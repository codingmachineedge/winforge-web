import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';

/**
 * .NET Decompiler / assembly explorer — a native port of WinForge's ILSpy-style
 * DecompilerModule. It opens a managed .dll/.exe and browses it: assembly metadata,
 * referenced assemblies, resources, and the namespace -> type -> member tree with real
 * member signatures, all read read-only through .NET reflection in PowerShell.
 * No external tool is launched; pure managed reflection (AssemblyName + ReflectionOnlyLoad).
 */

type TypeKind = 'Namespace' | 'Class' | 'Struct' | 'Interface' | 'Enum' | 'Delegate';
type MemberKind = 'Method' | 'Property' | 'Field' | 'Event';

interface TypeRow {
  Namespace: string;
  Name: string;
  FullName: string;
  Kind: TypeKind;
}

interface AssemblyMeta {
  Name: string;
  Version: string;
  Pkt: string;
  Arch: string;
  FullName: string;
  IsExe: boolean;
  TypeCount: number;
  Refs: string[];
  Res: string[];
  Types: TypeRow[];
}

interface MemberRow {
  Kind: MemberKind;
  Sig: string;
  Vis: string;
  Static: boolean;
}

// Quick-pick roots so the module is useful without a native file dialog.
const PRESETS: { key: string; path: string }[] = [
  { key: 'presetFwXml', path: '$env:WINDIR\\Microsoft.NET\\Framework64\\v4.0.30319\\System.Xml.dll' },
  { key: 'presetFwData', path: '$env:WINDIR\\Microsoft.NET\\Framework64\\v4.0.30319\\System.Data.dll' },
  { key: 'presetFwCore', path: '$env:WINDIR\\Microsoft.NET\\Framework64\\v4.0.30319\\System.dll' },
];

const KIND_GLYPH: Record<TypeKind | MemberKind, string> = {
  Namespace: '📁',
  Class: 'C',
  Struct: 'S',
  Interface: 'I',
  Enum: 'E',
  Delegate: 'D',
  Method: 'M',
  Property: 'P',
  Field: 'F',
  Event: 'V',
};

// Escape a JS string for embedding inside a single-quoted PowerShell literal.
function psQuote(s: string): string {
  return s.replace(/'/g, "''");
}

// One PowerShell payload that reads metadata + refs + resources + the full type list.
function loadScript(path: string): string {
  return `
$ErrorActionPreference='Stop'
$p = '${psQuote(path)}'
$p = $ExecutionContext.InvokeCommand.ExpandString($p)
if(-not (Test-Path -LiteralPath $p)){ throw "File not found: $p" }
$onResolve = [System.ResolveEventHandler]{
  param($s,$e)
  try { return [System.Reflection.Assembly]::ReflectionOnlyLoad($e.Name) } catch {
    try { return [System.Reflection.Assembly]::ReflectionOnlyLoadFrom((Join-Path (Split-Path $p) (($e.Name -split ',')[0].Trim() + '.dll'))) } catch { return $null }
  }
}
[System.AppDomain]::CurrentDomain.add_ReflectionOnlyAssemblyResolve($onResolve)
$an = [System.Reflection.AssemblyName]::GetAssemblyName($p)
$pkt = $an.GetPublicKeyToken()
$pktStr = if($pkt -and $pkt.Length){ ([BitConverter]::ToString($pkt) -replace '-','').ToLower() } else { '(none)' }
$asm = [System.Reflection.Assembly]::ReflectionOnlyLoadFrom($p)
try { $types = $asm.GetTypes() } catch [System.Reflection.ReflectionTypeLoadException] { $types = $_.Exception.Types | Where-Object { $_ } }
$refs = @($asm.GetReferencedAssemblies() | ForEach-Object { "$($_.Name), $($_.Version)" } | Sort-Object)
$res = @($asm.GetManifestResourceNames() | Sort-Object)
$typeList = foreach($t in $types){
  if($t.IsNested){ continue }
  $kind = if($t.IsInterface){'Interface'}elseif($t.IsEnum){'Enum'}elseif([System.Delegate].IsAssignableFrom($t)){'Delegate'}elseif($t.IsValueType){'Struct'}else{'Class'}
  [pscustomobject]@{ Namespace = $(if([string]::IsNullOrEmpty($t.Namespace)){'(global)'}else{$t.Namespace}); Name=$t.Name; FullName=$t.FullName; Kind=$kind }
}
$typeList = @($typeList | Sort-Object Namespace, Name)
$obj = [pscustomobject]@{
  Name=$an.Name; Version=$an.Version.ToString(); Pkt=$pktStr; Arch=$an.ProcessorArchitecture.ToString()
  FullName=$asm.FullName; IsExe=($p -like '*.exe'); TypeCount=$typeList.Count
  Refs=$refs; Res=$res; Types=$typeList
}
$obj | ConvertTo-Json -Depth 5 -Compress`;
}

// Enumerate a selected type's members with real signatures (mirrors the C# MemberLabel).
function membersScript(path: string, typeFullName: string): string {
  return `
$p = '${psQuote(path)}'
$p = $ExecutionContext.InvokeCommand.ExpandString($p)
$onResolve = [System.ResolveEventHandler]{
  param($s,$e)
  try { return [System.Reflection.Assembly]::ReflectionOnlyLoad($e.Name) } catch {
    try { return [System.Reflection.Assembly]::ReflectionOnlyLoadFrom((Join-Path (Split-Path $p) (($e.Name -split ',')[0].Trim() + '.dll'))) } catch { return $null }
  }
}
[System.AppDomain]::CurrentDomain.add_ReflectionOnlyAssemblyResolve($onResolve)
$asm = [System.Reflection.Assembly]::ReflectionOnlyLoadFrom($p)
$t = $asm.GetType('${psQuote(typeFullName)}', $false)
if(-not $t){ return }
$bf = [System.Reflection.BindingFlags]"Public,NonPublic,Instance,Static,DeclaredOnly"
foreach($m in $t.GetMethods($bf)){
  if($m.IsSpecialName){ continue }
  $ps = ($m.GetParameters() | ForEach-Object { $_.ParameterType.Name }) -join ', '
  $vis = if($m.IsPublic){'public'}elseif($m.IsFamily){'protected'}elseif($m.IsAssembly){'internal'}else{'private'}
  [pscustomobject]@{ Kind='Method'; Sig="$($m.Name)($ps) : $($m.ReturnType.Name)"; Vis=$vis; Static=$m.IsStatic }
}
foreach($pr in $t.GetProperties($bf)){ [pscustomobject]@{ Kind='Property'; Sig="$($pr.Name) : $($pr.PropertyType.Name)"; Vis='public'; Static=$false } }
foreach($f in $t.GetFields($bf)){
  $vis = if($f.IsPublic){'public'}elseif($f.IsFamily){'protected'}elseif($f.IsAssembly){'internal'}else{'private'}
  [pscustomobject]@{ Kind='Field'; Sig="$($f.Name) : $($f.FieldType.Name)"; Vis=$vis; Static=$f.IsStatic }
}
foreach($e in $t.GetEvents($bf)){ [pscustomobject]@{ Kind='Event'; Sig="$($e.Name) : $($($e.EventHandlerType).Name)"; Vis='public'; Static=$false } }`;
}

export function DecompilerModule() {
  const { t } = useTranslation();
  const [pathInput, setPathInput] = useState(PRESETS[0]?.path ?? '');
  const [meta, setMeta] = useState<AssemblyMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const [selected, setSelected] = useState<TypeRow | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [memBusy, setMemBusy] = useState(false);
  const [memErr, setMemErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async (path: string) => {
    const p = path.trim();
    if (!p) return;
    setLoading(true);
    setErr(null);
    setMeta(null);
    setSelected(null);
    setMembers([]);
    setMemErr(null);
    try {
      const res = await runPowershell(loadScript(p));
      const text = res.stdout.trim();
      if (!text) throw new Error(res.stderr.trim() || t('decompiler.notManaged'));
      const parsed = JSON.parse(text) as AssemblyMeta;
      // ConvertTo-Json emits a single object; normalise possibly-scalar arrays.
      parsed.Refs = Array.isArray(parsed.Refs) ? parsed.Refs : parsed.Refs ? [parsed.Refs] : [];
      parsed.Res = Array.isArray(parsed.Res) ? parsed.Res : parsed.Res ? [parsed.Res] : [];
      parsed.Types = Array.isArray(parsed.Types) ? parsed.Types : parsed.Types ? [parsed.Types] : [];
      setMeta(parsed);
    } catch (e) {
      setErr(`${t('decompiler.loadFailed')}: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setLoading(false);
    }
  };

  const selectType = async (row: TypeRow) => {
    setSelected(row);
    setMembers([]);
    setMemErr(null);
    setCopied(false);
    setMemBusy(true);
    try {
      const rows = await runPowershellJson<MemberRow>(membersScript(pathInput.trim(), row.FullName));
      setMembers(rows);
    } catch (e) {
      setMemErr(String(e instanceof Error ? e.message : e));
    } finally {
      setMemBusy(false);
    }
  };

  // namespace -> types, filtered
  const namespaces = useMemo(() => {
    const all = meta?.Types ?? [];
    const q = filter.trim().toLowerCase();
    const list = q
      ? all.filter((x) => x.FullName.toLowerCase().includes(q) || x.Name.toLowerCase().includes(q))
      : all;
    const map = new Map<string, TypeRow[]>();
    for (const tRow of list) {
      const arr = map.get(tRow.Namespace);
      if (arr) arr.push(tRow);
      else map.set(tRow.Namespace, [tRow]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [meta, filter]);

  const codeText = useMemo(() => {
    if (!selected) return '';
    const header = `// ${selected.Kind.toLowerCase()} ${selected.FullName}\n// ${t('decompiler.membersNote')}\n\n`;
    const order: MemberKind[] = ['Field', 'Property', 'Method', 'Event'];
    const body = [...members]
      .sort((a, b) => order.indexOf(a.Kind) - order.indexOf(b.Kind) || a.Sig.localeCompare(b.Sig))
      .map((m) => `${m.Vis}${m.Static ? ' static' : ''} ${m.Sig}`)
      .join('\n');
    return header + (body || `// ${t('decompiler.noMembers')}`);
  }, [selected, members, t]);

  const copy = async () => {
    if (!codeText) return;
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const memberCount = members.length;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('decompiler.blurb')}
      </p>

      <div className="mod-toolbar">
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 260 }}
          placeholder={t('decompiler.pathPlaceholder')}
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void load(pathInput);
          }}
        />
        <button className="mini primary" disabled={loading} onClick={() => void load(pathInput)}>
          {loading ? t('decompiler.loading') : t('decompiler.open')}
        </button>
      </div>

      <div className="mod-toolbar" style={{ marginTop: 4 }}>
        <span className="count-note">{t('decompiler.presets')}</span>
        {PRESETS.map((preset) => (
          <button
            key={preset.key}
            className="mini"
            disabled={loading}
            onClick={() => {
              setPathInput(preset.path);
              void load(preset.path);
            }}
          >
            {t(`decompiler.${preset.key}`)}
          </button>
        ))}
      </div>

      {!isTauri() && <p className="count-note">{t('decompiler.webNote')}</p>}
      {err && <pre className="cmd-out error">{err}</pre>}

      {meta && (
        <>
          <div
            className="hosts-edit"
            style={{ minHeight: 0, whiteSpace: 'pre-wrap', marginTop: 12, marginBottom: 12 }}
          >
            {[
              `${t('decompiler.mName')}: ${meta.Name}`,
              `${t('decompiler.mVersion')}: ${meta.Version}`,
              `${t('decompiler.mArch')}: ${meta.Arch}`,
              `${t('decompiler.mPkt')}: ${meta.Pkt}`,
              `${t('decompiler.mKind')}: ${meta.IsExe ? t('decompiler.exe') : t('decompiler.dll')}`,
              `${t('decompiler.mFull')}: ${meta.FullName}`,
              `${t('decompiler.mTypes')}: ${meta.TypeCount}`,
              `${t('decompiler.mRefs')}: ${meta.Refs.length}`,
              `${t('decompiler.mRes')}: ${meta.Res.length}`,
            ].join('\n')}
          </div>

          <div className="io-grid">
            {/* Left: tree (namespace -> type) */}
            <div>
              <div className="mod-toolbar" style={{ marginTop: 0 }}>
                <input
                  className="mod-search"
                  style={{ flex: 1 }}
                  placeholder={t('decompiler.searchPlaceholder')}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
              <div className="hosts-edit" style={{ minHeight: 340, whiteSpace: 'normal', overflow: 'auto' }}>
                {namespaces.length === 0 ? (
                  <span className="count-note">{t('modules.noRows')}</span>
                ) : (
                  namespaces.map(([ns, types]) => (
                    <div key={ns} style={{ marginBottom: 10 }}>
                      <div style={{ fontWeight: 700, opacity: 0.8 }}>
                        {KIND_GLYPH.Namespace} {ns}
                      </div>
                      {types.map((tRow) => (
                        <div
                          key={tRow.FullName}
                          onClick={() => void selectType(tRow)}
                          title={tRow.FullName}
                          style={{
                            cursor: 'pointer',
                            padding: '1px 0 1px 16px',
                            color: selected?.FullName === tRow.FullName ? 'var(--accent)' : undefined,
                            fontWeight: selected?.FullName === tRow.FullName ? 700 : undefined,
                          }}
                        >
                          <span style={{ opacity: 0.6, marginRight: 6 }}>[{KIND_GLYPH[tRow.Kind]}]</span>
                          {tRow.Name}
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </div>
              <details style={{ marginTop: 8 }}>
                <summary className="count-note" style={{ cursor: 'pointer' }}>
                  {t('decompiler.refsResTitle')}
                </summary>
                <div className="hosts-edit" style={{ minHeight: 0, whiteSpace: 'pre-wrap', marginTop: 6 }}>
                  {`${t('decompiler.mRefs')} (${meta.Refs.length}):\n${
                    meta.Refs.length ? meta.Refs.join('\n') : t('decompiler.none')
                  }\n\n${t('decompiler.mRes')} (${meta.Res.length}):\n${
                    meta.Res.length ? meta.Res.join('\n') : t('decompiler.none')
                  }`}
                </div>
              </details>
            </div>

            {/* Right: code / member view */}
            <div>
              <div className="mod-toolbar" style={{ marginTop: 0 }}>
                <span className="count-note" style={{ flex: 1 }}>
                  {selected ? selected.FullName : t('decompiler.noSelection')}
                </span>
                {selected && !memBusy && (
                  <span className="count-note">{t('decompiler.memberCount', { members: memberCount })}</span>
                )}
                <button className="mini" disabled={!codeText} onClick={() => void copy()}>
                  {copied ? t('decompiler.copied') : t('decompiler.copy')}
                </button>
              </div>
              {memBusy ? (
                <p className="count-note">{t('decompiler.loading')}</p>
              ) : memErr ? (
                <pre className="cmd-out error">{memErr}</pre>
              ) : selected ? (
                <textarea className="hosts-edit" readOnly value={codeText} spellCheck={false} />
              ) : (
                <div className="hosts-edit" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span className="count-note">{t('decompiler.emptyHint')}</span>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <p className="count-note" style={{ marginTop: 12 }}>
        {t('decompiler.footer')}
      </p>
    </div>
  );
}
