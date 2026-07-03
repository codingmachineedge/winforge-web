import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Ported from WinForge Services/IniEditService.cs — pure, never-throws INI
// parser/editor. Parses [sections], key=value pairs and comments (; or #).
// Round-trips list ⇄ raw text, preserving section grouping.

interface IniEntry {
  section: string;
  key: string;
  value: string;
  note: string;
}

function parseIni(raw: string): IniEntry[] {
  const list: IniEntry[] = [];
  if (!raw) return list;
  try {
    let section = '';
    const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      const first = line[0]!;
      if (first === ';' || first === '#') continue; // comment — dropped on round-trip by design

      if (first === '[') {
        const close = line.indexOf(']');
        if (close > 1) {
          section = line.substring(1, close).trim();
        } else {
          list.push({ section, key: line, value: '', note: 'malformed section · 分區格式錯誤' });
        }
        continue;
      }

      const eq = line.indexOf('=');
      if (eq <= 0) {
        list.push({ section, key: line, value: '', note: 'no key=value · 唔係 key=value' });
        continue;
      }
      const key = line.substring(0, eq).trim();
      const val = line.substring(eq + 1).trim();
      if (key.length === 0) {
        list.push({ section, key: line, value: '', note: 'empty key · 空白鍵' });
        continue;
      }
      list.push({ section, key, value: val, note: '' });
    }
  } catch {
    /* never throw — return whatever parsed so far */
  }
  return list;
}

function serializeIni(entries: IniEntry[]): string {
  let out = '';
  try {
    const good = entries.filter((e) => e && !e.note && e.key);
    const order: string[] = [];
    for (const e of good) if (!order.includes(e.section)) order.push(e.section);

    let first = true;
    for (const sec of order) {
      if (!first) out += '\n';
      first = false;
      if (sec) out += `[${sec}]\n`;
      for (const e of good.filter((x) => x.section === sec)) out += `${e.key}=${e.value}\n`;
    }
  } catch {
    /* never throw */
  }
  return out;
}

const ciEq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function getValue(entries: IniEntry[], section: string, key: string): string | null {
  if (!key) return null;
  try {
    const sec = section ?? '';
    for (const e of entries) {
      if (!e || e.note) continue;
      if (ciEq(e.section, sec) && ciEq(e.key, key)) return e.value;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Add or update section+key; returns [newList, updated] where updated=true if an
// existing key was replaced, false if a new key was appended.
function setValue(entries: IniEntry[], section: string, key: string, value: string): [IniEntry[], boolean] {
  if (!key.trim()) return [entries, false];
  const sec = (section ?? '').trim();
  const k = key.trim();
  const v = value ?? '';
  const next = entries.map((e) => ({ ...e }));
  for (const e of next) {
    if (!e || e.note) continue;
    if (ciEq(e.section, sec) && ciEq(e.key, k)) {
      e.value = v;
      return [next, true];
    }
  }
  next.push({ section: sec, key: k, value: v, note: '' });
  return [next, false];
}

// Remove section+key; returns [newList, countRemoved].
function removeKey(entries: IniEntry[], section: string, key: string): [IniEntry[], number] {
  if (!key) return [entries, 0];
  const sec = section ?? '';
  let removed = 0;
  const next = entries.filter((e) => {
    const hit = e && !e.note && ciEq(e.section, sec) && ciEq(e.key, key);
    if (hit) removed++;
    return !hit;
  });
  return [next, removed];
}

const SAMPLE = '; WinForge sample\n[General]\nName=WinForge\nMode=Bilingual\n\n[Reactor]\nStartMode=5';

export function IniEditModule() {
  const { t } = useTranslation();
  const [raw, setRaw] = useState(SAMPLE);
  const [entries, setEntries] = useState<IniEntry[]>(() => parseIni(SAMPLE));
  const [section, setSection] = useState('');
  const [key, setKey] = useState('');
  const [value, setValue2] = useState('');
  const [getResult, setGetResult] = useState('');
  const [status, setStatus] = useState(() => t('iniedit.ready'));
  const fileRef = useRef<HTMLInputElement>(null);

  const parse = () => {
    try {
      const list = parseIni(raw);
      setEntries(list);
      const bad = list.filter((e) => e.note).length;
      setStatus(
        bad === 0
          ? t('iniedit.parsed', { count: list.length })
          : t('iniedit.parsedBad', { count: list.length, bad }),
      );
    } catch {
      setStatus(t('iniedit.parseFail'));
    }
  };

  const toRaw = () => {
    try {
      setRaw(serializeIni(entries));
      setStatus(t('iniedit.serialized'));
    } catch {
      setStatus(t('iniedit.serializeFail'));
    }
  };

  const copyRaw = () => {
    try {
      void navigator.clipboard?.writeText(raw ?? '');
      setStatus(t('iniedit.copied'));
    } catch {
      setStatus(t('iniedit.copyFail'));
    }
  };

  const onLoadFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) {
      setStatus(t('iniedit.loadCancelled'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setRaw(typeof reader.result === 'string' ? reader.result : '');
      setStatus(t('iniedit.loaded'));
    };
    reader.onerror = () => setStatus(t('iniedit.loadFail'));
    reader.readAsText(file);
  };

  const save = () => {
    try {
      let text = serializeIni(entries);
      if (!text) text = raw ?? '';
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'config.ini';
      a.click();
      URL.revokeObjectURL(url);
      setStatus(t('iniedit.saved'));
    } catch {
      setStatus(t('iniedit.saveFail'));
    }
  };

  const doSet = () => {
    try {
      if (!key.trim()) {
        setStatus(t('iniedit.enterKey'));
        return;
      }
      const [next, updated] = setValue(entries, section, key, value);
      setEntries(next);
      setStatus(updated ? t('iniedit.updated') : t('iniedit.added'));
    } catch {
      setStatus(t('iniedit.setFail'));
    }
  };

  const doRemove = () => {
    try {
      if (!key.trim()) {
        setStatus(t('iniedit.enterKeyRemove'));
        return;
      }
      const [next, n] = removeKey(entries, section, key);
      setEntries(next);
      setStatus(n > 0 ? t('iniedit.removed', { count: n }) : t('iniedit.notFound'));
    } catch {
      setStatus(t('iniedit.removeFail'));
    }
  };

  const doGet = () => {
    try {
      const v = getValue(entries, section, key);
      setGetResult(v === null ? t('iniedit.getNotFound') : `[${section}] ${key} = ${v}`);
      setStatus(v === null ? t('iniedit.noSuch') : t('iniedit.retrieved'));
    } catch {
      setStatus(t('iniedit.getFail'));
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('iniedit.blurb')}
      </p>
      <p className="count-note" style={{ marginTop: 0 }}>
        {status}
      </p>

      {/* Raw text */}
      <h3 className="group-title" style={{ marginTop: 4 }}>
        {t('iniedit.rawTitle')}
      </h3>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        style={{ width: '100%', minHeight: 180, fontFamily: 'Consolas, ui-monospace, monospace', whiteSpace: 'pre' }}
      />
      <div className="mod-toolbar" style={{ marginTop: 10 }}>
        <button className="mini primary" onClick={parse}>
          {t('iniedit.parse')}
        </button>
        <button className="mini" onClick={() => fileRef.current?.click()}>
          {t('iniedit.load')}
        </button>
        <button className="mini" onClick={copyRaw}>
          {t('iniedit.copyRaw')}
        </button>
        <input ref={fileRef} type="file" accept=".ini,.cfg,.conf,.txt" style={{ display: 'none' }} onChange={onLoadFile} />
      </div>

      {/* Entries */}
      <h3 className="group-title">{t('iniedit.listTitle')}</h3>
      <div className="dt-wrap" style={{ maxHeight: 260 }}>
        <table className="dt">
          <thead>
            <tr>
              <th>{t('iniedit.colSection')}</th>
              <th>{t('iniedit.colKey')}</th>
              <th>{t('iniedit.colValue')}</th>
              <th>{t('iniedit.colNote')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colSpan={4} className="count-note">
                  {t('iniedit.empty')}
                </td>
              </tr>
            ) : (
              entries.map((e, i) => (
                <tr key={i}>
                  <td style={{ color: 'var(--text-secondary, #888)' }}>{e.section}</td>
                  <td style={{ fontWeight: 600 }}>{e.key}</td>
                  <td className="env-val">{e.value}</td>
                  <td style={{ color: 'var(--warning, #c90)', fontSize: 11 }}>{e.note}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="mod-toolbar" style={{ marginTop: 10 }}>
        <button className="mini" onClick={toRaw}>
          {t('iniedit.toRaw')}
        </button>
        <button className="mini" onClick={save}>
          {t('iniedit.save')}
        </button>
      </div>

      {/* Add / edit / remove / get */}
      <h3 className="group-title">{t('iniedit.editTitle')}</h3>
      <div className="kv-row" style={{ marginBottom: 10 }}>
        <input
          className="mod-search"
          placeholder={t('iniedit.sectionPlaceholder')}
          value={section}
          onChange={(e) => setSection(e.target.value)}
        />
        <input className="mod-search" placeholder={t('iniedit.keyPlaceholder')} value={key} onChange={(e) => setKey(e.target.value)} />
        <input
          className="mod-search"
          style={{ flex: 1.4 }}
          placeholder={t('iniedit.valuePlaceholder')}
          value={value}
          onChange={(e) => setValue2(e.target.value)}
        />
      </div>
      <div className="mod-toolbar">
        <button className="mini primary" onClick={doSet}>
          {t('iniedit.set')}
        </button>
        <button className="mini" onClick={doRemove}>
          {t('iniedit.remove')}
        </button>
        <button className="mini" onClick={doGet}>
          {t('iniedit.get')}
        </button>
      </div>
      {getResult && (
        <p className="count-note" style={{ fontFamily: 'Consolas, ui-monospace, monospace', marginTop: 10 }}>
          {getResult}
        </p>
      )}
    </div>
  );
}
