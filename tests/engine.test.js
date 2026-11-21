import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateReport, DECISIONS } from '../src/core/engine.js';
import { extractFeatures, coverage } from '../src/core/features.js';

const read = p => JSON.parse(readFileSync(new URL('../' + p, import.meta.url), 'utf8'));
const catalog = read('config/analytes.json');
const rulesets = { CHEM: read('config/rules.chem.json'), HEME: read('config/rules.heme.json') };
const AT = '2026-11-16T08:50:00+07:00';
const NORMAL = { GLU: 5.1, URE: 4.9, CRE: 82, NA: 140, K: 4.2, CL: 103, CA: 2.36, MG: 0.86, ALB: 43, ALP: 76, AST: 23, ALT: 22,
  WBC: 6.4, RBC: 4.85, HGB: 144, HCT: 0.432, MCV: 89.1, MCH: 29.7, MCHC: 333, RDW: 12.9, PLT: 248, NEU: 58.2, LYM: 30.5 };

function report(panel, values = {}, extra = {}) {
  const p = catalog.panels[panel];
  return {
    reportId: 'T-1', version: 1, subjectToken: 'SBJ-T', panel, discipline: p.discipline, ward: 'OPD', orderedTests: [...p.tests],
    specimen: { collectedAt: '2026-11-16T08:00:00+07:00', receivedAt: '2026-11-16T08:20:00+07:00', hil: p.discipline === 'CHEM' ? { H: 5, L: 10, I: 2 } : null },
    results: p.tests.map(t => ({ test: t, status: 'RESULTED', value: t in values ? values[t] : NORMAL[t], unit: catalog.analytes[t].unit, instrument: catalog.analytes[t].instrument, measuredAt: AT, flags: [] })),
    instrumentFlags: [], context: { age: 50, sex: 'M', conditions: [], medications: [], events: [] }, ...extra
  };
}
const qcPass = Object.entries(catalog.analytes).map(([t, a]) => ({ instrument: a.instrument, test: t, at: '2026-11-16T06:30:00+07:00', status: 'PASS' }));
const run = (r, env = {}) => evaluateReport(r, { catalog, rulesets, qcLog: qcPass, history: [], models: {}, ...env });
const check = (ev, code) => ev.checks.find(c => c.code === code);
const hist = (test, value, days = 10) => ({ test, value, unit: catalog.analytes[test].unit, measuredAt: new Date(Date.parse(AT) - days * 864e5).toISOString() });

test('clean complete report is eligible for auto-approval', () => {
  const ev = run(report('CHEM_EXT'));
  assert.equal(ev.decision, DECISIONS.AUTO);
  assert.equal(ev.signingUnit, 'Cả phiếu (không ký từng phần)');
  assert.equal(check(ev, 'CHEM-H01').status, 'NOT_APPLICABLE', 'no history → delta not applicable, not passed');
});

test('out of reference range alone does not block when inside auto-verification limits', () => {
  const ev = run(report('CHEM_BASIC', { GLU: 11.7 }), { history: [hist('GLU', 12.0, 40)] });
  assert.equal(ev.decision, DECISIONS.AUTO);
  assert.match(check(ev, 'CHEM-L02').message, /Ngoài khoảng tham chiếu: GLU/);
});

test('diagnosis in context never creates a pass by itself', () => {
  const ctx = { age: 60, sex: 'M', conditions: [{ code: 'DM', label: 'ĐTĐ', knownAt: '2024-01-01' }], medications: [], events: [] };
  const ev = run(report('CHEM_BASIC', { GLU: 18 }, { context: ctx }));
  assert.equal(ev.decision, DECISIONS.REVIEW, 'glucose outside AV limits stays in review despite diabetes');
});

test('missing result, missing unit and alternative unit are distinct blocking states', () => {
  const r = report('CHEM_BASIC');
  r.results.find(x => x.test === 'CL').status = 'TRANSMISSION_ERROR'; r.results.find(x => x.test === 'CL').value = null;
  r.results.find(x => x.test === 'CRE').unit = '';
  Object.assign(r.results.find(x => x.test === 'GLU'), { value: 104, unit: 'mg/dL' });
  const ev = run(r);
  assert.equal(ev.decision, DECISIONS.BLOCKED);
  assert.match(check(ev, 'CHEM-D01').message, /CL: Lỗi truyền dữ liệu/);
  assert.match(check(ev, 'CHEM-D02').message, /CRE: thiếu đơn vị/);
  assert.match(check(ev, 'CHEM-D02').message, /không tự quy đổi/);
  assert.equal(check(ev, 'CHEM-X02').status, 'NOT_APPLICABLE', 'Na−Cl not evaluated when Cl missing');
  const removed = report('CHEM_BASIC'); removed.results = removed.results.filter(x => x.test !== 'K');
  assert.match(check(run(removed), 'CHEM-D01').message, /K: Không nhận được bản ghi/);
});

test('QC: failing or missing QC blocks; QC after measurement does not count', () => {
  const failing = [...qcPass, { instrument: 'COBAS_ISE', test: 'K', at: '2026-11-16T08:30:00+07:00', status: 'FAIL' }];
  assert.equal(check(run(report('CHEM_BASIC'), { qcLog: failing }), 'CHEM-Q01').status, 'FAIL');
  const later = [...qcPass.filter(q => q.test !== 'K'), { instrument: 'COBAS_ISE', test: 'K', at: '2026-11-16T09:00:00+07:00', status: 'PASS' }];
  const ev = run(report('CHEM_BASIC'), { qcLog: later });
  assert.equal(check(ev, 'CHEM-Q01').status, 'NOT_EVALUABLE');
  assert.equal(ev.decision, DECISIONS.BLOCKED);
});

test('missing HIL is not treated as normal; high H blocks', () => {
  const r = report('CHEM_EXT'); r.specimen.hil = null;
  assert.equal(run(r).decision, DECISIONS.BLOCKED);
  const h = report('CHEM_EXT'); h.specimen.hil = { H: 180, L: 10, I: 2 };
  const ev = run(h);
  assert.equal(ev.decision, DECISIONS.BLOCKED);
  assert.deepEqual(check(ev, 'CHEM-S01').analytes.sort(), ['AST', 'K']);
});

test('delta check fires beyond RCV, glucose uses its wider override', () => {
  const ev = run(report('CHEM_EXT', { CRE: 158 }), { history: [hist('CRE', 71, 3)] });
  assert.equal(check(ev, 'CHEM-H01').status, 'FAIL');
  const g = run(report('CHEM_BASIC', { GLU: 6.1 }), { history: [hist('GLU', 7.5, 10)] });
  assert.equal(check(g, 'CHEM-H01').status, 'PASS', '−19% is inside glucose ±40%');
});

test('abnormal K without required history is held; with history it passes that rule', () => {
  assert.equal(check(run(report('CHEM_BASIC', { K: 5.6 })), 'CHEM-H02').status, 'FAIL');
  assert.equal(check(run(report('CHEM_BASIC', { K: 5.6 }), { history: [hist('K', 5.4, 30)] }), 'CHEM-H02').status, 'PASS');
  assert.equal(check(run(report('CHEM_BASIC')), 'CHEM-H02').status, 'NOT_APPLICABLE');
});

test('critical value → MANUAL_REVIEW with CRITICAL priority, not labelled as error', () => {
  const ev = run(report('CHEM_BASIC', { K: 6.6 }), { history: [hist('K', 6.1, 14)] });
  assert.equal(ev.decision, DECISIONS.REVIEW);
  assert.equal(ev.priority, 'CRITICAL');
  assert.equal(ev.criticalValue, true);
});

test('EDTA pattern: triggered, and not applicable when Ca not ordered', () => {
  assert.equal(check(run(report('CHEM_EXT', { K: 6.0, CA: 1.86 })), 'CHEM-X01').status, 'FAIL');
  assert.equal(check(run(report('CHEM_BASIC', { K: 6.0 })), 'CHEM-X01').status, 'NOT_APPLICABLE');
});

test('instrument flags: blocking vs review-only vs unknown flag', () => {
  assert.equal(run(report('CBC', { PLT: 61 }, { instrumentFlags: [{ code: 'PLT_CLUMPS' }] })).decision, DECISIONS.BLOCKED);
  assert.equal(run(report('CBC', {}, { instrumentFlags: [{ code: 'VARIANT_LYMPH' }] })).decision, DECISIONS.REVIEW);
  const unk = run(report('CBC', {}, { instrumentFlags: [{ code: 'SOMETHING_NEW' }] }));
  assert.equal(unk.decision, DECISIONS.REVIEW, 'unconfigured flags are never ignored');
});

// Stub tree models: one leaf, the margin is fixed by baseMargin. Keys are read FROM THE RULESET, so these tests
// always exercise the real model branch (regression: a renamed model key silently turned the safety test into rule-only).
const IV = rulesets.CHEM.rules.find(r => r.code === 'CHEM-M02').params.model;
const FV = rulesets.CHEM.rules.find(r => r.code === 'CHEM-M03').params.modelByPanel;
const stub = (key, margin, extra = {}) => ({ key, kind: 'tree_ensemble', name: 'stub', version: 't', features: ['hist_avail'], baseMargin: margin,
  trees: [[{ leaf: 0, v: 0 }]], threshold: 0.5, keyTests: ['NA', 'CL', 'GLU'], scope: 'all', ...extra });

test('model can escalate to review but can never lift a block or approve', () => {
  const always = stub(IV, 20), never = stub(IV, -20);
  const up = run(report('CHEM_EXT'), { models: { [IV]: always } });
  assert.equal(check(up, 'CHEM-M02').status, 'FAIL', 'the model branch really ran');
  assert.equal(up.decision, DECISIONS.REVIEW);
  const blocked = report('CHEM_EXT'); blocked.specimen.hil = null;
  assert.equal(run(blocked, { models: { [IV]: never } }).decision, DECISIONS.BLOCKED);
  const held = run(report('CHEM_BASIC', { K: 5.6 }), { models: { [IV]: never } });
  assert.equal(check(held, 'CHEM-M02').status, 'PASS');
  assert.equal(held.decision, DECISIONS.REVIEW, 'a low model score never releases a rule hold');
  assert.equal(run(report('CHEM_EXT'), { models: { [IV]: always }, settings: { modelEnabled: false } }).decision, DECISIONS.AUTO);
});

test('missing model file → rules only, said explicitly (no silent pass, no training at runtime)', () => {
  const ev = run(report('CHEM_EXT'), { models: {} });
  assert.equal(check(ev, 'CHEM-M02').status, 'NOT_APPLICABLE');
  assert.match(check(ev, 'CHEM-M02').message, /chỉ được đánh giá bằng rule/);
});

test('missing key inputs → NOT_EVALUABLE (never PASS), with data coverage shown', () => {
  const edtaLike = stub(IV, -20, { keyTests: ['K', 'CA'] });          // CHEM_BASIC has no Ca ordered
  const ev = run(report('CHEM_BASIC'), { models: { [IV]: edtaLike } });
  const c = check(ev, 'CHEM-M02');
  assert.equal(c.status, 'NOT_EVALUABLE');
  assert.match(c.message, /CA/);
  assert.match(c.message, /dùng 6\/12 chỉ số/);
  assert.match(c.message, /không chỉ định/);
  const m = ev.models.find(x => x.key === IV);
  assert.equal(m.status, 'NOT_EVALUABLE'); assert.equal(m.score, null); assert.equal(m.flagged, false);
});

test('first-visit model runs only without history ≤90 days; with history it is out of scope', () => {
  const fv = stub(FV.CHEM_EXT, 20, { scope: 'noHistory90d', keyTests: [] });
  const first = run(report('CHEM_EXT'), { models: { [FV.CHEM_EXT]: fv } });
  assert.equal(check(first, 'CHEM-M03').status, 'FAIL');
  assert.match(check(first, 'CHEM-M03').message, /chưa có lịch sử/);
  const prev = [{ test: 'K', value: 4.1, unit: 'mmol/L', measuredAt: '2026-11-10T08:00:00+07:00' }];
  const known = run(report('CHEM_EXT'), { models: { [FV.CHEM_EXT]: fv }, history: prev });
  assert.equal(check(known, 'CHEM-M03').status, 'NOT_APPLICABLE');
  assert.equal(known.decision, DECISIONS.AUTO);
  // panel without a configured first-visit model
  assert.equal(check(run(report('CHEM_BASIC'), { models: { [FV.CHEM_EXT]: fv } }), 'CHEM-M03').status, 'NOT_APPLICABLE');
});

test('first-visit policy: only ALWAYS_REVIEW runs; any other configured value still holds the report', () => {
  const h02 = rulesets.CHEM.rules.find(r => r.code === 'CHEM-H02');
  assert.equal(h02.params.firstVisitAbnormalPolicy, 'ALWAYS_REVIEW');
  const altered = { ...rulesets, CHEM: { ...rulesets.CHEM, rules: rulesets.CHEM.rules.map(r => r.code === 'CHEM-H02' ? { ...r, params: { ...r.params, firstVisitAbnormalPolicy: 'MODEL_FLAG_ONLY' } } : r) } };
  const ev = evaluateReport(report('CHEM_BASIC', { K: 5.6 }), { catalog, rulesets: altered, qcLog: qcPass, history: [], models: {} });
  assert.equal(ev.checks.find(c => c.code === 'CHEM-H02').status, 'FAIL');
  assert.equal(ev.decision, DECISIONS.REVIEW);
});

test('features never use history at or after the evaluated time', () => {
  const future = { test: 'K', value: 9, unit: 'mmol/L', measuredAt: '2026-11-17T08:00:00+07:00' };
  const f = extractFeatures(report('CHEM_BASIC'), [future], catalog);
  assert.equal(f.hist_avail, 0);
  assert.equal(f.d_K, null);
});

// ---- regressions from the Codex review (round 2) ----
test('result with missing instrument/time is not silently skipped by QC', () => {
  const r = report('CHEM_BASIC'); delete r.results.find(x => x.test === 'K').instrument;
  const ev = run(r);
  assert.equal(check(ev, 'CHEM-Q01').status, 'NOT_EVALUABLE');
  assert.equal(ev.decision, DECISIONS.BLOCKED);
});

test('unknown or NOT_APPLICABLE status on an ordered test blocks', () => {
  for (const status of ['UNKNOWN', 'NOT_APPLICABLE']) {
    const r = report('CHEM_BASIC'); Object.assign(r.results.find(x => x.test === 'K'), { status, value: null });
    assert.equal(run(r).decision, DECISIONS.BLOCKED, status);
  }
});

test('results outside the order block the report (critical ones are not hidden)', () => {
  const r = report('CHEM_BASIC'); r.orderedTests = ['NA', 'K', 'CL'];
  r.results = r.results.filter(x => ['NA', 'K', 'CL', 'GLU'].includes(x.test)); r.results.find(x => x.test === 'GLU').value = 30;
  const ev = run(r);
  assert.equal(ev.decision, DECISIONS.BLOCKED);
  assert.match(check(ev, 'CHEM-D01').message, /không thuộc chỉ định: GLU/);
});

test('invalid or inverted specimen times block', () => {
  const a = report('CHEM_BASIC'); a.specimen.collectedAt = 'invalid';
  assert.notEqual(run(a).decision, DECISIONS.AUTO);
  const b = report('CHEM_BASIC'); b.specimen.collectedAt = '2026-11-16T10:00:00+07:00';
  assert.equal(run(b).decision, DECISIONS.BLOCKED, 'measured before collection');
});

test('NaN or negative HIL is not evaluable → blocked', () => {
  for (const H of [NaN, -5]) { const r = report('CHEM_EXT'); r.specimen.hil = { H, L: 10, I: 2 }; assert.equal(run(r).decision, DECISIONS.BLOCKED); }
});

test('corrupted numeric strings are rejected, clean numeric strings accepted', () => {
  const bad = report('CHEM_BASIC'); bad.results.find(x => x.test === 'K').value = '4.2ERROR';
  assert.equal(run(bad).decision, DECISIONS.BLOCKED);
  const ok = report('CHEM_BASIC'); ok.results.find(x => x.test === 'K').value = '4.2';
  assert.equal(run(ok).decision, DECISIONS.AUTO);
});

test('per-analyte reference time: history measured after this analyte is never used', () => {
  const r = report('CHEM_BASIC');
  r.results.find(x => x.test === 'K').measuredAt = '2026-11-16T09:00:00+07:00';
  r.results.find(x => x.test === 'NA').measuredAt = '2026-11-16T12:00:00+07:00';
  r.specimen.collectedAt = '2026-11-16T08:00:00+07:00';
  const later = { test: 'K', value: 2.0, unit: 'mmol/L', measuredAt: '2026-11-16T10:00:00+07:00' };
  const ev = run(r, { history: [later] });
  assert.equal(check(ev, 'CHEM-H01').status, 'NOT_APPLICABLE');
  assert.equal(extractFeatures(r, [later], catalog).d_K, null);
});

// ---- personalized reference intervals ----
const stableCre = [318, 326, 312, 322].map((v, i) => hist('CRE', v, 180 - i * 40));
test('personal interval: OFF keeps population limits; ADAPT widens only inside the personal interval', () => {
  const r = report('CHEM_BASIC', { CRE: 329, URE: 16.9 });
  assert.equal(run(r, { history: stableCre }).decision, DECISIONS.REVIEW, 'OFF: CRE 329 > AV 300');
  const ad = run(r, { history: stableCre, settings: { personalMode: 'ADAPT' } });
  assert.equal(ad.decision, DECISIONS.AUTO);
  assert.match(check(ad, 'CHEM-L02').message, /ngưỡng cá nhân/);
  assert.equal(run(r, { history: stableCre, settings: { personalMode: 'TIGHTEN' } }).decision, DECISIONS.REVIEW, 'TIGHTEN never widens');
});

test('personal interval: TIGHTEN flags a value normal for the population but unusual for this patient', () => {
  // history older than the 90-day delta window: only the 365-day personal interval sees it
  const g = [12.1, 12.6, 11.8].map((v, i) => hist('GLU', v, 300 - i * 50));
  const ev = run(report('CHEM_BASIC', { GLU: 5.6 }), { history: g, settings: { personalMode: 'TIGHTEN' } });
  assert.equal(check(ev, 'CHEM-P01').status, 'FAIL');
  assert.equal(ev.decision, DECISIONS.REVIEW);
  assert.equal(run(report('CHEM_BASIC', { GLU: 5.6 }), { history: g }).decision, DECISIONS.AUTO, 'population thresholds + delta (90 days) alone pass it');
});

test('personal interval never widens past critical limits, nor for analytes outside the widen list', () => {
  const hiCre = [820, 830, 815].map((v, i) => hist('CRE', v, 90 - i * 30));
  const ev = run(report('CHEM_BASIC', { CRE: 825 }), { history: hiCre, settings: { personalMode: 'ADAPT' } });
  assert.equal(ev.criticalValue, true);
  assert.notEqual(ev.decision, DECISIONS.AUTO);
  const k = [5.9, 6.0, 5.95].map((v, i) => hist('K', v, 90 - i * 30));
  assert.equal(check(run(report('CHEM_BASIC', { K: 5.95 }), { history: k, settings: { personalMode: 'ADAPT' } }), 'CHEM-L02').status, 'FAIL', 'K is never widened');
});

test('personal interval not used with too little/unstable history or a recent admission', () => {
  const two = stableCre.slice(0, 2);
  assert.equal(check(run(report('CHEM_BASIC', { CRE: 329 }), { history: two, settings: { personalMode: 'ADAPT' } }), 'CHEM-P01').status, 'NOT_APPLICABLE');
  const ctx = { age: 70, sex: 'M', conditions: [], medications: [], events: [{ code: 'ADMISSION', label: 'Nhập viện', at: '2026-11-10T08:00:00+07:00', knownAt: '2026-11-10T08:00:00+07:00' }] };
  const ev = run(report('CHEM_BASIC', { CRE: 329 }, { context: ctx }), { history: stableCre, settings: { personalMode: 'ADAPT' } });
  assert.equal(ev.decision, DECISIONS.REVIEW);
  assert.match(check(ev, 'CHEM-P01').message, /Nhập viện/);
});

test('a diagnosis alone never changes the personal interval', () => {
  const withDx = { age: 70, sex: 'M', conditions: [{ code: 'CKD', label: 'Bệnh thận mạn', knownAt: '2020-01-01' }], medications: [], events: [] };
  const a = run(report('CHEM_BASIC', { CRE: 329 }), { history: [], settings: { personalMode: 'ADAPT' } });
  const b = run(report('CHEM_BASIC', { CRE: 329 }, { context: withDx }), { history: [], settings: { personalMode: 'ADAPT' } });
  assert.equal(a.decision, b.decision);
  assert.equal(b.decision, DECISIONS.REVIEW);
});

test('WBIT models are back (user decision): escalate-only, history-scoped, delta check kept', () => {
  for (const [rs, code, key] of [[rulesets.CHEM, 'CHEM-M01', 'chem_wbit'], [rulesets.HEME, 'HEME-M01', 'heme_wbit']]) {
    const r = rs.rules.find(x => x.code === code);
    assert.equal(r.params.model, key); assert.equal(r.onFail, 'REVIEW');
    assert.ok(rs.rules.some(x => x.type === 'delta_check'), 'delta check kept');
  }
  const W = 'chem_wbit';
  const always = stub(W, 20, { scope: 'history', keyTests: [] });
  const noHist = run(report('CHEM_EXT'), { models: { [W]: always } });
  assert.equal(check(noHist, 'CHEM-M01').status, 'NOT_APPLICABLE');            // no history → not applied, not a pass
  assert.match(check(noHist, 'CHEM-M01').message, /Không có lịch sử/);
  assert.equal(noHist.decision, DECISIONS.AUTO);
  const prev = [{ test: 'K', value: 4.2, unit: 'mmol/L', measuredAt: '2026-11-10T08:00:00+07:00' }];
  const withHist = run(report('CHEM_EXT'), { models: { [W]: always }, history: prev });
  assert.equal(check(withHist, 'CHEM-M01').status, 'FAIL');
  assert.equal(withHist.decision, DECISIONS.REVIEW);
});

test('a result of 0 is a real value: finite features, never treated as missing', () => {
  const f = extractFeatures(report('CBC', { NEU: 0, LYM: 0, PLT: 0 }), [], catalog);
  for (const k of ['z_NEU', 'z_LYM', 'z_PLT']) assert.ok(Number.isFinite(f[k]), k);
  assert.equal(f.m_NEU, 1);
  const c = extractFeatures(report('CHEM_EXT', { CA: 0, ALT: 0 }), [], catalog);
  assert.ok(Number.isFinite(c.z_CA) && Number.isFinite(c.z_ALT));
  assert.ok(Number.isFinite(c.k_minus_ca));
});

test('delta from a previous 0 (and to 0) stays finite in features and in the delta rule', () => {
  const prev = [{ test: 'NEU', value: 0, unit: '%', measuredAt: '2026-11-10T08:00:00+07:00' }, { test: 'PLT', value: 0, unit: 'G/L', measuredAt: '2026-11-10T08:00:00+07:00' }];
  const f = extractFeatures(report('CBC'), prev, catalog);
  assert.ok(Number.isFinite(f.d_NEU) && Number.isFinite(f.d_PLT));
  const ev = run(report('CBC'), { history: prev });
  const h = ev.checks.find(c => c.type === 'delta_check');
  assert.equal(h.status, 'FAIL');
  assert.ok(!/Infinity|NaN/.test(h.message), h.message);
  // 0 → 0: no change (feature delta exactly 0, rule passes)
  assert.equal(extractFeatures(report('CBC', { PLT: 0 }), [prev[1]], catalog).d_PLT, 0);
  assert.equal(run(report('CBC', { PLT: 0 }), { history: [prev[1]] }).checks.find(c => c.type === 'delta_check').status, 'PASS');
  // positive → 0 (Codex round 2): current 0 is used, delta is finite and negative, the rule flags it
  const prevPos = [{ test: 'PLT', value: 248, unit: 'G/L', measuredAt: '2026-11-10T08:00:00+07:00' }];
  const toZero = extractFeatures(report('CBC', { PLT: 0 }), prevPos, catalog);
  assert.ok(Number.isFinite(toZero.d_PLT) && toZero.d_PLT < 0, String(toZero.d_PLT));
  const evZero = run(report('CBC', { PLT: 0 }), { history: prevPos }).checks.find(c => c.type === 'delta_check');
  assert.equal(evZero.status, 'FAIL');
  assert.ok(evZero.analytes.includes('PLT') && !/Infinity|NaN/.test(evZero.message), evZero.message);
});

test('missing data is never imputed: not-ordered analytes and absent history give null + flags', () => {
  const f = extractFeatures(report('CHEM_BASIC'), [], catalog);
  assert.equal(f.z_CA, null); assert.equal(f.m_CA, 0); assert.equal(f.m_K, 1);
  assert.equal(f.k_minus_ca, null);
  assert.equal(f.hist_avail, 0);
  for (const k of ['n_deltas', 'delta_ms', 'delta_max_abs', 'log_days_since_prev', 'd_K']) assert.equal(f[k], null, k);
  const noAge = report('CHEM_BASIC'); noAge.context = { ...noAge.context, age: undefined };
  assert.equal(extractFeatures(noAge, [], catalog).age_dec, null);
});

test('coverage distinguishes not-ordered (type B) from ordered-without-result (type A)', () => {
  const tests = ['K', 'CA', 'NA'];
  const r = report('CHEM_BASIC', { K: null }, {});
  r.results.find(x => x.test === 'K').status = 'PENDING';
  const c = coverage(r, tests);
  assert.equal(c.used, 1); assert.equal(c.total, 3);
  assert.deepEqual(c.missing, [{ test: 'K', reason: 'NO_RESULT' }, { test: 'CA', reason: 'NOT_ORDERED' }]);
});

test('a value in the wrong unit never reaches the model as if it were in the configured unit', () => {
  const r = report('CHEM_BASIC', { GLU: 104 });
  r.results.find(x => x.test === 'GLU').unit = 'mg/dL';
  const f = extractFeatures(r, [], catalog);
  assert.equal(f.z_GLU, null); assert.equal(f.m_GLU, 0);
  assert.deepEqual(coverage(r, ['GLU', 'NA'], catalog).missing, [{ test: 'GLU', reason: 'NO_RESULT' }]);
  const ev = run(r, { models: { [IV]: stub(IV, 20) } });
  assert.equal(check(ev, 'CHEM-M02').status, 'NOT_EVALUABLE');   // glucose is a key input of the IV-fluid model
  assert.equal(ev.decision, DECISIONS.BLOCKED);                    // the unit rule still blocks
});

test('a model that cannot evaluate (key input missing) holds the report — the final decision, not just the status', () => {
  const edtaLike = stub(IV, -20, { keyTests: ['K', 'CA'] });
  const ev = run(report('CHEM_BASIC'), { models: { [IV]: edtaLike } });
  assert.equal(check(ev, 'CHEM-M02').status, 'NOT_EVALUABLE');
  assert.equal(ev.decision, DECISIONS.REVIEW);   // Codex r3: previously IGNORE → AUTO_APPROVE_ELIGIBLE
});

test('evaluation report is flagged stale when models/rules differ from what it was computed with', async () => {
  const { stackFingerprint } = await import('../src/core/load-models.js');
  const a = stackFingerprint({ x: { threshold: 0.5 } }, rulesets, catalog);
  assert.notEqual(a, stackFingerprint({ x: { threshold: 0.6 } }, rulesets, catalog));
  assert.notEqual(a, stackFingerprint({}, rulesets, catalog));
  assert.equal(a, stackFingerprint({ x: { threshold: 0.5 } }, rulesets, catalog));
});
