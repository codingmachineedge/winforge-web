import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  runCommand,
  runPowershellJson,
  isTauri,
  type CommandOutput,
} from '../tauri/bridge';
import { ModuleTabs } from './ModuleTabs';

// Windows Terminal module — full parity port of WinForge Pages/TerminalModule.
// Three sub-views mirroring the C# Pivot:
//   1. Profiles — read / add / edit / delete / duplicate / set-default profiles in
//      settings.json natively. The whole JSON DOM is loaded so unknown keys survive a
//      round-trip; Save backs the file up (.winforge-<ts>.bak) and writes atomically.
//   2. Shell runner — the non-PTY equivalent of the embedded ConPTY terminal: a shell
//      picker (pwsh / Windows PowerShell / cmd / wsl), a working-directory control, a
//      scrollback/output buffer, and command history + favourites.
//   3. Quick launch — wt.exe convenience verbs (open / new tab / split pane / here /
//      PowerShell / cmd / settings UI), matching Catalog/TerminalOperations.cs.
// Install detection surfaces a banner when Windows Terminal is missing.

// ─────────────────────────────── shared types ───────────────────────────────

interface WtProfile {
  guid: string;
  name: string;
  commandline: string;
  startingDirectory: string;
  colorScheme: string;
  fontFace: string;
  icon: string;
  hidden: boolean;
  source: string;
  isDefault: boolean;
  // The verbatim JSON object for this profile so unknown keys are preserved on save.
  raw: Record<string, unknown>;
}

interface SettingsDoc {
  path: string;
  defaultProfile: string;
  schemes: string[];
  // Parsed profile rows.
  profiles: WtProfile[];
  // The whole root object, mutated in place then re-serialised on save.
  root: Record<string, unknown>;
}

// Built-in colour schemes always available in Windows Terminal, matching
// WindowsTerminalService.BuiltInSchemes.
const BUILT_IN_SCHEMES = [
  'Campbell',
  'Campbell Powershell',
  'Vintage',
  'One Half Dark',
  'One Half Light',
  'Solarized Dark',
  'Solarized Light',
  'Tango Dark',
  'Tango Light',
];

// ─────────────────────────────── helpers ───────────────────────────────

// Split a wt argument string into argv, honouring double-quoted segments so
// -p "Windows PowerShell" stays one argument.
function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const quoted = m[1];
    const bare = m[2];
    if (quoted !== undefined) out.push(quoted);
    else if (bare !== undefined) out.push(bare);
  }
  return out;
}

function newGuid(): string {
  // Match WindowsTerminalService.NewGuid(): "{<uuid>}".
  const hex = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `{${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}}`;
}

// A stringy accessor over the parsed raw JSON that tolerates missing keys.
function rawStr(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

// PowerShell that locates the first existing Windows Terminal settings.json across the
// known candidate paths, parses it, and returns { path, defaultProfile, schemes, raw }.
// `raw` is the whole document re-serialised as compact JSON so the TS side owns the DOM
// and can round-trip unknown keys.
const LOAD_SCRIPT = String.raw`
$local = [Environment]::GetFolderPath('LocalApplicationData')
$candidates = @(
  (Join-Path $local 'Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json'),
  (Join-Path $local 'Packages\Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe\LocalState\settings.json'),
  (Join-Path $local 'Microsoft\Windows Terminal\settings.json')
)
$path = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $path) { return }
$raw = Get-Content -LiteralPath $path -Raw -ErrorAction Stop
$json = $raw | ConvertFrom-Json -ErrorAction Stop
$schemes = @()
if ($json.schemes) { $schemes = @($json.schemes | ForEach-Object { [string]$_.name }) }
[pscustomobject]@{
  path           = [string]$path
  defaultProfile = [string]$json.defaultProfile
  schemes        = $schemes
  doc            = ($json | ConvertTo-Json -Depth 30 -Compress)
}
`;

// Install detection: whether wt.exe resolves OR any settings.json exists.
const DETECT_SCRIPT = String.raw`
$local = [Environment]::GetFolderPath('LocalApplicationData')
$candidates = @(
  (Join-Path $local 'Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json'),
  (Join-Path $local 'Packages\Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe\LocalState\settings.json'),
  (Join-Path $local 'Microsoft\Windows Terminal\settings.json')
)
$settings = [bool]($candidates | Where-Object { Test-Path $_ } | Select-Object -First 1)
$alias = (Join-Path $local 'Microsoft\WindowsApps\wt.exe')
$wt = (Test-Path $alias) -or [bool](Get-Command wt.exe -ErrorAction SilentlyContinue)
[pscustomobject]@{ wt = [bool]$wt; settings = [bool]$settings }
`;

// Detect which shells are present so the runner picker only lists real ones.
const SHELLS_SCRIPT = String.raw`
$found = @()
$found += [pscustomobject]@{ id='powershell'; ok=$true }
$found += [pscustomobject]@{ id='cmd';        ok=$true }
$found += [pscustomobject]@{ id='pwsh';        ok=[bool](Get-Command pwsh.exe -ErrorAction SilentlyContinue) }
$found += [pscustomobject]@{ id='wsl';         ok=[bool](Get-Command wsl.exe  -ErrorAction SilentlyContinue) }
$found
`;

// Turn a parsed WT document object into the flat rows the editor binds to.
function parseProfiles(root: Record<string, unknown>, def: string): WtProfile[] {
  const out: WtProfile[] = [];
  const profilesNode = root['profiles'];
  let list: unknown[] = [];
  if (profilesNode && typeof profilesNode === 'object' && !Array.isArray(profilesNode)) {
    const inner = (profilesNode as Record<string, unknown>)['list'];
    if (Array.isArray(inner)) list = inner;
  } else if (Array.isArray(profilesNode)) {
    list = profilesNode; // very old schema
  }
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const guid = rawStr(raw, 'guid');
    const fontNode = raw['font'];
    const fontFace =
      fontNode && typeof fontNode === 'object' && !Array.isArray(fontNode)
        ? rawStr(fontNode as Record<string, unknown>, 'face')
        : '';
    out.push({
      guid,
      name: rawStr(raw, 'name'),
      commandline: rawStr(raw, 'commandline'),
      startingDirectory: rawStr(raw, 'startingDirectory'),
      colorScheme: rawStr(raw, 'colorScheme'),
      fontFace,
      icon: rawStr(raw, 'icon'),
      hidden: raw['hidden'] === true,
      source: rawStr(raw, 'source'),
      isDefault: !!guid && guid === def,
      raw,
    });
  }
  return out;
}

// Get (or create) the profiles.list array inside the mutable root.
function profileListArray(root: Record<string, unknown>): Record<string, unknown>[] {
  const profilesNode = root['profiles'];
  if (Array.isArray(profilesNode)) return profilesNode as Record<string, unknown>[];
  let prof = profilesNode as Record<string, unknown> | undefined;
  if (!prof || typeof prof !== 'object') {
    prof = {};
    root['profiles'] = prof;
  }
  let list = prof['list'];
  if (!Array.isArray(list)) {
    list = [];
    prof['list'] = list;
  }
  return list as Record<string, unknown>[];
}

// Apply the edited flat fields back onto a profile's raw JSON node, removing empty
// optional keys exactly like the C# WtProfile setters (SetOrRemove).
function writeFieldsToRaw(raw: Record<string, unknown>, p: WtProfile) {
  raw['guid'] = p.guid;
  raw['name'] = p.name;
  raw['hidden'] = p.hidden;
  const setOrRemove = (key: string, val: string) => {
    if (val.trim()) raw[key] = val;
    else delete raw[key];
  };
  setOrRemove('commandline', p.commandline);
  setOrRemove('startingDirectory', p.startingDirectory);
  setOrRemove('colorScheme', p.colorScheme);
  setOrRemove('icon', p.icon);
  // font.face is a nested object.
  if (p.fontFace.trim()) {
    const existing = raw['font'];
    const font =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};
    font['face'] = p.fontFace;
    raw['font'] = font;
  } else if (raw['font'] && typeof raw['font'] === 'object') {
    const font = raw['font'] as Record<string, unknown>;
    delete font['face'];
    if (Object.keys(font).length === 0) delete raw['font'];
  }
}

// ═══════════════════════════════ PROFILES TAB ═══════════════════════════════

function ProfilesTab() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [doc, setDoc] = useState<SettingsDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [selGuid, setSelGuid] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!desktop) return;
    setLoading(true);
    setErr(null);
    setMsg(null);
    setDirty(false);
    setConfirmDel(null);
    try {
      const rows = await runPowershellJson<{
        path: string;
        defaultProfile: string;
        schemes: string[] | string | null;
        doc: string;
      }>(LOAD_SCRIPT);
      const r = rows[0];
      if (!r) {
        setDoc(null);
        setMsg({ kind: 'info', text: t('terminal.noSettings') });
        return;
      }
      const root = JSON.parse(r.doc) as Record<string, unknown>;
      const def = r.defaultProfile ?? '';
      const schemes = Array.isArray(r.schemes) ? r.schemes : r.schemes ? [r.schemes] : [];
      const profiles = parseProfiles(root, def);
      setDoc({ path: r.path, defaultProfile: def, schemes, profiles, root });
      setSelGuid(profiles[0]?.guid ?? null);
      setMsg({ kind: 'info', text: t('terminal.loaded', { count: profiles.length }) });
    } catch (e) {
      setDoc(null);
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [desktop, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => doc?.profiles.find((p) => p.guid === selGuid) ?? null,
    [doc, selGuid],
  );

  // Mutate the selected profile's flat field and mark dirty. React state is replaced
  // immutably at the row level while the underlying `raw` node keeps unknown keys.
  const editField = (patch: Partial<WtProfile>) => {
    setDoc((d) => {
      if (!d) return d;
      const profiles = d.profiles.map((p) =>
        p.guid === selGuid ? { ...p, ...patch } : p,
      );
      return { ...d, profiles };
    });
    setDirty(true);
  };

  const displayPath = (path: string) => {
    // Collapse the LOCALAPPDATA prefix for a compact caption.
    const idx = path.toLowerCase().indexOf('\\packages\\');
    if (idx > 0) return '%LOCALAPPDATA%' + path.slice(idx);
    return path;
  };

  const schemeOptions = useMemo(() => {
    const set = new Set<string>(['']);
    for (const s of BUILT_IN_SCHEMES) set.add(s);
    for (const s of doc?.schemes ?? []) if (s) set.add(s);
    if (selected?.colorScheme) set.add(selected.colorScheme);
    return [...set];
  }, [doc, selected]);

  const addProfile = () => {
    setDoc((d) => {
      if (!d) return d;
      const guid = newGuid();
      const raw: Record<string, unknown> = {
        guid,
        name: t('terminal.newProfileName'),
        hidden: false,
        commandline: '%SystemRoot%\\System32\\cmd.exe',
      };
      const list = profileListArray(d.root);
      list.push(raw);
      const row: WtProfile = {
        guid,
        name: t('terminal.newProfileName'),
        commandline: '%SystemRoot%\\System32\\cmd.exe',
        startingDirectory: '',
        colorScheme: '',
        fontFace: '',
        icon: '',
        hidden: false,
        source: '',
        isDefault: false,
        raw,
      };
      let defaultProfile = d.defaultProfile;
      if (!defaultProfile) {
        defaultProfile = guid;
        d.root['defaultProfile'] = guid;
      }
      setSelGuid(guid);
      return {
        ...d,
        defaultProfile,
        profiles: [...d.profiles, row].map((p) => ({ ...p, isDefault: p.guid === defaultProfile })),
      };
    });
    setDirty(true);
    setMsg({ kind: 'info', text: t('terminal.added') });
  };

  const duplicateProfile = () => {
    if (!selected) return;
    setDoc((d) => {
      if (!d) return d;
      const guid = newGuid();
      const clone: Record<string, unknown> = JSON.parse(JSON.stringify(selected.raw));
      clone['guid'] = guid;
      const base = selected.name;
      clone['name'] = base ? `${base} (copy)` : 'Copy';
      delete clone['source']; // a copy of a generated profile becomes standalone
      const list = profileListArray(d.root);
      list.push(clone);
      const row: WtProfile = {
        ...selected,
        guid,
        name: String(clone['name']),
        source: '',
        isDefault: false,
        raw: clone,
      };
      setSelGuid(guid);
      return { ...d, profiles: [...d.profiles, row] };
    });
    setDirty(true);
    setMsg({ kind: 'info', text: t('terminal.duplicated') });
  };

  const deleteProfile = () => {
    if (!selected || !doc) return;
    if (confirmDel !== selected.guid) {
      setConfirmDel(selected.guid);
      return;
    }
    setDoc((d) => {
      if (!d) return d;
      const list = profileListArray(d.root);
      const idx = list.indexOf(selected.raw);
      if (idx >= 0) list.splice(idx, 1);
      const profiles = d.profiles.filter((p) => p.guid !== selected.guid);
      setSelGuid(profiles[0]?.guid ?? null);
      return { ...d, profiles };
    });
    setConfirmDel(null);
    setDirty(true);
    setMsg({ kind: 'info', text: t('terminal.removed') });
  };

  const setDefault = () => {
    if (!selected || !doc) return;
    doc.root['defaultProfile'] = selected.guid;
    setDoc((d) =>
      d
        ? {
            ...d,
            defaultProfile: selected.guid,
            profiles: d.profiles.map((p) => ({ ...p, isDefault: p.guid === selected.guid })),
          }
        : d,
    );
    setDirty(true);
    setMsg({ kind: 'info', text: t('terminal.defaultSet', { name: selected.name }) });
  };

  // Save: flush every edited flat field back into the raw DOM, back up the file, then
  // write atomically via a base64 round-trip so quoting/encoding never corrupts it.
  const save = async () => {
    if (!doc) return;
    setSaving(true);
    setMsg(null);
    try {
      for (const p of doc.profiles) writeFieldsToRaw(p.raw, p);
      const json = JSON.stringify(doc.root, null, 4);
      const b64 = btoa(unescape(encodeURIComponent(json)));
      const safePath = doc.path.replace(/'/g, "''");
      const script = String.raw`
$path = '${safePath}'
$json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))
$backup = ''
if (Test-Path -LiteralPath $path) {
  $backup = $path + '.winforge-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.bak'
  Copy-Item -LiteralPath $path -Destination $backup -Force -ErrorAction Stop
}
$dir = Split-Path -Parent $path
$tmp = Join-Path $dir ('.winforge-tmp-' + [Guid]::NewGuid().ToString('N') + '.json')
$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($tmp, $json, $enc)
if (Test-Path -LiteralPath $path) {
  try { [System.IO.File]::Replace($tmp, $path, $null) }
  catch { Copy-Item -LiteralPath $tmp -Destination $path -Force; Remove-Item -LiteralPath $tmp -Force }
} else {
  Move-Item -LiteralPath $tmp -Destination $path -Force
}
[pscustomobject]@{ backup = [string]$backup }
`;
      const rows = await runPowershellJson<{ backup: string }>(script);
      const backup = rows[0]?.backup ?? '';
      setDirty(false);
      const name = backup ? backup.split(/[\\/]/).pop() ?? backup : '';
      setMsg({
        kind: 'ok',
        text: name ? t('terminal.savedBackup', { file: name }) : t('terminal.savedNew'),
      });
    } catch (e) {
      setMsg({ kind: 'err', text: `${t('terminal.saveFailed')}: ${String(e instanceof Error ? e.message : e)}` });
    } finally {
      setSaving(false);
    }
  };

  const launchProfile = async () => {
    if (!selected) return;
    setBusy('launch');
    setMsg(null);
    try {
      const argv = ['nt', '-p', selected.name];
      if (selected.startingDirectory) argv.push('-d', selected.startingDirectory);
      const res = await runCommand('wt.exe', argv);
      if (!res.success && res.stderr.trim()) {
        setMsg({ kind: 'err', text: res.stderr.trim() });
      } else {
        setMsg({ kind: 'ok', text: t('terminal.launched') });
      }
    } catch (e) {
      setMsg({ kind: 'err', text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy('');
    }
  };

  if (!desktop) {
    return <p className="count-note" style={{ color: 'var(--danger)' }}>{t('terminal.desktopOnly')}</p>;
  }

  return (
    <div>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini" disabled={loading} onClick={() => void load()}>
          ⟳ {t('terminal.reload')}
        </button>
        <button className="mini" disabled={loading} onClick={addProfile}>
          {t('terminal.add')}
        </button>
        <button className="mini primary" disabled={!dirty || saving || !doc} onClick={() => void save()}>
          {saving ? t('terminal.saving') : t('terminal.save')}
        </button>
        {dirty && <span className="count-note">{t('terminal.unsaved')}</span>}
      </div>

      {doc && (
        <p className="count-note" style={{ marginTop: 0, wordBreak: 'break-all' }}>
          {displayPath(doc.path)}
        </p>
      )}
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('terminal.saveNote')}
      </p>

      {msg && (
        <p
          className="mod-msg"
          style={{ color: msg.kind === 'err' ? 'var(--danger)' : msg.kind === 'ok' ? 'var(--ok, var(--text))' : undefined }}
        >
          {msg.text}
        </p>
      )}
      {err && <pre className="cmd-out error">{err}</pre>}
      {loading && <p className="count-note">{t('terminal.loading')}</p>}

      {doc && !loading && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {/* Left: profile list */}
          <div style={{ flex: '0 0 300px', minWidth: 240 }}>
            <div className="dt-wrap" style={{ maxHeight: 460, overflow: 'auto' }}>
              <table className="dt">
                <tbody>
                  {doc.profiles.map((p) => (
                    <tr
                      key={p.guid || p.name}
                      onClick={() => {
                        setSelGuid(p.guid);
                        setConfirmDel(null);
                      }}
                      style={{
                        cursor: 'pointer',
                        background: p.guid === selGuid ? 'var(--surface-2, rgba(127,127,127,0.12))' : undefined,
                      }}
                    >
                      <td>
                        <div style={{ fontWeight: 600 }}>
                          {p.isDefault && <span title={t('terminal.flagDefault')}>★ </span>}
                          {p.name || t('terminal.unnamed')}
                        </div>
                        <div className="count-note" style={{ margin: 0 }}>
                          {[
                            p.hidden ? t('terminal.flagHidden') : '',
                            p.source || '',
                            p.commandline || '',
                          ]
                            .filter(Boolean)
                            .join('  ·  ') || '—'}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="count-note">{t('terminal.profilesNote', { count: doc.profiles.length })}</p>
          </div>

          {/* Right: editor */}
          <div style={{ flex: 1, minWidth: 280, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {!selected ? (
              <p className="count-note">{t('terminal.selectHint')}</p>
            ) : (
              <>
                {selected.source && (
                  <p className="count-note" style={{ margin: 0 }}>
                    {t('terminal.generatedNote')}
                  </p>
                )}
                <Field label={t('terminal.fName')}>
                  <input
                    className="mod-search"
                    style={{ width: '100%' }}
                    value={selected.name}
                    onChange={(e) => editField({ name: e.target.value })}
                  />
                </Field>
                <Field label={t('terminal.fCommand')}>
                  <input
                    className="mod-search"
                    style={{ width: '100%', fontFamily: 'Consolas, monospace' }}
                    value={selected.commandline}
                    onChange={(e) => editField({ commandline: e.target.value })}
                    placeholder="%SystemRoot%\System32\cmd.exe"
                  />
                </Field>
                <Field label={t('terminal.fDir')}>
                  <input
                    className="mod-search"
                    style={{ width: '100%', fontFamily: 'Consolas, monospace' }}
                    value={selected.startingDirectory}
                    onChange={(e) => editField({ startingDirectory: e.target.value })}
                    placeholder="%USERPROFILE%"
                  />
                </Field>
                <Field label={t('terminal.fIcon')}>
                  <input
                    className="mod-search"
                    style={{ width: '100%' }}
                    value={selected.icon}
                    onChange={(e) => editField({ icon: e.target.value })}
                    placeholder="🖥️"
                  />
                </Field>
                <Field label={t('terminal.fScheme')}>
                  <select
                    className="mod-select"
                    style={{ width: '100%' }}
                    value={selected.colorScheme}
                    onChange={(e) => editField({ colorScheme: e.target.value })}
                  >
                    {schemeOptions.map((s) => (
                      <option key={s} value={s}>
                        {s || t('terminal.schemeDefault')}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('terminal.fFont')}>
                  <input
                    className="mod-search"
                    style={{ width: '100%' }}
                    value={selected.fontFace}
                    onChange={(e) => editField({ fontFace: e.target.value })}
                    placeholder="Cascadia Mono"
                  />
                </Field>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={selected.hidden}
                    onChange={(e) => editField({ hidden: e.target.checked })}
                  />
                  {t('terminal.fHidden')}
                </label>

                <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 4 }}>
                  <button className="mini" disabled={selected.isDefault} onClick={setDefault}>
                    {t('terminal.setDefault')}
                  </button>
                  <button className="mini" onClick={duplicateProfile}>
                    {t('terminal.duplicate')}
                  </button>
                  <button
                    className={`mini${confirmDel === selected.guid ? ' danger' : ''}`}
                    onClick={deleteProfile}
                  >
                    {confirmDel === selected.guid ? t('terminal.confirmDelete') : t('terminal.delete')}
                  </button>
                  <button className="mini" disabled={busy === 'launch'} onClick={() => void launchProfile()}>
                    {busy === 'launch' ? t('terminal.running') : t('terminal.launch')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
      <span className="count-note" style={{ margin: 0 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

// ═══════════════════════════════ SHELL RUNNER TAB ═══════════════════════════════
// The web-capable equivalent of the C# embedded ConPTY terminal. A full interactive
// PTY is out of scope, so instead this runs one command at a time through the chosen
// backend shell, appends stdout/stderr to a scrollback buffer, and keeps a working
// directory plus command history and favourites.

interface ShellDef {
  id: string;
  ok: boolean;
}

// Map a shell id to its flat i18n key (single-segment so keys stay flat).
const SHELL_LABEL_KEY: Record<string, string> = {
  pwsh: 'shellPwsh',
  powershell: 'shellPowershell',
  cmd: 'shellCmd',
  wsl: 'shellWsl',
};

// Build argv to run a one-shot command line in the chosen shell, with an optional cwd.
function buildShellCommand(shell: string, cwd: string, cmd: string): { program: string; args: string[] } {
  const trimmedCwd = cwd.trim();
  switch (shell) {
    case 'pwsh':
      return { program: 'pwsh.exe', args: ['-NoProfile', '-NonInteractive', '-Command', cmd] };
    case 'powershell':
      return { program: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', cmd] };
    case 'wsl': {
      // Run inside the default WSL distro; cd first if a cwd is set.
      const inner = trimmedCwd ? `cd ${JSON.stringify(trimmedCwd)} 2>/dev/null; ${cmd}` : cmd;
      return { program: 'wsl.exe', args: ['--', 'bash', '-lc', inner] };
    }
    case 'cmd':
    default:
      return { program: 'cmd.exe', args: ['/c', cmd] };
  }
}

interface ScrollEntry {
  cwd: string;
  cmd: string;
  out: string;
  err: string;
  code: number;
}

function ShellTab() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [shells, setShells] = useState<ShellDef[]>([]);
  const [shell, setShell] = useState('powershell');
  const [cwd, setCwd] = useState('%USERPROFILE%');
  const [cmd, setCmd] = useState('');
  const [running, setRunning] = useState(false);
  const [scroll, setScroll] = useState<ScrollEntry[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [favorites, setFavorites] = useState<string[]>([]);
  const scrollRef = useRef<HTMLPreElement | null>(null);

  // Persist favourites and history in localStorage so they survive reloads.
  useEffect(() => {
    try {
      const f = localStorage.getItem('winforge.terminal.favorites');
      if (f) setFavorites(JSON.parse(f));
      const h = localStorage.getItem('winforge.terminal.history');
      if (h) setHistory(JSON.parse(h));
    } catch {
      /* ignore corrupt storage */
    }
  }, []);
  const persistFav = (next: string[]) => {
    setFavorites(next);
    try {
      localStorage.setItem('winforge.terminal.favorites', JSON.stringify(next.slice(0, 50)));
    } catch {
      /* ignore */
    }
  };
  const persistHist = (next: string[]) => {
    setHistory(next);
    try {
      localStorage.setItem('winforge.terminal.history', JSON.stringify(next.slice(0, 100)));
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!desktop) return;
    void runPowershellJson<ShellDef>(SHELLS_SCRIPT)
      .then((rows) => {
        const usable = rows.filter((r) => r.ok);
        setShells(usable);
        // Prefer pwsh if present (matches C# inserting it at the top), else PowerShell.
        if (usable.some((s) => s.id === 'pwsh')) setShell('pwsh');
      })
      .catch(() => setShells([{ id: 'powershell', ok: true }, { id: 'cmd', ok: true }]));
  }, [desktop]);

  useEffect(() => {
    // Auto-scroll to the newest output.
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scroll]);

  const run = async () => {
    const line = cmd.trim();
    if (!line || running) return;
    setRunning(true);
    const { program, args } = buildShellCommand(shell, cwd, line);
    // Record history (dedupe consecutive).
    persistHist([line, ...history.filter((h) => h !== line)]);
    setHistIdx(-1);
    try {
      const res: CommandOutput = await runCommand(program, args);
      setScroll((s) => [
        ...s,
        { cwd, cmd: line, out: res.stdout, err: res.stderr, code: res.code },
      ]);
    } catch (e) {
      setScroll((s) => [
        ...s,
        { cwd, cmd: line, out: '', err: String(e instanceof Error ? e.message : e), code: -1 },
      ]);
    } finally {
      setRunning(false);
      setCmd('');
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void run();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const next = Math.min(histIdx + 1, history.length - 1);
      setHistIdx(next);
      setCmd(history[next] ?? '');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx <= 0) {
        setHistIdx(-1);
        setCmd('');
      } else {
        const next = histIdx - 1;
        setHistIdx(next);
        setCmd(history[next] ?? '');
      }
    }
  };

  const addFavorite = () => {
    const line = cmd.trim();
    if (!line || favorites.includes(line)) return;
    persistFav([line, ...favorites]);
  };
  const removeFavorite = (f: string) => persistFav(favorites.filter((x) => x !== f));

  const shellOptions = shells.length > 0 ? shells : [{ id: 'powershell', ok: true }, { id: 'cmd', ok: true }];

  if (!desktop) {
    return <p className="count-note" style={{ color: 'var(--danger)' }}>{t('terminal.desktopOnly')}</p>;
  }

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('terminal.shellBlurb')}
      </p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          {t('terminal.shellLabel')}
          <select className="mod-select" value={shell} onChange={(e) => setShell(e.target.value)}>
            {shellOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {t(`terminal.${SHELL_LABEL_KEY[s.id] ?? 'shellCmd'}`)}
              </option>
            ))}
          </select>
        </label>
        <button className="mini" disabled={scroll.length === 0} onClick={() => setScroll([])}>
          {t('terminal.clear')}
        </button>
      </div>

      <Field label={t('terminal.workDir')}>
        <input
          className="mod-search"
          style={{ width: '100%', fontFamily: 'Consolas, monospace' }}
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="%USERPROFILE%"
        />
      </Field>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 220, fontFamily: 'Consolas, monospace' }}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('terminal.cmdPlaceholder')}
          spellCheck={false}
        />
        <button className="mini primary" disabled={running || !cmd.trim()} onClick={() => void run()}>
          {running ? t('terminal.running') : t('terminal.run')}
        </button>
        <button className="mini" disabled={!cmd.trim() || favorites.includes(cmd.trim())} onClick={addFavorite}>
          {t('terminal.addFavorite')}
        </button>
      </div>
      <p className="count-note" style={{ marginTop: 4 }}>
        {t('terminal.runNote')}
      </p>

      {favorites.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <span className="count-note">{t('terminal.favorites')}</span>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 4 }}>
            {favorites.map((f) => (
              <span key={f} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <button className="mini" onClick={() => setCmd(f)} title={f} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {f}
                </button>
                <button className="mini danger" onClick={() => removeFavorite(f)} title={t('terminal.removeFavorite')}>
                  ✕
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <pre
        ref={scrollRef}
        className="cmd-out"
        style={{ marginTop: 12, maxHeight: 340, overflow: 'auto', whiteSpace: 'pre-wrap' }}
      >
        {scroll.length === 0
          ? t('terminal.scrollEmpty')
          : scroll
              .map((e) => {
                const head = `${e.cwd} ${shellPrompt(shell)} ${e.cmd}`;
                const body = [e.out, e.err].filter((x) => x.trim()).join('\n');
                const tail = e.code !== 0 ? `\n[${t('terminal.exit')}: ${e.code}]` : '';
                return `${head}\n${body}${tail}`;
              })
              .join('\n\n')}
      </pre>

      {history.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="count-note" style={{ cursor: 'pointer' }}>
            {t('terminal.history', { count: history.length })}
          </summary>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 6 }}>
            {history.slice(0, 30).map((h, i) => (
              <button key={`${h}-${i}`} className="mini" onClick={() => setCmd(h)} title={h} style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {h}
              </button>
            ))}
            <button className="mini" onClick={() => persistHist([])}>
              {t('terminal.clearHistory')}
            </button>
          </div>
        </details>
      )}
    </div>
  );
}

function shellPrompt(shell: string): string {
  if (shell === 'cmd') return '>';
  if (shell === 'wsl') return '$';
  return 'PS>';
}

// ═══════════════════════════════ QUICK LAUNCH TAB ═══════════════════════════════
// wt.exe convenience verbs, matching Catalog/TerminalOperations.cs.

interface LaunchOp {
  key: string;
  args: string;
  // Flat i18n key suffixes (single-segment) so translation keys stay flat.
  labelKey: string;
  descKey: string;
}

const OPS: LaunchOp[] = [
  { key: 'launch', args: '', labelKey: 'opLaunchLabel', descKey: 'opLaunchDesc' },
  { key: 'newTab', args: 'nt', labelKey: 'opNewTabLabel', descKey: 'opNewTabDesc' },
  { key: 'splitPane', args: 'sp', labelKey: 'opSplitLabel', descKey: 'opSplitDesc' },
  { key: 'here', args: '-d %USERPROFILE%', labelKey: 'opHereLabel', descKey: 'opHereDesc' },
  { key: 'pwsh', args: 'nt -p "Windows PowerShell"', labelKey: 'opPwshLabel', descKey: 'opPwshDesc' },
  { key: 'cmd', args: 'nt -p "Command Prompt"', labelKey: 'opCmdLabel', descKey: 'opCmdDesc' },
  { key: 'settings', args: '-w 0', labelKey: 'opSettingsLabel', descKey: 'opSettingsDesc' },
];

function QuickLaunchTab() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState('');
  const [out, setOut] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const runOp = async (op: LaunchOp) => {
    setBusy(op.key);
    setErr(null);
    const argv = splitArgs(op.args);
    setOut(`> wt ${op.args}`.trim());
    try {
      const res: CommandOutput = await runCommand('wt.exe', argv);
      const text = res.stdout || res.stderr;
      if (text.trim()) setOut(text);
      if (!res.success && res.stderr.trim()) setErr(res.stderr.trim());
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  return (
    <div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('terminal.quickLaunch')}
      </p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        {OPS.map((op) => (
          <button
            key={op.key}
            className="mini"
            disabled={!!busy}
            onClick={() => void runOp(op)}
            title={t(`terminal.${op.descKey}`)}
          >
            {busy === op.key ? t('terminal.running') : t(`terminal.${op.labelKey}`)}
          </button>
        ))}
      </div>
      {err && <pre className="cmd-out error">{err}</pre>}
      {out && !err && <pre className="cmd-out">{out}</pre>}
      <p className="count-note">{t('terminal.footNote')}</p>
    </div>
  );
}

// ═══════════════════════════════ INSTALL BANNER ═══════════════════════════════

function InstallBanner() {
  const { t } = useTranslation();
  const desktop = isTauri();
  const [state, setState] = useState<{ wt: boolean; settings: boolean } | null>(null);

  useEffect(() => {
    if (!desktop) return;
    void runPowershellJson<{ wt: boolean; settings: boolean }>(DETECT_SCRIPT)
      .then((rows) => setState(rows[0] ?? { wt: false, settings: false }))
      .catch(() => setState(null));
  }, [desktop]);

  if (!desktop || !state || state.wt || state.settings) return null;
  return (
    <p
      className="count-note"
      style={{
        marginTop: 0,
        padding: '8px 12px',
        borderRadius: 6,
        background: 'rgba(240,180,40,0.12)',
        color: 'var(--warn, var(--text))',
      }}
    >
      ⚠ {t('terminal.notInstalled')}
    </p>
  );
}

// ═══════════════════════════════ MODULE ROOT ═══════════════════════════════

export function TerminalModule() {
  const { t } = useTranslation();

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('terminal.blurb')}
      </p>
      <InstallBanner />
      <ModuleTabs
        tabs={[
          { id: 'profiles', en: 'Profiles', zh: '設定檔', render: () => <ProfilesTab /> },
          { id: 'shell', en: 'Shell runner', zh: 'Shell 執行', render: () => <ShellTab /> },
          { id: 'launch', en: 'Quick launch', zh: '快捷啟動', render: () => <QuickLaunchTab /> },
        ]}
      />
    </div>
  );
}
