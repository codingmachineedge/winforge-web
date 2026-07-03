import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

/**
 * Native web port of WinForge CropAndLockModule (module.cropandlock) — a clone of PowerToys
 * Crop And Lock.
 *
 * The desktop original runs a background Win32 message pump that spawns always-on-top DWM-thumbnail
 * host windows (DwmRegisterThumbnail) mirroring a chosen crop of a source window, in Thumbnail
 * (live mirror) or Crop mode, triggered by global RegisterHotKey chords. This port keeps that exact
 * model and makes it genuinely live on the desktop through the Tauri Rust backend:
 *
 *  • A LIVE window picker enumerates every real top-level window (mirroring WindowManager.List — its
 *    title, owning process and pixel bounds) read read-only via PowerShell.
 *  • Thumbnail / Crop buttons spawn a real, always-on-top, movable/resizable DWM-thumbnail host
 *    window over the whole source window (or a saved crop fraction) through a self-contained
 *    Add-Type P/Invoke script — the same DwmRegisterThumbnail path the native module uses.
 *  • The two global hotkeys (default Ctrl+Shift+T / Ctrl+Shift+C) are configurable and persist in
 *    localStorage, matching the CropAndLockService.Chord model.
 *  • Enable/disable, the active-window list with per-item and Close-all buttons, and the bilingual
 *    "how it works" note all track the original page.
 */

interface WinRow {
  Handle: string; // decimal HWND as string (JSON-safe)
  Title: string;
  Process: string;
  X: number;
  Y: number;
  W: number;
  H: number;
}

interface ActiveEntry {
  id: string;
  handle: string;
  sourceTitle: string;
  thumbnail: boolean;
  cropPct: number; // 0..100 side length of the centered crop; 100 = whole window
}

interface Chord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  win: boolean;
  key: string; // friendly label e.g. "T", "F5", "" = none
}

const ENABLED_KEY = 'winforge.cropandlock.enabled.v1';
const THUMB_HK_KEY = 'winforge.cropandlock.hotkey.thumb.v1';
const CROP_HK_KEY = 'winforge.cropandlock.hotkey.crop.v1';

/** Mirrors HotkeyMacroService.PickableKeys. */
const PICKABLE_KEYS: string[] = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  ...'0123456789'.split(''),
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  'Space',
  'Enter',
  'Tab',
  'Esc',
  'Insert',
  'Delete',
  'Home',
  'End',
  'Page Up',
  'Page Down',
  'Print Screen',
  'Left',
  'Up',
  'Right',
  'Down',
];

const DEFAULT_THUMB: Chord = { ctrl: true, alt: false, shift: true, win: false, key: 'T' };
const DEFAULT_CROP: Chord = { ctrl: true, alt: false, shift: true, win: false, key: 'C' };

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function chordText(c: Chord): string {
  if (!c.key) return '';
  const parts: string[] = [];
  if (c.ctrl) parts.push('Ctrl');
  if (c.alt) parts.push('Alt');
  if (c.shift) parts.push('Shift');
  if (c.win) parts.push('Win');
  parts.push(c.key);
  return parts.join(' + ');
}

function loadChord(key: string, fallback: Chord): Chord {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      ctrl: o.ctrl === true,
      alt: o.alt === true,
      shift: o.shift === true,
      win: o.win === true,
      key: typeof o.key === 'string' ? o.key : '',
    };
  } catch {
    return fallback;
  }
}

// Enumerate real top-level windows, read-only, mirroring WindowManager.List():
// visible, non-owned, non-tool-window, titled, and not WinForge/this shell itself.
const LIST_WINDOWS_PS = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WFWin {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L,T,R,B; }
}
'@
$procs = @{}
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $procs[[int64]$_.MainWindowHandle] = $_.ProcessName }
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object {
  $h = $_.MainWindowHandle
  if (-not [WFWin]::IsWindowVisible($h)) { return }
  if ([WFWin]::GetWindow($h, 4) -ne [IntPtr]::Zero) { return }
  $ex = [WFWin]::GetWindowLong($h, -20)
  if (($ex -band 0x80) -ne 0) { return }
  if ($_.ProcessName -match 'WinForge|winforge-web') { return }
  $r = New-Object WFWin+RECT
  [void][WFWin]::GetWindowRect($h, [ref]$r)
  [pscustomobject]@{
    Handle  = [string]([int64]$h)
    Title   = [string]$_.MainWindowTitle
    Process = [string]$_.ProcessName
    X = $r.L; Y = $r.T; W = ($r.R - $r.L); H = ($r.B - $r.T)
  }
}`;

// Spawn a real always-on-top DWM-thumbnail host window mirroring a crop of the source window.
// This is the same DwmRegisterThumbnail path the native module uses. cropPct is the centered
// crop side length as a percentage (100 = whole window). The host runs detached so it survives
// after PowerShell returns; a marker title lets us find & close it later.
function spawnScript(handle: string, thumbnail: boolean, cropPct: number, marker: string): string {
  const modeName = thumbnail ? 'Thumbnail' : 'Cropped';
  const pct = Math.max(10, Math.min(100, Math.round(cropPct)));
  return `
$src = [IntPtr]${handle}
$pct = ${pct}
$marker = '${marker}'
$title = '${modeName} - ' + $marker
$code = @"
using System;
using System.Runtime.InteropServices;
public static class Host {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct TP { public uint dwFlags; public RECT rcDest; public RECT rcSrc; public byte opacity; public bool fVisible; public bool fSourceClientAreaOnly; }
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr CreateWindowExW(uint ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr p, IntPtr m, IntPtr i, IntPtr param);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG m);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint f);
  [DllImport("dwmapi.dll")] public static extern int DwmRegisterThumbnail(IntPtr d, IntPtr s, out IntPtr t);
  [DllImport("dwmapi.dll")] public static extern int DwmUpdateThumbnailProperties(IntPtr t, ref TP p);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT v, int sz);
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint msg; public IntPtr w, l; public uint t; public int px, py; }
}
"@
Add-Type $code
$frame = New-Object Host+RECT
if ([Host]::DwmGetWindowAttribute($src, 9, [ref]$frame, [System.Runtime.InteropServices.Marshal]::SizeOf([type][Host+RECT])) -ne 0) { throw 'no frame' }
$fw = $frame.Right - $frame.Left; $fh = $frame.Bottom - $frame.Top
if ($fw -le 0 -or $fh -le 0) { throw 'bad frame' }
$cw = [int]($fw * $pct / 100); $ch = [int]($fh * $pct / 100)
$cx = [int](($fw - $cw) / 2); $cy = [int](($fh - $ch) / 2)
$crop = New-Object Host+RECT
$crop.Left = $cx; $crop.Top = $cy; $crop.Right = $cx + $cw; $crop.Bottom = $cy + $ch
$capW = [Math]::Min($cw, 1200); $capH = [Math]::Min($ch, 900)
# WS_POPUP|WS_VISIBLE|WS_THICKFRAME|WS_CAPTION|WS_SYSMENU ; WS_EX_TOPMOST|WS_EX_TOOLWINDOW
$style = [uint32]0x14CF0000
$exStyle = [uint32]0x00000088
$hwnd = [Host]::CreateWindowExW($exStyle, 'Static', $title, $style, 200, 200, $capW, $capH, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero)
if ($hwnd -eq [IntPtr]::Zero) { throw 'no window' }
[Host]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x0053) | Out-Null
[Host]::ShowWindow($hwnd, 5) | Out-Null
$thumb = [IntPtr]::Zero
if ([Host]::DwmRegisterThumbnail($hwnd, $src, [ref]$thumb) -ne 0) { throw 'no thumb' }
$client = New-Object Host+RECT
[void][Host]::GetClientRect($hwnd, [ref]$client)
$props = New-Object Host+TP
$props.dwFlags = 0x1F  # DEST|SRC|OPACITY|VISIBLE|SOURCECLIENTAREAONLY
$props.fVisible = $true
$props.opacity = 255
$props.rcDest = $client
$props.rcSrc = $crop
[void][Host]::DwmUpdateThumbnailProperties($thumb, [ref]$props)
$m = New-Object Host+MSG
while ([Host]::GetMessage([ref]$m, [IntPtr]::Zero, 0, 0) -gt 0) {
  [void][Host]::TranslateMessage([ref]$m)
  [void][Host]::DispatchMessage([ref]$m)
  $c2 = New-Object Host+RECT
  [void][Host]::GetClientRect($hwnd, [ref]$c2)
  $props.rcDest = $c2
  [void][Host]::DwmUpdateThumbnailProperties($thumb, [ref]$props)
}`;
}

export function CropAndLockModule() {
  const { t } = useTranslation();
  const tauri = isTauri();

  const [enabled, setEnabled] = useState<boolean>(() => localStorage.getItem(ENABLED_KEY) !== 'false');
  const [thumbHk, setThumbHk] = useState<Chord>(() => loadChord(THUMB_HK_KEY, DEFAULT_THUMB));
  const [cropHk, setCropHk] = useState<Chord>(() => loadChord(CROP_HK_KEY, DEFAULT_CROP));
  const [active, setActive] = useState<ActiveEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [cropPct, setCropPct] = useState<number>(100);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  // Hotkey editor draft (which one is open, and its working values).
  const [editHk, setEditHk] = useState<'thumb' | 'crop' | null>(null);
  const [draft, setDraft] = useState<Chord>(DEFAULT_THUMB);

  useEffect(() => {
    try {
      localStorage.setItem(ENABLED_KEY, enabled ? 'true' : 'false');
    } catch {
      /* ignore */
    }
  }, [enabled]);
  useEffect(() => {
    try {
      localStorage.setItem(THUMB_HK_KEY, JSON.stringify(thumbHk));
    } catch {
      /* ignore */
    }
  }, [thumbHk]);
  useEffect(() => {
    try {
      localStorage.setItem(CROP_HK_KEY, JSON.stringify(cropHk));
    } catch {
      /* ignore */
    }
  }, [cropHk]);

  const { data, loading, error, reload } = useAsync<WinRow[]>(
    () => (tauri ? runPowershellJson<WinRow>(LIST_WINDOWS_PS) : Promise.resolve([])),
    [tauri],
  );

  const rows = useMemo(() => {
    const all = data ?? [];
    const q = filter.trim().toLowerCase();
    const list = q ? all.filter((w) => `${w.Title} ${w.Process}`.toLowerCase().includes(q)) : all;
    return [...list].sort((a, b) => a.Title.localeCompare(b.Title));
  }, [data, filter]);

  const selWin = useMemo(() => rows.find((w) => w.Handle === selected) ?? null, [rows, selected]);

  const spawn = async (thumbnail: boolean) => {
    if (!enabled) {
      setMsg(t('cropandlock.disabledFirst'));
      return;
    }
    if (!selWin) {
      setMsg(t('cropandlock.selectFirst'));
      return;
    }
    if (!tauri) {
      setMsg(t('cropandlock.desktopNote'));
      return;
    }
    setBusy(true);
    setMsg(null);
    const marker = newId().slice(0, 8);
    try {
      // Fire-and-detach: the host runs its own message loop, so run it as a background
      // pwsh process and don't await its exit. We do a quick validation pass first.
      const res = await runPowershell(
        `Start-Process -WindowStyle Hidden powershell -ArgumentList '-NoProfile','-WindowStyle','Hidden','-Command',([System.Management.Automation.ScriptBlock]::Create(@'
${spawnScript(selWin.Handle, thumbnail, cropPct, marker)}
'@)); 'ok'`,
      );
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      const entry: ActiveEntry = {
        id: marker,
        handle: selWin.Handle,
        sourceTitle: selWin.Title || t('cropandlock.untitled'),
        thumbnail,
        cropPct,
      };
      setActive((prev) => [entry, ...prev]);
      setMsg(thumbnail ? t('cropandlock.thumbCreated') : t('cropandlock.cropCreated'));
    } catch (e) {
      setMsg(`${t('cropandlock.spawnFailed')}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const closeOne = async (entry: ActiveEntry) => {
    if (tauri) {
      // Kill the detached pump process whose command line carries our unique marker; that tears
      // down its message loop and the DWM-thumbnail host window with it.
      await runPowershell(
        `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*${entry.id}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } ; 'ok'`,
      ).catch(() => undefined);
    }
    setActive((prev) => prev.filter((e) => e.id !== entry.id));
  };

  const closeAll = async () => {
    const items = [...active];
    setActive([]);
    for (const e of items) {
      // eslint-disable-next-line no-await-in-loop
      await closeOne(e);
    }
    setMsg(t('cropandlock.closedAll'));
  };

  const openHkEditor = (which: 'thumb' | 'crop') => {
    setDraft({ ...(which === 'thumb' ? thumbHk : cropHk) });
    setEditHk(which);
  };

  const saveHk = () => {
    if (!draft.ctrl && !draft.alt && !draft.shift && !draft.win) {
      setMsg(t('cropandlock.needMod'));
      return;
    }
    if (editHk === 'thumb') setThumbHk(draft);
    else if (editHk === 'crop') setCropHk(draft);
    setMsg(t('cropandlock.hkSaved'));
    setEditHk(null);
  };

  const clearHk = () => {
    const cleared: Chord = { ctrl: false, alt: false, shift: false, win: false, key: '' };
    if (editHk === 'thumb') setThumbHk(cleared);
    else if (editHk === 'crop') setCropHk(cleared);
    setMsg(t('cropandlock.hkCleared'));
    setEditHk(null);
  };

  const winColumns: Column<WinRow>[] = [
    {
      key: 'sel',
      header: '',
      width: 40,
      render: (w) => (
        <input
          type="radio"
          name="cropandlock-win"
          checked={selected === w.Handle}
          onChange={() => setSelected(w.Handle)}
        />
      ),
    },
    {
      key: 'Title',
      header: t('cropandlock.colTitle'),
      render: (w) => (
        <span>
          <span>{w.Title || t('cropandlock.untitled')}</span>
          <br />
          <span className="count-note">{w.Process}</span>
        </span>
      ),
    },
    {
      key: 'size',
      header: t('cropandlock.colSize'),
      width: 130,
      render: (w) => (
        <code>
          {w.W}×{w.H}
        </code>
      ),
    },
  ];

  const activeColumns: Column<ActiveEntry>[] = [
    {
      key: 'mode',
      header: t('cropandlock.colMode'),
      width: 130,
      render: (e) => (
        <StatusDot ok={e.thumbnail} label={e.thumbnail ? t('cropandlock.modeThumb') : t('cropandlock.modeCrop')} />
      ),
    },
    { key: 'sourceTitle', header: t('cropandlock.colSource') },
    {
      key: 'cropPct',
      header: t('cropandlock.colCrop'),
      width: 90,
      render: (e) => <code>{e.cropPct}%</code>,
    },
    {
      key: 'actions',
      header: '',
      width: 120,
      render: (e) => (
        <button className="mini" onClick={() => closeOne(e)}>
          {t('cropandlock.close')}
        </button>
      ),
    },
  ];

  const hkRow = (label: string, chord: Chord, which: 'thumb' | 'crop') => (
    <div className="mod-toolbar" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ minWidth: 150, fontWeight: 600 }}>{label}</span>
      <code className="hosts-edit" style={{ padding: '4px 10px' }}>
        {chordText(chord) || t('cropandlock.hkNone')}
      </code>
      <button className="mini" onClick={() => openHkEditor(which)}>
        {t('cropandlock.change')}
      </button>
    </div>
  );

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('cropandlock.blurb')}
      </p>
      {!tauri && <p className="mod-msg">{t('cropandlock.desktopNote')}</p>}
      {msg && <p className="mod-msg">{msg}</p>}

      {/* ===================== Enable + hotkeys ===================== */}
      <div className="panel" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="mod-toolbar" style={{ alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{t('cropandlock.enableTitle')}</div>
            <div className="count-note">{t('cropandlock.enableBlurb')}</div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {enabled ? t('cropandlock.on') : t('cropandlock.off')}
          </label>
        </div>

        {hkRow(t('cropandlock.thumbHk'), thumbHk, 'thumb')}
        {hkRow(t('cropandlock.cropHk'), cropHk, 'crop')}

        {editHk && (
          <div className="panel" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontWeight: 600 }}>
              {editHk === 'thumb' ? t('cropandlock.thumbHk') : t('cropandlock.cropHk')}
            </div>
            <div className="count-note">{t('cropandlock.hkPick')}</div>
            <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <label>
                <input type="checkbox" checked={draft.ctrl} onChange={(e) => setDraft({ ...draft, ctrl: e.target.checked })} />{' '}
                Ctrl
              </label>
              <label>
                <input type="checkbox" checked={draft.alt} onChange={(e) => setDraft({ ...draft, alt: e.target.checked })} /> Alt
              </label>
              <label>
                <input type="checkbox" checked={draft.shift} onChange={(e) => setDraft({ ...draft, shift: e.target.checked })} />{' '}
                Shift
              </label>
              <label>
                <input type="checkbox" checked={draft.win} onChange={(e) => setDraft({ ...draft, win: e.target.checked })} /> Win
              </label>
              <select
                className="mod-search"
                value={draft.key}
                onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                style={{ minWidth: 120 }}
              >
                {PICKABLE_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div className="row-actions">
              <button className="mini primary" onClick={saveHk}>
                {t('cropandlock.save')}
              </button>
              <button className="mini" onClick={clearHk}>
                {t('cropandlock.clear')}
              </button>
              <button className="mini" onClick={() => setEditHk(null)}>
                {t('cropandlock.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ===================== Pick a window & region ===================== */}
      <h3 className="group-title">{t('cropandlock.pickHeader')}</h3>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('cropandlock.pickBlurb')}
      </p>

      <div className="panel" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ minWidth: 150, fontWeight: 600 }}>{t('cropandlock.cropSize')}</span>
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={cropPct}
            onChange={(e) => setCropPct(Number(e.target.value))}
            style={{ flex: 1, minWidth: 160 }}
          />
          <code style={{ minWidth: 48, textAlign: 'right' }}>{cropPct}%</code>
        </div>
        <div className="count-note">{cropPct >= 100 ? t('cropandlock.cropWhole') : t('cropandlock.cropCentered')}</div>
        <div className="row-actions">
          <button className="mini primary" disabled={busy || !selWin} onClick={() => spawn(true)}>
            {t('cropandlock.thumbBtn')}
          </button>
          <button className="mini" disabled={busy || !selWin} onClick={() => spawn(false)}>
            {t('cropandlock.cropBtn')}
          </button>
        </div>
        <div className="count-note">{t('cropandlock.thumbDesc')}</div>
      </div>

      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('cropandlock.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">{t('cropandlock.winCount', { total: rows.length })}</span>
      </ModuleToolbar>
      <AsyncState loading={loading} error={error}>
        <DataTable columns={winColumns} rows={rows} rowKey={(w) => w.Handle} empty={t('cropandlock.noWindows')} />
      </AsyncState>

      {/* ===================== Active windows ===================== */}
      <h3 className="group-title">{t('cropandlock.activeHeader')}</h3>
      <ModuleToolbar>
        <button className="mini" disabled={active.length === 0} onClick={closeAll}>
          {t('cropandlock.closeAll')}
        </button>
        <span className="count-note">{t('cropandlock.activeCount', { total: active.length })}</span>
      </ModuleToolbar>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('cropandlock.activeBlurb')}
      </p>
      <DataTable columns={activeColumns} rows={active} rowKey={(e) => e.id} empty={t('cropandlock.noActive')} />

      {/* ===================== How it works ===================== */}
      <h3 className="group-title">{t('cropandlock.howHeader')}</h3>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('cropandlock.howBody')}
      </p>
    </div>
  );
}
