import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { StatusDot, useAsync } from './common';

// Native port of WinForge CommunicationsService — a deep-link launcher for mail and
// chat apps. Every field builds a protocol URI (mailto: / discord:// / tg:// / slack://
// / tel: / sms:) or an https Teams deep link; on the desktop we launch it via
// Start-Process (opens a DRAFT / compose / dialer — nothing is EVER auto-sent), and in
// a plain browser we build + copy the same URI. Classic Outlook is detected live via the
// App Paths registry key so the /c /a /select buttons only fire when OUTLOOK.EXE exists.

// ---------- URI builders (faithful to CommunicationsService) ----------

const enc = (s: string) => encodeURIComponent(s ?? '');

/** RFC 6068 mailto: with subject/cc/bcc/body query. */
function buildMailto(to: string, subject: string, cc: string, bcc: string, body: string): string {
  // to is left mostly literal (@ and , preserved) as in the C# port.
  let out = 'mailto:' + enc(to).replace(/%40/g, '@').replace(/%2C/g, ',');
  const q: string[] = [];
  if (subject.trim()) q.push('subject=' + enc(subject));
  if (cc.trim()) q.push('cc=' + enc(cc));
  if (bcc.trim()) q.push('bcc=' + enc(bcc));
  if (body.trim()) q.push('body=' + enc(body));
  if (q.length) out += '?' + q.join('&');
  return out;
}

/** The mailto query without the leading "mailto:" — for Outlook /m. */
function buildOutlookQuery(to: string, subject: string, cc: string, bcc: string, body: string): string {
  let out = to ?? '';
  const q: string[] = [];
  if (subject.trim()) q.push('subject=' + enc(subject));
  if (cc.trim()) q.push('cc=' + enc(cc));
  if (bcc.trim()) q.push('bcc=' + enc(bcc));
  if (body.trim()) q.push('body=' + enc(body));
  if (q.length) out += '?' + q.join('&');
  return out;
}

/** Strip to digits and + * # (RFC 3966-ish) as CleanNumber does. */
function cleanNumber(n: string): string {
  let out = '';
  for (const c of (n ?? '').trim()) {
    if (/[0-9]/.test(c) || c === '+' || c === '*' || c === '#') out += c;
  }
  return out;
}

/** PowerShell single-quote escape. */
const psq = (s: string) => s.replace(/'/g, "''");

const OUTLOOK_FOLDERS: { value: string; en: string; zh: string }[] = [
  { value: 'Inbox', en: 'Inbox', zh: '收件匣' },
  { value: 'Calendar', en: 'Calendar', zh: '行事曆' },
  { value: 'Contacts', en: 'Contacts', zh: '連絡人' },
  { value: 'Tasks', en: 'Tasks', zh: '工作' },
  { value: 'Notes', en: 'Notes', zh: '記事' },
  { value: 'Drafts', en: 'Drafts', zh: '草稿' },
];

interface OutlookProbe {
  Path: string;
}

export function CommsModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  // Live system query: resolve classic OUTLOOK.EXE via the App Paths registry key.
  const outlook = useAsync<OutlookProbe[]>(
    () =>
      runPowershellJson<OutlookProbe>(
        "$p=$null; " +
          "foreach($r in 'HKCU','HKLM'){ " +
          "  $k=\"$($r):\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\OUTLOOK.EXE\"; " +
          "  try{ $v=(Get-ItemProperty -Path $k -ErrorAction Stop).'(default)'; " +
          "    if($v){ $v=[Environment]::ExpandEnvironmentVariables($v.Trim('\"')); if(Test-Path -LiteralPath $v){ $p=$v; break } } }catch{} }; " +
          "if(-not $p){ foreach($b in $env:ProgramFiles,${env:ProgramFiles(x86)},$env:ProgramW6432){ if($b){ foreach($o in 'Office16','Office15','Office14'){ " +
          "  foreach($c in (Join-Path $b \"Microsoft Office\\root\\$o\\OUTLOOK.EXE\"),(Join-Path $b \"Microsoft Office\\$o\\OUTLOOK.EXE\")){ if(Test-Path -LiteralPath $c){ $p=$c; break } } } } if($p){break} } }; " +
          "[pscustomobject]@{ Path = ($p ?? '') }",
      ),
    [],
  );

  const outlookExe = desktop ? (outlook.data?.[0]?.Path ?? '') : '';
  const hasOutlook = outlookExe.length > 0;

  // ---------- Mail ----------
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [attachPath, setAttachPath] = useState('');
  const [folder, setFolder] = useState('Inbox');

  // ---------- Discord ----------
  const [dGuild, setDGuild] = useState('');
  const [dChannel, setDChannel] = useState('');
  const [dDm, setDDm] = useState('');

  // ---------- Teams ----------
  const [tUsers, setTUsers] = useState('');
  const [tTopic, setTTopic] = useState('');
  const [tMessage, setTMessage] = useState('');
  const [mSubject, setMSubject] = useState('');
  const [mAttendees, setMAttendees] = useState('');
  const [mStart, setMStart] = useState('');
  const [mEnd, setMEnd] = useState('');

  // ---------- Telegram ----------
  const [tgUrl, setTgUrl] = useState('');
  const [tgText, setTgText] = useState('');
  const [tgUser, setTgUser] = useState('');
  const [tgPost, setTgPost] = useState('');

  // ---------- Slack ----------
  const [sTeam, setSTeam] = useState('');
  const [sChannel, setSChannel] = useState('');
  const [sUser, setSUser] = useState('');

  // ---------- Phone Link ----------
  const [phone, setPhone] = useState('');
  const [smsBody, setSmsBody] = useState('');

  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  /** Launch a protocol/https URI: Start-Process on desktop, copy in a browser. */
  const launchUri = async (label: string, uri: string, invalid?: string) => {
    if (invalid) {
      setResult({ ok: false, text: invalid });
      return;
    }
    if (!desktop) {
      try {
        await navigator.clipboard?.writeText(uri);
      } catch {
        /* ignore clipboard denial */
      }
      setResult({ ok: true, text: t('comms.copied', { label, uri }) });
      return;
    }
    try {
      const res = await runPowershell(`Start-Process '${psq(uri)}'; 'ok'`);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setResult({ ok: true, text: t('comms.launched', { label, uri }) });
    } catch (e) {
      setResult({ ok: false, text: `${t('comms.failed', { label })}: ${String(e instanceof Error ? e.message : e)}` });
    }
  };

  /** Launch classic Outlook with args (build the draft / attach / folder — never send). */
  const launchOutlook = async (label: string, args: string, invalid?: string) => {
    if (invalid) {
      setResult({ ok: false, text: invalid });
      return;
    }
    if (!hasOutlook) {
      setResult({ ok: false, text: t('comms.noOutlook') });
      return;
    }
    try {
      const res = await runPowershell(
        `Start-Process -FilePath '${psq(outlookExe)}' -ArgumentList @(${args}); 'ok'`,
      );
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setResult({ ok: true, text: t('comms.launched', { label, uri: `OUTLOOK.EXE ${args}` }) });
    } catch (e) {
      setResult({ ok: false, text: `${t('comms.failed', { label })}: ${String(e instanceof Error ? e.message : e)}` });
    }
  };

  // ---------- Section actions ----------

  const onMailto = () =>
    launchUri(
      t('comms.mailtoBtn'),
      buildMailto(to, subject, cc, bcc, body),
      to.trim() ? undefined : t('comms.needTo'),
    );

  const onOutlook = () => {
    const q = buildOutlookQuery(to, subject, cc, bcc, body);
    launchOutlook(t('comms.outlookBtn'), `'/c','ipm.note','/m','${psq(q)}'`, to.trim() ? undefined : t('comms.needTo'));
  };

  const onAttach = () => {
    const f = attachPath.trim();
    if (!f) {
      setResult({ ok: false, text: t('comms.needFile') });
      return;
    }
    let args = `'/a','${psq(f)}'`;
    if (to.trim()) {
      const q = buildOutlookQuery(to, subject, '', '', body);
      args += `,'/m','${psq(q)}'`;
    }
    launchOutlook(t('comms.attachSendBtn'), args);
  };

  const onFolder = () => launchOutlook(t('comms.folderBtn'), `'/select','outlook:${psq(folder)}'`);

  const onDiscordChannel = () => {
    const g = dGuild.trim();
    const c = dChannel.trim();
    if (!g) return void setResult({ ok: false, text: t('comms.needGuild') });
    const uri = c ? `discord://-/channels/${g}/${c}` : `discord://-/channels/${g}`;
    launchUri(t('comms.discordChannelBtn'), uri);
  };
  const onDiscordDm = () =>
    launchUri(t('comms.discordDmBtn'), `discord://-/channels/@me/${dDm.trim()}`, dDm.trim() ? undefined : t('comms.needDm'));
  const onDiscordHome = () => launchUri(t('comms.discordHomeBtn'), 'discord://-/channels/@me');

  const onTeamsChat = () => {
    const u = tUsers.trim();
    if (!u) return void setResult({ ok: false, text: t('comms.needUsers') });
    const q = ['users=' + enc(u)];
    if (tTopic.trim()) q.push('topicName=' + enc(tTopic));
    if (tMessage.trim()) q.push('message=' + enc(tMessage));
    launchUri(t('comms.teamsChatBtn'), `https://teams.microsoft.com/l/chat/0/0?${q.join('&')}`);
  };
  const onTeamsCall = () =>
    launchUri(
      t('comms.teamsCallBtn'),
      `https://teams.microsoft.com/l/call/0/0?users=${enc(tUsers.trim())}`,
      tUsers.trim() ? undefined : t('comms.needUsers'),
    );
  const onTeamsMeeting = () => {
    const q: string[] = [];
    if (mSubject.trim()) q.push('subject=' + enc(mSubject));
    if (mAttendees.trim()) q.push('attendees=' + enc(mAttendees.trim()));
    if (mStart.trim()) q.push('startTime=' + enc(mStart.trim()));
    if (mEnd.trim()) q.push('endTime=' + enc(mEnd.trim()));
    const qs = q.length ? '?' + q.join('&') : '';
    launchUri(t('comms.teamsMeetingBtn'), `https://teams.microsoft.com/l/meeting/new${qs}`);
  };

  const onTgShare = () => {
    const u = tgUrl.trim();
    const txt = tgText;
    if (!u && !txt.trim()) return void setResult({ ok: false, text: t('comms.needUrlOrText') });
    if (!u) return void launchUri(t('comms.tgShareBtn'), 'tg://msg?text=' + enc(txt));
    const q = ['url=' + enc(u)];
    if (txt.trim()) q.push('text=' + enc(txt));
    launchUri(t('comms.tgShareBtn'), 'tg://msg_url?' + q.join('&'));
  };
  const onTgResolve = () => {
    const u = tgUser.trim().replace(/^@+/, '');
    if (!u) return void setResult({ ok: false, text: t('comms.needTgUser') });
    let uri = 'tg://resolve?domain=' + enc(u);
    if (tgPost.trim()) uri += '&post=' + enc(tgPost.trim());
    launchUri(t('comms.tgResolveBtn'), uri);
  };

  const onSlackChannel = () => {
    const tm = sTeam.trim();
    const ch = sChannel.trim();
    if (!tm || !ch) return void setResult({ ok: false, text: t('comms.needTeamChannel') });
    launchUri(t('comms.slackChannelBtn'), `slack://channel?team=${enc(tm)}&id=${enc(ch)}`);
  };
  const onSlackDm = () => {
    const tm = sTeam.trim();
    const us = sUser.trim();
    if (!tm || !us) return void setResult({ ok: false, text: t('comms.needTeamUser') });
    launchUri(t('comms.slackDmBtn'), `slack://user?team=${enc(tm)}&id=${enc(us)}`);
  };
  const onSlackOpen = () =>
    launchUri(t('comms.slackOpenBtn'), `slack://open?team=${enc(sTeam.trim())}`, sTeam.trim() ? undefined : t('comms.needTeam'));

  const onPhoneCall = () => {
    const n = cleanNumber(phone);
    launchUri(t('comms.phoneCallBtn'), 'tel:' + n, n ? undefined : t('comms.needPhone'));
  };
  const onPhoneSms = () => {
    const n = cleanNumber(phone);
    if (!n) return void setResult({ ok: false, text: t('comms.needPhone') });
    let uri = 'sms:' + n;
    if (smsBody.trim()) uri += '?body=' + enc(smsBody);
    launchUri(t('comms.phoneSmsBtn'), uri);
  };

  const onDefaults = () => launchUri(t('comms.defaultsBtn'), 'ms-settings:defaultapps');

  // Live preview of the mailto URI so the user sees exactly what will launch.
  const mailtoPreview = useMemo(() => buildMailto(to, subject, cc, bcc, body), [to, subject, cc, bcc, body]);

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('comms.blurb')}
      </p>

      {result && (
        <p className="mod-msg" style={{ color: result.ok ? undefined : 'var(--danger)' }}>
          {result.text}
        </p>
      )}

      {/* ============ MAIL ============ */}
      <Section title={t('comms.mailTitle')}>
        {desktop && (
          <p className="count-note" style={{ marginTop: 0 }}>
            <StatusDot ok={hasOutlook} label={hasOutlook ? t('comms.outlookFound') : t('comms.outlookMissing')} />
            {hasOutlook ? ` — ${outlookExe}` : ''}
          </p>
        )}
        <Field label={t('comms.to')}>
          <input className="hosts-edit" value={to} onChange={(e) => setTo(e.target.value)} placeholder="someone@example.com, other@example.com" />
        </Field>
        <div className="comms-row">
          <Field label="Cc">
            <input className="hosts-edit" value={cc} onChange={(e) => setCc(e.target.value)} />
          </Field>
          <Field label="Bcc">
            <input className="hosts-edit" value={bcc} onChange={(e) => setBcc(e.target.value)} />
          </Field>
        </div>
        <Field label={t('comms.subject')}>
          <input className="hosts-edit" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label={t('comms.bodyLabel')}>
          <textarea className="hosts-edit" value={body} onChange={(e) => setBody(e.target.value)} style={{ minHeight: 84 }} />
        </Field>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <button className="mini primary" onClick={onMailto}>
            {t('comms.mailtoBtn')}
          </button>
          <button className="mini" disabled={desktop && !hasOutlook} onClick={onOutlook}>
            {t('comms.outlookBtn')}
          </button>
        </div>
        <p className="count-note" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
          {mailtoPreview}
        </p>

        <p className="count-note" style={{ fontWeight: 600, marginTop: 6 }}>{t('comms.attachLabel')}</p>
        <div className="comms-row">
          <input
            className="hosts-edit"
            style={{ fontFamily: 'monospace' }}
            value={attachPath}
            onChange={(e) => setAttachPath(e.target.value)}
            placeholder={t('comms.attachPlaceholder')}
          />
          <button className="mini" disabled={desktop && !hasOutlook} onClick={onAttach}>
            {t('comms.attachSendBtn')}
          </button>
        </div>

        <p className="count-note" style={{ fontWeight: 600, marginTop: 6 }}>{t('comms.folderLabel')}</p>
        <div className="comms-row">
          <select className="mod-search" value={folder} onChange={(e) => setFolder(e.target.value)}>
            {OUTLOOK_FOLDERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.en} · {f.zh}
              </option>
            ))}
          </select>
          <button className="mini" disabled={desktop && !hasOutlook} onClick={onFolder}>
            {t('comms.folderBtn')}
          </button>
        </div>
      </Section>

      {/* ============ DISCORD ============ */}
      <Section title={t('comms.discordTitle')}>
        <div className="comms-row">
          <Field label={t('comms.discordGuild')}>
            <input className="hosts-edit" style={{ fontFamily: 'monospace' }} value={dGuild} onChange={(e) => setDGuild(e.target.value)} />
          </Field>
          <Field label={t('comms.discordChannel')}>
            <input className="hosts-edit" style={{ fontFamily: 'monospace' }} value={dChannel} onChange={(e) => setDChannel(e.target.value)} />
          </Field>
        </div>
        <div className="comms-row">
          <Field label={t('comms.discordDm')}>
            <input className="hosts-edit" style={{ fontFamily: 'monospace' }} value={dDm} onChange={(e) => setDDm(e.target.value)} />
          </Field>
        </div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <button className="mini primary" onClick={onDiscordChannel}>{t('comms.discordChannelBtn')}</button>
          <button className="mini" onClick={onDiscordDm}>{t('comms.discordDmBtn')}</button>
          <button className="mini" onClick={onDiscordHome}>{t('comms.discordHomeBtn')}</button>
        </div>
      </Section>

      {/* ============ TEAMS ============ */}
      <Section title={t('comms.teamsTitle')}>
        <Field label={t('comms.teamsUsers')}>
          <input className="hosts-edit" value={tUsers} onChange={(e) => setTUsers(e.target.value)} placeholder="joe@contoso.com, bob@contoso.com" />
        </Field>
        <div className="comms-row">
          <Field label={t('comms.teamsTopic')}>
            <input className="hosts-edit" value={tTopic} onChange={(e) => setTTopic(e.target.value)} />
          </Field>
          <Field label={t('comms.teamsMessage')}>
            <input className="hosts-edit" value={tMessage} onChange={(e) => setTMessage(e.target.value)} />
          </Field>
        </div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <button className="mini primary" onClick={onTeamsChat}>{t('comms.teamsChatBtn')}</button>
          <button className="mini" onClick={onTeamsCall}>{t('comms.teamsCallBtn')}</button>
        </div>
        <p className="count-note" style={{ fontWeight: 600, marginTop: 6 }}>{t('comms.teamsMeetingLabel')}</p>
        <Field label={t('comms.mtgSubject')}>
          <input className="hosts-edit" value={mSubject} onChange={(e) => setMSubject(e.target.value)} />
        </Field>
        <Field label={t('comms.mtgAttendees')}>
          <input className="hosts-edit" value={mAttendees} onChange={(e) => setMAttendees(e.target.value)} placeholder="a@x.com, b@x.com" />
        </Field>
        <div className="comms-row">
          <Field label={t('comms.mtgStart')}>
            <input className="mod-search" type="datetime-local" value={mStart} onChange={(e) => setMStart(e.target.value)} />
          </Field>
          <Field label={t('comms.mtgEnd')}>
            <input className="mod-search" type="datetime-local" value={mEnd} onChange={(e) => setMEnd(e.target.value)} />
          </Field>
        </div>
        <button className="mini" onClick={onTeamsMeeting}>{t('comms.teamsMeetingBtn')}</button>
      </Section>

      {/* ============ TELEGRAM ============ */}
      <Section title={t('comms.telegramTitle')}>
        <Field label={t('comms.tgUrl')}>
          <input className="hosts-edit" value={tgUrl} onChange={(e) => setTgUrl(e.target.value)} />
        </Field>
        <div className="comms-row">
          <Field label={t('comms.tgText')}>
            <input className="hosts-edit" value={tgText} onChange={(e) => setTgText(e.target.value)} />
          </Field>
          <button className="mini primary comms-inline-btn" onClick={onTgShare}>{t('comms.tgShareBtn')}</button>
        </div>
        <div className="comms-row">
          <Field label={t('comms.tgUser')}>
            <input className="hosts-edit" value={tgUser} onChange={(e) => setTgUser(e.target.value)} placeholder="@durov" />
          </Field>
          <Field label={t('comms.tgPost')}>
            <input className="hosts-edit" style={{ fontFamily: 'monospace', maxWidth: 120 }} value={tgPost} onChange={(e) => setTgPost(e.target.value)} />
          </Field>
          <button className="mini comms-inline-btn" onClick={onTgResolve}>{t('comms.tgResolveBtn')}</button>
        </div>
      </Section>

      {/* ============ SLACK ============ */}
      <Section title={t('comms.slackTitle')}>
        <div className="comms-row">
          <Field label={t('comms.slackTeam')}>
            <input className="hosts-edit" style={{ fontFamily: 'monospace' }} value={sTeam} onChange={(e) => setSTeam(e.target.value)} placeholder="Txxxx" />
          </Field>
          <Field label={t('comms.slackChannel')}>
            <input className="hosts-edit" style={{ fontFamily: 'monospace' }} value={sChannel} onChange={(e) => setSChannel(e.target.value)} placeholder="Cxxxx" />
          </Field>
          <button className="mini primary comms-inline-btn" onClick={onSlackChannel}>{t('comms.slackChannelBtn')}</button>
        </div>
        <div className="comms-row">
          <Field label={t('comms.slackUser')}>
            <input className="hosts-edit" style={{ fontFamily: 'monospace' }} value={sUser} onChange={(e) => setSUser(e.target.value)} placeholder="Uxxxx" />
          </Field>
          <button className="mini comms-inline-btn" onClick={onSlackDm}>{t('comms.slackDmBtn')}</button>
          <button className="mini comms-inline-btn" onClick={onSlackOpen}>{t('comms.slackOpenBtn')}</button>
        </div>
      </Section>

      {/* ============ PHONE LINK ============ */}
      <Section title={t('comms.phoneTitle')}>
        <div className="comms-row">
          <Field label={t('comms.phoneNumber')}>
            <input className="hosts-edit" style={{ fontFamily: 'monospace', maxWidth: 200 }} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+18005551234" />
          </Field>
          <Field label={t('comms.smsBody')}>
            <input className="hosts-edit" value={smsBody} onChange={(e) => setSmsBody(e.target.value)} />
          </Field>
        </div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <button className="mini primary" onClick={onPhoneCall}>{t('comms.phoneCallBtn')}</button>
          <button className="mini" onClick={onPhoneSms}>{t('comms.phoneSmsBtn')}</button>
        </div>
      </Section>

      {/* ============ DEFAULTS ============ */}
      <Section title={t('comms.defaultsTitle')}>
        <p className="count-note" style={{ marginTop: 0 }}>{t('comms.defaultsBlurb')}</p>
        <button className="mini" onClick={onDefaults}>{t('comms.defaultsBtn')}</button>
      </Section>

      <p className="count-note" style={{ marginTop: 10 }}>
        {desktop ? t('comms.desktopNote') : t('comms.webNote')}
      </p>

      <style>{`
        .comms-row { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 8px; }
        .comms-row > * { flex: 1 1 160px; }
        .comms-inline-btn { flex: 0 0 auto; }
        .comms-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
        .comms-field > label { font-size: 12px; opacity: 0.75; }
        .comms-field .hosts-edit, .comms-field textarea { min-height: 34px; }
      `}</style>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel">
      <h4 style={{ margin: '0 0 10px' }}>{title}</h4>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="comms-field">
      <label>{label}</label>
      {children}
    </div>
  );
}
