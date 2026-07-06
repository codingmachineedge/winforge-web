import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pick } from '../i18n';
import { isTauri, runCommand } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ── Native Bitwarden Vault module ────────────────────────────────────────────
//
// Ported from WinForge's BitwardenModule (a tabbed shell that manages self-hosted
// Vaultwarden containers through the managed DockerService, plus per-tab Bitwarden
// connections). The C# app drives Docker.DotNet over the local named pipe and owns
// its own in-memory keys.
//
// In winforge-web the equivalent LIVE path is the two CLIs that every such setup
// ships with and that talk to the SAME local daemons/vault:
//   • `docker` — lists/controls the running Vaultwarden self-hosted servers.
//   • `bw`     — the official Bitwarden CLI; `bw status` reports the login/lock state.
//
// This module is READ-ONLY for data. Container start/stop/restart mirror the C#
// instance buttons, are safe (no data-volume deletes), and are gated behind an
// explicit confirm — they never auto-run. Master passwords / session keys are never
// read, echoed, or logged here; we only surface the vault's own reported status.

// ── Docker (self-hosted Vaultwarden servers) ─────────────────────────────────

interface ContainerRow {
  ID: string;
  Names: string;
  Image: string;
  Status: string;
  State: string;
  Ports: string;
  CreatedAt: string;
  Labels: string;
}

/** Run `docker <args>`; returns raw output (empty + not-ok when not on Tauri). */
async function docker(args: string[]): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  const res = await runCommand('docker', args);
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', ok: res.success };
}

/** Query a `docker ... --format '{{json .}}'` list; one JSON object per non-empty line. */
async function dockerJsonList<T>(args: string[]): Promise<T[]> {
  const { stdout, stderr, ok } = await docker([...args, '--format', '{{json .}}']);
  if (!ok && !stdout.trim()) {
    throw new Error(stderr.trim() || 'docker command failed');
  }
  const rows: T[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      rows.push(JSON.parse(s) as T);
    } catch {
      // skip non-JSON noise
    }
  }
  return rows;
}

/** A Vaultwarden/Bitwarden-compatible server is anything whose image looks like it. */
function isVaultServer(c: ContainerRow): boolean {
  const hay = `${c.Image} ${c.Names} ${c.Labels}`.toLowerCase();
  return (
    hay.includes('vaultwarden') ||
    hay.includes('bitwarden') ||
    hay.includes('bwrs') ||
    hay.includes('mprasil/bitwarden')
  );
}

function runningState(state: string): boolean {
  const s = (state || '').toLowerCase();
  return s === 'running' || s === 'restarting';
}

/** Extract the first published host port from a `docker ps` Ports string. */
function firstHostPort(ports: string): number | null {
  // e.g. "0.0.0.0:8443->80/tcp, :::8443->80/tcp"
  const m = /(?:0\.0\.0\.0|127\.0\.0\.1|\[?::\]?):(\d+)->/.exec(ports || '');
  return m && m[1] ? Number(m[1]) : null;
}

function localUrl(ports: string): string | null {
  const p = firstHostPort(ports);
  return p ? `http://localhost:${p}` : null;
}

function shortId(id: string): string {
  const raw = (id || '').replace(/^sha256:/, '');
  return raw.length > 12 ? raw.slice(0, 12) : raw;
}

// ── Bitwarden CLI (`bw status`) ──────────────────────────────────────────────

interface BwStatus {
  serverUrl: string | null;
  lastSync: string | null;
  userEmail: string | null;
  status: string; // "unauthenticated" | "locked" | "unlocked"
}

async function bwStatus(): Promise<BwStatus | null> {
  const res = await runCommand('bw', ['status']);
  const text = (res.stdout ?? '').trim();
  if (!text) return null;
  try {
    const j = JSON.parse(text) as Partial<BwStatus>;
    return {
      serverUrl: j.serverUrl ?? null,
      lastSync: j.lastSync ?? null,
      userEmail: j.userEmail ?? null,
      status: j.status ?? 'unknown',
    };
  } catch {
    return null;
  }
}

// ── Password / passphrase generator (ports BitwardenService.Generate) ─────────
//
// Pure, network-free, browser-composable logic — a faithful TS port of the C#
// generator dialog (ambiguity-free character sets, at-least-one-per-set, Fisher-
// Yates shuffle; passphrase word list + separator + capitalize + trailing digit).
// Uses crypto.getRandomValues so it is unbiased, exactly like RandomNumberGenerator.

interface GenOptions {
  passphrase: boolean;
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  special: boolean;
  words: number;
  separator: string;
  capitalize: boolean;
}

const GEN_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const GEN_LOWER = 'abcdefghijkmnpqrstuvwxyz';
const GEN_NUMS = '23456789';
const GEN_SPECIAL = '!@#$%^&*()-_=+[]{}';
const GEN_WORDS =
  'correct horse battery staple apple river table cloud stone light forest copper silver maple ocean planet rocket garden window mirror anchor bridge candle dragon engine flower guitar hammer island jungle kettle ladder magnet needle orange pillow puzzle quartz ribbon saddle tunnel velvet walnut yellow zephyr breeze canyon ember falcon glacier harbor'.split(
    ' ',
  );

/** Unbiased [0, max) integer from a CSPRNG (mirrors RandomNumberGenerator.GetInt32). */
function randInt(max: number): number {
  if (max <= 0) return 0;
  const limit = Math.floor(0xffffffff / max) * max;
  const buf = new Uint32Array(1);
  let x = 0;
  do {
    crypto.getRandomValues(buf);
    x = buf[0] ?? 0;
  } while (x >= limit);
  return x % max;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function generateSecret(o: GenOptions): string {
  if (o.passphrase) {
    const n = clamp(Math.round(o.words), 3, 20);
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      let w = GEN_WORDS[randInt(GEN_WORDS.length)] ?? 'word';
      if (o.capitalize) w = w.charAt(0).toUpperCase() + w.slice(1);
      parts.push(w);
    }
    const sep = o.separator === '' ? '-' : o.separator;
    let result = parts.join(sep);
    if (o.numbers) result += String(randInt(10));
    return result;
  }
  const sets: string[] = [];
  if (o.uppercase) sets.push(GEN_UPPER);
  if (o.lowercase) sets.push(GEN_LOWER);
  if (o.numbers) sets.push(GEN_NUMS);
  if (o.special) sets.push(GEN_SPECIAL);
  if (sets.length === 0) sets.push(GEN_LOWER);
  const all = sets.join('');
  const len = clamp(Math.round(o.length), 5, 128);
  const chars: string[] = new Array(len);
  for (let i = 0; i < sets.length && i < len; i++) {
    const s = sets[i] ?? GEN_LOWER;
    chars[i] = s[randInt(s.length)] ?? 'a';
  }
  for (let i = sets.length; i < len; i++) chars[i] = all[randInt(all.length)] ?? 'a';
  for (let i = len - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const tmp = chars[i] as string;
    chars[i] = chars[j] as string;
    chars[j] = tmp;
  }
  return chars.join('');
}

/** Rough entropy estimate + strength band for the generated secret. */
function estimateStrength(o: GenOptions, secret: string): { bits: number; band: 'weak' | 'fair' | 'strong' } {
  let bits: number;
  if (o.passphrase) {
    bits = Math.round(clamp(Math.round(o.words), 3, 20) * Math.log2(GEN_WORDS.length));
  } else {
    let pool = 0;
    if (o.uppercase) pool += GEN_UPPER.length;
    if (o.lowercase) pool += GEN_LOWER.length;
    if (o.numbers) pool += GEN_NUMS.length;
    if (o.special) pool += GEN_SPECIAL.length;
    if (pool === 0) pool = GEN_LOWER.length;
    bits = Math.round(secret.length * Math.log2(pool));
  }
  const band = bits < 50 ? 'weak' : bits < 80 ? 'fair' : 'strong';
  return { bits, band };
}

// ── Local TOTP (ports BitwardenService.ComputeTotp, RFC 6238) ─────────────────

function base32Decode(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const s = input.trim().replace(/[ -]/g, '').replace(/=+$/, '').toUpperCase();
  if (!s) return new Uint8Array(0);
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s) {
    const idx = alphabet.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

interface TotpParsed {
  secret: string;
  digits: number;
  period: number;
  algo: 'SHA-1' | 'SHA-256' | 'SHA-512';
}

function parseTotpInput(secretOrUri: string): TotpParsed {
  let secret = secretOrUri.trim();
  let digits = 6;
  let period = 30;
  let algo: TotpParsed['algo'] = 'SHA-1';
  const applyQuery = (qs: URLSearchParams) => {
    const sv = qs.get('secret');
    if (sv) secret = sv;
    const dv = Number(qs.get('digits'));
    if (Number.isFinite(dv) && dv > 0) digits = dv;
    const pv = Number(qs.get('period'));
    if (Number.isFinite(pv) && pv > 0) period = pv;
    const av = (qs.get('algorithm') || '').toUpperCase();
    if (av === 'SHA256') algo = 'SHA-256';
    else if (av === 'SHA512') algo = 'SHA-512';
  };
  if (/^otpauth:\/\//i.test(secret)) {
    const q = secret.indexOf('?');
    if (q >= 0) applyQuery(new URLSearchParams(secret.slice(q + 1)));
  } else if (/(^|&)secret=/i.test(secret) || /^secret=/i.test(secret)) {
    applyQuery(new URLSearchParams(secret.startsWith('?') ? secret.slice(1) : secret));
  }
  return { secret, digits, period, algo };
}

async function computeTotp(secretOrUri: string): Promise<{ code: string; remaining: number; period: number } | null> {
  try {
    const p = parseTotpInput(secretOrUri);
    const key = base32Decode(p.secret);
    if (key.length === 0) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    const counter = Math.floor(nowSec / p.period);
    const counterBytes = new Uint8Array(8);
    let c = counter;
    for (let i = 7; i >= 0; i--) {
      counterBytes[i] = c & 0xff;
      c = Math.floor(c / 256);
    }
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      key as unknown as BufferSource,
      { name: 'HMAC', hash: p.algo },
      false,
      ['sign'],
    );
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, counterBytes as unknown as BufferSource));
    const offset = (sig[sig.length - 1] ?? 0) & 0x0f;
    const bin =
      (((sig[offset] ?? 0) & 0x7f) << 24) |
      (((sig[offset + 1] ?? 0) & 0xff) << 16) |
      (((sig[offset + 2] ?? 0) & 0xff) << 8) |
      ((sig[offset + 3] ?? 0) & 0xff);
    const mod = Math.pow(10, p.digits);
    const code = String(bin % mod).padStart(p.digits, '0');
    const remaining = p.period - (nowSec % p.period);
    return { code, remaining, period: p.period };
  } catch {
    return null;
  }
}

// ── New Vaultwarden instance composer (ports BitwardenInstanceService) ─────────

interface InstanceSpec {
  name: string;
  hostPort: number;
  signupsAllowed: boolean;
  websocketEnabled: boolean;
  adminToken: string;
}

/** Strong random ADMIN_TOKEN — 32 bytes, base64url (mirrors GenerateAdminToken). */
function generateAdminToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const VW_IMAGE = 'vaultwarden/server:latest';

/** docker compose file for one Vaultwarden instance (mirrors BuildProject's env). */
function composeYaml(s: InstanceSpec): string {
  const project = 'winforge_vaultwarden';
  const localUrl = `http://localhost:${s.hostPort}`;
  return [
    `# ${s.name || `Vaultwarden :${s.hostPort}`}`,
    `# save as docker-compose.yml, then:  docker compose -p ${project} up -d`,
    'services:',
    '  server:',
    `    image: ${VW_IMAGE}`,
    '    restart: unless-stopped',
    '    ports:',
    `      - "${s.hostPort}:80"`,
    '    volumes:',
    `      - ${project}_data:/data`,
    '    environment:',
    `      DOMAIN: "${localUrl}"`,
    `      ADMIN_TOKEN: "${s.adminToken}"`,
    `      SIGNUPS_ALLOWED: "${s.signupsAllowed ? 'true' : 'false'}"`,
    `      WEBSOCKET_ENABLED: "${s.websocketEnabled ? 'true' : 'false'}"`,
    '      ROCKET_PORT: "80"',
    'volumes:',
    `  ${project}_data:`,
    '',
  ].join('\n');
}

/** Equivalent one-shot `docker run` command for the same instance. */
function dockerRunCommand(s: InstanceSpec): string {
  const localUrl = `http://localhost:${s.hostPort}`;
  return [
    'docker run -d --name winforge_vaultwarden --restart unless-stopped',
    `-p ${s.hostPort}:80`,
    '-v winforge_vaultwarden_data:/data',
    `-e DOMAIN="${localUrl}"`,
    `-e ADMIN_TOKEN="${s.adminToken}"`,
    `-e SIGNUPS_ALLOWED=${s.signupsAllowed ? 'true' : 'false'}`,
    `-e WEBSOCKET_ENABLED=${s.websocketEnabled ? 'true' : 'false'}`,
    '-e ROCKET_PORT=80',
    VW_IMAGE,
  ].join(' \\\n  ');
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

function downloadText(filename: string, text: string): void {
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* ignore */
  }
}

export function BitwardenModule() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'en';
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reach, setReach] = useState<Record<string, 'up' | 'down' | 'checking'>>({});

  // Docker engine version doubles as the reachability probe for the daemon.
  const engine = useAsync(async () => {
    const { stdout, stderr, ok } = await docker(['version', '--format', '{{.Server.Version}}']);
    const v = stdout.trim();
    if (!ok || !v) throw new Error(stderr.trim() || 'Docker engine not reachable');
    return v;
  }, []);

  const containers = useAsync(() => dockerJsonList<ContainerRow>(['ps', '-a', '--no-trunc']), []);

  // Bitwarden CLI login/lock state (read-only; never touches secrets).
  const cli = useAsync(async () => await bwStatus(), []);

  // ── Password / passphrase generator (browser-composable, no OS) ─────────────
  const [gen, setGen] = useState<GenOptions>({
    passphrase: false,
    length: 16,
    uppercase: true,
    lowercase: true,
    numbers: true,
    special: true,
    words: 4,
    separator: '-',
    capitalize: true,
  });
  const [generated, setGenerated] = useState<string>(() =>
    generateSecret({
      passphrase: false,
      length: 16,
      uppercase: true,
      lowercase: true,
      numbers: true,
      special: true,
      words: 4,
      separator: '-',
      capitalize: true,
    }),
  );
  const [genCopied, setGenCopied] = useState(false);
  const strength = useMemo(() => estimateStrength(gen, generated), [gen, generated]);

  const patchGen = (patch: Partial<GenOptions>) => {
    setGen((g) => {
      const next = { ...g, ...patch };
      setGenerated(generateSecret(next));
      setGenCopied(false);
      return next;
    });
  };
  const regenerate = () => {
    setGenerated(generateSecret(gen));
    setGenCopied(false);
  };
  const copyGenerated = async () => {
    if (await copyText(generated)) {
      setGenCopied(true);
      setTimeout(() => setGenCopied(false), 2000);
    }
  };

  // ── Local TOTP calculator (RFC 6238; base32 secret or otpauth URI) ──────────
  const [totpSecret, setTotpSecret] = useState('');
  const [totp, setTotp] = useState<{ code: string; remaining: number; period: number } | null>(null);
  const [totpErr, setTotpErr] = useState(false);
  const [totpCopied, setTotpCopied] = useState(false);

  const runTotp = async () => {
    const s = totpSecret.trim();
    setTotpCopied(false);
    if (!s) {
      setTotp(null);
      setTotpErr(false);
      return;
    }
    const r = await computeTotp(s);
    setTotp(r);
    setTotpErr(r === null);
  };
  const copyTotp = async () => {
    if (totp && (await copyText(totp.code))) {
      setTotpCopied(true);
      setTimeout(() => setTotpCopied(false), 2000);
    }
  };

  // ── New Vaultwarden instance composer (preview + copy/export; live = Tauri) ──
  const [vwName, setVwName] = useState('');
  const [vwPort, setVwPort] = useState(8443);
  const [vwSignups, setVwSignups] = useState(true);
  const [vwWebsocket, setVwWebsocket] = useState(false);
  const [vwToken, setVwToken] = useState<string>(() => generateAdminToken());
  const [vwFormat, setVwFormat] = useState<'compose' | 'run'>('compose');
  const [vwCopied, setVwCopied] = useState(false);

  const portValid = Number.isInteger(vwPort) && vwPort >= 1024 && vwPort <= 65535;
  const vwSpec: InstanceSpec = useMemo(
    () => ({
      name: vwName.trim(),
      hostPort: portValid ? vwPort : 8443,
      signupsAllowed: vwSignups,
      websocketEnabled: vwWebsocket,
      adminToken: vwToken,
    }),
    [vwName, vwPort, portValid, vwSignups, vwWebsocket, vwToken],
  );
  const vwPreview = useMemo(
    () => (vwFormat === 'compose' ? composeYaml(vwSpec) : dockerRunCommand(vwSpec)),
    [vwFormat, vwSpec],
  );
  const copyVwPreview = async () => {
    if (await copyText(vwPreview)) {
      setVwCopied(true);
      setTimeout(() => setVwCopied(false), 2000);
    }
  };
  const exportVwPreview = () =>
    downloadText(vwFormat === 'compose' ? 'docker-compose.yml' : 'vaultwarden-run.sh', vwPreview);

  const reloadAll = useCallback(() => {
    engine.reload();
    containers.reload();
    cli.reload();
    setReach({});
  }, [engine, containers, cli]);

  const all = containers.data ?? [];
  const servers = useMemo(() => all.filter(isVaultServer), [all]);
  const runningCount = servers.filter((c) => runningState(c.State)).length;

  const q = filter.trim().toLowerCase();
  const rows = useMemo(() => {
    const list = q
      ? servers.filter((c) => `${c.Names} ${c.Image} ${c.Status}`.toLowerCase().includes(q))
      : servers;
    return [...list].sort((a, b) => a.Names.localeCompare(b.Names));
  }, [servers, q]);

  // ── safe container lifecycle (mirrors the C# Start/Stop buttons) ────────────
  const act = async (verb: 'start' | 'stop' | 'restart', c: ContainerRow) => {
    const name = (c.Names || shortId(c.ID)).replace(/^\//, '');
    if (verb !== 'start' && !window.confirm(t(`bitwarden.confirm.${verb}`, { name }))) return;
    setBusy(c.ID);
    setMsg(null);
    try {
      const { stderr, ok } = await docker(['container', verb, c.ID]);
      if (!ok) throw new Error(stderr.trim() || 'command failed');
      setMsg(t(`bitwarden.did.${verb}`, { name }));
      containers.reload();
    } catch (e) {
      setMsg(`${t('bitwarden.actionFailed', { name })}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  // ── reachability probe (HTTP HEAD via PowerShell-free runCommand curl) ───────
  const probe = async (c: ContainerRow) => {
    const url = localUrl(c.Ports);
    if (!url) return;
    setReach((r) => ({ ...r, [c.ID]: 'checking' }));
    try {
      // curl ships with Windows 10+; -s silent, -o discard, fast timeout.
      const res = await runCommand('curl', ['-s', '-o', 'NUL', '-m', '4', '-w', '%{http_code}', url]);
      const codeText = (res.stdout ?? '').trim();
      const httpCode = Number(codeText);
      setReach((r) => ({ ...r, [c.ID]: httpCode > 0 ? 'up' : 'down' }));
    } catch {
      setReach((r) => ({ ...r, [c.ID]: 'down' }));
    }
  };

  const openUrl = (c: ContainerRow) => {
    const url = localUrl(c.Ports);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };

  const stateLabel = (c: ContainerRow) =>
    runningState(c.State) ? t('bitwarden.state.running') : t('bitwarden.state.stopped');

  const columns: Column<ContainerRow>[] = [
    {
      key: 'State',
      header: t('bitwarden.col.state'),
      width: 110,
      render: (c) => <StatusDot ok={runningState(c.State)} label={stateLabel(c)} />,
    },
    {
      key: 'Names',
      header: t('bitwarden.col.name'),
      render: (c) => (
        <div>
          <div style={{ fontWeight: 600 }}>{(c.Names || '').replace(/^\//, '')}</div>
          <div className="count-note" style={{ margin: 0 }}>{shortId(c.ID)}</div>
        </div>
      ),
    },
    {
      key: 'Url',
      header: t('bitwarden.col.url'),
      width: 190,
      render: (c) => {
        const url = localUrl(c.Ports);
        const state = reach[c.ID];
        return (
          <div>
            {url ? (
              <button className="mini" onClick={() => openUrl(c)} title={t('bitwarden.open')}>
                {url}
              </button>
            ) : (
              <span className="count-note" style={{ margin: 0 }}>{t('bitwarden.noPort')}</span>
            )}
            {state && (
              <div style={{ marginTop: 4 }}>
                {state === 'checking' ? (
                  <span className="count-note" style={{ margin: 0 }}>{t('bitwarden.probing')}</span>
                ) : (
                  <StatusDot ok={state === 'up'} label={state === 'up' ? t('bitwarden.reachable') : t('bitwarden.unreachable')} />
                )}
              </div>
            )}
          </div>
        );
      },
    },
    { key: 'Image', header: t('bitwarden.col.image'), width: 200 },
    { key: 'Status', header: t('bitwarden.col.status'), width: 160 },
    {
      key: 'actions',
      header: '',
      width: 300,
      render: (c) => {
        const running = runningState(c.State);
        const url = localUrl(c.Ports);
        return (
          <span className="row-actions">
            {running ? (
              <>
                <button className="mini" disabled={busy === c.ID} onClick={() => act('stop', c)}>
                  {t('bitwarden.stop')}
                </button>
                <button className="mini" disabled={busy === c.ID} onClick={() => act('restart', c)}>
                  {t('bitwarden.restart')}
                </button>
              </>
            ) : (
              <button className="mini" disabled={busy === c.ID} onClick={() => act('start', c)}>
                {t('bitwarden.start')}
              </button>
            )}
            {url && (
              <button className="mini" disabled={reach[c.ID] === 'checking'} onClick={() => probe(c)}>
                {t('bitwarden.probe')}
              </button>
            )}
          </span>
        );
      },
    },
  ];

  const engineDown = !!engine.error && !engine.loading;

  // Bitwarden CLI status card.
  const st = cli.data;
  const cliMap: Record<string, string> = {
    unauthenticated: t('bitwarden.cli.unauthenticated'),
    locked: t('bitwarden.cli.locked'),
    unlocked: t('bitwarden.cli.unlocked'),
    unknown: t('bitwarden.cli.unknown'),
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('bitwarden.blurb')}</p>

      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('bitwarden.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="mini" onClick={reloadAll}>
          ⟳ {t('modules.refresh')}
        </button>
        {!engine.loading && !engine.error && engine.data && (
          <span className="count-note">
            {t('bitwarden.summary', {
              version: engine.data,
              running: runningCount,
              servers: servers.length,
            })}
          </span>
        )}
      </ModuleToolbar>

      {msg && <p className="mod-msg">{msg}</p>}
      <p className="count-note" style={{ marginTop: 0 }}>{t('bitwarden.safeNote')}</p>

      {/* ── Self-hosted servers (Vaultwarden via Docker) ── */}
      <h3 className="group-title" style={{ fontSize: 15, margin: '0 0 4px' }}>{t('bitwarden.serversTitle')}</h3>
      <p className="count-note" style={{ marginTop: 0 }}>{t('bitwarden.serversBlurb')}</p>

      {engineDown && <pre className="cmd-out error">{t('bitwarden.engineDown')}</pre>}

      {!engineDown && (
        <AsyncState loading={containers.loading} error={containers.error}>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(c) => c.ID}
            empty={t('bitwarden.noServers')}
          />
        </AsyncState>
      )}

      {/* ── Bitwarden CLI vault status ── */}
      <h3 className="group-title" style={{ fontSize: 15, margin: '20px 0 4px' }}>{t('bitwarden.cliTitle')}</h3>
      <p className="count-note" style={{ marginTop: 0 }}>{t('bitwarden.cliBlurb')}</p>

      <AsyncState loading={cli.loading} error={null}>
        {st ? (
          <div className="hosts-edit" style={{ display: 'grid', gap: 6, maxWidth: 560 }}>
            <div>
              <StatusDot ok={st.status === 'unlocked'} label={cliMap[st.status] ?? cliMap.unknown ?? st.status} />
            </div>
            <div className="count-note" style={{ margin: 0 }}>
              {t('bitwarden.cli.server')}: {st.serverUrl || t('bitwarden.cli.official')}
            </div>
            {st.userEmail && (
              <div className="count-note" style={{ margin: 0 }}>
                {t('bitwarden.cli.account')}: {st.userEmail}
              </div>
            )}
            {st.lastSync && (
              <div className="count-note" style={{ margin: 0 }}>
                {t('bitwarden.cli.lastSync')}: {new Date(st.lastSync).toLocaleString()}
              </div>
            )}
          </div>
        ) : (
          <p className="count-note" style={{ marginTop: 0 }}>{t('bitwarden.cli.notInstalled')}</p>
        )}
      </AsyncState>

      {/* ── New Vaultwarden instance composer (preview; live create needs the desktop app) ── */}
      <h3 className="group-title" style={{ fontSize: 15, margin: '20px 0 4px' }}>
        {pick('New Vaultwarden instance', '新 Vaultwarden 實例', lang)}
      </h3>
      <p className="count-note" style={{ marginTop: 0 }}>
        {pick(
          'Compose a self-hosted Vaultwarden server. Each instance gets its own data volume and host port, so several can run at once. The desktop app can create and start it for you; here you can build, copy, and export the exact config.',
          '編排一個自寄存 Vaultwarden 伺服器。每個實例有自己嘅資料卷同主機埠，可以同時行幾個。桌面版可以幫你建立同啟動；喺呢度你可以組出、複製同匯出完整設定。',
          lang,
        )}
      </p>

      <div className="hosts-edit" style={{ display: 'grid', gap: 8, maxWidth: 620 }}>
        <label className="kv-row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, alignItems: 'center' }}>
          <span className="count-note" style={{ margin: 0 }}>{pick('Display name (optional)', '顯示名（可選）', lang)}</span>
          <input
            className="mod-search"
            style={{ width: '100%' }}
            placeholder={pick('My Vaultwarden', '我嘅 Vaultwarden', lang)}
            value={vwName}
            onChange={(e) => setVwName(e.target.value)}
          />
        </label>

        <label className="kv-row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, alignItems: 'center' }}>
          <span className="count-note" style={{ margin: 0 }}>{pick('Host port', '主機埠', lang)}</span>
          <input
            className="mod-search"
            type="number"
            min={1024}
            max={65535}
            style={{ width: 140 }}
            value={vwPort}
            onChange={(e) => setVwPort(Number(e.target.value))}
          />
        </label>
        {!portValid && (
          <p className="count-note" style={{ margin: 0, color: 'var(--danger, #c0392b)' }}>
            {pick('Enter a port between 1024 and 65535.', '請輸入 1024 至 65535 之間嘅埠。', lang)}
          </p>
        )}

        <label className="kv-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={vwSignups} onChange={(e) => setVwSignups(e.target.checked)} />
          <span className="count-note" style={{ margin: 0 }}>
            {pick('Allow sign-ups (needed to create your first account)', '允許註冊（首次建立帳戶需要）', lang)}
          </span>
        </label>
        <label className="kv-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={vwWebsocket} onChange={(e) => setVwWebsocket(e.target.checked)} />
          <span className="count-note" style={{ margin: 0 }}>
            {pick('Enable WebSocket notifications', '啟用 WebSocket 通知', lang)}
          </span>
        </label>

        <div className="kv-row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, alignItems: 'center' }}>
          <span className="count-note" style={{ margin: 0 }}>{pick('Admin token', '管理權杖', lang)}</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
            <code style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{vwToken}</code>
            <button className="mini" onClick={() => setVwToken(generateAdminToken())}>
              {pick('Regenerate', '重新產生', lang)}
            </button>
          </div>
        </div>
        <p className="count-note" style={{ margin: 0 }}>
          {pick(
            'The ADMIN_TOKEN opens the /admin panel. It is generated locally in your browser — save it somewhere safe before you deploy.',
            'ADMIN_TOKEN 用嚟開 /admin 面板。佢喺你嘅瀏覽器本機產生 —— 部署前請儲存喺安全嘅地方。',
            lang,
          )}
        </p>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="mini"
            aria-pressed={vwFormat === 'compose'}
            style={vwFormat === 'compose' ? { fontWeight: 700 } : undefined}
            onClick={() => setVwFormat('compose')}
          >
            {pick('docker compose', 'docker compose', lang)}
          </button>
          <button
            className="mini"
            aria-pressed={vwFormat === 'run'}
            style={vwFormat === 'run' ? { fontWeight: 700 } : undefined}
            onClick={() => setVwFormat('run')}
          >
            {pick('docker run', 'docker run', lang)}
          </button>
          <span style={{ flex: 1 }} />
          <button className="mini" onClick={copyVwPreview}>
            {vwCopied ? pick('Copied', '已複製', lang) : pick('Copy', '複製', lang)}
          </button>
          <button className="mini" onClick={exportVwPreview}>
            {pick('Export', '匯出', lang)}
          </button>
        </div>

        <pre className="cmd-out" style={{ margin: 0, maxHeight: 320, overflow: 'auto' }}>{vwPreview}</pre>
        <p className="count-note" style={{ margin: 0 }}>
          {isTauri()
            ? pick(
                'Live create/start of this container runs from the desktop app.',
                '桌面版可以直接建立／啟動呢個容器。',
                lang,
              )
            : pick(
                'Live create/start runs only in the WinForge desktop app. In the browser, copy or export this config and run it yourself.',
                '直接建立／啟動只喺 WinForge 桌面版可用。喺瀏覽器，請複製或匯出呢份設定自己執行。',
                lang,
              )}
        </p>
      </div>

      {/* ── Password / passphrase generator (fully local, no OS) ── */}
      <h3 className="group-title" style={{ fontSize: 15, margin: '20px 0 4px' }}>
        {pick('Password generator', '密碼產生器', lang)}
      </h3>
      <p className="count-note" style={{ marginTop: 0 }}>
        {pick(
          'Generate a strong password or passphrase locally with a CSPRNG. Nothing leaves your device.',
          '用密碼學安全隨機數本機產生強密碼或通行短語。全程唔會離開你部裝置。',
          lang,
        )}
      </p>

      <div className="hosts-edit" style={{ display: 'grid', gap: 8, maxWidth: 620 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <code style={{ flex: 1, fontSize: 15, wordBreak: 'break-all', padding: '6px 8px' }}>{generated}</code>
          <button className="mini" onClick={regenerate}>
            {pick('Regenerate', '重新產生', lang)}
          </button>
          <button className="mini" onClick={copyGenerated}>
            {genCopied ? pick('Copied', '已複製', lang) : pick('Copy', '複製', lang)}
          </button>
        </div>
        <p className="count-note" style={{ margin: 0 }}>
          {pick('Estimated strength', '估計強度', lang)}:{' '}
          <span
            style={{
              fontWeight: 700,
              color:
                strength.band === 'strong'
                  ? 'var(--ok, #2e9e44)'
                  : strength.band === 'fair'
                    ? 'var(--warn, #c8951f)'
                    : 'var(--danger, #c0392b)',
            }}
          >
            {strength.band === 'strong'
              ? pick('Strong', '強', lang)
              : strength.band === 'fair'
                ? pick('Fair', '中等', lang)
                : pick('Weak', '弱', lang)}
          </span>{' '}
          <span>({strength.bits} {pick('bits', '位元', lang)})</span>
        </p>

        <label className="kv-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={gen.passphrase}
            onChange={(e) => patchGen({ passphrase: e.target.checked })}
          />
          <span className="count-note" style={{ margin: 0 }}>
            {pick('Passphrase (words) instead of password', '用通行短語（字詞）而唔係密碼', lang)}
          </span>
        </label>

        {!gen.passphrase ? (
          <>
            <label className="kv-row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr auto', gap: 8, alignItems: 'center' }}>
              <span className="count-note" style={{ margin: 0 }}>{pick('Length', '長度', lang)}</span>
              <input
                type="range"
                min={5}
                max={64}
                value={gen.length}
                onChange={(e) => patchGen({ length: Number(e.target.value) })}
              />
              <span className="count-note" style={{ margin: 0, minWidth: 28, textAlign: 'right' }}>{gen.length}</span>
            </label>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={gen.uppercase} onChange={(e) => patchGen({ uppercase: e.target.checked })} />
                <span className="count-note" style={{ margin: 0 }}>{pick('Uppercase (A-Z)', '大寫（A-Z）', lang)}</span>
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={gen.lowercase} onChange={(e) => patchGen({ lowercase: e.target.checked })} />
                <span className="count-note" style={{ margin: 0 }}>{pick('Lowercase (a-z)', '細寫（a-z）', lang)}</span>
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={gen.numbers} onChange={(e) => patchGen({ numbers: e.target.checked })} />
                <span className="count-note" style={{ margin: 0 }}>{pick('Numbers (0-9)', '數字（0-9）', lang)}</span>
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={gen.special} onChange={(e) => patchGen({ special: e.target.checked })} />
                <span className="count-note" style={{ margin: 0 }}>{pick('Special (!@#$…)', '特殊符號（!@#$…）', lang)}</span>
              </label>
            </div>
          </>
        ) : (
          <>
            <label className="kv-row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr auto', gap: 8, alignItems: 'center' }}>
              <span className="count-note" style={{ margin: 0 }}>{pick('Words', '字詞數', lang)}</span>
              <input
                type="range"
                min={3}
                max={12}
                value={gen.words}
                onChange={(e) => patchGen({ words: Number(e.target.value) })}
              />
              <span className="count-note" style={{ margin: 0, minWidth: 28, textAlign: 'right' }}>{gen.words}</span>
            </label>
            <label className="kv-row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, alignItems: 'center' }}>
              <span className="count-note" style={{ margin: 0 }}>{pick('Separator', '分隔符', lang)}</span>
              <input
                className="mod-search"
                style={{ width: 80 }}
                maxLength={4}
                value={gen.separator}
                onChange={(e) => patchGen({ separator: e.target.value })}
              />
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={gen.capitalize} onChange={(e) => patchGen({ capitalize: e.target.checked })} />
              <span className="count-note" style={{ margin: 0 }}>{pick('Capitalize', '首字母大寫', lang)}</span>
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={gen.numbers} onChange={(e) => patchGen({ numbers: e.target.checked })} />
              <span className="count-note" style={{ margin: 0 }}>{pick('Append a number', '結尾加數字', lang)}</span>
            </label>
          </>
        )}
      </div>

      {/* ── Local TOTP calculator (RFC 6238) ── */}
      <h3 className="group-title" style={{ fontSize: 15, margin: '20px 0 4px' }}>
        {pick('Verification code (TOTP)', '驗證碼（TOTP）', lang)}
      </h3>
      <p className="count-note" style={{ marginTop: 0 }}>
        {pick(
          'Compute a time-based one-time code (RFC 6238) from a base32 secret or an otpauth:// URI — locally, in your browser.',
          '由 base32 密鑰或 otpauth:// URI 本機（喺瀏覽器）計算時間型一次性驗證碼（RFC 6238）。',
          lang,
        )}
      </p>

      <div className="hosts-edit" style={{ display: 'grid', gap: 8, maxWidth: 620 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            className="mod-search"
            style={{ flex: 1 }}
            placeholder={pick('base32 secret or otpauth:// URI', 'base32 密鑰或 otpauth:// URI', lang)}
            value={totpSecret}
            onChange={(e) => setTotpSecret(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runTotp();
            }}
          />
          <button className="mini" onClick={() => void runTotp()}>
            {pick('Compute', '計算', lang)}
          </button>
        </div>
        {totpErr && (
          <p className="count-note" style={{ margin: 0, color: 'var(--danger, #c0392b)' }}>
            {pick('That is not a valid TOTP secret.', '嗰個唔係有效嘅 TOTP 密鑰。', lang)}
          </p>
        )}
        {totp && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <code style={{ fontSize: 22, letterSpacing: 2 }}>
              {totp.code.length === 6 ? `${totp.code.slice(0, 3)} ${totp.code.slice(3)}` : totp.code}
            </code>
            <span className="count-note" style={{ margin: 0 }}>
              {totp.remaining}s / {totp.period}s
            </span>
            <button className="mini" onClick={copyTotp}>
              {totpCopied ? pick('Copied', '已複製', lang) : pick('Copy', '複製', lang)}
            </button>
          </div>
        )}
        {totp && (
          <p className="count-note" style={{ margin: 0 }}>
            {pick(
              'Recompute to refresh — the code rotates every period.',
              '重新計算即可更新 —— 驗證碼每個週期輪換一次。',
              lang,
            )}
          </p>
        )}
      </div>
    </div>
  );
}
