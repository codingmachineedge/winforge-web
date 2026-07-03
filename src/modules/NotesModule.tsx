import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Faithful web port of WinForge NotesModule — a persistent scratchpad. Left list of note
 * titles + a large multiline editor, with search, New / Rename / Delete, live word & char
 * counts and debounced auto-save (~800 ms). Desktop file IO (NotesService) is replaced with
 * browser localStorage; everything is guarded and never throws.
 */

interface Note {
  id: string;
  title: string;
  body: string;
  modified: number; // epoch ms
}

const STORE_KEY = 'winforge.notes.v1';

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function loadNotes(): Note[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Note[] = [];
    for (const item of parsed) {
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        out.push({
          id: typeof o.id === 'string' ? o.id : newId(),
          title: typeof o.title === 'string' ? o.title : '',
          body: typeof o.body === 'string' ? o.body : '',
          modified: typeof o.modified === 'number' ? o.modified : Date.now(),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function saveNotes(notes: Note[]): boolean {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(notes));
    return true;
  } catch {
    return false;
  }
}

function countWords(text: string): number {
  return text.split(/[\s\r\n\t]+/).filter((s) => s.length > 0).length;
}

export function NotesModule() {
  const { t } = useTranslation();
  const [notes, setNotes] = useState<Note[]>(() => loadNotes());
  const [currentId, setCurrentId] = useState<string | null>(() => {
    const first = loadNotes()[0];
    return first ? first.id : null;
  });
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState(false); // rename mode
  const [renameText, setRenameText] = useState('');

  // Filtered view (title OR body contains query, case-insensitive).
  const view = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return notes;
    return notes.filter(
      (n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q),
    );
  }, [notes, query]);

  const current = useMemo(
    () => notes.find((n) => n.id === currentId) ?? null,
    [notes, currentId],
  );

  // Debounced auto-save (~800 ms) — mirrors the WinForge save timer.
  useEffect(() => {
    const handle = setTimeout(() => {
      const ok = saveNotes(notes);
      setStatus(ok ? t('notes.saved') : t('notes.saveError'));
    }, 800);
    return () => clearTimeout(handle);
  }, [notes, t]);

  // Keep a valid selection when the filtered view changes.
  useEffect(() => {
    if (current && view.some((n) => n.id === current.id)) return;
    const first = view[0];
    setCurrentId(first ? first.id : null);
  }, [view, current]);

  const selectNote = (id: string) => {
    setEditing(false);
    setCurrentId(id);
  };

  const onEdit = (body: string) => {
    if (!currentId) return;
    setNotes((prev) =>
      prev.map((n) => (n.id === currentId ? { ...n, body, modified: Date.now() } : n)),
    );
  };

  const addNote = () => {
    const note: Note = {
      id: newId(),
      title: t('notes.untitled'),
      body: '',
      modified: Date.now(),
    };
    setNotes((prev) => [note, ...prev]);
    setCurrentId(note.id);
    setEditing(false);
    setStatus(t('notes.saved'));
  };

  const beginRename = () => {
    if (!current) return;
    setRenameText(current.title);
    setEditing(true);
  };

  const commitRename = () => {
    if (!current) {
      setEditing(false);
      return;
    }
    const name = renameText.trim();
    if (name.length === 0) {
      setEditing(false);
      return;
    }
    setNotes((prev) =>
      prev.map((n) => (n.id === current.id ? { ...n, title: name, modified: Date.now() } : n)),
    );
    setEditing(false);
  };

  const deleteNote = () => {
    if (!current) return;
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      const ok = window.confirm(t('notes.confirmDelete', { title: current.title }));
      if (!ok) return;
    }
    setNotes((prev) => prev.filter((n) => n.id !== current.id));
  };

  const bodyText = current?.body ?? '';
  const chars = bodyText.length;
  const words = countWords(bodyText);

  const fmtTime = (ms: number): string => {
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return '';
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('notes.blurb')}</p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini primary" onClick={addNote}>{t('notes.new')}</button>
        <button className="mini" disabled={!current} onClick={beginRename}>{t('notes.rename')}</button>
        <button className="mini" disabled={!current} onClick={deleteNote}>{t('notes.delete')}</button>
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 160 }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('notes.searchPlaceholder')}
        />
      </div>

      <div className="io-grid" style={{ gridTemplateColumns: '240px 1fr', alignItems: 'stretch' }}>
        <div className="panel" style={{ overflowY: 'auto', maxHeight: 420, padding: 6 }}>
          {view.length === 0 ? (
            <p className="count-note" style={{ padding: 8 }}>
              {notes.length === 0 ? t('notes.emptyList') : t('notes.noMatches')}
            </p>
          ) : (
            <div className="kv-list">
              {view.map((n) => {
                const active = n.id === currentId;
                return (
                  <div
                    key={n.id}
                    className="kv-row"
                    onClick={() => selectNote(n.id)}
                    style={{
                      cursor: 'pointer',
                      display: 'block',
                      padding: '6px 8px',
                      borderRadius: 4,
                      background: active ? 'var(--accent, #2a6)' : undefined,
                      color: active ? '#fff' : undefined,
                    }}
                  >
                    <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {n.title || t('notes.untitled')}
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.7, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {fmtTime(n.modified)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {editing && current ? (
            <div className="mod-toolbar" style={{ marginBottom: 6 }}>
              <input
                className="mod-search"
                autoFocus
                style={{ flex: 1 }}
                value={renameText}
                onChange={(e) => setRenameText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  else if (e.key === 'Escape') setEditing(false);
                }}
                placeholder={t('notes.name')}
              />
              <button className="mini primary" onClick={commitRename}>{t('notes.ok')}</button>
              <button className="mini" onClick={() => setEditing(false)}>{t('notes.cancel')}</button>
            </div>
          ) : null}
          <textarea
            className="hosts-edit"
            spellCheck={false}
            disabled={!current}
            value={bodyText}
            onChange={(e) => onEdit(e.target.value)}
            placeholder={current ? t('notes.editorPlaceholder') : t('notes.selectPrompt')}
            style={{ flex: 1, minHeight: 360 }}
          />
        </div>
      </div>

      <div className="mod-toolbar" style={{ justifyContent: 'space-between' }}>
        <span className="count-note">{t('notes.count', { words, chars })}</span>
        <span className="count-note">{status}</span>
      </div>
    </div>
  );
}
