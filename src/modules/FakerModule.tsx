import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// ---- unbiased randomness (mirrors RandomNumberGenerator.GetInt32) -----------------
function rand(maxExclusive: number): number;
function rand(minInclusive: number, maxExclusive: number): number;
function rand(a: number, b?: number): number {
  const min = b === undefined ? 0 : a;
  const max = b === undefined ? a : b;
  if (max <= min + 1) return min;
  const range = max - min;
  // Rejection sampling for an unbiased result across [min, max).
  const limit = Math.floor(0x100000000 / range) * range;
  const buf = new Uint32Array(1);
  let x: number;
  do {
    crypto.getRandomValues(buf);
    x = buf[0]!;
  } while (x >= limit);
  return min + (x % range);
}

function pick<T>(arr: readonly T[]): T {
  return arr[rand(arr.length)]!;
}

function clampCount(v: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(v)));
}

// ---- word banks (verbatim from FakerService.cs) ----------------------------------
const LOREM = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'do',
  'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore', 'magna', 'aliqua', 'enim',
  'ad', 'minim', 'veniam', 'quis', 'nostrud', 'exercitation', 'ullamco', 'laboris', 'nisi',
  'aliquip', 'ex', 'ea', 'commodo', 'consequat', 'duis', 'aute', 'irure', 'in', 'reprehenderit',
  'voluptate', 'velit', 'esse', 'cillum', 'eu', 'fugiat', 'nulla', 'pariatur', 'excepteur', 'sint',
  'occaecat', 'cupidatat', 'non', 'proident', 'sunt', 'culpa', 'qui', 'officia', 'deserunt',
  'mollit', 'anim', 'id', 'est', 'laborum', 'at', 'vero', 'eos', 'accusamus', 'iusto', 'odio',
  'dignissimos', 'ducimus', 'blanditiis', 'praesentium', 'voluptatum', 'deleniti', 'atque',
  'corrupti', 'quos', 'dolores', 'quas', 'molestias', 'excepturi', 'similique', 'mollitia',
] as const;

const FIRST_NAMES = [
  'James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda', 'William',
  'Elizabeth', 'David', 'Barbara', 'Richard', 'Susan', 'Joseph', 'Jessica', 'Thomas', 'Sarah',
  'Charles', 'Karen', 'Christopher', 'Nancy', 'Daniel', 'Lisa', 'Matthew', 'Betty', 'Anthony',
  'Sandra', 'Mark', 'Ashley', 'Donald', 'Emily', 'Steven', 'Kimberly', 'Paul', 'Donna',
] as const;

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez',
  'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore',
  'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark',
  'Ramirez', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott',
] as const;

const CITIES = [
  'New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia', 'San Antonio',
  'San Diego', 'Dallas', 'San Jose', 'Austin', 'Seattle', 'Denver', 'Boston', 'Portland',
  'London', 'Toronto', 'Sydney', 'Singapore', 'Dublin', 'Auckland', 'Vancouver', 'Hong Kong',
] as const;

const COMPANIES = [
  'Acme', 'Globex', 'Initech', 'Umbrella', 'Soylent', 'Hooli', 'Vandelay', 'Wayne', 'Stark',
  'Wonka', 'Cyberdyne', 'Tyrell', 'Aperture', 'Massive', 'Pied Piper', 'Nakatomi', 'Gekko',
] as const;

const COMPANY_SUFFIX = [
  'Inc', 'LLC', 'Corp', 'Group', 'Holdings', 'Systems', 'Labs', 'Industries', 'Partners', 'Co',
] as const;

const STREET_NAMES = [
  'Main', 'Oak', 'Pine', 'Maple', 'Cedar', 'Elm', 'Washington', 'Lake', 'Hill', 'Park',
  'Sunset', 'Church', 'River', 'Spring', 'Highland', 'Franklin', 'Union', 'Broadway', 'Market',
] as const;

const STREET_TYPES = ['St', 'Ave', 'Blvd', 'Rd', 'Ln', 'Dr', 'Way', 'Ct', 'Pl'] as const;

const EMAIL_HOSTS = ['example.com', 'mail.com', 'test.org', 'demo.net', 'inbox.io'] as const;

// ---- lorem ipsum -----------------------------------------------------------------
type LoremMode = 'paragraphs' | 'sentences' | 'words';

function word(): string {
  return pick(LOREM);
}

function sentence(): string {
  const words = rand(6, 15);
  const parts: string[] = [];
  for (let i = 0; i < words; i++) {
    let w = word();
    if (i === 0) w = w.charAt(0).toUpperCase() + w.slice(1);
    parts.push(w);
  }
  return parts.join(' ') + '.';
}

function wordsText(count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) parts.push(word());
  return parts.join(' ');
}

function sentencesText(count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) parts.push(sentence());
  return parts.join(' ');
}

function paragraphsText(count: number): string {
  const paras: string[] = [];
  for (let p = 0; p < count; p++) {
    const sentences = rand(3, 7);
    const parts: string[] = [];
    for (let i = 0; i < sentences; i++) parts.push(sentence());
    paras.push(parts.join(' '));
  }
  return paras.join('\n\n');
}

function lorem(mode: LoremMode, count: number): string {
  const n = Math.max(1, Math.min(500, count));
  if (mode === 'words') return wordsText(n);
  if (mode === 'sentences') return sentencesText(n);
  return paragraphsText(n);
}

// ---- fake data -------------------------------------------------------------------
type Field =
  | 'fullName' | 'email' | 'username' | 'phone' | 'street' | 'city'
  | 'company' | 'uuid' | 'date' | 'integer' | 'boolean' | 'ipv4' | 'hexColor';

const pad = (n: number, len: number) => n.toString().padStart(len, '0');
const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

function uuidv4(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

function one(field: Field): string {
  switch (field) {
    case 'fullName':
      return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    case 'email': {
      const f = pick(FIRST_NAMES).toLowerCase();
      const l = pick(LAST_NAMES).toLowerCase();
      return `${f}.${l}${rand(1, 99)}@${pick(EMAIL_HOSTS)}`;
    }
    case 'username': {
      const f = pick(FIRST_NAMES).toLowerCase();
      const l = pick(LAST_NAMES).toLowerCase();
      return `${f}_${l}${rand(10, 9999)}`;
    }
    case 'phone':
      return `(${pad(rand(200, 1000), 3)}) ${pad(rand(200, 1000), 3)}-${pad(rand(0, 10000), 4)}`;
    case 'street':
      return `${rand(1, 9999)} ${pick(STREET_NAMES)} ${pick(STREET_TYPES)}`;
    case 'city':
      return pick(CITIES);
    case 'company':
      return `${pick(COMPANIES)} ${pick(COMPANY_SUFFIX)}`;
    case 'uuid':
      return uuidv4();
    case 'date': {
      const start = Date.UTC(1970, 0, 1);
      const days = rand(0, 20454); // ~ up to 2026
      const d = new Date(start + days * 86400000);
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
    }
    case 'integer':
      return String(rand(0, 1000000));
    case 'boolean':
      return rand(0, 2) === 0 ? 'false' : 'true';
    case 'ipv4':
      return `${rand(1, 256)}.${rand(0, 256)}.${rand(0, 256)}.${rand(1, 255)}`;
    case 'hexColor':
      return `#${hex2(rand(0, 256))}${hex2(rand(0, 256))}${hex2(rand(0, 256))}`;
    default:
      return '';
  }
}

function generate(field: Field, count: number): string {
  const n = Math.max(1, Math.min(500, count));
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(one(field));
  return lines.join('\n');
}

const LOREM_MODES: { id: LoremMode; key: string }[] = [
  { id: 'paragraphs', key: 'faker.modeParagraphs' },
  { id: 'sentences', key: 'faker.modeSentences' },
  { id: 'words', key: 'faker.modeWords' },
];

const FIELDS: { id: Field; key: string }[] = [
  { id: 'fullName', key: 'faker.fieldFullName' },
  { id: 'email', key: 'faker.fieldEmail' },
  { id: 'username', key: 'faker.fieldUsername' },
  { id: 'phone', key: 'faker.fieldPhone' },
  { id: 'street', key: 'faker.fieldStreet' },
  { id: 'city', key: 'faker.fieldCity' },
  { id: 'company', key: 'faker.fieldCompany' },
  { id: 'uuid', key: 'faker.fieldUuid' },
  { id: 'date', key: 'faker.fieldDate' },
  { id: 'integer', key: 'faker.fieldInteger' },
  { id: 'boolean', key: 'faker.fieldBoolean' },
  { id: 'ipv4', key: 'faker.fieldIpv4' },
  { id: 'hexColor', key: 'faker.fieldHexColor' },
];

export function FakerModule() {
  const { t } = useTranslation();

  const [loremMode, setLoremMode] = useState<LoremMode>('paragraphs');
  const [loremCount, setLoremCount] = useState(3);
  const [loremOut, setLoremOut] = useState('');

  const [field, setField] = useState<Field>('fullName');
  const [dataCount, setDataCount] = useState(10);
  const [dataOut, setDataOut] = useState('');

  const [status, setStatus] = useState('');

  const genLorem = () => {
    try {
      setLoremOut(lorem(loremMode, clampCount(loremCount, 3)));
    } catch (e) {
      setStatus(t('faker.genFail') + String(e instanceof Error ? e.message : e));
    }
  };

  const genData = () => {
    try {
      setDataOut(generate(field, clampCount(dataCount, 10)));
    } catch (e) {
      setStatus(t('faker.genFail') + String(e instanceof Error ? e.message : e));
    }
  };

  const copy = (text: string) => {
    if (!text) {
      setStatus(t('faker.nothingToCopy'));
      return;
    }
    void navigator.clipboard?.writeText(text);
    setStatus(t('faker.copied'));
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('faker.blurb')}</p>
      <p className="count-note" style={{ marginTop: 0 }}>{t('faker.rngNote')}</p>
      {status && <p className="count-note" style={{ marginTop: 0 }}>{status}</p>}

      {/* Lorem ipsum */}
      <div className="kv-list" style={{ display: 'block' }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: '4px 0 10px' }}>{t('faker.loremTitle')}</h3>
        <div className="mod-toolbar">
          <span className="count-note">{t('faker.mode')}</span>
          <select className="mod-select" value={loremMode} onChange={(e) => setLoremMode(e.target.value as LoremMode)}>
            {LOREM_MODES.map((m) => (
              <option key={m.id} value={m.id}>{t(m.key)}</option>
            ))}
          </select>
          <span className="count-note">{t('faker.count')}</span>
          <input
            className="mod-search"
            type="number"
            min={1}
            max={500}
            style={{ maxWidth: 100 }}
            value={loremCount}
            onChange={(e) => setLoremCount(clampCount(+e.target.value, 3))}
          />
          <button className="mini primary" onClick={genLorem}>{t('faker.generate')}</button>
          <button className="mini" disabled={!loremOut} onClick={() => copy(loremOut)}>{t('faker.copy')}</button>
        </div>
        <textarea className="hosts-edit" spellCheck={false} readOnly value={loremOut} placeholder={t('faker.loremPlaceholder')} style={{ minHeight: 160, marginTop: 10 }} />
      </div>

      {/* Fake data */}
      <div className="kv-list" style={{ display: 'block', marginTop: 14 }}>
        <h3 className="group-title" style={{ fontSize: 15, margin: '4px 0 10px' }}>{t('faker.dataTitle')}</h3>
        <div className="mod-toolbar">
          <span className="count-note">{t('faker.field')}</span>
          <select className="mod-select" value={field} onChange={(e) => setField(e.target.value as Field)}>
            {FIELDS.map((f) => (
              <option key={f.id} value={f.id}>{t(f.key)}</option>
            ))}
          </select>
          <span className="count-note">{t('faker.count')}</span>
          <input
            className="mod-search"
            type="number"
            min={1}
            max={500}
            style={{ maxWidth: 100 }}
            value={dataCount}
            onChange={(e) => setDataCount(clampCount(+e.target.value, 10))}
          />
          <button className="mini primary" onClick={genData}>{t('faker.generate')}</button>
          <button className="mini" disabled={!dataOut} onClick={() => copy(dataOut)}>{t('faker.copy')}</button>
        </div>
        <textarea
          className="hosts-edit"
          spellCheck={false}
          readOnly
          value={dataOut}
          placeholder={t('faker.dataPlaceholder')}
          style={{ minHeight: 160, marginTop: 10, fontFamily: 'ui-monospace, Consolas, monospace', whiteSpace: 'pre' }}
        />
      </div>
    </div>
  );
}
