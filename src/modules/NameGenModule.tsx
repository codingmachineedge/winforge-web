import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Faithful port of WinForge NameGenService — cryptographically-random name maker.
// All word lists are embedded static arrays; randomness comes only from Web Crypto.
// Never throws.

type Kind = 'username' | 'project' | 'company' | 'fantasy' | 'band' | 'slug';

const KINDS: Kind[] = ['username', 'project', 'company', 'fantasy', 'band', 'slug'];

const Adjectives = [
  'swift', 'brave', 'silent', 'cosmic', 'golden', 'crimson', 'frozen', 'electric',
  'hidden', 'ancient', 'lucky', 'mighty', 'quantum', 'velvet', 'rusty', 'noble',
  'wild', 'clever', 'solar', 'lunar', 'iron', 'shadow', 'bright', 'gentle',
  'fearless', 'restless', 'wandering', 'hollow', 'radiant', 'stormy', 'amber', 'jade',
];

const Nouns = [
  'falcon', 'otter', 'harbor', 'ember', 'comet', 'willow', 'raven', 'summit',
  'cobalt', 'lantern', 'meadow', 'phoenix', 'glacier', 'cinder', 'maple', 'harbour',
  'voyager', 'beacon', 'thunder', 'river', 'canyon', 'orbit', 'tundra', 'prairie',
  'badger', 'hornet', 'walrus', 'sparrow', 'boulder', 'nimbus', 'quartz', 'onyx',
];

// CVC fantasy syllable parts.
const Onsets = ['b', 'd', 'f', 'g', 'k', 'l', 'm', 'n', 'r', 's', 't', 'v', 'th', 'sh', 'dr', 'gr', 'br', 'vy', ' z'];
const Vowels = ['a', 'e', 'i', 'o', 'u', 'ae', 'ei', 'ia', 'ou', 'yr', 'ael'];
const Codas = ['n', 'r', 'l', 's', 'th', 'm', 'x', 'sk', ' n', ''];

// Company/startup portmanteau fragments.
const BlendHeads = ['no', 'zen', 'lumi', 'cove', 'flux', 'nova', 'veri', 'opti', 'hyper', 'pana', 'aero', 'cala', 'vibra', 'octo', 'sona', 'meta'];
const BlendTails = ['ly', 'ify', 'wave', 'sync', 'hub', 'labs', 'flow', 'grid', 'kit', 'loop', 'forge', 'scape', 'mint', 'verse', 'pilot', 'spark'];

const CodeNames = [
  'Aurora', 'Nimbus', 'Vertex', 'Pinnacle', 'Odyssey', 'Zenith', 'Mirage', 'Catalyst',
  'Horizon', 'Quicksilver', 'Obsidian', 'Tempest', 'Lodestar', 'Falcon', 'Titan', 'Everest',
];

/** Cryptographically-uniform int in [0, n). Falls back to 0 on any error. */
function rand(n: number): number {
  try {
    if (n <= 1) return 0;
    const cryptoObj = typeof crypto !== 'undefined' ? crypto : undefined;
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      // Rejection sampling for a uniform value in [0, n).
      const range = 0x100000000; // 2^32
      const limit = range - (range % n);
      const buf = new Uint32Array(1);
      for (let tries = 0; tries < 64; tries++) {
        cryptoObj.getRandomValues(buf);
        const v = buf[0]!;
        if (v < limit) return v % n;
      }
      return buf[0]! % n;
    }
    return Math.floor(Math.random() * n);
  } catch {
    return 0;
  }
}

function pick(arr: string[]): string {
  if (arr.length === 0) return '';
  const v = arr[rand(arr.length)];
  return (v ?? '').trim();
}

function cap(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function oneUsername(): string {
  let out = cap(pick(Adjectives)) + cap(pick(Nouns));
  if (rand(3) !== 0) out += String(rand(90) + 10); // ~2/3 get a 2-digit suffix
  return out;
}

function oneProject(): string {
  // Codename style: "<CodeName>-<noun>" or "<adjective> <noun>".
  if (rand(2) === 0) return `${pick(CodeNames)}-${cap(pick(Nouns))}`;
  return `${cap(pick(Adjectives))} ${cap(pick(Nouns))}`;
}

function oneCompany(): string {
  // Portmanteau / blend.
  if (rand(2) === 0) return cap(pick(BlendHeads) + pick(BlendTails));
  // Blend a real word with a tail.
  let root = pick(rand(2) === 0 ? Adjectives : Nouns);
  if (root.length > 4) root = root.slice(0, 4);
  return cap(root + pick(BlendTails));
}

function oneFantasy(): string {
  const syl = 2 + rand(2); // 2 or 3 syllables
  let out = '';
  for (let i = 0; i < syl; i++) {
    out += pick(Onsets) + pick(Vowels);
    if (i === syl - 1 || rand(3) === 0) out += pick(Codas);
  }
  return cap(out);
}

function oneBand(): string {
  // "The <Adjective> <Nouns(plural-ish)>"
  let noun = pick(Nouns);
  if (!noun.endsWith('s')) noun += 's';
  return `The ${cap(pick(Adjectives))} ${cap(noun)}`;
}

function oneSlug(): string {
  return `${pick(Adjectives)}-${pick(Nouns)}`;
}

function one(kind: Kind): string {
  switch (kind) {
    case 'username': return oneUsername();
    case 'project': return oneProject();
    case 'company': return oneCompany();
    case 'fantasy': return oneFantasy();
    case 'band': return oneBand();
    case 'slug': return oneSlug();
    default: return oneUsername();
  }
}

/** Generate count names of the given kind. Clamps count to 1..100. Never throws. */
function generate(kind: Kind, count: number): string[] {
  const list: string[] = [];
  try {
    let n = count;
    if (n < 1) n = 1;
    if (n > 100) n = 100;
    for (let i = 0; i < n; i++) {
      let name = one(kind);
      if (!name || !name.trim()) name = 'name' + (i + 1);
      list.push(name);
    }
  } catch {
    if (list.length === 0) list.push('name1');
  }
  return list;
}

export function NameGenModule() {
  const { t } = useTranslation();
  const [kind, setKind] = useState<Kind>('username');
  const [count, setCount] = useState(10);
  const [seed, setSeed] = useState(0); // bump to regenerate
  const [copied, setCopied] = useState(false);

  const clampedCount = Math.max(1, Math.min(100, Math.floor(count) || 1));

  const names = useMemo(() => {
    return generate(kind, clampedCount);
    // seed is intentionally a dependency to force fresh randomness on regenerate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, clampedCount, seed]);

  const output = names.join('\n');

  const kindLabel = (k: Kind): string => t(`namegen.kind_${k}`);

  const copy = () => {
    if (!output) return;
    try {
      navigator.clipboard?.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('namegen.blurb')}</p>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <label className="count-note">{t('namegen.typeLabel')}</label>
        <select className="mod-select" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {KINDS.map((k) => (
            <option key={k} value={k}>{kindLabel(k)}</option>
          ))}
        </select>
        <label className="count-note">{t('namegen.countLabel')}</label>
        <input
          className="mod-search"
          type="number"
          min={1}
          max={100}
          style={{ maxWidth: 80 }}
          value={count}
          onChange={(e) => setCount(Math.max(1, Math.min(100, +e.target.value || 1)))}
        />
        <button className="mini primary" onClick={() => setSeed((s) => s + 1)}>{t('namegen.regenerate')}</button>
        <button className="mini" disabled={!output} onClick={copy}>
          {copied ? t('namegen.copied') : t('namegen.copyAll')}
        </button>
      </div>
      <textarea
        className="hosts-edit"
        spellCheck={false}
        readOnly
        value={output}
        style={{ marginTop: 8, fontFamily: 'monospace', minHeight: 240 }}
        placeholder={t('namegen.outputPlaceholder')}
      />
      <p className="count-note" style={{ marginTop: 8 }}>{t('namegen.status', { count: names.length })}</p>
    </div>
  );
}
