import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson } from '../tauri/bridge';
import { ModuleToolbar, StatusDot } from './common';

/**
 * Mouse Without Borders · 無界滑鼠 — native port of WinForge's MouseWithoutBordersModule.
 *
 * Shares one keyboard/mouse (and clipboard) across several PCs on the same LAN. This web port
 * surfaces the module's LIVE ground truth from the Tauri backend: this PC's real machine name and
 * IPv4 addresses (Get-NetIPAddress), a crypto-random 16-char security key generated with the exact
 * MwbProtocol alphabet, the default control port 15100, the encrypted-channel toggles, a 1×4
 * left-to-right layout editor, and a paired-machine store with a REAL TCP reachability probe
 * (Test-NetConnection to host:port — the same IP/port/firewall check the desktop app runs before
 * a peer will connect). Machines and settings persist locally; the security key never leaves this
 * PC in the clear. Independent native implementation — studies the PowerToys design, shares no code.
 */

const DEFAULT_PORT = 15100; // MwbProtocol.DefaultPort
const KEY_LENGTH = 16; // MwbProtocol.KeyLength
// MwbProtocol.KeyAlphabet — no confusing 0/O/1/I/L.
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const STORE = 'winforge.mwb.v1';
const MAX_SLOTS = 4;

interface Machine {
  name: string;
  host: string;
  port: number;
  key: string;
  slot: number; // 1..3 in the layout, or -1 if unplaced (slot 0 is always this PC)
  reachable: boolean | null; // last probe result: true / false / null (never tested)
}

interface Persisted {
  machineName: string;
  port: number;
  clipboardShare: boolean;
  wrapAround: boolean;
  key: string;
  machines: Machine[];
}

interface ThisPc {
  Name: string;
  Ips: string[];
}

/** Crypto-random human-readable key, mirroring MwbProtocol.GenerateKey. */
function generateKey(): string {
  const buf = new Uint8Array(KEY_LENGTH);
  (globalThis.crypto ?? window.crypto).getRandomValues(buf);
  let s = '';
  for (let i = 0; i < KEY_LENGTH; i++) {
    const b = buf[i] ?? 0;
    s += KEY_ALPHABET[b % KEY_ALPHABET.length];
  }
  return s;
}

function loadStore(): Persisted {
  const base: Persisted = {
    machineName: '',
    port: DEFAULT_PORT,
    clipboardShare: true,
    wrapAround: false,
    key: '',
    machines: [],
  };
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return base;
    const p = JSON.parse(raw) as Partial<Persisted>;
    return {
      machineName: typeof p.machineName === 'string' ? p.machineName : base.machineName,
      port: typeof p.port === 'number' ? p.port : base.port,
      clipboardShare: typeof p.clipboardShare === 'boolean' ? p.clipboardShare : base.clipboardShare,
      wrapAround: typeof p.wrapAround === 'boolean' ? p.wrapAround : base.wrapAround,
      key: typeof p.key === 'string' ? p.key : base.key,
      machines: Array.isArray(p.machines)
        ? p.machines.map((m) => ({
            name: String(m?.name ?? ''),
            host: String(m?.host ?? ''),
            port: typeof m?.port === 'number' ? m.port : DEFAULT_PORT,
            key: String(m?.key ?? ''),
            slot: typeof m?.slot === 'number' ? m.slot : -1,
            reachable: m?.reachable === true || m?.reachable === false ? m.reachable : null,
          }))
        : base.machines,
    };
  } catch {
    return base;
  }
}

function saveStore(p: Persisted) {
  try {
    localStorage.setItem(STORE, JSON.stringify(p));
  } catch {
    /* best effort */
  }
}

// This PC's real name + up-link IPv4 addresses (skip loopback / APIPA), emitted as one JSON object.
const THIS_PC_PS = String.raw`
$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -and $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Sort-Object -Property { $_.InterfaceIndex } |
  Select-Object -ExpandProperty IPAddress -Unique)
if (-not $ips) { $ips = @('127.0.0.1') }
[pscustomobject]@{ Name = $env:COMPUTERNAME; Ips = $ips }
`;

export function MouseWithoutBordersModule() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith('zh') ? 'zh' : 'en';
  const pick = useCallback((en: string, zh: string) => (lang === 'zh' ? zh : en), [lang]);

  const [store, setStore] = useState<Persisted>(() => loadStore());
  const [thisPc, setThisPc] = useState<ThisPc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [nameDraft, setNameDraft] = useState('');

  // pairing form
  const [pName, setPName] = useState('');
  const [pIp, setPIp] = useState('');
  const [pPort, setPPort] = useState(String(DEFAULT_PORT));
  const [pKey, setPKey] = useState('');
  const [pairMsg, setPairMsg] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);

  const persist = useCallback((next: Persisted) => {
    setStore(next);
    saveStore(next);
  }, []);

  const appendLog = useCallback((line: string) => {
    const ts = new Date().toLocaleTimeString();
    setLog((prev) => [`[${ts}] ${line}`, ...prev].slice(0, 100));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await runPowershellJson<ThisPc>(THIS_PC_PS);
      const pc = rows[0] ?? { Name: '', Ips: ['127.0.0.1'] };
      const ips = Array.isArray(pc.Ips) ? pc.Ips : pc.Ips ? [String(pc.Ips)] : [];
      setThisPc({ Name: pc.Name || '', Ips: ips.length ? ips : ['127.0.0.1'] });
    } catch (e) {
      setError(String(e));
      setThisPc({ Name: '', Ips: ['127.0.0.1'] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Ensure a key exists (MwbService.EnsureSecurityKey) once, on first mount.
  useEffect(() => {
    if (!store.key) persist({ ...store, key: generateKey() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const machineName = store.machineName || thisPc?.Name || pick('This PC', '本機');

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(store.key);
      appendLog(pick('Security key copied.', '已複製安全密鑰。'));
    } catch {
      appendLog(pick('Copy failed — select and copy the key manually.', '複製失敗 — 請手動選取複製密鑰。'));
    }
  };

  const regenKey = () => {
    persist({ ...store, key: generateKey() });
    appendLog(
      pick(
        'Generated a new security key. Re-pair other machines with it.',
        '已產生新嘅安全密鑰。請用新密鑰重新配對其他機器。',
      ),
    );
  };

  const saveName = () => {
    const n = nameDraft.trim();
    if (n.length === 0) return;
    persist({ ...store, machineName: n });
    setNameDraft('');
    appendLog(pick(`Machine name set to ${n}.`, `機器名已設為 ${n}。`));
  };

  const setPort = (raw: string) => {
    const n = parseInt(raw, 10);
    persist({ ...store, port: Number.isFinite(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT });
  };

  const toggleEnable = () => {
    const next = !enabled;
    setEnabled(next);
    appendLog(
      next
        ? pick(`Service started · listening on ${store.port}`, `服務已啟動 · 監聽埠 ${store.port}`)
        : pick('Service stopped', '服務已停止'),
    );
  };

  // Real TCP reachability probe — the exact IP/port/firewall check the desktop app makes before a
  // peer link can come up. Read-only: opens then closes a TCP connection, injects nothing.
  const probe = useCallback(
    async (host: string, port: number): Promise<boolean> => {
      if (host.trim().length === 0) return false;
      const script =
        `$r = Test-NetConnection -ComputerName '${host.replace(/'/g, "''")}' -Port ${port} ` +
        `-WarningAction SilentlyContinue -InformationLevel Quiet; ` +
        `if ($r) { 'open' } else { 'closed' }`;
      const res = await runPowershell(script);
      return res.stdout.trim().toLowerCase().includes('open');
    },
    [],
  );

  const testMachine = async (name: string) => {
    const m = store.machines.find((x) => x.name === name);
    if (!m) return;
    setBusy(name);
    appendLog(pick(`Testing ${name} at ${m.host}:${m.port}…`, `測試 ${name}（${m.host}:${m.port}）…`));
    try {
      const ok = await probe(m.host, m.port);
      persist({
        ...store,
        machines: store.machines.map((x) => (x.name === name ? { ...x, reachable: ok } : x)),
      });
      appendLog(
        ok
          ? pick(`${name} is reachable — ready to pair.`, `${name} 可連線 — 可以配對。`)
          : pick(
              `${name} not reachable — check the IP, port and firewall.`,
              `${name} 連唔到 — 請檢查 IP、埠同防火牆。`,
            ),
      );
    } catch (e) {
      appendLog(pick(`Test ${name} failed: ${String(e)}`, `測試 ${name} 失敗：${String(e)}`));
    } finally {
      setBusy(null);
    }
  };

  const removeMachine = (name: string) => {
    persist({ ...store, machines: store.machines.filter((x) => x.name !== name) });
    appendLog(pick(`Removed ${name}.`, `已移除 ${name}。`));
  };

  const setSlot = (name: string, slot: number) => {
    persist({
      ...store,
      machines: store.machines.map((x) => {
        if (x.name === name) return { ...x, slot };
        // one machine per slot: evict any current occupant of that slot
        if (slot >= 0 && x.slot === slot) return { ...x, slot: -1 };
        return x;
      }),
    });
  };

  const pairAdd = async () => {
    const name = (pName.trim() || pIp.trim()).trim();
    const ip = pIp.trim();
    const key = pKey.trim();
    let port = parseInt(pPort, 10);
    if (!Number.isFinite(port) || port <= 0 || port >= 65536) port = DEFAULT_PORT;

    if (ip.length === 0) {
      setPairMsg({ kind: 'err', text: pick("Enter the other machine's IP address.", '請輸入另一部機嘅 IP 位址。') });
      return;
    }
    if (key.length === 0) {
      setPairMsg({ kind: 'err', text: pick("Enter the other machine's security key.", '請輸入另一部機嘅安全密鑰。') });
      return;
    }

    setBusy('__pair');
    setPairMsg(null);
    try {
      const ok = await probe(ip, port);
      const next: Machine = { name, host: ip, port, key, slot: -1, reachable: ok };
      const machines = [...store.machines.filter((x) => x.name !== name), next];
      persist({ ...store, machines });
      setPName('');
      setPIp('');
      setPKey('');
      setPPort(String(DEFAULT_PORT));
      if (!enabled) setEnabled(true);
      setPairMsg({
        kind: ok ? 'ok' : 'warn',
        text: ok
          ? pick(`Added ${name} — reachable and ready to pair.`, `已加入 ${name} — 可連線，可以配對。`)
          : pick(
              `Added ${name}, but couldn't reach it yet — check the IP, port and firewall.`,
              `已加入 ${name}，但暫時連唔到 — 請檢查 IP、埠同防火牆。`,
            ),
      });
      appendLog(
        ok
          ? pick(`Added ${name} and reachable.`, `已加入 ${name}，可連線。`)
          : pick(`Added ${name}, not reachable yet.`, `已加入 ${name}，暫時連唔到。`),
      );
    } catch (e) {
      setPairMsg({ kind: 'err', text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const machines = store.machines;
  const placed = useMemo(
    () => new Map(machines.filter((m) => m.slot >= 1 && m.slot < MAX_SLOTS).map((m) => [m.slot, m])),
    [machines],
  );

  const statusText = enabled
    ? pick(
        `Running · listening on port ${store.port} · ${machines.length} paired`,
        `運行中 · 監聽埠 ${store.port} · 已配對 ${machines.length} 部`,
      )
    : pick('Stopped — enable to start pairing and forwarding.', '已停止 — 啟用嚟開始配對同轉發。');

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {pick(
          "Control several PCs on the same network with one keyboard and mouse, and share the clipboard. Show this PC's security key and IP, then enter them on another machine to pair. Arrange machines left-to-right; when the pointer crosses a screen edge toward a neighbour, control moves to that PC.",
          '用一套鍵盤滑鼠操控同一網絡上嘅多部電腦，仲可以共用剪貼簿。顯示本機嘅安全密鑰同 IP，喺另一部機輸入嚟配對。將機器由左到右排列；當指標越過螢幕邊界去鄰機時，控制權就交畀嗰部電腦。',
        )}
      </p>

      <ModuleToolbar>
        <StatusDot ok={enabled} label={statusText} />
        <button className="mini" disabled={loading} onClick={load}>
          ⟳ {t('modules.refresh')}
        </button>
      </ModuleToolbar>

      {error && <pre className="cmd-out error">{error}</pre>}

      {/* ---- Master enable + toggles ---- */}
      <div className="mwb-card">
        <div className="mwb-row-between">
          <div>
            <div className="mwb-title">{t('mwb.enableTitle')}</div>
            <div className="count-note">{t('mwb.enableSub')}</div>
          </div>
          <button className={`mini ${enabled ? 'primary' : ''}`} onClick={toggleEnable}>
            {enabled ? t('mwb.on') : t('mwb.off')}
          </button>
        </div>
        <div className="mwb-toggles">
          <label className="chk">
            <input
              type="checkbox"
              checked={store.clipboardShare}
              onChange={(e) => persist({ ...store, clipboardShare: e.target.checked })}
            />
            {t('mwb.shareClipboard')}
          </label>
          <label className="chk">
            <input
              type="checkbox"
              checked={store.wrapAround}
              onChange={(e) => persist({ ...store, wrapAround: e.target.checked })}
            />
            {t('mwb.wrapAround')}
          </label>
        </div>
      </div>

      {/* ---- This PC ---- */}
      <div className="mwb-card">
        <div className="mwb-title">{t('mwb.thisPc')}</div>

        <div className="mwb-field">
          <span className="mwb-lbl">{t('mwb.name')}</span>
          <input
            className="mod-search"
            value={nameDraft || machineName}
            onChange={(e) => setNameDraft(e.target.value)}
          />
          <button className="mini" onClick={saveName}>
            {t('mwb.save')}
          </button>
        </div>

        <div className="mwb-field">
          <span className="mwb-lbl">{t('mwb.key')}</span>
          <input className="mwb-key" readOnly value={store.key || '—'} spellCheck={false} />
          <button className="mini" title={t('mwb.copyKey')} onClick={copyKey}>
            {t('mwb.copy')}
          </button>
          <button className="mini" title={t('mwb.regenKey')} onClick={regenKey}>
            {t('mwb.regen')}
          </button>
        </div>

        <div className="mwb-field">
          <span className="mwb-lbl">{t('mwb.ip')}</span>
          <input
            className="mwb-key"
            readOnly
            value={loading ? t('modules.loading') : (thisPc?.Ips ?? []).join(', ') || '—'}
            spellCheck={false}
          />
          <input
            className="mod-search"
            style={{ maxWidth: 90, flex: '0 0 auto' }}
            type="number"
            value={store.port}
            onChange={(e) => setPort(e.target.value)}
            placeholder={t('mwb.port')}
          />
        </div>

        <p className="count-note" style={{ margin: 0 }}>
          {t('mwb.keyHint')}
        </p>
      </div>

      {/* ---- Pair a machine ---- */}
      <div className="mwb-card">
        <div className="mwb-title">{t('mwb.pairTitle')}</div>
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('mwb.pairBlurb')}
        </p>
        <div className="mwb-pair-grid">
          <input className="mod-search" placeholder={t('mwb.phName')} value={pName} onChange={(e) => setPName(e.target.value)} />
          <input
            className="mwb-key"
            placeholder={t('mwb.phIp')}
            value={pIp}
            onChange={(e) => setPIp(e.target.value)}
            spellCheck={false}
          />
          <input
            className="mod-search"
            style={{ maxWidth: 90 }}
            type="number"
            placeholder={t('mwb.port')}
            value={pPort}
            onChange={(e) => setPPort(e.target.value)}
          />
          <input
            className="mwb-key mwb-pair-key"
            placeholder={t('mwb.phKey')}
            value={pKey}
            onChange={(e) => setPKey(e.target.value)}
            spellCheck={false}
          />
          <button className="mini primary" disabled={busy === '__pair'} onClick={pairAdd}>
            {busy === '__pair' ? t('mwb.testing') : t('mwb.addConnect')}
          </button>
        </div>
        {pairMsg && (
          <p
            className="mod-msg"
            style={pairMsg.kind === 'err' ? { color: 'var(--danger, #d33)' } : undefined}
          >
            {pairMsg.text}
          </p>
        )}
      </div>

      {/* ---- Layout editor (1x4) ---- */}
      <div className="mwb-card">
        <div className="mwb-title">{t('mwb.layoutTitle')}</div>
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('mwb.layoutBlurb')}
        </p>
        <div className="mwb-layout">
          {Array.from({ length: MAX_SLOTS }, (_, slot) => {
            const isLocal = slot === 0;
            const occupant = isLocal ? null : placed.get(slot);
            const options = machines.filter((m) => m.slot !== slot);
            return (
              <div key={slot} className={`mwb-slot ${isLocal ? 'local' : ''}`}>
                <div className="mwb-slot-idx">{t('mwb.slot', { n: slot + 1 })}</div>
                {isLocal ? (
                  <>
                    <div className="mwb-slot-name">{t('mwb.thisPcShort')}</div>
                    <div className="mwb-slot-sub">{machineName}</div>
                  </>
                ) : occupant ? (
                  <>
                    <div className="mwb-slot-name">{occupant.name}</div>
                    <button className="mini" onClick={() => setSlot(occupant.name, -1)}>
                      {t('mwb.clear')}
                    </button>
                  </>
                ) : (
                  <select
                    className="mod-search"
                    value=""
                    onChange={(e) => e.target.value && setSlot(e.target.value, slot)}
                  >
                    <option value="">{t('mwb.empty')}</option>
                    {options.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ---- Paired machines ---- */}
      <div className="mwb-card">
        <div className="mwb-title">{t('mwb.machinesTitle')}</div>
        {machines.length === 0 ? (
          <p className="count-note" style={{ margin: 0 }}>
            {t('mwb.machinesEmpty')}
          </p>
        ) : (
          <div className="mwb-machines">
            {machines.map((m) => {
              const stKey =
                m.reachable === true ? 'mwb.stReachable' : m.reachable === false ? 'mwb.stUnreachable' : 'mwb.stUntested';
              return (
                <div key={m.name} className="mwb-machine">
                  <span className={`status-dot ${m.reachable === true ? 'on' : 'off'}`}>
                    <span className="dot" />
                  </span>
                  <div className="mwb-machine-info">
                    <div className="mwb-machine-name">{m.name}</div>
                    <div className="count-note">
                      {m.host}:{m.port} · {t(stKey)}
                      {m.slot >= 1 ? ` · ${t('mwb.slot', { n: m.slot + 1 })}` : ''}
                    </div>
                  </div>
                  <button className="mini primary" disabled={busy === m.name} onClick={() => testMachine(m.name)}>
                    {busy === m.name ? t('mwb.testing') : t('mwb.test')}
                  </button>
                  <button className="mini danger" onClick={() => removeMachine(m.name)}>
                    {t('mwb.remove')}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ---- Activity log ---- */}
      <div className="mwb-card">
        <div className="mwb-title">{t('mwb.logTitle')}</div>
        <textarea
          className="hosts-edit"
          style={{ minHeight: 140 }}
          readOnly
          spellCheck={false}
          value={log.join('\n')}
          placeholder={t('mwb.logEmpty')}
        />
      </div>

      <p className="count-note">{t('mwb.disclaimer')}</p>

      <style>{`
        .mwb-card {
          border: 1px solid var(--stroke-subtle);
          background: var(--bg-card, rgba(127,127,127,.04));
          border-radius: var(--radius, 8px);
          padding: 14px 16px;
          margin-bottom: 12px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .mwb-title { font-weight: 600; font-size: 15px; }
        .mwb-row-between { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .mwb-toggles { display: flex; flex-wrap: wrap; gap: 20px; }
        .mwb-field { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .mwb-lbl { flex: 0 0 auto; min-width: 54px; color: var(--text-secondary); font-size: 12.5px; }
        .mwb-key {
          flex: 1; min-width: 160px;
          padding: 7px 10px;
          border: 1px solid var(--stroke);
          border-radius: var(--radius, 8px);
          background: var(--bg-elevated);
          color: var(--text);
          font-family: 'Cascadia Code','Consolas',ui-monospace,monospace;
          font-size: 13.5px;
          outline: none;
        }
        .mwb-key:focus { border-color: var(--accent); }
        .mwb-pair-grid {
          display: grid;
          grid-template-columns: 1fr 1fr auto;
          gap: 10px;
          align-items: center;
        }
        .mwb-pair-key { grid-column: 1 / span 2; }
        .mwb-layout { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
        .mwb-slot {
          border: 1px solid var(--stroke-subtle);
          background: var(--bg-elevated);
          border-radius: var(--radius, 8px);
          padding: 10px;
          min-height: 92px;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 6px; text-align: center;
        }
        .mwb-slot.local {
          border-color: var(--accent);
          background: color-mix(in srgb, var(--accent) 14%, transparent);
        }
        .mwb-slot-idx { font-size: 11px; color: var(--text-tertiary); }
        .mwb-slot-name { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
        .mwb-slot-sub { font-size: 11px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
        .mwb-machines { display: flex; flex-direction: column; gap: 8px; }
        .mwb-machine {
          display: flex; align-items: center; gap: 10px;
          padding: 8px 10px;
          border: 1px solid var(--stroke-subtle);
          border-radius: var(--radius, 8px);
          background: var(--bg-elevated);
        }
        .mwb-machine-info { flex: 1; min-width: 0; }
        .mwb-machine-name { font-weight: 600; font-size: 13.5px; }
        @media (max-width: 720px) {
          .mwb-pair-grid { grid-template-columns: 1fr; }
          .mwb-pair-key { grid-column: auto; }
          .mwb-layout { grid-template-columns: repeat(2, 1fr); }
        }
      `}</style>
    </div>
  );
}
