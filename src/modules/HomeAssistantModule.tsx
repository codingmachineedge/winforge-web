import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell } from '../tauri/bridge';
import { Column, DataTable, ModuleToolbar, StatusDot } from './common';

// ── Config persistence (browser-native; base URL + long-lived token) ──────────
// The token is never written to storage in plaintext: it is base64-obfuscated on
// save and decoded on load (with a one-time migration for any legacy plaintext
// value). The desktop build uses DPAPI; the browser cannot, so obfuscation plus a
// masked input is the best available. The token is never logged or shown unmasked.
const URL_KEY = 'winforge.ha.baseUrl';
const TOKEN_KEY = 'winforge.ha.token'; // legacy plaintext key (migrated away)
const TOKEN_ENC_KEY = 'winforge.ha.token.enc'; // base64-obfuscated token

function encTok(s: string): string {
  if (!s) return '';
  try {
    return btoa(unescape(encodeURIComponent(s)));
  } catch {
    return '';
  }
}

function decTok(s: string): string {
  if (!s) return '';
  try {
    return decodeURIComponent(escape(atob(s)));
  } catch {
    return '';
  }
}

function loadCfg(): { url: string; token: string } {
  try {
    const url = localStorage.getItem(URL_KEY) ?? '';
    const enc = localStorage.getItem(TOKEN_ENC_KEY) ?? '';
    if (enc) return { url, token: decTok(enc) };
    // Migrate a legacy plaintext token to the obfuscated key, then scrub it.
    const legacy = localStorage.getItem(TOKEN_KEY) ?? '';
    if (legacy) {
      try {
        localStorage.setItem(TOKEN_ENC_KEY, encTok(legacy));
        localStorage.removeItem(TOKEN_KEY);
      } catch {
        /* ignore */
      }
      return { url, token: legacy };
    }
    return { url, token: '' };
  } catch {
    return { url: '', token: '' };
  }
}

// ── REST bridge: call the HA REST API through the Rust/PowerShell backend ──────
interface HaResult {
  ok: boolean;
  status: number;
  body: string;
}

const RELOAD_DOMAINS = ['automation', 'scene', 'script', 'template', 'input_boolean', 'group'];
const HVAC_MODES = ['off', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only'];

function b64(s: string): string {
  // btoa needs latin1; encode UTF-8 first so non-ASCII survives.
  return btoa(unescape(encodeURIComponent(s)));
}

/**
 * One HA REST call. Runs Invoke-WebRequest on the backend (no CORS, native TLS).
 * All inputs are base64-encoded into the script to dodge quoting problems.
 * Returns the raw response body plus an HTTP-ish status.
 */
async function haCall(
  cfg: { url: string; token: string },
  method: 'GET' | 'POST',
  path: string,
  jsonBody?: string,
): Promise<HaResult> {
  if (!isTauri()) {
    return { ok: false, status: 0, body: 'Desktop backend required · 需要桌面後端' };
  }
  if (!cfg.url.trim() || !cfg.token.trim()) {
    return { ok: false, status: 0, body: 'Not configured · 未設定' };
  }
  const base = cfg.url.trim().replace(/\/+$/, '');
  const uB64 = b64(base + path);
  const tB64 = b64(cfg.token.trim());
  const bodyLine =
    jsonBody != null
      ? `$body = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(jsonBody)}'))`
      : '$body = $null';
  const bodyArg = jsonBody != null ? "-Body $body -ContentType 'application/json' " : '';
  const script = `
$ErrorActionPreference = 'Stop'
$u = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${uB64}'))
$tok = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${tB64}'))
${bodyLine}
$headers = @{ Authorization = "Bearer $tok"; Accept = 'application/json' }
try {
  $resp = Invoke-WebRequest -Uri $u -Method ${method} ${bodyArg}-Headers $headers -TimeoutSec 30 -UseBasicParsing
  $code = [int]$resp.StatusCode
  $text = $resp.Content
  Write-Output ("HA_STATUS=" + $code)
  Write-Output "HA_BODY_BEGIN"
  Write-Output $text
} catch {
  $code = 0
  if ($_.Exception.Response) { try { $code = [int]$_.Exception.Response.StatusCode } catch {} }
  $text = ''
  if ($_.Exception.Response) {
    try {
      $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      $text = $sr.ReadToEnd()
    } catch {}
  }
  if (-not $text) { $text = $_.Exception.Message }
  Write-Output ("HA_STATUS=" + $code)
  Write-Output "HA_BODY_BEGIN"
  Write-Output $text
}
`;
  const res = await runPowershell(script);
  const out = res.stdout;
  const mStatus = out.match(/HA_STATUS=(-?\d+)/);
  const status = mStatus ? Number(mStatus[1]) : 0;
  const marker = 'HA_BODY_BEGIN';
  const idx = out.indexOf(marker);
  const body = idx >= 0 ? out.slice(idx + marker.length).replace(/^\r?\n/, '') : res.stderr || out;
  const ok = status >= 200 && status < 300;
  return { ok, status, body: body.trimEnd() };
}

/**
 * Fetch a camera JPEG through the backend and return it as a base64 data URL.
 * The camera proxy returns binary, so we read raw bytes and base64 them in-shell.
 */
async function haCameraProxy(cfg: { url: string; token: string }, entityId: string): Promise<{ ok: boolean; status: number; dataUrl: string; error: string }> {
  if (!isTauri()) return { ok: false, status: 0, dataUrl: '', error: 'Desktop backend required · 需要桌面後端' };
  if (!cfg.url.trim() || !cfg.token.trim()) return { ok: false, status: 0, dataUrl: '', error: 'Not configured · 未設定' };
  const base = cfg.url.trim().replace(/\/+$/, '');
  const uB64 = b64(`${base}/api/camera_proxy/${entityId}`);
  const tB64 = b64(cfg.token.trim());
  const script = `
$ErrorActionPreference = 'Stop'
$u = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${uB64}'))
$tok = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${tB64}'))
$headers = @{ Authorization = "Bearer $tok" }
try {
  $resp = Invoke-WebRequest -Uri $u -Method GET -Headers $headers -TimeoutSec 30 -UseBasicParsing
  $code = [int]$resp.StatusCode
  $bytes = $resp.Content
  if ($bytes -is [string]) { $bytes = [System.Text.Encoding]::UTF8.GetBytes($bytes) }
  $ct = 'image/jpeg'
  try { $ct = [string]$resp.Headers['Content-Type'] } catch {}
  if (-not $ct) { $ct = 'image/jpeg' }
  Write-Output ("HA_STATUS=" + $code)
  Write-Output ("HA_CT=" + $ct)
  Write-Output "HA_B64_BEGIN"
  Write-Output ([Convert]::ToBase64String($bytes))
} catch {
  $code = 0
  if ($_.Exception.Response) { try { $code = [int]$_.Exception.Response.StatusCode } catch {} }
  Write-Output ("HA_STATUS=" + $code)
  Write-Output "HA_ERR_BEGIN"
  Write-Output $_.Exception.Message
}
`;
  const res = await runPowershell(script);
  const out = res.stdout;
  const mStatus = out.match(/HA_STATUS=(-?\d+)/);
  const status = mStatus ? Number(mStatus[1]) : 0;
  const bIdx = out.indexOf('HA_B64_BEGIN');
  if (bIdx >= 0) {
    const ctMatch = out.match(/HA_CT=([^\r\n]+)/);
    const ct = ctMatch && ctMatch[1] ? ctMatch[1].trim() : 'image/jpeg';
    const b64s = out.slice(bIdx + 'HA_B64_BEGIN'.length).replace(/\s+/g, '');
    if (b64s) return { ok: status >= 200 && status < 300, status, dataUrl: `data:${ct};base64,${b64s}`, error: '' };
  }
  const eIdx = out.indexOf('HA_ERR_BEGIN');
  const error = eIdx >= 0 ? out.slice(eIdx + 'HA_ERR_BEGIN'.length).trim() : res.stderr || 'snapshot failed';
  return { ok: false, status, dataUrl: '', error };
}

// ── Entity model ──────────────────────────────────────────────────────────────
interface HaEntity {
  entityId: string;
  state: string;
  name: string; // friendly name or entity id
  domain: string;
  brightnessPct: number | null;
}

function parseStates(body: string): HaEntity[] {
  let arr: unknown;
  try {
    arr = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: HaEntity[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const entityId = typeof o.entity_id === 'string' ? o.entity_id : '';
    if (!entityId) continue;
    const attrs = (o.attributes && typeof o.attributes === 'object' ? o.attributes : {}) as Record<string, unknown>;
    const fn = typeof attrs.friendly_name === 'string' ? attrs.friendly_name : '';
    const rawB = typeof attrs.brightness === 'number' ? attrs.brightness : null;
    out.push({
      entityId,
      state: typeof o.state === 'string' ? o.state : '',
      name: fn || entityId,
      domain: entityId.includes('.') ? entityId.slice(0, entityId.indexOf('.')) : '',
      brightnessPct: rawB != null ? Math.round((rawB / 255) * 100) : null,
    });
  }
  return out.sort((a, b) => a.entityId.localeCompare(b.entityId));
}

interface HaCalEvent {
  summary: string;
  start: string;
  end: string;
}

function jstr(s: string): string {
  return JSON.stringify(s);
}

function isValidJson(s: string): boolean {
  if (!s.trim()) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

type TabKey =
  | 'devices'
  | 'states'
  | 'template'
  | 'automation'
  | 'config'
  | 'notify'
  | 'camera'
  | 'calendar'
  | 'acdefender'
  | 'log';

export function HomeAssistantModule() {
  const { t } = useTranslation();
  const live = isTauri();

  const [cfg, setCfg] = useState(loadCfg);
  const [urlInput, setUrlInput] = useState(cfg.url);
  const [tokenInput, setTokenInput] = useState(cfg.token);
  const [tab, setTab] = useState<TabKey>('devices');
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const configured = cfg.url.trim().length > 0 && cfg.token.trim().length > 0;

  const say = useCallback((ok: boolean, text: string) => setBanner({ ok, text }), []);

  const saveCfg = () => {
    const next = { url: urlInput.trim().replace(/\/+$/, ''), token: tokenInput.trim() };
    setCfg(next);
    try {
      localStorage.setItem(URL_KEY, next.url);
      // Never persist the token in plaintext.
      localStorage.setItem(TOKEN_ENC_KEY, encTok(next.token));
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    say(true, t('homeassistant.saved'));
  };

  const test = async () => {
    setBusy(true);
    setBanner(null);
    try {
      const r = await haCall(cfg, 'GET', '/api/');
      if (r.ok) say(true, t('homeassistant.connected'));
      else say(false, `${t('homeassistant.noConnection', { status: r.status })}: ${r.body.slice(0, 200)}`);
    } finally {
      setBusy(false);
    }
  };

  // ── Devices (lights / plugs / switches) ────────────────────────────────────
  const [toggles, setToggles] = useState<HaEntity[]>([]);
  const [toggleFilter, setToggleFilter] = useState('');
  const [devLoading, setDevLoading] = useState(false);

  const loadToggles = useCallback(async () => {
    if (!configured) return;
    setDevLoading(true);
    try {
      const r = await haCall(cfg, 'GET', '/api/states');
      if (!r.ok) {
        say(false, `${t('homeassistant.loadFailed', { status: r.status })}: ${r.body.slice(0, 200)}`);
        setToggles([]);
        return;
      }
      const all = parseStates(r.body).filter(
        (e) => e.domain === 'light' || e.domain === 'switch' || e.domain === 'input_boolean',
      );
      setToggles(all);
      if (all.length === 0) say(false, t('homeassistant.noControllables'));
    } finally {
      setDevLoading(false);
    }
  }, [cfg, configured, say, t]);

  const doService = async (entityId: string, service: 'turn_on' | 'turn_off' | 'toggle') => {
    const domain = entityId.includes('.') ? entityId.slice(0, entityId.indexOf('.')) : 'homeassistant';
    setBusy(true);
    try {
      const r = await haCall(cfg, 'POST', `/api/services/${domain}/${service}`, `{"entity_id":${jstr(entityId)}}`);
      if (!r.ok) say(false, `${t('homeassistant.actionFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
      else say(true, t('homeassistant.done'));
      await loadToggles();
    } finally {
      setBusy(false);
    }
  };

  const setBrightness = async (entityId: string, pct: number) => {
    setBusy(true);
    try {
      const r = await haCall(
        cfg,
        'POST',
        '/api/services/light/turn_on',
        `{"entity_id":${jstr(entityId)},"brightness_pct":${Math.max(0, Math.min(100, pct))}}`,
      );
      if (!r.ok) say(false, `${t('homeassistant.actionFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
      await loadToggles();
    } finally {
      setBusy(false);
    }
  };

  const allLights = async (on: boolean) => {
    setBusy(true);
    try {
      const r = await haCall(cfg, 'POST', `/api/services/light/turn_${on ? 'on' : 'off'}`, '{"entity_id":"all"}');
      if (!r.ok) say(false, `${t('homeassistant.actionFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
      else say(true, on ? t('homeassistant.allOn') : t('homeassistant.allOff'));
      await loadToggles();
    } finally {
      setBusy(false);
    }
  };

  const filteredToggles = useMemo(() => {
    const q = toggleFilter.trim().toLowerCase();
    const list = q ? toggles.filter((e) => `${e.name} ${e.entityId}`.toLowerCase().includes(q)) : toggles;
    return {
      lights: list.filter((e) => e.domain === 'light'),
      plugs: list.filter((e) => e.domain !== 'light'),
    };
  }, [toggles, toggleFilter]);

  // Advanced single-light control (colour temp / RGB) + climate.
  const [advLightId, setAdvLightId] = useState('');
  const [advBright, setAdvBright] = useState(80);
  const [advTempK, setAdvTempK] = useState(4000);
  const [climateId, setClimateId] = useState('');
  const [climateTemp, setClimateTemp] = useState('21');
  const [hvacMode, setHvacMode] = useState(HVAC_MODES[1]!);

  const lightEntities = useMemo(() => toggles.filter((e) => e.domain === 'light'), [toggles]);
  const [climateEntities, setClimateEntities] = useState<HaEntity[]>([]);

  const loadClimate = useCallback(async () => {
    if (!configured) return;
    const r = await haCall(cfg, 'GET', '/api/states');
    if (!r.ok) return;
    const cl = parseStates(r.body).filter((e) => e.domain === 'climate');
    setClimateEntities(cl);
    if (cl[0]) setClimateId((v) => v || cl[0]!.entityId);
  }, [cfg, configured]);

  const applyAdvLight = async () => {
    if (!advLightId) {
      say(false, t('homeassistant.noLight'));
      return;
    }
    setBusy(true);
    try {
      const body = `{"entity_id":${jstr(advLightId)},"brightness_pct":${Math.max(0, Math.min(100, advBright))},"color_temp_kelvin":${Math.max(2000, Math.min(6500, advTempK))}}`;
      const r = await haCall(cfg, 'POST', '/api/services/light/turn_on', body);
      say(r.ok, r.ok ? t('homeassistant.lightUpdated') : `${t('homeassistant.actionFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
      await loadToggles();
    } finally {
      setBusy(false);
    }
  };

  const advLightOff = async () => {
    if (!advLightId) {
      say(false, t('homeassistant.noLight'));
      return;
    }
    setBusy(true);
    try {
      const r = await haCall(cfg, 'POST', '/api/services/light/turn_off', `{"entity_id":${jstr(advLightId)}}`);
      say(r.ok, r.ok ? t('homeassistant.lightOff') : `${t('homeassistant.actionFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
      await loadToggles();
    } finally {
      setBusy(false);
    }
  };

  const setThermostat = async () => {
    if (!climateId) {
      say(false, t('homeassistant.noThermostat'));
      return;
    }
    const tval = Number(climateTemp);
    if (!Number.isFinite(tval)) {
      say(false, t('homeassistant.enterTemp'));
      return;
    }
    setBusy(true);
    try {
      const r = await haCall(cfg, 'POST', '/api/services/climate/set_temperature', `{"entity_id":${jstr(climateId)},"temperature":${tval}}`);
      say(r.ok, r.ok ? t('homeassistant.tempSet') : `${t('homeassistant.actionFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
    } finally {
      setBusy(false);
    }
  };

  const setHvac = async () => {
    if (!climateId) {
      say(false, t('homeassistant.noThermostat'));
      return;
    }
    setBusy(true);
    try {
      const r = await haCall(cfg, 'POST', '/api/services/climate/set_hvac_mode', `{"entity_id":${jstr(climateId)},"hvac_mode":${jstr(hvacMode)}}`);
      say(r.ok, r.ok ? t('homeassistant.modeSet') : `${t('homeassistant.actionFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (configured && tab === 'devices' && toggles.length === 0) void loadToggles();
    if (configured && tab === 'devices' && climateEntities.length === 0) void loadClimate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, tab]);

  useEffect(() => {
    if (lightEntities[0]) setAdvLightId((v) => v || lightEntities[0]!.entityId);
  }, [lightEntities]);

  // ── States list / history sparkline / set state (+ attributes) ─────────────
  const [entities, setEntities] = useState<HaEntity[]>([]);
  const [stFilter, setStFilter] = useState('');
  const [histId, setHistId] = useState('');
  const [spark, setSpark] = useState<{ pts: number[]; min: number; max: number; note: string } | null>(null);
  const [setVal, setSetVal] = useState('');
  const [setAttr, setSetAttr] = useState('');

  const loadEntities = async () => {
    setBusy(true);
    try {
      const r = await haCall(cfg, 'GET', '/api/states');
      if (!r.ok) {
        say(false, `${t('homeassistant.loadFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
        return;
      }
      const all = parseStates(r.body);
      setEntities(all);
      say(true, t('homeassistant.entitiesLoaded', { num: all.length }));
    } finally {
      setBusy(false);
    }
  };

  const plotHistory = async () => {
    const id = histId.trim();
    if (!id) {
      say(false, t('homeassistant.enterEntity'));
      return;
    }
    setBusy(true);
    setSpark(null);
    try {
      const end = new Date();
      const start = new Date(end.getTime() - 24 * 3600 * 1000);
      const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, 'Z');
      const path = `/api/history/period/${encodeURIComponent(iso(start))}?filter_entity_id=${encodeURIComponent(id)}&end_time=${encodeURIComponent(iso(end))}&minimal_response`;
      const r = await haCall(cfg, 'GET', path);
      if (!r.ok) {
        say(false, `${t('homeassistant.loadFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
        return;
      }
      let series: unknown;
      try {
        series = JSON.parse(r.body);
      } catch {
        series = null;
      }
      const vals: number[] = [];
      if (Array.isArray(series)) {
        for (const grp of series) {
          if (!Array.isArray(grp)) continue;
          for (const s of grp) {
            const st = (s as Record<string, unknown>)?.state;
            const n = typeof st === 'string' ? Number(st) : NaN;
            if (Number.isFinite(n)) vals.push(n);
          }
        }
      }
      if (vals.length < 2) {
        setSpark(null);
        say(false, t('homeassistant.noNumericHistory'));
        return;
      }
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      setSpark({
        pts: vals,
        min,
        max,
        note: t('homeassistant.sparkNote', { min: round2(min), max: round2(max), num: vals.length }),
      });
    } finally {
      setBusy(false);
    }
  };

  const setState = async () => {
    const id = histId.trim();
    if (!id) {
      say(false, t('homeassistant.enterEntity'));
      return;
    }
    const attr = setAttr.trim();
    if (attr && !isValidJson(attr)) {
      say(false, t('homeassistant.attrJson'));
      return;
    }
    setBusy(true);
    try {
      const body = attr ? `{"state":${jstr(setVal)},"attributes":${attr}}` : `{"state":${jstr(setVal)}}`;
      const r = await haCall(cfg, 'POST', `/api/states/${id}`, body);
      if (r.ok) say(true, t('homeassistant.stateSet'));
      else say(false, `${t('homeassistant.actionFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
    } finally {
      setBusy(false);
    }
  };

  const filteredEntities = useMemo(() => {
    const q = stFilter.trim().toLowerCase();
    const list = q
      ? entities.filter((e) => `${e.name} ${e.entityId} ${e.state}`.toLowerCase().includes(q))
      : entities;
    return list.slice(0, 500);
  }, [entities, stFilter]);

  // ── Template render ────────────────────────────────────────────────────────
  const [tpl, setTpl] = useState("{{ states('sun.sun') }}");
  const [tplOut, setTplOut] = useState('');

  const renderTpl = async () => {
    setBusy(true);
    setTplOut(t('homeassistant.rendering'));
    try {
      const r = await haCall(cfg, 'POST', '/api/template', `{"template":${jstr(tpl)}}`);
      setTplOut(r.ok ? r.body : `[HTTP ${r.status}] ${r.body}`);
    } finally {
      setBusy(false);
    }
  };

  // ── Automation: scenes / scripts / events / intents ────────────────────────
  const [scenes, setScenes] = useState<HaEntity[]>([]);
  const [scripts, setScripts] = useState<HaEntity[]>([]);
  const [sceneSel, setSceneSel] = useState('');
  const [scriptSel, setScriptSel] = useState('');
  const [eventType, setEventType] = useState('');
  const [eventData, setEventData] = useState('');
  const [intentName, setIntentName] = useState('');
  const [intentData, setIntentData] = useState('');

  const loadAutomation = useCallback(async () => {
    if (!configured) return;
    setBusy(true);
    try {
      const r = await haCall(cfg, 'GET', '/api/states');
      if (!r.ok) {
        say(false, `${t('homeassistant.loadFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
        return;
      }
      const all = parseStates(r.body);
      const sc = all.filter((e) => e.domain === 'scene');
      const sr = all.filter((e) => e.domain === 'script');
      setScenes(sc);
      setScripts(sr);
      if (sc[0]) setSceneSel((v) => v || sc[0]!.entityId);
      if (sr[0]) setScriptSel((v) => v || sr[0]!.entityId);
    } finally {
      setBusy(false);
    }
  }, [cfg, configured, say, t]);

  useEffect(() => {
    if (configured && tab === 'automation' && scenes.length === 0 && scripts.length === 0) void loadAutomation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, tab]);

  const runScene = async () => {
    if (!sceneSel) {
      say(false, t('homeassistant.pickScene'));
      return;
    }
    setBusy(true);
    try {
      const r = await haCall(cfg, 'POST', '/api/services/scene/turn_on', `{"entity_id":${jstr(sceneSel)}}`);
      say(r.ok, r.ok ? t('homeassistant.sceneRun') : `${t('homeassistant.actionFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
    } finally {
      setBusy(false);
    }
  };

  const runScript = async () => {
    if (!scriptSel) {
      say(false, t('homeassistant.pickScript'));
      return;
    }
    setBusy(true);
    try {
      const obj = scriptSel.startsWith('script.') ? scriptSel.slice('script.'.length) : scriptSel;
      const r = await haCall(cfg, 'POST', `/api/services/script/${obj}`, '{}');
      say(r.ok, r.ok ? t('homeassistant.scriptRun') : `${t('homeassistant.actionFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
    } finally {
      setBusy(false);
    }
  };

  const fireEvent = async () => {
    const type = eventType.trim();
    if (!type) {
      say(false, t('homeassistant.enterEvent'));
      return;
    }
    const data = eventData.trim();
    if (data && !isValidJson(data)) {
      say(false, t('homeassistant.eventJson'));
      return;
    }
    setBusy(true);
    try {
      const r = await haCall(cfg, 'POST', `/api/events/${type}`, data || undefined);
      say(r.ok, r.ok ? t('homeassistant.eventFired') : `${t('homeassistant.actionFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleIntent = async () => {
    const name = intentName.trim();
    if (!name) {
      say(false, t('homeassistant.enterIntent'));
      return;
    }
    const data = intentData.trim();
    if (data && !isValidJson(data)) {
      say(false, t('homeassistant.intentJson'));
      return;
    }
    setBusy(true);
    try {
      const body = `{"name":${jstr(name)},"data":${data || '{}'}}`;
      const r = await haCall(cfg, 'POST', '/api/intent/handle', body);
      say(r.ok, r.ok ? t('homeassistant.intentHandled') : `${t('homeassistant.actionFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
    } finally {
      setBusy(false);
    }
  };

  // ── Config: check / restart / reload domain / reload config entry ──────────
  const [reloadDomain, setReloadDomain] = useState(RELOAD_DOMAINS[0]!);
  const [entryId, setEntryId] = useState('');

  const checkConfig = async () => {
    setBusy(true);
    try {
      const r = await haCall(cfg, 'POST', '/api/config/core/check_config', '');
      if (r.ok && r.body.includes('"valid"')) say(true, t('homeassistant.cfgValid'));
      else say(false, `${t('homeassistant.cfgInvalid')}: ${r.body.slice(0, 200)}`);
    } finally {
      setBusy(false);
    }
  };

  const restart = async () => {
    if (!window.confirm(t('homeassistant.restartConfirm'))) return;
    setBusy(true);
    try {
      const r = await haCall(cfg, 'POST', '/api/services/homeassistant/restart', '{}');
      say(r.ok, r.ok ? t('homeassistant.restartRequested') : `${t('homeassistant.actionFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
    } finally {
      setBusy(false);
    }
  };

  const reloadDom = async () => {
    setBusy(true);
    try {
      const r = await haCall(cfg, 'POST', `/api/services/${reloadDomain}/reload`, '{}');
      say(r.ok, r.ok ? t('homeassistant.reloaded', { domain: reloadDomain }) : `${t('homeassistant.actionFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
    } finally {
      setBusy(false);
    }
  };

  const reloadEntry = async () => {
    const id = entryId.trim();
    if (!id) {
      say(false, t('homeassistant.enterEntry'));
      return;
    }
    setBusy(true);
    try {
      const r = await haCall(cfg, 'POST', '/api/services/homeassistant/reload_config_entry', `{"entry_id":${jstr(id)}}`);
      say(r.ok, r.ok ? t('homeassistant.entryReloaded') : `${t('homeassistant.actionFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
    } finally {
      setBusy(false);
    }
  };

  // ── Notify ─────────────────────────────────────────────────────────────────
  const [targets, setTargets] = useState<string[]>([]);
  const [targetSel, setTargetSel] = useState('');
  const [notifyTitle, setNotifyTitle] = useState('');
  const [notifyMsg, setNotifyMsg] = useState('');

  const loadTargets = async () => {
    setBusy(true);
    try {
      const r = await haCall(cfg, 'GET', '/api/services');
      if (!r.ok) {
        say(false, `${t('homeassistant.loadFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
        return;
      }
      let arr: unknown;
      try {
        arr = JSON.parse(r.body);
      } catch {
        arr = null;
      }
      const out: string[] = [];
      if (Array.isArray(arr)) {
        for (const dom of arr) {
          const o = dom as Record<string, unknown>;
          if (o?.domain !== 'notify') continue;
          const svcs = o.services;
          if (svcs && typeof svcs === 'object') {
            for (const name of Object.keys(svcs as Record<string, unknown>)) out.push(`notify.${name}`);
          }
        }
      }
      out.sort();
      setTargets(out);
      if (out[0]) setTargetSel(out[0]);
      say(true, t('homeassistant.targetsLoaded', { num: out.length }));
    } finally {
      setBusy(false);
    }
  };

  const pushNotify = async () => {
    if (!targetSel) {
      say(false, t('homeassistant.pickTarget'));
      return;
    }
    const msg = notifyMsg.trim();
    if (!msg) {
      say(false, t('homeassistant.enterMessage'));
      return;
    }
    setBusy(true);
    try {
      const svc = targetSel.startsWith('notify.') ? targetSel.slice('notify.'.length) : targetSel;
      const body = notifyTitle.trim()
        ? `{"title":${jstr(notifyTitle.trim())},"message":${jstr(msg)}}`
        : `{"message":${jstr(msg)}}`;
      const r = await haCall(cfg, 'POST', `/api/services/notify/${svc}`, body);
      say(r.ok, r.ok ? t('homeassistant.pushed') : `${t('homeassistant.actionFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
    } finally {
      setBusy(false);
    }
  };

  // ── Camera ─────────────────────────────────────────────────────────────────
  const [cameras, setCameras] = useState<HaEntity[]>([]);
  const [cameraSel, setCameraSel] = useState('');
  const [snapUrl, setSnapUrl] = useState('');

  const loadCameras = useCallback(async () => {
    if (!configured) return;
    const r = await haCall(cfg, 'GET', '/api/states');
    if (!r.ok) return;
    const cams = parseStates(r.body).filter((e) => e.domain === 'camera');
    setCameras(cams);
    if (cams[0]) setCameraSel((v) => v || cams[0]!.entityId);
  }, [cfg, configured]);

  useEffect(() => {
    if (configured && tab === 'camera' && cameras.length === 0) void loadCameras();
    if (configured && tab === 'calendar' && calendars.length === 0) void loadCalendars();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, tab]);

  const snapCamera = async () => {
    if (!cameraSel) {
      say(false, t('homeassistant.noCamera'));
      return;
    }
    setBusy(true);
    setSnapUrl('');
    try {
      const r = await haCameraProxy(cfg, cameraSel);
      if (r.ok && r.dataUrl) {
        setSnapUrl(r.dataUrl);
        say(true, t('homeassistant.snapCaptured'));
      } else {
        say(false, `${t('homeassistant.snapFailed', { status: r.status })}: ${r.error.slice(0, 160)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const saveSnap = () => {
    if (!snapUrl) {
      say(false, t('homeassistant.snapFirst'));
      return;
    }
    const a = document.createElement('a');
    a.href = snapUrl;
    a.download = `ha-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // ── Calendar ───────────────────────────────────────────────────────────────
  const [calendars, setCalendars] = useState<HaEntity[]>([]);
  const [calendarSel, setCalendarSel] = useState('');
  const [calEvents, setCalEvents] = useState<HaCalEvent[]>([]);

  const loadCalendars = useCallback(async () => {
    if (!configured) return;
    setBusy(true);
    try {
      const r = await haCall(cfg, 'GET', '/api/calendars');
      if (!r.ok) {
        say(false, `${t('homeassistant.loadFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
        return;
      }
      let arr: unknown;
      try {
        arr = JSON.parse(r.body);
      } catch {
        arr = null;
      }
      const out: HaEntity[] = [];
      if (Array.isArray(arr)) {
        for (const raw of arr) {
          const o = raw as Record<string, unknown>;
          const id = typeof o?.entity_id === 'string' ? o.entity_id : '';
          if (!id) continue;
          const nm = typeof o?.name === 'string' ? o.name : id;
          out.push({ entityId: id, state: '', name: nm, domain: 'calendar', brightnessPct: null });
        }
      }
      setCalendars(out);
      if (out[0]) setCalendarSel((v) => v || out[0]!.entityId);
      say(true, t('homeassistant.calendarsLoaded', { num: out.length }));
    } finally {
      setBusy(false);
    }
  }, [cfg, configured, say, t]);

  const loadToday = async () => {
    if (!calendarSel) {
      say(false, t('homeassistant.pickCalendar'));
      return;
    }
    setBusy(true);
    setCalEvents([]);
    try {
      const now = new Date();
      const startLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const endLocal = new Date(startLocal.getTime() + 24 * 3600 * 1000);
      const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, 'Z');
      const path = `/api/calendars/${calendarSel}?start=${encodeURIComponent(iso(startLocal))}&end=${encodeURIComponent(iso(endLocal))}`;
      const r = await haCall(cfg, 'GET', path);
      if (!r.ok) {
        say(false, `${t('homeassistant.loadFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
        return;
      }
      let arr: unknown;
      try {
        arr = JSON.parse(r.body);
      } catch {
        arr = null;
      }
      const evs: HaCalEvent[] = [];
      if (Array.isArray(arr)) {
        for (const raw of arr) {
          const o = raw as Record<string, unknown>;
          evs.push({
            summary: typeof o?.summary === 'string' ? o.summary : '',
            start: readDateOrTime(o?.start),
            end: readDateOrTime(o?.end),
          });
        }
      }
      setCalEvents(evs);
      say(true, t('homeassistant.eventsToday', { num: evs.length }));
    } finally {
      setBusy(false);
    }
  };

  // ── AC Defender: generate Home Assistant AC-guard Docker deployment files ────
  const [acProject, setAcProject] = useState('ha-ac-defender');
  const [acClimate, setAcClimate] = useState('');
  const [acPoll, setAcPoll] = useState('60');
  const [acCoolAbove, setAcCoolAbove] = useState('28');
  const [acHeatBelow, setAcHeatBelow] = useState('16');
  const [acDryRun, setAcDryRun] = useState(true);
  const [acFile, setAcFile] = useState<'compose' | 'dockerfile' | 'python' | 'readme' | 'deploy'>('compose');
  const [acOut, setAcOut] = useState('');

  const acProjectName = (raw: string) => {
    let s = (raw || 'ha-ac-defender').toLowerCase().replace(/[^a-z0-9]/g, '-');
    while (s.includes('--')) s = s.replace('--', '-');
    s = s.replace(/^-+|-+$/g, '');
    return s || 'ha-ac-defender';
  };

  const acArtifacts = useMemo(() => {
    const project = acProjectName(acProject);
    const climate = acClimate.trim() || 'climate.living_room';
    const cool = acCoolAbove.trim() || '28';
    const heat = acHeatBelow.trim() || '16';
    const pollN = Math.max(10, Math.min(3600, Number(acPoll) || 60));
    const dry = acDryRun ? '1' : '0';
    const esc = (s: string) => s.replace(/"/g, '\\"');

    const compose = `services:
  ac-defender:
    image: python:3.12-slim
    working_dir: /app
    command: python /app/ac_defender.py
    environment:
      HA_URL: \${HA_URL}
      HA_TOKEN: \${HA_TOKEN}
      CLIMATE_ENTITY: "${esc(climate)}"
      COOL_ABOVE_C: "${cool}"
      HEAT_BELOW_C: "${heat}"
      POLL_SECONDS: "${pollN}"
      DRY_RUN: "${dry}"
    volumes:
      - ./ac_defender.py:/app/ac_defender.py:ro
    restart: unless-stopped`;

    const dockerfile = `FROM python:3.12-slim
WORKDIR /app
COPY ac_defender.py /app/ac_defender.py
ENV PYTHONUNBUFFERED=1
CMD ["python", "/app/ac_defender.py"]`;

    const python = `import json
import os
import time
import urllib.error
import urllib.request

HA_URL = os.environ.get("HA_URL", "").rstrip("/")
HA_TOKEN = os.environ.get("HA_TOKEN", "")
CLIMATE_ENTITY = os.environ.get("CLIMATE_ENTITY", "${esc(climate)}")
COOL_ABOVE_C = float(os.environ.get("COOL_ABOVE_C", "${cool}"))
HEAT_BELOW_C = float(os.environ.get("HEAT_BELOW_C", "${heat}"))
POLL_SECONDS = max(10, int(os.environ.get("POLL_SECONDS", "${pollN}")))
DRY_RUN = os.environ.get("DRY_RUN", "${dry}").lower() in ("1", "true", "yes", "on")

def request(method, path, body=None):
    if not HA_URL or not HA_TOKEN:
        raise RuntimeError("HA_URL and HA_TOKEN are required")
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(HA_URL + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + HA_TOKEN)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw else {}

def current_temperature(state):
    attrs = state.get("attributes", {})
    for key in ("current_temperature", "temperature"):
        value = attrs.get(key)
        try:
            return float(value)
        except (TypeError, ValueError):
            pass
    return None

def turn_off(reason):
    print(reason, flush=True)
    if DRY_RUN:
        print("dry-run: climate.turn_off skipped", flush=True)
        return
    request("POST", "/api/services/climate/turn_off", {"entity_id": CLIMATE_ENTITY})
    request("POST", "/api/events/winforge_ac_defender_trip", {
        "entity_id": CLIMATE_ENTITY,
        "reason": reason,
        "source": "winforge"
    })

print("WinForge AC Defender started for " + CLIMATE_ENTITY, flush=True)
while True:
    try:
        state = request("GET", "/api/states/" + CLIMATE_ENTITY)
        temp = current_temperature(state)
        mode = str(state.get("state", "unknown"))
        print("state=%s current_temperature=%s" % (mode, temp), flush=True)
        if temp is not None and mode in ("cool", "heat", "heat_cool", "auto"):
            if mode == "cool" and temp >= COOL_ABOVE_C:
                turn_off("cooling guard tripped at %.2f C" % temp)
            elif mode == "heat" and temp <= HEAT_BELOW_C:
                turn_off("heating guard tripped at %.2f C" % temp)
            elif mode in ("heat_cool", "auto") and (temp >= COOL_ABOVE_C or temp <= HEAT_BELOW_C):
                turn_off("auto guard tripped at %.2f C" % temp)
    except urllib.error.HTTPError as ex:
        print("http error %s: %s" % (ex.code, ex.read().decode("utf-8", "replace")), flush=True)
    except Exception as ex:
        print("error: " + str(ex), flush=True)
    time.sleep(POLL_SECONDS)`;

    const readme = `# Home Assistant AC Defender

Generated by WinForge. This bundle watches one Home Assistant climate entity and turns HVAC off
when the reported temperature crosses the configured guard band.

## Files

- \`ac_defender.py\` - runtime watcher using Python standard libraries only.
- \`Dockerfile\` - optional image build for remote hosts.
- \`docker-compose.yml\` - local/remote compose deployment.
- \`deploy-ssh.sh\` - helper commands to run on a remote Docker host after upload.

## Configure

Set secrets on the host, not in these files:

\`\`\`sh
export HA_URL="http://homeassistant.local:8123"
export HA_TOKEN="your-long-lived-access-token"
\`\`\`

Defaults in this bundle:

- Climate entity: \`${climate}\`
- Cool-above trip: \`${cool} C\`
- Heat-below trip: \`${heat} C\`
- Poll interval: \`${pollN} s\`
- Dry run: \`${acDryRun ? 'on' : 'off'}\``;

    const deploy = `#!/usr/bin/env sh
set -eu
: "\${HA_URL:?Set HA_URL first}"
: "\${HA_TOKEN:?Set HA_TOKEN first}"
docker compose -p ${project} up -d
docker compose -p ${project} ps`;

    return { project, compose, dockerfile, python, readme, deploy };
  }, [acProject, acClimate, acPoll, acCoolAbove, acHeatBelow, acDryRun]);

  const acFileName = (kind: typeof acFile) =>
    kind === 'compose'
      ? 'docker-compose.yml'
      : kind === 'dockerfile'
        ? 'Dockerfile'
        : kind === 'python'
          ? 'ac_defender.py'
          : kind === 'readme'
            ? 'README.md'
            : 'deploy-ssh.sh';

  const acContent = (kind: typeof acFile) =>
    kind === 'compose'
      ? acArtifacts.compose
      : kind === 'dockerfile'
        ? acArtifacts.dockerfile
        : kind === 'python'
          ? acArtifacts.python
          : kind === 'readme'
            ? acArtifacts.readme
            : acArtifacts.deploy;

  const acGenerate = () => {
    setAcOut(acContent(acFile));
    say(true, t('homeassistant.acGenerated', { name: acArtifacts.project }));
  };

  const acDownload = () => {
    const content = acContent(acFile);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = acFileName(acFile);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  };

  // ── Error log ──────────────────────────────────────────────────────────────
  const [logOut, setLogOut] = useState('');

  const tailLog = async () => {
    setBusy(true);
    setLogOut(t('homeassistant.rendering'));
    try {
      const r = await haCall(cfg, 'GET', '/api/error_log');
      setLogOut(r.ok ? r.body.trim() || t('homeassistant.logEmpty') : `[HTTP ${r.status}] ${r.body}`);
    } finally {
      setBusy(false);
    }
  };

  // ── Columns for the entity list ────────────────────────────────────────────
  const entityColumns: Column<HaEntity>[] = [
    { key: 'state', header: t('homeassistant.colState'), width: 110, render: (e) => <StatusDot ok={e.state === 'on'} label={e.state || '—'} /> },
    { key: 'name', header: t('homeassistant.colName') },
    { key: 'entityId', header: t('homeassistant.colEntity'), width: 260 },
    { key: 'domain', header: t('homeassistant.colDomain'), width: 130 },
  ];

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'devices', label: t('homeassistant.tabDevices') },
    { key: 'states', label: t('homeassistant.tabStates') },
    { key: 'template', label: t('homeassistant.tabTemplate') },
    { key: 'automation', label: t('homeassistant.tabAutomation') },
    { key: 'config', label: t('homeassistant.tabConfig') },
    { key: 'notify', label: t('homeassistant.tabNotify') },
    { key: 'camera', label: t('homeassistant.tabCamera') },
    { key: 'calendar', label: t('homeassistant.tabCalendar') },
    { key: 'acdefender', label: t('homeassistant.tabAcDefender') },
    { key: 'log', label: t('homeassistant.tabLog') },
  ];

  return (
    <div className="mod">
      <h2 className="group-title" style={{ marginTop: 0 }}>{t('homeassistant.title')}</h2>
      <p className="count-note" style={{ marginTop: 0 }}>{t('homeassistant.blurb')}</p>

      {!live && <p className="count-note">{t('homeassistant.browserNote')}</p>}

      {/* Connection */}
      <div className="hosts-edit" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <input
          className="mod-search"
          style={{ minWidth: 260, flex: '1 1 260px' }}
          placeholder="http://homeassistant.local:8123"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
        />
        <input
          className="mod-search"
          style={{ minWidth: 220, flex: '1 1 220px' }}
          type="password"
          placeholder={t('homeassistant.tokenPlaceholder')}
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
        />
        <button className="mini primary" onClick={saveCfg}>{t('homeassistant.save')}</button>
        <button className="mini" disabled={busy || !configured} onClick={test}>{t('homeassistant.test')}</button>
        <StatusDot ok={configured} label={configured ? t('homeassistant.configured') : t('homeassistant.notConfigured')} />
      </div>

      {banner && <p className={`mod-msg ${banner.ok ? '' : 'error'}`}>{banner.text}</p>}

      {/* Tabs */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        {tabs.map((tb) => (
          <button key={tb.key} className={tab === tb.key ? 'mini primary' : 'mini'} onClick={() => setTab(tb.key)}>
            {tb.label}
          </button>
        ))}
      </div>

      {!configured && <p className="count-note">{t('homeassistant.setFirst')}</p>}

      {/* ── Devices ── */}
      {tab === 'devices' && (
        <div>
          <ModuleToolbar>
            <input
              className="mod-search"
              placeholder={t('homeassistant.searchToggles')}
              value={toggleFilter}
              onChange={(e) => setToggleFilter(e.target.value)}
            />
            <button className="mini" disabled={busy || !configured} onClick={loadToggles}>⟳ {t('modules.refresh')}</button>
            <button className="mini" disabled={busy || !configured} onClick={() => allLights(true)}>{t('homeassistant.allLightsOn')}</button>
            <button className="mini" disabled={busy || !configured} onClick={() => allLights(false)}>{t('homeassistant.allLightsOff')}</button>
            <span className="count-note">{t('homeassistant.deviceCount', { num: toggles.length })}</span>
          </ModuleToolbar>
          {devLoading && <p className="count-note">{t('modules.loading')}</p>}

          <h3 className="group-title" style={{ fontSize: 14, margin: '16px 0 6px' }}>{t('homeassistant.groupLights')}</h3>
          {filteredToggles.lights.length === 0 ? (
            <p className="count-note">{t('modules.noRows')}</p>
          ) : (
            filteredToggles.lights.map((e) => (
              <div key={e.entityId} className="hosts-edit" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', flexWrap: 'wrap' }}>
                <StatusDot ok={e.state === 'on'} label="" />
                <div style={{ flex: '1 1 200px', minWidth: 160 }}>
                  <div>{e.name}</div>
                  <div className="count-note" style={{ margin: 0 }}>{e.entityId}</div>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  defaultValue={e.brightnessPct ?? (e.state === 'on' ? 100 : 0)}
                  disabled={busy}
                  onMouseUp={(ev) => setBrightness(e.entityId, Number((ev.target as HTMLInputElement).value))}
                  style={{ flex: '0 0 140px' }}
                />
                <button className="mini" disabled={busy} onClick={() => doService(e.entityId, 'turn_on')}>{t('homeassistant.on')}</button>
                <button className="mini" disabled={busy} onClick={() => doService(e.entityId, 'turn_off')}>{t('homeassistant.off')}</button>
                <button className="mini" disabled={busy} onClick={() => doService(e.entityId, 'toggle')}>{t('homeassistant.toggle')}</button>
              </div>
            ))
          )}

          <h3 className="group-title" style={{ fontSize: 14, margin: '16px 0 6px' }}>{t('homeassistant.groupPlugs')}</h3>
          {filteredToggles.plugs.length === 0 ? (
            <p className="count-note">{t('modules.noRows')}</p>
          ) : (
            filteredToggles.plugs.map((e) => (
              <div key={e.entityId} className="hosts-edit" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', flexWrap: 'wrap' }}>
                <StatusDot ok={e.state === 'on'} label="" />
                <div style={{ flex: '1 1 200px', minWidth: 160 }}>
                  <div>{e.name}</div>
                  <div className="count-note" style={{ margin: 0 }}>{e.entityId}</div>
                </div>
                <button className="mini" disabled={busy} onClick={() => doService(e.entityId, 'turn_on')}>{t('homeassistant.on')}</button>
                <button className="mini" disabled={busy} onClick={() => doService(e.entityId, 'turn_off')}>{t('homeassistant.off')}</button>
                <button className="mini" disabled={busy} onClick={() => doService(e.entityId, 'toggle')}>{t('homeassistant.toggle')}</button>
              </div>
            ))
          )}

          {/* Advanced single-light control (colour temp) */}
          <h3 className="group-title" style={{ fontSize: 14, margin: '18px 0 6px' }}>{t('homeassistant.advLight')}</h3>
          <div className="hosts-edit" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '4px 0' }}>
            <select className="mod-select" style={{ flex: '1 1 220px' }} value={advLightId} onChange={(e) => setAdvLightId(e.target.value)}>
              <option value="">{t('homeassistant.noLight')}</option>
              {lightEntities.map((l) => <option key={l.entityId} value={l.entityId}>{l.name}</option>)}
            </select>
            <label className="count-note" style={{ margin: 0 }}>{t('homeassistant.brightnessPct', { pct: advBright })}
              <input type="range" min={0} max={100} value={advBright} onChange={(e) => setAdvBright(Number(e.target.value))} style={{ marginLeft: 8, verticalAlign: 'middle' }} />
            </label>
            <label className="count-note" style={{ margin: 0 }}>{t('homeassistant.colorTempK', { k: advTempK })}
              <input type="range" min={2000} max={6500} step={100} value={advTempK} onChange={(e) => setAdvTempK(Number(e.target.value))} style={{ marginLeft: 8, verticalAlign: 'middle' }} />
            </label>
            <button className="mini primary" disabled={busy || !configured} onClick={applyAdvLight}>{t('homeassistant.apply')}</button>
            <button className="mini" disabled={busy || !configured} onClick={advLightOff}>{t('homeassistant.off')}</button>
          </div>

          {/* Thermostat / climate */}
          <h3 className="group-title" style={{ fontSize: 14, margin: '18px 0 6px' }}>{t('homeassistant.thermostat')}</h3>
          <div className="hosts-edit" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '4px 0' }}>
            <select className="mod-select" style={{ flex: '1 1 220px' }} value={climateId} onChange={(e) => setClimateId(e.target.value)}>
              <option value="">{t('homeassistant.noThermostat')}</option>
              {climateEntities.map((c) => <option key={c.entityId} value={c.entityId}>{c.name}</option>)}
            </select>
            <input className="mod-search" style={{ flex: '0 1 100px' }} placeholder="°C" value={climateTemp} onChange={(e) => setClimateTemp(e.target.value)} />
            <button className="mini" disabled={busy || !configured} onClick={setThermostat}>{t('homeassistant.setTemp')}</button>
            <select className="mod-select" value={hvacMode} onChange={(e) => setHvacMode(e.target.value)}>
              {HVAC_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button className="mini" disabled={busy || !configured} onClick={setHvac}>{t('homeassistant.setMode')}</button>
          </div>
        </div>
      )}

      {/* ── States ── */}
      {tab === 'states' && (
        <div>
          <ModuleToolbar>
            <button className="mini primary" disabled={busy || !configured} onClick={loadEntities}>{t('homeassistant.loadEntities')}</button>
            <input
              className="mod-search"
              placeholder={t('homeassistant.filterEntities')}
              value={stFilter}
              onChange={(e) => setStFilter(e.target.value)}
            />
            <span className="count-note">{t('homeassistant.entityCount', { num: entities.length })}</span>
          </ModuleToolbar>

          <div className="hosts-edit" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
            <input
              className="mod-search"
              style={{ flex: '1 1 220px' }}
              placeholder="sensor.temperature"
              value={histId}
              onChange={(e) => setHistId(e.target.value)}
            />
            <button className="mini" disabled={busy || !configured} onClick={plotHistory}>{t('homeassistant.plotHistory')}</button>
            <input
              className="mod-search"
              style={{ flex: '0 1 140px' }}
              placeholder={t('homeassistant.stateValue')}
              value={setVal}
              onChange={(e) => setSetVal(e.target.value)}
            />
            <input
              className="mod-search"
              style={{ flex: '0 1 200px', fontFamily: 'monospace' }}
              placeholder={t('homeassistant.attrPlaceholder')}
              value={setAttr}
              onChange={(e) => setSetAttr(e.target.value)}
            />
            <button className="mini" disabled={busy || !configured} onClick={setState}>{t('homeassistant.setState')}</button>
          </div>

          {spark && (
            <div style={{ border: '1px solid var(--border, #333)', borderRadius: 6, padding: 8, marginBottom: 10 }}>
              <Sparkline pts={spark.pts} />
              <p className="count-note" style={{ margin: '4px 0 0' }}>{spark.note}</p>
            </div>
          )}

          <DataTable columns={entityColumns} rows={filteredEntities} rowKey={(e) => e.entityId} />
        </div>
      )}

      {/* ── Template ── */}
      {tab === 'template' && (
        <div>
          <p className="count-note" style={{ marginTop: 0 }}>{t('homeassistant.tplBlurb')}</p>
          <textarea
            className="mod-search"
            style={{ width: '100%', minHeight: 90, fontFamily: 'monospace' }}
            value={tpl}
            onChange={(e) => setTpl(e.target.value)}
          />
          <div style={{ margin: '8px 0' }}>
            <button className="mini primary" disabled={busy || !configured} onClick={renderTpl}>{t('homeassistant.render')}</button>
          </div>
          <pre className="cmd-out" style={{ whiteSpace: 'pre-wrap' }}>{tplOut}</pre>
        </div>
      )}

      {/* ── Automation ── */}
      {tab === 'automation' && (
        <div>
          <ModuleToolbar>
            <button className="mini" disabled={busy || !configured} onClick={loadAutomation}>⟳ {t('modules.refresh')}</button>
          </ModuleToolbar>
          <div className="hosts-edit" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
            <select className="mod-select" style={{ flex: '1 1 240px' }} value={sceneSel} onChange={(e) => setSceneSel(e.target.value)}>
              <option value="">{t('homeassistant.pickScene')}</option>
              {scenes.map((s) => <option key={s.entityId} value={s.entityId}>{s.name}</option>)}
            </select>
            <button className="mini primary" disabled={busy || !configured} onClick={runScene}>{t('homeassistant.runScene')}</button>
          </div>
          <div className="hosts-edit" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
            <select className="mod-select" style={{ flex: '1 1 240px' }} value={scriptSel} onChange={(e) => setScriptSel(e.target.value)}>
              <option value="">{t('homeassistant.pickScript')}</option>
              {scripts.map((s) => <option key={s.entityId} value={s.entityId}>{s.name}</option>)}
            </select>
            <button className="mini" disabled={busy || !configured} onClick={runScript}>{t('homeassistant.runScript')}</button>
          </div>

          <h3 className="group-title" style={{ fontSize: 14, margin: '14px 0 6px' }}>{t('homeassistant.fireEventLbl')}</h3>
          <div className="hosts-edit" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
            <input
              className="mod-search"
              style={{ flex: '1 1 200px' }}
              placeholder="winforge_pc_locked"
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
            />
            <input
              className="mod-search"
              style={{ flex: '1 1 200px', fontFamily: 'monospace' }}
              placeholder={t('homeassistant.eventDataPlaceholder')}
              value={eventData}
              onChange={(e) => setEventData(e.target.value)}
            />
            <button className="mini" disabled={busy || !configured} onClick={fireEvent}>{t('homeassistant.fireEvent')}</button>
          </div>

          <h3 className="group-title" style={{ fontSize: 14, margin: '14px 0 6px' }}>{t('homeassistant.intentLbl')}</h3>
          <div className="hosts-edit" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
            <input
              className="mod-search"
              style={{ flex: '1 1 200px' }}
              placeholder="HassTurnOn"
              value={intentName}
              onChange={(e) => setIntentName(e.target.value)}
            />
            <input
              className="mod-search"
              style={{ flex: '1 1 200px', fontFamily: 'monospace' }}
              placeholder={t('homeassistant.intentDataPlaceholder')}
              value={intentData}
              onChange={(e) => setIntentData(e.target.value)}
            />
            <button className="mini" disabled={busy || !configured} onClick={handleIntent}>{t('homeassistant.handleIntent')}</button>
          </div>
        </div>
      )}

      {/* ── Config ── */}
      {tab === 'config' && (
        <div>
          <p className="count-note" style={{ marginTop: 0 }}>{t('homeassistant.cfgBlurb')}</p>
          <ModuleToolbar>
            <button className="mini primary" disabled={busy || !configured} onClick={checkConfig}>{t('homeassistant.checkConfig')}</button>
            <button className="mini" disabled={busy || !configured} onClick={restart}>{t('homeassistant.restart')}</button>
          </ModuleToolbar>
          <p className="count-note">{t('homeassistant.reloadLbl')}</p>
          <div className="hosts-edit" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select className="mod-select" value={reloadDomain} onChange={(e) => setReloadDomain(e.target.value)}>
              {RELOAD_DOMAINS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <button className="mini" disabled={busy || !configured} onClick={reloadDom}>{t('homeassistant.reloadDomain')}</button>
          </div>
          <div className="hosts-edit" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
            <input
              className="mod-search"
              style={{ flex: '1 1 240px', fontFamily: 'monospace' }}
              placeholder="config_entry_id"
              value={entryId}
              onChange={(e) => setEntryId(e.target.value)}
            />
            <button className="mini" disabled={busy || !configured} onClick={reloadEntry}>{t('homeassistant.reloadEntry')}</button>
          </div>
        </div>
      )}

      {/* ── Notify ── */}
      {tab === 'notify' && (
        <div>
          <ModuleToolbar>
            <button className="mini" disabled={busy || !configured} onClick={loadTargets}>{t('homeassistant.loadTargets')}</button>
            <select className="mod-select" style={{ flex: '1 1 220px' }} value={targetSel} onChange={(e) => setTargetSel(e.target.value)}>
              <option value="">{t('homeassistant.pickTarget')}</option>
              {targets.map((tg) => <option key={tg} value={tg}>{tg}</option>)}
            </select>
          </ModuleToolbar>
          <input
            className="mod-search"
            style={{ width: '100%', marginTop: 8 }}
            placeholder={t('homeassistant.notifyTitle')}
            value={notifyTitle}
            onChange={(e) => setNotifyTitle(e.target.value)}
          />
          <textarea
            className="mod-search"
            style={{ width: '100%', minHeight: 60, marginTop: 8 }}
            placeholder={t('homeassistant.notifyMessage')}
            value={notifyMsg}
            onChange={(e) => setNotifyMsg(e.target.value)}
          />
          <div style={{ marginTop: 8 }}>
            <button className="mini primary" disabled={busy || !configured} onClick={pushNotify}>{t('homeassistant.push')}</button>
          </div>
        </div>
      )}

      {/* ── Camera ── */}
      {tab === 'camera' && (
        <div>
          <ModuleToolbar>
            <button className="mini" disabled={busy || !configured} onClick={loadCameras}>⟳ {t('modules.refresh')}</button>
            <select className="mod-select" style={{ flex: '1 1 220px' }} value={cameraSel} onChange={(e) => setCameraSel(e.target.value)}>
              <option value="">{t('homeassistant.noCamera')}</option>
              {cameras.map((c) => <option key={c.entityId} value={c.entityId}>{c.name}</option>)}
            </select>
            <button className="mini primary" disabled={busy || !configured} onClick={snapCamera}>{t('homeassistant.snapshot')}</button>
            <button className="mini" disabled={!snapUrl} onClick={saveSnap}>{t('homeassistant.saveSnapshot')}</button>
          </ModuleToolbar>
          <div style={{ border: '1px solid var(--border, #333)', borderRadius: 6, padding: 6, marginTop: 8, minHeight: 180, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {snapUrl ? (
              <img src={snapUrl} alt="camera snapshot" style={{ maxWidth: '100%', maxHeight: 360 }} />
            ) : (
              <span className="count-note" style={{ margin: 0 }}>{t('homeassistant.noSnapshot')}</span>
            )}
          </div>
        </div>
      )}

      {/* ── Calendar ── */}
      {tab === 'calendar' && (
        <div>
          <ModuleToolbar>
            <button className="mini" disabled={busy || !configured} onClick={loadCalendars}>{t('homeassistant.loadCalendars')}</button>
            <select className="mod-select" style={{ flex: '1 1 220px' }} value={calendarSel} onChange={(e) => setCalendarSel(e.target.value)}>
              <option value="">{t('homeassistant.pickCalendar')}</option>
              {calendars.map((c) => <option key={c.entityId} value={c.entityId}>{c.name}</option>)}
            </select>
            <button className="mini primary" disabled={busy || !configured} onClick={loadToday}>{t('homeassistant.today')}</button>
          </ModuleToolbar>
          {calEvents.length === 0 ? (
            <p className="count-note" style={{ marginTop: 10 }}>{t('modules.noRows')}</p>
          ) : (
            <div className="dt-wrap" style={{ marginTop: 10 }}>
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ width: 170 }}>{t('homeassistant.colStart')}</th>
                    <th>{t('homeassistant.colSummary')}</th>
                  </tr>
                </thead>
                <tbody>
                  {calEvents.map((ev, i) => (
                    <tr key={i}>
                      <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{ev.start}</td>
                      <td>{ev.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── AC Defender ── */}
      {tab === 'acdefender' && (
        <div>
          <p className="count-note" style={{ marginTop: 0 }}>{t('homeassistant.acBlurb')}</p>
          <div className="hosts-edit" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
            <input className="mod-search" style={{ flex: '1 1 180px' }} placeholder={t('homeassistant.acProject')} value={acProject} onChange={(e) => setAcProject(e.target.value)} />
            <input className="mod-search" style={{ flex: '1 1 180px', fontFamily: 'monospace' }} placeholder="climate.living_room" value={acClimate} onChange={(e) => setAcClimate(e.target.value)} />
            <input className="mod-search" style={{ flex: '0 1 110px' }} placeholder={t('homeassistant.acPoll')} value={acPoll} onChange={(e) => setAcPoll(e.target.value)} />
          </div>
          <div className="hosts-edit" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
            <label className="count-note" style={{ margin: 0 }}>{t('homeassistant.acCoolAbove')}
              <input className="mod-search" style={{ width: 80, marginLeft: 6 }} value={acCoolAbove} onChange={(e) => setAcCoolAbove(e.target.value)} />
            </label>
            <label className="count-note" style={{ margin: 0 }}>{t('homeassistant.acHeatBelow')}
              <input className="mod-search" style={{ width: 80, marginLeft: 6 }} value={acHeatBelow} onChange={(e) => setAcHeatBelow(e.target.value)} />
            </label>
            <label className="count-note" style={{ margin: 0 }}>
              <input type="checkbox" checked={acDryRun} onChange={(e) => setAcDryRun(e.target.checked)} style={{ marginRight: 6 }} />
              {t('homeassistant.acDryRun')}
            </label>
          </div>
          <div className="hosts-edit" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
            <select className="mod-select" value={acFile} onChange={(e) => setAcFile(e.target.value as typeof acFile)}>
              <option value="compose">docker-compose.yml</option>
              <option value="dockerfile">Dockerfile</option>
              <option value="python">ac_defender.py</option>
              <option value="readme">README.md</option>
              <option value="deploy">deploy-ssh.sh</option>
            </select>
            <button className="mini primary" onClick={acGenerate}>{t('homeassistant.acGenerate')}</button>
            <button className="mini" onClick={acDownload}>{t('homeassistant.acDownload')}</button>
          </div>
          <pre className="cmd-out" style={{ whiteSpace: 'pre', overflow: 'auto', maxHeight: 380 }}>{acOut}</pre>
        </div>
      )}

      {/* ── Error log ── */}
      {tab === 'log' && (
        <div>
          <ModuleToolbar>
            <button className="mini primary" disabled={busy || !configured} onClick={tailLog}>{t('homeassistant.tailLog')}</button>
            <button className="mini" disabled={!logOut} onClick={() => { void navigator.clipboard?.writeText(logOut); }}>{t('homeassistant.copy')}</button>
          </ModuleToolbar>
          <pre className="cmd-out" style={{ whiteSpace: 'pre-wrap', maxHeight: 420, overflow: 'auto' }}>{logOut}</pre>
        </div>
      )}
    </div>
  );
}

function readDateOrTime(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.dateTime === 'string') return o.dateTime;
    if (typeof o.date === 'string') return o.date;
  }
  return '';
}

function round2(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

function Sparkline({ pts }: { pts: number[] }) {
  const w = 880;
  const h = 56;
  const pad = 4;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = Math.abs(max - min) < 1e-9 ? 1 : max - min;
  const step = pts.length > 1 ? (w - 2 * pad) / (pts.length - 1) : 0;
  const path = pts
    .map((v, i) => {
      const x = pad + i * step;
      const y = pad + (1 - (v - min) / range) * (h - 2 * pad);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" style={{ display: 'block' }}>
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}
