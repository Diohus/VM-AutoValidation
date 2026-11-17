// Feature extraction shared by offline training and runtime inference.
// Uses only data available at the time of evaluation (history strictly before measuredAt,
// context with knownAt <= measuredAt). No identifiers, no diagnosis-as-shortcut.

export const MODEL_TESTS = {
  CHEM: ['GLU', 'URE', 'CRE', 'NA', 'K', 'CL', 'CA', 'MG', 'ALB', 'ALP', 'AST', 'ALT'],
  HEME: ['WBC', 'RBC', 'HGB', 'HCT', 'MCV', 'MCH', 'MCHC', 'RDW', 'PLT', 'NEU', 'LYM']
};

const DAY = 86400000;

/** Strict numeric parse: "4.2" → 4.2, "4.2ERROR" / "" / NaN → null. Shared by rules and model. */
export function parseNumeric(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
export const validTime = s => typeof s === 'string' && Number.isFinite(Date.parse(s));

export function popMean(def, sex) {
  return typeof def.mean === 'object' ? def.mean[sex] ?? def.mean.M : def.mean;
}

// Reference population centre for derived CBC indices (not generated from a population mean).
const DERIVED_CENTRE = { HGB: { M: 150, F: 135 }, HCT: { M: 0.45, F: 0.405 }, MCH: { M: 30, F: 30 }, MCHC: { M: 333, F: 333 } };
const DERIVED_CVG = { HGB: 7, HCT: 7, MCH: 5, MCHC: 2 };

function centre(def, test, sex) {
  if (def.dist === 'derived') return DERIVED_CENTRE[test]?.[sex] ?? DERIVED_CENTRE[test]?.M;
  return popMean(def, sex);
}
function cvg(def, test) { return def.dist === 'derived' ? DERIVED_CVG[test] : def.cvg; }

/** Reporting resolution of an analyte (10^-decimals): the ε used so that a reported 0 stays a finite, real value. */
export function resolution(def) { return 10 ** -(def.decimals ?? 0); }
const isLog = def => def.dist === 'lognormal';

/**
 * Value relative to the population centre, in units of between-subject CV (CV stored in %).
 * lognormal analytes: (log(x+ε) − log(c+ε)) / (CVg/100). Others (incl. % analytes NEU/LYM/RDW): (x − c) / (c·CVg/100).
 * Never undefined for x = 0.
 */
export function zScore(def, test, x, sex) {
  const c = centre(def, test, sex), s = cvg(def, test) / 100;
  if (isLog(def)) { const e = resolution(def); return (Math.log(x + e) - Math.log(c + e)) / s; }
  return (x - c) / (c * s);
}

/**
 * Change vs the previous result in units of the SD of a difference (√2·√(CVi²+CVa²), CV in %).
 * lognormal: log ratio with ε; others: absolute difference scaled by the POPULATION centre (not by the previous
 * value), so a previous result of 0 never divides by zero or explodes.
 */
export function deltaScore(def, test, x, prev, sex) {
  const sd = Math.SQRT2 * Math.sqrt(def.cvi ** 2 + (def.cva ?? 1) ** 2) / 100;
  if (isLog(def)) { const e = resolution(def); return (Math.log(x + e) - Math.log(prev + e)) / sd; }
  return (x - prev) / (centre(def, test, sex) * sd);
}

/**
 * Data coverage of a model's analytes on one report: which were used and why the others are missing.
 * NOT_ORDERED = type B (not an error); NO_RESULT = type A (ordered, no usable value → rule D01 blocks).
 */
export function coverage(report, tests, catalog) {
  const cur = currentValues(report, catalog);
  const ordered = new Set(report.orderedTests ?? []);
  const missing = [];
  let used = 0;
  for (const t of tests) {
    if (cur[t] && cur[t].value >= 0) used++;
    else missing.push({ test: t, reason: ordered.has(t) ? 'NO_RESULT' : 'NOT_ORDERED' });
  }
  return { used, total: tests.length, missing };
}

/** Latest prior numeric result per test inside the window. */
export function previousResults(history, measuredAt, windowDays) {
  const t0 = Date.parse(measuredAt);
  const prev = {};
  for (const h of history) {
    const t = Date.parse(h.measuredAt);
    if (!(t < t0) || t0 - t > windowDays * DAY || typeof h.value !== 'number') continue;
    if (!prev[h.test] || Date.parse(prev[h.test].measuredAt) < t) prev[h.test] = h;
  }
  return prev;
}

/**
 * Usable current values. With a catalog, a value in a unit other than the configured one is NOT usable (it would be read
 * on the wrong scale, e.g. glucose 104 mg/dL as 104 mmol/L): it counts as ordered-without-usable-result (rule D02 blocks).
 */
export function currentValues(report, catalog) {
  const v = {};
  for (const r of report.results) {
    const value = parseNumeric(r.value);
    if (r.status !== 'RESULTED' || value == null) continue;
    if (catalog && (r.unit ?? '').trim() !== catalog.analytes[r.test]?.unit) continue;
    v[r.test] = { ...r, value };
  }
  return v;
}

export function extractFeatures(report, history, catalog, { windowDays = 90 } = {}) {
  const discipline = report.discipline;
  const tests = MODEL_TESTS[discipline];
  const sex = report.context?.sex === 'F' ? 'F' : 'M';
  const cur = currentValues(report, catalog);
  const measuredAt = report.results.find(r => r.measuredAt)?.measuredAt ?? report.specimen?.collectedAt;
  // Reference time is per analyte (a partially re-run report can mix run times): no look-ahead.
  const prevOf = t => cur[t]?.measuredAt && validTime(cur[t].measuredAt) ? previousResults(history, cur[t].measuredAt, windowDays)[t] : undefined;
  // Missing values are NEVER imputed here: null = "no value" (not ordered / no result / no history).
  // m_<test> says whether the analyte was measured on this report; d_<test> is null without history.
  const f = {};
  let ss = 0, n = 0, maxAbs = 0, dilSum = 0, dilN = 0, minGapDays = null;
  for (const t of tests) {
    const def = catalog.analytes[t];
    const c = cur[t];
    const val = c && c.value >= 0 ? c.value : null; // 0 is a real result; negative concentrations are invalid
    f[`m_${t}`] = val == null ? 0 : 1;
    f[`z_${t}`] = val == null ? null : zScore(def, t, val, sex);
    const p = prevOf(t);
    const d = val != null && p && p.value >= 0 ? deltaScore(def, t, val, p.value, sex) : null;
    if (d != null) {
      f[`d_${t}`] = d;
      f[`ad_${t}`] = Math.abs(d);
      ss += d * d; n++; maxAbs = Math.max(maxAbs, Math.abs(d));
      if (!['NA', 'CL', 'GLU'].includes(t)) { dilSum += d; dilN++; }
      // Gap measured per analyte (its own measuredAt vs its own previous result), then the smallest is kept.
      const gap = (Date.parse(c.measuredAt) - Date.parse(p.measuredAt)) / DAY;
      if (Number.isFinite(gap) && gap >= 0 && (minGapDays == null || gap < minGapDays)) minGapDays = gap;
    } else {
      f[`d_${t}`] = null;
      f[`ad_${t}`] = null;
    }
  }
  f.hist_avail = n > 0 ? 1 : 0;
  // Without history the aggregate delta features are "not evaluable" (null), not 0.
  f.n_deltas = n ? n : null;
  f.delta_ms = n ? ss / n : null;
  f.delta_max_abs = n ? maxAbs : null;
  f.log_days_since_prev = minGapDays == null ? null : Math.log1p(minGapDays);
  f.acute_setting = ['IPD', 'ER'].includes(report.ward) ? 1 : 0;
  const age = report.context?.age;
  f.age_dec = typeof age === 'number' && Number.isFinite(age) ? age / 10 : null;
  f.sex_m = sex === 'M' ? 1 : 0;
  if (discipline === 'CHEM') {
    f.dilution_score = dilN ? dilSum / dilN : null;
    f.na_cl_gap = cur.NA && cur.CL ? cur.NA.value - cur.CL.value : null;
    f.k_minus_ca = f.z_K != null && f.z_CA != null ? f.z_K - f.z_CA : null;
    f.k_minus_alp = f.z_K != null && f.z_ALP != null ? f.z_K - f.z_ALP : null;
  } else {
    const t0 = Date.parse(measuredAt);
    f.recent_transfusion = (report.context?.events ?? []).some(e => e.code === 'TRANSFUSION'
      && Date.parse(e.knownAt) <= t0 && t0 - Date.parse(e.at) <= 14 * DAY && Date.parse(e.at) <= t0) ? 1 : 0;
    f.mchc_dev = cur.MCHC ? Math.abs(cur.MCHC.value - 333) / 10 : null;
  }
  return f;
}

export const FEATURE_LABELS = {
  hist_avail: 'Có lịch sử để so sánh', n_deltas: 'Số chỉ số so sánh được', delta_ms: 'Độ lệch lịch sử tổng hợp',
  delta_max_abs: 'Độ lệch lịch sử lớn nhất', log_days_since_prev: 'Khoảng cách tới lần trước',
  acute_setting: 'Nội trú/cấp cứu', age_dec: 'Tuổi', sex_m: 'Giới tính', dilution_score: 'Chỉ số pha loãng (các chỉ số cùng giảm)',
  na_cl_gap: 'Hiệu Na − Cl', k_minus_ca: 'K cao so với Ca', k_minus_alp: 'K cao so với ALP',
  recent_transfusion: 'Truyền máu ≤14 ngày (đã ghi nhận)', mchc_dev: 'MCHC lệch vùng thường gặp'
};

export function featureLabel(name, catalog) {
  if (FEATURE_LABELS[name]) return FEATURE_LABELS[name];
  const [kind, test] = name.split('_');
  const n = catalog?.analytes?.[test]?.name ?? test;
  if (kind === 'z') return `${n}: mức so với quần thể`;
  if (kind === 'd') return `${n}: thay đổi có hướng so với lần trước`;
  if (kind === 'ad') return `${n}: độ lớn thay đổi so với lần trước`;
  if (kind === 'm') return `${n}: có đo trên phiếu này`;
  return name;
}
