import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native Torrent · 原生種子下載
//
// The WinForge desktop module embeds MonoTorrent — a fully-managed BitTorrent
// protocol engine (DHT / LSD / PEX / UDP+HTTP trackers) running in-process. The
// browser has no such engine, so the faithful native port drives aria2c (aria2),
// a real BitTorrent client CLI, through the desktop backend: add magnet links or
// .torrent files, download to a save folder with DHT / peer-exchange, cap the
// up/down rates, choose the listen port, and open the finished folder. Everything
// is gated on the aria2 dependency and guarded so it never throws.

type Mode = 'magnet' | 'file';

const CACHE_ROOT = '%LOCALAPPDATA%\\WinForge\\torrent';

// Sanitise a numeric text field into a clamped integer.
function clampInt(text: string, lo: number, hi: number, fallback: number): number {
  const n = parseInt(text, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

export function TorrentModule() {
  const { t } = useTranslation();

  const [mode, setMode] = useState<Mode>('magnet');
  const [magnet, setMagnet] = useState('');
  const [torrentPath, setTorrentPath] = useState('');
  const [savePath, setSavePath] = useState('%USERPROFILE%\\Downloads\\WinForge');

  // Global settings (mirror of the MonoTorrent engine settings).
  const [maxDown, setMaxDown] = useState('0'); // KiB/s, 0 = unlimited
  const [maxUp, setMaxUp] = useState('0'); // KiB/s, 0 = unlimited
  const [maxConn, setMaxConn] = useState('200');
  const [listenPort, setListenPort] = useState('55123');
  const [dht, setDht] = useState(true);
  const [seq, setSeq] = useState(false);
  const [seedAfter, setSeedAfter] = useState(false);

  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // Build the aria2c argument vector from the current settings + source.
  const buildArgs = (): string[] | null => {
    const dir = savePath.trim() || '%USERPROFILE%\\Downloads\\WinForge';
    const port = clampInt(listenPort, 1, 65535, 55123);
    const conn = clampInt(maxConn, 10, 2000, 200);
    const dn = clampInt(maxDown, 0, 1_000_000, 0);
    const up = clampInt(maxUp, 0, 1_000_000, 0);

    const args: string[] = [
      '--dir', dir,
      '--enable-dht=' + (dht ? 'true' : 'false'),
      '--enable-dht6=' + (dht ? 'true' : 'false'),
      '--enable-peer-exchange=true',
      '--bt-enable-lpd=true',
      '--listen-port', String(port),
      '--dht-listen-port', String(port),
      '--max-overall-download-limit=' + (dn > 0 ? `${dn}K` : '0'),
      '--max-overall-upload-limit=' + (up > 0 ? `${up}K` : '0'),
      '--max-connection-per-server', String(Math.min(16, conn)),
      '--bt-max-peers', String(conn),
      '--seed-time=' + (seedAfter ? '0' : '0'),
      '--summary-interval=0',
      '--console-log-level=notice',
      '--dht-file-path=' + CACHE_ROOT + '\\dht.dat',
      '--bt-save-metadata=true',
      '--check-integrity=true',
    ];
    if (!seedAfter) args.push('--seed-ratio=0.0');
    if (seq) args.push('--bt-prioritize-piece=head,tail');

    if (mode === 'magnet') {
      const m = magnet.trim();
      if (!m) return null;
      args.push(m);
    } else {
      const f = torrentPath.trim();
      if (!f) return null;
      // aria2c treats a .torrent path as a torrent input directly.
      args.push(f);
    }
    return args;
  };

  const run = async (path: string) => {
    const args = buildArgs();
    if (!args) {
      setErr(t('torrentn.errNoSource'));
      return;
    }
    setBusy(true);
    setErr(null);
    setStatus(null);
    setOut('> aria2c ' + args.join(' ') + '\n');
    try {
      const res: CommandOutput = await runCommand(path, args);
      const text = res.stdout || res.stderr || t('torrentn.noOutput', { code: res.code });
      setOut(text);
      setStatus(res.success ? t('torrentn.doneOk') : t('torrentn.doneErr', { code: res.code }));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  // Fetch metadata / list files inside a .torrent or magnet without downloading.
  const showInfo = async (path: string) => {
    const args = buildArgs();
    if (!args) {
      setErr(t('torrentn.errNoSource'));
      return;
    }
    // --show-files prints the torrent's file list, then exits.
    const infoArgs = ['--show-files=true', ...args];
    setBusy(true);
    setErr(null);
    setStatus(null);
    setOut('> aria2c --show-files ...\n');
    try {
      const res = await runCommand(path, infoArgs);
      setOut(res.stdout || res.stderr || t('torrentn.noOutput', { code: res.code }));
      setStatus(res.success ? t('torrentn.infoOk') : t('torrentn.doneErr', { code: res.code }));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async () => {
    const dir = savePath.trim() || '%USERPROFILE%\\Downloads\\WinForge';
    setErr(null);
    try {
      const res = await runCommand('explorer.exe', [dir]);
      // explorer returns non-zero even on success; only surface a hard failure.
      if (!res.success && res.stderr.trim()) setErr(res.stderr.trim());
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  const version = async (path: string) => {
    setBusy(true);
    setErr(null);
    setStatus(null);
    setOut('> aria2c --version\n');
    try {
      const res = await runCommand(path, ['--version']);
      setOut(res.stdout || res.stderr || t('torrentn.noOutput', { code: res.code }));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('torrentn.blurb')}</p>

      <DependencyGate tool="aria2c" preferId="aria2.aria2" query="aria2">
        {(path) => (
          <>
            <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
              <select
                className="mod-select"
                value={mode}
                onChange={(e) => setMode(e.target.value === 'file' ? 'file' : 'magnet')}
              >
                <option value="magnet">{t('torrentn.srcMagnet')}</option>
                <option value="file">{t('torrentn.srcFile')}</option>
              </select>
              <button className="mini primary" disabled={busy} onClick={() => run(path)}>
                {busy ? t('torrentn.working') : t('torrentn.download')}
              </button>
              <button className="mini" disabled={busy} onClick={() => showInfo(path)}>
                {t('torrentn.showFiles')}
              </button>
              <button className="mini" disabled={busy} onClick={openFolder}>
                {t('torrentn.openFolder')}
              </button>
              <button className="mini" disabled={busy} onClick={() => version(path)}>
                {t('torrentn.version')}
              </button>
            </div>

            {mode === 'magnet' ? (
              <textarea
                className="hosts-edit"
                placeholder={t('torrentn.magnetPlaceholder')}
                value={magnet}
                onChange={(e) => setMagnet(e.target.value)}
                spellCheck={false}
                rows={2}
              />
            ) : (
              <input
                className="mod-search"
                placeholder={t('torrentn.filePlaceholder')}
                value={torrentPath}
                onChange={(e) => setTorrentPath(e.target.value)}
              />
            )}

            <div className="io-grid" style={{ marginTop: 10 }}>
              <label className="label">{t('torrentn.saveFolder')}</label>
              <input
                className="mod-search"
                value={savePath}
                onChange={(e) => setSavePath(e.target.value)}
                placeholder="%USERPROFILE%\\Downloads\\WinForge"
              />
            </div>

            <div className="panel" style={{ marginTop: 10 }}>
              <div className="kv-list">
                <div className="kv-row">
                  <span className="label">{t('torrentn.maxDown')}</span>
                  <span className="value">
                    <input
                      className="mod-search"
                      type="number"
                      min={0}
                      style={{ maxWidth: 110 }}
                      value={maxDown}
                      onChange={(e) => setMaxDown(e.target.value)}
                    />
                  </span>
                </div>
                <div className="kv-row">
                  <span className="label">{t('torrentn.maxUp')}</span>
                  <span className="value">
                    <input
                      className="mod-search"
                      type="number"
                      min={0}
                      style={{ maxWidth: 110 }}
                      value={maxUp}
                      onChange={(e) => setMaxUp(e.target.value)}
                    />
                  </span>
                </div>
                <div className="kv-row">
                  <span className="label">{t('torrentn.maxConn')}</span>
                  <span className="value">
                    <input
                      className="mod-search"
                      type="number"
                      min={10}
                      max={2000}
                      style={{ maxWidth: 110 }}
                      value={maxConn}
                      onChange={(e) => setMaxConn(e.target.value)}
                    />
                  </span>
                </div>
                <div className="kv-row">
                  <span className="label">{t('torrentn.listenPort')}</span>
                  <span className="value">
                    <input
                      className="mod-search"
                      type="number"
                      min={1}
                      max={65535}
                      style={{ maxWidth: 110 }}
                      value={listenPort}
                      onChange={(e) => setListenPort(e.target.value)}
                    />
                  </span>
                </div>
                <div className="kv-row">
                  <span className="label">{t('torrentn.dht')}</span>
                  <span className="value">
                    <label className="chk">
                      <input type="checkbox" checked={dht} onChange={(e) => setDht(e.target.checked)} />
                      {t('torrentn.dhtOn')}
                    </label>
                  </span>
                </div>
                <div className="kv-row">
                  <span className="label">{t('torrentn.sequential')}</span>
                  <span className="value">
                    <label className="chk">
                      <input type="checkbox" checked={seq} onChange={(e) => setSeq(e.target.checked)} />
                      {t('torrentn.sequentialNote')}
                    </label>
                  </span>
                </div>
                <div className="kv-row">
                  <span className="label">{t('torrentn.seed')}</span>
                  <span className="value">
                    <label className="chk">
                      <input
                        type="checkbox"
                        checked={seedAfter}
                        onChange={(e) => setSeedAfter(e.target.checked)}
                      />
                      {t('torrentn.seedNote')}
                    </label>
                  </span>
                </div>
              </div>
            </div>

            <p className="count-note">{t('torrentn.engineNote')}</p>

            {status && <p className="count-note" style={{ color: 'var(--accent)' }}>{status}</p>}
            {err && <pre className="cmd-out error">{err}</pre>}
            {out && <pre className="cmd-out">{out}</pre>}
          </>
        )}
      </DependencyGate>
    </div>
  );
}
