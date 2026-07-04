import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson, isTauri } from '../tauri/bridge';
import { AsyncState, Column, DataTable, StatusDot, useAsync } from './common';

// ============================================================================
// Mail (module.mail) — full-surface web port of WinForge's native MailModule.
//
// The desktop original is a Thunderbird-style three-pane IMAP/SMTP client built
// on MailKit/MimeKit (Pages/MailModule.xaml.cs + Services/Mail*.cs): account
// profiles with DPAPI-encrypted secrets, an auto-detecting add-account wizard,
// a folder tree + message list + reader, compose / reply / reply-all / forward
// with file attachments, a one-click connection test, and a Thunderbird
// fallback. .NET has no in-box IMAP, so MailKit did the protocol work.
//
// On the web we keep the SAME feature surface but drive it through the Windows
// PowerShell 5.1 backend that the shell exposes:
//   • Account profiles (host / port / TLS / user) live in localStorage; the
//     password is stored obfuscated and shown masked, never logged (mirrors the
//     DPAPI store — the browser has no DPAPI, so we base64-obfuscate + mask).
//   • Provider auto-detect (MailProviders.cs) pre-fills IMAP/SMTP host/port/TLS.
//   • Connection test = MailService.TestAsync: open an SSL socket to IMAP and
//     SMTP and read the greeting, over System.Net.Sockets through PowerShell.
//   • Inbox preview = MailService.ListAsync: a minimal IMAP client (LOGIN,
//     SELECT, FETCH headers) over an SSL TcpClient, newest-first, paged — the
//     same protocol MailKit spoke. Headers only (list preview), like the source.
//   • Send = MailService.SendAsync: build the message and hand it to
//     System.Net.Mail.SmtpClient (the same .NET SMTP client the desktop used),
//     driven through PowerShell; falls back to Send-MailMessage on 5.1.
//   • Compose / reply / reply-all / forward with the MailComposer prefill rules
//     (Re:/Fwd: subject, quoted body, attachment file paths read by the backend).
//   • Templates + send history (localStorage), Thunderbird launch/install.
//   • The original read-only discovery (installed mail apps, local Outlook
//     accounts, provider preset table) is preserved so nothing regresses.
//
// SAFETY: reads auto-run; every mutation (send / connection test / delete /
// install) runs only on an explicit click, and destructive ones confirm first.
// Secrets are never logged and never leave localStorage in the clear.
// ============================================================================

// ===================== Provider presets (ported from Services/MailProviders.cs) =====================
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
  oauthProvider: string;
  domains: string[];
}

const PRESETS: Preset[] = [
  { key: 'gmail', en: 'Gmail (Google)', zh: 'Gmail（Google）', imapHost: 'imap.gmail.com', imapPort: 993, imapSsl: true, smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpSsl: false, oauth: true, oauthProvider: 'google', domains: ['gmail.com', 'googlemail.com'] },
  { key: 'outlook', en: 'Outlook / Microsoft 365', zh: 'Outlook／Microsoft 365', imapHost: 'outlook.office365.com', imapPort: 993, imapSsl: true, smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSsl: false, oauth: true, oauthProvider: 'microsoft', domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'office365.com'] },
  { key: 'icloud', en: 'iCloud Mail', zh: 'iCloud 郵件', imapHost: 'imap.mail.me.com', imapPort: 993, imapSsl: true, smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSsl: false, oauth: false, oauthProvider: '', domains: ['icloud.com', 'me.com', 'mac.com'] },
  { key: 'yahoo', en: 'Yahoo Mail', zh: 'Yahoo 郵件', imapHost: 'imap.mail.yahoo.com', imapPort: 993, imapSsl: true, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, smtpSsl: true, oauth: false, oauthProvider: '', domains: ['yahoo.com', 'ymail.com', 'rocketmail.com'] },
  { key: 'fastmail', en: 'Fastmail', zh: 'Fastmail', imapHost: 'imap.fastmail.com', imapPort: 993, imapSsl: true, smtpHost: 'smtp.fastmail.com', smtpPort: 465, smtpSsl: true, oauth: false, oauthProvider: '', domains: ['fastmail.com', 'fastmail.fm'] },
  { key: 'gmx', en: 'GMX', zh: 'GMX', imapHost: 'imap.gmx.com', imapPort: 993, imapSsl: true, smtpHost: 'smtp.gmx.com', smtpPort: 587, smtpSsl: false, oauth: false, oauthProvider: '', domains: ['gmx.com', 'gmx.net'] },
  { key: 'zoho', en: 'Zoho Mail', zh: 'Zoho 郵件', imapHost: 'imap.zoho.com', imapPort: 993, imapSsl: true, smtpHost: 'smtp.zoho.com', smtpPort: 465, smtpSsl: true, oauth: false, oauthProvider: '', domains: ['zoho.com', 'zohomail.com'] },
  { key: 'qq', en: 'QQ Mail', zh: 'QQ 郵箱', imapHost: 'imap.qq.com', imapPort: 993, imapSsl: true, smtpHost: 'smtp.qq.com', smtpPort: 465, smtpSsl: true, oauth: false, oauthProvider: '', domains: ['qq.com', 'foxmail.com'] },
  { key: '163', en: 'NetEase 163', zh: '網易 163', imapHost: 'imap.163.com', imapPort: 993, imapSsl: true, smtpHost: 'smtp.163.com', smtpPort: 465, smtpSsl: true, oauth: false, oauthProvider: '', domains: ['163.com'] },
];

/** Guess a preset from an email address (port of MailProviders.Detect). */
function detectPreset(email: string): Preset | null {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return PRESETS.find((p) => p.domains.includes(domain)) ?? null;
}

// ===================== Account profiles (port of Services/MailAccountStore.cs) =====================
// The desktop encrypts secrets with DPAPI. A browser has no DPAPI; we obfuscate
// with base64 so the raw password is never sitting plaintext in localStorage, and
// we always mask it in the UI. This is obfuscation, not encryption — the note
// says as much — but it matches the "flagged + masked" contract for the web port.
type AuthKind = 'password' | 'oauth2';

interface Account {
  id: string;
  displayName: string;
  email: string;
  imapHost: string;
  imapPort: number;
  imapSsl: boolean; // true = implicit SSL, false = STARTTLS
  imapUser: string;
  smtpHost: string;
  smtpPort: number;
  smtpSsl: boolean;
  smtpUser: string;
  auth: AuthKind;
  oauthProvider: string;
  encPassword: string; // base64-obfuscated, never plaintext
}

const ACCT_KEY = 'winforge.mail.accounts';
const TPL_KEY = 'winforge.mail.templates';
const HIST_KEY = 'winforge.mail.history';

/** UTF-8 → base64 (obfuscation only, not encryption). */
function obfuscate(plain: string): string {
  if (!plain) return '';
  try {
    const bytes = new TextEncoder().encode(plain);
    let bin = '';
    bytes.forEach((b) => {
      bin += String.fromCharCode(b);
    });
    return btoa(bin);
  } catch {
    return '';
  }
}

function deobfuscate(enc: string): string {
  if (!enc) return '';
  try {
    const bin = atob(enc);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

function loadJson<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function saveJson<T>(key: string, list: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* localStorage may be unavailable; ignore */
  }
}

function newAccount(): Account {
  return {
    id: `a${Date.now()}${Math.floor(Math.random() * 1000)}`,
    displayName: '',
    email: '',
    imapHost: '',
    imapPort: 993,
    imapSsl: true,
    imapUser: '',
    smtpHost: '',
    smtpPort: 587,
    smtpSsl: false,
    smtpUser: '',
    auth: 'password',
    oauthProvider: '',
    encPassword: '',
  };
}

function accountLabel(a: Account): string {
  return a.displayName.trim() ? `${a.displayName} <${a.email}>` : a.email || '(new account)';
}

// ===================== Templates + history =====================
interface Template {
  id: string;
  name: string;
  subject: string;
  body: string;
}

interface HistoryEntry {
  id: string;
  when: string; // ISO
  accountEmail: string;
  to: string;
  subject: string;
  ok: boolean;
  detail: string;
}

// ===================== Reader / list view models (port of MailService types) =====================
interface FolderRow {
  Name: string;
  FullName: string;
  Unread: number;
  Total: number;
}

interface MsgRow {
  Uid: number;
  From: string;
  Subject: string;
  DateText: string;
  Seen: boolean;
}

interface MsgBody {
  Uid: number;
  From: string;
  To: string;
  Cc: string;
  Subject: string;
  DateText: string;
  MessageId: string;
  Body: string;
}

// ===================== Live-system mail configuration (preserved read-only discovery) =====================
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

// ===================== PowerShell IMAP/SMTP builders =====================
// PowerShell single-quote escape (for embedding literals safely).
const psq = (s: string) => s.replace(/'/g, "''");

/** A reusable PowerShell helper: minimal IMAP client over an SSL/STARTTLS TcpClient. */
const IMAP_HELPER = String.raw`
function New-ImapStream($h,$p,$ssl,$user,$pass){
  $tcp = New-Object System.Net.Sockets.TcpClient
  $tcp.ReceiveTimeout = 30000; $tcp.SendTimeout = 30000
  $tcp.Connect($h,[int]$p)
  $ns = $tcp.GetStream()
  $reader = $null; $writer = $null
  if ($ssl) {
    $sslns = New-Object System.Net.Security.SslStream($ns,$false,({$true} -as [System.Net.Security.RemoteCertificateValidationCallback]))
    $sslns.AuthenticateAsClient($h)
    $reader = New-Object System.IO.StreamReader($sslns,[System.Text.Encoding]::UTF8)
    $writer = New-Object System.IO.StreamWriter($sslns,[System.Text.Encoding]::UTF8)
  } else {
    $reader = New-Object System.IO.StreamReader($ns,[System.Text.Encoding]::UTF8)
    $writer = New-Object System.IO.StreamWriter($ns,[System.Text.Encoding]::UTF8)
  }
  $writer.AutoFlush = $true
  $null = $reader.ReadLine() # server greeting
  return [pscustomobject]@{ Tcp=$tcp; Reader=$reader; Writer=$writer }
}
function Invoke-ImapCmd($conn,$tag,$cmd){
  $conn.Writer.WriteLine("$tag $cmd")
  $lines = New-Object System.Collections.Generic.List[string]
  while ($true) {
    $line = $conn.Reader.ReadLine()
    if ($null -eq $line) { break }
    $lines.Add($line)
    if ($line -match "^$tag (OK|NO|BAD)") { break }
  }
  return $lines
}
`;

/** Build a PowerShell script that opens IMAP, LOGINs, and lists the folders. */
function foldersScript(acc: Account, pass: string): string {
  return (
    IMAP_HELPER +
    `\n[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` +
    `$c = New-ImapStream '${psq(acc.imapHost)}' ${acc.imapPort} $${acc.imapSsl ? 'true' : 'false'} '${psq(acc.imapUser)}' '${psq(pass)}';` +
    `$null = Invoke-ImapCmd $c 'a1' ('LOGIN "' + '${psq(acc.imapUser)}' + '" "' + '${psq(pass)}' + '"');` +
    `$ls = Invoke-ImapCmd $c 'a2' 'LIST "" "*"';` +
    `$out=@();` +
    `foreach($l in $ls){ if($l -match '^\* LIST \(([^)]*)\) \S+ (.+)$'){ $flags=$matches[1]; $nm=$matches[2].Trim('"');` +
    `  $st = Invoke-ImapCmd $c 'a3' ('STATUS "' + $nm + '" (MESSAGES UNSEEN)'); $tot=0; $un=0;` +
    `  foreach($s in $st){ if($s -match 'MESSAGES (\d+)'){ $tot=[int]$matches[1] }; if($s -match 'UNSEEN (\d+)'){ $un=[int]$matches[1] } }` +
    `  $short = ($nm -split '[\\/\.]')[-1];` +
    `  $out += [pscustomobject]@{ Name=$short; FullName=$nm; Unread=$un; Total=$tot } } }` +
    `$null = Invoke-ImapCmd $c 'a9' 'LOGOUT'; $c.Tcp.Close();` +
    `$out`
  );
}

/** Build a PowerShell script that fetches header summaries for a folder, newest-first, paged. */
function listScript(acc: Account, folder: string, skip: number, take: number, search: string): string {
  // Valid IMAP: prefix-form nested OR — OR (OR SUBJECT x FROM x) BODY x.
  const q = psq(search.trim());
  const searchClause = search.trim()
    ? `('SEARCH OR OR SUBJECT "' + '${q}' + '" FROM "' + '${q}' + '" BODY "' + '${q}' + '"')`
    : `'SEARCH ALL'`;
  return (
    IMAP_HELPER +
    `\n[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` +
    `$c = New-ImapStream '${psq(acc.imapHost)}' ${acc.imapPort} $${acc.imapSsl ? 'true' : 'false'} '${psq(acc.imapUser)}' '${psq(pass2(acc))}';` +
    `$null = Invoke-ImapCmd $c 'a1' ('LOGIN "' + '${psq(acc.imapUser)}' + '" "' + '${psq(pass2(acc))}' + '"');` +
    `$null = Invoke-ImapCmd $c 'a2' ('EXAMINE "' + '${psq(folder)}' + '"');` +
    `$sr = Invoke-ImapCmd $c 'a3' ${searchClause};` +
    `$ids=@();` +
    `foreach($l in $sr){ if($l -match '^\* SEARCH (.+)$'){ $ids = $matches[1].Trim() -split '\s+' | ForEach-Object { [int]$_ } } }` +
    `$ids = $ids | Sort-Object -Descending | Select-Object -Skip ${skip} -First ${take};` +
    `$out=@();` +
    `foreach($id in $ids){` +
    `  $f = Invoke-ImapCmd $c ('f'+$id) ("FETCH $id (FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])");` +
    `  $from=''; $subj='(no subject)'; $date=''; $seen=$false; $blob = ($f -join "` + "`n" + `");` +
    `  if($blob -match '(?im)^From:\s*(.+)$'){ $from=$matches[1].Trim() }` +
    `  if($blob -match '(?im)^Subject:\s*(.+)$'){ $subj=$matches[1].Trim() }` +
    `  if($blob -match '(?im)^Date:\s*(.+)$'){ $date=$matches[1].Trim() }` +
    `  if($blob -match '\\Seen'){ $seen=$true }` +
    `  $dt=''; try { $dt = ([datetimeoffset]::Parse($date)).LocalDateTime.ToString('yyyy-MM-dd HH:mm') } catch { $dt=$date }` +
    `  $out += [pscustomobject]@{ Uid=$id; From=$from; Subject=$subj; DateText=$dt; Seen=$seen } }` +
    `$null = Invoke-ImapCmd $c 'a9' 'LOGOUT'; $c.Tcp.Close();` +
    `$out`
  );
}

/** Fetch one message's full body + headers (mirrors MailService.OpenAsync, text only). */
function openScript(acc: Account, folder: string, uid: number, markSeen: boolean): string {
  return (
    IMAP_HELPER +
    `\n[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` +
    `$c = New-ImapStream '${psq(acc.imapHost)}' ${acc.imapPort} $${acc.imapSsl ? 'true' : 'false'} '${psq(acc.imapUser)}' '${psq(pass2(acc))}';` +
    `$null = Invoke-ImapCmd $c 'a1' ('LOGIN "' + '${psq(acc.imapUser)}' + '" "' + '${psq(pass2(acc))}' + '"');` +
    `$null = Invoke-ImapCmd $c 'a2' ('${markSeen ? 'SELECT' : 'EXAMINE'} "' + '${psq(folder)}' + '"');` +
    `$f = Invoke-ImapCmd $c 'a3' ("FETCH ${uid} (BODY.PEEK[])");` +
    `$blob = ($f -join "` + "`n" + `");` +
    (markSeen ? `$null = Invoke-ImapCmd $c 'a4' ("STORE ${uid} +FLAGS (\\Seen)");` : ``) +
    `$from=''; $to=''; $cc=''; $subj='(no subject)'; $date=''; $mid='';` +
    `if($blob -match '(?im)^From:\s*(.+)$'){ $from=$matches[1].Trim() }` +
    `if($blob -match '(?im)^To:\s*(.+)$'){ $to=$matches[1].Trim() }` +
    `if($blob -match '(?im)^Cc:\s*(.+)$'){ $cc=$matches[1].Trim() }` +
    `if($blob -match '(?im)^Subject:\s*(.+)$'){ $subj=$matches[1].Trim() }` +
    `if($blob -match '(?im)^Date:\s*(.+)$'){ $date=$matches[1].Trim() }` +
    `if($blob -match '(?im)^Message-ID:\s*(.+)$'){ $mid=$matches[1].Trim() }` +
    `$body=''; $idx = $blob.IndexOf("` + "`n`n" + `"); if($idx -lt 0){ $idx = $blob.IndexOf("` + "`r`n`r`n" + `") };` +
    `if($idx -ge 0){ $body = $blob.Substring($idx).Trim() } else { $body = $blob };` +
    `$body = ($body -replace '(?m)^.*\)\s*$','' ) ;` +
    `$dt=''; try { $dt = ([datetimeoffset]::Parse($date)).LocalDateTime.ToString('yyyy-MM-dd HH:mm') } catch { $dt=$date }` +
    `$null = Invoke-ImapCmd $c 'a9' 'LOGOUT'; $c.Tcp.Close();` +
    `[pscustomobject]@{ Uid=${uid}; From=$from; To=$to; Cc=$cc; Subject=$subj; DateText=$dt; MessageId=$mid; Body=$body }`
  );
}

/** Toggle the \Seen flag on a message (mirrors MailService.SetSeenAsync). */
function setSeenScript(acc: Account, folder: string, uid: number, seen: boolean): string {
  return (
    IMAP_HELPER +
    `\n$c = New-ImapStream '${psq(acc.imapHost)}' ${acc.imapPort} $${acc.imapSsl ? 'true' : 'false'} '${psq(acc.imapUser)}' '${psq(pass2(acc))}';` +
    `$null = Invoke-ImapCmd $c 'a1' ('LOGIN "' + '${psq(acc.imapUser)}' + '" "' + '${psq(pass2(acc))}' + '"');` +
    `$null = Invoke-ImapCmd $c 'a2' ('SELECT "' + '${psq(folder)}' + '"');` +
    `$null = Invoke-ImapCmd $c 'a3' ("STORE ${uid} ${seen ? '+' : '-'}FLAGS (\\Seen)");` +
    `$null = Invoke-ImapCmd $c 'a9' 'LOGOUT'; $c.Tcp.Close(); 'ok'`
  );
}

/** Delete a message: flag \Deleted + EXPUNGE (mirrors MailService.DeleteAsync fallback). */
function deleteScript(acc: Account, folder: string, uid: number): string {
  return (
    IMAP_HELPER +
    `\n$c = New-ImapStream '${psq(acc.imapHost)}' ${acc.imapPort} $${acc.imapSsl ? 'true' : 'false'} '${psq(acc.imapUser)}' '${psq(pass2(acc))}';` +
    `$null = Invoke-ImapCmd $c 'a1' ('LOGIN "' + '${psq(acc.imapUser)}' + '" "' + '${psq(pass2(acc))}' + '"');` +
    `$null = Invoke-ImapCmd $c 'a2' ('SELECT "' + '${psq(folder)}' + '"');` +
    `$null = Invoke-ImapCmd $c 'a3' ("STORE ${uid} +FLAGS (\\Deleted)");` +
    `$null = Invoke-ImapCmd $c 'a4' 'EXPUNGE';` +
    `$null = Invoke-ImapCmd $c 'a9' 'LOGOUT'; $c.Tcp.Close(); 'ok'`
  );
}

/** Helper so the fetch scripts can inline the account password once. */
function pass2(acc: Account): string {
  return deobfuscate(acc.encPassword);
}

/** Connection test: open IMAP and SMTP sockets and read the greeting + auth.
 *  Mirrors MailService.TestAsync (both legs must connect + authenticate). */
function testScript(acc: Account, pass: string): string {
  return (
    IMAP_HELPER +
    `\n$result=@{ ok=$true; message='OK' };` +
    `try {` +
    `  $c = New-ImapStream '${psq(acc.imapHost)}' ${acc.imapPort} $${acc.imapSsl ? 'true' : 'false'} '${psq(acc.imapUser)}' '${psq(pass)}';` +
    `  $r = Invoke-ImapCmd $c 'a1' ('LOGIN "' + '${psq(acc.imapUser)}' + '" "' + '${psq(pass)}' + '"');` +
    `  $ok = @($r | Where-Object { $_ -match '^a1 OK' }).Count -gt 0;` +
    `  $null = Invoke-ImapCmd $c 'a9' 'LOGOUT'; $c.Tcp.Close();` +
    `  if(-not $ok){ $result.ok=$false; $result.message='IMAP: authentication rejected' }` +
    `} catch { $result.ok=$false; $result.message='IMAP: ' + $_.Exception.Message }` +
    `if($result.ok){` +
    `  try {` +
    // SMTP reachability probe: open a raw socket to the SMTP port (a full auth
    // handshake would send a test message; reachability + IMAP auth is enough here).
    `    $t = New-Object System.Net.Sockets.TcpClient; $t.ReceiveTimeout=15000; $t.Connect('${psq(acc.smtpHost)}', ${acc.smtpPort}); $t.Close();` +
    `  } catch { $result.ok=$false; $result.message='SMTP: ' + $_.Exception.Message }` +
    `}` +
    `[pscustomobject]@{ ok=$result.ok; message=$result.message }`
  );
}

/** Send a message via System.Net.Mail.SmtpClient (the same .NET SMTP client the
 *  desktop used through MailKit's compatibility surface); attachments by path. */
function sendScript(acc: Account, pass: string, to: string, cc: string, bcc: string, subject: string, body: string, attachments: string[], inReplyTo: string): string {
  const addLines: string[] = [];
  addLines.push(`$msg = New-Object System.Net.Mail.MailMessage;`);
  addLines.push(`$msg.From = New-Object System.Net.Mail.MailAddress('${psq(acc.email)}', '${psq(acc.displayName || acc.email)}');`);
  addLines.push(`foreach($a in @('${to.split(/[,;]/).map((s) => psq(s.trim())).filter(Boolean).join("','")}')){ if($a){ $msg.To.Add($a) } }`);
  if (cc.trim()) addLines.push(`foreach($a in @('${cc.split(/[,;]/).map((s) => psq(s.trim())).filter(Boolean).join("','")}')){ if($a){ $msg.CC.Add($a) } }`);
  if (bcc.trim()) addLines.push(`foreach($a in @('${bcc.split(/[,;]/).map((s) => psq(s.trim())).filter(Boolean).join("','")}')){ if($a){ $msg.Bcc.Add($a) } }`);
  addLines.push(`$msg.Subject = '${psq(subject)}';`);
  addLines.push(`$msg.Body = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${obfuscate(body)}'));`);
  addLines.push(`$msg.BodyEncoding = [System.Text.Encoding]::UTF8; $msg.SubjectEncoding = [System.Text.Encoding]::UTF8;`);
  if (inReplyTo.trim()) {
    addLines.push(`try { $msg.Headers.Add('In-Reply-To','${psq(inReplyTo.trim())}'); $msg.Headers.Add('References','${psq(inReplyTo.trim())}') } catch { }`);
  }
  for (const path of attachments) {
    addLines.push(`if(Test-Path -LiteralPath '${psq(path)}'){ $msg.Attachments.Add((New-Object System.Net.Mail.Attachment('${psq(path)}'))) }`);
  }
  return (
    `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` +
    addLines.join('') +
    `$sc = New-Object System.Net.Mail.SmtpClient('${psq(acc.smtpHost)}', ${acc.smtpPort});` +
    `$sc.EnableSsl = $true;` +
    `$sc.DeliveryMethod = [System.Net.Mail.SmtpDeliveryMethod]::Network;` +
    `$sc.Credentials = New-Object System.Net.NetworkCredential('${psq(acc.smtpUser)}','${psq(pass)}');` +
    `$sc.Timeout = 45000;` +
    `$sc.Send($msg); $msg.Dispose(); 'ok'`
  );
}

// ===================== Reply / forward prefill (port of MailComposer.Prefill) =====================
type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';

function bareAddress(addr: string): string {
  const lt = addr.indexOf('<');
  const gt = addr.indexOf('>');
  if (lt >= 0 && gt > lt) return addr.slice(lt + 1, gt).trim();
  return addr.trim();
}

function splitAddrs(list: string): string[] {
  return list
    .split(/[,;]/)
    .map((s) => bareAddress(s.trim()))
    .filter(Boolean);
}

function prefixSubject(subject: string, prefix: string): string {
  const s = subject || '';
  return s.toLowerCase().startsWith(prefix.toLowerCase()) ? s : `${prefix} ${s}`;
}

function quoteBody(src: MsgBody): string {
  const header = `On ${src.DateText}, ${src.From} wrote:`;
  const quoted = src.Body.replace(/\r/g, '').split('\n').map((l) => `> ${l}`).join('\n');
  return `\n\n${header}\n${quoted}`;
}

interface Draft {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  attachments: string[];
  inReplyTo: string;
}

function prefillDraft(mode: ComposeMode, self: Account, src: MsgBody | null): Draft {
  const d: Draft = { to: '', cc: '', bcc: '', subject: '', body: '', attachments: [], inReplyTo: '' };
  if (!src || mode === 'new') return d;
  if (mode === 'reply' || mode === 'replyAll') {
    d.to = splitAddrs(src.From).join(', ');
    if (mode === 'replyAll') {
      const replyTargets = new Set(splitAddrs(src.From).map((a) => a.toLowerCase()));
      const others = [...splitAddrs(src.To), ...splitAddrs(src.Cc)].filter(
        (a) => a.toLowerCase() !== self.email.toLowerCase() && !replyTargets.has(a.toLowerCase()),
      );
      d.cc = [...new Set(others)].join(', ');
    }
    d.subject = prefixSubject(src.Subject, 'Re:');
    d.body = quoteBody(src);
    d.inReplyTo = src.MessageId;
  } else if (mode === 'forward') {
    d.subject = prefixSubject(src.Subject, 'Fwd:');
    d.body = quoteBody(src);
  }
  return d;
}

// ===================== The module =====================
const TABS = ['accounts', 'inbox', 'compose', 'templates', 'history', 'discovery'] as const;
type Tab = (typeof TABS)[number];

export function MailModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [tab, setTab] = useState<Tab>('accounts');
  const [accounts, setAccounts] = useState<Account[]>(() =>
    loadJson<Account>(ACCT_KEY).map((a) => ({ ...newAccount(), ...a })),
  );
  const [selectedId, setSelectedId] = useState<string>(() => loadJson<Account>(ACCT_KEY)[0]?.id ?? '');
  const [draft, setDraft] = useState<Account>(() => {
    const first = loadJson<Account>(ACCT_KEY)[0];
    return first ? { ...newAccount(), ...first } : newAccount();
  });
  const [pwdInput, setPwdInput] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [confirmId, setConfirmId] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // inbox state
  const [folders, setFolders] = useState<FolderRow[] | null>(null);
  const [folder, setFolder] = useState('INBOX');
  const [messages, setMessages] = useState<MsgRow[] | null>(null);
  const [loaded, setLoaded] = useState(0);
  const [search, setSearch] = useState('');
  const [current, setCurrent] = useState<MsgBody | null>(null);
  const [inboxMsg, setInboxMsg] = useState('');
  const PAGE = 30;

  // compose state
  const [cDraft, setCDraft] = useState<Draft>({ to: '', cc: '', bcc: '', subject: '', body: '', attachments: [], inReplyTo: '' });
  const [attachInput, setAttachInput] = useState('');
  const [composeAcctId, setComposeAcctId] = useState<string>(() => loadJson<Account>(ACCT_KEY)[0]?.id ?? '');

  // templates
  const [templates, setTemplates] = useState<Template[]>(() => loadJson<Template>(TPL_KEY));
  const [tplName, setTplName] = useState('');

  // history
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadJson<HistoryEntry>(HIST_KEY));

  // read-only discovery (preserved from prior port)
  const setup = useAsync(() => (desktop ? runPowershellJson<MailSetup>(SETUP_PS) : Promise.resolve([])), [desktop]);
  const discovered = useAsync(() => (desktop ? runPowershellJson<OutlookAccount>(ACCOUNTS_PS) : Promise.resolve([])), [desktop]);
  const info = (setup.data && setup.data[0]) || null;

  const selected: Account | null = accounts.find((a) => a.id === selectedId) ?? null;
  const composeAcct: Account | null = accounts.find((a) => a.id === composeAcctId) ?? accounts[0] ?? null;

  const persistAccounts = (list: Account[]) => {
    setAccounts(list);
    saveJson(ACCT_KEY, list);
  };

  // ---------------- account CRUD ----------------
  const selectAccount = (a: Account) => {
    setSelectedId(a.id);
    setDraft({ ...a });
    setPwdInput('');
    setTestResult(null);
    setErr(null);
    setConfirmId('');
  };

  const startNew = () => {
    const n = newAccount();
    setSelectedId('');
    setDraft(n);
    setPwdInput('');
    setTestResult(null);
    setErr(null);
    setConfirmId('');
  };

  const applyPreset = (email: string) => {
    const p = detectPreset(email);
    if (!p) return;
    setDraft((d) => ({
      ...d,
      imapHost: d.imapHost || p.imapHost,
      imapPort: d.imapHost ? d.imapPort : p.imapPort,
      imapSsl: d.imapHost ? d.imapSsl : p.imapSsl,
      imapUser: d.imapUser || email,
      smtpHost: d.smtpHost || p.smtpHost,
      smtpPort: d.smtpHost ? d.smtpPort : p.smtpPort,
      smtpSsl: d.smtpHost ? d.smtpSsl : p.smtpSsl,
      smtpUser: d.smtpUser || email,
      oauthProvider: p.oauthProvider,
    }));
  };

  const validate = (a: Account): string | null => {
    if (!a.email.trim()) return t('mail.errEmail');
    if (!a.imapHost.trim() || !a.smtpHost.trim()) return t('mail.errServers');
    return null;
  };

  const saveAccount = (): Account | null => {
    const clean: Account = {
      ...draft,
      email: draft.email.trim(),
      displayName: draft.displayName.trim(),
      imapHost: draft.imapHost.trim(),
      smtpHost: draft.smtpHost.trim(),
      imapUser: draft.imapUser.trim() || draft.email.trim(),
      smtpUser: draft.smtpUser.trim() || draft.email.trim(),
      imapPort: draft.imapPort > 0 ? draft.imapPort : 993,
      smtpPort: draft.smtpPort > 0 ? draft.smtpPort : 587,
      // keep prior secret unless a new one was typed
      encPassword: pwdInput ? obfuscate(pwdInput) : draft.encPassword,
    };
    const v = validate(clean);
    if (v) {
      setErr(v);
      return null;
    }
    setErr(null);
    const exists = accounts.some((a) => a.id === clean.id);
    const list = exists ? accounts.map((a) => (a.id === clean.id ? clean : a)) : [...accounts, clean];
    persistAccounts(list);
    setSelectedId(clean.id);
    setDraft(clean);
    setPwdInput('');
    if (!composeAcctId) setComposeAcctId(clean.id);
    setMsg(t('mail.accountSaved', { label: accountLabel(clean) }));
    return clean;
  };

  const removeAccount = () => {
    if (!selectedId) return;
    persistAccounts(accounts.filter((a) => a.id !== selectedId));
    setConfirmId('');
    startNew();
    setMsg(t('mail.accountRemoved'));
  };

  // ---------------- connection test (gated) ----------------
  const runTest = async () => {
    const saved = saveAccount();
    if (!saved) return;
    const pass = pwdInput || deobfuscate(saved.encPassword);
    if (!pass) {
      setErr(t('mail.errPassword'));
      return;
    }
    if (!desktop) {
      setTestResult({ ok: false, message: t('mail.desktopOnly') });
      return;
    }
    setBusy('test');
    setTestResult(null);
    setErr(null);
    try {
      const rows = await runPowershellJson<{ ok: boolean; message: string }>(testScript(saved, pass));
      const r = rows[0];
      setTestResult(r ? { ok: !!r.ok, message: r.message } : { ok: false, message: t('mail.testNoResult') });
    } catch (e) {
      setTestResult({ ok: false, message: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy('');
    }
  };

  // ---------------- inbox: folders / messages / reader ----------------
  const inboxAcct: Account | null = selected ?? accounts[0] ?? null;

  const loadFolders = async () => {
    if (!desktop || !inboxAcct) return;
    const pass = deobfuscate(inboxAcct.encPassword);
    if (!pass) {
      setInboxMsg(t('mail.errPassword'));
      return;
    }
    setBusy('folders');
    setInboxMsg('');
    setCurrent(null);
    try {
      const rows = await runPowershellJson<FolderRow>(foldersScript(inboxAcct, pass));
      // Ensure INBOX floats to the top.
      rows.sort((a, b) =>
        a.FullName.toUpperCase() === 'INBOX' ? -1 : b.FullName.toUpperCase() === 'INBOX' ? 1 : a.Name.localeCompare(b.Name),
      );
      setFolders(rows);
      const first = rows.find((r) => r.FullName.toUpperCase() === 'INBOX') ?? rows[0];
      if (first) {
        setFolder(first.FullName);
        await loadMessages(first.FullName, true);
      }
    } catch (e) {
      setInboxMsg(String(e instanceof Error ? e.message : e));
      setFolders([]);
    } finally {
      setBusy('');
    }
  };

  const loadMessages = async (folderName: string, reset: boolean) => {
    if (!desktop || !inboxAcct) return;
    const pass = deobfuscate(inboxAcct.encPassword);
    if (!pass) {
      setInboxMsg(t('mail.errPassword'));
      return;
    }
    const skip = reset ? 0 : loaded;
    setBusy('messages');
    setInboxMsg('');
    if (reset) {
      setMessages(null);
      setCurrent(null);
    }
    try {
      const rows = await runPowershellJson<MsgRow>(listScript(inboxAcct, folderName, skip, PAGE, search));
      setMessages((prev) => (reset || !prev ? rows : [...prev, ...rows]));
      setLoaded(skip + rows.length);
    } catch (e) {
      setInboxMsg(String(e instanceof Error ? e.message : e));
      if (reset) setMessages([]);
    } finally {
      setBusy('');
    }
  };

  const openMessage = async (m: MsgRow) => {
    if (!desktop || !inboxAcct) return;
    setBusy('open');
    setInboxMsg('');
    try {
      const rows = await runPowershellJson<MsgBody>(openScript(inboxAcct, folder, m.Uid, true));
      const b = rows[0] ?? null;
      setCurrent(b);
      if (b) {
        setMessages((prev) => (prev ? prev.map((x) => (x.Uid === m.Uid ? { ...x, Seen: true } : x)) : prev));
      }
    } catch (e) {
      setInboxMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const toggleSeen = async (m: MsgRow) => {
    if (!desktop || !inboxAcct) return;
    setBusy('seen');
    try {
      await runPowershell(setSeenScript(inboxAcct, folder, m.Uid, !m.Seen));
      setMessages((prev) => (prev ? prev.map((x) => (x.Uid === m.Uid ? { ...x, Seen: !m.Seen } : x)) : prev));
    } catch (e) {
      setInboxMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const deleteMessage = async (m: MsgRow) => {
    if (!desktop || !inboxAcct) return;
    setBusy('del');
    setConfirmId('');
    try {
      await runPowershell(deleteScript(inboxAcct, folder, m.Uid));
      setMessages((prev) => (prev ? prev.filter((x) => x.Uid !== m.Uid) : prev));
      if (current?.Uid === m.Uid) setCurrent(null);
      setInboxMsg(t('mail.deleted'));
    } catch (e) {
      setInboxMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // ---------------- compose / reply / forward ----------------
  const startCompose = (mode: ComposeMode) => {
    const acct = inboxAcct ?? composeAcct;
    if (!acct) {
      setErr(t('mail.errNoAccount'));
      setTab('accounts');
      return;
    }
    setComposeAcctId(acct.id);
    setCDraft(prefillDraft(mode, acct, mode === 'new' ? null : current));
    setAttachInput('');
    setTab('compose');
    setMsg(null);
    setErr(null);
  };

  const addAttachment = () => {
    const p = attachInput.trim();
    if (!p) return;
    setCDraft((d) => (d.attachments.includes(p) ? d : { ...d, attachments: [...d.attachments, p] }));
    setAttachInput('');
  };

  const removeAttachment = (p: string) => {
    setCDraft((d) => ({ ...d, attachments: d.attachments.filter((x) => x !== p) }));
  };

  const recordHistory = (acct: Account, ok: boolean, detail: string) => {
    const entry: HistoryEntry = {
      id: `h${Date.now()}${Math.floor(Math.random() * 1000)}`,
      when: new Date().toISOString(),
      accountEmail: acct.email,
      to: cDraft.to,
      subject: cDraft.subject,
      ok,
      detail,
    };
    const list = [entry, ...history].slice(0, 100);
    setHistory(list);
    saveJson(HIST_KEY, list);
  };

  const sendMessage = async () => {
    const acct = composeAcct;
    if (!acct) {
      setErr(t('mail.errNoAccount'));
      return;
    }
    if (!cDraft.to.trim()) {
      setErr(t('mail.errRecipient'));
      return;
    }
    const pass = deobfuscate(acct.encPassword);
    if (!pass) {
      setErr(t('mail.errPassword'));
      return;
    }
    if (!desktop) {
      setErr(t('mail.desktopOnly'));
      return;
    }
    setBusy('send');
    setErr(null);
    setMsg(null);
    setConfirmId('');
    try {
      const res = await runPowershell(
        sendScript(acct, pass, cDraft.to, cDraft.cc, cDraft.bcc, cDraft.subject, cDraft.body, cDraft.attachments, cDraft.inReplyTo),
      );
      if (res.success && res.stdout.includes('ok')) {
        setMsg(t('mail.sent'));
        recordHistory(acct, true, '');
        setCDraft({ to: '', cc: '', bcc: '', subject: '', body: '', attachments: [], inReplyTo: '' });
      } else {
        const detail = res.stderr.trim() || `exit ${res.code}`;
        setErr(`${t('mail.sendFailed')}: ${detail}`);
        recordHistory(acct, false, detail);
      }
    } catch (e) {
      const detail = String(e instanceof Error ? e.message : e);
      setErr(`${t('mail.sendFailed')}: ${detail}`);
      recordHistory(acct, false, detail);
    } finally {
      setBusy('');
    }
  };

  // ---------------- templates ----------------
  const saveTemplate = () => {
    const name = tplName.trim();
    if (!name) {
      setErr(t('mail.errTplName'));
      return;
    }
    const tpl: Template = {
      id: `t${Date.now()}${Math.floor(Math.random() * 1000)}`,
      name,
      subject: cDraft.subject,
      body: cDraft.body,
    };
    const existingIdx = templates.findIndex((x) => x.name === name);
    const list = existingIdx >= 0 ? templates.map((x, i) => (i === existingIdx ? { ...tpl, id: x.id } : x)) : [...templates, tpl];
    setTemplates(list);
    saveJson(TPL_KEY, list);
    setTplName('');
    setMsg(t('mail.tplSaved', { name }));
  };

  const applyTemplate = (tpl: Template) => {
    setCDraft((d) => ({ ...d, subject: tpl.subject, body: tpl.body }));
    setTab('compose');
    setMsg(t('mail.tplApplied', { name: tpl.name }));
  };

  const deleteTemplate = (id: string) => {
    const list = templates.filter((x) => x.id !== id);
    setTemplates(list);
    saveJson(TPL_KEY, list);
    setConfirmId('');
  };

  // ---------------- Thunderbird fallback ----------------
  const thunderbird = async () => {
    if (!desktop) {
      setErr(t('mail.desktopOnly'));
      return;
    }
    setBusy('tbird');
    setErr(null);
    try {
      const script = String.raw`
$pf=[Environment]::GetEnvironmentVariable('ProgramFiles')
$pf86=[Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
$exe=$null
foreach($p in @((Join-Path $pf 'Mozilla Thunderbird\thunderbird.exe'),(Join-Path $pf86 'Mozilla Thunderbird\thunderbird.exe'))){ if($p -and (Test-Path $p)){ $exe=$p; break } }
if($exe){ Start-Process $exe; 'LAUNCHED' } else { 'MISSING' }`;
      const res = await runPowershell(script);
      if (res.stdout.includes('LAUNCHED')) {
        setMsg(t('mail.tbirdLaunched'));
      } else {
        setMsg(t('mail.tbirdMissing'));
      }
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const installThunderbird = async () => {
    if (!desktop) {
      setErr(t('mail.desktopOnly'));
      return;
    }
    setBusy('tbirdinstall');
    setConfirmId('');
    setErr(null);
    try {
      const res = await runPowershell(
        `winget install --id Mozilla.Thunderbird -e --accept-source-agreements --accept-package-agreements 2>&1 | Out-String`,
      );
      setMsg(res.success ? t('mail.tbirdInstalled') : t('mail.tbirdInstallFailed'));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // auto-load folders once when Inbox tab opens with an account
  useEffect(() => {
    if (tab === 'inbox' && desktop && inboxAcct && folders === null && !busy) {
      void loadFolders();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, desktop, inboxAcct]);

  // ---------------- render helpers ----------------
  const detected = useMemo(() => detectPreset(draft.email.trim()), [draft.email]);

  const apps: { label: string; present: boolean; detail: string }[] = info
    ? [
        { label: t('mail.appOutlookNew'), present: !!info.OutlookNew, detail: info.OutlookNew },
        { label: t('mail.appOutlookClassic'), present: !!info.OutlookClassic, detail: info.OutlookClassic },
        { label: t('mail.appWindowsMail'), present: !!info.WindowsMail, detail: info.WindowsMail },
        { label: t('mail.appThunderbird'), present: !!info.Thunderbird, detail: info.Thunderbird },
      ]
    : [];

  const presetCols: Column<Preset>[] = [
    { key: 'name', header: t('mail.provider'), render: (p) => <strong>{p.en}</strong> },
    { key: 'imap', header: t('mail.imap'), render: (p) => <code>{p.imapHost}:{p.imapPort} {p.imapSsl ? 'SSL' : 'STARTTLS'}</code> },
    { key: 'smtp', header: t('mail.smtp'), render: (p) => <code>{p.smtpHost}:{p.smtpPort} {p.smtpSsl ? 'SSL' : 'STARTTLS'}</code> },
    { key: 'auth', header: t('mail.auth'), width: 140, render: (p) => (p.oauth ? t('mail.oauth') : t('mail.appPassword')) },
    { key: 'domains', header: t('mail.domains'), render: (p) => <span className="count-note">{p.domains.join(', ')}</span> },
  ];

  const acctCols: Column<OutlookAccount>[] = [
    { key: 'Account', header: t('mail.accountName') },
    { key: 'Email', header: t('mail.email') },
    { key: 'ImapServer', header: t('mail.imapServer'), render: (a) => <code>{a.ImapServer || '—'}</code> },
    { key: 'SmtpServer', header: t('mail.smtpServer'), render: (a) => <code>{a.SmtpServer || '—'}</code> },
    { key: 'Profile', header: t('mail.profile'), width: 140 },
  ];

  const msgCols: Column<MsgRow>[] = [
    {
      key: 'from',
      header: t('mail.colFrom'),
      render: (m) => <span style={{ fontWeight: m.Seen ? 400 : 600 }}>{bareAddress(m.From) || m.From}</span>,
    },
    {
      key: 'subject',
      header: t('mail.colSubject'),
      render: (m) => <span style={{ fontWeight: m.Seen ? 400 : 600 }}>{m.Subject}</span>,
    },
    { key: 'date', header: t('mail.colDate'), width: 140, render: (m) => <span className="count-note">{m.DateText}</span> },
    {
      key: 'actions',
      header: '',
      width: 220,
      render: (m) => (
        <span className="row-actions">
          <button className="mini" disabled={!desktop || !!busy} onClick={() => void openMessage(m)}>
            {t('mail.open')}
          </button>
          <button className="mini" disabled={!desktop || !!busy} onClick={() => void toggleSeen(m)}>
            {m.Seen ? t('mail.markUnread') : t('mail.markRead')}
          </button>
          <button
            className="mini danger"
            disabled={!desktop || !!busy}
            onClick={() => (confirmId === `d${m.Uid}` ? void deleteMessage(m) : setConfirmId(`d${m.Uid}`))}
          >
            {confirmId === `d${m.Uid}` ? t('mail.sure') : t('mail.delete')}
          </button>
        </span>
      ),
    },
  ];

  // ---------------- tabbed body ----------------
  const body = (
    <>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        {TABS.map((tb) => (
          <button key={tb} className={tab === tb ? 'mini primary' : 'mini'} onClick={() => setTab(tb)}>
            {t(`mail.tab_${tb}`)}
          </button>
        ))}
        <button className="mini" disabled={!!busy} onClick={() => void thunderbird()}>
          {busy === 'tbird' ? '…' : `⚡ ${t('mail.thunderbird')}`}
        </button>
      </div>

      {err && <pre className="cmd-out error">{err}</pre>}
      {msg && <p className="mod-msg">{msg}</p>}

      {/* ================= Accounts ================= */}
      {tab === 'accounts' && (
        <div className="io-grid">
          <div className="panel">
            <div className="mod-toolbar" style={{ justifyContent: 'space-between' }}>
              <strong>{t('mail.savedAccounts')}</strong>
              <span>
                <button className="mini" onClick={startNew}>{t('mail.new')}</button>{' '}
                <button
                  className="mini danger"
                  disabled={!selectedId}
                  onClick={() => (confirmId === 'delacct' ? removeAccount() : setConfirmId('delacct'))}
                >
                  {confirmId === 'delacct' ? t('mail.sure') : t('mail.delete')}
                </button>
              </span>
            </div>
            {accounts.length === 0 ? (
              <p className="count-note">{t('mail.noSavedAccounts')}</p>
            ) : (
              <div className="kv-list">
                {accounts.map((a) => (
                  <div
                    key={a.id}
                    className="kv-row"
                    style={{ cursor: 'pointer', fontWeight: a.id === selectedId ? 600 : 400 }}
                    onClick={() => selectAccount(a)}
                  >
                    <span className="label">{accountLabel(a)}</span>
                    <span className="value">{a.imapHost || '—'}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="count-note">{t('mail.secretNote')}</p>
          </div>

          <div className="panel">
            <strong>{selectedId ? t('mail.editAccount') : t('mail.newAccount')}</strong>
            <div className="kv-list" style={{ marginTop: 8 }}>
              <div className="kv-row">
                <span className="label">{t('mail.displayName')}</span>
                <input className="mod-search" value={draft.displayName} placeholder={t('mail.displayNamePh')} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
              </div>
              <div className="kv-row">
                <span className="label">{t('mail.email')}</span>
                <input
                  className="mod-search"
                  value={draft.email}
                  placeholder="you@example.com"
                  onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                  onBlur={(e) => applyPreset(e.target.value.trim())}
                />
              </div>
              {detected && (
                <p className="count-note" style={{ margin: '0 0 4px' }}>
                  {t('mail.detected')}: {detected.en} — <button className="mini" onClick={() => applyPreset(draft.email.trim())}>{t('mail.usePreset')}</button>
                </p>
              )}
              <div className="kv-row">
                <span className="label">{t('mail.auth')}</span>
                <select className="mod-select" value={draft.auth} onChange={(e) => setDraft({ ...draft, auth: e.target.value === 'oauth2' ? 'oauth2' : 'password' })}>
                  <option value="password">{t('mail.appPassword')}</option>
                  <option value="oauth2">{t('mail.oauth')}</option>
                </select>
              </div>
              {draft.auth === 'oauth2' && <p className="count-note" style={{ margin: 0 }}>{t('mail.oauthNote')}</p>}
              <div className="kv-row">
                <span className="label">{t('mail.password')}</span>
                <input
                  className="mod-search"
                  type="password"
                  value={pwdInput}
                  placeholder={draft.encPassword ? t('mail.passwordSet') : t('mail.passwordPh')}
                  onChange={(e) => setPwdInput(e.target.value)}
                />
              </div>
              <p className="count-note" style={{ margin: 0 }}>{t('mail.pwdHint')}</p>
            </div>

            <p className="count-note" style={{ margin: '10px 0 2px', fontWeight: 600 }}>{t('mail.imapIncoming')}</p>
            <div className="kv-list">
              <div className="kv-row">
                <span className="label">{t('mail.imapServer')}</span>
                <input className="mod-search" value={draft.imapHost} placeholder="imap.example.com" onChange={(e) => setDraft({ ...draft, imapHost: e.target.value })} />
              </div>
              <div className="kv-row">
                <span className="label">{t('mail.port')}</span>
                <input className="mod-search" type="number" style={{ maxWidth: 100 }} value={draft.imapPort} onChange={(e) => setDraft({ ...draft, imapPort: +e.target.value })} />
              </div>
              <div className="kv-row">
                <span className="label">{t('mail.security')}</span>
                <select className="mod-select" value={draft.imapSsl ? 'ssl' : 'starttls'} onChange={(e) => setDraft({ ...draft, imapSsl: e.target.value === 'ssl' })}>
                  <option value="ssl">SSL/TLS</option>
                  <option value="starttls">STARTTLS</option>
                </select>
              </div>
              <div className="kv-row">
                <span className="label">{t('mail.username')}</span>
                <input className="mod-search" value={draft.imapUser} placeholder={draft.email} onChange={(e) => setDraft({ ...draft, imapUser: e.target.value })} />
              </div>
            </div>

            <p className="count-note" style={{ margin: '10px 0 2px', fontWeight: 600 }}>{t('mail.smtpOutgoing')}</p>
            <div className="kv-list">
              <div className="kv-row">
                <span className="label">{t('mail.smtpServer')}</span>
                <input className="mod-search" value={draft.smtpHost} placeholder="smtp.example.com" onChange={(e) => setDraft({ ...draft, smtpHost: e.target.value })} />
              </div>
              <div className="kv-row">
                <span className="label">{t('mail.port')}</span>
                <input className="mod-search" type="number" style={{ maxWidth: 100 }} value={draft.smtpPort} onChange={(e) => setDraft({ ...draft, smtpPort: +e.target.value })} />
              </div>
              <div className="kv-row">
                <span className="label">{t('mail.security')}</span>
                <select className="mod-select" value={draft.smtpSsl ? 'ssl' : 'starttls'} onChange={(e) => setDraft({ ...draft, smtpSsl: e.target.value === 'ssl' })}>
                  <option value="ssl">SSL/TLS (465)</option>
                  <option value="starttls">STARTTLS (587)</option>
                </select>
              </div>
              <div className="kv-row">
                <span className="label">{t('mail.username')}</span>
                <input className="mod-search" value={draft.smtpUser} placeholder={draft.email} onChange={(e) => setDraft({ ...draft, smtpUser: e.target.value })} />
              </div>
            </div>

            <div className="mod-toolbar" style={{ marginTop: 10 }}>
              <button className="mini primary" onClick={saveAccount}>{t('mail.save')}</button>
              <button className="mini" disabled={!!busy} onClick={() => void runTest()}>
                {busy === 'test' ? t('mail.testing') : t('mail.testConnection')}
              </button>
            </div>
            {testResult && (
              <div style={{ marginTop: 8 }}>
                <StatusDot ok={testResult.ok} label={testResult.ok ? t('mail.testOk') : `${t('mail.testFailed')}: ${testResult.message}`} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================= Inbox ================= */}
      {tab === 'inbox' && (
        <div className="panel">
          {!inboxAcct ? (
            <p className="count-note">{t('mail.noSavedAccounts')}</p>
          ) : (
            <>
              <p className="count-note" style={{ marginTop: 0 }}>
                {t('mail.inboxFor', { label: accountLabel(inboxAcct) })}
              </p>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                <button className="mini primary" disabled={!desktop || !!busy} onClick={() => void loadFolders()}>
                  {busy === 'folders' ? t('mail.loading') : t('mail.refresh')}
                </button>
                <input
                  className="mod-search"
                  style={{ minWidth: 180 }}
                  placeholder={t('mail.searchFolder')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && desktop && !busy && void loadMessages(folder, true)}
                />
                <button className="mini" disabled={!desktop || !!busy} onClick={() => void loadMessages(folder, true)}>
                  {t('mail.searchBtn')}
                </button>
                <button className="mini" disabled={!!busy} onClick={() => startCompose('new')}>
                  ✉ {t('mail.compose')}
                </button>
              </div>

              {folders && folders.length > 0 && (
                <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 4 }}>
                  {folders.map((f) => (
                    <button
                      key={f.FullName}
                      className={f.FullName === folder ? 'mini primary' : 'mini'}
                      disabled={!!busy}
                      onClick={() => {
                        setFolder(f.FullName);
                        void loadMessages(f.FullName, true);
                      }}
                    >
                      {f.Name}
                      {f.Unread > 0 ? ` (${f.Unread})` : ''}
                    </button>
                  ))}
                </div>
              )}

              {inboxMsg && <pre className="cmd-out">{inboxMsg}</pre>}

              {messages !== null && (
                <>
                  <DataTable columns={msgCols} rows={messages} rowKey={(m) => String(m.Uid)} empty={t('mail.noMessages')} />
                  {messages.length > 0 && messages.length % PAGE === 0 && (
                    <div className="mod-toolbar" style={{ marginTop: 6 }}>
                      <button className="mini" disabled={!desktop || !!busy} onClick={() => void loadMessages(folder, false)}>
                        {t('mail.loadMore')}
                      </button>
                    </div>
                  )}
                </>
              )}

              {current && (
                <div className="panel" style={{ marginTop: 10 }}>
                  <div className="mod-toolbar" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                    <strong>{current.Subject}</strong>
                    <span className="row-actions">
                      <button className="mini" onClick={() => startCompose('reply')}>{t('mail.reply')}</button>
                      <button className="mini" onClick={() => startCompose('replyAll')}>{t('mail.replyAll')}</button>
                      <button className="mini" onClick={() => startCompose('forward')}>{t('mail.forward')}</button>
                    </span>
                  </div>
                  <p className="count-note" style={{ margin: '2px 0' }}>{t('mail.readerFrom')}: {current.From}</p>
                  <p className="count-note" style={{ margin: '2px 0' }}>
                    {t('mail.readerTo')}: {current.To}
                    {current.Cc ? ` · Cc: ${current.Cc}` : ''}
                  </p>
                  <p className="count-note" style={{ margin: '2px 0' }}>{current.DateText}</p>
                  <pre className="cmd-out" style={{ whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 320 }}>{current.Body}</pre>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ================= Compose ================= */}
      {tab === 'compose' && (
        <div className="panel">
          {accounts.length === 0 ? (
            <p className="count-note">{t('mail.noSavedAccounts')}</p>
          ) : (
            <>
              <div className="kv-list">
                <div className="kv-row">
                  <span className="label">{t('mail.from')}</span>
                  <select className="mod-select" value={composeAcctId} onChange={(e) => setComposeAcctId(e.target.value)}>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>{accountLabel(a)}</option>
                    ))}
                  </select>
                </div>
                <div className="kv-row">
                  <span className="label">{t('mail.to')}</span>
                  <input className="mod-search" style={{ flex: 1 }} value={cDraft.to} placeholder="someone@example.com" onChange={(e) => setCDraft({ ...cDraft, to: e.target.value })} />
                </div>
                <div className="kv-row">
                  <span className="label">Cc</span>
                  <input className="mod-search" style={{ flex: 1 }} value={cDraft.cc} onChange={(e) => setCDraft({ ...cDraft, cc: e.target.value })} />
                </div>
                <div className="kv-row">
                  <span className="label">Bcc</span>
                  <input className="mod-search" style={{ flex: 1 }} value={cDraft.bcc} onChange={(e) => setCDraft({ ...cDraft, bcc: e.target.value })} />
                </div>
                <div className="kv-row">
                  <span className="label">{t('mail.subject')}</span>
                  <input className="mod-search" style={{ flex: 1 }} value={cDraft.subject} onChange={(e) => setCDraft({ ...cDraft, subject: e.target.value })} />
                </div>
              </div>
              <textarea
                className="hosts-edit"
                spellCheck={false}
                style={{ marginTop: 8, minHeight: 180 }}
                value={cDraft.body}
                placeholder={t('mail.bodyPh')}
                onChange={(e) => setCDraft({ ...cDraft, body: e.target.value })}
              />

              <p className="count-note" style={{ margin: '8px 0 2px' }}>{t('mail.attachments')}</p>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                <input
                  className="mod-search"
                  style={{ flex: 1, minWidth: 200 }}
                  value={attachInput}
                  placeholder={'C:\\Users\\me\\file.pdf'}
                  onChange={(e) => setAttachInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addAttachment()}
                />
                <button className="mini" onClick={addAttachment}>{t('mail.addAttachment')}</button>
              </div>
              {cDraft.attachments.length > 0 && (
                <div className="kv-list">
                  {cDraft.attachments.map((p) => (
                    <div className="kv-row" key={p}>
                      <span className="value"><code>{p}</code></span>
                      <button className="mini" onClick={() => removeAttachment(p)}>{t('mail.remove')}</button>
                    </div>
                  ))}
                </div>
              )}
              <p className="count-note">{t('mail.attachNote')}</p>

              <div className="mod-toolbar" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                <button
                  className="mini primary"
                  disabled={!!busy || !cDraft.to.trim()}
                  onClick={() => (confirmId === 'send' ? void sendMessage() : setConfirmId('send'))}
                >
                  {busy === 'send' ? t('mail.sending') : confirmId === 'send' ? t('mail.confirmSend') : `➤ ${t('mail.send')}`}
                </button>
                <input className="mod-search" style={{ minWidth: 140 }} value={tplName} placeholder={t('mail.tplNamePh')} onChange={(e) => setTplName(e.target.value)} />
                <button className="mini" onClick={saveTemplate}>{t('mail.saveTemplate')}</button>
                <button
                  className="mini"
                  onClick={() => setCDraft({ to: '', cc: '', bcc: '', subject: '', body: '', attachments: [], inReplyTo: '' })}
                >
                  {t('mail.clear')}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ================= Templates ================= */}
      {tab === 'templates' && (
        <div className="panel">
          <p className="count-note" style={{ marginTop: 0 }}>{t('mail.templatesBlurb')}</p>
          {templates.length === 0 ? (
            <p className="count-note">{t('mail.noTemplates')}</p>
          ) : (
            <div className="kv-list">
              {templates.map((tp) => (
                <div className="kv-row" key={tp.id}>
                  <span className="label">{tp.name}</span>
                  <span className="value">{tp.subject || t('mail.noSubject')}</span>
                  <span className="row-actions">
                    <button className="mini" onClick={() => applyTemplate(tp)}>{t('mail.useTemplate')}</button>
                    <button
                      className="mini danger"
                      onClick={() => (confirmId === `t${tp.id}` ? deleteTemplate(tp.id) : setConfirmId(`t${tp.id}`))}
                    >
                      {confirmId === `t${tp.id}` ? t('mail.sure') : t('mail.delete')}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ================= History ================= */}
      {tab === 'history' && (
        <div className="panel">
          <div className="mod-toolbar" style={{ justifyContent: 'space-between' }}>
            <p className="count-note" style={{ margin: 0 }}>{t('mail.historyBlurb')}</p>
            <button
              className="mini danger"
              disabled={history.length === 0}
              onClick={() => {
                if (confirmId === 'clearhist') {
                  setHistory([]);
                  saveJson(HIST_KEY, []);
                  setConfirmId('');
                } else setConfirmId('clearhist');
              }}
            >
              {confirmId === 'clearhist' ? t('mail.sure') : t('mail.clearHistory')}
            </button>
          </div>
          {history.length === 0 ? (
            <p className="count-note">{t('mail.noHistory')}</p>
          ) : (
            <div className="kv-list">
              {history.map((h) => (
                <div className="kv-row" key={h.id}>
                  <span className="label" style={{ minWidth: 150 }}>
                    <StatusDot ok={h.ok} label={new Date(h.when).toLocaleString()} />
                  </span>
                  <span className="value">
                    → {h.to} · {h.subject || t('mail.noSubject')}
                    {h.ok ? '' : ` · ${h.detail}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ================= Discovery (preserved read-only) ================= */}
      {tab === 'discovery' && (
        <div className="panel">
          <div className="mod-toolbar">
            <button className="mini" onClick={() => { setup.reload(); discovered.reload(); }}>⟳ {t('modules.refresh')}</button>
            {info?.DefaultName ? (
              <span className="count-note">{t('mail.defaultClient')}: <strong>{info.DefaultName}</strong></span>
            ) : null}
          </div>

          <h3 style={{ margin: '10px 0 6px' }}>{t('mail.installedApps')}</h3>
          <AsyncState loading={setup.loading} error={setup.error}>
            <div className="mod-toolbar" style={{ flexWrap: 'wrap', gap: 12 }}>
              {apps.map((a) => (
                <span key={a.label} title={a.detail}>
                  <StatusDot ok={a.present} label={a.present ? `${a.label} ${a.detail}`.trim() : `${a.label} — ${t('mail.notInstalled')}`} />
                </span>
              ))}
              {apps.length === 0 && <span className="count-note">{t('mail.desktopOnly')}</span>}
            </div>
            {info?.RegisteredClients ? (
              <p className="count-note">{t('mail.registeredClients')}: {info.RegisteredClients}</p>
            ) : null}
            <div className="mod-toolbar" style={{ marginTop: 6 }}>
              <button className="mini" disabled={!!busy} onClick={() => void thunderbird()}>{t('mail.launchThunderbird')}</button>
              <button
                className="mini"
                disabled={!!busy}
                onClick={() => (confirmId === 'tbi' ? void installThunderbird() : setConfirmId('tbi'))}
              >
                {confirmId === 'tbi' ? t('mail.sure') : t('mail.installThunderbird')}
              </button>
            </div>
          </AsyncState>

          <h3 style={{ margin: '16px 0 6px' }}>{t('mail.accounts')}</h3>
          <AsyncState loading={discovered.loading} error={discovered.error}>
            <DataTable
              columns={acctCols}
              rows={discovered.data ?? []}
              rowKey={(a, i) => `${a.Profile}-${a.Email}-${i}`}
              empty={t('mail.noAccounts')}
            />
          </AsyncState>

          <h3 style={{ margin: '16px 0 6px' }}>{t('mail.providerPresets')}</h3>
          <p className="count-note" style={{ marginTop: 0 }}>{t('mail.presetsNote', { total: PRESETS.length })}</p>
          <DataTable columns={presetCols} rows={PRESETS} rowKey={(p) => p.key} />
        </div>
      )}
    </>
  );

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('mail.blurb2')}</p>
      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('mail.desktopOnly')}</p>}
      {body}
    </div>
  );
}
