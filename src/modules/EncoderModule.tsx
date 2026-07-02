import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleToolbar } from './common';

type Mode = 'base64' | 'base64url' | 'url' | 'html' | 'hex' | 'jwt';

function strToBytes(s: string, utf8: boolean): Uint8Array {
  if (utf8) return new TextEncoder().encode(s);
  return Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));
}
function bytesToStr(b: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder().decode(b);
  return String.fromCharCode(...b);
}
function b64FromBytes(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
function bytesFromB64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ''));
  return Uint8Array.from([...bin].map((c) => c.charCodeAt(0)));
}
const toB64Url = (s: string) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = (s: string) => s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);

const HTML_ENC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function EncoderModule() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('base64');
  const [utf8, setUtf8] = useState(true);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; msg: string }>({ ok: true, msg: t('encoder.ready') });

  const isJwt = mode === 'jwt';

  const wrap = (fn: () => string, okMsg: string) => {
    try {
      setOutput(fn());
      setStatus({ ok: true, msg: okMsg });
    } catch (e) {
      setStatus({ ok: false, msg: String(e instanceof Error ? e.message : e) });
    }
  };

  const encode = () =>
    wrap(() => {
      switch (mode) {
        case 'base64':
          return b64FromBytes(strToBytes(input, utf8));
        case 'base64url':
          return toB64Url(b64FromBytes(strToBytes(input, utf8)));
        case 'url':
          return encodeURIComponent(input);
        case 'html':
          return input.replace(/[&<>"']/g, (c) => HTML_ENC[c]!);
        case 'hex':
          return [...strToBytes(input, utf8)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
        default:
          return output;
      }
    }, t('encoder.encoded'));

  const decode = () =>
    wrap(() => {
      switch (mode) {
        case 'base64':
          return bytesToStr(bytesFromB64(input), utf8);
        case 'base64url':
          return bytesToStr(bytesFromB64(fromB64Url(input.trim())), utf8);
        case 'url':
          return decodeURIComponent(input);
        case 'html': {
          const el = document.createElement('textarea');
          el.innerHTML = input;
          return el.value;
        }
        case 'hex': {
          const hx = input.replace(/[^0-9a-f]/gi, '');
          if (hx.length % 2) throw new Error(t('encoder.badHex'));
          const bytes = Uint8Array.from(hx.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
          return bytesToStr(bytes, utf8);
        }
        case 'jwt': {
          const parts = input.trim().split('.');
          if (parts.length < 2) throw new Error(t('encoder.badJwt'));
          const dec = (p: string) => JSON.stringify(JSON.parse(bytesToStr(bytesFromB64(fromB64Url(p)), true)), null, 2);
          const sig = parts[2] || t('encoder.noSig');
          return `${t('encoder.header')}\n${dec(parts[0]!)}\n\n${t('encoder.payload')}\n${dec(parts[1]!)}\n\n${t('encoder.signature')}\n${sig}`;
        }
        default:
          return output;
      }
    }, t('encoder.decoded'));

  const swap = () => {
    setInput(output);
    setOutput('');
    setStatus({ ok: true, msg: t('encoder.swapped') });
  };
  const copy = () => {
    if (!output) return setStatus({ ok: false, msg: t('encoder.nothing') });
    void navigator.clipboard?.writeText(output);
    setStatus({ ok: true, msg: t('encoder.copied') });
  };

  const modes: Mode[] = ['base64', 'base64url', 'url', 'html', 'hex', 'jwt'];

  return (
    <div className="mod">
      <ModuleToolbar>
        <select className="mod-select" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          {modes.map((m) => (
            <option key={m} value={m}>
              {t(`encoder.mode_${m}`)}
            </option>
          ))}
        </select>
        {!isJwt && (mode === 'base64' || mode === 'base64url' || mode === 'hex') && (
          <select className="mod-select" value={utf8 ? 'utf8' : 'ascii'} onChange={(e) => setUtf8(e.target.value === 'utf8')}>
            <option value="utf8">UTF-8</option>
            <option value="ascii">ASCII</option>
          </select>
        )}
        {!isJwt && (
          <button className="mini primary" onClick={encode}>
            {t('encoder.encode')}
          </button>
        )}
        <button className="mini" onClick={decode}>
          {isJwt ? t('encoder.mode_jwt') : t('encoder.decode')}
        </button>
        <button className="mini" onClick={swap}>
          {t('encoder.swap')}
        </button>
      </ModuleToolbar>
      <div className="io-grid">
        <textarea
          className="hosts-edit"
          spellCheck={false}
          placeholder={t('encoder.inputPlaceholder')}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <textarea className="hosts-edit" spellCheck={false} readOnly value={output} placeholder={t('encoder.outputPlaceholder')} />
      </div>
      <div className="mod-toolbar" style={{ marginTop: 10 }}>
        <button className="mini" onClick={copy}>
          {t('encoder.copy')}
        </button>
        <span className={status.ok ? 'count-note' : ''} style={status.ok ? {} : { color: 'var(--danger)', fontSize: 12.5 }}>
          {status.msg}
        </span>
      </div>
    </div>
  );
}
