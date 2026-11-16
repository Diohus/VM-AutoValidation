import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateReport, DECISIONS } from '../src/core/engine.js';
import { extractFeatures } from '../src/core/features.js';
import { trainLogReg, scoreFeatures } from '../src/core/model.js';

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

test('model can escalate to review but can never lift a block or approve', () => {
  const always = { key: 'chem_contam', name: 'test', version: 't', features: ['hist_avail'], mean: [0], sd: [1], weights: [0], bias: 20, threshold: 0.5 };
  const never = { ...always, bias: -20 };
  assert.equal(run(report('CHEM_EXT'), { models: { chem_contam: always } }).decision, DECISIONS.REVIEW);
  const blocked = report('CHEM_EXT'); blocked.specimen.hil = null;
  assert.equal(run(blocked, { models: { chem_contam: never } }).decision, DECISIONS.BLOCKED);
  assert.equal(run(report('CHEM_BASIC', { K: 5.6 }), { models: { chem_contam: never } }).decision, DECISIONS.REVIEW);
  assert.equal(run(report('CHEM_EXT'), { models: { chem_contam: always }, settings: { modelEnabled: false } }).decision, DECISIONS.AUTO);
});

test('history-scoped model is not applied without history', () => {
  const m = { key: 'chem_wbit', name: 'w', version: 't', requiresHistory: true, features: ['hist_avail'], mean: [0], sd: [1], weights: [0], bias: 20, threshold: 0.5 };
  const ev = run(report('CHEM_EXT'), { models: { chem_wbit: m } });
  assert.equal(check(ev, 'CHEM-M01').status, 'NOT_APPLICABLE');
  assert.equal(ev.decision, DECISIONS.AUTO);
});

test('features never use history at or after the evaluated time', () => {
  const future = { test: 'K', value: 9, unit: 'mmol/L', measuredAt: '2026-11-17T08:00:00+07:00' };
  const f = extractFeatures(report('CHEM_BASIC'), [future], catalog);
  assert.equal(f.hist_avail, 0);
  assert.equal(f.d_K, null);
});

test('logistic regression learns a separable toy problem', () => {
  const rows = [], y = [];
  for (let i = 0; i < 400; i++) { const v = (i % 2) ? 2 + (i % 7) / 10 : -2 - (i % 5) / 10; rows.push({ a: v, b: i % 3 }); y.push(i % 2); }
  const m = trainLogReg(rows, y, ['a', 'b'], { epochs: 200 });
  assert.ok(scoreFeatures({ a: 2.5, b: 1 }, m).score > 0.9);
  assert.ok(scoreFeatures({ a: -2.5, b: 1 }, m).score < 0.1);
  assert.ok(scoreFeatures({ a: null, b: 1 }, m).score > 0.05, 'missing value is mean-imputed, not zero-in-raw-space');
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
