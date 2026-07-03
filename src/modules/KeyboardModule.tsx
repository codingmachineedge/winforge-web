import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// Ported from ../WinForge/Services/KeyboardRemapper.cs — same key set + scancodes.
interface KeyDef {
  en: string;
  zh: string;
  scancode: number;
}

const KEYS: KeyDef[] = [
  { en: 'Caps Lock', zh: 'Caps Lock', scancode: 0x003a },
  { en: 'Left Ctrl', zh: '左 Ctrl', scancode: 0x001d },
  { en: 'Left Alt', zh: '左 Alt', scancode: 0x0038 },
  { en: 'Left Shift', zh: '左 Shift', scancode: 0x002a },
  { en: 'Left Win', zh: '左 Win', scancode: 0xe05b },
  { en: 'Right Win', zh: '右 Win', scancode: 0xe05c },
  { en: 'Menu (Apps)', zh: '選單鍵', scancode: 0xe05d },
  { en: 'Esc', zh: 'Esc', scancode: 0x0001 },
  { en: 'Tab', zh: 'Tab', scancode: 0x000f },
  { en: 'Insert', zh: 'Insert', scancode: 0xe052 },
  { en: 'Scroll Lock', zh: 'Scroll Lock', scancode: 0x0046 },
  { en: 'Num Lock', zh: 'Num Lock', scancode: 0x0045 },
  { en: 'Print Screen', zh: 'Print Screen', scancode: 0xe037 },
  { en: 'Enter', zh: 'Enter', scancode: 0x001c },
  { en: 'Backspace', zh: 'Backspace', scancode: 0x000e },
];

const DISABLE = 0;

interface KeyMap {
  source: number;
  target: number;
}

function hex4(n: number): string {
  return '0x' + n.toString(16).toUpperCase().padStart(4, '0');
}

function nameOf(scancode: number, disabledLabel: string): string {
  if (scancode === DISABLE) return disabledLabel;
  const k = KEYS.find((x) => x.scancode === scancode);
  return k ? `${k.en} · ${k.zh}` : hex4(scancode);
}

/**
 * Decode the HKLM "Scancode Map" REG_BINARY into mappings.
 * Layout (mirrors KeyboardRemapper.GetCurrent): 8 header bytes, uint32 count
 * (= entries + 1 null terminator) at offset 8, then count-1 entries of 4 bytes
 * each at offset 12 — little-endian target word then source word.
 */
function decodeScancodeMap(bytes: number[]): KeyMap[] {
  const result: KeyMap[] = [];
  if (bytes.length < 16) return result;
  const u32 = (o: number) =>
    (bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16) | (bytes[o + 3]! << 24)) >>> 0;
  const count = u32(8);
  const entries = count - 1;
  let o = 12;
  for (let i = 0; i < entries && o + 4 <= bytes.length; i++, o += 4) {
    const target = (bytes[o]! | (bytes[o + 1]! << 8)) & 0xffff;
    const source = (bytes[o + 2]! | (bytes[o + 3]! << 8)) & 0xffff;
    result.push({ source, target });
  }
  return result;
}

/** Build the REG_BINARY payload (mirrors KeyboardRemapper.Build). */
function buildScancodeMap(maps: KeyMap[]): number[] {
  const bytes = new Array<number>(8 + 4 + maps.length * 4 + 4).fill(0);
  const c = maps.length + 1;
  bytes[8] = c & 0xff;
  bytes[9] = (c >> 8) & 0xff;
  bytes[10] = (c >> 16) & 0xff;
  bytes[11] = (c >> 24) & 0xff;
  let o = 12;
  for (const m of maps) {
    bytes[o + 0] = m.target & 0xff;
    bytes[o + 1] = (m.target >> 8) & 0xff;
    bytes[o + 2] = m.source & 0xff;
    bytes[o + 3] = (m.source >> 8) & 0xff;
    o += 4;
  }
  return bytes;
}

const REG_KEY = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Keyboard Layout';
const REG_VALUE = 'Scancode Map';

export function KeyboardModule() {
  const { t } = useTranslation();
  const disabledLabel = t('keyboard.disabledLabel');

  // Live read of the current Scancode Map from the registry (READ-ONLY).
  const { data, loading, error, reload } = useAsync(
    () =>
      runPowershellJson<{ Byte: number }>(
        `$p='${REG_KEY}'; $v='${REG_VALUE}';
         $item = Get-ItemProperty -Path $p -Name $v -ErrorAction SilentlyContinue;
         if ($item -and $item.'${REG_VALUE}') { $item.'${REG_VALUE}' | ForEach-Object { [pscustomobject]@{ Byte = [int]$_ } } }`,
      ),
    [],
  );

  const currentMaps = useMemo(
    () => decodeScancodeMap((data ?? []).map((b) => b.Byte)),
    [data],
  );

  // Proposed mappings the user is composing (starts empty; not written until Apply).
  const [maps, setMaps] = useState<KeyMap[]>([]);
  const [fromSc, setFromSc] = useState<number>(KEYS[0]!.scancode);
  const [toSc, setToSc] = useState<number>(DISABLE);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadCurrentIntoEditor = () => {
    setMaps(currentMaps.map((m) => ({ ...m })));
    setMsg(null);
  };

  const add = () => {
    if (fromSc === toSc) {
      setMsg({ kind: 'warn', text: t('keyboard.sameKey') });
      return;
    }
    // one mapping per source key
    setMaps((prev) => [...prev.filter((m) => m.source !== fromSc), { source: fromSc, target: toSc }]);
    setMsg(null);
  };

  const remove = (source: number) => {
    setMaps((prev) => prev.filter((m) => m.source !== source));
  };

  const write = async (payload: number[] | null) => {
    setBusy(true);
    setMsg(null);
    try {
      const script =
        payload === null
          ? `Remove-ItemProperty -Path '${REG_KEY}' -Name '${REG_VALUE}' -ErrorAction Stop; 'ok'`
          : `Set-ItemProperty -Path '${REG_KEY}' -Name '${REG_VALUE}' -Value ([byte[]]@(${payload.join(',')})) -Type Binary -ErrorAction Stop; 'ok'`;
      const res = await runPowershell(script);
      if (!res.success) {
        const err = (res.stderr || '').toLowerCase();
        if (err.includes('denied') || err.includes('requested registry access') || err.includes('unauthorized')) {
          setMsg({ kind: 'err', text: t('keyboard.needAdmin') });
        } else {
          setMsg({ kind: 'err', text: `${t('keyboard.failed')}: ${res.stderr.trim() || `exit ${res.code}`}` });
        }
        return;
      }
      setMsg({
        kind: 'ok',
        text: payload === null ? t('keyboard.cleared') : t('keyboard.saved', { n: maps.length }),
      });
      reload();
    } catch (e) {
      setMsg({ kind: 'err', text: `${t('keyboard.failed')}: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (maps.length === 0) {
      // Applying an empty set == clear all.
      if (!window.confirm(t('keyboard.confirmClear'))) return;
      void write(null);
      return;
    }
    if (!window.confirm(t('keyboard.confirmApply', { n: maps.length }))) return;
    void write(buildScancodeMap(maps));
  };

  const clearAll = () => {
    if (!window.confirm(t('keyboard.confirmClear'))) return;
    void write(null);
  };

  const currentColumns: Column<KeyMap>[] = [
    { key: 'source', header: t('keyboard.from'), render: (m) => nameOf(m.source, disabledLabel) },
    { key: 'arrow', header: '', width: 30, align: 'center', render: () => '→' },
    {
      key: 'target',
      header: t('keyboard.to'),
      render: (m) => <strong>{nameOf(m.target, disabledLabel)}</strong>,
    },
  ];

  const editorColumns: Column<KeyMap>[] = [
    { key: 'source', header: t('keyboard.from'), render: (m) => nameOf(m.source, disabledLabel) },
    { key: 'arrow', header: '', width: 30, align: 'center', render: () => '→' },
    {
      key: 'target',
      header: t('keyboard.to'),
      render: (m) => <strong>{nameOf(m.target, disabledLabel)}</strong>,
    },
    {
      key: 'actions',
      header: '',
      width: 90,
      render: (m) => (
        <span className="row-actions">
          <button className="mini" onClick={() => remove(m.source)}>
            {t('keyboard.removeRow')}
          </button>
        </span>
      ),
    },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('keyboard.blurb')}
      </p>

      {/* Live current state from the registry. */}
      <ModuleToolbar>
        <StatusDot
          ok={currentMaps.length > 0}
          label={t('keyboard.activeCount', { n: currentMaps.length })}
        />
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <button
          className="mini"
          disabled={currentMaps.length === 0}
          onClick={loadCurrentIntoEditor}
        >
          {t('keyboard.loadCurrent')}
        </button>
      </ModuleToolbar>

      <AsyncState loading={loading} error={error}>
        <DataTable
          columns={currentColumns}
          rows={currentMaps}
          rowKey={(m) => `cur-${m.source}`}
          empty={t('keyboard.noneActive')}
        />
      </AsyncState>

      {/* Editor — compose a proposed map. Nothing is written until Apply. */}
      <h4 style={{ margin: '16px 0 6px' }}>{t('keyboard.builderTitle')}</h4>
      <ModuleToolbar>
        <span style={{ alignSelf: 'center' }}>{t('keyboard.map')}</span>
        <select
          className="mod-search"
          value={fromSc}
          onChange={(e) => setFromSc(Number(e.target.value))}
        >
          {KEYS.map((k) => (
            <option key={k.scancode} value={k.scancode}>
              {k.en} · {k.zh}
            </option>
          ))}
        </select>
        <span style={{ alignSelf: 'center' }}>→</span>
        <select className="mod-search" value={toSc} onChange={(e) => setToSc(Number(e.target.value))}>
          {KEYS.map((k) => (
            <option key={k.scancode} value={k.scancode}>
              {k.en} · {k.zh}
            </option>
          ))}
          <option value={DISABLE}>{t('keyboard.disableKey')}</option>
        </select>
        <button className="mini primary" onClick={add}>
          {t('keyboard.add')}
        </button>
      </ModuleToolbar>

      <DataTable
        columns={editorColumns}
        rows={maps}
        rowKey={(m) => `edit-${m.source}`}
        empty={t('keyboard.builderEmpty')}
      />

      <ModuleToolbar>
        <button className="mini primary" disabled={busy} onClick={apply}>
          {t('keyboard.apply')}
        </button>
        <button className="mini" disabled={busy} onClick={clearAll}>
          {t('keyboard.clearAll')}
        </button>
        <span className="count-note" style={{ alignSelf: 'center' }}>
          {t('keyboard.mappingCount', { n: maps.length })}
        </span>
      </ModuleToolbar>

      {msg && (
        <p className={`mod-msg ${msg.kind === 'err' ? 'error' : ''}`}>{msg.text}</p>
      )}
      <p className="count-note">{t('keyboard.rebootNote')}</p>
    </div>
  );
}
