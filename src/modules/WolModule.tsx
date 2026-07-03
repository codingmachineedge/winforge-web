import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell } from '../tauri/bridge';

// Faithful port of WinForge WolService — parse MAC, build the 102-byte magic packet.
// In a browser we compute & show the packet (bytes/hex) as read-only info. In the
// WinForge Web we also SEND it over a UDP broadcast (×3) via the backend.

/** PowerShell that sends the magic packet ×3 over a UDP broadcast (Windows PowerShell + .NET UdpClient). */
function sendScript(mac: number[], host: string, port: number): string {
  const bytes = mac.map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(',');
  return `$mac=[byte[]]@(${bytes}); $packet=New-Object byte[] 102; ` +
    `for($i=0;$i -lt 6;$i++){$packet[$i]=0xFF}; for($r=0;$r -lt 16;$r++){[Array]::Copy($mac,0,$packet,6+$r*6,6)}; ` +
    `$udp=New-Object System.Net.Sockets.UdpClient; $udp.EnableBroadcast=$true; ` +
    `$ep=New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Parse('${host}'),${port}); ` +
    `for($i=0;$i -lt 3;$i++){[void]$udp.Send($packet,102,$ep)}; $udp.Close(); 'sent'`;
}

/** Parse a MAC in any common notation into 6 bytes, or null (never throws). */
function tryParseMac(input: string | null | undefined): number[] | null {
  if (!input || input.trim().length === 0) return null;
  let hex = '';
  for (const c of input) {
    if (c === ':' || c === '-' || c === '.' || c === ' ' || c === '\t') continue;
    if (/[0-9a-fA-F]/.test(c)) hex += c;
    else return null;
  }
  if (hex.length !== 12) return null;
  const bytes: number[] = [];
  for (let i = 0; i < 6; i++) {
    const v = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(v)) return null;
    bytes.push(v);
  }
  return bytes;
}

/** Build the 102-byte magic packet: 6×0xFF then the MAC repeated 16×. */
function buildMagicPacket(mac: number[]): number[] {
  const packet: number[] = [];
  for (let i = 0; i < 6; i++) packet.push(0xff);
  for (let rep = 0; rep < 16; rep++) {
    for (let i = 0; i < 6; i++) packet.push(mac[i]!);
  }
  return packet;
}

const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, '0');
const macColon = (mac: number[]) => mac.map(hex2).join(':');

/** Basic IPv4 dotted-quad validation (matches IPAddress.TryParse for the v4 case). */
function isValidIPv4(text: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text.trim());
  if (!m) return false;
  return [m[1]!, m[2]!, m[3]!, m[4]!].every((x) => Number(x) <= 255);
}

export function WolModule() {
  const { t } = useTranslation();
  const [macText, setMacText] = useState('AA:BB:CC:DD:EE:FF');
  const [broadcast, setBroadcast] = useState('255.255.255.255');
  const [port, setPort] = useState(9);
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const desktop = isTauri();

  const model = useMemo(() => {
    const mac = tryParseMac(macText);
    if (mac === null) {
      return { ok: false as const, msg: t('wol.invalidMac') };
    }
    const host = broadcast.trim().length === 0 ? '255.255.255.255' : broadcast.trim();
    if (!isValidIPv4(host)) {
      return { ok: false as const, msg: t('wol.invalidBroadcast', { host }) };
    }
    let p = port;
    if (!Number.isInteger(p) || p < 1 || p > 65535) p = 9;
    const packet = buildMagicPacket(mac);
    const hexStr = packet.map(hex2).join('');
    const hexGrouped = packet.map(hex2).join(' ');
    return {
      ok: true as const,
      mac,
      macStr: macColon(mac),
      host,
      port: p,
      packet,
      hexStr,
      hexGrouped,
      length: packet.length,
    };
  }, [macText, broadcast, port, t]);

  const copyHex = () => {
    if (!model.ok) return;
    navigator.clipboard?.writeText(model.hexStr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const send = async () => {
    if (!model.ok) return;
    setSending(true);
    setSendMsg(null);
    try {
      const res = await runPowershell(sendScript(model.mac, model.host, model.port));
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setSendMsg({ ok: true, text: t('wol.sent', { mac: model.macStr, host: model.host, port: model.port }) });
    } catch (e) {
      setSendMsg({ ok: false, text: String(e instanceof Error ? e.message : e) });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('wol.blurb')}</p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('wol.macLabel')}</label>
        <input
          className="hosts-edit"
          style={{ minHeight: 0, height: 34, maxWidth: 220, fontFamily: 'monospace' }}
          value={macText}
          onChange={(e) => setMacText(e.target.value)}
          placeholder="AA:BB:CC:DD:EE:FF"
        />
        <label className="count-note">{t('wol.broadcastLabel')}</label>
        <input
          className="hosts-edit"
          style={{ minHeight: 0, height: 34, maxWidth: 170, fontFamily: 'monospace' }}
          value={broadcast}
          onChange={(e) => setBroadcast(e.target.value)}
          placeholder="255.255.255.255"
        />
        <label className="count-note">{t('wol.portLabel')}</label>
        <input
          className="mod-search"
          type="number"
          min={1}
          max={65535}
          style={{ maxWidth: 90 }}
          value={port}
          onChange={(e) => setPort(Math.max(0, Math.trunc(+e.target.value) || 0))}
        />
      </div>

      {model.ok ? (
        <>
          <div className="panel">
            <table className="dt">
              <tbody>
                <tr><td>{t('wol.rowMac')}</td><td style={{ fontFamily: 'monospace' }}>{model.macStr}</td></tr>
                <tr><td>{t('wol.rowTarget')}</td><td style={{ fontFamily: 'monospace' }}>{model.host}:{model.port}</td></tr>
                <tr><td>{t('wol.rowLength')}</td><td>{t('wol.bytes', { n: model.length })}</td></tr>
              </tbody>
            </table>
          </div>

          <div className="panel">
            <div className="mod-toolbar" style={{ justifyContent: 'space-between' }}>
              <h4 style={{ margin: 0 }}>{t('wol.packetTitle')}</h4>
              <span style={{ display: 'flex', gap: 8 }}>
                {desktop && (
                  <button className="mini primary" disabled={sending} onClick={send}>
                    {sending ? t('wol.sending') : t('wol.send')}
                  </button>
                )}
                <button className="mini" onClick={copyHex}>
                  {copied ? t('wol.copied') : t('wol.copyHex')}
                </button>
              </span>
            </div>
            {sendMsg && (
              <p className="count-note" style={{ marginTop: 8, color: sendMsg.ok ? undefined : 'var(--danger)' }}>{sendMsg.text}</p>
            )}
            <textarea
              className="hosts-edit"
              spellCheck={false}
              readOnly
              value={model.hexGrouped}
              style={{ marginTop: 8, fontFamily: 'monospace', minHeight: 140 }}
            />
            <p className="count-note" style={{ marginTop: 8 }}>{t('wol.packetNote')}</p>
          </div>
        </>
      ) : (
        <p className="count-note" style={{ color: 'var(--danger)' }}>{model.msg}</p>
      )}

      <p className="count-note" style={{ marginTop: 10 }}>{desktop ? t('wol.desktopNote') : t('wol.webNote')}</p>
    </div>
  );
}
