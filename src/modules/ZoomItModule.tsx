import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, type CommandOutput } from '../tauri/bridge';

// Native module — ZoomIt clone (screen zoom, freehand/shape annotation, break-timer
// countdown) built on a pure-Win32 GDI overlay + global hotkeys in the WinForge desktop
// backend. The live overlay is native GDI and cannot run in a browser, so this control page
// edits the same persisted settings the desktop backend reads: the three global-hotkey chords
// (Ctrl+1 zoom / Ctrl+2 draw / Ctrl+3 break by default), the default pen colour & width, and
// the break length. Settings live in %LOCALAPPDATA%\WinForge\settings.json, so writes here are
// picked up by the desktop overlay. All live reads/writes are gated on isTauri().

// HotMod flags mirror the native HotMod enum used by RegisterHotKey (MOD_ALT=1, MOD_CONTROL=2,
// MOD_SHIFT=4, MOD_WIN=8).
const MOD_ALT = 1;
const MOD_CONTROL = 2;
const MOD_SHIFT = 4;
const MOD_WIN = 8;

// settings.json keys, identical to the native ZoomItService constants.
const K = {
  zoomMods: 'zoomit.zoom.mods',
  zoomVk: 'zoomit.zoom.vk',
  drawMods: 'zoomit.draw.mods',
  drawVk: 'zoomit.draw.vk',
  breakMods: 'zoomit.break.mods',
  breakVk: 'zoomit.break.vk',
  penColor: 'zoomit.pen.color',
  penWidth: 'zoomit.pen.width',
  breakMinutes: 'zoomit.break.minutes',
} as const;

// pen palette: (i18n key suffix, 0xRRGGBB, css hex) — mirrors the native Palette.
const PALETTE: { key: string; rgb: number; css: string }[] = [
  { key: 'red', rgb: 0xff0000, css: '#ff0000' },
  { key: 'green', rgb: 0x00c000, css: '#00c000' },
  { key: 'blue', rgb: 0x0078d4, css: '#0078d4' },
  { key: 'orange', rgb: 0xff8c00, css: '#ff8c00' },
  { key: 'yellow', rgb: 0xffd400, css: '#ffd400' },
  { key: 'white', rgb: 0xffffff, css: '#ffffff' },
  { key: 'black', rgb: 0x000000, css: '#000000' },
];

// keys the native PickableKeys picker offers, kept simple: digits, letters, F-keys, Space.
const KEY_OPTIONS: { name: string; vk: number }[] = (() => {
  const out: { name: string; vk: number }[] = [];
  for (let d = 0; d <= 9; d++) out.push({ name: String(d), vk: 0x30 + d });
  for (let c = 0; c < 26; c++) out.push({ name: String.fromCharCode(65 + c), vk: 0x41 + c });
  for (let f = 1; f <= 12; f++) out.push({ name: `F${f}`, vk: 0x6f + f });
  out.push({ name: 'Space', vk: 0x20 });
  return out;
})();

function vkName(vk: number): string {
  const hit = KEY_OPTIONS.find((k) => k.vk === vk);
  return hit ? hit.name : `0x${vk.toString(16).toUpperCase()}`;
}

function chordText(mods: number, vk: number): string {
  const parts: string[] = [];
  if (mods & MOD_CONTROL) parts.push('Ctrl');
  if (mods & MOD_ALT) parts.push('Alt');
  if (mods & MOD_SHIFT) parts.push('Shift');
  if (mods & MOD_WIN) parts.push('Win');
  parts.push(vkName(vk));
  return parts.join(' + ');
}

function indexOfColor(rgb: number): number {
  const i = PALETTE.findIndex((c) => c.rgb === rgb);
  return i < 0 ? 0 : i;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// one hotkey chord's editable state.
interface Chord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  win: boolean;
  vk: number;
}

function modsOf(c: Chord): number {
  return (c.ctrl ? MOD_CONTROL : 0) | (c.alt ? MOD_ALT : 0) | (c.shift ? MOD_SHIFT : 0) | (c.win ? MOD_WIN : 0);
}
function chordFrom(mods: number, vk: number): Chord {
  return {
    ctrl: (mods & MOD_CONTROL) !== 0,
    alt: (mods & MOD_ALT) !== 0,
    shift: (mods & MOD_SHIFT) !== 0,
    win: (mods & MOD_WIN) !== 0,
    vk,
  };
}

interface Settings {
  zoom: Chord;
  draw: Chord;
  break: Chord;
  colorIdx: number;
  penWidth: number;
  breakMinutes: number;
}

const DEFAULTS: Settings = {
  zoom: chordFrom(MOD_CONTROL, 0x31),
  draw: chordFrom(MOD_CONTROL, 0x32),
  break: chordFrom(MOD_CONTROL, 0x33),
  colorIdx: indexOfColor(0xff0000),
  penWidth: 6,
  breakMinutes: 10,
};

const esc = (s: string) => s.replace(/'/g, "''");

// PowerShell that reads %LOCALAPPDATA%\WinForge\settings.json and echoes the ZoomIt values as
// simple `key=value` lines (missing keys are simply absent). Never throws.
function readScript(): string {
  return (
    `$p=Join-Path $env:LOCALAPPDATA 'WinForge\\settings.json'; ` +
    `if(Test-Path $p){ try{ $j=Get-Content -Raw -LiteralPath $p | ConvertFrom-Json } catch { $j=$null } } else { $j=$null } ` +
    `$keys=@('${Object.values(K).map(esc).join("','")}'); ` +
    `foreach($k in $keys){ if($j -and ($j.PSObject.Properties.Name -contains $k)){ $v=$j.$k } else { $v=$null } ` +
    `if($null -ne $v){ Write-Output ("{0}={1}" -f $k,$v) } }`
  );
}

// PowerShell that merges the given key/value pairs into settings.json, creating the folder/file
// if needed. `pairs` is pre-escaped `key=value` entries. Never throws; prints OK on success.
function writeScript(pairs: [string, string][]): string {
  const hashBody = pairs.map(([k, v]) => `'${esc(k)}'='${esc(v)}'`).join(';');
  return (
    `$dir=Join-Path $env:LOCALAPPDATA 'WinForge'; ` +
    `$p=Join-Path $dir 'settings.json'; ` +
    `if(-not (Test-Path $dir)){ New-Item -ItemType Directory -Force -Path $dir | Out-Null } ` +
    `$map=@{}; ` +
    `if(Test-Path $p){ try{ $j=Get-Content -Raw -LiteralPath $p | ConvertFrom-Json; ` +
    `foreach($pr in $j.PSObject.Properties){ $map[$pr.Name]=[string]$pr.Value } } catch {} } ` +
    `$upd=@{${hashBody}}; ` +
    `foreach($k in $upd.Keys){ $map[$k]=[string]$upd[$k] } ` +
    `($map | ConvertTo-Json -Depth 3) | Set-Content -LiteralPath $p -Encoding UTF8; ` +
    `Write-Output 'OK'`
  );
}

function parseKv(stdout: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    m.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  return m;
}

function toInt(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function settingsFromKv(kv: Map<string, string>): Settings {
  const zoomMods = toInt(kv.get(K.zoomMods), MOD_CONTROL);
  const zoomVk = toInt(kv.get(K.zoomVk), 0x31);
  const drawMods = toInt(kv.get(K.drawMods), MOD_CONTROL);
  const drawVk = toInt(kv.get(K.drawVk), 0x32);
  const breakMods = toInt(kv.get(K.breakMods), MOD_CONTROL);
  const breakVk = toInt(kv.get(K.breakVk), 0x33);
  const color = toInt(kv.get(K.penColor), 0xff0000);
  const width = clamp(toInt(kv.get(K.penWidth), 6), 1, 60);
  const minutes = clamp(toInt(kv.get(K.breakMinutes), 10), 1, 240);
  return {
    zoom: chordFrom(zoomMods, zoomVk),
    draw: chordFrom(drawMods, drawVk),
    break: chordFrom(breakMods, breakVk),
    colorIdx: indexOfColor(color),
    penWidth: width,
    breakMinutes: minutes,
  };
}

export function ZoomItModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    (async () => {
      setBusy('load');
      setErr(null);
      try {
        const res: CommandOutput = await runPowershell(readScript());
        if (!alive) return;
        setSettings(settingsFromKv(parseKv(res.stdout)));
      } catch (e) {
        if (alive) setErr(String(e instanceof Error ? e.message : e));
      } finally {
        if (alive) setBusy('');
      }
    })();
    return () => {
      alive = false;
    };
  }, [desktop]);

  const setChord = (mode: 'zoom' | 'draw' | 'break', patch: Partial<Chord>) => {
    setSettings((s) => ({ ...s, [mode]: { ...s[mode], ...patch } }));
  };

  const validate = (): string | null => {
    const chords: Chord[] = [settings.zoom, settings.draw, settings.break];
    if (chords.some((c) => c.vk === 0)) return t('zoomit.errNoKey');
    const sig = (c: Chord) => `${modsOf(c)}:${c.vk}`;
    const sigs = chords.map(sig);
    if (new Set(sigs).size !== sigs.length) return t('zoomit.errConflict');
    return null;
  };

  const save = async () => {
    if (!desktop) return;
    const problem = validate();
    if (problem) {
      setErr(problem);
      setStatus(null);
      return;
    }
    setBusy('save');
    setErr(null);
    setStatus(null);
    const color = PALETTE[settings.colorIdx];
    const rgb = color ? color.rgb : 0xff0000;
    const pairs: [string, string][] = [
      [K.zoomMods, String(modsOf(settings.zoom))],
      [K.zoomVk, String(settings.zoom.vk)],
      [K.drawMods, String(modsOf(settings.draw))],
      [K.drawVk, String(settings.draw.vk)],
      [K.breakMods, String(modsOf(settings.break))],
      [K.breakVk, String(settings.break.vk)],
      [K.penColor, String(rgb >>> 0)],
      [K.penWidth, String(clamp(settings.penWidth, 1, 60))],
      [K.breakMinutes, String(clamp(settings.breakMinutes, 1, 240))],
    ];
    try {
      const res = await runPowershell(writeScript(pairs));
      if (!res.success && !res.stdout.includes('OK')) {
        throw new Error(res.stderr.trim() || `exit ${res.code}`);
      }
      setStatus(
        t('zoomit.savedDetail', {
          zoom: chordText(modsOf(settings.zoom), settings.zoom.vk),
          draw: chordText(modsOf(settings.draw), settings.draw.vk),
          brk: chordText(modsOf(settings.break), settings.break.vk),
        }),
      );
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const resetDefaults = () => {
    setSettings(DEFAULTS);
    setStatus(null);
    setErr(null);
  };

  const chordRow = (mode: 'zoom' | 'draw' | 'break', label: string) => {
    const c = settings[mode];
    return (
      <div className="kv-row" key={mode}>
        <span className="label">{label}</span>
        <span className="value" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <label className="chk">
            <input type="checkbox" checked={c.ctrl} onChange={(e) => setChord(mode, { ctrl: e.target.checked })} /> Ctrl
          </label>
          <label className="chk">
            <input type="checkbox" checked={c.alt} onChange={(e) => setChord(mode, { alt: e.target.checked })} /> Alt
          </label>
          <label className="chk">
            <input type="checkbox" checked={c.shift} onChange={(e) => setChord(mode, { shift: e.target.checked })} /> Shift
          </label>
          <label className="chk">
            <input type="checkbox" checked={c.win} onChange={(e) => setChord(mode, { win: e.target.checked })} /> Win
          </label>
          <select
            className="mod-select"
            value={c.vk}
            onChange={(e) => setChord(mode, { vk: Number(e.target.value) })}
          >
            {KEY_OPTIONS.map((k) => (
              <option key={k.vk} value={k.vk}>
                {k.name}
              </option>
            ))}
          </select>
          <span className="count-note" style={{ fontFamily: 'monospace' }}>
            {chordText(modsOf(c), c.vk)}
          </span>
        </span>
      </div>
    );
  };

  const swatch = PALETTE[settings.colorIdx];

  return (
    <div className="mod">
      <p className="count-note">{t('zoomit.blurb')}</p>
      {!desktop && <p className="count-note" style={{ color: 'var(--danger)' }}>{t('zoomit.desktopOnly')}</p>}

      {/* ---- Start a mode (overlay is native; the desktop backend owns it) ---- */}
      <div className="panel">
        <div className="dt-wrap">
          <p className="label">{t('zoomit.startHeader')}</p>
          <p className="count-note">{t('zoomit.startBlurb')}</p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <span className="count-note">
              {t('zoomit.hkZoom')}: <b style={{ fontFamily: 'monospace' }}>{chordText(modsOf(settings.zoom), settings.zoom.vk)}</b>
            </span>
            <span className="count-note">
              {t('zoomit.hkDraw')}: <b style={{ fontFamily: 'monospace' }}>{chordText(modsOf(settings.draw), settings.draw.vk)}</b>
            </span>
            <span className="count-note">
              {t('zoomit.hkBreak')}: <b style={{ fontFamily: 'monospace' }}>{chordText(modsOf(settings.break), settings.break.vk)}</b>
            </span>
          </div>
          <p className="count-note">{t('zoomit.startNote')}</p>
        </div>
      </div>

      {/* ---- Global hotkeys ---- */}
      <div className="panel">
        <div className="kv-list">
          <p className="label">{t('zoomit.hotkeyHeader')}</p>
          {chordRow('zoom', t('zoomit.hkZoom'))}
          {chordRow('draw', t('zoomit.hkDraw'))}
          {chordRow('break', t('zoomit.hkBreak'))}
        </div>
      </div>

      {/* ---- Pen & break defaults ---- */}
      <div className="panel">
        <div className="kv-list">
          <p className="label">{t('zoomit.defaultsHeader')}</p>
          <div className="kv-row">
            <span className="label">{t('zoomit.penColor')}</span>
            <span className="value" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <select
                className="mod-select"
                value={settings.colorIdx}
                onChange={(e) => setSettings((s) => ({ ...s, colorIdx: Number(e.target.value) }))}
              >
                {PALETTE.map((c, i) => (
                  <option key={c.key} value={i}>
                    {t(`zoomit.color_${c.key}`)}
                  </option>
                ))}
              </select>
              <span
                aria-hidden="true"
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 3,
                  border: '1px solid var(--border, #888)',
                  background: swatch ? swatch.css : '#ff0000',
                  display: 'inline-block',
                }}
              />
            </span>
          </div>
          <div className="kv-row">
            <span className="label">{t('zoomit.penWidth')}</span>
            <span className="value">
              <input
                className="mod-search"
                type="number"
                min={1}
                max={60}
                style={{ maxWidth: 90 }}
                value={settings.penWidth}
                onChange={(e) => setSettings((s) => ({ ...s, penWidth: clamp(Math.trunc(+e.target.value) || 1, 1, 60) }))}
              />
            </span>
          </div>
          <div className="kv-row">
            <span className="label">{t('zoomit.breakMinutes')}</span>
            <span className="value">
              <input
                className="mod-search"
                type="number"
                min={1}
                max={240}
                style={{ maxWidth: 90 }}
                value={settings.breakMinutes}
                onChange={(e) => setSettings((s) => ({ ...s, breakMinutes: clamp(Math.trunc(+e.target.value) || 1, 1, 240) }))}
              />
            </span>
          </div>
        </div>
        <div className="mod-toolbar">
          <button className="mini primary" disabled={!desktop || !!busy} onClick={save}>
            {busy === 'save' ? t('zoomit.saving') : t('zoomit.save')}
          </button>
          <button className="mini" disabled={!!busy} onClick={resetDefaults}>
            {t('zoomit.resetDefaults')}
          </button>
          {busy === 'load' && <span className="count-note">{t('zoomit.loading')}</span>}
        </div>
      </div>

      {err && <p className="error">{err}</p>}
      {status && <p className="count-note dep-ok">{status}</p>}

      {/* ---- How to use ---- */}
      <div className="panel">
        <div className="kv-list">
          <p className="label">{t('zoomit.helpHeader')}</p>
          <p className="count-note">{t('zoomit.helpZoom')}</p>
          <p className="count-note">{t('zoomit.helpDraw')}</p>
          <p className="count-note">{t('zoomit.helpBreak')}</p>
          <p className="count-note">{t('zoomit.helpKeys')}</p>
        </div>
      </div>
    </div>
  );
}
