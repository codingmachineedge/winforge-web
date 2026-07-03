import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Port of WinForge EnvDiffService. The desktop tool captures live OS environment
// variables and persists timestamped JSON snapshots to disk — neither is possible
// in the browser. The offline core that IS portable is the diff engine: paste two
// sets of environment variables (as KEY=VALUE lines or as a captured JSON snapshot)
// and compare them into Added / Removed / Changed, exactly matching the C# logic:
// keys compared case-insensitively (OrdinalIgnoreCase), values compared exactly
// (Ordinal), all groups sorted case-insensitively by key.

interface DiffEntry {
  key: string;
  oldValue: string;
  newValue: string;
}

interface DiffResult {
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffEntry[];
}

// EnvDiffService.DiffEntry.Display
function displayValue(e: DiffEntry): string {
  if (e.oldValue.length === 0 && e.newValue.length > 0) return e.newValue;
  if (e.newValue.length === 0 && e.oldValue.length > 0) return e.oldValue;
  return `${e.oldValue}  →  ${e.newValue}`;
}

// Case-insensitive key comparison for sorting (mirrors OrdinalIgnoreCase ordering
// closely enough for display; ties broken by exact key to stay stable).
function keyCompare(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// A case-insensitive map keyed by env var name. Later duplicates overwrite earlier
// ones (matches Dictionary<string,string> indexer assignment in ReadLive).
interface EnvMap {
  // lowered key -> [originalKey, value]
  entries: Map<string, [string, string]>;
}

function emptyMap(): EnvMap {
  return { entries: new Map() };
}

function setVar(m: EnvMap, key: string, value: string): void {
  if (key.length === 0) return;
  m.entries.set(key.toLowerCase(), [key, value]);
}

function getVar(m: EnvMap, key: string): string | undefined {
  const hit = m.entries.get(key.toLowerCase());
  return hit ? hit[1] : undefined;
}

function hasVar(m: EnvMap, key: string): boolean {
  return m.entries.has(key.toLowerCase());
}

// Parse pasted text into an EnvMap. Accepts either a captured JSON snapshot
// ({ "Vars": { ... } } or a bare object of key->value) or plain KEY=VALUE lines.
// Lines beginning with '#' and blank lines are ignored (matches the ToPlainText
// export format so a copied snapshot round-trips).
function parseEnv(text: string): EnvMap {
  const map = emptyMap();
  const trimmed = text.trim();
  if (trimmed.length === 0) return map;

  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as unknown;
      if (obj && typeof obj === 'object') {
        const rec = obj as Record<string, unknown>;
        const vars = rec['Vars'] ?? rec['vars'];
        const source: unknown =
          vars && typeof vars === 'object' ? vars : rec;
        const srcRec = source as Record<string, unknown>;
        for (const k of Object.keys(srcRec)) {
          const v = srcRec[k];
          if (typeof v === 'string') setVar(map, k, v);
          else if (typeof v === 'number' || typeof v === 'boolean') setVar(map, k, String(v));
        }
        return map;
      }
    } catch {
      // fall through to line parsing
    }
  }

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) {
      // A key with no '=' is treated as a present-but-empty variable.
      setVar(map, line, '');
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    setVar(map, key, value);
  }
  return map;
}

// EnvDiffService.Diff — Added (only in new), Removed (only in old),
// Changed (present in both, differing values by exact/Ordinal comparison).
function diffMaps(oldVars: EnvMap, newVars: EnvMap): DiffResult {
  const result: DiffResult = { added: [], removed: [], changed: [] };

  const newOrdered = [...newVars.entries.values()].sort((a, b) => keyCompare(a[0], b[0]));
  for (const [key, value] of newOrdered) {
    const ov = getVar(oldVars, key);
    if (ov === undefined) {
      result.added.push({ key, oldValue: '', newValue: value });
    } else if (ov !== value) {
      result.changed.push({ key, oldValue: ov, newValue: value });
    }
  }

  const oldOrdered = [...oldVars.entries.values()].sort((a, b) => keyCompare(a[0], b[0]));
  for (const [key, value] of oldOrdered) {
    if (!hasVar(newVars, key)) {
      result.removed.push({ key, oldValue: value, newValue: '' });
    }
  }

  return result;
}

// EnvDiffService.ToPlainText(DiffResult, leftLabel, rightLabel)
function diffToPlainText(diff: DiffResult, leftLabel: string, rightLabel: string): string {
  const lines: string[] = [];
  lines.push('# WinForge environment diff');
  lines.push(`# old: ${leftLabel}`);
  lines.push(`# new: ${rightLabel}`);
  lines.push('');
  lines.push(`## Added (${diff.added.length})`);
  for (const e of diff.added) lines.push(`+ ${e.key}=${e.newValue}`);
  lines.push('');
  lines.push(`## Removed (${diff.removed.length})`);
  for (const e of diff.removed) lines.push(`- ${e.key}=${e.oldValue}`);
  lines.push('');
  lines.push(`## Changed (${diff.changed.length})`);
  for (const e of diff.changed) lines.push(`~ ${e.key}: ${e.oldValue}  =>  ${e.newValue}`);
  return lines.join('\n');
}

const SAMPLE_OLD = `PATH=C:\\Windows;C:\\Windows\\System32
JAVA_HOME=C:\\Java\\jdk-17
NODE_ENV=development
TEMP=C:\\Temp`;

const SAMPLE_NEW = `PATH=C:\\Windows;C:\\Windows\\System32;C:\\Tools
JAVA_HOME=C:\\Java\\jdk-21
NODE_ENV=production
GRADLE_HOME=C:\\Gradle`;

export function EnvDiffModule() {
  const { t } = useTranslation();

  const [oldText, setOldText] = useState(SAMPLE_OLD);
  const [newText, setNewText] = useState(SAMPLE_NEW);
  const [status, setStatus] = useState('');

  const oldMap = useMemo(() => parseEnv(oldText), [oldText]);
  const newMap = useMemo(() => parseEnv(newText), [newText]);
  const diff = useMemo(() => diffMaps(oldMap, newMap), [oldMap, newMap]);

  const oldCount = oldMap.entries.size;
  const newCount = newMap.entries.size;

  const copyDiff = () => {
    const text = diffToPlainText(
      diff,
      t('envdiff.oldLabel') + ` (${oldCount})`,
      t('envdiff.newLabel') + ` (${newCount})`,
    );
    try {
      void navigator.clipboard?.writeText(text);
      setStatus(t('envdiff.copied'));
    } catch {
      setStatus(t('envdiff.copyFailed'));
    }
  };

  const pasteInto = async (which: 'old' | 'new') => {
    try {
      const text = await navigator.clipboard?.readText();
      if (typeof text === 'string') {
        if (which === 'old') setOldText(text);
        else setNewText(text);
        setStatus(t('envdiff.pasted'));
      }
    } catch {
      setStatus(t('envdiff.pasteFailed'));
    }
  };

  const swap = () => {
    setOldText(newText);
    setNewText(oldText);
    setStatus('');
  };

  const clearAll = () => {
    setOldText('');
    setNewText('');
    setStatus('');
  };

  const renderGroup = (title: string, entries: DiffEntry[], sign: string, color: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <h3 className="group-title" style={{ fontSize: 14, margin: 0 }}>
        {title} ({entries.length})
      </h3>
      <div className="dt-wrap" style={{ maxHeight: 260 }}>
        {entries.length === 0 ? (
          <p className="count-note" style={{ margin: '6px 0' }}>
            {t('envdiff.none')}
          </p>
        ) : (
          entries.map((e) => (
            <div key={e.key} style={{ padding: '3px 0', minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5, wordBreak: 'break-all' }}>
                <span style={{ color, marginRight: 4 }}>{sign}</span>
                {e.key}
              </div>
              <div
                className="count-note"
                style={{ margin: 0, fontSize: 11.5, fontFamily: 'Consolas, monospace', wordBreak: 'break-all' }}
              >
                {displayValue(e)}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('envdiff.blurb')}
      </p>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('envdiff.offlineNote')}
      </p>

      <div className="mod-toolbar">
        <button className="mini" onClick={swap}>
          {t('envdiff.swap')}
        </button>
        <button className="mini" onClick={copyDiff}>
          {t('envdiff.copyDiff')}
        </button>
        <button className="mini" onClick={clearAll}>
          {t('envdiff.clear')}
        </button>
        <span className="count-note">
          {t('envdiff.summary', {
            added: diff.added.length,
            removed: diff.removed.length,
            changed: diff.changed.length,
          })}
        </span>
      </div>

      <div className="io-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="count-note" style={{ margin: 0 }}>
              {t('envdiff.oldLabel')} · {t('envdiff.varCount', { count: oldCount })}
            </span>
            <button className="mini" onClick={() => void pasteInto('old')}>
              {t('envdiff.paste')}
            </button>
          </div>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            value={oldText}
            onChange={(e) => setOldText(e.target.value)}
            placeholder={t('envdiff.inputPlaceholder')}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="count-note" style={{ margin: 0 }}>
              {t('envdiff.newLabel')} · {t('envdiff.varCount', { count: newCount })}
            </span>
            <button className="mini" onClick={() => void pasteInto('new')}>
              {t('envdiff.paste')}
            </button>
          </div>
          <textarea
            className="hosts-edit"
            spellCheck={false}
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            placeholder={t('envdiff.inputPlaceholder')}
          />
        </div>
      </div>

      {status && (
        <p className="count-note" style={{ marginTop: 10 }}>
          {status}
        </p>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 12,
          marginTop: 16,
        }}
      >
        {renderGroup(t('envdiff.added'), diff.added, '+', 'var(--ok, #2e7d32)')}
        {renderGroup(t('envdiff.removed'), diff.removed, '-', 'var(--danger, #c62828)')}
        {renderGroup(t('envdiff.changed'), diff.changed, '~', 'var(--accent, #1565c0)')}
      </div>
    </div>
  );
}
