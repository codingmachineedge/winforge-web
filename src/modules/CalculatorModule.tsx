import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

// ---- Evaluator (ported from WinForge CalculatorService.cs) ----------------
// Recursive-descent evaluator over + - * / % ^ (right-assoc power), unary
// minus, parentheses, math functions and the constants pi/e. Never throws to
// the caller — every failure returns { ok:false, error } with a tag the UI
// localizes. Trig honours the angle mode.

type AngleMode = 'radians' | 'degrees';

type EvalResult = { ok: true; value: number } | { ok: false; error: string };

type TokType = 'number' | 'ident' | 'op' | 'lparen' | 'rparen' | 'end';
interface Token {
  type: TokType;
  text: string;
  num: number;
}

class EvalError extends Error {
  tag: string;
  constructor(tag: string) {
    super(tag);
    this.tag = tag;
  }
}

function tokenize(s: string): Token[] {
  const list: Token[] = [];
  let i = 0;
  const n = s.length;
  const isDigit = (c: string) => c >= '0' && c <= '9';
  const isLetter = (c: string) => /[A-Za-z]/.test(c);
  const isLetterOrDigit = (c: string) => /[A-Za-z0-9]/.test(c);
  while (i < n) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }

    if (isDigit(c) || c === '.') {
      const start = i;
      let seenDot = false;
      let seenExp = false;
      while (i < n) {
        const d = s[i]!;
        if (isDigit(d)) {
          i++;
        } else if (d === '.' && !seenDot && !seenExp) {
          seenDot = true;
          i++;
        } else if ((d === 'e' || d === 'E') && !seenExp && i > start) {
          seenExp = true;
          i++;
          if (i < n && (s[i] === '+' || s[i] === '-')) i++;
        } else {
          break;
        }
      }
      const numStr = s.substring(start, i);
      const val = Number(numStr);
      if (!Number.isFinite(val) && numStr !== 'Infinity') {
        if (Number.isNaN(val)) throw new EvalError('malformed');
      }
      if (Number.isNaN(val)) throw new EvalError('malformed');
      list.push({ type: 'number', text: numStr, num: val });
      continue;
    }

    if (isLetter(c) || c === '_') {
      const start = i;
      while (i < n && (isLetterOrDigit(s[i]!) || s[i] === '_')) i++;
      list.push({ type: 'ident', text: s.substring(start, i), num: 0 });
      continue;
    }

    switch (c) {
      case '+':
      case '-':
      case '*':
      case '/':
      case '%':
      case '^':
        list.push({ type: 'op', text: c, num: 0 });
        i++;
        break;
      case '(':
        list.push({ type: 'lparen', text: '(', num: 0 });
        i++;
        break;
      case ')':
        list.push({ type: 'rparen', text: ')', num: 0 });
        i++;
        break;
      default:
        throw new EvalError('badchar');
    }
  }
  list.push({ type: 'end', text: '', num: 0 });
  return list;
}

function cbrt(x: number): number {
  return Math.cbrt(x);
}

class Parser {
  private t: Token[];
  private mode: AngleMode;
  private pos = 0;

  constructor(tokens: Token[], mode: AngleMode) {
    this.t = tokens;
    this.mode = mode;
  }

  private cur(): Token {
    return this.t[this.pos]!;
  }
  private next(): Token {
    return this.t[this.pos++]!;
  }

  expectEnd(): void {
    if (this.cur().type !== 'end') throw new EvalError('trailing');
  }

  parseExpression(): number {
    let left = this.parseTerm();
    while (this.cur().type === 'op' && (this.cur().text === '+' || this.cur().text === '-')) {
      const op = this.next().text;
      const right = this.parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  private parseTerm(): number {
    let left = this.parsePower();
    while (this.cur().type === 'op' && (this.cur().text === '*' || this.cur().text === '/' || this.cur().text === '%')) {
      const op = this.next().text;
      const right = this.parsePower();
      if (op === '*') {
        left *= right;
      } else if (op === '/') {
        if (right === 0) throw new EvalError('divzero');
        left /= right;
      } else {
        if (right === 0) throw new EvalError('divzero');
        left %= right;
      }
    }
    return left;
  }

  private parsePower(): number {
    const baseVal = this.parseUnary();
    if (this.cur().type === 'op' && this.cur().text === '^') {
      this.next();
      const exp = this.parsePower(); // right-associative
      return Math.pow(baseVal, exp);
    }
    return baseVal;
  }

  private parseUnary(): number {
    if (this.cur().type === 'op' && (this.cur().text === '+' || this.cur().text === '-')) {
      const op = this.next().text;
      const v = this.parseUnary();
      return op === '-' ? -v : v;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const tok = this.cur();
    switch (tok.type) {
      case 'number':
        this.next();
        return tok.num;

      case 'lparen': {
        this.next();
        const v = this.parseExpression();
        if (this.cur().type !== 'rparen') throw new EvalError('unbalanced');
        this.next();
        return v;
      }

      case 'ident': {
        this.next();
        const name = tok.text.toLowerCase();

        if (name === 'pi') return Math.PI;
        if (name === 'e') return Math.E;

        if (this.cur().type === 'lparen') {
          this.next();
          const arg = this.parseExpression();
          if (this.cur().type !== 'rparen') throw new EvalError('unbalanced');
          this.next();
          return this.applyFunc(name, arg);
        }

        throw new EvalError('unknown:' + name);
      }

      case 'rparen':
        throw new EvalError('unbalanced');

      case 'end':
        throw new EvalError('incomplete');

      default:
        throw new EvalError('malformed');
    }
  }

  private applyFunc(name: string, x: number): number {
    const toRad = (a: number) => (this.mode === 'degrees' ? (a * Math.PI) / 180.0 : a);
    const fromRad = (a: number) => (this.mode === 'degrees' ? (a * 180.0) / Math.PI : a);

    switch (name) {
      case 'sin':
        return Math.sin(toRad(x));
      case 'cos':
        return Math.cos(toRad(x));
      case 'tan':
        return Math.tan(toRad(x));
      case 'asin':
        if (x < -1 || x > 1) throw new EvalError('domain');
        return fromRad(Math.asin(x));
      case 'acos':
        if (x < -1 || x > 1) throw new EvalError('domain');
        return fromRad(Math.acos(x));
      case 'atan':
        return fromRad(Math.atan(x));
      case 'sqrt':
        if (x < 0) throw new EvalError('domain');
        return Math.sqrt(x);
      case 'cbrt':
        return cbrt(x);
      case 'ln':
        if (x <= 0) throw new EvalError('domain');
        return Math.log(x);
      case 'log':
        if (x <= 0) throw new EvalError('domain');
        return Math.log10(x);
      case 'log2':
        if (x <= 0) throw new EvalError('domain');
        return Math.log2(x);
      case 'abs':
        return Math.abs(x);
      case 'round':
        // MidpointRounding.AwayFromZero
        return Math.sign(x) * Math.round(Math.abs(x));
      case 'floor':
        return Math.floor(x);
      case 'ceil':
        return Math.ceil(x);
      case 'exp':
        return Math.exp(x);
      default:
        throw new EvalError('unknownfn:' + name);
    }
  }
}

function evaluate(expression: string, mode: AngleMode): EvalResult {
  if (!expression || !expression.trim()) return { ok: false, error: 'empty' };
  try {
    const tokens = tokenize(expression);
    const parser = new Parser(tokens, mode);
    const v = parser.parseExpression();
    parser.expectEnd();
    if (Number.isNaN(v)) return { ok: false, error: 'nan' };
    if (!Number.isFinite(v)) return { ok: false, error: 'infinity' };
    return { ok: true, value: v };
  } catch (ex) {
    if (ex instanceof EvalError) return { ok: false, error: ex.tag };
    return { ok: false, error: 'malformed' };
  }
}

// ---- Formatting -----------------------------------------------------------

function formatNumber(v: number): string {
  if (v === Math.floor(v) && Math.abs(v) < 1e15 && Number.isFinite(v)) {
    return String(v);
  }
  // Approximate C# "G15": up to 15 significant digits, trailing zeros trimmed.
  const s = v.toPrecision(15);
  return String(Number(s));
}

// BigInt-based 64-bit two's-complement conversions for the programmer view.
const U64_MASK = (1n << 64n) - 1n;

function toUnsigned64(n: bigint): bigint {
  return n & U64_MASK;
}

// ---- Button pad -----------------------------------------------------------

const PAD_ROWS: string[][] = [
  ['7', '8', '9', '/', '(', ')'],
  ['4', '5', '6', '*', '^', '%'],
  ['1', '2', '3', '-', 'pi', 'e'],
  ['0', '.', '=', '+', 'sqrt(', 'ln('],
  ['sin(', 'cos(', 'tan(', 'log(', 'abs(', '⌫'],
];

const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;

export function CalculatorModule() {
  const { t } = useTranslation();
  const [expr, setExpr] = useState('');
  const [degrees, setDegrees] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const exprRef = useRef<HTMLInputElement>(null);

  const mode: AngleMode = degrees ? 'degrees' : 'radians';

  const errorText = (tag: string): string => {
    if (tag.startsWith('unknown:')) {
      const name = tag.substring('unknown:'.length);
      return t('calculator.errUnknownName', { name });
    }
    if (tag.startsWith('unknownfn:')) {
      const name = tag.substring('unknownfn:'.length);
      return t('calculator.errUnknownFn', { name });
    }
    switch (tag) {
      case 'empty':
        return '';
      case 'divzero':
        return t('calculator.errDivZero');
      case 'domain':
        return t('calculator.errDomain');
      case 'unbalanced':
        return t('calculator.errUnbalanced');
      case 'trailing':
        return t('calculator.errTrailing');
      case 'incomplete':
        return t('calculator.errIncomplete');
      case 'badchar':
        return t('calculator.errBadChar');
      case 'nan':
        return t('calculator.errNan');
      case 'infinity':
        return t('calculator.errInfinity');
      case 'malformed':
      default:
        return t('calculator.errMalformed');
    }
  };

  const result = useMemo(() => evaluate(expr, mode), [expr, mode]);

  // Programmer view: only for finite, integral values that fit signed 64-bit.
  const prog = useMemo(() => {
    if (!result.ok) return null;
    const v = result.value;
    if (Number.isNaN(v) || !Number.isFinite(v) || v !== Math.floor(v)) return null;
    let n: bigint;
    try {
      n = BigInt(v);
    } catch {
      return null;
    }
    if (n < LONG_MIN || n > LONG_MAX) return null;
    const bits = toUnsigned64(n);
    return {
      dec: n.toString(10),
      hex: '0x' + bits.toString(16).toUpperCase(),
      bin: '0b' + bits.toString(2),
      oct: '0o' + bits.toString(8),
    };
  }, [result]);

  const focusExpr = () => {
    const el = exprRef.current;
    if (el) {
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }
  };

  const commitToHistory = () => {
    const e = expr.trim();
    if (!e) return;
    const r = evaluate(e, mode);
    if (!r.ok) return; // status already reflects the live error
    const entry = `${e} = ${formatNumber(r.value)}`;
    setHistory((h) => {
      const next = [entry, ...h];
      if (next.length > 100) next.length = 100;
      return next;
    });
  };

  const onExprKeyDown = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      commitToHistory();
    }
  };

  const onHistoryClick = (s: string) => {
    const idx = s.lastIndexOf(' = ');
    const e = idx > 0 ? s.substring(0, idx) : s;
    setExpr(e);
    setTimeout(focusExpr, 0);
  };

  const onPad = (key: string) => {
    if (key === '⌫') {
      setExpr((t0) => (t0.length > 0 ? t0.substring(0, t0.length - 1) : t0));
      setTimeout(focusExpr, 0);
      return;
    }
    if (key === '=') {
      commitToHistory();
      return;
    }
    setExpr((t0) => t0 + key);
    setTimeout(focusExpr, 0);
  };

  const status = !expr.trim() ? '' : result.ok ? '' : errorText(result.error);
  const resultDisplay = expr.trim() && result.ok ? '= ' + formatNumber(result.value) : '';

  return (
    <div className="mod">
      <p className="count-note" style={{ marginBottom: 12 }}>{t('calculator.blurb')}</p>

      {/* Expression + result */}
      <div
        style={{
          border: '1px solid var(--border, #333)',
          borderRadius: 8,
          padding: '14px 16px',
          marginBottom: 14,
        }}
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <input
            ref={exprRef}
            className="mod-search"
            style={{ flex: 1, fontFamily: 'Consolas, monospace', fontSize: 16 }}
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            onKeyDown={onExprKeyDown}
            placeholder={t('calculator.exprPlaceholder')}
            spellCheck={false}
          />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', whiteSpace: 'nowrap' }}>
            <span className="count-note" style={{ fontSize: 12 }}>
              {degrees ? t('calculator.degrees') : t('calculator.radians')}
            </span>
            <input type="checkbox" checked={degrees} onChange={(e) => setDegrees(e.target.checked)} />
          </label>
        </div>
        <div
          style={{
            fontSize: 30,
            fontWeight: 600,
            marginTop: 12,
            minHeight: 38,
            wordBreak: 'break-all',
            userSelect: 'text',
          }}
        >
          {resultDisplay}
        </div>
        {status && (
          <div style={{ fontSize: 12, marginTop: 4, color: 'var(--danger, #e5484d)' }}>{status}</div>
        )}
      </div>

      {/* Button pad */}
      <div
        style={{
          border: '1px solid var(--border, #333)',
          borderRadius: 8,
          padding: 12,
          marginBottom: 14,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>{t('calculator.buttonPad')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {PAD_ROWS.map((row, ri) => (
            <div key={ri} style={{ display: 'flex', gap: 6 }}>
              {row.map((key) => (
                <button
                  key={key}
                  className={key === '=' ? 'mini primary' : 'mini'}
                  style={{ minWidth: 64, flex: 1 }}
                  onClick={() => onPad(key)}
                >
                  {key}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Programmer view */}
      {prog && (
        <div
          style={{
            border: '1px solid var(--border, #333)',
            borderRadius: 8,
            padding: '14px 16px',
            marginBottom: 14,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>{t('calculator.programmerView')}</div>
          <div className="kv-list">
            <div className="kv-row">
              <span style={{ fontFamily: 'Consolas, monospace', opacity: 0.7 }}>DEC</span>
              <span style={{ fontFamily: 'Consolas, monospace', userSelect: 'text' }}>{prog.dec}</span>
            </div>
            <div className="kv-row">
              <span style={{ fontFamily: 'Consolas, monospace', opacity: 0.7 }}>HEX</span>
              <span style={{ fontFamily: 'Consolas, monospace', userSelect: 'text' }}>{prog.hex}</span>
            </div>
            <div className="kv-row">
              <span style={{ fontFamily: 'Consolas, monospace', opacity: 0.7 }}>BIN</span>
              <span style={{ fontFamily: 'Consolas, monospace', userSelect: 'text', wordBreak: 'break-all' }}>{prog.bin}</span>
            </div>
            <div className="kv-row">
              <span style={{ fontFamily: 'Consolas, monospace', opacity: 0.7 }}>OCT</span>
              <span style={{ fontFamily: 'Consolas, monospace', userSelect: 'text' }}>{prog.oct}</span>
            </div>
          </div>
        </div>
      )}

      {/* History */}
      <div
        style={{
          border: '1px solid var(--border, #333)',
          borderRadius: 8,
          padding: '14px 16px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{t('calculator.history')}</span>
          <button className="mini" disabled={history.length === 0} onClick={() => setHistory([])}>
            {t('calculator.clear')}
          </button>
        </div>
        {history.length === 0 ? (
          <p className="count-note">{t('calculator.historyEmpty')}</p>
        ) : (
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {history.map((h, i) => (
              <div
                key={i}
                className="kv-row"
                style={{ cursor: 'pointer', fontFamily: 'Consolas, monospace' }}
                onClick={() => onHistoryClick(h)}
                title={t('calculator.historyItemTip')}
              >
                {h}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
