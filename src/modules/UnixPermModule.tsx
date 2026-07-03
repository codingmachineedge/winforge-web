import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge UnixPermService. Mode = 12 bits: 3 special + 9 rwx.
const SetUid = 0x800, SetGid = 0x400, Sticky = 0x200;
const OwnerR = 0x100, OwnerW = 0x80, OwnerX = 0x40;
const GroupR = 0x20, GroupW = 0x10, GroupX = 0x08;
const OtherR = 0x04, OtherW = 0x02, OtherX = 0x01;
const PermMask = 0xfff;

const norm = (m: number) => m & PermMask;

function toOctal(mode: number): string {
  mode = norm(mode);
  const special = (mode >> 9) & 0x7;
  const perms = mode & 0x1ff;
  return `${special}${perms.toString(8).padStart(3, '0')}`;
}
function toChmodOctal(mode: number): string {
  mode = norm(mode);
  const special = (mode >> 9) & 0x7;
  const perms = mode & 0x1ff;
  const p = perms.toString(8).padStart(3, '0');
  return special !== 0 ? `${special}${p}` : p;
}
function specialExec(exec: boolean, special: boolean, lower: string): string {
  const upper = lower.toUpperCase();
  if (special) return exec ? lower : upper;
  return exec ? 'x' : '-';
}
function toSymbolic(mode: number): string {
  mode = norm(mode);
  return (
    (mode & OwnerR ? 'r' : '-') + (mode & OwnerW ? 'w' : '-') + specialExec(!!(mode & OwnerX), !!(mode & SetUid), 's') +
    (mode & GroupR ? 'r' : '-') + (mode & GroupW ? 'w' : '-') + specialExec(!!(mode & GroupX), !!(mode & SetGid), 's') +
    (mode & OtherR ? 'r' : '-') + (mode & OtherW ? 'w' : '-') + specialExec(!!(mode & OtherX), !!(mode & Sticky), 't')
  );
}
function parseOctal(text: string): number | null {
  if (!text.trim()) return null;
  let s = text.trim();
  if (/^0x/i.test(s)) return null;
  if (/^0o/i.test(s)) s = s.slice(2);
  if (s.length === 0 || s.length > 4) return null;
  let value = 0;
  for (const ch of s) {
    if (ch < '0' || ch > '7') return null;
    value = (value << 3) | (ch.charCodeAt(0) - 48);
  }
  return norm(value);
}
function parseSymbolic(text: string): number | null {
  if (!text.trim()) return null;
  let s = text.trim();
  if (s.length === 10) s = s.slice(1);
  if (s.length !== 9) return null;
  let m = 0;
  const rw = (c: string, set: string, bit: number): boolean => {
    if (c === set) { m |= bit; return true; }
    return c === '-';
  };
  const ex = (c: string, execBit: number, specialBit: number, lower: string): boolean => {
    const upper = lower.toUpperCase();
    if (c === 'x') { m |= execBit; return true; }
    if (c === '-') return true;
    if (c === lower) { m |= execBit | specialBit; return true; }
    if (c === upper) { m |= specialBit; return true; }
    return false;
  };
  if (!rw(s[0]!, 'r', OwnerR)) return null;
  if (!rw(s[1]!, 'w', OwnerW)) return null;
  if (!ex(s[2]!, OwnerX, SetUid, 's')) return null;
  if (!rw(s[3]!, 'r', GroupR)) return null;
  if (!rw(s[4]!, 'w', GroupW)) return null;
  if (!ex(s[5]!, GroupX, SetGid, 's')) return null;
  if (!rw(s[6]!, 'r', OtherR)) return null;
  if (!rw(s[7]!, 'w', OtherW)) return null;
  if (!ex(s[8]!, OtherX, Sticky, 't')) return null;
  return m;
}

const ROWS: [string, number, number, number][] = [
  ['owner', OwnerR, OwnerW, OwnerX],
  ['group', GroupR, GroupW, GroupX],
  ['other', OtherR, OtherW, OtherX],
];

export function UnixPermModule() {
  const { t } = useTranslation();
  const [mode, setMode] = useState(OwnerR | OwnerW | GroupR | OtherR); // 0644
  const [octalText, setOctalText] = useState(toOctal(OwnerR | OwnerW | GroupR | OtherR));
  const [symText, setSymText] = useState(toSymbolic(OwnerR | OwnerW | GroupR | OtherR));
  const [err, setErr] = useState<string | null>(null);

  const applyMode = (m: number) => {
    setMode(m);
    setOctalText(toOctal(m));
    setSymText(toSymbolic(m));
    setErr(null);
  };
  const toggle = (bit: number) => applyMode(mode ^ bit);

  const onOctal = (v: string) => {
    setOctalText(v);
    const m = parseOctal(v);
    if (m === null) { setErr(t('unixperm.badOctal')); return; }
    setMode(m); setSymText(toSymbolic(m)); setErr(null);
  };
  const onSym = (v: string) => {
    setSymText(v);
    const m = parseSymbolic(v);
    if (m === null) { setErr(t('unixperm.badSym')); return; }
    setMode(m); setOctalText(toOctal(m)); setErr(null);
  };

  const command = `chmod ${toChmodOctal(mode)} file`;
  const copy = (v: string) => navigator.clipboard?.writeText(v);

  return (
    <div className="mod">
      <div className="panel">
        <table className="dt" style={{ maxWidth: 360 }}>
          <thead>
            <tr>
              <th></th>
              <th style={{ textAlign: 'center' }}>{t('unixperm.read')}</th>
              <th style={{ textAlign: 'center' }}>{t('unixperm.write')}</th>
              <th style={{ textAlign: 'center' }}>{t('unixperm.exec')}</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([label, r, w, x]) => (
              <tr key={label}>
                <td>{t(`unixperm.${label}`)}</td>
                {[r, w, x].map((bit) => (
                  <td key={bit} style={{ textAlign: 'center' }}>
                    <input type="checkbox" checked={!!(mode & bit)} onChange={() => toggle(bit)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mod-toolbar" style={{ marginTop: 10 }}>
          <label className="chk"><input type="checkbox" checked={!!(mode & SetUid)} onChange={() => toggle(SetUid)} /> {t('unixperm.setuid')}</label>
          <label className="chk"><input type="checkbox" checked={!!(mode & SetGid)} onChange={() => toggle(SetGid)} /> {t('unixperm.setgid')}</label>
          <label className="chk"><input type="checkbox" checked={!!(mode & Sticky)} onChange={() => toggle(Sticky)} /> {t('unixperm.sticky')}</label>
        </div>
      </div>
      <div className="panel" style={{ marginTop: 12 }}>
        <div className="uc-row">
          <label className="count-note" style={{ width: 90 }}>{t('unixperm.octal')}</label>
          <input className="hosts-edit" style={{ minHeight: 0, height: 34, maxWidth: 140, fontFamily: 'monospace' }} value={octalText} onChange={(e) => onOctal(e.target.value)} />
          <button className="mini" onClick={() => copy(toOctal(mode))}>{t('unixperm.copy')}</button>
        </div>
        <div className="uc-row" style={{ marginTop: 8 }}>
          <label className="count-note" style={{ width: 90 }}>{t('unixperm.symbolic')}</label>
          <input className="hosts-edit" style={{ minHeight: 0, height: 34, maxWidth: 200, fontFamily: 'monospace' }} value={symText} onChange={(e) => onSym(e.target.value)} />
          <button className="mini" onClick={() => copy(toSymbolic(mode))}>{t('unixperm.copy')}</button>
        </div>
        <div className="uc-row" style={{ marginTop: 8 }}>
          <label className="count-note" style={{ width: 90 }}>{t('unixperm.command')}</label>
          <code style={{ flex: 1 }}>{command}</code>
          <button className="mini" onClick={() => copy(command)}>{t('unixperm.copy')}</button>
        </div>
      </div>
      <p className="count-note" style={{ marginTop: 10, color: err ? 'var(--danger)' : undefined }}>
        {err ?? t('unixperm.status', { octal: toOctal(mode), sym: toSymbolic(mode) })}
      </p>
    </div>
  );
}
