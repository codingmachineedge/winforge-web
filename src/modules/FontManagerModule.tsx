import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAsync, AsyncState, ModuleToolbar, StatusDot, DataTable, type Column } from './common';
import { runPowershell, runPowershellJson, isTauri } from '../tauri/bridge';

// Port of WinForge Pages/FontManagerModule + Services/FontService: list
// installed fonts (per-user HKCU + machine HKLM), live preview (the webview
// renders any installed family by name), per-user install without UAC (copy
// to %LOCALAPPDATA%\Microsoft\Windows\Fonts + HKCU value + AddFontResource +
// WM_FONTCHANGE broadcast), and gated uninstall.

interface FontEntry {
  face: string;
  regName: string;
  path: string;
  machineWide: boolean;
  kind: string;
}

const BROADCAST = `
Add-Type -Name WfFont -Namespace Wf -MemberDefinition @'
[DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern int AddFontResource(string path);
[DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern bool RemoveFontResource(string path);
[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.IntPtr wParam, System.IntPtr lParam, uint flags, uint timeout, out System.IntPtr result);
'@
function Send-FontChange { $r = [System.IntPtr]::Zero; [void][Wf.WfFont]::SendMessageTimeout([System.IntPtr]0xffff, 0x001D, [System.IntPtr]::Zero, [System.IntPtr]::Zero, 2, 1000, [ref]$r) }
`;

const LIST_PS = `
function Read-FontKey([string]$hive, [string]$key, [bool]$machine, [string]$baseDir) {
  $item = Get-Item -Path "$hive\\$key" -ErrorAction SilentlyContinue
  if (-not $item) { return @() }
  foreach ($name in $item.GetValueNames()) {
    $raw = [string]$item.GetValue($name)
    if (-not $raw) { continue }
    $path = if ([System.IO.Path]::IsPathRooted($raw)) { $raw } else { Join-Path $baseDir $raw }
    $face = $name; $kind = 'TrueType'
    $paren = $name.LastIndexOf(' (')
    if ($paren -gt 0 -and $name.EndsWith(')')) { $face = $name.Substring(0, $paren); $kind = $name.Substring($paren + 2).TrimEnd(')') }
    [pscustomobject]@{ face = $face; regName = $name; path = $path; machineWide = $machine; kind = $kind }
  }
}
$user = Read-FontKey 'HKCU:' 'Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' $false (Join-Path $env:LOCALAPPDATA 'Microsoft\\Windows\\Fonts')
$machine = Read-FontKey 'HKLM:' 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' $true (Join-Path $env:windir 'Fonts')
@($user) + @($machine) | Sort-Object face
`;

function installPs(src: string): string {
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(src)));
  return `
${BROADCAST}
$src = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
if (-not (Test-Path $src)) { throw "File not found: $src" }
$ext = [System.IO.Path]::GetExtension($src).ToLowerInvariant()
if ($ext -notin '.ttf','.otf','.ttc','.otc','.fon') { throw "Not a font file: $src" }
$kind = if ($ext -in '.otf','.otc') { 'OpenType' } else { 'TrueType' }
$face = [System.IO.Path]::GetFileNameWithoutExtension($src)
try {
  Add-Type -AssemblyName PresentationCore
  $gt = [Windows.Media.GlyphTypeface]::new([Uri]$src)
  $names = $gt.Win32FamilyNames
  if ($names.ContainsKey('en-us')) { $face = $names['en-us'] } elseif ($names.Count -gt 0) { $face = @($names.Values)[0] }
} catch { }
$dir = Join-Path $env:LOCALAPPDATA 'Microsoft\\Windows\\Fonts'
New-Item -ItemType Directory -Force $dir | Out-Null
$dest = Join-Path $dir ([System.IO.Path]::GetFileName($src))
$i = 1
while ((Test-Path $dest) -and ((Resolve-Path $dest).Path -ne (Resolve-Path $src -ErrorAction SilentlyContinue).Path)) {
  $dest = Join-Path $dir ("{0}_{1}{2}" -f [System.IO.Path]::GetFileNameWithoutExtension($src), $i++, $ext)
}
Copy-Item $src $dest -Force
Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' -Name "$face ($kind)" -Value $dest
[void][Wf.WfFont]::AddFontResource($dest)
Send-FontChange
"Installed: $face ($kind)"
`;
}

function uninstallPs(f: FontEntry): string {
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  return `
${BROADCAST}
$regName = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(f.regName)}'))
$path = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(f.path)}'))
$hive = '${f.machineWide ? 'HKLM:' : 'HKCU:'}'
Remove-ItemProperty -Path "$hive\\${f.machineWide ? 'SOFTWARE' : 'Software'}\\Microsoft\\Windows NT\\CurrentVersion\\Fonts" -Name $regName -ErrorAction Stop
if (Test-Path $path) {
  [void][Wf.WfFont]::RemoveFontResource($path)
  try { Remove-Item $path -Force -Confirm:$false } catch { }
}
Send-FontChange
"Removed: $regName"
`;
}

export function FontManagerModule() {
  const { t } = useTranslation();
  const live = isTauri();
  const [filter, setFilter] = useState('');
  const [scope, setScope] = useState<'all' | 'user' | 'machine'>('all');
  const [sample, setSample] = useState('The quick brown fox 敏捷嘅棕色狐狸 0123');
  const [installPath, setInstallPath] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const fonts = useAsync(async () => {
    if (!live) return [] as FontEntry[];
    return runPowershellJson<FontEntry>(LIST_PS);
  }, [live]);

  const rows = useMemo(() => {
    const all = fonts.data ?? [];
    const q = filter.trim().toLowerCase();
    return all.filter(
      (f) =>
        (scope === 'all' || (scope === 'machine') === f.machineWide) &&
        (!q || f.face.toLowerCase().includes(q)),
    );
  }, [fonts.data, filter, scope]);

  const act = (script: string) => {
    runPowershell(script).then(
      (r) => {
        setMessage(r.success ? r.stdout.trim() : r.stderr.trim() || r.stdout.trim());
        if (r.success) fonts.reload();
      },
      (e) => setMessage(String(e)),
    );
  };

  const cols: Column<FontEntry>[] = [
    { key: 'face', header: t('fonts.face'), width: 220 },
    {
      key: 'preview',
      header: t('fonts.previewCol'),
      render: (f) => (
        <span style={{ fontFamily: `'${f.face.replace(/'/g, '')}'`, fontSize: 17 }}>{sample}</span>
      ),
    },
    { key: 'kind', header: t('fonts.kind'), width: 90 },
    {
      key: 'scope',
      header: t('fonts.scope'),
      width: 90,
      render: (f) => (f.machineWide ? t('fonts.machine') : t('fonts.user')),
    },
    {
      key: 'actions',
      header: '',
      width: 90,
      render: (f) => (
        <button
          className="mini"
          disabled={f.machineWide}
          title={f.machineWide ? t('fonts.machineNote') : t('fonts.uninstall')}
          onClick={() => {
            if (window.confirm(t('fonts.confirmRemove', { face: f.face }))) act(uninstallPs(f));
          }}
        >
          {t('fonts.uninstall')}
        </button>
      ),
    },
  ];

  return (
    <div className="mod">
      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('fonts.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {(['all', 'user', 'machine'] as const).map((s) => (
          <button key={s} className={`mini${scope === s ? ' primary' : ''}`} onClick={() => setScope(s)}>
            {t(`fonts.scope_${s}`)}
          </button>
        ))}
        <button className="mini" onClick={fonts.reload}>{t('fonts.refresh')}</button>
        <StatusDot ok={live} label={live ? t('fonts.live') : t('fonts.preview')} />
      </ModuleToolbar>

      <p className="count-note">{t('fonts.blurb')}</p>

      <div className="panel" style={{ marginBottom: 10, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ flex: '1 1 260px' }}
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          placeholder={t('fonts.samplePh')}
        />
        <input
          className="mod-search"
          style={{ flex: '2 1 320px' }}
          value={installPath}
          onChange={(e) => setInstallPath(e.target.value)}
          placeholder={t('fonts.installPh')}
        />
        <button
          className="mini primary"
          disabled={!live || !installPath.trim()}
          onClick={() => act(installPs(installPath.trim()))}
        >
          {t('fonts.install')}
        </button>
      </div>

      {message && <p className="count-note">{message}</p>}

      {live ? (
        <AsyncState loading={fonts.loading} error={fonts.error}>
          <p className="count-note">{t('fonts.total', { shown: rows.length })}</p>
          <DataTable columns={cols} rows={rows} rowKey={(f) => `${f.machineWide ? 'm' : 'u'}:${f.regName}`} />
        </AsyncState>
      ) : (
        <p className="count-note">{t('fonts.previewNote')}</p>
      )}
    </div>
  );
}
