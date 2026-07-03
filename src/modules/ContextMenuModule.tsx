import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, useAsync } from './common';

// Scope index -> registry sub-path under HKCU:\Software\Classes and the command placeholder.
// Mirrors ContextMenuService.Scopes (per-user HKCU only; never touches system HKLM/HKCR defaults).
const SCOPES: { path: string; ph: string; enKey: string }[] = [
  { path: '*\\shell', ph: '%1', enKey: 'scopeFiles' },
  { path: 'Directory\\shell', ph: '%1', enKey: 'scopeFolders' },
  { path: 'Directory\\Background\\shell', ph: '%V', enKey: 'scopeBackground' },
  { path: 'Drive\\shell', ph: '%1', enKey: 'scopeDrives' },
];

interface VerbRow {
  Scope: number;
  Key: string;
  Label: string;
  Command: string;
  Icon: string;
  Extended: boolean;
}

// Sanitize a label into a registry key name, matching ContextMenuService.SanitizeKey ("WT_" prefix).
function sanitizeKey(label: string): string {
  const kept = [...label].filter((c) => /[\p{L}\p{N}_ -]/u.test(c)).join('');
  const k = kept.trim().replace(/ /g, '_');
  return 'WT_' + (k.length ? k : 'WinForgeVerb');
}

// PowerShell single-quote escape (double any embedded quote).
const psq = (s: string) => s.replace(/'/g, "''");

export function ContextMenuModule() {
  const { t } = useTranslation();

  const [scope, setScope] = useState(2); // default: Folder background, like the WinUI page
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [icon, setIcon] = useState('');
  const [extended, setExtended] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const scopeLabel = (i: number) => t(`contextmenu.${SCOPES[i]?.enKey ?? 'scopeFiles'}`);

  // Read every custom verb across all four scopes from HKCU. We only surface keys we created
  // (the "WT_" prefix) so the user never accidentally deletes a third-party or system verb.
  const { data, loading, error, reload } = useAsync<VerbRow[]>(async () => {
    const script = `
$scopes = @('*\\shell','Directory\\shell','Directory\\Background\\shell','Drive\\shell')
$out = New-Object System.Collections.ArrayList
for ($s = 0; $s -lt $scopes.Length; $s++) {
  $root = "HKCU:\\Software\\Classes\\" + $scopes[$s]
  if (-not (Test-Path -LiteralPath $root)) { continue }
  Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {
    $k = $_.PSChildName
    if ($k -notlike 'WT_*') { return }
    $vp = Join-Path $root $k
    $p = Get-ItemProperty -LiteralPath $vp -ErrorAction SilentlyContinue
    $lbl = if ($p.'(default)') { $p.'(default)' } elseif ($p.MUIVerb) { $p.MUIVerb } else { $k }
    $cmd = ''
    $cp = Join-Path $vp 'command'
    if (Test-Path -LiteralPath $cp) { $cmd = (Get-ItemProperty -LiteralPath $cp -ErrorAction SilentlyContinue).'(default)' }
    $ic = if ($p.Icon) { $p.Icon } else { '' }
    $ext = ($null -ne $p.Extended)
    [void]$out.Add([pscustomobject]@{ Scope = $s; Key = $k; Label = "$lbl"; Command = "$cmd"; Icon = "$ic"; Extended = $ext })
  }
}
$out`;
    return runPowershellJson<VerbRow>(script);
  }, []);

  const rows = useMemo(() => {
    const all = data ?? [];
    return [...all].sort((a, b) => a.Scope - b.Scope || a.Label.localeCompare(b.Label));
  }, [data]);

  // Write a verb into HKCU: default value = label, optional Icon / Extended, and command\(default) = command.
  const addVerb = async (
    sc: number,
    lbl: string,
    cmd: string,
    ic: string,
    ext: boolean,
  ): Promise<boolean> => {
    const sp = SCOPES[sc]?.path ?? SCOPES[0]!.path;
    const key = sanitizeKey(lbl);
    const vp = `HKCU:\\Software\\Classes\\${sp}\\${key}`;
    const parts = [
      `New-Item -Path '${psq(vp)}' -Force | Out-Null`,
      `Set-ItemProperty -LiteralPath '${psq(vp)}' -Name '(default)' -Value '${psq(lbl)}'`,
    ];
    if (ic.trim()) parts.push(`Set-ItemProperty -LiteralPath '${psq(vp)}' -Name 'Icon' -Value '${psq(ic.trim())}'`);
    if (ext) parts.push(`Set-ItemProperty -LiteralPath '${psq(vp)}' -Name 'Extended' -Value ''`);
    parts.push(`New-Item -Path '${psq(vp)}\\command' -Force | Out-Null`);
    parts.push(`Set-ItemProperty -LiteralPath '${psq(vp)}\\command' -Name '(default)' -Value '${psq(cmd)}'`);
    parts.push(`'ok'`);
    const res = await runPowershell(parts.join('; '));
    if (!res.success) {
      setMsg(`${t('contextmenu.failed')}: ${res.stderr.trim() || `exit ${res.code}`}`);
      return false;
    }
    return true;
  };

  const onAdd = async () => {
    const lbl = label.trim();
    const cmd = command.trim();
    if (!lbl || !cmd) {
      setMsg(t('contextmenu.needBoth'));
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const ok = await addVerb(scope, lbl, cmd, icon, extended);
      if (ok) {
        setMsg(`${t('contextmenu.added')}: ${scopeLabel(scope)} · ${lbl}`);
        setLabel('');
        setCommand('');
        setIcon('');
        setExtended(false);
        reload();
      }
    } catch (e) {
      setMsg(`${t('contextmenu.failed')}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const addPreset = async (sc: number, lbl: string, cmd: string, ic: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const ok = await addVerb(sc, lbl, cmd, ic, false);
      if (ok) {
        setMsg(`${t('contextmenu.presetAdded')}: ${lbl}`);
        reload();
      }
    } catch (e) {
      setMsg(`${t('contextmenu.failed')}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const removeVerb = async (row: VerbRow) => {
    if (!window.confirm(t('contextmenu.confirmRemove', { label: row.Label }))) return;
    const sp = SCOPES[row.Scope]?.path ?? SCOPES[0]!.path;
    const vp = `HKCU:\\Software\\Classes\\${sp}\\${row.Key}`;
    setBusy(true);
    setMsg(null);
    try {
      const res = await runPowershell(`Remove-Item -LiteralPath '${psq(vp)}' -Recurse -Force -ErrorAction Stop; 'ok'`);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg(`${t('contextmenu.removed')}: ${row.Label}`);
      reload();
    } catch (e) {
      setMsg(`${t('contextmenu.failed')}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<VerbRow>[] = [
    {
      key: 'Scope',
      header: t('contextmenu.colScope'),
      width: 150,
      render: (r) => <span className="env-val">{scopeLabel(r.Scope)}</span>,
    },
    {
      key: 'Label',
      header: t('contextmenu.colLabel'),
      width: 200,
      render: (r) => (
        <span>
          {r.Label}
          {r.Extended ? <span className="count-note"> · {t('contextmenu.shiftOnly')}</span> : null}
        </span>
      ),
    },
    {
      key: 'Command',
      header: t('contextmenu.colCommand'),
      render: (r) => <span className="env-val">{r.Command}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: 90,
      render: (r) => (
        <button className="mini" disabled={busy} onClick={() => void removeVerb(r)}>
          {t('contextmenu.remove')}
        </button>
      ),
    },
  ];

  const presetPh = SCOPES[2]!.ph; // %V for folder-background presets

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('contextmenu.blurb')}
      </p>

      <div className="hosts-edit" style={{ display: 'flex', flexDirection: 'column', gap: 8, height: 'auto', padding: 12 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select value={scope} onChange={(e) => setScope(Number(e.target.value))} style={{ minWidth: 180 }}>
            {SCOPES.map((s, i) => (
              <option key={s.path} value={i}>
                {scopeLabel(i)}
              </option>
            ))}
          </select>
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 220 }}
            placeholder={t('contextmenu.labelPlaceholder')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <input
          className="mod-search"
          style={{ fontFamily: 'monospace' }}
          placeholder={t('contextmenu.commandPlaceholder', { ph: SCOPES[scope]?.ph ?? '%1' })}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 200 }}
            placeholder={t('contextmenu.iconPlaceholder')}
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
          />
          <label className="count-note" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={extended} onChange={(e) => setExtended(e.target.checked)} />
            {t('contextmenu.shiftOnly')}
          </label>
          <button className="mini primary" disabled={busy} onClick={() => void onAdd()}>
            {t('contextmenu.add')}
          </button>
        </div>
      </div>

      <div className="mod-toolbar" style={{ marginTop: 8 }}>
        <span className="count-note">{t('contextmenu.presets')}</span>
        <button
          className="mini"
          disabled={busy}
          onClick={() =>
            void addPreset(
              2,
              t('contextmenu.presetPsLabel'),
              `powershell.exe -NoExit -Command "Set-Location -LiteralPath '${presetPh}'"`,
              'powershell.exe',
            )
          }
        >
          {t('contextmenu.presetPs')}
        </button>
        <button
          className="mini"
          disabled={busy}
          onClick={() => void addPreset(2, t('contextmenu.presetCmdLabel'), `cmd.exe /s /k pushd "${presetPh}"`, 'cmd.exe')}
        >
          {t('contextmenu.presetCmd')}
        </button>
        <button className="mini" disabled={busy} onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">{t('contextmenu.customCount', { total: rows.length })}</span>
      </div>

      {msg && <p className="mod-msg">{msg}</p>}

      <AsyncState loading={loading} error={error}>
        <DataTable columns={columns} rows={rows} rowKey={(r) => `${r.Scope}-${r.Key}`} empty={t('contextmenu.none')} />
      </AsyncState>
    </div>
  );
}
