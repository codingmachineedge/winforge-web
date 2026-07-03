import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  runCommand,
  runPowershell,
  isTauri,
  type CommandOutput,
} from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// ============================================================================
// SSH Toolset (module.ssh) — a faithful web port of WinForge's SshModule.
//
// The desktop original ran connections in-process via SSH.NET; on the web we
// drive the Windows OpenSSH client (ssh.exe / ssh-keygen.exe / scp.exe, which
// ship with Windows 11) through the native backend. Core operations preserved:
//   • saved connection profiles (host / user / port / identity key)
//   • quick remote commands (the SshOperations catalog) over `ssh user@host cmd`
//   • SSH key generation + listing under ~/.ssh (ssh-keygen)
//   • one-click passwordless deploy (append a public key to authorized_keys)
//   • SFTP-style file transfer via scp (upload / download)
// Every action is guarded and never throws.
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

const STORE_KEY = 'winforge.sshmod.profiles';
const TABS = ['profiles', 'commands', 'keys', 'transfer'] as const;
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

/** PowerShell-single-quote escape. */
const psq = (s: string) => s.replace(/'/g, "''");

function fmtOut(res: CommandOutput): string {
  const parts: string[] = [];
  if (res.stdout.trim()) parts.push(res.stdout.trimEnd());
  if (res.stderr.trim()) parts.push(res.stderr.trimEnd());
  if (!parts.length) parts.push(`(exit ${res.code})`);
  return parts.join('\n');
}

export function SshModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [tab, setTab] = useState<Tab>('profiles');
  const [profiles, setProfiles] = useState<Profile[]>(() => loadProfiles());
  const [selectedId, setSelectedId] = useState<string>('');
  const [draft, setDraft] = useState<Profile>(() => newProfile(''));

  // command runner state
  const [opFilter, setOpFilter] = useState('');
  const [customCmd, setCustomCmd] = useState('');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  // keys tab state
  const [keyType, setKeyType] = useState<'ed25519' | 'rsa'>('ed25519');
  const [keyFile, setKeyFile] = useState('');
  const [keyComment, setKeyComment] = useState('');
  const [keyList, setKeyList] = useState('');

  // transfer tab state
  const [localPath, setLocalPath] = useState('');
  const [remotePath, setRemotePath] = useState('');

  useEffect(() => {
    if (!selectedId && !draft.name) setDraft(newProfile(t('sshmod.newProfile')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const save = () => {
    if (!draft.host.trim() || !draft.user.trim()) {
      setErr(t('sshmod.errHostUser'));
      return;
    }
    setErr('');
    const clean: Profile = {
      ...draft,
      name: draft.name.trim() || t('sshmod.unnamed'),
      host: draft.host.trim(),
      user: draft.user.trim(),
      keyPath: draft.keyPath.trim(),
      port: Number.isFinite(draft.port) && draft.port > 0 ? draft.port : 22,
    };
    const exists = profiles.some((p) => p.id === clean.id);
    const list = exists ? profiles.map((p) => (p.id === clean.id ? clean : p)) : [...profiles, clean];
    persist(list);
    setSelectedId(clean.id);
    setDraft(clean);
  };

  const remove = () => {
    if (!selectedId) return;
    persist(profiles.filter((p) => p.id !== selectedId));
    startNew();
  };

  // The active connection profile — a saved one matching the draft, else the draft itself.
  const active: Profile | null = draft.host.trim() && draft.user.trim() ? draft : null;

  const runRemote = async (command: string, tag: string) => {
    if (!desktop) return;
    if (!active) {
      setErr(t('sshmod.errNoActive'));
      setTab('profiles');
      return;
    }
    setErr('');
    setBusy(tag);
    setOut(`> ssh ${active.user}@${active.host} -p ${active.port}\n$ ${command}\n`);
    try {
      const res = await runCommand('ssh', sshArgs(active, command));
      setOut(fmtOut(res));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const deploy = async () => {
    if (!desktop || !active) {
      if (!active) {
        setErr(t('sshmod.errNoActive'));
        setTab('profiles');
      }
      return;
    }
    setErr('');
    setBusy('deploy');
    setOut(t('sshmod.deploying') + '\n');
    // Read the default public key locally, then append it to the remote authorized_keys.
    try {
      const pubScript =
        `$d=Join-Path $env:USERPROFILE '.ssh'; ` +
        `$f=Get-ChildItem -Path $d -Filter '*.pub' -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
        `if($f){ Get-Content -Raw $f.FullName } else { '' }`;
      const pubRes = await runPowershell(pubScript);
      const pub = pubRes.stdout.trim();
      if (!pub) {
        setErr(t('sshmod.errNoKeys'));
        setBusy('');
        setTab('keys');
        return;
      }
      const safe = pub.replace(/'/g, "'\\''");
      const script =
        'mkdir -p ~/.ssh && chmod 700 ~/.ssh && ' +
        'touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && ' +
        `grep -qxF '${safe}' ~/.ssh/authorized_keys || echo '${safe}' >> ~/.ssh/authorized_keys`;
      const res = await runCommand('ssh', sshArgs(active, script));
      setOut(res.success ? t('sshmod.deployOk') : fmtOut(res));
      if (!res.success && !res.stderr.trim() && !res.stdout.trim()) setErr(t('sshmod.deployFail'));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const generateKey = async () => {
    if (!desktop) return;
    setErr('');
    setBusy('gen');
    setOut('');
    const type = keyType;
    const file = keyFile.trim() || (type === 'rsa' ? 'id_rsa' : 'id_ed25519');
    const comment = keyComment.trim();
    try {
      // ssh-keygen writes into ~/.ssh; -N "" for empty passphrase, -q quiet.
      const script =
        `$d=Join-Path $env:USERPROFILE '.ssh'; New-Item -ItemType Directory -Force -Path $d | Out-Null; ` +
        `$p=Join-Path $d '${psq(file)}'; ` +
        `if(Test-Path $p){ 'EXISTS' } else { ` +
        `& ssh-keygen -t ${type}${type === 'rsa' ? ' -b 4096' : ''} -f $p -N '""' ` +
        (comment ? `-C '${psq(comment)}' ` : '') +
        `-q 2>&1; if(Test-Path ($p + '.pub')){ Get-Content -Raw ($p + '.pub') } }`;
      const res = await runPowershell(script);
      const text = res.stdout.trim();
      if (text === 'EXISTS') {
        setErr(t('sshmod.errKeyExists'));
      } else {
        setOut(text ? t('sshmod.keyGenerated', { file }) + '\n\n' + text : fmtOut(res));
      }
      await listKeys();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const listKeys = async () => {
    if (!desktop) return;
    setBusy('list');
    try {
      const script =
        `$d=Join-Path $env:USERPROFILE '.ssh'; ` +
        `if(-not (Test-Path $d)){ '${psq(t('sshmod.noKeys'))}' } else { ` +
        `$k=Get-ChildItem -Path $d -Filter '*.pub' -ErrorAction SilentlyContinue; ` +
        `if(-not $k){ '${psq(t('sshmod.noKeys'))}' } else { ` +
        `$k | ForEach-Object { $_.Name + ' :: ' + ((Get-Content -Raw $_.FullName).Trim()) } } }`;
      const res = await runPowershell(script);
      setKeyList(fmtOut(res));
    } catch (e) {
      setKeyList(String(e instanceof Error ? e.message : e));
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

  const upload = async () => {
    if (!desktop || !active) {
      if (!active) {
        setErr(t('sshmod.errNoActive'));
        setTab('profiles');
      }
      return;
    }
    if (!localPath.trim()) {
      setErr(t('sshmod.errLocalPath'));
      return;
    }
    setErr('');
    setBusy('upload');
    setOut(t('sshmod.uploading') + '\n');
    const dest = `${active.user}@${active.host}:${remotePath.trim() || '.'}`;
    const args = ['-P', String(active.port > 0 ? active.port : 22)];
    if (active.auth === 'key' && active.keyPath.trim()) args.push('-i', active.keyPath.trim());
    args.push(localPath.trim(), dest);
    try {
      const res = await runCommand('scp', args);
      setOut(res.success ? t('sshmod.uploadOk') : fmtOut(res));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const download = async () => {
    if (!desktop || !active) {
      if (!active) {
        setErr(t('sshmod.errNoActive'));
        setTab('profiles');
      }
      return;
    }
    if (!remotePath.trim() || !localPath.trim()) {
      setErr(t('sshmod.errBothPaths'));
      return;
    }
    setErr('');
    setBusy('download');
    setOut(t('sshmod.downloading') + '\n');
    const src = `${active.user}@${active.host}:${remotePath.trim()}`;
    const args = ['-P', String(active.port > 0 ? active.port : 22)];
    if (active.auth === 'key' && active.keyPath.trim()) args.push('-i', active.keyPath.trim());
    args.push(src, localPath.trim());
    try {
      const res = await runCommand('scp', args);
      setOut(res.success ? t('sshmod.downloadOk') : fmtOut(res));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

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

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('sshmod.blurb')}
      </p>

      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('sshmod.desktopOnly')}</p>}

      <DependencyGate tool="ssh" query="OpenSSH client">
        {() => (
          <>
            <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
              {TABS.map((tb) => (
                <button
                  key={tb}
                  className={tab === tb ? 'mini primary' : 'mini'}
                  onClick={() => setTab(tb)}
                >
                  {t(`sshmod.tab_${tb}`)}
                </button>
              ))}
            </div>

            {err && <pre className="cmd-out error">{err}</pre>}

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
                          style={{
                            cursor: 'pointer',
                            fontWeight: p.id === selectedId ? 600 : 400,
                          }}
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
                      <input className="mod-search" type="number" style={{ maxWidth: 100 }} value={draft.port} onChange={(e) => setDraft({ ...draft, port: +e.target.value })} />
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
                        <input className="mod-search" value={draft.keyPath} placeholder="C:\\Users\\me\\.ssh\\id_ed25519" onChange={(e) => setDraft({ ...draft, keyPath: e.target.value })} />
                      </div>
                    )}
                  </div>
                  <p className="count-note">{t('sshmod.authNote')}</p>
                  <div className="mod-toolbar">
                    <button className="mini primary" onClick={save}>{t('sshmod.save')}</button>
                    <button className="mini" disabled={!desktop || !active} onClick={() => { save(); setTab('commands'); }}>{t('sshmod.connect')}</button>
                    <button className="mini" disabled={!desktop || !active || !!busy} onClick={deploy}>{busy === 'deploy' ? t('sshmod.deploying') : t('sshmod.deployBtn')}</button>
                  </div>
                </div>
              </div>
            )}

            {/* ---------------- Quick commands ---------------- */}
            {tab === 'commands' && (
              <div className="panel">
                <p className="count-note" style={{ marginTop: 0 }}>
                  {active ? t('sshmod.activeProfile', { target: `${active.user}@${active.host}:${active.port}` }) : t('sshmod.pickProfile')}
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
                  <button className="mini primary" disabled={!desktop || !customCmd.trim() || !!busy} onClick={() => runRemote(customCmd.trim(), 'custom')}>
                    {busy === 'custom' ? t('sshmod.running') : t('sshmod.run')}
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
                      <button className="mini" disabled={!desktop || !!busy} onClick={() => runRemote(op.command, op.id)}>
                        {busy === op.id ? t('sshmod.running') : t('sshmod.run')}
                      </button>
                    </div>
                  ))}
                </div>
                {out && <pre className="cmd-out">{out}</pre>}
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
                </div>
                <div className="mod-toolbar">
                  <button className="mini primary" disabled={!desktop || !!busy} onClick={generateKey}>{busy === 'gen' ? t('sshmod.generating') : t('sshmod.generate')}</button>
                  <button className="mini" disabled={!desktop || !!busy} onClick={listKeys}>{t('sshmod.refresh')}</button>
                  <button className="mini" disabled={!desktop} onClick={openSshFolder}>{t('sshmod.openFolder')}</button>
                </div>
                {out && <pre className="cmd-out">{out}</pre>}
                {keyList && (
                  <>
                    <p className="count-note">{t('sshmod.keyList')}</p>
                    <pre className="cmd-out">{keyList}</pre>
                  </>
                )}
              </div>
            )}

            {/* ---------------- Transfer (scp) ---------------- */}
            {tab === 'transfer' && (
              <div className="panel">
                <p className="count-note" style={{ marginTop: 0 }}>
                  {active ? t('sshmod.activeProfile', { target: `${active.user}@${active.host}:${active.port}` }) : t('sshmod.pickProfile')}
                </p>
                <p className="count-note">{t('sshmod.transferBlurb')}</p>
                <div className="kv-list">
                  <div className="kv-row">
                    <span className="label">{t('sshmod.localPath')}</span>
                    <input className="mod-search" style={{ flex: 1 }} value={localPath} placeholder="C:\\Users\\me\\file.txt" onChange={(e) => setLocalPath(e.target.value)} />
                  </div>
                  <div className="kv-row">
                    <span className="label">{t('sshmod.remotePath')}</span>
                    <input className="mod-search" style={{ flex: 1 }} value={remotePath} placeholder="/home/user/file.txt" onChange={(e) => setRemotePath(e.target.value)} />
                  </div>
                </div>
                <div className="mod-toolbar">
                  <button className="mini primary" disabled={!desktop || !active || !!busy} onClick={upload}>{busy === 'upload' ? t('sshmod.uploading') : t('sshmod.upload')}</button>
                  <button className="mini" disabled={!desktop || !active || !!busy} onClick={download}>{busy === 'download' ? t('sshmod.downloading') : t('sshmod.download')}</button>
                </div>
                {out && <pre className="cmd-out">{out}</pre>}
              </div>
            )}
          </>
        )}
      </DependencyGate>
    </div>
  );
}
