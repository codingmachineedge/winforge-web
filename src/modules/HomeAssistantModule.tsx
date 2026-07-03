import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell } from '../tauri/bridge';
import { Column, DataTable, ModuleToolbar, StatusDot } from './common';

// ── Config persistence (browser-native; base URL + long-lived token) ──────────
const URL_KEY = 'winforge.ha.baseUrl';
const TOKEN_KEY = 'winforge.ha.token';

function loadCfg(): { url: string; token: string } {
  try {
    return {
      url: localStorage.getItem(URL_KEY) ?? '',
      token: localStorage.getItem(TOKEN_KEY) ?? '',
    };
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

function b64(s: string): string {
  // btoa needs latin1; encode UTF-8 first so non-ASCII survives.
  return btoa(unescape(encodeURIComponent(s)));
}

/**
 * One HA REST call. Runs Invoke-RestMethod on the backend (no CORS, native TLS).
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
  const bodyLine = jsonBody != null ? `$body = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(jsonBody)}'))` : '$body = $null';
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
  const body = idx >= 0 ? out.slice(idx + marker.length).replace(/^\r?\n/, '') : (res.stderr || out);
  const ok = status >= 200 && status < 300;
  return { ok, status, body: body.trimEnd() };
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

function jstr(s: string): string {
  return JSON.stringify(s);
}

type TabKey =
  | 'devices'
  | 'states'
  | 'template'
  | 'automation'
  | 'config'
  | 'notify'
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
      localStorage.setItem(TOKEN_KEY, next.token);
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
      const all = parseStates(r.body).filter((e) =>
        e.domain === 'light' || e.domain === 'switch' || e.domain === 'input_boolean',
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
    const list = q
      ? toggles.filter((e) => `${e.name} ${e.entityId}`.toLowerCase().includes(q))
      : toggles;
    return {
      lights: list.filter((e) => e.domain === 'light'),
      plugs: list.filter((e) => e.domain !== 'light'),
    };
  }, [toggles, toggleFilter]);

  useEffect(() => {
    if (configured && tab === 'devices' && toggles.length === 0) void loadToggles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, tab]);

  // ── States list / history sparkline / set state ────────────────────────────
  const [entities, setEntities] = useState<HaEntity[]>([]);
  const [stFilter, setStFilter] = useState('');
  const [histId, setHistId] = useState('');
  const [spark, setSpark] = useState<{ pts: number[]; min: number; max: number; note: string } | null>(null);
  const [setVal, setSetVal] = useState('');

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
    setBusy(true);
    try {
      const r = await haCall(cfg, 'POST', `/api/states/${id}`, `{"state":${jstr(setVal)}}`);
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

  // ── Automation: scenes / scripts / events ──────────────────────────────────
  const [scenes, setScenes] = useState<HaEntity[]>([]);
  const [scripts, setScripts] = useState<HaEntity[]>([]);
  const [sceneSel, setSceneSel] = useState('');
  const [scriptSel, setScriptSel] = useState('');
  const [eventType, setEventType] = useState('');

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
    setBusy(true);
    try {
      const r = await haCall(cfg, 'POST', `/api/events/${type}`);
      say(r.ok, r.ok ? t('homeassistant.eventFired') : `${t('homeassistant.actionFailed', { status: r.status })}: ${r.body.slice(0, 160)}`);
    } finally {
      setBusy(false);
    }
  };

  // ── Config: check / restart / reload ───────────────────────────────────────
  const [reloadDomain, setReloadDomain] = useState(RELOAD_DOMAINS[0]!);

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

  // ── Error log ──────────────────────────────────────────────────────────────
  const [logOut, setLogOut] = useState('');

  const tailLog = async () => {
    setBusy(true);
    setLogOut(t('homeassistant.rendering'));
    try {
      const r = await haCall(cfg, 'GET', '/api/error_log');
      setLogOut(r.ok ? (r.body.trim() || t('homeassistant.logEmpty')) : `[HTTP ${r.status}] ${r.body}`);
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

      {banner && (
        <p className={`mod-msg ${banner.ok ? '' : 'error'}`}>{banner.text}</p>
      )}

      {/* Tabs */}
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        {tabs.map((tb) => (
          <button
            key={tb.key}
            className={tab === tb.key ? 'mini primary' : 'mini'}
            onClick={() => setTab(tb.key)}
          >
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

          <h3 className="group-title" style={{ fontSize: 14, margin: "16px 0 6px" }}>{t('homeassistant.groupLights')}</h3>
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

          <h3 className="group-title" style={{ fontSize: 14, margin: "16px 0 6px" }}>{t('homeassistant.groupPlugs')}</h3>
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
              style={{ flex: '0 1 160px' }}
              placeholder={t('homeassistant.stateValue')}
              value={setVal}
              onChange={(e) => setSetVal(e.target.value)}
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
            <select className="mod-search" style={{ flex: '1 1 240px' }} value={sceneSel} onChange={(e) => setSceneSel(e.target.value)}>
              <option value="">{t('homeassistant.pickScene')}</option>
              {scenes.map((s) => <option key={s.entityId} value={s.entityId}>{s.name}</option>)}
            </select>
            <button className="mini primary" disabled={busy || !configured} onClick={runScene}>{t('homeassistant.runScene')}</button>
          </div>
          <div className="hosts-edit" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
            <select className="mod-search" style={{ flex: '1 1 240px' }} value={scriptSel} onChange={(e) => setScriptSel(e.target.value)}>
              <option value="">{t('homeassistant.pickScript')}</option>
              {scripts.map((s) => <option key={s.entityId} value={s.entityId}>{s.name}</option>)}
            </select>
            <button className="mini" disabled={busy || !configured} onClick={runScript}>{t('homeassistant.runScript')}</button>
          </div>
          <div className="hosts-edit" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
            <input
              className="mod-search"
              style={{ flex: '1 1 240px' }}
              placeholder="winforge_pc_locked"
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
            />
            <button className="mini" disabled={busy || !configured} onClick={fireEvent}>{t('homeassistant.fireEvent')}</button>
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
            <select className="mod-search" value={reloadDomain} onChange={(e) => setReloadDomain(e.target.value)}>
              {RELOAD_DOMAINS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <button className="mini" disabled={busy || !configured} onClick={reloadDom}>{t('homeassistant.reloadDomain')}</button>
          </div>
        </div>
      )}

      {/* ── Notify ── */}
      {tab === 'notify' && (
        <div>
          <ModuleToolbar>
            <button className="mini" disabled={busy || !configured} onClick={loadTargets}>{t('homeassistant.loadTargets')}</button>
            <select className="mod-search" style={{ flex: '1 1 220px' }} value={targetSel} onChange={(e) => setTargetSel(e.target.value)}>
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
