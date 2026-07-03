import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ===================== Provider presets (ported from Services/MailProviders.cs) =====================
// Real IMAP/SMTP server defaults so you can set up any client — the same table the WinForge
// account wizard uses to auto-detect Gmail / Outlook / iCloud / Yahoo / … from an email domain.
interface Preset {
  key: string;
  en: string;
  zh: string;
  imapHost: string;
  imapPort: number;
  imapSsl: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSsl: boolean;
  oauth: boolean;
  domains: string[];
}

const PRESETS: Preset[] = [
  { key: 'gmail', en: 'Gmail (Google)', zh: 'Gmail（Google）', imapHost: 'imap.gmail.com', imapPort: 993, imapSsl: true, smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpSsl: false, oauth: true, domains: ['gmail.com', 'googlemail.com'] },
  { key: 'outlook', en: 'Outlook / Microsoft 365', zh: 'Outlook／Microsoft 365', imapHost: 'outlook.office365.com', imapPort: 993, imapSsl: true, smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSsl: false, oauth: true, domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'office365.com'] },
  { key: 'icloud', en: 'iCloud Mail', zh: 'iCloud 郵件', imapHost: 'imap.mail.me.com', imapPort: 993, imapSsl: true, smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSsl: false, oauth: false, domains: ['icloud.com', 'me.com', 'mac.com'] },
  { key: 'yahoo', en: 'Yahoo Mail', zh: 'Yahoo 郵件', imapHost: 'imap.mail.yahoo.com', imapPort: 993, imapSsl: true, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, smtpSsl: true, oauth: false, domains: ['yahoo.com', 'ymail.com', 'rocketmail.com'] },
  { key: 'fastmail', en: 'Fastmail', zh: 'Fastmail', imapHost: 'imap.fastmail.com', imapPort: 993, imapSsl: true, smtpHost: 'smtp.fastmail.com', smtpPort: 465, smtpSsl: true, oauth: false, domains: ['fastmail.com', 'fastmail.fm'] },
  { key: 'gmx', en: 'GMX', zh: 'GMX', imapHost: 'imap.gmx.com', imapPort: 993, imapSsl: true, smtpHost: 'smtp.gmx.com', smtpPort: 587, smtpSsl: false, oauth: false, domains: ['gmx.com', 'gmx.net'] },
  { key: 'zoho', en: 'Zoho Mail', zh: 'Zoho 郵件', imapHost: 'imap.zoho.com', imapPort: 993, imapSsl: true, smtpHost: 'smtp.zoho.com', smtpPort: 465, smtpSsl: true, oauth: false, domains: ['zoho.com', 'zohomail.com'] },
  { key: 'qq', en: 'QQ Mail', zh: 'QQ 郵箱', imapHost: 'imap.qq.com', imapPort: 993, imapSsl: true, smtpHost: 'smtp.qq.com', smtpPort: 465, smtpSsl: true, oauth: false, domains: ['qq.com', 'foxmail.com'] },
  { key: '163', en: 'NetEase 163', zh: '網易 163', imapHost: 'imap.163.com', imapPort: 993, imapSsl: true, smtpHost: 'smtp.163.com', smtpPort: 465, smtpSsl: true, oauth: false, domains: ['163.com'] },
];

/** Guess a preset from an email address (port of MailProviders.Detect). */
function detectPreset(email: string): Preset | null {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return PRESETS.find((p) => p.domains.includes(domain)) ?? null;
}

// ===================== Live-system mail configuration (via Rust/PowerShell bridge) =====================
interface MailSetup {
  DefaultProgId: string;
  DefaultName: string;
  OutlookNew: string;
  OutlookClassic: string;
  Thunderbird: string;
  WindowsMail: string;
  RegisteredClients: string;
}

interface OutlookAccount {
  Profile: string;
  Account: string;
  Email: string;
  ImapServer: string;
  SmtpServer: string;
}

// One PowerShell payload that discovers the machine's mail configuration read-only.
const SETUP_PS = String.raw`
$ErrorActionPreference='SilentlyContinue'
function RegVal($p,$n){ (Get-ItemProperty -Path $p -Name $n -ErrorAction SilentlyContinue).$n }
$prog = RegVal 'HKCU:\SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\mailto\UserChoice' 'ProgId'
if (-not $prog) { $prog = '' }
$name = ''
if ($prog) {
  $name = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\$prog" -ErrorAction SilentlyContinue).'(default)'
  if (-not $name) {
    $app = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $prog -like ('*' + ($_.PackageFamilyName -replace '.*!','') + '*') -or $_.PackageFamilyName -eq ($prog -replace '!.*','') } | Select-Object -First 1
    if ($app) { $name = $app.Name }
  }
}
$newOutlook = (Get-AppxPackage 'Microsoft.OutlookForWindows' -ErrorAction SilentlyContinue | Select-Object -First 1).Version
$comm = (Get-AppxPackage 'microsoft.windowscommunicationsapps' -ErrorAction SilentlyContinue | Select-Object -First 1).Version
$classic = ''
foreach ($p in @(
  'C:\Program Files\Microsoft Office\root\Office16\OUTLOOK.EXE',
  'C:\Program Files (x86)\Microsoft Office\root\Office16\OUTLOOK.EXE',
  'C:\Program Files (x86)\Microsoft Office\Office16\OUTLOOK.EXE')) {
  if (Test-Path $p) { $classic = (Get-Item $p).VersionInfo.ProductVersion; break }
}
$tbird = ''
$pf   = [Environment]::GetEnvironmentVariable('ProgramFiles')
$pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
foreach ($p in @(
  (Join-Path $pf 'Mozilla Thunderbird\thunderbird.exe'),
  (Join-Path $pf86 'Mozilla Thunderbird\thunderbird.exe'))) {
  if ($p -and (Test-Path $p)) { $tbird = (Get-Item $p).VersionInfo.ProductVersion; break }
}
$clients = (Get-ChildItem 'HKLM:\SOFTWARE\Clients\Mail' -ErrorAction SilentlyContinue | ForEach-Object { $_.PSChildName }) -join ', '
[pscustomobject]@{
  DefaultProgId    = "$prog"
  DefaultName      = "$name"
  OutlookNew       = "$newOutlook"
  OutlookClassic   = "$classic"
  Thunderbird      = "$tbird"
  WindowsMail      = "$comm"
  RegisteredClients= "$clients"
}
`;

// Outlook accounts live under the classic-Outlook profile hive (IMAP/SMTP server + email, no passwords).
const ACCOUNTS_PS = String.raw`
$ErrorActionPreference='SilentlyContinue'
function DecStr($v){
  if ($null -eq $v) { return '' }
  if ($v -is [byte[]]) { return ([System.Text.Encoding]::Unicode.GetString($v)).Trim([char]0) }
  return "$v"
}
$root='HKCU:\SOFTWARE\Microsoft\Office\16.0\Outlook\Profiles'
$out=@()
Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
  $prof=$_.PSChildName
  Get-ChildItem "$($_.PSPath)\9375CFF0413111d3B88A00104B2A6676" -ErrorAction SilentlyContinue | ForEach-Object {
    $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    $email = DecStr $props.'Email'
    $acct  = DecStr $props.'Account Name'
    $imap  = DecStr $props.'IMAP Server'
    $smtp  = DecStr $props.'SMTP Server'
    if ($email -or $acct) {
      $out += [pscustomobject]@{
        Profile    = "$prof"
        Account    = $acct
        Email      = $email
        ImapServer = $imap
        SmtpServer = $smtp
      }
    }
  }
}
$out
`;

export function MailModule() {
  const { t } = useTranslation();
  const [emailProbe, setEmailProbe] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setup = useAsync(() => runPowershellJson<MailSetup>(SETUP_PS), []);
  const accounts = useAsync(() => runPowershellJson<OutlookAccount>(ACCOUNTS_PS), []);

  const info = (setup.data && setup.data[0]) || null;

  const detected = useMemo(() => detectPreset(emailProbe.trim()), [emailProbe]);

  // Launch the system default mail client (opens a blank compose window via mailto:).
  const compose = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await runPowershell("Start-Process 'mailto:'; 'ok'");
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg(t('mail.composeOpened'));
    } catch (e) {
      setMsg(`${t('mail.composeFailed')}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Detected mail apps as StatusDot rows.
  const apps: { label: string; present: boolean; detail: string }[] = info
    ? [
        { label: t('mail.appOutlookNew'), present: !!info.OutlookNew, detail: info.OutlookNew },
        { label: t('mail.appOutlookClassic'), present: !!info.OutlookClassic, detail: info.OutlookClassic },
        { label: t('mail.appWindowsMail'), present: !!info.WindowsMail, detail: info.WindowsMail },
        { label: t('mail.appThunderbird'), present: !!info.Thunderbird, detail: info.Thunderbird },
      ]
    : [];

  const acctRows = accounts.data ?? [];

  const presetCols: Column<Preset>[] = [
    {
      key: 'name',
      header: t('mail.provider'),
      render: (p) => <strong>{p.en}</strong>,
    },
    {
      key: 'imap',
      header: t('mail.imap'),
      render: (p) => (
        <code>
          {p.imapHost}:{p.imapPort} {p.imapSsl ? 'SSL' : 'STARTTLS'}
        </code>
      ),
    },
    {
      key: 'smtp',
      header: t('mail.smtp'),
      render: (p) => (
        <code>
          {p.smtpHost}:{p.smtpPort} {p.smtpSsl ? 'SSL' : 'STARTTLS'}
        </code>
      ),
    },
    {
      key: 'auth',
      header: t('mail.auth'),
      width: 140,
      render: (p) => (p.oauth ? t('mail.oauth') : t('mail.appPassword')),
    },
    {
      key: 'domains',
      header: t('mail.domains'),
      render: (p) => <span className="count-note">{p.domains.join(', ')}</span>,
    },
  ];

  const acctCols: Column<OutlookAccount>[] = [
    { key: 'Account', header: t('mail.accountName') },
    { key: 'Email', header: t('mail.email') },
    { key: 'ImapServer', header: t('mail.imapServer'), render: (a) => <code>{a.ImapServer || '—'}</code> },
    { key: 'SmtpServer', header: t('mail.smtpServer'), render: (a) => <code>{a.SmtpServer || '—'}</code> },
    { key: 'Profile', header: t('mail.profile'), width: 140 },
  ];

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini primary" disabled={busy} onClick={compose}>
          ✉ {t('mail.compose')}
        </button>
        <button
          className="mini"
          onClick={() => {
            setup.reload();
            accounts.reload();
          }}
        >
          ⟳ {t('modules.refresh')}
        </button>
        {info?.DefaultName ? (
          <span className="count-note">
            {t('mail.defaultClient')}: <strong>{info.DefaultName}</strong>
          </span>
        ) : null}
      </ModuleToolbar>

      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mail.blurb')}
      </p>
      {msg && <p className="mod-msg">{msg}</p>}

      {/* ---- Installed mail apps ---- */}
      <h3 style={{ margin: '14px 0 6px' }}>{t('mail.installedApps')}</h3>
      <AsyncState loading={setup.loading} error={setup.error}>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', gap: 12 }}>
          {apps.map((a) => (
            <span key={a.label} title={a.detail}>
              <StatusDot ok={a.present} label={a.present ? `${a.label} ${a.detail}`.trim() : `${a.label} — ${t('mail.notInstalled')}`} />
            </span>
          ))}
        </div>
        {info?.RegisteredClients ? (
          <p className="count-note">
            {t('mail.registeredClients')}: {info.RegisteredClients}
          </p>
        ) : null}
      </AsyncState>

      {/* ---- Discovered accounts ---- */}
      <h3 style={{ margin: '18px 0 6px' }}>{t('mail.accounts')}</h3>
      <AsyncState loading={accounts.loading} error={accounts.error}>
        <DataTable
          columns={acctCols}
          rows={acctRows}
          rowKey={(a, i) => `${a.Profile}-${a.Email}-${i}`}
          empty={t('mail.noAccounts')}
        />
      </AsyncState>

      {/* ---- Provider auto-detect ---- */}
      <h3 style={{ margin: '18px 0 6px' }}>{t('mail.autoDetect')}</h3>
      <ModuleToolbar>
        <input
          className="mod-search"
          style={{ minWidth: 240 }}
          placeholder={t('mail.emailPlaceholder')}
          value={emailProbe}
          onChange={(e) => setEmailProbe(e.target.value)}
        />
      </ModuleToolbar>
      {emailProbe.trim() ? (
        detected ? (
          <div className="hosts-edit" style={{ display: 'block', whiteSpace: 'pre-wrap' }}>
            {`${t('mail.matched')}: ${detected.en}\n`}
            {`IMAP  ${detected.imapHost}:${detected.imapPort}  ${detected.imapSsl ? 'SSL' : 'STARTTLS'}\n`}
            {`SMTP  ${detected.smtpHost}:${detected.smtpPort}  ${detected.smtpSsl ? 'SSL' : 'STARTTLS'}\n`}
            {`${t('mail.auth')}: ${detected.oauth ? t('mail.oauth') : t('mail.appPassword')}`}
          </div>
        ) : (
          <p className="count-note">{t('mail.noMatch')}</p>
        )
      ) : null}

      {/* ---- Provider preset reference ---- */}
      <h3 style={{ margin: '18px 0 6px' }}>{t('mail.providerPresets')}</h3>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mail.presetsNote', { total: PRESETS.length })}
      </p>
      <DataTable columns={presetCols} rows={PRESETS} rowKey={(p) => p.key} />
    </div>
  );
}
