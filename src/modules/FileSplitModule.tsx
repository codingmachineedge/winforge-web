import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// 格式化位元組數 · Human-readable byte count. Ported from FileSplitService.FormatBytes.
function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const unit = units[u]!;
  if (u === 0) return `${bytes} ${unit}`;
  // {v:0.##} — up to 2 decimals, trailing zeros trimmed.
  const rounded = Math.round(v * 100) / 100;
  return `${rounded} ${unit}`;
}

// Pad an index to 3 digits (matches C# $"{index:000}"): 1 -> "001", 42 -> "042", 1234 -> "1234".
function pad3(n: number): string {
  const s = String(n);
  return s.length >= 3 ? s : '0'.repeat(3 - s.length) + s;
}

// Trigger a browser download of a Blob under a given filename.
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Full SHA-256 hex (uppercase, matching Convert.ToHexString) of a Blob.
async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out.toUpperCase();
}

// Trailing ".NNN" part-number pattern used both for join ordering and stem detection.
const PART_RE = /\.(\d{3,})$/;

type Status = { ok: boolean; msg: string } | null;

export function FileSplitModule() {
  const { t } = useTranslation();

  // Split state
  const [source, setSource] = useState<File | null>(null);
  const [partMb, setPartMb] = useState(100);
  const [splitBusy, setSplitBusy] = useState(false);
  const [splitProgress, setSplitProgress] = useState(0);
  const [splitStatus, setSplitStatus] = useState<Status>(null);

  // Join state
  const [parts, setParts] = useState<File[]>([]);
  const [wantHash, setWantHash] = useState(true);
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinProgress, setJoinProgress] = useState(0);
  const [joinStatus, setJoinStatus] = useState<Status>(null);

  const onPickSource = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files && e.target.files[0];
    setSource(f ?? null);
    setSplitStatus(null);
    setSplitProgress(0);
  };

  const onPickParts = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files ? Array.from(e.target.files) : [];
    // Sort by the trailing part number so .001, .002, … join in order regardless of pick order.
    const sorted = list.slice().sort((a, b) => {
      const ma = a.name.match(PART_RE);
      const mb = b.name.match(PART_RE);
      const na = ma ? parseInt(ma[1]!, 10) : 0;
      const nb = mb ? parseInt(mb[1]!, 10) : 0;
      if (na !== nb) return na - nb;
      return a.name.localeCompare(b.name);
    });
    setParts(sorted);
    setJoinStatus(null);
    setJoinProgress(0);
  };

  const doSplit = async () => {
    if (splitBusy) return;
    if (!source) {
      setSplitStatus({ ok: false, msg: t('filesplit.pickFileFirst') });
      return;
    }
    const partBytes = Math.max(1, Math.floor(partMb * 1024 * 1024));
    const total = source.size;
    const name = source.name;

    setSplitBusy(true);
    setSplitProgress(0);
    setSplitStatus({ ok: true, msg: t('filesplit.splitting') });

    try {
      let index = 0;
      let offset = 0;
      let firstPart = '';
      // Empty source still produces exactly one (empty) part for a clean round-trip.
      do {
        index++;
        const end = Math.min(offset + partBytes, total);
        const slice = source.slice(offset, end);
        const partName = `${name}.${pad3(index)}`;
        if (index === 1) firstPart = partName;
        downloadBlob(slice, partName);
        offset = end;
        setSplitProgress(total > 0 ? Math.min(1, offset / total) : 1);
        // Yield so the UI can paint progress and downloads can queue.
        await new Promise((r) => setTimeout(r, 0));
      } while (offset < total);

      setSplitProgress(1);
      setSplitStatus({
        ok: true,
        msg: t('filesplit.splitDone', {
          parts: index,
          total: formatBytes(total),
          first: firstPart,
        }),
      });
    } catch (err) {
      setSplitStatus({
        ok: false,
        msg: t('filesplit.splitFailed') + (err instanceof Error ? err.message : String(err)),
      });
    } finally {
      setSplitBusy(false);
    }
  };

  const doJoin = async () => {
    if (joinBusy) return;
    if (parts.length === 0) {
      setJoinStatus({ ok: false, msg: t('filesplit.pickPartsFirst') });
      return;
    }

    // Suggest the original name by stripping the trailing ".NNN" from the first part.
    const firstName = parts[0]!.name;
    const m = firstName.match(PART_RE);
    const suggested = m ? firstName.slice(0, firstName.length - m[0]!.length) : firstName + '.joined';

    let total = 0;
    for (const p of parts) total += p.size;

    setJoinBusy(true);
    setJoinProgress(0);
    setJoinStatus({ ok: true, msg: t('filesplit.joining') });

    try {
      // Concatenate all parts in order into one Blob (lossless byte copy).
      const merged = new Blob(parts.slice(), { type: 'application/octet-stream' });
      setJoinProgress(0.5);

      let hash: string | null = null;
      if (wantHash) {
        hash = await sha256Hex(merged);
      }
      setJoinProgress(1);

      downloadBlob(merged, suggested);

      const baseMsg = t('filesplit.joinDone', {
        parts: parts.length,
        total: formatBytes(total),
        name: suggested,
      });
      setJoinStatus({
        ok: true,
        msg: hash ? baseMsg + '\n' + t('filesplit.sha256Prefix') + hash : baseMsg,
      });
    } catch (err) {
      setJoinStatus({
        ok: false,
        msg: t('filesplit.joinFailed') + (err instanceof Error ? err.message : String(err)),
      });
    } finally {
      setJoinBusy(false);
    }
  };

  const statusStyle = (s: Status): React.CSSProperties =>
    s && !s.ok
      ? { marginTop: 8, color: 'var(--danger)', fontSize: 12, whiteSpace: 'pre-wrap' }
      : { marginTop: 8, fontSize: 12, whiteSpace: 'pre-wrap' };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('filesplit.blurb')}
      </p>

      {/* Split card */}
      <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
          {t('filesplit.splitTitle')}
        </h3>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="mini">
            {t('filesplit.pickFile')}
            <input type="file" style={{ display: 'none' }} onChange={onPickSource} />
          </label>
          <span className="count-note" style={{ margin: 0 }}>
            {source ? `${source.name} · ${formatBytes(source.size)}` : t('filesplit.noFile')}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className="count-note" style={{ margin: 0 }}>
            {t('filesplit.partSize')}
          </span>
          <input
            className="mod-search"
            type="number"
            min={1}
            max={1048576}
            style={{ maxWidth: 150 }}
            value={partMb}
            onChange={(e) => setPartMb(Math.max(1, Math.min(1048576, Math.trunc(+e.target.value) || 1)))}
          />
        </div>

        <div>
          <button className="mini primary" disabled={splitBusy || !source} onClick={() => void doSplit()}>
            {t('filesplit.split')}
          </button>
        </div>

        <progress className="mod-progress" value={splitProgress} max={1} style={{ width: '100%' }} />
        {splitStatus && (
          <p className={splitStatus.ok ? 'count-note' : ''} style={statusStyle(splitStatus)}>
            {splitStatus.msg}
          </p>
        )}
      </div>

      {/* Join card */}
      <div className="kv-list" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>
          {t('filesplit.joinTitle')}
        </h3>

        <span className="count-note" style={{ margin: 0 }}>
          {t('filesplit.joinHint')}
        </span>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="mini">
            {t('filesplit.pickParts')}
            <input type="file" multiple style={{ display: 'none' }} onChange={onPickParts} />
          </label>
          <span className="count-note" style={{ margin: 0 }}>
            {parts.length === 0
              ? t('filesplit.noParts')
              : t('filesplit.partsChosen', { n: parts.length })}
          </span>
        </div>

        {parts.length > 0 && (
          <ul className="kv-list" style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
            {parts.map((p, i) => (
              <li key={p.name + '|' + i} className="count-note" style={{ margin: 0 }}>
                {p.name} · {formatBytes(p.size)}
              </li>
            ))}
          </ul>
        )}

        <label className="chk" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={wantHash} onChange={(e) => setWantHash(e.target.checked)} />
          {t('filesplit.showHash')}
        </label>

        <div>
          <button className="mini primary" disabled={joinBusy || parts.length === 0} onClick={() => void doJoin()}>
            {t('filesplit.join')}
          </button>
        </div>

        <progress className="mod-progress" value={joinProgress} max={1} style={{ width: '100%' }} />
        {joinStatus && (
          <p
            className={joinStatus.ok ? 'count-note' : ''}
            style={{ ...statusStyle(joinStatus), userSelect: 'text', wordBreak: 'break-all' }}
          >
            {joinStatus.msg}
          </p>
        )}
      </div>
    </div>
  );
}
