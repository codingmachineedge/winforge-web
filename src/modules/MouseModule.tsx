import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAsync, AsyncState, ModuleToolbar, StatusDot } from './common';
import { runPowershell, runPowershellJson, isTauri } from '../tauri/bridge';

// Port of WinForge Pages/MouseModule + Services/MouseSettings: native mouse &
// pointer settings that apply instantly via SystemParametersInfo and persist
// (SPIF_UPDATEINIFILE | SPIF_SENDCHANGE) — no ms-settings redirect.

interface MouseCfg {
  swap: boolean;
  speed: number; // 1–20
  accel: boolean;
  doubleClick: number; // ms, 100–900
  wheelLines: number; // 1–15
  vanish: boolean;
  snap: boolean;
}

const HELPER = `
Add-Type -Name WfMouse -Namespace Wf -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true)]
public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref uint pvParam, uint fWinIni);
[DllImport("user32.dll", SetLastError=true)]
public static extern bool SystemParametersInfoMouse(uint uiAction, uint uiParam, int[] pvParam, uint fWinIni);
[DllImport("user32.dll", EntryPoint="SystemParametersInfo", SetLastError=true)]
public static extern bool SpiSetInt(uint uiAction, uint uiParam, System.IntPtr pvParam, uint fWinIni);
[DllImport("user32.dll", EntryPoint="SystemParametersInfo", SetLastError=true)]
public static extern bool SpiGetMouse(uint uiAction, uint uiParam, int[] pvParam, uint fWinIni);
[DllImport("user32.dll", EntryPoint="SystemParametersInfo", SetLastError=true)]
public static extern bool SpiSetMouse(uint uiAction, uint uiParam, int[] pvParam, uint fWinIni);
[DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
[DllImport("user32.dll")] public static extern bool SwapMouseButton(bool fSwap);
[DllImport("user32.dll")] public static extern uint GetDoubleClickTime();
[DllImport("user32.dll")] public static extern bool SetDoubleClickTime(uint uInterval);
'@
`;

const READ_PS = `
${HELPER}
$speed = [uint32]0; [void][Wf.WfMouse]::SystemParametersInfo(0x0070, 0, [ref]$speed, 0)
$wheel = [uint32]0; [void][Wf.WfMouse]::SystemParametersInfo(0x0068, 0, [ref]$wheel, 0)
$vanish = [uint32]0; [void][Wf.WfMouse]::SystemParametersInfo(0x1020, 0, [ref]$vanish, 0)
$snap = [uint32]0; [void][Wf.WfMouse]::SystemParametersInfo(0x005F, 0, [ref]$snap, 0)
$m = @(0,0,0); [void][Wf.WfMouse]::SpiGetMouse(0x0003, 0, $m, 0)
[pscustomobject]@{
  swap        = [bool]([Wf.WfMouse]::GetSystemMetrics(23))
  speed       = [int]$speed
  accel       = ($m[2] -ne 0)
  doubleClick = [int][Wf.WfMouse]::GetDoubleClickTime()
  wheelLines  = [int]$wheel
  vanish      = ($vanish -ne 0)
  snap        = ($snap -ne 0)
} | ConvertTo-Json
`;

// fWinIni = 3 → SPIF_UPDATEINIFILE | SPIF_SENDCHANGE (persist + broadcast).
const SETTERS: Record<keyof MouseCfg, (v: boolean | number) => string> = {
  swap: (v) => `${HELPER}\n[void][Wf.WfMouse]::SwapMouseButton($${v ? 'true' : 'false'})\nSet-ItemProperty 'HKCU:\\Control Panel\\Mouse' SwapMouseButtons '${v ? 1 : 0}'`,
  speed: (v) => `${HELPER}\n[void][Wf.WfMouse]::SpiSetInt(0x0071, 0, [System.IntPtr]${Number(v)}, 3)`,
  accel: (v) => `${HELPER}\n$m = @(${v ? '6,10,1' : '0,0,0'})\n[void][Wf.WfMouse]::SpiSetMouse(0x0004, 0, $m, 3)`,
  doubleClick: (v) => `${HELPER}\n[void][Wf.WfMouse]::SetDoubleClickTime(${Number(v)})\nSet-ItemProperty 'HKCU:\\Control Panel\\Mouse' DoubleClickSpeed '${Number(v)}'`,
  wheelLines: (v) => `${HELPER}\n[void][Wf.WfMouse]::SpiSetInt(0x0069, ${Number(v)}, [System.IntPtr]::Zero, 3)`,
  vanish: (v) => `${HELPER}\n[void][Wf.WfMouse]::SpiSetInt(0x1021, ${v ? 1 : 0}, [System.IntPtr]::Zero, 3)`,
  snap: (v) => `${HELPER}\n[void][Wf.WfMouse]::SpiSetInt(0x0060, ${v ? 1 : 0}, [System.IntPtr]::Zero, 3)`,
};

export function MouseModule() {
  const { t } = useTranslation();
  const live = isTauri();
  const [cfg, setCfg] = useState<MouseCfg | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const state = useAsync(async () => {
    if (!live) return null;
    const rows = await runPowershellJson<MouseCfg>(READ_PS);
    return rows[0] ?? null;
  }, [live]);

  useEffect(() => {
    if (state.data) setCfg(state.data);
  }, [state.data]);

  const apply = (key: keyof MouseCfg, value: boolean | number, debounced = false) => {
    setCfg((c) => (c ? { ...c, [key]: value } : c));
    if (!live) return;
    const run = () => {
      runPowershell(SETTERS[key](value)).then(
        (r) => setApplyError(r.success ? null : r.stderr || r.stdout),
        (e) => setApplyError(String(e)),
      );
    };
    if (debounce.current) clearTimeout(debounce.current);
    if (debounced) debounce.current = setTimeout(run, 300);
    else run();
  };

  const row = (label: string, desc: string, control: JSX.Element) => (
    <div className="panel" style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 10 }}>
      <div style={{ flex: 1 }}>
        <strong>{label}</strong>
        <div className="count-note" style={{ margin: 0 }}>{desc}</div>
      </div>
      {control}
    </div>
  );

  const toggle = (key: keyof MouseCfg) => (
    <button
      className={`mini${cfg?.[key] ? ' primary' : ''}`}
      onClick={() => apply(key, !cfg?.[key])}
      aria-pressed={Boolean(cfg?.[key])}
      disabled={!cfg}
    >
      {cfg?.[key] ? t('mouse.on') : t('mouse.off')}
    </button>
  );

  const slider = (key: keyof MouseCfg, min: number, max: number, unit: string) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <input
        type="range"
        min={min}
        max={max}
        value={Number(cfg?.[key] ?? min)}
        onChange={(e) => apply(key, Number(e.target.value), true)}
        disabled={!cfg}
      />
      <span style={{ minWidth: 64, textAlign: 'right' }}>{String(cfg?.[key] ?? '—')}{unit}</span>
    </span>
  );

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini" onClick={state.reload}>{t('mouse.refresh')}</button>
        <StatusDot ok={live} label={live ? t('mouse.live') : t('mouse.preview')} />
      </ModuleToolbar>
      <p className="count-note">{t('mouse.blurb')}</p>
      {applyError && <pre className="cmd-out error">{applyError}</pre>}
      {live ? (
        <AsyncState loading={state.loading} error={state.error}>
          {row(t('mouse.swap'), t('mouse.swapDesc'), toggle('swap'))}
          {row(t('mouse.speed'), t('mouse.speedDesc'), slider('speed', 1, 20, ' / 20'))}
          {row(t('mouse.accel'), t('mouse.accelDesc'), toggle('accel'))}
          {row(t('mouse.doubleClick'), t('mouse.doubleClickDesc'), slider('doubleClick', 100, 900, ' ms'))}
          {row(t('mouse.wheelLines'), t('mouse.wheelLinesDesc'), slider('wheelLines', 1, 15, ''))}
          {row(t('mouse.vanish'), t('mouse.vanishDesc'), toggle('vanish'))}
          {row(t('mouse.snap'), t('mouse.snapDesc'), toggle('snap'))}
        </AsyncState>
      ) : (
        <p className="count-note">{t('mouse.previewNote')}</p>
      )}
    </div>
  );
}
