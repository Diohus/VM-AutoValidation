// Feature extraction shared by offline training and runtime inference.
// Uses only data available at the time of evaluation (history strictly before measuredAt,
// context with knownAt <= measuredAt). No identifiers, no diagnosis-as-shortcut.

export const MODEL_TESTS = {
  CHEM: ['GLU', 'URE', 'CRE', 'NA', 'K', 'CL', 'CA', 'MG', 'ALB', 'ALP', 'AST', 'ALT'],
  HEME: ['WBC', 'RBC', 'HGB', 'MCV', 'MCH', 'MCHC', 'RDW', 'PLT', 'NEU', 'LYM']
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

export function currentValues(report) {
  const v = {};
  for (const r of report.results) {
    const value = parseNumeric(r.value);
    if (r.status === 'RESULTED' && value != null) v[r.test] = { ...r, value };
  }
  return v;
}

export function extractFeatures(report, history, catalog, { windowDays = 90 } = {}) {
  const discipline = report.discipline;
  const tests = MODEL_TESTS[discipline];
  const sex = report.context?.sex === 'F' ? 'F' : 'M';
  const cur = currentValues(report);
  const measuredAt = report.results.find(r => r.measuredAt)?.measuredAt ?? report.specimen?.collectedAt;
  // Reference time is per analyte (a partially re-run report can mix run times): no look-ahead.
  const prevOf = t => cur[t]?.measuredAt && validTime(cur[t].measuredAt) ? previousResults(history, cur[t].measuredAt, windowDays)[t] : undefined;
  const f = {};
  let ss = 0, n = 0, maxAbs = 0, dilSum = 0, dilN = 0, lastPrevT = null;
  for (const t of tests) {
    const def = catalog.analytes[t];
    const c = cur[t];
    const val = c && c.value > 0 ? c.value : null;
    f[`z_${t}`] = val == null ? null : Math.log(val / centre(def, t, sex)) / (cvg(def, t) / 100);
    const p = prevOf(t);
    if (val != null && p && p.value > 0) {
      const sd = Math.SQRT2 * Math.sqrt(def.cvi ** 2 + (def.cva ?? 1) ** 2) / 100;
      const d = Math.log(val / p.value) / sd;
      f[`d_${t}`] = d;
      f[`ad_${t}`] = Math.abs(d);
      ss += d * d; n++; maxAbs = Math.max(maxAbs, Math.abs(d));
      if (!['NA', 'CL', 'GLU'].includes(t)) { dilSum += d; dilN++; }
      const pt = Date.parse(p.measuredAt);
      if (lastPrevT == null || pt > lastPrevT) lastPrevT = pt;
    } else {
      f[`d_${t}`] = null;
      f[`ad_${t}`] = null;
    }
  }
  f.hist_avail = n > 0 ? 1 : 0;
  f.n_deltas = n;
  f.delta_ms = n ? ss / n : null;
  f.delta_max_abs = n ? maxAbs : null;
  f.log_days_since_prev = lastPrevT == null ? null : Math.log1p((Date.parse(measuredAt) - lastPrevT) / DAY);
  f.acute_setting = ['IPD', 'ER'].includes(report.ward) ? 1 : 0;
  f.age_dec = (report.context?.age ?? 50) / 10;
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
  return name;
}
