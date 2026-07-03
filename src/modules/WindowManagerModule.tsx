import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, ModuleToolbar, StatusDot, useAsync } from './common';

// Window Manager · 視窗管理 — native port of WinForge's WindowManagerModule
// (Pages/WindowManagerModule.xaml.cs + Services/WindowManager.cs).
// Lists real top-level windows via Win32 EnumWindows and snaps the selected one to
// halves / quarters / thirds, maximise, centre, full area, plus focus / minimise /
// always-on-top and desktop-wide tile & cascade — all through the Rust backend
// shelling out to Windows PowerShell 5.1 with Add-Type P/Invoke (user32.dll).
// Read/list runs on mount; every window mutation happens only on an explicit click.

interface WinRow {
  handle: number;
  title: string;
  proc: string;
  procId: number;
  state: string; // 'normal' | 'min' | 'max'
  topmost: boolean;
}

// P/Invoke surface (mirrors Services/WindowManager.cs). No single quotes inside —
// it is embedded in a PowerShell single-quoted string.
const DEFS =
  'public delegate bool EnumProc(IntPtr h, IntPtr l); ' +
  '[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l); ' +
  '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); ' +
  '[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h); ' +
  '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); ' +
  '[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h); ' +
  '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int m); ' +
  '[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h); ' +
  '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); ' +
  '[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c); ' +
  '[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i); ' +
  '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f); ' +
  '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); ' +
  '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); ' +
  '[DllImport("user32.dll")] public static extern ushort TileWindows(IntPtr p, uint w, IntPtr r, uint n, IntPtr k); ' +
  '[DllImport("user32.dll")] public static extern ushort CascadeWindows(IntPtr p, uint w, IntPtr r, uint n, IntPtr k);';

const ADD_TYPE = `if (-not ('WF.User32' -as [type])) { Add-Type -Namespace WF -Name User32 -MemberDefinition '${DEFS}' }`;

// Enumerate visible, unowned, non-toolwindow top-level windows with a title —
// same filter chain as WindowManager.List() in the C# service.
// PS 5.1 writes stdout in the OEM codepage by default, which mangles CJK window
// titles through the backend's UTF-8 decode — force UTF-8 first (verified live).
const LIST_SCRIPT =
  'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}; ' +
  `${ADD_TYPE}; ` +
  '$procs=@{}; Get-Process | ForEach-Object { $procs[$_.Id]=$_.ProcessName }; ' +
  '$res=New-Object System.Collections.ArrayList; ' +
  '$cb=[WF.User32+EnumProc]{ param($h,$l); try { ' +
  'if (-not [WF.User32]::IsWindowVisible($h)) { return $true }; ' +
  'if ([WF.User32]::GetWindow($h,4) -ne [IntPtr]::Zero) { return $true }; ' +
  '$ex=[WF.User32]::GetWindowLong($h,-20); if ($ex -band 0x80) { return $true }; ' +
  '$len=[WF.User32]::GetWindowTextLength($h); if ($len -lt 1) { return $true }; ' +
  '$sb=New-Object System.Text.StringBuilder ($len+2); [void][WF.User32]::GetWindowText($h,$sb,$sb.Capacity); ' +
  '$ti=$sb.ToString().Trim(); if ($ti.Length -lt 1) { return $true }; ' +
  '$wp=[uint32]0; [void][WF.User32]::GetWindowThreadProcessId($h,[ref]$wp); $pn=[string]$procs[[int]$wp]; ' +
  "$st='normal'; if ([WF.User32]::IsIconic($h)) { $st='min' } elseif ([WF.User32]::IsZoomed($h)) { $st='max' }; " +
  '[void]$res.Add([pscustomobject]@{handle=[int64]$h; title=$ti; proc=$pn; procId=[int]$wp; state=$st; topmost=(($ex -band 8) -ne 0)}) ' +
  '} catch {}; return $true }; ' +
  '[void][WF.User32]::EnumWindows($cb,[IntPtr]::Zero); $res';

// Per-window action wrapper: verifies the handle still exists, echoes ok/gone.
const winScript = (handle: number, body: string) =>
  `${ADD_TYPE}; $h=[IntPtr]::new(${Math.trunc(handle)}); ` +
  `if (-not [WF.User32]::IsWindow($h)) { 'gone' } else { ${body}; 'ok' }`;

const FOCUS_BODY = '[void][WF.User32]::ShowWindow($h,9); [void][WF.User32]::SetForegroundWindow($h)';
const MIN_BODY = '[void][WF.User32]::ShowWindow($h,6)';
const MAX_BODY = '[void][WF.User32]::ShowWindow($h,3); [void][WF.User32]::SetForegroundWindow($h)';
const pinBody = (on: boolean) =>
  `[void][WF.User32]::SetWindowPos($h,[IntPtr]::new(${on ? -1 : -2}),0,0,0,0,0x13)`;
// Restore, compute the zone rect from the primary work area, then SetWindowPos —
// identical geometry to WindowManager.Snap() ($g = height; 0x44 = SHOWWINDOW|NOZORDER).
const snapBody = (expr: string) =>
  'Add-Type -AssemblyName System.Windows.Forms; ' +
  '$wa=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; ' +
  '$ax=$wa.X; $ay=$wa.Y; $aw=$wa.Width; $ah=$wa.Height; ' +
  '$hw=[int][math]::Floor($aw/2); $hh=[int][math]::Floor($ah/2); $tw=[int][math]::Floor($aw/3); ' +
  '[void][WF.User32]::ShowWindow($h,9); ' +
  expr +
  '; [void][WF.User32]::SetWindowPos($h,[IntPtr]::Zero,$x,$y,$w,$g,0x44); [void][WF.User32]::SetForegroundWindow($h)';

const TILE_SCRIPT = `${ADD_TYPE}; [void][WF.User32]::TileWindows([IntPtr]::Zero,0,[IntPtr]::Zero,0,[IntPtr]::Zero); 'ok'`;
const CASCADE_SCRIPT = `${ADD_TYPE}; [void][WF.User32]::CascadeWindows([IntPtr]::Zero,0,[IntPtr]::Zero,0,[IntPtr]::Zero); 'ok'`;

interface ZoneDef {
  id: string;
  labelKey: string;
  glyph?: string;
  expr: string;
}

// Same zones (and glyphs) as the original snap pad.
const ZONE_GROUPS: { titleKey: string; zones: ZoneDef[] }[] = [
  {
    titleKey: 'winmgr.halves',
    zones: [
      { id: 'LeftHalf', labelKey: 'winmgr.left', glyph: '◧', expr: '$x=$ax; $y=$ay; $w=$hw; $g=$ah' },
      { id: 'RightHalf', labelKey: 'winmgr.right', glyph: '◨', expr: '$x=$ax+$hw; $y=$ay; $w=$aw-$hw; $g=$ah' },
      { id: 'TopHalf', labelKey: 'winmgr.top', glyph: '⬒', expr: '$x=$ax; $y=$ay; $w=$aw; $g=$hh' },
      { id: 'BottomHalf', labelKey: 'winmgr.bottom', glyph: '⬓', expr: '$x=$ax; $y=$ay+$hh; $w=$aw; $g=$ah-$hh' },
    ],
  },
  {
    titleKey: 'winmgr.quarters',
    zones: [
      { id: 'TopLeft', labelKey: 'winmgr.topL', glyph: '◰', expr: '$x=$ax; $y=$ay; $w=$hw; $g=$hh' },
      { id: 'TopRight', labelKey: 'winmgr.topR', glyph: '◳', expr: '$x=$ax+$hw; $y=$ay; $w=$aw-$hw; $g=$hh' },
      { id: 'BottomLeft', labelKey: 'winmgr.botL', glyph: '◱', expr: '$x=$ax; $y=$ay+$hh; $w=$hw; $g=$ah-$hh' },
      { id: 'BottomRight', labelKey: 'winmgr.botR', glyph: '◲', expr: '$x=$ax+$hw; $y=$ay+$hh; $w=$aw-$hw; $g=$ah-$hh' },
    ],
  },
  {
    titleKey: 'winmgr.thirds',
    zones: [
      { id: 'LeftThird', labelKey: 'winmgr.leftThird', expr: '$x=$ax; $y=$ay; $w=$tw; $g=$ah' },
      { id: 'CenterThird', labelKey: 'winmgr.centerThird', expr: '$x=$ax+$tw; $y=$ay; $w=$tw; $g=$ah' },
      { id: 'RightThird', labelKey: 'winmgr.rightThird', expr: '$x=$ax+2*$tw; $y=$ay; $w=$aw-2*$tw; $g=$ah' },
    ],
  },
  {
    titleKey: 'winmgr.whole',
    zones: [
      { id: 'Maximize', labelKey: 'winmgr.maximize', expr: '' },
      {
        id: 'Center',
        labelKey: 'winmgr.center',
        expr: '$x=$ax+[int][math]::Floor($aw/6); $y=$ay+[int][math]::Floor($ah/6); $w=[int][math]::Floor($aw*2/3); $g=[int][math]::Floor($ah*2/3)',
      },
      { id: 'FullArea', labelKey: 'winmgr.fullArea', expr: '$x=$ax; $y=$ay; $w=$aw; $g=$ah' },
    ],
  },
];

export function WindowManagerModule() {
  const { t } = useTranslation();
  const desktop = isTauri();
  const [filter, setFilter] = useState('');
  const [selHandle, setSelHandle] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const { data, loading, error, reload } = useAsync(
    () => (desktop ? runPowershellJson<WinRow>(LIST_SCRIPT) : Promise.resolve<WinRow[]>([])),
    [],
  );

  const rows = useMemo(() => {
    const all = data ?? [];
    const q = filter.trim().toLowerCase();
    return q ? all.filter((w) => `${w.title} ${w.proc}`.toLowerCase().includes(q)) : all;
  }, [data, filter]);

  const selected = useMemo(
    () => (data ?? []).find((w) => w.handle === selHandle) ?? null,
    [data, selHandle],
  );

  const stateLabel = (s: string) =>
    s === 'min' ? t('winmgr.stMin') : s === 'max' ? t('winmgr.stMax') : t('winmgr.stNormal');

  const runAct = async (id: string, script: string, okText: string) => {
    setBusy(id);
    setMsg(null);
    try {
      const res = await runPowershell(script);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      const out = res.stdout.trim();
      setMsg(out === 'gone' ? { ok: false, text: t('winmgr.gone') } : { ok: true, text: okText });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: `${t('winmgr.failed')}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const snap = (z: ZoneDef) => {
    if (!selected) {
      setMsg({ ok: false, text: t('winmgr.selectFirst') });
      return;
    }
    const body = z.id === 'Maximize' ? MAX_BODY : snapBody(z.expr);
    void runAct(
      `snap:${z.id}`,
      winScript(selected.handle, body),
      t('winmgr.snapped', { title: selected.title, zone: t(z.labelKey) }),
    );
  };

  const extra = (id: string, body: string, actionLabel: string) => {
    if (!selected) {
      setMsg({ ok: false, text: t('winmgr.selectFirst') });
      return;
    }
    void runAct(
      id,
      winScript(selected.handle, body),
      t('winmgr.done', { action: actionLabel, title: selected.title }),
    );
  };

  const actionsOff = !desktop || !selected || busy !== null;
  const globalOff = !desktop || busy !== null;

  return (
    <div className="mod">
      <p className="count-note">{t('winmgr.blurb')}</p>
      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>
          {t('winmgr.desktopNote')}
        </p>
      )}
      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('winmgr.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="mini" disabled={globalOff} onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <button className="mini" disabled={globalOff} onClick={() => void runAct('tile', TILE_SCRIPT, t('winmgr.tiled'))}>
          {t('winmgr.tile')}
        </button>
        <button
          className="mini"
          disabled={globalOff}
          onClick={() => void runAct('cascade', CASCADE_SCRIPT, t('winmgr.cascaded'))}
        >
          {t('winmgr.cascade')}
        </button>
        <span className="count-note">{t('winmgr.wins', { count: rows.length })}</span>
      </ModuleToolbar>
      {msg &&
        (msg.ok ? (
          <p className="mod-msg">{msg.text}</p>
        ) : (
          <pre className="cmd-out error">{msg.text}</pre>
        ))}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <AsyncState loading={loading} error={error}>
            {rows.length === 0 ? (
              <p className="count-note">{t('modules.noRows')}</p>
            ) : (
              <div className="dt-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th style={{ width: 110 }}>{t('winmgr.colState')}</th>
                      <th>{t('winmgr.colTitle')}</th>
                      <th style={{ width: 150 }}>{t('winmgr.colProc')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((w) => {
                      const sel = w.handle === selHandle;
                      return (
                        <tr
                          key={w.handle}
                          onClick={() => setSelHandle(w.handle)}
                          style={{
                            cursor: 'pointer',
                            background: sel
                              ? 'color-mix(in srgb, var(--accent) 18%, transparent)'
                              : undefined,
                          }}
                        >
                          <td>
                            <StatusDot ok={w.state !== 'min'} label={stateLabel(w.state)} />
                          </td>
                          <td>
                            {w.topmost && <span title={t('winmgr.pinned')}>📌 </span>}
                            {w.title}
                          </td>
                          <td style={{ fontFamily: 'monospace' }} title={`PID ${w.procId}`}>
                            {w.proc}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </AsyncState>
        </div>
        <div className="panel" style={{ width: 300, flexShrink: 0 }}>
          <h3>{t('winmgr.padTitle')}</h3>
          <p
            className="count-note"
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {selected ? `${t('winmgr.selectedLabel')}: ${selected.title}` : t('winmgr.selectFirst')}
          </p>
          {ZONE_GROUPS.map((g) => (
            <div key={g.titleKey} style={{ marginBottom: 10 }}>
              <p className="count-note" style={{ margin: '4px 0', fontWeight: 600 }}>
                {t(g.titleKey)}
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {g.zones.map((z) => (
                  <button key={z.id} className="mini" disabled={actionsOff} onClick={() => snap(z)}>
                    {z.glyph ? `${z.glyph} ${t(z.labelKey)}` : t(z.labelKey)}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            <button
              className="mini"
              disabled={actionsOff}
              onClick={() => extra('focus', FOCUS_BODY, t('winmgr.focus'))}
            >
              {t('winmgr.focus')}
            </button>
            <button
              className="mini"
              disabled={actionsOff}
              onClick={() => extra('min', MIN_BODY, t('winmgr.minimize'))}
            >
              {t('winmgr.minimize')}
            </button>
            <button
              className={selected?.topmost ? 'mini primary' : 'mini'}
              disabled={actionsOff}
              onClick={() =>
                selected &&
                extra(
                  'pin',
                  pinBody(!selected.topmost),
                  selected.topmost ? t('winmgr.pinOff') : t('winmgr.pinOn'),
                )
              }
            >
              {selected?.topmost ? t('winmgr.pinOff') : t('winmgr.pinOn')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
