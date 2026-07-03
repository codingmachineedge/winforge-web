import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { Column, DataTable, ModuleToolbar } from './common';

// Native port of WinForge's in-app Registry Editor (Pages/RegistryEditor.xaml[.cs] +
// Services/RegistryHelper.cs): lazy hive/key tree, value list with REG_* formatting,
// and new/edit/delete value actions — every write sits behind an explicit confirm
// click. Reads and writes go through the Tauri backend (Windows PowerShell 5.1,
// 64-bit registry view — the same place Windows 11 actually stores settings).

interface RegVal {
  name: string;
  kind: string;
  data: string; // display text (DWORD as 0x… (dec), binary as hex bytes, …)
  edit: string; // editable text (DWORD as decimal, multi-string newline-joined, …)
}

interface KeyNode {
  name: string;
  path: string; // full path incl. hive, e.g. HKEY_CURRENT_USER\Software
  children: KeyNode[] | null; // null = not enumerated yet (lazy, like the WinUI TreeView)
  expanded: boolean;
  loading: boolean;
}

const HIVES = ['HKEY_CURRENT_USER', 'HKEY_LOCAL_MACHINE', 'HKEY_CLASSES_ROOT', 'HKEY_USERS'] as const;
// Same populated key the desktop app preloads so values are visible immediately.
const DEFAULT_KEY = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced';
// The WinUI TreeView virtualises its rows; the DOM does not — rendering every HKCR
// root subkey (~15–20k) at once would freeze the page, so cap what one node shows.
const MAX_CHILDREN = 2500;
const KINDS = ['String', 'ExpandString', 'DWord', 'QWord', 'MultiString', 'Binary'] as const;
type Kind = (typeof KINDS)[number];

const TYPE_LABEL: Record<string, string> = {
  String: 'REG_SZ',
  ExpandString: 'REG_EXPAND_SZ',
  DWord: 'REG_DWORD',
  QWord: 'REG_QWORD',
  MultiString: 'REG_MULTI_SZ',
  Binary: 'REG_BINARY',
  None: 'REG_NONE',
};
const typeLabel = (k: string): string => TYPE_LABEL[k] ?? k;

/** UTF-8 → base64 so paths/names/data survive quoting untouched inside PowerShell. */
function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
const psDecode = (s: string): string =>
  `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(s)}'))`;

// PowerShell 5.1 defaults redirected stdout to the OEM code page, which mangles
// non-ASCII key/value names before the Rust backend decodes them as UTF-8.
const PS_UTF8 = `try{[Console]::OutputEncoding=[Text.Encoding]::UTF8}catch{}; `;

/** Split "HIVE\sub\key" and open the 64-bit base key (mirrors RegistryHelper.BaseKey). */
const PS_OPEN_BASE =
  `$ix=$rp.IndexOf('\\'); if($ix -lt 0){ $hive=$rp; $sub='' } else { $hive=$rp.Substring(0,$ix); $sub=$rp.Substring($ix+1) }; ` +
  `$hv=switch($hive){ 'HKEY_CURRENT_USER' {[Microsoft.Win32.RegistryHive]::CurrentUser} 'HKEY_LOCAL_MACHINE' {[Microsoft.Win32.RegistryHive]::LocalMachine} 'HKEY_CLASSES_ROOT' {[Microsoft.Win32.RegistryHive]::ClassesRoot} 'HKEY_USERS' {[Microsoft.Win32.RegistryHive]::Users} default { throw ('Unknown hive: ' + $hive) } }; ` +
  `$bk=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hv,[Microsoft.Win32.RegistryView]::Registry64); `;

function subkeysScript(path: string): string {
  return (
    PS_UTF8 +
    `$rp=${psDecode(path)}; ` +
    `try { @((Get-Item -LiteralPath ('Registry::' + $rp) -ErrorAction Stop).GetSubKeyNames()) } catch { @() }`
  );
}

function valuesScript(path: string): string {
  return (
    PS_UTF8 +
    `$rp=${psDecode(path)}; ` +
    `try { $k=Get-Item -LiteralPath ('Registry::' + $rp) -ErrorAction Stop; ` +
    `foreach($n in $k.GetValueNames()){ ` +
    `$kind='Unknown'; try { $kind=$k.GetValueKind($n).ToString() } catch { $kind='Unknown' }; ` +
    `$d=$null; try { $d=$k.GetValue($n,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } catch { $d=$null }; ` +
    `$disp=''; $edit=''; ` +
    `if($null -ne $d){ switch($kind){ ` +
    `'DWord' { $i=[int]$d; $disp=('0x{0:X8} ({1})' -f $i,$i); $edit=[string]$i } ` +
    `'QWord' { $l=[long]$d; $disp=('0x{0:X16} ({1})' -f $l,$l); $edit=[string]$l } ` +
    `'MultiString' { $disp=(@($d) -join ' | '); $edit=(@($d) -join ([char]10)) } ` +
    `'Binary' { $h=((@($d) | ForEach-Object { $_.ToString('X2') }) -join ' '); $disp=$h; $edit=$h } ` +
    `default { $disp=[string]$d; $edit=[string]$d } } }; ` +
    `[pscustomobject]@{ name=$n; kind=$kind; data=$disp; edit=$edit } } ` +
    `} catch { [pscustomobject]@{ name='__ERROR__'; kind='ERR'; data=$_.Exception.Message; edit='' } }`
  );
}

/** Create or overwrite a value (mirrors RegistryEditor.ParseData + RegistryHelper.SetValue). */
function setScript(path: string, name: string, kind: string, text: string): string {
  const kd = kind.replace(/[^A-Za-z]/g, '') || 'String';
  return (
    PS_UTF8 +
    `$ErrorActionPreference='Stop'; try { ` +
    `$rp=${psDecode(path)}; $vn=${psDecode(name)}; $tx=${psDecode(text)}; $kd='${kd}'; ` +
    `switch($kd){ ` +
    `'DWord' { $s=$tx.Trim(); if($s -like '0x*'){ $v=[Convert]::ToInt32($s.Substring(2),16) } else { $v=[int]::Parse($s) } } ` +
    `'QWord' { $s=$tx.Trim(); if($s -like '0x*'){ $v=[Convert]::ToInt64($s.Substring(2),16) } else { $v=[long]::Parse($s) } } ` +
    `'MultiString' { $v=[string[]](($tx -replace '\\r','') -split '\\n') } ` +
    `'Binary' { $v=[byte[]]@(($tx -split '[\\s,]+') | Where-Object { $_ -ne '' } | ForEach-Object { [Convert]::ToByte($_,16) }) } ` +
    `default { $v=$tx } }; ` +
    PS_OPEN_BASE +
    `$key=if($sub -ne ''){ $bk.CreateSubKey($sub,$true) } else { $bk }; ` +
    `if($null -eq $key){ throw 'Cannot open key' }; ` +
    `$key.SetValue($vn,$v,[Microsoft.Win32.RegistryValueKind]::$kd); 'OK' ` +
    `} catch { 'ERR: ' + $_.Exception.Message }`
  );
}

function delScript(path: string, name: string): string {
  return (
    PS_UTF8 +
    `$ErrorActionPreference='Stop'; try { ` +
    `$rp=${psDecode(path)}; $vn=${psDecode(name)}; ` +
    PS_OPEN_BASE +
    `$key=if($sub -ne ''){ $bk.OpenSubKey($sub,$true) } else { $bk }; ` +
    `if($null -eq $key){ throw 'Key not found' }; ` +
    `$key.DeleteValue($vn,$false); 'OK' ` +
    `} catch { 'ERR: ' + $_.Exception.Message }`
  );
}

/** Accept HKCU:\… / HKLM\… / Computer\HKEY_…\… / forward slashes and normalise. */
function normalizePath(raw: string): string {
  let p = raw
    .trim()
    .replace(/\//g, '\\')
    .replace(/^Registry::/i, '')
    .replace(/^(Computer|電腦)\\/i, '')
    .replace(/\\{2,}/g, '\\')
    .replace(/\\+$/, '');
  const shorts: Array<[RegExp, string]> = [
    [/^HKCU:?(?=\\|$)/i, 'HKEY_CURRENT_USER'],
    [/^HKLM:?(?=\\|$)/i, 'HKEY_LOCAL_MACHINE'],
    [/^HKCR:?(?=\\|$)/i, 'HKEY_CLASSES_ROOT'],
    [/^HKU:?(?=\\|$)/i, 'HKEY_USERS'],
  ];
  for (const [re, full] of shorts) p = p.replace(re, full);
  const ix = p.indexOf('\\');
  const hive = (ix < 0 ? p : p.slice(0, ix)).toUpperCase();
  return ix < 0 ? hive : hive + p.slice(ix);
}

function updateNode(nodes: KeyNode[], path: string, up: (n: KeyNode) => KeyNode): KeyNode[] {
  return nodes.map((n) => {
    if (n.path === path) return up(n);
    if (path.startsWith(n.path + '\\') && n.children) {
      return { ...n, children: updateNode(n.children, path, up) };
    }
    return n;
  });
}

const caretStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  width: 20,
  flex: '0 0 auto',
  padding: 0,
  fontSize: 10,
  opacity: 0.7,
};
const nameStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  padding: '2px 4px',
  fontSize: 13,
  textAlign: 'left',
  borderRadius: 4,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export function RegeditModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [tree, setTree] = useState<KeyNode[]>(() =>
    HIVES.map((h) => ({ name: h, path: h, children: null, expanded: false, loading: false })),
  );
  const [selPath, setSelPath] = useState(DEFAULT_KEY);
  const [goPath, setGoPath] = useState(DEFAULT_KEY);
  const [vals, setVals] = useState<RegVal[]>([]);
  const [valsLoading, setValsLoading] = useState(false);
  const [valsErr, setValsErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<'new' | 'edit' | 'del' | null>(null);
  const [fName, setFName] = useState('');
  const [fKind, setFKind] = useState<Kind>('String');
  const [fText, setFText] = useState('');
  const [fRow, setFRow] = useState<RegVal | null>(null);
  // Monotonic token so a slow value-load for an old key can't overwrite a newer one
  // (same guard as the desktop editor's _valuesLoadToken).
  const tokenRef = useRef(0);

  const loadValues = async (path: string) => {
    const token = ++tokenRef.current;
    setValsLoading(true);
    setValsErr(null);
    let rows: RegVal[] = [];
    let err: string | null = null;
    if (desktop) {
      try {
        rows = await runPowershellJson<RegVal>(valuesScript(path));
      } catch (e) {
        err = String(e instanceof Error ? e.message : e);
      }
    }
    if (token !== tokenRef.current) return;
    const bad = rows.find((r) => r.name === '__ERROR__' && r.kind === 'ERR');
    if (bad) {
      err = `${t('regedit.badPath')} — ${bad.data}`;
      rows = [];
    }
    setVals(rows);
    setValsErr(err);
    setValsLoading(false);
  };

  useEffect(() => {
    if (desktop) void loadValues(DEFAULT_KEY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const expand = async (node: KeyNode) => {
    if (node.loading) return;
    if (node.children !== null) {
      setTree((tr) => updateNode(tr, node.path, (n) => ({ ...n, expanded: !n.expanded })));
      return;
    }
    setTree((tr) => updateNode(tr, node.path, (n) => ({ ...n, loading: true })));
    let names: string[] = [];
    if (desktop) {
      try {
        names = (await runPowershellJson<string>(subkeysScript(node.path))).filter(
          (x): x is string => typeof x === 'string',
        );
      } catch {
        names = [];
      }
    }
    names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    setTree((tr) =>
      updateNode(tr, node.path, (n) => ({
        ...n,
        loading: false,
        expanded: true,
        children: names.map((nm) => ({
          name: nm,
          path: `${n.path}\\${nm}`,
          children: null,
          expanded: false,
          loading: false,
        })),
      })),
    );
  };

  const selectKey = (node: KeyNode) => {
    setSelPath(node.path);
    setGoPath(node.path);
    setForm(null);
    setMsg(null);
    void loadValues(node.path);
    if (!node.expanded) void expand(node);
  };

  const go = () => {
    const p = normalizePath(goPath);
    if (!p) return;
    const hive = p.split('\\')[0] ?? '';
    if (!(HIVES as readonly string[]).includes(hive)) {
      setMsg({ ok: false, text: t('regedit.badHive') });
      return;
    }
    setSelPath(p);
    setGoPath(p);
    setForm(null);
    setMsg(null);
    void loadValues(p);
  };

  const runMutation = async (script: string, okText: string) => {
    // The backend hands the script to powershell.exe via -Command: stay clear of the
    // ~32K process command-line limit instead of failing with a cryptic OS error.
    if (script.length > 30000) {
      setMsg({ ok: false, text: `${t('regedit.failed')}: ${t('regedit.tooBig')}` });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await runPowershell(script);
      const out = res.stdout.trim();
      if (out !== 'OK') {
        const raw =
          (out.startsWith('ERR:') ? out.slice(4).trim() : '') ||
          res.stderr.trim() ||
          `exit ${res.code}`;
        throw new Error(raw);
      }
      setMsg({ ok: true, text: okText });
      setForm(null);
      void loadValues(selPath);
    } catch (e) {
      const raw = String(e instanceof Error ? e.message : e);
      const text = /denied|not allowed|unauthor/i.test(raw) ? t('regedit.denied') : raw;
      setMsg({ ok: false, text: `${t('regedit.failed')}: ${text}` });
    } finally {
      setBusy(false);
    }
  };

  const displayName = (r: RegVal): ReactNode =>
    r.name === '' ? <em>{t('regedit.defaultName')}</em> : r.name;

  const hintFor = (k: string): string | null =>
    k === 'DWord' || k === 'QWord'
      ? t('regedit.hintNum')
      : k === 'MultiString'
        ? t('regedit.hintMulti')
        : k === 'Binary'
          ? t('regedit.hintBin')
          : null;

  const columns: Column<RegVal>[] = [
    { key: 'name', header: t('regedit.nameCol'), width: 220, render: (r) => displayName(r) },
    {
      key: 'kind',
      header: t('regedit.type'),
      width: 130,
      render: (r) => <span className="count-note">{typeLabel(r.kind)}</span>,
    },
    {
      key: 'data',
      header: t('regedit.data'),
      render: (r) => (
        <span
          style={{
            fontFamily: 'var(--mono, monospace)',
            display: 'inline-block',
            maxWidth: 460,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            verticalAlign: 'bottom',
          }}
          title={r.data.length > 800 ? `${r.data.slice(0, 800)}…` : r.data}
        >
          {r.data === '' ? '—' : r.data}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 150,
      render: (r) => (
        <span className="row-actions">
          <button
            className="mini"
            disabled={busy || !desktop}
            onClick={() => {
              setForm('edit');
              setFRow(r);
              setFText(r.edit);
              setMsg(null);
            }}
          >
            {t('regedit.edit')}
          </button>
          <button
            className="mini"
            style={{ color: 'var(--danger)' }}
            disabled={busy || !desktop}
            onClick={() => {
              setForm('del');
              setFRow(r);
              setMsg(null);
            }}
          >
            {t('regedit.delete')}
          </button>
        </span>
      ),
    },
  ];

  const renderNode = (n: KeyNode, depth: number): ReactNode => (
    <div key={n.path}>
      <div style={{ display: 'flex', alignItems: 'center', paddingLeft: depth * 14, minWidth: 0 }}>
        <button style={caretStyle} onClick={() => void expand(n)}>
          {n.loading ? '…' : n.expanded ? '▾' : '▸'}
        </button>
        <button
          style={{
            ...nameStyle,
            ...(selPath === n.path ? { color: 'var(--accent)', fontWeight: 600 } : {}),
          }}
          title={n.path}
          onClick={() => selectKey(n)}
        >
          {n.name}
        </button>
      </div>
      {n.expanded && n.children && n.children.length === 0 && (
        <p className="count-note" style={{ margin: 0, paddingLeft: depth * 14 + 34 }}>
          {t('regedit.noSubkeys')}
        </p>
      )}
      {n.expanded && n.children?.slice(0, MAX_CHILDREN).map((c) => renderNode(c, depth + 1))}
      {n.expanded && n.children && n.children.length > MAX_CHILDREN && (
        <p className="count-note" style={{ margin: 0, paddingLeft: depth * 14 + 34 }}>
          {t('regedit.moreKeys', { shown: MAX_CHILDREN, total: n.children.length })}
        </p>
      )}
    </div>
  );

  return (
    <div className="mod">
      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>
          {t('regedit.desktopOnly')}
        </p>
      )}
      <ModuleToolbar>
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 260, fontFamily: 'var(--mono, monospace)' }}
          value={goPath}
          onChange={(e) => setGoPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && desktop && !busy) go();
          }}
          placeholder={'HKEY_CURRENT_USER\\Software\\…'}
        />
        <button className="mini primary" disabled={!desktop || busy} onClick={go}>
          {t('regedit.go')}
        </button>
        <button
          className="mini"
          disabled={!desktop || busy}
          onClick={() => {
            setForm('new');
            setFName('');
            setFKind('String');
            setFText('');
            setFRow(null);
            setMsg(null);
          }}
        >
          ＋ {t('regedit.newValue')}
        </button>
        <button className="mini" disabled={!desktop || busy} onClick={() => void loadValues(selPath)}>
          ⟳ {t('modules.refresh')}
        </button>
      </ModuleToolbar>

      <p className="count-note" style={{ fontFamily: 'var(--mono, monospace)', marginTop: 0 }}>
        {selPath} · {t('regedit.valuesFound', { n: vals.length })}
      </p>

      {msg &&
        (msg.ok ? (
          <p className="mod-msg">
            ✓ {t('regedit.done')} — {msg.text}
          </p>
        ) : (
          <pre className="cmd-out error">{msg.text}</pre>
        ))}

      {form === 'new' && (
        <div className="panel">
          <h3>{t('regedit.newValue')}</h3>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <label className="count-note">{t('regedit.valueName')}</label>
            <input
              className="mod-search"
              style={{ maxWidth: 220 }}
              value={fName}
              onChange={(e) => setFName(e.target.value)}
              placeholder="MyValue"
            />
            <label className="count-note">{t('regedit.type')}</label>
            <select
              className="mod-select"
              value={fKind}
              onChange={(e) => setFKind(e.target.value as Kind)}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {typeLabel(k)}
                </option>
              ))}
            </select>
          </div>
          <label className="count-note">{t('regedit.data')}</label>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            style={{ minHeight: 72 }}
            value={fText}
            onChange={(e) => setFText(e.target.value)}
          />
          {hintFor(fKind) && <p className="count-note">{hintFor(fKind)}</p>}
          <div className="mod-toolbar">
            <button
              className="mini primary"
              disabled={busy || !desktop}
              onClick={() => void runMutation(setScript(selPath, fName, fKind, fText), t('regedit.created'))}
            >
              {t('regedit.create')}
            </button>
            <button className="mini" disabled={busy} onClick={() => setForm(null)}>
              {t('regedit.cancel')}
            </button>
          </div>
        </div>
      )}

      {form === 'edit' && fRow && (
        <div className="panel">
          <h3>
            {t('regedit.editValue')} — {displayName(fRow)} · {typeLabel(fRow.kind)}
          </h3>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            style={{ minHeight: 72 }}
            value={fText}
            onChange={(e) => setFText(e.target.value)}
          />
          {hintFor(fRow.kind) && <p className="count-note">{hintFor(fRow.kind)}</p>}
          <div className="mod-toolbar">
            <button
              className="mini primary"
              disabled={busy || !desktop}
              onClick={() =>
                void runMutation(setScript(selPath, fRow.name, fRow.kind, fText), t('regedit.saved'))
              }
            >
              {t('regedit.save')}
            </button>
            <button className="mini" disabled={busy} onClick={() => setForm(null)}>
              {t('regedit.cancel')}
            </button>
          </div>
        </div>
      )}

      {form === 'del' && fRow && (
        <div className="panel">
          <h3>{t('regedit.deleteValue')}</h3>
          <p style={{ margin: '4px 0' }}>
            <code>{displayName(fRow)}</code> · {typeLabel(fRow.kind)} — {t('regedit.noUndo')}
          </p>
          <div className="mod-toolbar">
            <button
              className="mini"
              style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
              disabled={busy || !desktop}
              onClick={() => void runMutation(delScript(selPath, fRow.name), t('regedit.deleted'))}
            >
              {t('regedit.delete')}
            </button>
            <button className="mini" disabled={busy} onClick={() => setForm(null)}>
              {t('regedit.cancel')}
            </button>
          </div>
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(230px, 330px) minmax(0, 1fr)',
          gap: 12,
          alignItems: 'start',
        }}
      >
        <div className="panel" style={{ maxHeight: 520, overflow: 'auto' }}>
          <h3>{t('regedit.keys')}</h3>
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('regedit.pathHint')}
          </p>
          {tree.map((n) => renderNode(n, 0))}
        </div>
        <div style={{ minWidth: 0 }}>
          {valsErr && <pre className="cmd-out error">{valsErr}</pre>}
          {valsLoading ? (
            <p className="count-note">{t('modules.loading')}</p>
          ) : (
            <DataTable
              columns={columns}
              rows={vals}
              rowKey={(r) => `${r.kind}|${r.name}`}
              empty={t('regedit.emptyKey')}
            />
          )}
        </div>
      </div>

      <p className="count-note">{t('regedit.note')}</p>
    </div>
  );
}
