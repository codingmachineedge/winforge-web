import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  runCommand,
  runPowershell,
  runPowershellJson,
  isTauri,
  type CommandOutput,
} from '../tauri/bridge';
import { Column, DataTable } from './common';
import { DependencyGate } from './DependencyGate';

// ============================================================================
// SSH Toolset (module.ssh) — full-surface web port of WinForge's SshModule.
//
// The desktop original ran connections in-process via SSH.NET; on the web we
// drive the Windows OpenSSH client (ssh.exe / ssh-keygen.exe / scp.exe, which
// ship with Windows 11) through the native backend. Feature surface:
//   • saved connection profiles (host / user / port / identity key, localStorage)
//   • one-shot remote commands over `ssh -o BatchMode=yes` + the SshOperations catalog
//   • connection test ("Connect") mirroring the C# terminal connect
//   • SSH key management: generate (ed25519 / rsa-4096, optional passphrase),
//     structured ~/.ssh listing, copy public key, open the .ssh folder
//   • passwordless deploy = ssh-copy-id equivalent (pick a key when several exist)
//   • known_hosts viewer + gated per-entry removal (rewrites the file safely)
//   • ~/.ssh/config parser + raw editor with a gated, confirmed save
//   • SFTP-style remote browser (ls over ssh: navigate / mkdir / delete) plus
//     one-shot scp transfers with the transfer output surfaced
// A full interactive terminal (ConPTY) is the one C# affordance not in this wave.
// Every action is guarded and never throws; mutations only run on explicit click.
// ============================================================================

type AuthKind = 'password' | 'key';

interface Profile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: AuthKind;
  keyPath: string;
}

interface RemoteOp {
  id: string;
  titleKey: string;
  descKey: string;
  command: string;
  keywords: string;
}

interface KeyRow {
  Name: string;
  Pub: string;
  HasPriv: boolean;
}

interface KhEntry {
  idx: number; // original line index inside known_hosts
  raw: string;
  marker: string; // @cert-authority / @revoked / ''
  hosts: string;
  algo: string;
  key: string;
  hashed: boolean;
}

interface CfgHost {
  host: string;
  hostName: string;
  user: string;
  port: string;
  identity: string;
  other: number;
}

interface RemoteEntry {
  name: string;
  full: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  modified: string;
}

// The SshOperations catalog, ported 1:1 (command strings unchanged).
const OPS: RemoteOp[] = [
  { id: 'whoami', titleKey: 'sshmod.opWhoamiTitle', descKey: 'sshmod.opWhoamiDesc', command: 'echo "$(whoami)@$(hostname)"; uptime', keywords: 'whoami hostname uptime' },
  { id: 'os', titleKey: 'sshmod.opOsTitle', descKey: 'sshmod.opOsDesc', command: 'cat /etc/os-release 2>/dev/null || uname -a', keywords: 'os release uname version' },
  { id: 'uname', titleKey: 'sshmod.opUnameTitle', descKey: 'sshmod.opUnameDesc', command: 'uname -a', keywords: 'uname kernel arch' },
  { id: 'disk', titleKey: 'sshmod.opDiskTitle', descKey: 'sshmod.opDiskDesc', command: 'df -h', keywords: 'disk df space' },
  { id: 'mem', titleKey: 'sshmod.opMemTitle', descKey: 'sshmod.opMemDesc', command: 'free -h', keywords: 'memory ram swap free' },
  { id: 'top', titleKey: 'sshmod.opTopTitle', descKey: 'sshmod.opTopDesc', command: 'ps aux --sort=-%cpu | head -n 16', keywords: 'top ps cpu process' },
  { id: 'uptime', titleKey: 'sshmod.opUptimeTitle', descKey: 'sshmod.opUptimeDesc', command: 'uptime', keywords: 'uptime load' },
  { id: 'who', titleKey: 'sshmod.opWhoTitle', descKey: 'sshmod.opWhoDesc', command: 'who', keywords: 'who users login' },
  { id: 'netstat', titleKey: 'sshmod.opNetstatTitle', descKey: 'sshmod.opNetstatDesc', command: 'ss -tulpn 2>/dev/null || netstat -tulpn', keywords: 'ports listen ss netstat' },
  { id: 'ip', titleKey: 'sshmod.opIpTitle', descKey: 'sshmod.opIpDesc', command: 'ip a 2>/dev/null || ifconfig', keywords: 'ip address network interface' },
  { id: 'services', titleKey: 'sshmod.opServicesTitle', descKey: 'sshmod.opServicesDesc', command: "systemctl --failed 2>/dev/null || echo 'systemd not available'", keywords: 'systemd services failed' },
  { id: 'updates', titleKey: 'sshmod.opUpdatesTitle', descKey: 'sshmod.opUpdatesDesc', command: '(apt list --upgradable 2>/dev/null) || (dnf check-update 2>/dev/null) || (yum check-update 2>/dev/null)', keywords: 'updates apt dnf yum package' },
  { id: 'authkeys', titleKey: 'sshmod.opAuthkeysTitle', descKey: 'sshmod.opAuthkeysDesc', command: "cat ~/.ssh/authorized_keys 2>/dev/null || echo 'no authorized_keys'", keywords: 'authorized_keys ssh key' },
  { id: 'docker', titleKey: 'sshmod.opDockerTitle', descKey: 'sshmod.opDockerDesc', command: "docker ps 2>/dev/null || echo 'docker not available'", keywords: 'docker containers ps' },
  { id: 'lastlog', titleKey: 'sshmod.opLastlogTitle', descKey: 'sshmod.opLastlogDesc', command: "last -n 15 2>/dev/null || echo 'last not available'", keywords: 'last login history' },
  { id: 'gpu', titleKey: 'sshmod.opGpuTitle', descKey: 'sshmod.opGpuDesc', command: "nvidia-smi 2>/dev/null || echo 'nvidia-smi not available'", keywords: 'gpu nvidia smi' },
  { id: 'reboot', titleKey: 'sshmod.opRebootTitle', descKey: 'sshmod.opRebootDesc', command: "[ -f /var/run/reboot-required ] && cat /var/run/reboot-required || echo 'No reboot required'", keywords: 'reboot required' },
  { id: 'temp', titleKey: 'sshmod.opTempTitle', descKey: 'sshmod.opTempDesc', command: "sensors 2>/dev/null || cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo 'no sensors'", keywords: 'temperature sensors thermal' },
];

/** Connection test = the "Who am I" op, mirroring the C# Connect flow. */
const TEST_CMD = 'echo "$(whoami)@$(hostname)"; uptime';

const STORE_KEY = 'winforge.sshmod.profiles';
const TABS = ['profiles', 'commands', 'keys', 'hosts', 'config', 'sftp'] as const;
type Tab = (typeof TABS)[number];

function loadProfiles(): Profile[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is Profile => !!p && typeof p === 'object' && 'id' in p);
  } catch {
    return [];
  }
}

function saveProfiles(list: Profile[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    /* localStorage may be unavailable; ignore */
  }
}

function newProfile(name: string): Profile {
  return {
    id: `p${Date.now()}${Math.floor(Math.random() * 1000)}`,
    name,
    host: '',
    port: 22,
    user: '',
    auth: 'password',
    keyPath: '',
  };
}

/** Build the ssh.exe argument list for a profile plus a remote command. */
function sshArgs(p: Profile, command: string): string[] {
  const args: string[] = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=20',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', String(p.port > 0 ? p.port : 22),
  ];
  if (p.auth === 'key' && p.keyPath.trim()) {
    args.push('-i', p.keyPath.trim());
  }
  args.push(`${p.user}@${p.host}`, command);
  return args;
}

/** scp.exe common flags (BatchMode so a password prompt can never hang the call). */
function scpArgs(p: Profile): string[] {
  const args: string[] = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=20',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-P', String(p.port > 0 ? p.port : 22),
  ];
  if (p.auth === 'key' && p.keyPath.trim()) args.push('-i', p.keyPath.trim());
  return args;
}

/** PowerShell single-quote escape. */
const psq = (s: string) => s.replace(/'/g, "''");

/** POSIX single-quote an argument for the remote shell. */
const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** UTF-8 → base64 (safe transport of arbitrary text into PowerShell). */
function toB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
}

function fmtOut(res: CommandOutput): string {
  const parts: string[] = [];
  if (res.stdout.trim()) parts.push(res.stdout.trimEnd());
  if (res.stderr.trim()) parts.push(res.stderr.trimEnd());
  if (!parts.length) parts.push(`(exit ${res.code})`);
  return parts.join('\n');
}

function humanSize(bytes: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${bytes} B` : `${v.toFixed(1).replace(/\.0$/, '')} ${u[i]}`;
}

/** Parent of a remote POSIX path (port of SshService.ParentPath). */
function parentPath(path: string): string {
  if (!path.trim() || path === '/') return '/';
  const p = path.replace(/\/+$/, '');
  const i = p.lastIndexOf('/');
  if (i <= 0) return '/';
  return p.slice(0, i);
}

function joinRemote(dir: string, name: string): string {
  const d = dir.trim() ? dir.replace(/\/+$/, '') : '.';
  return d === '' ? `/${name}` : `${d}/${name}`;
}

function prettyKeyType(algo: string): string {
  if (algo === 'ssh-ed25519') return 'ed25519';
  if (algo === 'ssh-rsa') return 'rsa';
  if (algo.startsWith('ecdsa')) return 'ecdsa';
  return algo;
}

const LS_RE = /^([-bcdlps])[rwxstST-]{9}[.+@]?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\S+\s+\S+)\s+(.+)$/;

function parseLsLine(line: string, dir: string): RemoteEntry | null {
  const m = line.match(LS_RE);
  if (!m) return null;
  const kind = m[1] ?? '-';
  let name = m[4] ?? '';
  if (kind === 'l') {
    const j = name.indexOf(' -> ');
    if (j > 0) name = name.slice(0, j);
  }
  if (!name || name === '.' || name === '..') return null;
  return {
    name,
    full: joinRemote(dir, name),
    isDir: kind === 'd',
    isLink: kind === 'l',
    size: Number(m[2] ?? '0'),
    modified: (m[3] ?? '').replace(/\s+/g, ' '),
  };
}

function parseKnownHosts(text: string): KhEntry[] {
  const out: KhEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const s = raw.trim();
    if (!s || s.startsWith('#')) continue;
    const toks = s.split(/\s+/);
    let j = 0;
    let marker = '';
    if ((toks[0] ?? '').startsWith('@')) {
      marker = toks[0] ?? '';
      j = 1;
    }
    const hosts = toks[j] ?? '';
    out.push({
      idx: i,
      raw,
      marker,
      hosts,
      algo: toks[j + 1] ?? '',
      key: toks[j + 2] ?? '',
      hashed: hosts.startsWith('|1|'),
    });
  }
  return out;
}

function parseSshConfig(text: string): CfgHost[] {
  const out: CfgHost[] = [];
  let cur: CfgHost | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+)\s*(?:=\s*)?(.*)$/);
    if (!m) continue;
    const kw = (m[1] ?? '').toLowerCase();
    const val = (m[2] ?? '').trim();
    if (kw === 'host' || kw === 'match') {
      cur = {
        host: kw === 'match' ? `Match ${val}` : val,
        hostName: '',
        user: '',
        port: '',
        identity: '',
        other: 0,
      };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (kw === 'hostname') cur.hostName = val;
    else if (kw === 'user') cur.user = val;
    else if (kw === 'port') cur.port = val;
    else if (kw === 'identityfile') cur.identity = val;
    else cur.other++;
  }
  return out;
}

const truncMid = (s: string, max: number) =>
  s.length <= max ? s : `${s.slice(0, Math.ceil(max / 2))}…${s.slice(-Math.floor(max / 2) + 1)}`;

export function SshModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [tab, setTab] = useState<Tab>('profiles');
  const [profiles, setProfiles] = useState<Profile[]>(() => loadProfiles());
  const [selectedId, setSelectedId] = useState<string>('');
  const [draft, setDraft] = useState<Profile>(() => newProfile(''));
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState(''); // global success/info bar (the C# ProfileBar equivalent)
  const [busy, setBusy] = useState('');
  const [confirmId, setConfirmId] = useState('');

  // command runner state
  const [opFilter, setOpFilter] = useState('');
  const [customCmd, setCustomCmd] = useState('');
  const [out, setOut] = useState('');

  // keys tab state
  const [keyType, setKeyType] = useState<'ed25519' | 'rsa'>('ed25519');
  const [keyFile, setKeyFile] = useState('');
  const [keyComment, setKeyComment] = useState('');
  const [keyPass, setKeyPass] = useState('');
  const [keyRows, setKeyRows] = useState<KeyRow[] | null>(null);
  const [keysMsg, setKeysMsg] = useState('');

  // deploy key picker (shown when several public keys exist)
  const [deployKeys, setDeployKeys] = useState<KeyRow[] | null>(null);
  const [deployChoice, setDeployChoice] = useState('');

  // known_hosts tab state
  const [khList, setKhList] = useState<KhEntry[] | null>(null);
  const [khMsg, setKhMsg] = useState('');

  // config tab state
  const [cfgText, setCfgText] = useState('');
  const [cfgBase, setCfgBase] = useState<string | null>(null);
  const [cfgMsg, setCfgMsg] = useState('');

  // sftp tab state
  const [cwd, setCwd] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [entries, setEntries] = useState<RemoteEntry[] | null>(null);
  const [sftpMsg, setSftpMsg] = useState('');
  const [mkName, setMkName] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [remotePath, setRemotePath] = useState('');

  useEffect(() => {
    if (!selectedId && !draft.name) setDraft(newProfile(t('sshmod.newProfile')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Local reads auto-load the first time their tab opens (mutations never do).
  useEffect(() => {
    if (!desktop) return;
    if (tab === 'keys' && keyRows === null && !busy) void refreshKeys();
    if (tab === 'hosts' && khList === null && !busy) void refreshKnownHosts();
    if (tab === 'config' && cfgBase === null && !busy) void loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, desktop]);

  const persist = (list: Profile[]) => {
    setProfiles(list);
    saveProfiles(list);
  };

  const selectProfile = (p: Profile) => {
    setSelectedId(p.id);
    setDraft({ ...p });
    setErr('');
  };

  const startNew = () => {
    setSelectedId('');
    setDraft(newProfile(t('sshmod.newProfile')));
    setErr('');
  };

  const save = (): boolean => {
    if (!draft.host.trim() || !draft.user.trim()) {
      setErr(t('sshmod.errHostUser'));
      return false;
    }
    setErr('');
    const clean: Profile = {
      ...draft,
      name: draft.name.trim() || t('sshmod.unnamed'),
      host: draft.host.trim(),
      user: draft.user.trim(),
      keyPath: draft.keyPath.trim(),
      port: Number.isFinite(draft.port) && draft.port > 0 && draft.port <= 65535 ? draft.port : 22,
    };
    const exists = profiles.some((p) => p.id === clean.id);
    const list = exists ? profiles.map((p) => (p.id === clean.id ? clean : p)) : [...profiles, clean];
    persist(list);
    setSelectedId(clean.id);
    setDraft(clean);
    return true;
  };

  const remove = () => {
    if (!selectedId) return;
    persist(profiles.filter((p) => p.id !== selectedId));
    startNew();
  };

  // The active connection profile — a saved one matching the draft, else the draft itself.
  const active: Profile | null = draft.host.trim() && draft.user.trim() ? draft : null;

  const requireActive = (): Profile | null => {
    if (!active) {
      setErr(t('sshmod.errNoActive'));
      setTab('profiles');
      return null;
    }
    return active;
  };

  // ---------------- one-shot remote exec ----------------

  const runRemote = async (command: string, tag: string) => {
    if (!desktop) return;
    const p = requireActive();
    if (!p) return;
    setErr('');
    setMsg('');
    setBusy(tag);
    setOut(`> ssh ${p.user}@${p.host} -p ${p.port}\n$ ${command}\n`);
    try {
      const res = await runCommand('ssh', sshArgs(p, command));
      setOut(fmtOut(res));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  /** Connect = save profile, jump to Commands, run a quick connectivity check. */
  const connectNow = () => {
    if (!save()) return;
    setTab('commands');
    void runRemote(TEST_CMD, 'test');
  };

  const copyText = async (text: string, note: (m: string) => void) => {
    try {
      await navigator.clipboard.writeText(text);
      note(t('sshmod.copied'));
    } catch {
      /* clipboard may be unavailable outside secure contexts */
    }
  };

  // ---------------- keys ----------------

  const fetchKeys = async (): Promise<KeyRow[]> => {
    const script =
      `$d=Join-Path $env:USERPROFILE '.ssh'; ` +
      `if(Test-Path -LiteralPath $d){ Get-ChildItem -LiteralPath $d -Filter '*.pub' -ErrorAction SilentlyContinue | ForEach-Object { ` +
      `$t=''; try { $t=([System.IO.File]::ReadAllText($_.FullName)).Trim() } catch { }; ` +
      `$priv=$_.FullName.Substring(0,$_.FullName.Length-4); ` +
      `New-Object PSObject -Property @{ Name=$_.Name; Pub=$t; HasPriv=[bool](Test-Path -LiteralPath $priv) } } }`;
    return runPowershellJson<KeyRow>(script);
  };

  const refreshKeys = async () => {
    if (!desktop) return;
    setBusy('keylist');
    setKeysMsg('');
    try {
      setKeyRows(await fetchKeys());
    } catch (e) {
      setKeysMsg(String(e instanceof Error ? e.message : e));
      setKeyRows([]);
    } finally {
      setBusy('');
    }
  };

  const generateKey = async () => {
    if (!desktop) return;
    setErr('');
    setBusy('gen');
    const type = keyType;
    const file = (keyFile.trim() || (type === 'rsa' ? 'id_rsa' : 'id_ed25519')).replace(/[\\/]/g, '');
    const comment = keyComment.trim();
    const passArg = keyPass ? `'${psq(keyPass)}'` : `'""'`;
    const cmtArg = comment ? `'${psq(comment)}'` : `"$env:USERNAME@winforge"`;
    try {
      const script =
        `$d=Join-Path $env:USERPROFILE '.ssh'; New-Item -ItemType Directory -Force -Path $d | Out-Null; ` +
        `$p=Join-Path $d '${psq(file)}'; ` +
        `if((Test-Path -LiteralPath $p) -or (Test-Path -LiteralPath ($p+'.pub'))){ 'EXISTS' } else { ` +
        `& ssh-keygen -t ${type}${type === 'rsa' ? ' -b 4096' : ''} -f $p -N ${passArg} -C ${cmtArg} -q 2>&1 | Out-String; ` +
        `if(Test-Path -LiteralPath ($p+'.pub')){ 'PUB::' + (Get-Content -Raw ($p+'.pub')).Trim() } }`;
      const res = await runPowershell(script);
      const text = res.stdout.trim();
      if (text.includes('EXISTS')) {
        setKeysMsg(t('sshmod.errKeyExists'));
      } else if (text.includes('PUB::')) {
        const pub = text.slice(text.indexOf('PUB::') + 5).trim();
        setKeysMsg(`${t('sshmod.keyGenerated', { file })}\n\n${pub}`);
        setKeyPass('');
      } else {
        setKeysMsg(fmtOut(res));
      }
      setKeyRows(await fetchKeys());
    } catch (e) {
      setKeysMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const openSshFolder = async () => {
    if (!desktop) return;
    try {
      await runPowershell(
        `$d=Join-Path $env:USERPROFILE '.ssh'; New-Item -ItemType Directory -Force -Path $d | Out-Null; Start-Process explorer.exe $d`,
      );
    } catch {
      /* ignore */
    }
  };

  // ---------------- passwordless deploy (ssh-copy-id equivalent) ----------------

  const doDeploy = async (pubText: string) => {
    if (!desktop) return;
    const p = requireActive();
    if (!p) return;
    setDeployKeys(null);
    setErr('');
    setMsg(t('sshmod.deploying'));
    setBusy('deploy');
    try {
      const safe = pubText.trim().replace(/'/g, "'\\''");
      const script =
        'mkdir -p ~/.ssh && chmod 700 ~/.ssh && ' +
        'touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && ' +
        `grep -qxF '${safe}' ~/.ssh/authorized_keys || echo '${safe}' >> ~/.ssh/authorized_keys`;
      const res = await runCommand('ssh', sshArgs(p, script));
      if (res.success) {
        setMsg(t('sshmod.deployOk'));
      } else {
        setMsg('');
        setErr(fmtOut(res).trim() || t('sshmod.deployFail'));
      }
    } catch (e) {
      setMsg('');
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  /** Start the deploy flow: 0 keys → hint; 1 key → deploy; several → picker. */
  const startDeploy = async () => {
    if (!desktop) return;
    if (!requireActive()) return;
    setErr('');
    setBusy('deploy');
    try {
      const keys = (await fetchKeys()).filter((k) => k.Pub.trim());
      setKeyRows(keys);
      if (keys.length === 0) {
        setErr(t('sshmod.errNoKeys'));
        setTab('keys');
        return;
      }
      const first = keys[0];
      if (keys.length === 1 && first) {
        setBusy('');
        await doDeploy(first.Pub);
        return;
      }
      setDeployChoice(first ? first.Name : '');
      setDeployKeys(keys);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy((b) => (b === 'deploy' ? '' : b));
    }
  };

  // ---------------- known_hosts ----------------

  const refreshKnownHosts = async () => {
    if (!desktop) return;
    setBusy('kh');
    setKhMsg('');
    setConfirmId('');
    try {
      const script =
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ` +
        `$p=Join-Path $env:USERPROFILE '.ssh\\known_hosts'; ` +
        `if(Test-Path -LiteralPath $p){ [System.IO.File]::ReadAllText($p) }`;
      const res = await runPowershell(script);
      setKhList(parseKnownHosts(res.stdout));
    } catch (e) {
      setKhMsg(String(e instanceof Error ? e.message : e));
      setKhList([]);
    } finally {
      setBusy('');
    }
  };

  const removeKnownHost = async (entry: KhEntry) => {
    if (!desktop) return;
    setBusy('khrm');
    setKhMsg('');
    setConfirmId('');
    try {
      const b64 = toB64(entry.raw);
      const script =
        `$ErrorActionPreference='Stop'; ` +
        `$p=Join-Path $env:USERPROFILE '.ssh\\known_hosts'; ` +
        `$exp=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')); ` +
        `$lines=@([System.IO.File]::ReadAllLines($p)); ` +
        `if(${entry.idx} -ge $lines.Count -or $lines[${entry.idx}] -cne $exp){ 'MISMATCH' } else { ` +
        `$keep=New-Object System.Collections.Generic.List[string]; ` +
        `for($i=0;$i -lt $lines.Count;$i++){ if($i -ne ${entry.idx}){ $keep.Add($lines[$i]) } }; ` +
        `[System.IO.File]::WriteAllLines($p,$keep.ToArray()); 'OK' }`;
      const res = await runPowershell(script);
      const txt = res.stdout.trim();
      const done = txt.includes('OK')
        ? t('sshmod.khRemoved')
        : txt.includes('MISMATCH')
          ? t('sshmod.khMismatch')
          : fmtOut(res);
      setBusy('');
      await refreshKnownHosts();
      setKhMsg(done);
    } catch (e) {
      setKhMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // ---------------- ~/.ssh/config ----------------

  const loadConfig = async () => {
    if (!desktop) return;
    setBusy('cfg');
    setCfgMsg('');
    setConfirmId('');
    try {
      const script =
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ` +
        `$p=Join-Path $env:USERPROFILE '.ssh\\config'; ` +
        `if(Test-Path -LiteralPath $p){ [System.IO.File]::ReadAllText($p) }`;
      const res = await runPowershell(script);
      const text = res.stdout.replace(/\r?\n$/, '');
      setCfgText(text);
      setCfgBase(text);
    } catch (e) {
      setCfgMsg(String(e instanceof Error ? e.message : e));
      setCfgBase('');
    } finally {
      setBusy('');
    }
  };

  const saveConfig = async () => {
    if (!desktop) return;
    setBusy('cfgsave');
    setCfgMsg('');
    setConfirmId('');
    try {
      const b64 = toB64(cfgText.replace(/\r\n/g, '\n'));
      const script =
        `$ErrorActionPreference='Stop'; ` +
        `$d=Join-Path $env:USERPROFILE '.ssh'; New-Item -ItemType Directory -Force -Path $d | Out-Null; ` +
        `$p=Join-Path $d 'config'; ` +
        `[System.IO.File]::WriteAllBytes($p,[System.Convert]::FromBase64String('${b64}')); 'OK'`;
      const res = await runPowershell(script);
      if (res.stdout.includes('OK')) {
        setCfgBase(cfgText);
        setCfgMsg(t('sshmod.cfgSaved'));
      } else {
        setCfgMsg(fmtOut(res));
      }
    } catch (e) {
      setCfgMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const cfgHosts = useMemo(() => parseSshConfig(cfgText), [cfgText]);
  const cfgDirty = cfgBase !== null && cfgText !== cfgBase;

  // ---------------- SFTP browser + transfers ----------------

  const listRemote = async (path: string) => {
    if (!desktop) return;
    const p = requireActive();
    if (!p) return;
    const target = path.trim() || '.';
    setErr('');
    setBusy('sftp');
    setSftpMsg(t('sshmod.sftpListing'));
    setConfirmId('');
    try {
      const q = target === '.' || target === '~' ? target : shq(target);
      const res = await runCommand('ssh', sshArgs(p, `cd ${q} 2>/dev/null && pwd && LC_ALL=C ls -lA`));
      const lines = res.stdout.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
      const first = lines[0];
      if (!res.success || !first || !first.startsWith('/')) {
        setSftpMsg(fmtOut(res));
        return;
      }
      const list: RemoteEntry[] = [];
      for (const l of lines.slice(1)) {
        const e = parseLsLine(l, first);
        if (e) list.push(e);
      }
      list.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
      setCwd(first);
      setPathInput(first);
      setEntries(list);
      setSftpMsg('');
    } catch (e) {
      setSftpMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const sftpMkdir = async () => {
    if (!desktop || !cwd || !mkName.trim()) return;
    const p = requireActive();
    if (!p) return;
    setBusy('mkdir');
    setSftpMsg('');
    try {
      const res = await runCommand('ssh', sshArgs(p, `mkdir -p ${shq(joinRemote(cwd, mkName.trim()))}`));
      if (res.success) {
        setMkName('');
        setBusy('');
        await listRemote(cwd);
        setSftpMsg(t('sshmod.sftpCreated'));
      } else {
        setSftpMsg(fmtOut(res));
      }
    } catch (e) {
      setSftpMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const sftpDelete = async (entry: RemoteEntry) => {
    if (!desktop || !cwd) return;
    const p = requireActive();
    if (!p) return;
    setBusy('rm');
    setSftpMsg('');
    setConfirmId('');
    try {
      const cmd = entry.isDir ? `rmdir ${shq(entry.full)}` : `rm -f ${shq(entry.full)}`;
      const res = await runCommand('ssh', sshArgs(p, cmd));
      if (res.success) {
        setBusy('');
        await listRemote(cwd);
        setSftpMsg(t('sshmod.sftpDeleted'));
      } else {
        setSftpMsg(fmtOut(res));
      }
    } catch (e) {
      setSftpMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const upload = async () => {
    if (!desktop) return;
    const p = requireActive();
    if (!p) return;
    if (!localPath.trim()) {
      setErr(t('sshmod.errLocalPath'));
      return;
    }
    setErr('');
    setBusy('upload');
    setSftpMsg(t('sshmod.uploading'));
    const destDir = remotePath.trim() || cwd || '.';
    const args = [...scpArgs(p), localPath.trim(), `${p.user}@${p.host}:${destDir}`];
    try {
      const res = await runCommand('scp', args);
      if (res.success && cwd) {
        setBusy('');
        await listRemote(cwd);
      }
      setSftpMsg(res.success ? `${t('sshmod.uploadOk')}\n${fmtOut(res)}`.trimEnd() : fmtOut(res));
    } catch (e) {
      setSftpMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const download = async () => {
    if (!desktop) return;
    const p = requireActive();
    if (!p) return;
    if (!remotePath.trim() || !localPath.trim()) {
      setErr(t('sshmod.errBothPaths'));
      return;
    }
    setErr('');
    setBusy('download');
    setSftpMsg(t('sshmod.downloading'));
    const args = [...scpArgs(p), `${p.user}@${p.host}:${remotePath.trim()}`, localPath.trim()];
    try {
      const res = await runCommand('scp', args);
      setSftpMsg(res.success ? `${t('sshmod.downloadOk')}\n${fmtOut(res)}` : fmtOut(res));
    } catch (e) {
      setSftpMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  // ---------------- derived ----------------

  const filteredOps = OPS.filter((o) => {
    const f = opFilter.trim().toLowerCase();
    if (!f) return true;
    return (
      o.keywords.includes(f) ||
      o.command.toLowerCase().includes(f) ||
      t(o.titleKey).toLowerCase().includes(f) ||
      t(o.descKey).toLowerCase().includes(f)
    );
  });

  const targetLabel = active ? `${active.user}@${active.host}:${active.port}` : '';

  const khColumns: Column<KhEntry>[] = [
    { key: 'idx', header: '#', width: 46, render: (e) => String(e.idx + 1) },
    {
      key: 'hosts',
      header: t('sshmod.host'),
      render: (e) => (
        <span>
          {e.marker && <code style={{ marginRight: 6 }}>{e.marker}</code>}
          {e.hashed ? <em>{t('sshmod.khHashed')}</em> : truncMid(e.hosts, 46)}
        </span>
      ),
    },
    { key: 'algo', header: t('sshmod.khAlgo'), width: 140 },
    { key: 'key', header: t('sshmod.khKey'), render: (e) => <code>{truncMid(e.key, 36)}</code> },
    {
      key: 'actions',
      header: '',
      width: 110,
      render: (e) => (
        <span className="row-actions">
          <button
            className="mini"
            disabled={!desktop || !!busy}
            onClick={() =>
              confirmId === `kh${e.idx}` ? void removeKnownHost(e) : setConfirmId(`kh${e.idx}`)
            }
          >
            {confirmId === `kh${e.idx}` ? t('sshmod.sure') : t('sshmod.delete')}
          </button>
        </span>
      ),
    },
  ];

  const cfgColumns: Column<CfgHost>[] = [
    { key: 'host', header: t('sshmod.cfgHostCol'), render: (h) => <strong>{h.host}</strong> },
    { key: 'hostName', header: 'HostName' },
    { key: 'user', header: 'User', width: 110 },
    { key: 'port', header: 'Port', width: 70 },
    { key: 'identity', header: 'IdentityFile', render: (h) => <code>{h.identity}</code> },
    { key: 'other', header: t('sshmod.cfgOther'), width: 70, align: 'right', render: (h) => String(h.other) },
  ];

  const sftpColumns: Column<RemoteEntry>[] = [
    {
      key: 'name',
      header: t('sshmod.name'),
      render: (e) => (
        <span>
          {e.isDir ? '📁 ' : e.isLink ? '🔗 ' : '📄 '}
          {e.name}
        </span>
      ),
    },
    {
      key: 'size',
      header: t('sshmod.sftpSize'),
      width: 100,
      align: 'right',
      render: (e) => (e.isDir ? '—' : humanSize(e.size)),
    },
    { key: 'modified', header: t('sshmod.sftpModified'), width: 150 },
    {
      key: 'actions',
      header: '',
      width: 210,
      render: (e) => (
        <span className="row-actions">
          {e.isDir ? (
            <button className="mini" disabled={!desktop || !!busy} onClick={() => void listRemote(e.full)}>
              {t('sshmod.sftpOpen')}
            </button>
          ) : (
            <button
              className="mini"
              disabled={!!busy}
              onClick={() => {
                setRemotePath(e.full);
                setSftpMsg('');
              }}
            >
              {t('sshmod.sftpSelect')}
            </button>
          )}
          <button
            className="mini"
            disabled={!desktop || !!busy}
            onClick={() =>
              confirmId === `rm${e.full}` ? void sftpDelete(e) : setConfirmId(`rm${e.full}`)
            }
          >
            {confirmId === `rm${e.full}` ? t('sshmod.sure') : t('sshmod.delete')}
          </button>
        </span>
      ),
    },
  ];

  // ---------------- render ----------------

  const body = (
    <>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        {TABS.map((tb) => (
          <button key={tb} className={tab === tb ? 'mini primary' : 'mini'} onClick={() => setTab(tb)}>
            {t(`sshmod.tab_${tb}`)}
          </button>
        ))}
      </div>

      {err && <pre className="cmd-out error">{err}</pre>}
      {msg && <p className="mod-msg">{msg}</p>}

      {/* ---------------- Profiles ---------------- */}
      {tab === 'profiles' && (
        <div className="io-grid">
          <div className="panel">
            <div className="mod-toolbar" style={{ justifyContent: 'space-between' }}>
              <strong>{t('sshmod.savedProfiles')}</strong>
              <span>
                <button className="mini" onClick={startNew}>{t('sshmod.new')}</button>{' '}
                <button className="mini" disabled={!selectedId} onClick={remove}>{t('sshmod.delete')}</button>
              </span>
            </div>
            {profiles.length === 0 ? (
              <p className="count-note">{t('sshmod.noProfiles')}</p>
            ) : (
              <div className="kv-list">
                {profiles.map((p) => (
                  <div
                    key={p.id}
                    className="kv-row"
                    style={{ cursor: 'pointer', fontWeight: p.id === selectedId ? 600 : 400 }}
                    onClick={() => selectProfile(p)}
                  >
                    <span className="label">{p.name}</span>
                    <span className="value">{p.user}@{p.host}:{p.port}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel">
            <strong>{selectedId ? t('sshmod.editProfile') : t('sshmod.newProfileHeader')}</strong>
            <div className="kv-list" style={{ marginTop: 8 }}>
              <div className="kv-row">
                <span className="label">{t('sshmod.name')}</span>
                <input className="mod-search" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>
              <div className="kv-row">
                <span className="label">{t('sshmod.host')}</span>
                <input className="mod-search" value={draft.host} placeholder="example.com" onChange={(e) => setDraft({ ...draft, host: e.target.value })} />
              </div>
              <div className="kv-row">
                <span className="label">{t('sshmod.port')}</span>
                <input className="mod-search" type="number" min={1} max={65535} style={{ maxWidth: 100 }} value={draft.port} onChange={(e) => setDraft({ ...draft, port: +e.target.value })} />
              </div>
              <div className="kv-row">
                <span className="label">{t('sshmod.user')}</span>
                <input className="mod-search" value={draft.user} placeholder="root" onChange={(e) => setDraft({ ...draft, user: e.target.value })} />
              </div>
              <div className="kv-row">
                <span className="label">{t('sshmod.auth')}</span>
                <select className="mod-select" value={draft.auth} onChange={(e) => setDraft({ ...draft, auth: e.target.value === 'key' ? 'key' : 'password' })}>
                  <option value="password">{t('sshmod.authPassword')}</option>
                  <option value="key">{t('sshmod.authKey')}</option>
                </select>
              </div>
              {draft.auth === 'key' && (
                <div className="kv-row">
                  <span className="label">{t('sshmod.keyPath')}</span>
                  <input className="mod-search" value={draft.keyPath} placeholder={'C:\\Users\\me\\.ssh\\id_ed25519'} onChange={(e) => setDraft({ ...draft, keyPath: e.target.value })} />
                </div>
              )}
            </div>
            <p className="count-note">{t('sshmod.authNote')}</p>
            <p className="count-note">{t('sshmod.connectNote')}</p>
            <div className="mod-toolbar">
              <button className="mini primary" onClick={save}>{t('sshmod.save')}</button>
              <button className="mini" disabled={!desktop || !active || !!busy} onClick={connectNow}>{t('sshmod.connect')}</button>
              <button className="mini" disabled={!desktop || !active || !!busy} onClick={() => void startDeploy()}>
                {busy === 'deploy' ? t('sshmod.deploying') : t('sshmod.deployBtn')}
              </button>
            </div>

            {deployKeys && (
              <div className="panel" style={{ marginTop: 10 }}>
                <strong>{t('sshmod.pickDeployKey')}</strong>
                <div className="mod-toolbar" style={{ marginTop: 8 }}>
                  <select className="mod-select" value={deployChoice} onChange={(e) => setDeployChoice(e.target.value)}>
                    {deployKeys.map((k) => (
                      <option key={k.Name} value={k.Name}>
                        {k.Name} ({prettyKeyType(k.Pub.split(' ')[0] ?? '')})
                      </option>
                    ))}
                  </select>
                  <button
                    className="mini primary"
                    disabled={!!busy}
                    onClick={() => {
                      const k = deployKeys.find((x) => x.Name === deployChoice) ?? deployKeys[0];
                      if (k) void doDeploy(k.Pub);
                    }}
                  >
                    {t('sshmod.confirm')}
                  </button>
                  <button className="mini" onClick={() => setDeployKeys(null)}>{t('sshmod.cancel')}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---------------- Commands (one-shot exec) ---------------- */}
      {tab === 'commands' && (
        <div className="panel">
          <p className="count-note" style={{ marginTop: 0 }}>
            {active ? t('sshmod.activeProfile', { target: targetLabel }) : t('sshmod.pickProfile')}
          </p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <input
              className="mod-search"
              style={{ flex: 1, minWidth: 180 }}
              placeholder={t('sshmod.customCmd')}
              value={customCmd}
              onChange={(e) => setCustomCmd(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && desktop && customCmd.trim() && runRemote(customCmd.trim(), 'custom')}
            />
            <button className="mini primary" disabled={!desktop || !customCmd.trim() || !!busy} onClick={() => void runRemote(customCmd.trim(), 'custom')}>
              {busy === 'custom' ? t('sshmod.running') : t('sshmod.run')}
            </button>
            <button className="mini" disabled={!desktop || !!busy} onClick={() => void runRemote(TEST_CMD, 'test')}>
              {busy === 'test' ? t('sshmod.running') : t('sshmod.testConn')}
            </button>
          </div>
          <input
            className="mod-search"
            style={{ marginTop: 8, width: '100%' }}
            placeholder={t('sshmod.filterCmds')}
            value={opFilter}
            onChange={(e) => setOpFilter(e.target.value)}
          />
          <p className="count-note">{t('sshmod.opsHeader')}</p>
          <div className="kv-list">
            {filteredOps.map((op) => (
              <div className="kv-row" key={op.id}>
                <span className="label" style={{ minWidth: 140 }}>{t(op.titleKey)}</span>
                <span className="value" style={{ flex: 1 }}>{t(op.descKey)}</span>
                <button className="mini" disabled={!desktop || !!busy} onClick={() => void runRemote(op.command, op.id)}>
                  {busy === op.id ? t('sshmod.running') : t('sshmod.run')}
                </button>
              </div>
            ))}
          </div>
          {out && (
            <>
              <div className="mod-toolbar" style={{ marginTop: 8 }}>
                <button className="mini" onClick={() => void copyText(out, setMsg)}>
                  {t('sshmod.copyOutput')}
                </button>
              </div>
              <pre className="cmd-out">{out}</pre>
            </>
          )}
        </div>
      )}

      {/* ---------------- Keys ---------------- */}
      {tab === 'keys' && (
        <div className="panel">
          <p className="count-note" style={{ marginTop: 0 }}>{t('sshmod.keysBlurb')}</p>
          <div className="kv-list">
            <div className="kv-row">
              <span className="label">{t('sshmod.keyType')}</span>
              <select className="mod-select" value={keyType} onChange={(e) => setKeyType(e.target.value === 'rsa' ? 'rsa' : 'ed25519')}>
                <option value="ed25519">ed25519</option>
                <option value="rsa">rsa (4096)</option>
              </select>
            </div>
            <div className="kv-row">
              <span className="label">{t('sshmod.keyFile')}</span>
              <input className="mod-search" value={keyFile} placeholder={keyType === 'rsa' ? 'id_rsa' : 'id_ed25519'} onChange={(e) => setKeyFile(e.target.value)} />
            </div>
            <div className="kv-row">
              <span className="label">{t('sshmod.keyComment')}</span>
              <input className="mod-search" value={keyComment} placeholder="me@winforge" onChange={(e) => setKeyComment(e.target.value)} />
            </div>
            <div className="kv-row">
              <span className="label">{t('sshmod.keyPassphrase')}</span>
              <input className="mod-search" type="password" value={keyPass} onChange={(e) => setKeyPass(e.target.value)} />
            </div>
          </div>
          <div className="mod-toolbar">
            <button className="mini primary" disabled={!desktop || !!busy} onClick={() => void generateKey()}>
              {busy === 'gen' ? t('sshmod.generating') : t('sshmod.generate')}
            </button>
            <button className="mini" disabled={!desktop || !!busy} onClick={() => void refreshKeys()}>{t('sshmod.refresh')}</button>
            <button className="mini" disabled={!desktop} onClick={() => void openSshFolder()}>{t('sshmod.openFolder')}</button>
            {keyRows !== null && <span className="count-note">{t('sshmod.keysFound', { n: keyRows.length })}</span>}
          </div>
          {keysMsg && <pre className="cmd-out">{keysMsg}</pre>}
          <p className="count-note">{t('sshmod.keyList')}</p>
          {keyRows === null || keyRows.length === 0 ? (
            <p className="count-note">{t('sshmod.noKeys')}</p>
          ) : (
            keyRows.map((k) => {
              const bits = k.Pub.split(' ');
              const type = prettyKeyType(bits[0] ?? '');
              const comment = bits.slice(2).join(' ');
              return (
                <div className="panel" key={k.Name} style={{ marginBottom: 8 }}>
                  <strong>
                    {k.Name} · {type}
                    {comment ? ` · ${comment}` : ''}
                  </strong>
                  <p className="count-note" style={{ margin: '2px 0' }}>
                    {k.HasPriv ? t('sshmod.keyPrivOk') : t('sshmod.keyPrivMissing')}
                  </p>
                  <pre className="cmd-out" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{k.Pub}</pre>
                  <div className="mod-toolbar">
                    <button className="mini" onClick={() => void copyText(k.Pub, setKeysMsg)}>{t('sshmod.copyPub')}</button>
                    <button className="mini" disabled={!desktop || !active || !!busy} onClick={() => void doDeploy(k.Pub)}>
                      {t('sshmod.deployThis')}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ---------------- known_hosts ---------------- */}
      {tab === 'hosts' && (
        <div className="panel">
          <p className="count-note" style={{ marginTop: 0 }}>{t('sshmod.khBlurb')}</p>
          <div className="mod-toolbar">
            <button className="mini" disabled={!desktop || !!busy} onClick={() => void refreshKnownHosts()}>{t('sshmod.refresh')}</button>
            {khList !== null && <span className="count-note">{t('sshmod.khEntries', { n: khList.length })}</span>}
          </div>
          <p className="count-note">{t('sshmod.khRemoveNote')}</p>
          {khMsg && <pre className="cmd-out">{khMsg}</pre>}
          <DataTable
            columns={khColumns}
            rows={khList ?? []}
            rowKey={(e) => String(e.idx)}
            empty={t('sshmod.khEmpty')}
          />
        </div>
      )}

      {/* ---------------- ~/.ssh/config ---------------- */}
      {tab === 'config' && (
        <div className="panel">
          <p className="count-note" style={{ marginTop: 0 }}>{t('sshmod.cfgBlurb')}</p>
          <p className="count-note">{t('sshmod.cfgHosts')}</p>
          <DataTable
            columns={cfgColumns}
            rows={cfgHosts}
            rowKey={(h, i) => `${h.host}-${i}`}
            empty={t('sshmod.cfgEmpty')}
          />
          <div className="mod-toolbar" style={{ marginTop: 8 }}>
            <button className="mini" disabled={!desktop || !!busy} onClick={() => void loadConfig()}>{t('sshmod.cfgReload')}</button>
            <button
              className="mini primary"
              disabled={!desktop || !!busy || !cfgDirty}
              onClick={() => (confirmId === 'cfgsave' ? void saveConfig() : setConfirmId('cfgsave'))}
            >
              {confirmId === 'cfgsave' ? t('sshmod.sure') : t('sshmod.save')}
            </button>
            {cfgDirty && <span className="count-note">{t('sshmod.cfgDirty')}</span>}
          </div>
          {cfgMsg && <pre className="cmd-out">{cfgMsg}</pre>}
          <textarea
            className="hosts-edit"
            spellCheck={false}
            value={cfgText}
            placeholder={'Host myserver\n  HostName example.com\n  User root\n  Port 22\n  IdentityFile ~/.ssh/id_ed25519'}
            onChange={(e) => {
              setCfgText(e.target.value);
              setConfirmId('');
            }}
          />
        </div>
      )}

      {/* ---------------- SFTP (browser + scp transfers) ---------------- */}
      {tab === 'sftp' && (
        <div className="panel">
          <p className="count-note" style={{ marginTop: 0 }}>
            {active ? t('sshmod.activeProfile', { target: targetLabel }) : t('sshmod.pickProfile')}
          </p>
          <p className="count-note">{t('sshmod.sftpBlurb')}</p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <button className="mini primary" disabled={!desktop || !active || !!busy} onClick={() => void listRemote(pathInput.trim() || '.')}>
              {busy === 'sftp' ? t('sshmod.sftpListing') : t('sshmod.sftpConnect')}
            </button>
            <button className="mini" disabled={!desktop || !active || !!busy || cwd === null} onClick={() => void listRemote(parentPath(cwd ?? pathInput))}>
              ↑ {t('sshmod.sftpUp')}
            </button>
            <input
              className="mod-search"
              style={{ flex: 1, minWidth: 160 }}
              placeholder="/remote/path"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && desktop && active && !busy && void listRemote(pathInput.trim() || '.')}
            />
            <button className="mini" disabled={!desktop || !active || !!busy} onClick={() => void listRemote(pathInput.trim() || '.')}>
              {t('sshmod.sftpGo')}
            </button>
          </div>

          {entries !== null && (
            <DataTable
              columns={sftpColumns}
              rows={entries}
              rowKey={(e) => e.full}
              empty={t('sshmod.sftpEmptyDir')}
            />
          )}

          <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
            <input
              className="mod-search"
              style={{ minWidth: 140 }}
              placeholder={t('sshmod.sftpFolderName')}
              value={mkName}
              onChange={(e) => setMkName(e.target.value)}
            />
            <button
              className="mini"
              disabled={!desktop || !active || !!busy || cwd === null || !mkName.trim()}
              title={cwd === null ? t('sshmod.sftpNeedList') : undefined}
              onClick={() => void sftpMkdir()}
            >
              {busy === 'mkdir' ? t('sshmod.running') : t('sshmod.sftpMkdir')}
            </button>
          </div>

          <p className="count-note">{t('sshmod.transferBlurb')} {t('sshmod.sftpDlHint')}</p>
          <div className="kv-list">
            <div className="kv-row">
              <span className="label">{t('sshmod.localPath')}</span>
              <input className="mod-search" style={{ flex: 1 }} value={localPath} placeholder={'C:\\Users\\me\\file.txt'} onChange={(e) => setLocalPath(e.target.value)} />
            </div>
            <div className="kv-row">
              <span className="label">{t('sshmod.remotePath')}</span>
              <input className="mod-search" style={{ flex: 1 }} value={remotePath} placeholder="/home/user/file.txt" onChange={(e) => setRemotePath(e.target.value)} />
            </div>
          </div>
          <div className="mod-toolbar">
            <button className="mini primary" disabled={!desktop || !active || !!busy} onClick={() => void upload()}>
              {busy === 'upload' ? t('sshmod.uploading') : t('sshmod.upload')}
            </button>
            <button className="mini" disabled={!desktop || !active || !!busy} onClick={() => void download()}>
              {busy === 'download' ? t('sshmod.downloading') : t('sshmod.download')}
            </button>
          </div>
          {sftpMsg && <pre className="cmd-out">{sftpMsg}</pre>}
        </div>
      )}
    </>
  );

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('sshmod.blurb')}
      </p>

      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('sshmod.desktopOnly')}</p>}

      {desktop ? (
        <DependencyGate tool="ssh" query="OpenSSH client">
          {() => body}
        </DependencyGate>
      ) : (
        body
      )}
    </div>
  );
}
