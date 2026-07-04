import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { type Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// Native port of WinForge CommunicationsService — a deep-link launcher for mail and
// chat apps. Every field builds a protocol URI (mailto: / discord:// / tg:// / slack://
// / tel: / sms:) or an https Teams deep link; on the desktop we launch it via
// Start-Process (opens a DRAFT / compose / dialer — nothing is EVER auto-sent), and in
// a plain browser we build + copy the same URI. A "copy instead of launch" toggle mirrors
// the C# LaunchUri/LaunchExe clipboard behaviour exactly. Classic Outlook is detected live
// via the App Paths registry key (PowerShell 5.1-safe) so the /c /a /select buttons only
// fire when OUTLOOK.EXE exists. Upgrade surface on top of the original page: saved
// per-provider profiles + a send/launch history log, both in localStorage (phone numbers
// are treated as sensitive and masked in every list; deep links carry no passwords).

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

// ---------- Saved profiles + send/launch history (localStorage) ----------

type ProviderId = 'mail' | 'discord' | 'teams' | 'telegram' | 'slack' | 'phone';
const PROVIDERS: ProviderId[] = ['mail', 'discord', 'teams', 'telegram', 'slack', 'phone'];

interface CommsProfile {
  id: string;
  name: string;
  provider: ProviderId;
  /** Plain form fields — deep links carry no passwords/tokens; phone numbers are masked on display. */
  fields: Record<string, string>;
  updated: number;
}

interface HistEntry {
  id: string;
  ts: number;
  provider: ProviderId | 'system';
  action: string;
  uri: string; // full link (kind=uri) or OUTLOOK.EXE command line (kind=cmd)
  kind: 'uri' | 'cmd';
  mode: 'launched' | 'copied';
  ok: boolean;
}

const PROFILES_KEY = 'winforge.comms.profiles.v1';
const HISTORY_KEY = 'winforge.comms.history.v1';
const HISTORY_MAX = 200;

function loadStored<T extends { id: string }>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is T => !!p && typeof p === 'object' && 'id' in p);
  } catch {
    return [];
  }
}

function saveStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage may be unavailable; ignore */
  }
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Sensitive-field mask: keep 2+2 edge chars of a phone number, hide the middle. */
function maskPhone(n: string): string {
  if (n.length <= 4) return '••••';
  return `${n.slice(0, 2)}${'•'.repeat(Math.min(6, Math.max(3, n.length - 4)))}${n.slice(-2)}`;
}

/** Display form of a stored link: tel:/sms: numbers masked, long URIs truncated. */
function maskUriForDisplay(uri: string): string {
  let out = uri;
  const m = /^(tel:|sms:)([0-9+*#]+)(.*)$/.exec(uri);
  if (m) out = `${m[1] ?? ''}${maskPhone(m[2] ?? '')}${m[3] ?? ''}`;
  return out.length > 110 ? `${out.slice(0, 107)}…` : out;
}

/** One-line profile summary with sensitive fields masked. */
function profileSummary(p: CommsProfile): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(p.fields)) {
    if (typeof v !== 'string' || !v.trim()) continue;
    parts.push(`${k}=${p.provider === 'phone' && k === 'number' ? maskPhone(v) : v}`);
  }
  const s = parts.join('; ');
  return s.length > 90 ? `${s.slice(0, 87)}…` : s;
}

/** Clipboard copy with a textarea fallback for non-secure contexts. */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea fallback */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function CommsModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  // Live system query: resolve classic OUTLOOK.EXE via the App Paths registry key.
  // Windows PowerShell 5.1-compatible (no ?? operator).
  const outlook = useAsync<OutlookProbe[]>(
    () =>
      runPowershellJson<OutlookProbe>(
        "$p=$null; " +
          "foreach($r in 'HKCU','HKLM'){ " +
          "  $k=\"$($r):\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\OUTLOOK.EXE\"; " +
          "  try{ $v=(Get-ItemProperty -Path $k -ErrorAction Stop).'(default)'; " +
          "    if($v){ $v=[Environment]::ExpandEnvironmentVariables($v.Trim('\"')); if(Test-Path -LiteralPath $v){ $p=$v; break } } }catch{} }; " +
          "if(-not $p){ foreach($b in @($env:ProgramFiles,${env:ProgramFiles(x86)},$env:ProgramW6432)){ if($b -and -not $p){ foreach($o in 'Office16','Office15','Office14'){ " +
          "  foreach($c in (Join-Path $b \"Microsoft Office\\root\\$o\\OUTLOOK.EXE\"),(Join-Path $b \"Microsoft Office\\$o\\OUTLOOK.EXE\")){ if(Test-Path -LiteralPath $c){ $p=$c; break } } if($p){break} } } } }; " +
          "[pscustomobject]@{ Path = $(if($p){$p}else{''}) }",
      ),
    [],
  );

  const outlookExe = desktop ? (outlook.data?.[0]?.Path ?? '') : '';
  const hasOutlook = outlookExe.length > 0;
  const outlookDisplayExe = hasOutlook ? `"${outlookExe}"` : 'OUTLOOK.EXE';

  // ---------- Mail ----------
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [attachPath, setAttachPath] = useState('');
  const [folder, setFolder] = useState('Inbox');
  const fileRef = useRef<HTMLInputElement | null>(null);

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

  // ---------- Upgrade state: copy-mode, profiles, history ----------
  const [copyMode, setCopyMode] = useState(false); // desktop: copy the link like the C# app instead of launching
  const [profiles, setProfiles] = useState<CommsProfile[]>(() => loadStored<CommsProfile>(PROFILES_KEY));
  const [hist, setHist] = useState<HistEntry[]>(() => loadStored<HistEntry>(HISTORY_KEY));
  const [saveProvider, setSaveProvider] = useState<ProviderId>('mail');
  const [saveName, setSaveName] = useState('');
  const [confirmId, setConfirmId] = useState('');

  useEffect(() => saveStored(PROFILES_KEY, profiles), [profiles]);
  useEffect(() => saveStored(HISTORY_KEY, hist), [hist]);

  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const log = (e: Omit<HistEntry, 'id' | 'ts'>) =>
    setHist((prev) => [{ id: newId(), ts: Date.now(), ...e }, ...prev].slice(0, HISTORY_MAX));

  const provLabel = (p: ProviderId | 'system'): string => {
    switch (p) {
      case 'mail':
        return t('comms.provMail');
      case 'discord':
        return t('comms.provDiscord');
      case 'teams':
        return t('comms.provTeams');
      case 'telegram':
        return t('comms.provTelegram');
      case 'slack':
        return t('comms.provSlack');
      case 'phone':
        return t('comms.provPhone');
      case 'system':
        return t('comms.provSystem');
    }
  };

  /** Launch a protocol/https URI: Start-Process on desktop, clipboard copy in a browser or in copy-mode. */
  const launchUri = async (provider: ProviderId | 'system', label: string, uri: string, invalid?: string) => {
    if (invalid) {
      setResult({ ok: false, text: invalid });
      return;
    }
    if (!desktop || copyMode) {
      const ok = await copyTextToClipboard(uri);
      setResult(
        ok
          ? { ok: true, text: t('comms.copied', { label, uri }) }
          : { ok: false, text: t('comms.failed', { label }) },
      );
      log({ provider, action: label, uri, kind: 'uri', mode: 'copied', ok });
      return;
    }
    try {
      const res = await runPowershell(`Start-Process '${psq(uri)}'; 'ok'`);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setResult({ ok: true, text: t('comms.launched', { label, uri }) });
      log({ provider, action: label, uri, kind: 'uri', mode: 'launched', ok: true });
    } catch (e) {
      setResult({ ok: false, text: `${t('comms.failed', { label })}: ${String(e instanceof Error ? e.message : e)}` });
      log({ provider, action: label, uri, kind: 'uri', mode: 'launched', ok: false });
    }
  };

  /** Launch classic Outlook with args (build the draft / attach / folder — never send). */
  const launchOutlook = async (
    label: string,
    argsPs: string,
    displayCmd: string,
    opts?: { invalid?: string; guard?: string },
  ) => {
    if (opts?.invalid) {
      setResult({ ok: false, text: opts.invalid });
      return;
    }
    if (!desktop || copyMode) {
      // Faithful to the C# LaunchExe: copy the full command line to the clipboard.
      if (desktop && !hasOutlook) {
        setResult({ ok: false, text: t('comms.noOutlook') });
        return;
      }
      const ok = await copyTextToClipboard(displayCmd);
      setResult(
        ok
          ? { ok: true, text: t('comms.copied', { label, uri: displayCmd }) }
          : { ok: false, text: t('comms.failed', { label }) },
      );
      log({ provider: 'mail', action: label, uri: displayCmd, kind: 'cmd', mode: 'copied', ok });
      return;
    }
    if (!hasOutlook) {
      setResult({ ok: false, text: t('comms.noOutlook') });
      return;
    }
    try {
      const res = await runPowershell(
        `${opts?.guard ?? ''}Start-Process -FilePath '${psq(outlookExe)}' -ArgumentList @(${argsPs}); 'ok'`,
      );
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setResult({ ok: true, text: t('comms.launched', { label, uri: displayCmd }) });
      log({ provider: 'mail', action: label, uri: displayCmd, kind: 'cmd', mode: 'launched', ok: true });
    } catch (e) {
      setResult({ ok: false, text: `${t('comms.failed', { label })}: ${String(e instanceof Error ? e.message : e)}` });
      log({ provider: 'mail', action: label, uri: displayCmd, kind: 'cmd', mode: 'launched', ok: false });
    }
  };

  // ---------- Section actions ----------

  const onMailto = () =>
    launchUri(
      'mail',
      t('comms.mailtoBtn'),
      buildMailto(to, subject, cc, bcc, body),
      to.trim() ? undefined : t('comms.needTo'),
    );

  const onOutlook = () => {
    const q = buildOutlookQuery(to, subject, cc, bcc, body);
    launchOutlook(
      t('comms.outlookBtn'),
      `'/c','ipm.note','/m','${psq(q)}'`,
      `${outlookDisplayExe} /c ipm.note /m "${q}"`,
      { invalid: to.trim() ? undefined : t('comms.needTo') },
    );
  };

  /** Pick the attachment: native OpenFileDialog on desktop, name-only file input in a browser. */
  const onBrowse = async () => {
    if (!desktop) {
      fileRef.current?.click();
      return;
    }
    try {
      const res = await runPowershell(
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; ` +
          `$d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='${psq(t('comms.browseTitle'))}'; ` +
          `if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ $d.FileName }`,
      );
      const p = res.stdout.trim();
      if (p) setAttachPath(p);
    } catch (e) {
      setResult({
        ok: false,
        text: `${t('comms.failed', { label: t('comms.browseBtn') })}: ${String(e instanceof Error ? e.message : e)}`,
      });
    }
  };

  const onAttach = () => {
    const f = attachPath.trim();
    if (!f) {
      setResult({ ok: false, text: t('comms.needFile') });
      return;
    }
    let argsPs = `'/a','${psq(f)}'`;
    let display = `${outlookDisplayExe} /a "${f}"`;
    if (to.trim()) {
      const q = buildOutlookQuery(to, subject, '', '', body);
      argsPs += `,'/m','${psq(q)}'`;
      display += ` /m "${q}"`;
    }
    launchOutlook(t('comms.attachSendBtn'), argsPs, display, {
      // The C# checks File.Exists before launching — same guard, same PowerShell call.
      guard: `if(-not (Test-Path -LiteralPath '${psq(f)}')){ throw '${psq(t('comms.needFile'))}' }; `,
    });
  };

  const onFolder = () =>
    launchOutlook(
      t('comms.folderBtn'),
      `'/select','outlook:${psq(folder)}'`,
      `${outlookDisplayExe} /select outlook:${folder}`,
    );

  const onDiscordChannel = () => {
    const g = dGuild.trim();
    const c = dChannel.trim();
    if (!g) return void setResult({ ok: false, text: t('comms.needGuild') });
    const uri = c ? `discord://-/channels/${g}/${c}` : `discord://-/channels/${g}`;
    launchUri('discord', t('comms.discordChannelBtn'), uri);
  };
  const onDiscordDm = () =>
    launchUri(
      'discord',
      t('comms.discordDmBtn'),
      `discord://-/channels/@me/${dDm.trim()}`,
      dDm.trim() ? undefined : t('comms.needDm'),
    );
  const onDiscordHome = () => launchUri('discord', t('comms.discordHomeBtn'), 'discord://-/channels/@me');

  const onTeamsChat = () => {
    const u = tUsers.trim();
    if (!u) return void setResult({ ok: false, text: t('comms.needUsers') });
    const q = ['users=' + enc(u)];
    if (tTopic.trim()) q.push('topicName=' + enc(tTopic));
    if (tMessage.trim()) q.push('message=' + enc(tMessage));
    launchUri('teams', t('comms.teamsChatBtn'), `https://teams.microsoft.com/l/chat/0/0?${q.join('&')}`);
  };
  const onTeamsCall = () =>
    launchUri(
      'teams',
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
    launchUri('teams', t('comms.teamsMeetingBtn'), `https://teams.microsoft.com/l/meeting/new${qs}`);
  };

  const onTgShare = () => {
    const u = tgUrl.trim();
    const txt = tgText;
    if (!u && !txt.trim()) return void setResult({ ok: false, text: t('comms.needUrlOrText') });
    if (!u) return void launchUri('telegram', t('comms.tgShareBtn'), 'tg://msg?text=' + enc(txt));
    const q = ['url=' + enc(u)];
    if (txt.trim()) q.push('text=' + enc(txt));
    launchUri('telegram', t('comms.tgShareBtn'), 'tg://msg_url?' + q.join('&'));
  };
  const onTgResolve = () => {
    const u = tgUser.trim().replace(/^@+/, '');
    if (!u) return void setResult({ ok: false, text: t('comms.needTgUser') });
    let uri = 'tg://resolve?domain=' + enc(u);
    if (tgPost.trim()) uri += '&post=' + enc(tgPost.trim());
    launchUri('telegram', t('comms.tgResolveBtn'), uri);
  };

  const onSlackChannel = () => {
    const tm = sTeam.trim();
    const ch = sChannel.trim();
    if (!tm || !ch) return void setResult({ ok: false, text: t('comms.needTeamChannel') });
    launchUri('slack', t('comms.slackChannelBtn'), `slack://channel?team=${enc(tm)}&id=${enc(ch)}`);
  };
  const onSlackDm = () => {
    const tm = sTeam.trim();
    const us = sUser.trim();
    if (!tm || !us) return void setResult({ ok: false, text: t('comms.needTeamUser') });
    launchUri('slack', t('comms.slackDmBtn'), `slack://user?team=${enc(tm)}&id=${enc(us)}`);
  };
  const onSlackOpen = () =>
    launchUri(
      'slack',
      t('comms.slackOpenBtn'),
      `slack://open?team=${enc(sTeam.trim())}`,
      sTeam.trim() ? undefined : t('comms.needTeam'),
    );

  const onPhoneCall = () => {
    const n = cleanNumber(phone);
    launchUri('phone', t('comms.phoneCallBtn'), 'tel:' + n, n ? undefined : t('comms.needPhone'));
  };
  const onPhoneSms = () => {
    const n = cleanNumber(phone);
    if (!n) return void setResult({ ok: false, text: t('comms.needPhone') });
    let uri = 'sms:' + n;
    if (smsBody.trim()) uri += '?body=' + enc(smsBody);
    launchUri('phone', t('comms.phoneSmsBtn'), uri);
  };

  const onDefaults = () => launchUri('system', t('comms.defaultsBtn'), 'ms-settings:defaultapps');

  // ---------- Profiles ----------

  const snapshotProvider = (p: ProviderId): Record<string, string> => {
    switch (p) {
      case 'mail':
        return { to, cc, bcc, subject, body, attachPath, folder };
      case 'discord':
        return { guild: dGuild, channel: dChannel, dm: dDm };
      case 'teams':
        return {
          users: tUsers,
          topic: tTopic,
          message: tMessage,
          mtgSubject: mSubject,
          mtgAttendees: mAttendees,
          mtgStart: mStart,
          mtgEnd: mEnd,
        };
      case 'telegram':
        return { url: tgUrl, text: tgText, username: tgUser, post: tgPost };
      case 'slack':
        return { team: sTeam, channel: sChannel, user: sUser };
      case 'phone':
        return { number: phone, smsBody };
    }
  };

  const applyProfile = (prof: CommsProfile) => {
    const f = prof.fields;
    const g = (k: string): string => {
      const v = f[k];
      return typeof v === 'string' ? v : '';
    };
    switch (prof.provider) {
      case 'mail': {
        setTo(g('to'));
        setCc(g('cc'));
        setBcc(g('bcc'));
        setSubject(g('subject'));
        setBody(g('body'));
        setAttachPath(g('attachPath'));
        const fol = g('folder');
        setFolder(OUTLOOK_FOLDERS.some((x) => x.value === fol) ? fol : 'Inbox');
        break;
      }
      case 'discord':
        setDGuild(g('guild'));
        setDChannel(g('channel'));
        setDDm(g('dm'));
        break;
      case 'teams':
        setTUsers(g('users'));
        setTTopic(g('topic'));
        setTMessage(g('message'));
        setMSubject(g('mtgSubject'));
        setMAttendees(g('mtgAttendees'));
        setMStart(g('mtgStart'));
        setMEnd(g('mtgEnd'));
        break;
      case 'telegram':
        setTgUrl(g('url'));
        setTgText(g('text'));
        setTgUser(g('username'));
        setTgPost(g('post'));
        break;
      case 'slack':
        setSTeam(g('team'));
        setSChannel(g('channel'));
        setSUser(g('user'));
        break;
      case 'phone':
        setPhone(g('number'));
        setSmsBody(g('smsBody'));
        break;
    }
    setResult({ ok: true, text: t('comms.profileLoaded', { name: prof.name, provider: provLabel(prof.provider) }) });
  };

  const onSaveProfile = () => {
    const name = saveName.trim();
    if (!name) {
      setResult({ ok: false, text: t('comms.needProfileName') });
      return;
    }
    const existing = profiles.find(
      (p) => p.provider === saveProvider && p.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing && confirmId !== `ow:${existing.id}`) {
      // Overwrite is destructive — require a second explicit click.
      setConfirmId(`ow:${existing.id}`);
      setResult({
        ok: false,
        text: t('comms.confirmOverwrite', { name: existing.name, provider: provLabel(saveProvider) }),
      });
      return;
    }
    const fields = snapshotProvider(saveProvider);
    if (existing) {
      const next: CommsProfile = { ...existing, fields, updated: Date.now() };
      setProfiles((prev) => prev.map((p) => (p.id === existing.id ? next : p)));
    } else {
      setProfiles((prev) => [{ id: newId(), name, provider: saveProvider, fields, updated: Date.now() }, ...prev]);
    }
    setConfirmId('');
    setSaveName('');
    setResult({ ok: true, text: t('comms.profileSaved', { name }) });
  };

  const deleteProfile = (p: CommsProfile) => {
    setProfiles((prev) => prev.filter((x) => x.id !== p.id));
    setConfirmId('');
    setResult({ ok: true, text: t('comms.profileDeleted', { name: p.name }) });
  };

  // ---------- History row actions ----------

  const copyRow = async (h: HistEntry) => {
    const ok = await copyTextToClipboard(h.uri);
    setResult(
      ok
        ? { ok: true, text: t('comms.copied', { label: h.action, uri: maskUriForDisplay(h.uri) }) }
        : { ok: false, text: t('comms.failed', { label: h.action }) },
    );
  };

  const reopenRow = (h: HistEntry) => {
    if (h.kind !== 'uri') return;
    void launchUri(h.provider, h.action, h.uri);
  };

  const profileColumns: Column<CommsProfile>[] = [
    { key: 'name', header: t('comms.profileName'), width: 150, render: (p) => p.name },
    { key: 'provider', header: t('comms.historyApp'), width: 96, render: (p) => provLabel(p.provider) },
    {
      key: 'fields',
      header: t('comms.profileFields'),
      render: (p) => (
        <span style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{profileSummary(p)}</span>
      ),
    },
    {
      key: 'updated',
      header: t('comms.profileUpdated'),
      width: 150,
      render: (p) => new Date(p.updated).toLocaleString(),
    },
    {
      key: 'actions',
      header: '',
      width: 190,
      render: (p) => (
        <span className="row-actions">
          <button className="mini" onClick={() => applyProfile(p)}>
            {t('comms.loadBtn')}
          </button>
          {confirmId === `p:${p.id}` ? (
            <>
              <button className="mini primary" onClick={() => deleteProfile(p)}>
                {t('comms.confirmBtn')}
              </button>
              <button className="mini" onClick={() => setConfirmId('')}>
                {t('comms.cancelBtn')}
              </button>
            </>
          ) : (
            <button className="mini" onClick={() => setConfirmId(`p:${p.id}`)}>
              {t('comms.deleteBtn')}
            </button>
          )}
        </span>
      ),
    },
  ];

  const historyColumns: Column<HistEntry>[] = [
    { key: 'ts', header: t('comms.historyTime'), width: 150, render: (h) => new Date(h.ts).toLocaleString() },
    { key: 'provider', header: t('comms.historyApp'), width: 90, render: (h) => provLabel(h.provider) },
    { key: 'action', header: t('comms.historyAction'), width: 170, render: (h) => h.action },
    {
      key: 'result',
      header: t('comms.historyResult'),
      width: 110,
      render: (h) => (
        <StatusDot
          ok={h.ok}
          label={h.ok ? (h.mode === 'launched' ? t('comms.howLaunched') : t('comms.howCopied')) : t('comms.howFailed')}
        />
      ),
    },
    {
      key: 'uri',
      header: t('comms.historyLink'),
      render: (h) => (
        <span style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{maskUriForDisplay(h.uri)}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 210,
      render: (h) => (
        <span className="row-actions">
          <button className="mini" onClick={() => void copyRow(h)}>
            {t('comms.copyBtn')}
          </button>
          {h.kind === 'uri' && (
            <button className="mini" onClick={() => reopenRow(h)}>
              {t('comms.openBtn')}
            </button>
          )}
          {confirmId === `h:${h.id}` ? (
            <>
              <button
                className="mini primary"
                onClick={() => {
                  setHist((prev) => prev.filter((x) => x.id !== h.id));
                  setConfirmId('');
                }}
              >
                {t('comms.confirmBtn')}
              </button>
              <button className="mini" onClick={() => setConfirmId('')}>
                {t('comms.cancelBtn')}
              </button>
            </>
          ) : (
            <button className="mini" onClick={() => setConfirmId(`h:${h.id}`)}>
              {t('comms.deleteBtn')}
            </button>
          )}
        </span>
      ),
    },
  ];

  // Live preview of the mailto URI so the user sees exactly what will launch.
  const mailtoPreview = useMemo(() => buildMailto(to, subject, cc, bcc, body), [to, subject, cc, bcc, body]);

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('comms.blurb')}
      </p>

      {desktop && (
        <ModuleToolbar>
          <label className="count-note" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={copyMode} onChange={(e) => setCopyMode(e.target.checked)} />
            {t('comms.copyMode')}
          </label>
        </ModuleToolbar>
      )}

      {result && (
        <p className="mod-msg" style={{ color: result.ok ? undefined : 'var(--danger)' }}>
          {result.text}{' '}
          <button className="mini" aria-label={t('comms.dismiss')} title={t('comms.dismiss')} onClick={() => setResult(null)}>
            ×
          </button>
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
          {t('comms.previewLabel')}: {mailtoPreview}
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
          <button className="mini comms-inline-btn" onClick={() => void onBrowse()}>
            {t('comms.browseBtn')}
          </button>
          <button className="mini comms-inline-btn" disabled={desktop && !hasOutlook} onClick={onAttach}>
            {t('comms.attachSendBtn')}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              setAttachPath(f.name);
              setResult({ ok: true, text: t('comms.browseWebNote') });
            }
            e.target.value = '';
          }}
        />

        <p className="count-note" style={{ fontWeight: 600, marginTop: 6 }}>{t('comms.folderLabel')}</p>
        <div className="comms-row">
          <select className="mod-search" value={folder} onChange={(e) => setFolder(e.target.value)}>
            {OUTLOOK_FOLDERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.en} · {f.zh}
              </option>
            ))}
          </select>
          <button className="mini comms-inline-btn" disabled={desktop && !hasOutlook} onClick={onFolder}>
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
        <p className="count-note" style={{ marginTop: 4 }}>{t('comms.maskedHint')}</p>
      </Section>

      {/* ============ DEFAULTS ============ */}
      <Section title={t('comms.defaultsTitle')}>
        <p className="count-note" style={{ marginTop: 0 }}>{t('comms.defaultsBlurb')}</p>
        <button className="mini" onClick={onDefaults}>{t('comms.defaultsBtn')}</button>
      </Section>

      {/* ============ SAVED PROFILES ============ */}
      <Section title={t('comms.profilesTitle')}>
        <p className="count-note" style={{ marginTop: 0 }}>{t('comms.profilesBlurb')}</p>
        <div className="comms-row">
          <Field label={t('comms.profileProvider')}>
            <select
              className="mod-search"
              value={saveProvider}
              onChange={(e) => {
                setSaveProvider(e.target.value as ProviderId);
                setConfirmId('');
              }}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {provLabel(p)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('comms.profileName')}>
            <input className="hosts-edit" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
          </Field>
          <button className="mini primary comms-inline-btn" onClick={onSaveProfile}>
            {t('comms.saveProfileBtn')}
          </button>
        </div>
        <DataTable columns={profileColumns} rows={profiles} rowKey={(p) => p.id} empty={t('comms.profileNone')} />
      </Section>

      {/* ============ SEND / LAUNCH HISTORY ============ */}
      <Section title={t('comms.historyTitle')}>
        <p className="count-note" style={{ marginTop: 0 }}>{t('comms.historyBlurb')}</p>
        <ModuleToolbar>
          {confirmId === 'hist-clear' ? (
            <>
              <button
                className="mini primary"
                onClick={() => {
                  setHist([]);
                  setConfirmId('');
                }}
              >
                {t('comms.confirmBtn')}
              </button>
              <button className="mini" onClick={() => setConfirmId('')}>
                {t('comms.cancelBtn')}
              </button>
            </>
          ) : (
            <button className="mini" disabled={hist.length === 0} onClick={() => setConfirmId('hist-clear')}>
              {t('comms.clearHistoryBtn')}
            </button>
          )}
          <span className="count-note">{t('comms.historyCount', { total: hist.length })}</span>
        </ModuleToolbar>
        <DataTable columns={historyColumns} rows={hist} rowKey={(h) => h.id} empty={t('comms.historyEmpty')} />
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
