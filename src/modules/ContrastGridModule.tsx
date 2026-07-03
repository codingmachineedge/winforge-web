import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// ---- WCAG contrast helpers (ported from ContrastGridService.cs) ----

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const AA_NORMAL = 4.5;
const AAA_NORMAL = 7.0;
const AA_LARGE = 3.0;
const AAA_LARGE = 4.5;

function toHex(c: Rgb): string {
  const h = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function inByte(v: number): boolean {
  return Number.isInteger(v) && v >= 0 && v <= 255;
}

/** Parse "#RGB", "#RRGGBB", "RRGGBB", "rgb(r,g,b)" or "r,g,b". Returns null on failure. */
function parseColor(input: string | null | undefined): Rgb | null {
  try {
    if (!input || !input.trim()) return null;
    const s = input.trim();

    // rgb(...) or r,g,b
    let body = s;
    if (s.toLowerCase().startsWith('rgb')) {
      const lp = s.indexOf('(');
      const rp = s.indexOf(')');
      if (lp >= 0 && rp > lp) body = s.substring(lp + 1, rp);
    }
    if (body.includes(',')) {
      const parts = body.split(/[,\s]+/).filter((p) => p.length > 0);
      if (parts.length >= 3) {
        const r = Number(parts[0]);
        const g = Number(parts[1]);
        const b = Number(parts[2]);
        if (inByte(r) && inByte(g) && inByte(b)) return { r, g, b };
      }
      return null;
    }

    // hex
    let hex = s.replace(/^#/, '').trim();
    if (hex.length === 3) {
      const a = hex[0]!;
      const c = hex[1]!;
      const d = hex[2]!;
      hex = `${a}${a}${c}${c}${d}${d}`;
    }
    if (hex.length === 6 && /^[0-9a-fA-F]{6}$/.test(hex)) {
      return {
        r: parseInt(hex.substring(0, 2), 16),
        g: parseInt(hex.substring(2, 4), 16),
        b: parseInt(hex.substring(4, 6), 16),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function lin(channel: number): number {
  const cs = channel / 255.0;
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

function relativeLuminance(c: Rgb): number {
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

const PASS_COLOR = '#2E7D32';
const FAIL_COLOR = '#C62828';

interface PairResult {
  a: Rgb;
  b: Rgb;
  pairText: string;
  ratio: number;
  ratioText: string;
}

export function ContrastGridModule() {
  const { t } = useTranslation();
  const [colors, setColors] = useState<Rgb[]>([
    { r: 0xff, g: 0xff, b: 0xff },
    { r: 0x76, g: 0x76, b: 0x76 },
    { r: 0x1a, g: 0x73, b: 0xe8 },
  ]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('');

  const pairs = useMemo<PairResult[]>(() => {
    const out: PairResult[] = [];
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        const a = colors[i]!;
        const b = colors[j]!;
        const ratio = contrastRatio(a, b);
        out.push({
          a,
          b,
          pairText: `${toHex(a)} · ${toHex(b)}`,
          ratio,
          ratioText: `${ratio.toFixed(2)}:1`,
        });
      }
    }
    return out;
  }, [colors]);

  function emptyStatus(next: Rgb[]) {
    if (next.length < 2) {
      setStatus(t('contrastgrid.needTwo'));
    } else {
      setStatus(
        t('contrastgrid.summary', { n: next.length, pairs: (next.length * (next.length - 1)) / 2 }),
      );
    }
  }

  function tryAdd(text: string): Rgb[] | null {
    const c = parseColor(text);
    if (!c) return null;
    const hex = toHex(c);
    for (const existing of colors) {
      if (toHex(existing).toLowerCase() === hex.toLowerCase()) {
        return colors; // already present; treat as success, no dup
      }
    }
    return [...colors, c];
  }

  function onAdd() {
    const next = tryAdd(input);
    if (next) {
      setColors(next);
      setInput('');
      if (next.length >= 2) {
        setStatus(
          t('contrastgrid.summary', { n: next.length, pairs: (next.length * (next.length - 1)) / 2 }),
        );
      } else {
        setStatus(t('contrastgrid.added'));
      }
    } else {
      setStatus(t('contrastgrid.cantRead', { text: input }));
    }
  }

  function onRemove(index: number) {
    const next = colors.filter((_, i) => i !== index);
    setColors(next);
    emptyStatus(next);
  }

  function badge(pass: boolean, label: string): string {
    return `${label} ${pass ? t('contrastgrid.pass') : t('contrastgrid.fail')}`;
  }

  function onCopy() {
    try {
      const lines: string[] = [];
      lines.push(t('contrastgrid.reportTitle'));
      lines.push('');
      for (const p of pairs) {
        const large = t('contrastgrid.large');
        lines.push(`${p.pairText}  ${p.ratioText}`);
        lines.push(
          `    AA ${t('contrastgrid.normal')}: ${badge(p.ratio >= AA_NORMAL, 'AA')} | ` +
            `AAA ${t('contrastgrid.normal')}: ${badge(p.ratio >= AAA_NORMAL, 'AAA')} | ` +
            `AA ${large}: ${badge(p.ratio >= AA_LARGE, `AA ${large}`)} | ` +
            `AAA ${large}: ${badge(p.ratio >= AAA_LARGE, `AAA ${large}`)}`,
        );
      }
      if (pairs.length === 0) lines.push(t('contrastgrid.noPairs'));
      const text = lines.join('\n');
      navigator.clipboard?.writeText(text);
      setStatus(t('contrastgrid.reportCopied'));
    } catch {
      setStatus(t('contrastgrid.cantCopy'));
    }
  }

  const large = t('contrastgrid.large');

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('contrastgrid.blurb')}
      </p>

      <div className="mod-toolbar">
        <input
          className="mod-search"
          style={{ minWidth: 220 }}
          placeholder={t('contrastgrid.placeholder')}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onAdd();
          }}
        />
        <button className="mini primary" onClick={onAdd}>
          {t('contrastgrid.add')}
        </button>
        <button className="mini" onClick={onCopy}>
          {t('contrastgrid.copyReport')}
        </button>
        {status && <span className="count-note">{status}</span>}
      </div>

      <h3 className="group-title" style={{ fontSize: 13, margin: '12px 0 6px' }}>
        {t('contrastgrid.colours')}
      </h3>
      <div className="kv-list">
        {colors.map((c, i) => (
          <div className="kv-row" key={`${toHex(c)}-${i}`} style={{ alignItems: 'center', gap: 10 }}>
            <span
              style={{
                display: 'inline-block',
                width: 34,
                height: 22,
                borderRadius: 4,
                background: toHex(c),
                border: '1px solid var(--card-stroke, #8884)',
                flex: '0 0 auto',
              }}
            />
            <code style={{ flex: 1 }}>{toHex(c)}</code>
            <button
              className="mini"
              title={t('contrastgrid.remove')}
              onClick={() => onRemove(i)}
              aria-label={t('contrastgrid.remove')}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <h3 className="group-title" style={{ fontSize: 13, margin: '16px 0 6px' }}>
        {t('contrastgrid.pairs')}
      </h3>
      {pairs.length === 0 && <p className="count-note">{t('contrastgrid.noPairs')}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {pairs.map((p, i) => {
          const chips: { text: string; pass: boolean }[] = [
            { text: badge(p.ratio >= AA_NORMAL, 'AA'), pass: p.ratio >= AA_NORMAL },
            { text: badge(p.ratio >= AAA_NORMAL, 'AAA'), pass: p.ratio >= AAA_NORMAL },
            { text: badge(p.ratio >= AA_LARGE, `AA ${large}`), pass: p.ratio >= AA_LARGE },
            { text: badge(p.ratio >= AAA_LARGE, `AAA ${large}`), pass: p.ratio >= AAA_LARGE },
          ];
          return (
            <div
              key={`${p.pairText}-${i}`}
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr auto',
                gridTemplateRows: 'auto auto',
                columnGap: 12,
                rowGap: 6,
                padding: '10px 12px',
                border: '1px solid var(--card-stroke, #8884)',
                borderRadius: 8,
                alignItems: 'center',
              }}
            >
              <div
                style={{
                  gridRow: '1 / span 2',
                  width: 88,
                  height: 52,
                  borderRadius: 6,
                  background: toHex(p.a),
                  border: '1px solid var(--card-stroke, #8884)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <span style={{ color: toHex(p.b), fontSize: 20, fontWeight: 600 }}>Aa</span>
              </div>
              <code style={{ gridColumn: 2, gridRow: 1 }}>{p.pairText}</code>
              <span style={{ gridColumn: 3, gridRow: 1, fontWeight: 600, fontSize: 16 }}>
                {p.ratioText}
              </span>
              <div
                style={{
                  gridColumn: '2 / span 2',
                  gridRow: 2,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                }}
              >
                {chips.map((chip, ci) => (
                  <span
                    key={ci}
                    style={{
                      background: chip.pass ? PASS_COLOR : FAIL_COLOR,
                      color: '#fff',
                      borderRadius: 4,
                      padding: '3px 8px',
                      fontSize: 11,
                    }}
                  >
                    {chip.text}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
