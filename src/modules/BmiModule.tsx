import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// ---- pure math (ported from WinForge Services/BmiService.cs) ----------------

const CM_PER_INCH = 2.54;
const KG_PER_LB = 0.45359237;

type Sex = 'male' | 'female';

interface Activity {
  factor: number;
  en: string;
  zh: string;
}

// key used for t('bmi.act<N>'); en/zh kept for reference/labels
const ACTIVITY_LEVELS: Activity[] = [
  { factor: 1.2, en: 'Sedentary (little/no exercise)', zh: '久坐（好少或者冇運動）' },
  { factor: 1.375, en: 'Light (1–3 days/week)', zh: '輕度（每週 1–3 日）' },
  { factor: 1.55, en: 'Moderate (3–5 days/week)', zh: '中度（每週 3–5 日）' },
  { factor: 1.725, en: 'Active (6–7 days/week)', zh: '活躍（每週 6–7 日）' },
  { factor: 1.9, en: 'Very active (physical job)', zh: '非常活躍（體力勞動）' },
];

const ok = (v: number): boolean => Number.isFinite(v) && v > 0;

const lengthToCm = (value: number, metric: boolean): number => (metric ? value : value * CM_PER_INCH);
const massToKg = (value: number, metric: boolean): number => (metric ? value : value * KG_PER_LB);

function bmiValue(heightCm: number, weightKg: number): number | null {
  if (!ok(heightCm) || !ok(weightKg)) return null;
  const m = heightCm / 100.0;
  const b = weightKg / (m * m);
  return ok(b) ? b : null;
}

// WHO category — returns the t() key suffix
function bmiCategoryKey(bmi: number): string {
  if (bmi < 18.5) return 'catUnder';
  if (bmi < 25.0) return 'catNormal';
  if (bmi < 30.0) return 'catOver';
  if (bmi < 35.0) return 'catObese1';
  if (bmi < 40.0) return 'catObese2';
  return 'catObese3';
}

function bmrValue(sex: Sex, age: number, heightCm: number, weightKg: number): number | null {
  if (age <= 0 || age > 130 || !ok(heightCm) || !ok(weightKg)) return null;
  const b = 10.0 * weightKg + 6.25 * heightCm - 5.0 * age + (sex === 'male' ? 5.0 : -161.0);
  return ok(b) ? b : null;
}

function tdeeValue(bmr: number | null, factor: number): number | null {
  if (bmr === null || !ok(bmr) || !ok(factor)) return null;
  const t = bmr * factor;
  return ok(t) ? t : null;
}

// US-Navy body-fat % (base-10 log circumference formulae, all lengths in cm)
function bodyFatNavy(sex: Sex, heightCm: number, neckCm: number, waistCm: number, hipsCm: number): number | null {
  if (!ok(heightCm) || !ok(neckCm) || !ok(waistCm)) return null;
  let bf: number;
  if (sex === 'male') {
    const denom = waistCm - neckCm;
    if (denom <= 0) return null;
    bf = 495.0 / (1.0324 - 0.19077 * Math.log10(denom) + 0.15456 * Math.log10(heightCm)) - 450.0;
  } else {
    if (!ok(hipsCm)) return null;
    const denom = waistCm + hipsCm - neckCm;
    if (denom <= 0) return null;
    bf = 495.0 / (1.29579 - 0.35004 * Math.log10(denom) + 0.221 * Math.log10(heightCm)) - 450.0;
  }
  if (!Number.isFinite(bf)) return null;
  if (bf < 2.0) bf = 2.0;
  if (bf > 70.0) bf = 70.0;
  return bf;
}

const round = (v: number, dp: number): string => v.toFixed(dp);

// numeric field: keeps raw string so the box can be blanked, coerces to number for math
function num(raw: string): number {
  const v = parseFloat(raw);
  return Number.isNaN(v) ? 0 : v;
}

// ---- component --------------------------------------------------------------

export function BmiModule() {
  const { t } = useTranslation();

  // false = metric (cm/kg), true = imperial (in/lb) — mirrors WinForge UnitSwitch.IsOn
  const [imperial, setImperial] = useState(false);
  const metric = !imperial;

  // BMI card
  const [bmiHeight, setBmiHeight] = useState('170');
  const [bmiWeight, setBmiWeight] = useState('65');

  // BMR card
  const [bmrSex, setBmrSex] = useState<Sex>('male');
  const [bmrAge, setBmrAge] = useState('30');
  const [bmrHeight, setBmrHeight] = useState('170');
  const [bmrWeight, setBmrWeight] = useState('65');
  const [activityIdx, setActivityIdx] = useState(0);

  // Body-fat card
  const [bfSex, setBfSex] = useState<Sex>('male');
  const [bfHeight, setBfHeight] = useState('170');
  const [bfNeck, setBfNeck] = useState('38');
  const [bfWaist, setBfWaist] = useState('85');
  const [bfHips, setBfHips] = useState('95');

  const lenUnit = metric ? t('bmi.unitCm') : t('bmi.unitIn');
  const massUnit = metric ? t('bmi.unitKg') : t('bmi.unitLb');
  const heightLabel = `${t('bmi.height')}${lenUnit}`;
  const weightLabel = `${t('bmi.weight')}${massUnit}`;

  const unitsHint = metric ? t('bmi.metricHint') : t('bmi.imperialHint');

  // ---- BMI result ----
  const bmiResult = useMemo(() => {
    const h = lengthToCm(num(bmiHeight), metric);
    const w = massToKg(num(bmiWeight), metric);
    const b = bmiValue(h, w);
    if (b === null) return t('bmi.bmiInvalid');
    return t('bmi.bmiResult', { bmi: round(b, 1), cat: t(`bmi.${bmiCategoryKey(b)}`) });
  }, [bmiHeight, bmiWeight, metric, t]);

  // ---- BMR + TDEE result ----
  const bmrResult = useMemo(() => {
    const age = Math.round(num(bmrAge));
    const h = lengthToCm(num(bmrHeight), metric);
    const w = massToKg(num(bmrWeight), metric);
    const b = bmrValue(bmrSex, age, h, w);
    if (b === null) return t('bmi.bmrInvalid');
    const level = ACTIVITY_LEVELS[activityIdx] ?? ACTIVITY_LEVELS[0]!;
    const tdee = tdeeValue(b, level.factor);
    const tdeeText = tdee !== null ? t('bmi.tdeeSuffix', { kcal: round(tdee, 0) }) : '';
    return t('bmi.bmrResult', { kcal: round(b, 0), tdee: tdeeText });
  }, [bmrSex, bmrAge, bmrHeight, bmrWeight, activityIdx, metric, t]);

  // ---- Body fat result ----
  const bfIsFemale = bfSex === 'female';
  const bfResult = useMemo(() => {
    const h = lengthToCm(num(bfHeight), metric);
    const neck = lengthToCm(num(bfNeck), metric);
    const waist = lengthToCm(num(bfWaist), metric);
    const hips = lengthToCm(num(bfHips), metric);
    const bf = bodyFatNavy(bfSex, h, neck, waist, hips);
    if (bf === null) return bfIsFemale ? t('bmi.bfInvalidFemale') : t('bmi.bfInvalidMale');
    return t('bmi.bfResult', { pct: round(bf, 1) });
  }, [bfSex, bfHeight, bfNeck, bfWaist, bfHips, bfIsFemale, metric, t]);

  const cardStyle: React.CSSProperties = {
    border: '1px solid var(--border, #333)',
    borderRadius: 8,
    padding: '14px 16px',
    marginTop: 12,
  };
  const labelStyle: React.CSSProperties = { fontSize: 12, opacity: 0.75, display: 'block', marginBottom: 4 };
  const fieldStyle: React.CSSProperties = { minWidth: 130 };
  const rowStyle: React.CSSProperties = { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 };
  const resultStyle: React.CSSProperties = { fontSize: 14, marginTop: 6 };
  const cardTitle: React.CSSProperties = { fontWeight: 600, fontSize: 15, margin: '0 0 12px' };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('bmi.blurb')}
      </p>

      {/* Units toggle */}
      <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{t('bmi.units')}</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>{unitsHint}</div>
        </div>
        <label className="chk" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={imperial} onChange={(e) => setImperial(e.target.checked)} />
          {t('bmi.imperialToggle')}
        </label>
      </div>

      {/* BMI */}
      <div style={cardStyle}>
        <h3 style={cardTitle}>{t('bmi.bmiTitle')}</h3>
        <div style={rowStyle}>
          <label style={fieldStyle}>
            <span style={labelStyle}>{heightLabel}</span>
            <input className="mod-search" type="number" min={1} value={bmiHeight} onChange={(e) => setBmiHeight(e.target.value)} />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>{weightLabel}</span>
            <input className="mod-search" type="number" min={1} value={bmiWeight} onChange={(e) => setBmiWeight(e.target.value)} />
          </label>
        </div>
        <div style={resultStyle}>{bmiResult}</div>
      </div>

      {/* BMR + calories */}
      <div style={cardStyle}>
        <h3 style={cardTitle}>{t('bmi.bmrTitle')}</h3>
        <div style={rowStyle}>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('bmi.sex')}</span>
            <select className="mod-select" value={bmrSex} onChange={(e) => setBmrSex(e.target.value as Sex)}>
              <option value="male">{t('bmi.male')}</option>
              <option value="female">{t('bmi.female')}</option>
            </select>
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('bmi.age')}</span>
            <input className="mod-search" type="number" min={1} max={130} value={bmrAge} onChange={(e) => setBmrAge(e.target.value)} />
          </label>
        </div>
        <div style={rowStyle}>
          <label style={fieldStyle}>
            <span style={labelStyle}>{heightLabel}</span>
            <input className="mod-search" type="number" min={1} value={bmrHeight} onChange={(e) => setBmrHeight(e.target.value)} />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>{weightLabel}</span>
            <input className="mod-search" type="number" min={1} value={bmrWeight} onChange={(e) => setBmrWeight(e.target.value)} />
          </label>
        </div>
        <div style={{ ...rowStyle, marginBottom: 10 }}>
          <label style={{ minWidth: 300, flex: 1 }}>
            <span style={labelStyle}>{t('bmi.activity')}</span>
            <select className="mod-select" style={{ width: '100%', maxWidth: 360 }} value={activityIdx} onChange={(e) => setActivityIdx(Number(e.target.value))}>
              {ACTIVITY_LEVELS.map((lvl, i) => (
                <option key={lvl.en} value={i}>
                  {t(`bmi.act${i}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div style={resultStyle}>{bmrResult}</div>
      </div>

      {/* Body fat (US Navy) */}
      <div style={cardStyle}>
        <h3 style={cardTitle}>{t('bmi.bfTitle')}</h3>
        <div style={rowStyle}>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('bmi.sex')}</span>
            <select className="mod-select" value={bfSex} onChange={(e) => setBfSex(e.target.value as Sex)}>
              <option value="male">{t('bmi.male')}</option>
              <option value="female">{t('bmi.female')}</option>
            </select>
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>{heightLabel}</span>
            <input className="mod-search" type="number" min={1} value={bfHeight} onChange={(e) => setBfHeight(e.target.value)} />
          </label>
        </div>
        <div style={rowStyle}>
          <label style={fieldStyle}>
            <span style={labelStyle}>{`${t('bmi.neck')}${lenUnit}`}</span>
            <input className="mod-search" type="number" min={1} value={bfNeck} onChange={(e) => setBfNeck(e.target.value)} />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>{`${t('bmi.waist')}${lenUnit}`}</span>
            <input className="mod-search" type="number" min={1} value={bfWaist} onChange={(e) => setBfWaist(e.target.value)} />
          </label>
          {bfIsFemale && (
            <label style={fieldStyle}>
              <span style={labelStyle}>{`${t('bmi.hips')}${lenUnit}`}</span>
              <input className="mod-search" type="number" min={1} value={bfHips} onChange={(e) => setBfHips(e.target.value)} />
            </label>
          )}
        </div>
        <div style={resultStyle}>{bfResult}</div>
      </div>

      <p className="count-note" style={{ fontStyle: 'italic', marginTop: 12 }}>
        {t('bmi.disclaimer')}
      </p>
    </div>
  );
}
