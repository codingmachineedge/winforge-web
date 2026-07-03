import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Pick = (en: string, zh: string) => string;

interface AsciiRow {
  code: number;
  dec: string;
  hex: string;
  oct: string;
  bin: string;
  char: string;
  name: string;
  copyChar: string;
  search: string;
}

// C0 control codes 0–31: mnemonic + bilingual (en, zh) description.
const C0: [string, string, string][] = [
  ['NUL', 'Null', '空字元'],
  ['SOH', 'Start of Heading', '標題開始'],
  ['STX', 'Start of Text', '文字開始'],
  ['ETX', 'End of Text', '文字結束'],
  ['EOT', 'End of Transmission', '傳輸結束'],
  ['ENQ', 'Enquiry', '查詢'],
  ['ACK', 'Acknowledge', '確認'],
  ['BEL', 'Bell', '響鈴'],
  ['BS', 'Backspace', '退格'],
  ['HT', 'Horizontal Tab', '水平定位（Tab）'],
  ['LF', 'Line Feed', '換行'],
  ['VT', 'Vertical Tab', '垂直定位'],
  ['FF', 'Form Feed', '換頁'],
  ['CR', 'Carriage Return', '歸位'],
  ['SO', 'Shift Out', '移出'],
  ['SI', 'Shift In', '移入'],
  ['DLE', 'Data Link Escape', '資料連結跳脫'],
  ['DC1', 'Device Control 1 (XON)', '裝置控制 1（XON）'],
  ['DC2', 'Device Control 2', '裝置控制 2'],
  ['DC3', 'Device Control 3 (XOFF)', '裝置控制 3（XOFF）'],
  ['DC4', 'Device Control 4', '裝置控制 4'],
  ['NAK', 'Negative Acknowledge', '否定確認'],
  ['SYN', 'Synchronous Idle', '同步閒置'],
  ['ETB', 'End of Transmission Block', '傳輸區塊結束'],
  ['CAN', 'Cancel', '取消'],
  ['EM', 'End of Medium', '媒體結束'],
  ['SUB', 'Substitute', '替代'],
  ['ESC', 'Escape', '跳脫'],
  ['FS', 'File Separator', '檔案分隔'],
  ['GS', 'Group Separator', '群組分隔'],
  ['RS', 'Record Separator', '記錄分隔'],
  ['US', 'Unit Separator', '單位分隔'],
];

function bin8(code: number): string {
  return (code & 0xff).toString(2).padStart(8, '0');
}

function oct(code: number): string {
  return '0o' + code.toString(8);
}

function buildRow(code: number, pick: Pick): AsciiRow {
  let glyph: string;
  let name: string;
  let copy: string;

  const c0 = C0[code];
  if (c0) {
    // 0–31 control codes
    const [mn, en, zh] = c0;
    glyph = mn;
    name = `${mn} — ${pick(en, zh)}`;
    copy = String.fromCharCode(code);
  } else if (code === 32) {
    glyph = 'SP';
    name = `SP — ${pick('Space', '空格')}`;
    copy = ' ';
  } else if (code === 127) {
    glyph = 'DEL';
    name = `DEL — ${pick('Delete', '刪除')}`;
    copy = String.fromCharCode(code);
  } else if (code >= 128 && code <= 160) {
    // C1 controls + NBSP boundary
    glyph = code === 160 ? 'NBSP' : 'CTRL';
    name =
      code === 160
        ? `NBSP — ${pick('No-Break Space', '不換行空格')}`
        : pick('C1 control', 'C1 控制碼');
    copy = String.fromCharCode(code);
  } else {
    // printable
    glyph = String.fromCharCode(code);
    name = pick('Printable', '可列印字元');
    copy = glyph;
  }

  const dec = String(code);
  const hex = '0x' + code.toString(16).toUpperCase().padStart(2, '0');
  const octStr = oct(code);
  const bin = bin8(code);
  return {
    code,
    dec,
    hex,
    oct: octStr,
    bin,
    char: glyph,
    name,
    copyChar: copy,
    search: `${dec} ${hex} ${octStr} ${bin} ${glyph} ${name}`.toLowerCase(),
  };
}

function buildAll(latin1: boolean, pick: Pick): AsciiRow[] {
  const rows: AsciiRow[] = [];
  const max = latin1 ? 255 : 127;
  for (let i = 0; i <= max; i++) rows.push(buildRow(i, pick));
  return rows;
}

function filterRows(rows: AsciiRow[], query: string): AsciiRow[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return rows;
  return rows.filter((r) => r.search.includes(q));
}

export function AsciiTableModule() {
  const { t, i18n } = useTranslation();
  const isZh = (i18n.language || '').toLowerCase().startsWith('zh');
  const pick: Pick = (en, zh) => (isZh ? zh : en);

  const [query, setQuery] = useState('');
  const [latin1, setLatin1] = useState(false);
  const [status, setStatus] = useState('');

  const all = useMemo(() => buildAll(latin1, pick), [latin1, isZh]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => filterRows(all, query), [all, query]);

  const copyRow = (row: AsciiRow) => {
    const toCopy = row.copyChar.length === 0 ? row.dec : row.copyChar;
    let label: string;
    if (row.copyChar.length === 0) {
      label = t('asciitable.copiedCode', { dec: row.dec, hex: row.hex });
    } else if (row.code <= 32 || row.code === 127 || (row.code >= 128 && row.code <= 160)) {
      // Control / space / C1 — copying the raw char is invisible, so name it.
      label = t('asciitable.copiedControl', { char: row.char, dec: row.dec });
    } else {
      label = t('asciitable.copiedChar', { char: row.char, dec: row.dec });
    }
    try {
      void navigator.clipboard?.writeText(toCopy);
      setStatus(label);
    } catch {
      setStatus(t('asciitable.copyFailed'));
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('asciitable.blurb')}
      </p>

      <div className="mod-toolbar">
        <input
          className="mod-search"
          placeholder={t('asciitable.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="chk">
          <input type="checkbox" checked={latin1} onChange={(e) => setLatin1(e.target.checked)} />
          {t('asciitable.includeLatin1')}
        </label>
        <span className="count-note">
          {t('asciitable.rowCount', { shown: rows.length, total: all.length })}
        </span>
      </div>

      <p className="count-note" style={{ marginTop: 0 }}>
        {status || t('asciitable.clickRow')}
      </p>

      <div className="dt-wrap" style={{ maxHeight: 480 }}>
        <table className="dt">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>{t('asciitable.colDec')}</th>
              <th style={{ textAlign: 'left' }}>{t('asciitable.colHex')}</th>
              <th style={{ textAlign: 'left' }}>{t('asciitable.colOct')}</th>
              <th style={{ textAlign: 'left' }}>{t('asciitable.colBin')}</th>
              <th style={{ textAlign: 'left' }}>{t('asciitable.colChar')}</th>
              <th style={{ textAlign: 'left' }}>{t('asciitable.colName')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code} style={{ cursor: 'pointer' }} onClick={() => copyRow(r)}>
                <td style={{ fontFamily: 'monospace' }}>{r.dec}</td>
                <td style={{ fontFamily: 'monospace' }}>{r.hex}</td>
                <td style={{ fontFamily: 'monospace', opacity: 0.7 }}>{r.oct}</td>
                <td style={{ fontFamily: 'monospace', opacity: 0.7 }}>{r.bin}</td>
                <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{r.char}</td>
                <td>{r.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
