// Synthetic LIS dataset generator. ALL DATA IS SYNTHETIC. Parameters are illustrative, not clinical.
// Layers: individual set-point → time-varying biology/disease (AR(1) within-subject variation, CVi)
//         → analytical error (CVa) → injected, labelled pre-analytical/analytical/data errors.
// Splits are assigned per subject BEFORE error injection. Wrong-blood-in-tube (WBIT) is NOT simulated
// (project decision 2026-11-17: specimens carry a positive SID; risk treated as negligible).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRng, hashString } from '../src/core/rng.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const catalog = JSON.parse(readFileSync(root + 'config/analytes.json', 'utf8'));
const A = catalog.analytes;

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const SEED = Number(args.seed ?? 20261116);
const N_SUBJECTS = Number(args.subjects ?? 3000);
const OUT_DIR = args.out ? (args.out.endsWith('/') ? args.out : args.out + '/') : 'data/synthetic/';
const WITH_TODAY = args.today !== 'false'; // demo worklist visits for "today" (runtime dataset only)
const START = Date.parse('2026-03-01T00:00:00+07:00');
const TODAY = '2026-11-16';
const TODAY_T = Date.parse(`${TODAY}T00:00:00+07:00`);
const END = TODAY_T + 86400000;
const DAY = 86400000, HOUR = 3600000, MIN = 60000;
const rng = createRng(SEED);

// Error rates are deliberately ENRICHED (≈10–50× real-world) so the models see enough positives.
// Real-world prevalence is handled at evaluation time by re-weighting (see scripts/train.mjs).
const RATES = {
  CHEM: { analytical_single: 0.01, edta: 0.01, saline_opd: 0.004, saline_ipd: 0.03, d5w_ipd: 0.012, short_sample: 0.003, unit: 0.003, missing: 0.008, delayed: 0.012, hil_missing: 0.006 },
  HEME: { analytical_single: 0.01, plt_clump: 0.02, clot: 0.003, missing: 0.005, delayed: 0.006, variant_lymph: 0.02 }
};

// ---------- time helpers (ISO with +07:00) ----------
function iso(t) {
  const d = new Date(t + 7 * HOUR);
  return d.toISOString().slice(0, 19) + '+07:00';
}
const dayStart = t => { const d = new Date(t + 7 * HOUR); d.setUTCHours(0, 0, 0, 0); return d.getTime() - 7 * HOUR; };

// ---------- ids ----------
let seq = { rpt: 0, enc: 0, spc: 0, ord: 0 };
const pad = (n, w = 6) => String(n).padStart(w, '0');
const hex = n => Array.from({ length: n }, () => '0123456789ABCDEF'[rng.int(0, 15)]).join('');

// ---------- subjects ----------
function splitOf(token) {
  const h = hashString(token + ':split') / 4294967296;
  return h < 0.6 ? 'train' : h < 0.8 ? 'val' : 'test';
}

const CONDITION_LABELS = {
  DM: 'Đái tháo đường type 2 (đã ghi nhận)', CKD: 'Bệnh thận mạn (đã ghi nhận)', LIVER: 'Bệnh gan mạn (đã ghi nhận)',
  IDA: 'Thiếu máu thiếu sắt (đã ghi nhận)', HTN: 'Tăng huyết áp (đã ghi nhận)'
};
const MED_LABELS = { INSULIN: 'Bắt đầu insulin', METFORMIN: 'Metformin', DIURETIC: 'Lợi tiểu thiazide', IRON: 'Bổ sung sắt' };

// Pseudonymous tokens must be unique: a collision would merge two simulated people's histories (Codex round 2).
const usedTokens = new Set();
function makeSubject(i) {
  let token;
  do token = `SBJ-${hex(6)}`; while (usedTokens.has(token));
  usedTokens.add(token);
  const sex = rng.chance(0.52) ? 'F' : 'M';
  const age = Math.round(Math.min(92, Math.max(18, 25 + rng.next() * 45 + rng.normal() * 12)));
  const conditions = [], medications = [];
  const before = START - rng.int(30, 2000) * DAY;
  const maybeOnset = () => rng.chance(0.85) ? before : START + rng.int(10, 200) * DAY;
  if (rng.chance(age > 50 ? 0.18 : 0.06)) conditions.push({ code: 'DM', severity: rng.uniform(1.4, 2.4), onset: maybeOnset() });
  if (rng.chance(age > 60 ? 0.1 : 0.03)) conditions.push({ code: 'CKD', severity: rng.uniform(1.5, 4.0), onset: maybeOnset() });
  if (rng.chance(0.04)) conditions.push({ code: 'LIVER', severity: rng.uniform(1.5, 4.0), onset: maybeOnset() });
  if (rng.chance(sex === 'F' ? 0.08 : 0.03)) conditions.push({ code: 'IDA', severity: rng.uniform(0.6, 1.0), onset: maybeOnset() });
  if (rng.chance(age > 50 ? 0.3 : 0.1)) conditions.push({ code: 'HTN', severity: 1, onset: before });
  if (conditions.some(c => c.code === 'HTN') && rng.chance(0.35)) medications.push({ code: 'DIURETIC', start: before });
  const dm = conditions.find(c => c.code === 'DM');
  if (dm) {
    medications.push({ code: 'METFORMIN', start: dm.onset });
    if (rng.chance(0.25)) medications.push({ code: 'INSULIN', start: START + rng.int(20, 240) * DAY });
  }
  // Set-points: shared latent factors give illustrative correlations (URE–CRE, AST–ALT, NA–CL).
  const fRenal = rng.normal(), fLiver = rng.normal(), fNaCl = rng.normal(), fErythro = rng.normal();
  const z = {};
  for (const t of Object.keys(A)) z[t] = rng.normal();
  z.URE = 0.6 * fRenal + 0.8 * z.URE; z.CRE = 0.6 * fRenal + 0.8 * z.CRE;
  z.AST = 0.75 * fLiver + 0.66 * z.AST; z.ALT = 0.75 * fLiver + 0.66 * z.ALT;
  z.NA = 0.6 * fNaCl + 0.8 * z.NA; z.CL = 0.6 * fNaCl + 0.8 * z.CL;
  z.RBC = 0.5 * fErythro + 0.87 * z.RBC;
  const setpoint = {};
  for (const [t, def] of Object.entries(A)) {
    if (def.dist === 'derived') continue;
    const m = typeof def.mean === 'object' ? def.mean[sex] : def.mean;
    setpoint[t] = def.dist === 'lognormal' ? m * Math.exp(z[t] * def.cvg / 100) : m * (1 + z[t] * def.cvg / 100);
  }
  setpoint.MCHC = 333 * (1 + rng.normal() * 0.02);
  setpoint.NEU = Math.min(75, Math.max(38, setpoint.NEU));
  return { token, sex, age, conditions, medications, setpoint, split: splitOf(token), ar: {}, acute: [] };
}

// ---------- physiology at time t ----------
function condActive(s, code, t) { const c = s.conditions.find(c => c.code === code); return c && c.onset <= t ? c : null; }
function medActive(s, code, t) { return s.medications.find(m => m.code === code && m.start <= t) ?? null; }

function trueValues(s, t, visit) {
  const v = {};
  const mult = Object.fromEntries(Object.keys(A).map(k => [k, 1]));
  const dm = condActive(s, 'DM', t);
  if (dm) {
    let g = dm.severity;
    const ins = medActive(s, 'INSULIN', t);
    if (ins) { const k = Math.min(1, (t - ins.start) / (35 * DAY)); g = g + (Math.min(g, 1.25) - g) * k; }
    mult.GLU *= g;
  }
  const ckd = condActive(s, 'CKD', t);
  if (ckd) { const k = ckd.severity; mult.CRE *= k; mult.URE *= 0.8 * k ** 0.9 + 0.2; mult.K *= 1 + 0.05 * (k - 1); mult.CA *= 0.97; mult.MG *= 1.08; mult.ALB *= 0.95; mult.RBC *= 1 - 0.05 * (k - 1); }
  const liv = condActive(s, 'LIVER', t);
  if (liv) { mult.AST *= liv.severity; mult.ALT *= liv.severity * rng.uniform(0.9, 1.2); mult.ALB *= 0.88; mult.ALP *= 1.3; mult.PLT *= 0.75; }
  const ida = condActive(s, 'IDA', t);
  if (ida && !medActive(s, 'IRON', t)) { const k = ida.severity; mult.MCV *= 1 - 0.14 * k; mult.MCHC *= 1 - 0.05 * k; mult.RDW *= 1 + 0.25 * k; mult.RBC *= 1 - 0.03 * k; }
  if (medActive(s, 'DIURETIC', t)) { mult.K *= 0.9; mult.NA *= 0.99; mult.URE *= 1.15; }
  if (visit.fasting === 'NO') mult.GLU *= rng.uniform(1.1, 1.5);
  // acute episode effects (inpatient)
  for (const e of s.acute) {
    if (t < e.start || t > e.end + 10 * DAY) continue;
    const day = (t - e.start) / DAY;
    if (e.type === 'AKI') { const k = 1 + (e.peak - 1) * Math.min(1, day / 3) * (t > e.end ? Math.max(0, 1 - (t - e.end) / (8 * DAY)) : 1); mult.CRE *= k; mult.URE *= k ** 0.9; mult.K *= 1 + 0.04 * (k - 1); }
    if (e.type === 'SEPSIS' && t <= e.end) { mult.WBC *= e.peak; mult.PLT *= 0.6; mult.ALB *= 0.9; mult.CRE *= 1.25; mult.NEU *= 1.25; }
    if (e.type === 'BLEED') {
      if (day >= 1) mult.RBC *= e.peak;
      if (e.transfusionAt && t >= e.transfusionAt) { mult.RBC *= 1 / e.peak * 0.92; mult.MCV = 1 + (mult.MCV - 1) * 0.5 + (90 / s.setpoint.MCV - 1) * 0.35; mult.RDW *= 1.12; }
    }
  }
  // within-subject AR(1) deviations (CVi is the stationary SD around the set-point, not a random-walk step)
  for (const [k, def] of Object.entries(A)) {
    if (def.dist === 'derived') continue;
    const prev = s.ar[k];
    const rho = prev ? Math.exp(-Math.abs(t - prev.t) / (12 * DAY)) : 0;
    const e = prev ? rho * prev.e + Math.sqrt(1 - rho * rho) * rng.normal() : rng.normal();
    s.ar[k] = { t, e };
    v[k] = s.setpoint[k] * mult[k] * (1 + e * def.cvi / 100);
  }
  const prevM = s.ar.MCHC; const rhoM = prevM ? Math.exp(-Math.abs(t - prevM.t) / (12 * DAY)) : 0;
  const eM = prevM ? rhoM * prevM.e + Math.sqrt(1 - rhoM ** 2) * rng.normal() : rng.normal();
  s.ar.MCHC = { t, e: eM };
  const MCHC = s.setpoint.MCHC * mult.MCHC * (1 + eM * 0.01);
  v.HCT = v.RBC * v.MCV / 1000;
  v.HGB = v.HCT * MCHC;
  v.MCH = v.HGB / v.RBC;
  v.MCHC = MCHC;
  v.NEU = Math.min(95, Math.max(20, v.NEU));
  v.LYM = Math.max(3, Math.min(70, (100 - v.NEU - 10) * (1 + rng.normal() * 0.08)));
  return v;
}

function measure(trueV, tests) {
  const out = {};
  for (const t of tests) {
    const def = A[t];
    out[t] = trueV[t] * (1 + rng.normal() * (def.cva ?? 1) / 100);
  }
  return out;
}
const round = (t, x) => Number(x.toFixed(A[t].decimals));

// ---------- QC log ----------
const qcLog = [];
const qcFailWindows = []; // {instrument,test,from,to}
function buildQc() {
  const pairs = [];
  for (const [t, def] of Object.entries(A)) pairs.push({ instrument: def.instrument, test: t });
  for (let d = dayStart(START - 2 * DAY); d < END; d += DAY) {
    for (const p of pairs) {
      // morning QC (two levels summarised as one record for the demo)
      qcLog.push({ instrument: p.instrument, test: p.test, at: iso(d + 6 * HOUR + 30 * MIN), status: 'PASS', level: 'L1+L2', note: null });
      if (rng.chance(0.006) && d < TODAY_T) {
        const from = d + rng.int(9, 14) * HOUR + rng.int(0, 59) * MIN;
        const to = from + rng.int(60, 180) * MIN;
        qcLog.push({ instrument: p.instrument, test: p.test, at: iso(from), status: 'FAIL', level: 'L2', note: 'Vượt 1-3s (minh họa)' });
        qcLog.push({ instrument: p.instrument, test: p.test, at: iso(to), status: 'PASS', level: 'L1+L2', note: 'Sau hiệu chuẩn lại (minh họa)' });
        qcFailWindows.push({ instrument: p.instrument, test: p.test, from, to, bias: rng.chance(0.5) ? 1.06 : 0.94 });
      }
    }
  }
  // Today: a scripted K failure on the ISE (used by a pinned scenario, also affects other K results in the window).
  const from = TODAY_T + 10 * HOUR + 20 * MIN, to = TODAY_T + 11 * HOUR + 40 * MIN;
  qcLog.push({ instrument: 'COBAS_ISE', test: 'K', at: iso(from), status: 'FAIL', level: 'L2', note: 'Vượt 1-3s, nghi điện cực K (kịch bản minh họa)' });
  qcLog.push({ instrument: 'COBAS_ISE', test: 'K', at: iso(to), status: 'PASS', level: 'L1+L2', note: 'Sau bảo trì điện cực (kịch bản minh họa)' });
  qcFailWindows.push({ instrument: 'COBAS_ISE', test: 'K', from, to, bias: 1.07 });
  qcLog.sort((a, b) => a.at.localeCompare(b.at));
}
const inQcFail = (instrument, test, t) => qcFailWindows.find(w => w.instrument === instrument && w.test === test && t >= w.from && t < w.to);

// ---------- reports ----------
const PANELS = catalog.panels;

function contextFor(s, t, visit) {
  const known = x => x <= t;
  return {
    age: s.age,
    ageGroup: s.age < 40 ? '18–39' : s.age < 60 ? '40–59' : s.age < 75 ? '60–74' : '≥75',
    sex: s.sex,
    fasting: visit.fasting,
    ivInfusion: visit.ivInfusion,
    conditions: s.conditions.filter(c => known(c.onset) && c.code !== 'HTN' || c.code === 'HTN' && known(c.onset))
      .map(c => ({ code: c.code, label: CONDITION_LABELS[c.code], knownAt: iso(c.onset) })),
    medications: s.medications.filter(m => known(m.start)).map(m => ({ code: m.code, label: MED_LABELS[m.code], startedAt: iso(m.start), knownAt: iso(m.start) })),
    events: s.acute.flatMap(e => {
      const ev = [];
      if (known(e.start)) ev.push({ code: 'ADMISSION', label: e.label, at: iso(e.start), knownAt: iso(e.start) });
      if (e.transfusionAt && known(e.transfusionAt)) ev.push({ code: 'TRANSFUSION', label: 'Truyền khối hồng cầu', at: iso(e.transfusionAt), knownAt: iso(e.transfusionAt) });
      return ev;
    })
  };
}

function hilFor(s, t) {
  let H = Math.round(Math.max(0, rng.normal() * 8 + 6));
  let L = Math.round(Math.max(0, rng.normal() * 10 + 15));
  let I = Math.round(Math.max(0, rng.normal() * 1 + 2));
  if (condActive(s, 'LIVER', t)) I = rng.int(5, 40);
  if (rng.chance(0.01)) L = rng.int(300, 1600);
  return { H, L, I };
}

function newReport(s, panelCode, collectedT, visit, { ward }) {
  const panel = PANELS[panelCode];
  const receivedT = collectedT + rng.int(10, 60) * MIN;
  const measuredT = receivedT + rng.int(15, 80) * MIN;
  return {
    reportId: `RPT-${pad(++seq.rpt)}`,
    version: 1,
    subjectToken: s.token,
    encounterId: visit.encounterId,
    orderId: `ORD-${pad(++seq.ord)}`,
    panel: panelCode,
    panelName: panel.name,
    discipline: panel.discipline,
    ward,
    orderedTests: [...panel.tests],
    specimen: { specimenId: `SPC-${pad(++seq.spc)}`, type: panel.specimen, collectedAt: iso(collectedT), receivedAt: iso(receivedT), hil: panel.discipline === 'CHEM' ? hilFor(s, collectedT) : null },
    results: [],
    instrumentFlags: [],
    context: contextFor(s, collectedT, visit),
    split: s.split,
    _t: measuredT,
    truth: { sampleError: null, errors: [], dataIssue: null, criticalValue: false, pathologyFlag: null, requiresReview: false, details: null }
  };
}

function fillResults(r, measured) {
  r.results = r.orderedTests.map(t => ({
    test: t, status: 'RESULTED', value: round(t, measured[t]), unit: A[t].unit,
    instrument: A[t].instrument, measuredAt: iso(r._t), run: 1, flags: []
  }));
}

// Every injected error is recorded in truth.errors (multi-label); truth.sampleError keeps the first (primary) one.
function markError(r, code, details) {
  if (!r.truth.errors.includes(code)) r.truth.errors.push(code);
  if (!r.truth.sampleError) { r.truth.sampleError = code; r.truth.details = details; }
}

// Analytes never hit by analytical_single in train/val: test-only, to check generalisation beyond the injected pattern.
export const ANALYTICAL_HOLDOUT = ['ALT', 'MG', 'PLT', 'RDW'];

// Single-analyte analytical error (Farrell 2024 style): one analyte off by 8–60% with no instrument flag and passing QC
// (e.g. bubble / partial probe clog). Percent-type analytes (NEU, LYM) get an additive shift instead.
// On the haematology analyser HCT, MCH and MCHC are CALCULATED (HCT = RBC×MCV, MCH = HGB/RBC, MCHC = HGB/HCT):
// a single-channel error hits a measured parameter and propagates to the calculated ones, never the reverse.
const HEME_CALCULATED = ['HCT', 'MCH', 'MCHC'];
function applyAnalyticalSingle(r) {
  const pool = r.results.filter(x => typeof x.value === 'number' && !HEME_CALCULATED.includes(x.test)
    && (r.split === 'test' || !ANALYTICAL_HOLDOUT.includes(x.test)));
  if (!pool.length) return;
  const x = rng.pick(pool);
  const mag = rng.uniform(0.08, 0.6), dir = rng.chance(0.5) ? 1 : -1;
  const pct = ['NEU', 'LYM'].includes(x.test);
  const before = x.value;
  x.value = round(x.test, Math.max(0, pct ? x.value + dir * mag * 40 : x.value * (1 + dir * mag)));
  if (r.discipline === 'HEME' && ['RBC', 'HGB', 'MCV'].includes(x.test)) {
    const g = t => r.results.find(q => q.test === t);
    const ok = t => typeof g(t)?.value === 'number';
    if (ok('RBC') && ok('MCV') && ok('HCT') && x.test !== 'HGB') g('HCT').value = round('HCT', g('RBC').value * g('MCV').value / 1000);
    if (ok('HGB') && ok('RBC') && ok('MCH') && x.test !== 'MCV') g('MCH').value = round('MCH', g('RBC').value > 0 ? g('HGB').value / g('RBC').value : 0);
    if (ok('HGB') && ok('HCT') && ok('MCHC')) g('MCHC').value = round('MCHC', g('HCT').value > 0 ? g('HGB').value / g('HCT').value : 0);
  }
  r.truth.analytical = { test: x.test, magnitude: Number(mag.toFixed(3)), direction: dir, before, after: x.value, holdoutAnalyte: ANALYTICAL_HOLDOUT.includes(x.test) };
  markError(r, 'analytical_single', `Lỗi phân tích đơn chỉ số mô phỏng: ${x.test} ${dir > 0 ? '+' : '−'}${(mag * 100).toFixed(0)}%${pct ? ' (điểm ×40)' : ''}`);
}

function applyErrors(r, s) {
  const rates = RATES[r.discipline];
  const v = Object.fromEntries(r.results.map(x => [x.test, x.value]));
  const set = (t, x) => { const res = r.results.find(q => q.test === t); if (res) res.value = round(t, Math.max(x, 0)); };
  const has = t => t in v;
  if (r.discipline === 'CHEM') {
    const ipd = r.ward !== 'OPD';
    const u = rng.next();
    let acc = 0;
    const pickErr = [['edta', rates.edta], ['saline', ipd ? rates.saline_ipd : rates.saline_opd], ['d5w', ipd ? rates.d5w_ipd : 0], ['short_sample', rates.short_sample], ['delayed', rates.delayed]];
    let chosen = null;
    for (const [k, p] of pickErr) { acc += p; if (u < acc) { chosen = k; break; } }
    if (chosen === 'edta') {
      const sev = rng.uniform(0.15, 1);
      set('K', v.K + 0.8 + 6 * sev);
      if (has('CA')) set('CA', v.CA * (1 - 0.1 - 0.55 * sev));
      if (has('MG')) set('MG', v.MG * (1 - 0.05 - 0.4 * sev));
      if (has('ALP')) set('ALP', v.ALP * (1 - 0.1 - 0.5 * sev));
      markError(r, 'edta', `Nhiễm EDTA mô phỏng, mức ${sev.toFixed(2)}`);
    } else if (chosen === 'saline' || chosen === 'd5w') {
      const f = chosen === 'saline' ? rng.uniform(0.06, 0.4) : rng.uniform(0.04, 0.3);
      const fluid = chosen === 'saline' ? { NA: 154, CL: 154 } : { GLU: 278 };
      for (const t of Object.keys(v)) set(t, (1 - f) * v[t] + f * (fluid[t] ?? 0));
      markError(r, chosen, `Lẫn ${chosen === 'saline' ? 'NaCl 0,9%' : 'glucose 5%'} mô phỏng, tỷ lệ ${(f * 100).toFixed(0)}%`);
      r.context.ivInfusion = rng.chance(0.6) ? 'YES' : 'UNKNOWN';
    } else if (chosen === 'short_sample') {
      for (const t of Object.keys(v)) set(t, v[t] * rng.uniform(0.75, 0.95));
      r.instrumentFlags.push({ code: 'SAMPLE_SHORT', source: 'COBAS_C303' });
      markError(r, 'short_sample', 'Thiếu thể tích mẫu (máy gắn cờ)');
    } else if (chosen === 'delayed') {
      const hrs = rng.uniform(5, 11);
      r._t = Date.parse(r.specimen.collectedAt) + hrs * HOUR;
      r.results.forEach(x => x.measuredAt = iso(r._t));
      set('K', v.K + 0.08 * (hrs - 3)); set('GLU', v.GLU * (1 - 0.05 * (hrs - 2)));
      markError(r, 'delayed', `Mẫu chậm xử lý ${hrs.toFixed(1)} giờ (mô phỏng)`);
    }
    // hemolysis (independent of above)
    const hil = r.specimen.hil;
    if (hil && rng.chance(0.05)) {
      hil.H = rng.chance(0.25) ? rng.int(300, 800) : rng.int(40, 300);
      const H = hil.H;
      const cur = Object.fromEntries(r.results.map(x => [x.test, x.value]));
      set('K', cur.K + 0.003 * H); if (has('AST')) set('AST', cur.AST + 0.12 * H); if (has('ALT')) set('ALT', cur.ALT + 0.01 * H); if (has('MG')) set('MG', cur.MG + 0.0005 * H);
      if (H > 90) markError(r, 'hemolysis', `Tan máu mô phỏng, H=${H}`);
    }
    if (rng.chance(rates.hil_missing)) { r.specimen.hil = null; r.truth.dataIssue = r.truth.dataIssue ?? 'hil_missing'; }
    if (rng.chance(rates.unit)) {
      const t = rng.pick(['GLU', 'CRE', 'CRE_NOUNIT']);
      if (t === 'GLU') { const res = r.results.find(x => x.test === 'GLU'); res.value = Math.round(res.value * 18.016); res.unit = 'mg/dL'; }
      else if (t === 'CRE') { const res = r.results.find(x => x.test === 'CRE'); res.value = Number((res.value / 88.4).toFixed(2)); res.unit = 'mg/dL'; }
      else { const res = r.results.find(x => x.test === 'CRE'); res.unit = ''; }
      r.truth.dataIssue = 'unit_error';
    }
  } else {
    const u = rng.next();
    if (u < rates.plt_clump) {
      set('PLT', v.PLT * rng.uniform(0.25, 0.7));
      if (rng.chance(0.85)) r.instrumentFlags.push({ code: 'PLT_CLUMPS', source: 'DXH_690T' });
      markError(r, 'plt_clump', 'Tiểu cầu kết cụm mô phỏng');
    } else if (u < rates.plt_clump + rates.clot) {
      set('PLT', v.PLT * rng.uniform(0.3, 0.7)); set('WBC', v.WBC * rng.uniform(0.8, 0.95));
      r.instrumentFlags.push({ code: 'CLOT_DETECTED', source: 'DXH_690T' });
      markError(r, 'clot', 'Mẫu có cục đông (máy gắn cờ)');
    } else if (u < rates.plt_clump + rates.clot + rates.delayed) {
      const hrs = rng.uniform(26, 40);
      r._t = Date.parse(r.specimen.collectedAt) + hrs * HOUR; r.results.forEach(x => x.measuredAt = iso(r._t));
      set('MCV', v.MCV * 1.04); set('HCT', v.HCT * 1.04); set('MCHC', v.MCHC * 0.96);
      markError(r, 'delayed', `Mẫu EDTA để ${hrs.toFixed(0)} giờ`);
    }
    if (rng.chance(rates.variant_lymph)) { r.instrumentFlags.push({ code: 'VARIANT_LYMPH', source: 'DXH_690T' }); r.truth.pathologyFlag = 'VARIANT_LYMPH'; }
  }
  if (rng.chance(rates.analytical_single)) applyAnalyticalSingle(r);
  if (rng.chance(rates.missing)) {
    const res = rng.pick(r.results);
    res.status = rng.pick(['PENDING', 'TRANSMISSION_ERROR', 'FAILED']); res.value = null;
    r.truth.dataIssue = r.truth.dataIssue ?? 'missing_result';
  }
}

function applyQcBias(r) {
  for (const x of r.results) {
    const w = inQcFail(x.instrument, x.test, Date.parse(x.measuredAt));
    if (w && typeof x.value === 'number') { x.value = round(x.test, x.value * w.bias); markError(r, 'qc_window', `Đo trong khoảng QC không đạt (${x.test})`); }
  }
}

function finalizeTruth(r) {
  for (const x of r.results) {
    if (typeof x.value !== 'number') continue;
    const def = A[x.test];
    if (x.unit !== def.unit) continue;
    const [lo, hi] = def.critical ?? [];
    if ((lo != null && x.value < lo) || (hi != null && x.value > hi)) r.truth.criticalValue = true;
    if (x.value > def.amr[1]) x.flags.push('ABOVE_AMR');
  }
  if (r.discipline === 'HEME') {
    const sepsis = r.context.events.some(e => e.code === 'ADMISSION' && /nhiễm khuẩn/.test(e.label));
    const wbc = r.results.find(x => x.test === 'WBC')?.value;
    if (sepsis && wbc > 14 && rng.chance(0.5)) { r.instrumentFlags.push({ code: 'IG_PRESENT', source: 'DXH_690T' }); r.truth.pathologyFlag = 'IG_PRESENT'; }
  }
  const t = r.truth;
  t.requiresReview = !!(t.sampleError || t.dataIssue || t.criticalValue || t.pathologyFlag);
  // Simulated reviewer: "reviewer approved" ≠ "result was correct".
  const pHold = t.sampleError ? ({ analytical_single: 0.5, edta: 0.85, saline: 0.7, d5w: 0.8, hemolysis: 0.95, qc_window: 0.97, delayed: 0.6, plt_clump: 0.9, clot: 0.97, short_sample: 0.97 }[t.sampleError] ?? 0.8)
    : t.dataIssue ? 0.99 : t.criticalValue ? 0.97 : t.pathologyFlag ? 0.9 : 0.05;
  r.reviewer = { action: rng.chance(pHold) ? 'HOLD' : 'APPROVE', simulated: true };
}

// ---------- main simulation ----------
function simulate() {
  const subjects = Array.from({ length: N_SUBJECTS }, (_, i) => makeSubject(i));
  const reports = [];
  const visits = [];
  for (const s of subjects) {
    const nOpd = 1 + rng.poisson(2.0);
    for (let k = 0; k < nOpd; k++) visits.push({ s, t: START + rng.next() * (TODAY_T - START - DAY), ward: 'OPD' });
    if (rng.chance(0.15)) {
      const st = dayStart(START + rng.next() * (TODAY_T - START - 8 * DAY)) + rng.int(8, 20) * HOUR;
      const len = rng.int(3, 6);
      const type = rng.pick(['AKI', 'SEPSIS', 'BLEED', 'OTHER', 'OTHER']);
      const label = { AKI: 'Nhập viện: theo dõi tổn thương thận cấp', SEPSIS: 'Nhập viện: nghi nhiễm khuẩn', BLEED: 'Nhập viện: xuất huyết tiêu hóa', OTHER: 'Nhập viện nội khoa' }[type];
      const e = { type, label, start: st, end: st + len * DAY, peak: type === 'AKI' ? rng.uniform(1.5, 3) : type === 'SEPSIS' ? rng.uniform(1.8, 3.5) : type === 'BLEED' ? rng.uniform(0.7, 0.85) : 1 };
      if (type === 'BLEED' && rng.chance(0.7)) e.transfusionAt = st + 2 * DAY + 3 * HOUR;
      s.acute.push(e);
      visits.push({ s, t: st - rng.int(1, 4) * HOUR, ward: 'ER' });
      for (let d = 1; d <= len; d++) visits.push({ s, t: dayStart(st) + d * DAY + rng.int(5 * 60, 6 * 60 + 30) * MIN, ward: 'IPD' });
    }
  }
  // Today's worklist: test-split subjects (never seen in training) get a morning visit.
  const testSubjects = subjects.filter(s => s.split === 'test');
  if (WITH_TODAY) for (const s of testSubjects) if (rng.chance(0.09)) visits.push({ s, t: TODAY_T + rng.int(7 * 60, 10 * 60 + 30) * MIN, ward: 'OPD', today: true });
  // Fix OPD clock times BEFORE ordering visits, so the AR(1) biology is always advanced forward in time.
  for (const v of visits) if (v.ward === 'OPD' && !v.today) v.t = dayStart(v.t) + rng.int(7 * 60, 11 * 60) * MIN;
  visits.sort((a, b) => a.t - b.t);
  for (const vis of visits) {
    const { s, ward } = vis;
    const t = vis.t;
    const visit = { encounterId: `ENC-${pad(++seq.enc)}`, fasting: ward === 'OPD' ? (rng.chance(0.6) ? 'YES' : rng.chance(0.5) ? 'NO' : 'UNKNOWN') : 'UNKNOWN', ivInfusion: ward === 'IPD' ? (rng.chance(0.6) ? 'YES' : 'UNKNOWN') : ward === 'ER' ? 'UNKNOWN' : 'NO' };
    const trueV = trueValues(s, t, visit);
    const panels = [];
    if (ward === 'OPD') {
      const c = rng.next();
      if (c < 0.4) panels.push('CHEM_BASIC'); else if (c < 0.85) panels.push('CHEM_EXT');
      if (rng.chance(0.65) || !panels.length) panels.push('CBC');
    } else { panels.push(rng.chance(0.6) ? 'CHEM_EXT' : 'CHEM_BASIC', 'CBC'); }
    for (const p of panels) {
      const r = newReport(s, p, t, visit, { ward });
      fillResults(r, measure(trueV, r.orderedTests));
      applyErrors(r, s);
      reports.push(r);
    }
  }
  for (const r of reports) { applyQcBias(r); finalizeTruth(r); }
  return { subjects, reports };
}

// ---------- pinned demo scenarios (hand-crafted, excluded from model evaluation) ----------
const NORMAL = { GLU: 5.1, URE: 4.9, CRE: 82, NA: 140, K: 4.2, CL: 103, CA: 2.36, MG: 0.86, ALB: 43, ALP: 76, AST: 23, ALT: 22,
  WBC: 6.4, RBC: 4.85, HGB: 144, HCT: 0.432, MCV: 89.1, MCH: 29.7, MCHC: 333, RDW: 12.9, PLT: 248, NEU: 58.2, LYM: 30.5 };

function scenarioReports() {
  const out = [];
  const mk = (sc, panel, whenIso, values = {}, opts = {}) => {
    const p = PANELS[panel];
    const collected = Date.parse(whenIso);
    const measured = collected + (opts.measureAfterMin ?? 55) * MIN;
    const r = {
      reportId: opts.id ?? `RPT-${pad(++seq.rpt)}`, version: 1, subjectToken: sc.token, encounterId: `ENC-${pad(++seq.enc)}`, orderId: `ORD-${pad(++seq.ord)}`,
      panel, panelName: p.name, discipline: p.discipline, ward: opts.ward ?? 'OPD', orderedTests: [...p.tests],
      specimen: { specimenId: `SPC-${pad(++seq.spc)}`, type: p.specimen, collectedAt: iso(collected), receivedAt: iso(collected + 20 * MIN),
        hil: p.discipline === 'CHEM' ? (opts.hil === undefined ? { H: 8, L: 14, I: 2 } : opts.hil) : null },
      results: p.tests.map(t => {
        const val = t in values ? values[t] : NORMAL[t] * (1 + (opts.jitter ?? 0.01) * rng.normal() * (t === 'NA' || t === 'CL' ? 0.2 : 1));
        const over = opts.override?.[t] ?? {};
        return { test: t, status: 'RESULTED', value: typeof val === 'number' ? round(t, val) : val, unit: A[t].unit, instrument: A[t].instrument,
          measuredAt: iso(opts.measuredAtIso ? Date.parse(opts.measuredAtIso) : measured), run: 1, flags: [], ...over };
      }),
      instrumentFlags: opts.flags ?? [],
      context: { age: sc.age, ageGroup: sc.age < 40 ? '18–39' : sc.age < 60 ? '40–59' : sc.age < 75 ? '60–74' : '≥75', sex: sc.sex, fasting: opts.fasting ?? 'YES', ivInfusion: opts.iv ?? 'NO',
        conditions: sc.conditions ?? [], medications: (sc.medications ?? []).filter(m => m.knownAt <= iso(collected)), events: (sc.events ?? []).filter(e => e.knownAt <= iso(collected)) },
      split: 'scenario',
      truth: { sampleError: null, dataIssue: null, criticalValue: false, pathologyFlag: null, requiresReview: false, details: null, ...(opts.truth ?? {}) },
      reviewer: null
    };
    r.truth.errors = r.truth.sampleError ? [r.truth.sampleError] : [];
    r.truth.requiresReview = !!(r.truth.sampleError || r.truth.dataIssue || r.truth.criticalValue || r.truth.pathologyFlag || opts.truth?.requiresReview);
    if (opts.scenario) r.scenario = opts.scenario;
    out.push(r);
    return r;
  };
  const S = (n, sex, age, extra = {}) => ({ token: `SBJ-DEMO${String(n).padStart(2, '0')}`, sex, age, ...extra });
  const T = (hhmm) => `${TODAY}T${hhmm}:00+07:00`;
  const sc = (code, title, expect, story) => ({ code, title, expect, story });

  // 1. Clean
  let s = S(1, 'M', 46);
  mk(s, 'CHEM_EXT', '2026-06-10T08:05:00+07:00'); mk(s, 'CHEM_EXT', '2026-09-02T08:20:00+07:00');
  mk(s, 'CHEM_EXT', T('07:40'), {}, { scenario: sc('KB1', 'Phiếu đầy đủ, đáp ứng mọi điều kiện demo', 'AUTO_APPROVE_ELIGIBLE', 'Đủ chỉ số, QC đạt, không cờ, HIL thấp, ổn định so với lịch sử → đủ điều kiện tự động duyệt (mô phỏng ký).') });
  // 2. Diabetic, high but stable glucose
  s = S(2, 'F', 63, { conditions: [{ code: 'DM', label: CONDITION_LABELS.DM, knownAt: '2024-03-01T00:00:00+07:00' }], medications: [{ code: 'METFORMIN', label: MED_LABELS.METFORMIN, startedAt: '2024-03-05T00:00:00+07:00', knownAt: '2024-03-05T00:00:00+07:00' }] });
  mk(s, 'CHEM_BASIC', '2026-08-12T07:50:00+07:00', { GLU: 11.1, CRE: 68 }); mk(s, 'CHEM_BASIC', '2026-10-01T08:10:00+07:00', { GLU: 12.2, CRE: 70 });
  mk(s, 'CHEM_BASIC', T('07:55'), { GLU: 11.7, CRE: 69 }, { scenario: sc('KB2', 'Ngoài khoảng tham chiếu nhưng ổn định theo lịch sử', 'AUTO_APPROVE_ELIGIBLE', 'Glucose 11,7 mmol/L ngoài khoảng tham chiếu. Hệ thống KHÔNG pass vì "có tiểu đường": phiếu chỉ đủ điều kiện vì vẫn trong giới hạn tự duyệt minh họa, khớp lịch sử có thời điểm và qua mọi điều kiện khác. Chẩn đoán nền chỉ hiển thị làm bối cảnh.') });
  // 3. Diabetic, glucose back to target after treatment → delta fires, context shown
  s = S(3, 'M', 58, { conditions: [{ code: 'DM', label: CONDITION_LABELS.DM, knownAt: '2025-01-10T00:00:00+07:00' }],
    medications: [{ code: 'METFORMIN', label: MED_LABELS.METFORMIN, startedAt: '2025-01-12T00:00:00+07:00', knownAt: '2025-01-12T00:00:00+07:00' }, { code: 'INSULIN', label: MED_LABELS.INSULIN, startedAt: '2026-10-15T00:00:00+07:00', knownAt: '2026-10-15T10:00:00+07:00' }] });
  mk(s, 'CHEM_BASIC', '2026-07-15T08:00:00+07:00', { GLU: 12.1 }); mk(s, 'CHEM_BASIC', '2026-09-20T08:00:00+07:00', { GLU: 12.6 }); mk(s, 'CHEM_BASIC', '2026-10-28T08:00:00+07:00', { GLU: 10.8 });
  mk(s, 'CHEM_BASIC', T('08:05'), { GLU: 6.1 }, { scenario: sc('KB2b', 'Tiểu đường, glucose về mục tiêu sau điều trị', 'MANUAL_REVIEW', 'Glucose giảm 10,8 → 6,1 (−44%) vượt delta minh họa của glucose (±40%). Bối cảnh "bắt đầu insulin 15/10" được hiển thị kèm thời điểm, nhưng hệ thống không tự dùng chẩn đoán/điều trị để cho qua và cũng không kết luận lỗi mẫu: người phụ trách quyết định. Bật "Ngưỡng cá nhân": 6,1 còn nằm ngoài khoảng thường gặp của chính người bệnh — đúng ý "glucose bình thường lại bất thường với người này", nhưng vẫn chỉ là lý do để xem, không phải kết luận lỗi.') });
  // 4. Delta check fail (creatinine jump, outpatient, no context)
  s = S(4, 'F', 51);
  mk(s, 'CHEM_EXT', '2026-11-13T08:30:00+07:00', { CRE: 71 });
  mk(s, 'CHEM_EXT', T('08:15'), { CRE: 158, URE: 5.2 }, { truth: { sampleError: null, requiresReview: true, details: 'Ca dựng sẵn: chưa rõ nguyên nhân, cần đối chiếu' },
    scenario: sc('KB3', 'Thay đổi so với lịch sử vượt điều kiện demo', 'MANUAL_REVIEW', 'Creatinine 71 → 158 µmol/L sau 3 ngày (+123%), ure gần như không đổi, không có bối cảnh nhập viện. Hệ thống chuyển kiểm tra; đây là lý do cần xem xét, chưa phải bằng chứng mẫu lỗi.') });
  // 5. CBC: large change vs previous (cause not established) → delta check holds. WBIT is out of scope.
  s = S(5, 'M', 39);
  mk(s, 'CBC', '2026-11-06T09:00:00+07:00', { MCV: 92.4, RDW: 12.6, MCH: 31.0, HGB: 151, RBC: 4.87, HCT: 0.45, MCHC: 336 });
  mk(s, 'CBC', T('08:40'), { MCV: 77.8, RDW: 16.1, MCH: 24.9, HGB: 117, RBC: 4.70, HCT: 0.366, MCHC: 320, PLT: 331 }, { truth: { requiresReview: true, details: 'Thay đổi lớn so với lần trước, nguyên nhân chưa xác định' },
    scenario: sc('KB3b', 'CBC thay đổi lớn so với lần trước (MCV/RDW)', 'MANUAL_REVIEW', 'MCV 92,4 → 77,8 fL, RDW 12,6 → 16,1% sau 10 ngày, không ghi nhận truyền máu. MCV/RDW/MCH là các chỉ số ổn định trong cá thể nên delta check (HEME-H01) giữ lại. Hệ thống chỉ nêu thay đổi, không kết luận nguyên nhân (thay đổi thật hay lỗi phân tích); người phụ trách đối chiếu lâm sàng/chạy lại.') });
  // 6. QC lock
  s = S(6, 'M', 44);
  mk(s, 'CHEM_BASIC', T('10:05'), { K: 4.6 }, { measuredAtIso: T('10:45'), truth: { sampleError: 'qc_window', details: 'Đo K trong khoảng QC không đạt' },
    scenario: sc('KB4', 'QC không đạt đang khóa (cobas ISE – K)', 'BLOCKED', 'QC kali lúc 10:20 không đạt, QC đạt lại lúc 11:40. Mẫu đo K lúc 10:45 → BLOCKED dù giá trị trông bình thường. Các phiếu khác có K đo trong khoảng này cũng bị chặn.') });
  // 7. Instrument flag
  s = S(7, 'F', 33);
  mk(s, 'CBC', T('08:20'), { PLT: 61 }, { flags: [{ code: 'PLT_CLUMPS', source: 'DXH_690T' }], truth: { sampleError: 'plt_clump', details: 'Kết cụm tiểu cầu (cờ máy)' },
    scenario: sc('KB4b', 'Cờ máy: PLT clumps', 'BLOCKED', 'DxH 690T (mô phỏng) gửi cờ PLT_CLUMPS kèm PLT 61 G/L. Không ký tự động; người phụ trách xử lý theo SOP (xem lam, chạy lại/ống citrat...).') });
  // 8. Unit error
  s = S(8, 'M', 55);
  mk(s, 'CHEM_BASIC', T('08:30'), { GLU: 104 }, { override: { GLU: { unit: 'mg/dL' } }, truth: { dataIssue: 'unit_error' },
    scenario: sc('KB5', 'Sai đơn vị trong bản tin', 'BLOCKED', 'Glucose gửi 104 mg/dL thay vì mmol/L. Hệ thống không tự quy đổi; nêu giá trị nếu quy đổi (≈5,8 mmol/L) và yêu cầu xác nhận cấu hình giao tiếp.') });
  // 9. Missing required result
  s = S(9, 'F', 67);
  mk(s, 'CHEM_EXT', T('08:10'), { CL: null }, { override: { CL: { status: 'TRANSMISSION_ERROR', value: null } }, truth: { dataIssue: 'missing_result' },
    scenario: sc('KB5b', 'Thiếu kết quả bắt buộc (lỗi truyền)', 'BLOCKED', 'Cl được chỉ định nhưng bản ghi ở trạng thái TRANSMISSION_ERROR. Không coi là bình thường, không điền 0; các kiểm tra phụ thuộc Cl (Na − Cl) hiển thị "không đánh giá được".') });
  // 10. Abnormal without required history
  s = S(10, 'M', 71);
  mk(s, 'CHEM_BASIC', T('08:50'), { K: 5.6 }, { truth: { requiresReview: true, details: 'Bất thường, không có lịch sử' },
    scenario: sc('KB5c', 'Bất thường nhưng thiếu lịch sử mà rule yêu cầu', 'MANUAL_REVIEW', 'Kali 5,6 mmol/L ở người bệnh lần đầu. Rule CHEM-H02 yêu cầu lịch sử với K bất thường → giữ lại, lý do: chưa đủ cơ sở.') });
  // 11. Critical value
  s = S(11, 'F', 74, { conditions: [{ code: 'CKD', label: CONDITION_LABELS.CKD, knownAt: '2023-05-01T00:00:00+07:00' }] });
  mk(s, 'CHEM_BASIC', '2026-10-02T08:00:00+07:00', { K: 5.8, CRE: 310, URE: 17.5 }); mk(s, 'CHEM_BASIC', '2026-11-02T08:00:00+07:00', { K: 6.0, CRE: 322, URE: 18.9 });
  mk(s, 'CHEM_BASIC', T('07:35'), { K: 6.6, CRE: 335, URE: 19.4 }, { truth: { criticalValue: true },
    scenario: sc('KB6', 'Giá trị tới hạn giả lập (K 6,6)', 'MANUAL_REVIEW', 'K 6,6 vượt ngưỡng tới hạn minh họa 6,2 → luồng ƯU TIÊN, phải ghi nhận đã thông báo lâm sàng. Lịch sử cho thấy xu hướng tăng dần; giá trị tới hạn không đồng nghĩa kết quả sai.') });
  // 12. EDTA pattern
  s = S(12, 'F', 49);
  mk(s, 'CHEM_EXT', '2026-10-20T08:00:00+07:00', { K: 4.1, CA: 2.34, MG: 0.84, ALP: 82 });
  mk(s, 'CHEM_EXT', T('09:20'), { K: 6.0, CA: 1.86, MG: 0.66, ALP: 49 }, { truth: { sampleError: 'edta', details: 'Kịch bản nhiễm EDTA dựng sẵn' },
    scenario: sc('KB7', 'Kiểu hình nghi nhiễm EDTA → dùng để thử phản hồi', 'MANUAL_REVIEW', 'K↑ Ca↓ Mg↓ ALP↓ so với lần trước. Rule nhất quán K–Ca và mô hình cùng giữ. Thử: chọn "Yêu cầu kiểm tra bổ sung" → "Lấy mẫu lại", ghi lý do; phản hồi được lưu, rule đang chạy KHÔNG đổi.') });
  // 13. Hemolysis
  s = S(13, 'M', 29);
  mk(s, 'CHEM_EXT', T('08:45'), { K: 5.4, AST: 51, ALT: 25 }, { hil: { H: 180, L: 12, I: 2 }, truth: { sampleError: 'hemolysis', details: 'H=180' },
    scenario: sc('KB4c', 'Cờ mẫu: tan máu (H-index)', 'BLOCKED', 'H=180 vượt giới hạn nhiễu minh họa của K (90) và AST (100) → BLOCKED cả phiếu (đơn vị ký là cả phiếu).') });
  // 14. Saline contamination (inpatient)
  s = S(14, 'M', 66, { events: [{ code: 'ADMISSION', label: 'Nhập viện nội khoa', at: '2026-11-14T15:00:00+07:00', knownAt: '2026-11-14T15:00:00+07:00' }] });
  mk(s, 'CHEM_EXT', '2026-11-15T05:30:00+07:00', { NA: 139, CL: 101, URE: 6.1, CRE: 96, K: 4.3, CA: 2.31, ALB: 38, GLU: 6.2 }, { ward: 'IPD', fasting: 'UNKNOWN', iv: 'YES' });
  mk(s, 'CHEM_EXT', T('05:40'), { NA: 145, CL: 118, URE: 4.4, CRE: 70, K: 3.2, CA: 1.75, MG: 0.63, ALB: 28, ALP: 55, AST: 16, ALT: 15, GLU: 4.6 }, { ward: 'IPD', fasting: 'UNKNOWN', iv: 'YES', truth: { sampleError: 'saline', details: 'Lẫn NaCl 0,9% ~27%' },
    scenario: sc('KB3c', 'Nghi mẫu lẫn dịch truyền NaCl 0,9%', 'MANUAL_REVIEW', 'Na − Cl = 27 thấp, các chỉ số khác giảm đồng loạt ~25% so với hôm qua, đang truyền dịch. Rule Na−Cl và mô hình (chỉ số pha loãng) cùng gợi ý; hệ thống chỉ nêu nghi ngờ.') });
  // 15. True change (hard negative)
  s = S(15, 'F', 69, { events: [{ code: 'ADMISSION', label: 'Nhập viện: theo dõi tổn thương thận cấp', at: '2026-11-14T10:00:00+07:00', knownAt: '2026-11-14T10:00:00+07:00' }] });
  mk(s, 'CHEM_BASIC', '2026-11-14T10:30:00+07:00', { CRE: 112, URE: 8.4, K: 4.6 }, { ward: 'ER', fasting: 'UNKNOWN', iv: 'UNKNOWN' });
  mk(s, 'CHEM_BASIC', '2026-11-15T05:30:00+07:00', { CRE: 168, URE: 11.6, K: 4.9 }, { ward: 'IPD', fasting: 'UNKNOWN', iv: 'YES' });
  mk(s, 'CHEM_BASIC', T('05:35'), { CRE: 236, URE: 15.8, K: 5.2 }, { ward: 'IPD', fasting: 'UNKNOWN', iv: 'YES', truth: { requiresReview: true, details: 'Thay đổi thật, mẫu đúng (ca âm tính khó)' },
    scenario: sc('KB3d', 'Thay đổi thật, mẫu đúng (ca âm tính khó)', 'MANUAL_REVIEW', 'Creatinine tăng liên tục 112 → 168 → 236 khi có bối cảnh nhập viện vì tổn thương thận. Delta check vẫn giữ — bối cảnh không tự cho qua. Người phụ trách có thể duyệt và ghi lý do; đây là dữ liệu quý để đánh giá tỷ lệ giữ không cần thiết.') });
  // 17. Stable chronic kidney disease: outside population AV limit, inside the patient's own interval
  s = S(17, 'M', 71, { conditions: [{ code: 'CKD', label: CONDITION_LABELS.CKD, knownAt: '2022-06-01T00:00:00+07:00' }] });
  mk(s, 'CHEM_BASIC', '2026-05-12T08:00:00+07:00', { CRE: 318, URE: 15.9, K: 4.9 }); mk(s, 'CHEM_BASIC', '2026-07-14T08:00:00+07:00', { CRE: 326, URE: 16.8, K: 5.0 });
  mk(s, 'CHEM_BASIC', '2026-09-10T08:00:00+07:00', { CRE: 312, URE: 16.2, K: 4.8 }); mk(s, 'CHEM_BASIC', '2026-10-21T08:00:00+07:00', { CRE: 322, URE: 16.5, K: 5.0 });
  mk(s, 'CHEM_BASIC', T('07:45'), { CRE: 329, URE: 16.9, K: 4.9 }, { truth: { requiresReview: false, details: 'Mẫu đúng, bệnh thận mạn ổn định' },
    scenario: sc('KB8', 'Bệnh thận mạn ổn định — ngưỡng chung vs ngưỡng cá nhân', 'MANUAL_REVIEW', 'Creatinine 329 µmol/L vượt giới hạn tự duyệt chung (300) nên bị giữ dù 4 lần trước đều 312–326. Chuyển "Ngưỡng cá nhân" sang "Siết + nới có điều kiện": 329 nằm trong khoảng cá nhân → đủ điều kiện tự duyệt. Bệnh nền chỉ hiển thị; ngưỡng cá nhân tính từ chính dữ liệu đo, không từ chẩn đoán.') });
  // 16. Missing HIL
  s = S(16, 'F', 41);
  mk(s, 'CHEM_EXT', T('09:00'), {}, { hil: null, truth: { dataIssue: 'hil_missing' },
    scenario: sc('KB5d', 'Thiếu chỉ số HIL bắt buộc', 'BLOCKED', 'Bản tin không có H/L/I. Trạng thái "chưa đủ thông tin" được biểu diễn rõ, không mặc định đạt.') });
  return out;
}

// ---------- run ----------
buildQc();
const { subjects, reports } = simulate();
const scen = scenarioReports();
if (new Set(subjects.map(x => x.token)).size !== subjects.length) throw new Error('Duplicate subject tokens');
const all = [...reports, ...scen].map(r => { delete r._t; return r; });
all.sort((a, b) => a.specimen.collectedAt.localeCompare(b.specimen.collectedAt));

const meta = {
  generatedAt: new Date().toISOString(), seed: SEED, subjects: N_SUBJECTS, today: TODAY,
  disclaimer: 'DỮ LIỆU GIẢ LẬP HOÀN TOÀN. Không chứa thông tin người bệnh thật. Tỷ lệ lỗi được làm giàu so với thực tế để huấn luyện; tham số minh họa.',
  rates: RATES, catalogVersion: catalog.version
};
const outDir = root + OUT_DIR;
mkdirSync(outDir, { recursive: true });
writeFileSync(outDir + 'dataset.json', JSON.stringify({ meta, subjects: subjects.map(s => ({ token: s.token, sex: s.sex, age: s.age, split: s.split })), reports: all, qcLog }));

// Long-format CSV (one row per result) for inspection / offline work.
const esc = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
const lines = ['report_id,subject_token,split,discipline,panel,ward,specimen_id,collected_at,test,status,value,unit,instrument,measured_at,flags,hil_h,hil_l,hil_i,truth_sample_error,truth_data_issue,truth_critical,truth_requires_review,reviewer_action'];
for (const r of all) for (const x of r.results) lines.push([r.reportId, r.subjectToken, r.split, r.discipline, r.panel, r.ward, r.specimen.specimenId, r.specimen.collectedAt, x.test, x.status, x.value, x.unit, x.instrument, x.measuredAt,
  [...x.flags, ...r.instrumentFlags.map(f => f.code)].join('|'), r.specimen.hil?.H, r.specimen.hil?.L, r.specimen.hil?.I, r.truth.sampleError, r.truth.dataIssue, r.truth.criticalValue, r.truth.requiresReview, r.reviewer?.action].map(esc).join(','));
writeFileSync(outDir + 'results_long.csv', lines.join('\n'));

const count = (pred) => all.filter(pred).length;
const bySplit = ['train', 'val', 'test', 'scenario'].map(sp => `${sp}=${count(r => r.split === sp)}`).join(' ');
const errTypes = {};
for (const r of all) if (r.truth.sampleError) errTypes[r.truth.sampleError] = (errTypes[r.truth.sampleError] ?? 0) + 1;
console.log(`Subjects: ${N_SUBJECTS} | Reports: ${all.length} (${bySplit}) | Results: ${lines.length - 1} | QC records: ${qcLog.length}`);
console.log('Sample errors (primary label):', errTypes);
console.log(`Today (${TODAY}) reports: ${count(r => r.specimen.collectedAt.startsWith(TODAY))}`);
