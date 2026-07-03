import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge PathDoctorService. WinForge Web reads/writes the
// User & Machine "Path" environment variables and checks whether each folder exists on
// disk. A browser cannot read env vars or the filesystem, so this port operates on a
// PATH string the user pastes in: split, dedupe, remove dead-by-syntax, sort, reorder,
// remove, add, and a before/after preview. "Exists" and "Apply" are not web-computable
// and are shown as read-only info. Never throws.

/** Split a ';'-separated string, dropping empties and trimming. */
function splitPath(raw: string): string[] {
  if (!raw) return [];
  try {
    return raw
      .split(';')
      .map((e) => e.trim())
      .filter((e) => e.length > 0);
  } catch {
    return [];
  }
}

/** Join entries back into a ';'-separated string. */
function joinPath(entries: string[]): string {
  try {
    return entries.filter((e) => e && e.trim().length > 0).join(';');
  } catch {
    return '';
  }
}

/** Remove case-insensitive duplicates, keeping the first (matches service Dedupe). */
function dedupe(entries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  try {
    for (const e of entries) {
      const key = (e ?? '').trim().replace(/[\\/]+$/, '').toLowerCase();
      if (key.length === 0) continue;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(e.trim());
      }
    }
  } catch {
    /* ignore */
  }
  return result;
}

/** Count case-insensitive duplicates that dedupe would remove. */
function dupeCount(entries: string[]): number {
  return entries.length - dedupe(entries).length;
}

/** Sort entries case-insensitively (matches service Sort). */
function sortEntries(entries: string[]): string[] {
  try {
    return [...entries].sort((a, b) =>
      a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0,
    );
  } catch {
    return [...entries];
  }
}

/**
 * Web stand-in for the desktop directory-existence check. A browser cannot touch the
 * filesystem, so we can only judge an entry by syntax: blank or obviously malformed
 * entries are flagged as "dead" (removable), everything else is "unknown".
 */
function looksDead(entry: string): boolean {
  const e = (entry ?? '').trim();
  if (e.length === 0) return true;
  // Contains characters illegal in Windows paths.
  if (/[<>"|?*]/.test(e)) return true;
  return false;
}

/** Remove entries that look syntactically dead. */
function removeDead(entries: string[]): string[] {
  try {
    return entries.filter((e) => !looksDead(e));
  } catch {
    return [...entries];
  }
}

const SAMPLE =
  'C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem;' +
  'C:\\Program Files\\Git\\cmd;C:\\Windows\\system32;' +
  '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;' +
  'C:\\Program Files\\Nonexistent<bad>\\bin';

export function PathDoctorModule() {
  const { t } = useTranslation();
  const [scope, setScope] = useState<'user' | 'machine'>('user');
  const [original, setOriginal] = useState<string>(SAMPLE);
  const [working, setWorking] = useState<string[]>(() => splitPath(SAMPLE));
  const [selected, setSelected] = useState<number>(-1);
  const [newEntry, setNewEntry] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);

  const counts = useMemo(() => {
    const total = working.length;
    const dead = working.filter((e) => looksDead(e)).length;
    const dupes = dupeCount(working);
    return { total, dead, dupes };
  }, [working]);

  const afterText = useMemo(() => joinPath(working), [working]);

  // Load / re-parse the pasted PATH into working entries.
  const loadFromText = (text: string) => {
    setOriginal(text);
    setWorking(splitPath(text));
    setSelected(-1);
    setStatus(t('pathdoctor.loaded'));
  };

  const moveUp = () => {
    const i = selected;
    if (i > 0 && i < working.length) {
      const next = [...working];
      const a = next[i - 1]!;
      const b = next[i]!;
      next[i - 1] = b;
      next[i] = a;
      setWorking(next);
      setSelected(i - 1);
    }
  };

  const moveDown = () => {
    const i = selected;
    if (i >= 0 && i < working.length - 1) {
      const next = [...working];
      const a = next[i + 1]!;
      const b = next[i]!;
      next[i + 1] = b;
      next[i] = a;
      setWorking(next);
      setSelected(i + 1);
    }
  };

  const remove = () => {
    const i = selected;
    if (i >= 0 && i < working.length) {
      const next = working.filter((_, idx) => idx !== i);
      setWorking(next);
      setSelected(next.length === 0 ? -1 : Math.min(i, next.length - 1));
      setStatus(t('pathdoctor.removed'));
    }
  };

  const add = () => {
    const folder = newEntry.trim();
    if (folder.length === 0) return;
    const dupKey = folder.replace(/[\\/]+$/, '').toLowerCase();
    const exists = working.some((x) => x.trim().replace(/[\\/]+$/, '').toLowerCase() === dupKey);
    if (exists) {
      setStatus(t('pathdoctor.alreadyIn'));
      return;
    }
    const next = [...working, folder];
    setWorking(next);
    setSelected(next.length - 1);
    setNewEntry('');
    setStatus(t('pathdoctor.added'));
  };

  const doDedupe = () => {
    const before = working.length;
    const next = dedupe(working);
    setWorking(next);
    setSelected(-1);
    setStatus(t('pathdoctor.removedDupes', { n: before - next.length }));
  };

  const doDead = () => {
    const before = working.length;
    const next = removeDead(working);
    setWorking(next);
    setSelected(-1);
    setStatus(t('pathdoctor.removedDead', { n: before - next.length }));
  };

  const doSort = () => {
    setWorking(sortEntries(working));
    setSelected(-1);
    setStatus(t('pathdoctor.sorted'));
  };

  const reload = () => loadFromText(original);

  const copyAfter = () => {
    if (!afterText) return;
    navigator.clipboard?.writeText(afterText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const beforeEntries = useMemo(() => splitPath(original), [original]);

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('pathdoctor.blurb')}
      </p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('pathdoctor.editing')}</label>
        <select
          className="mod-select"
          value={scope}
          onChange={(e) => setScope(e.target.value as 'user' | 'machine')}
        >
          <option value="user">{t('pathdoctor.scopeUser')}</option>
          <option value="machine">{t('pathdoctor.scopeMachine')}</option>
        </select>
      </div>

      {/* Paste / edit the raw PATH the browser cannot read on its own. */}
      <label className="count-note">{t('pathdoctor.pasteLabel')}</label>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        value={original}
        onChange={(e) => loadFromText(e.target.value)}
        placeholder={t('pathdoctor.pastePlaceholder')}
        style={{ minHeight: 70, fontFamily: 'monospace', marginBottom: 8 }}
      />

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini" disabled={selected <= 0} onClick={moveUp}>
          {t('pathdoctor.moveUp')}
        </button>
        <button className="mini" disabled={selected < 0 || selected >= working.length - 1} onClick={moveDown}>
          {t('pathdoctor.moveDown')}
        </button>
        <button className="mini" disabled={selected < 0} onClick={remove}>
          {t('pathdoctor.remove')}
        </button>
        <button className="mini" onClick={doDedupe}>
          {t('pathdoctor.dedupe')}
        </button>
        <button className="mini" onClick={doDead}>
          {t('pathdoctor.removeDead')}
        </button>
        <button className="mini" onClick={doSort}>
          {t('pathdoctor.sort')}
        </button>
        <button className="mini" onClick={reload}>
          {t('pathdoctor.reload')}
        </button>
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 200, fontFamily: 'monospace' }}
          value={newEntry}
          onChange={(e) => setNewEntry(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
          placeholder={t('pathdoctor.addPlaceholder')}
        />
        <button className="mini primary" disabled={newEntry.trim().length === 0} onClick={add}>
          {t('pathdoctor.add')}
        </button>
      </div>

      <p className="count-note">
        {t('pathdoctor.counts', { total: counts.total, dead: counts.dead, dupes: counts.dupes })}
      </p>

      {/* Editable entry list. */}
      <div className="panel">
        <div className="label" style={{ marginBottom: 6 }}>
          {t('pathdoctor.entries')}
        </div>
        {working.length === 0 ? (
          <p className="count-note" style={{ margin: 0 }}>
            {t('pathdoctor.empty')}
          </p>
        ) : (
          <div className="kv-list">
            {working.map((entry, i) => {
              const dead = looksDead(entry);
              return (
                <div
                  key={`${i}-${entry}`}
                  className="kv-row"
                  onClick={() => setSelected(i)}
                  style={{
                    cursor: 'pointer',
                    background: selected === i ? 'var(--sel, rgba(127,127,127,0.18))' : undefined,
                    borderRadius: 4,
                  }}
                >
                  <span
                    className="label"
                    style={{
                      fontFamily: 'monospace',
                      minWidth: 20,
                      color: dead ? 'var(--danger)' : 'limegreen',
                    }}
                    title={dead ? t('pathdoctor.markDead') : t('pathdoctor.markUnknown')}
                  >
                    {dead ? '✗' : '•'}
                  </span>
                  <span className="value" style={{ fontFamily: 'monospace' }}>
                    {entry}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Before / after preview. */}
      <div className="panel">
        <div className="label" style={{ marginBottom: 6 }}>
          {t('pathdoctor.previewTitle')}
        </div>
        <div className="io-grid">
          <div>
            <div className="count-note">{t('pathdoctor.beforeLabel')}</div>
            <textarea
              className="hosts-edit"
              spellCheck={false}
              readOnly
              value={beforeEntries.length === 0 ? t('pathdoctor.emptyParen') : beforeEntries.join(';\n')}
              style={{ minHeight: 140, fontFamily: 'monospace' }}
            />
          </div>
          <div>
            <div className="count-note">{t('pathdoctor.afterLabel')}</div>
            <textarea
              className="hosts-edit"
              spellCheck={false}
              readOnly
              value={working.length === 0 ? t('pathdoctor.emptyParen') : working.join(';\n')}
              style={{ minHeight: 140, fontFamily: 'monospace' }}
            />
          </div>
        </div>
        <div className="mod-toolbar" style={{ marginTop: 8 }}>
          <button className="mini" disabled={!afterText} onClick={copyAfter}>
            {copied ? t('pathdoctor.copied') : t('pathdoctor.copyAfter')}
          </button>
        </div>
      </div>

      {/* Apply is desktop-only. */}
      <p className="count-note" style={{ color: 'var(--danger)' }}>
        {scope === 'machine' ? t('pathdoctor.applyMachineNote') : t('pathdoctor.applyUserNote')}
      </p>

      {status && <p className="count-note">{status}</p>}
    </div>
  );
}
