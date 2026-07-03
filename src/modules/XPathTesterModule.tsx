import { useMemo } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface XPathMatch {
  name: string;
  value: string;
  outer: string;
}

interface XPathResult {
  ok: boolean;
  errorKey?: string;
  errorDetail?: string;
  scalar?: string; // non-null when the XPath returned a string / number / boolean
  matches: XPathMatch[];
  count: number;
}

const DEFAULT_XML =
  '<catalog>\n  <book id="b1"><title>WinForge</title><price>0</price></book>\n  <book id="b2"><title>Reactor</title><price>42</price></book>\n</catalog>';
const DEFAULT_XPATH = '//book/title';

const MAX = 4000;

function trim(s: string): string {
  if (!s) return '';
  s = s.replace(/\r/g, ' ').replace(/\n/g, ' ').trim();
  return s.length > MAX ? s.slice(0, MAX) + '…' : s;
}

function serialize(node: Node): string {
  try {
    return new XMLSerializer().serializeToString(node);
  } catch {
    return node.textContent ?? '';
  }
}

function describe(node: Node): XPathMatch {
  switch (node.nodeType) {
    case Node.ELEMENT_NODE: {
      const el = node as Element;
      return { name: el.localName, value: trim(el.textContent ?? ''), outer: trim(serialize(el)) };
    }
    case Node.ATTRIBUTE_NODE: {
      const at = node as Attr;
      return { name: '@' + at.localName, value: trim(at.value), outer: trim(`${at.localName}="${at.value}"`) };
    }
    case Node.TEXT_NODE:
    case Node.CDATA_SECTION_NODE: {
      const v = trim(node.nodeValue ?? '');
      return { name: '#text', value: v, outer: v };
    }
    case Node.COMMENT_NODE: {
      const v = node.nodeValue ?? '';
      return { name: '#comment', value: trim(v), outer: trim(`<!--${v}-->`) };
    }
    case Node.PROCESSING_INSTRUCTION_NODE: {
      const pi = node as ProcessingInstruction;
      return { name: '#pi', value: trim(pi.data), outer: trim(serialize(pi)) };
    }
    case Node.DOCUMENT_NODE: {
      const s = trim(serialize(node));
      return { name: '#document', value: trim(node.textContent ?? ''), outer: s };
    }
    default: {
      const s = trim(node.textContent ?? '');
      return { name: node.nodeName || 'value', value: s, outer: s };
    }
  }
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  // Trim to at most 12 decimal places, drop trailing zeros — mirrors "0.############".
  let s = n.toFixed(12);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

function evaluate(xml: string | undefined, xpath: string | undefined): XPathResult {
  const xmlText = xml ?? '';
  const expr = xpath ?? '';

  if (!xmlText.trim() || !expr.trim()) {
    return { ok: true, matches: [], count: 0 };
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  } catch (e) {
    return { ok: false, errorKey: 'readError', errorDetail: e instanceof Error ? e.message : String(e), matches: [], count: 0 };
  }

  // DOMParser reports XML syntax errors as a <parsererror> element rather than throwing.
  const parserError = doc.getElementsByTagName('parsererror')[0];
  if (parserError) {
    const detail = (parserError.textContent ?? '').replace(/\s+/g, ' ').trim();
    return { ok: false, errorKey: 'parseError', errorDetail: detail, matches: [], count: 0 };
  }

  let evaluated: XPathResult2;
  try {
    evaluated = doc.evaluate(expr, doc, null, 0 /* ANY_TYPE */, null);
  } catch (e) {
    return { ok: false, errorKey: 'xpathError', errorDetail: e instanceof Error ? e.message : String(e), matches: [], count: 0 };
  }

  try {
    switch (evaluated.resultType) {
      case 1 /* NUMBER_TYPE */:
        return { ok: true, scalar: formatNumber(evaluated.numberValue), matches: [], count: 1 };
      case 2 /* STRING_TYPE */:
        return { ok: true, scalar: evaluated.stringValue, matches: [], count: 1 };
      case 3 /* BOOLEAN_TYPE */:
        return { ok: true, scalar: evaluated.booleanValue ? 'true' : 'false', matches: [], count: 1 };
      default: {
        // A node-set (ordered/unordered iterator).
        const matches: XPathMatch[] = [];
        let node = evaluated.iterateNext();
        while (node) {
          matches.push(describe(node));
          node = evaluated.iterateNext();
        }
        return { ok: true, matches, count: matches.length };
      }
    }
  } catch (e) {
    return { ok: false, errorKey: 'matchError', errorDetail: e instanceof Error ? e.message : String(e), matches: [], count: 0 };
  }
}

// Minimal structural type for the XPathResult DOM object (avoids depending on lib.dom name clashes).
interface XPathResult2 {
  resultType: number;
  numberValue: number;
  stringValue: string;
  booleanValue: boolean;
  iterateNext(): Node | null;
}

export function XPathTesterModule() {
  const { t } = useTranslation();
  const [xml, setXml] = useState(DEFAULT_XML);
  const [xpath, setXpath] = useState(DEFAULT_XPATH);
  const [msg, setMsg] = useState('');

  const res = useMemo(() => evaluate(xml, xpath), [xml, xpath]);

  const status = useMemo(() => {
    if (!res.ok) {
      const base = t(`xpathtester.${res.errorKey}`);
      return res.errorDetail ? `${base}: ${res.errorDetail}` : base;
    }
    if (res.scalar !== undefined) return t('xpathtester.scalar', { value: res.scalar });
    return t('xpathtester.count', { count: res.count });
  }, [res, t]);

  const empty = res.ok && res.scalar === undefined && res.count === 0 ? t('xpathtester.noMatch') : '';

  const copyMatches = () => {
    if (res.scalar !== undefined) {
      void navigator.clipboard?.writeText(res.scalar);
      setMsg(t('xpathtester.copied'));
      return;
    }
    if (res.matches.length === 0) return;
    const text = res.matches.map((m) => m.outer).join('\n');
    void navigator.clipboard?.writeText(text);
    setMsg(t('xpathtester.copied'));
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('xpathtester.blurb')}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label style={{ fontWeight: 600 }}>{t('xpathtester.xmlLabel')}</label>
        <textarea
          className="hosts-edit"
          spellCheck={false}
          style={{ minHeight: 180, fontFamily: 'Consolas, monospace' }}
          value={xml}
          onChange={(e) => {
            setXml(e.target.value);
            setMsg('');
          }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 12 }}>
        <label style={{ fontWeight: 600 }}>{t('xpathtester.xpathLabel')}</label>
        <input
          className="mod-search"
          style={{ fontFamily: 'Consolas, monospace', maxWidth: '100%' }}
          spellCheck={false}
          value={xpath}
          onChange={(e) => {
            setXpath(e.target.value);
            setMsg('');
          }}
        />
      </div>

      <p
        className={res.ok ? 'count-note' : ''}
        style={res.ok ? { marginTop: 10 } : { marginTop: 10, color: 'var(--danger)', fontSize: 12.5 }}
      >
        {status}
      </p>

      <div className="mod-toolbar" style={{ marginTop: 6 }}>
        <h3 className="group-title" style={{ fontSize: 14, margin: 0, flex: 1 }}>
          {t('xpathtester.resultsLabel')}
        </h3>
        <button
          className="mini"
          disabled={res.scalar === undefined && res.matches.length === 0}
          onClick={copyMatches}
        >
          {t('xpathtester.copy')}
        </button>
        {msg && <span className="count-note">{msg}</span>}
      </div>

      {res.matches.length > 0 && (
        <div className="kv-list" style={{ marginTop: 6 }}>
          {res.matches.map((m, i) => (
            <div className="kv-row" key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 0' }}>
              <span style={{ fontWeight: 600, fontFamily: 'Consolas, monospace' }}>{m.name}</span>
              {m.value && <span style={{ opacity: 0.85, wordBreak: 'break-word' }}>{m.value}</span>}
              {m.outer && (
                <span className="count-note" style={{ fontFamily: 'Consolas, monospace', wordBreak: 'break-word' }}>
                  {m.outer}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {empty && (
        <p className="count-note" style={{ marginTop: 6 }}>
          {empty}
        </p>
      )}
    </div>
  );
}
