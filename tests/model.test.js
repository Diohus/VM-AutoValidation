// JS inference must reproduce the Python libraries (LightGBM, XGBoost, scikit-learn KNN) on synthetic reports,
// and every score must come with a per-report explanation. Fixture: tests/fixtures/model-parity.json (ml/train_runtime.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreTrees, scoreKnn, nextNode, scoreReport } from '../src/core/model.js';

const read = p => JSON.parse(readFileSync(new URL('../' + p, import.meta.url), 'utf8'));
const fx = read('tests/fixtures/model-parity.json').models;
const close = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

test('LightGBM (chem_ivfluid): JS margin equals the library on ≥250 synthetic reports', () => {
  const model = read(fx.chem_ivfluid.file);
  assert.ok(fx.chem_ivfluid.rows.length >= 250);
  let withNull = 0;
  for (const r of fx.chem_ivfluid.rows) {
    if (Object.values(r.features).some(v => v == null)) withNull++;
    const out = scoreTrees(r.features, model);
    assert.ok(close(out.margin, r.margin, 1e-9), `${out.margin} vs ${r.margin}`);
  }
  assert.ok(withNull > 0, 'fixture must include reports with missing features (no history / not ordered)');
});

test('XGBoost float32 comparison path equals the library', () => {
  const { model, rows } = fx.xgboost_parity_only;
  for (const r of rows) assert.ok(close(scoreTrees(r.features, model).margin, r.margin, 1e-5), String(r.margin));
});

test('XGBoost split compares in float32: a value equal to the threshold only after float32 rounding goes right', () => {
  const t = Math.fround(0.1); // 0.100000001490116...
  const node = { op: '<', t, l: 1, r: 2, miss: 1 };
  assert.equal(nextNode(node, 0.1), 2);        // fround(0.1) === t → not "<" → right (double 0.1 < t would wrongly go left)
  assert.equal(nextNode(node, 0.09), 1);
  assert.equal(nextNode(node, null), 1);       // missing → learned default branch
});

test('LightGBM missing types: NaN default branch, Zero treats 0 as missing, None treats NaN as 0', () => {
  assert.equal(nextNode({ op: '<=', t: 1, mt: 'nan', dl: false, l: 1, r: 2 }, null), 2);
  assert.equal(nextNode({ op: '<=', t: 1, mt: 'nan', dl: false, l: 1, r: 2 }, 0), 1);
  assert.equal(nextNode({ op: '<=', t: 1, mt: 'zero', dl: false, l: 1, r: 2 }, 0), 2);
  assert.equal(nextNode({ op: '<=', t: -1, mt: 'none', dl: true, l: 1, r: 2 }, null), 2); // NaN → 0 > -1 → right
});

test('every tree score has an exact per-report explanation (bias + Σ contributions = margin)', () => {
  const model = read(fx.chem_ivfluid.file);
  for (const r of fx.chem_ivfluid.rows.slice(0, 60)) {
    const out = scoreTrees(r.features, model);
    const sum = out.contributions.reduce((a, c) => a + c.contribution, out.bias);
    assert.ok(close(sum, out.margin, 1e-9), `${sum} vs ${out.margin}`);
    assert.equal(out.contributions.length, model.features.length);
  }
});

test('first-visit KNN (3 panels): JS score equals scikit-learn, with an analyte-level explanation', () => {
  for (const key of ['fv_chem_basic', 'fv_chem_ext', 'fv_cbc']) {
    const model = read(fx[key].file);
    for (const r of fx[key].rows) {
      const out = scoreKnn(r.features, model);
      assert.ok(close(out.score, r.score, 1e-9), `${key}: ${out.score} vs ${r.score}`);
      assert.equal(out.contributions.length, model.inputs.length);
    }
  }
});

// ---- regressions from Codex round 3 ----
test('Saabas node values are true expectations: count/cover-weighted mean of the children, at every internal node', () => {
  const lgb = read(fx.chem_ivfluid.file), xgbm = fx.xgboost_parity_only.model;
  for (const model of [lgb, xgbm]) {
    let checked = 0;
    for (const tree of model.trees) for (const n of tree) {
      if (n.leaf !== undefined) continue;
      const L = tree[n.l], R = tree[n.r];
      assert.ok(close(n.v, (L.c * L.v + R.c * R.v) / (L.c + R.c), 1e-9), `${model.source}: ${n.v}`);
      checked++;
    }
    assert.ok(checked > 50);
  }
});

test('XGBoost per-feature contributions equal the library\'s own Saabas (approx_contribs), one by one', () => {
  const { model, rows } = fx.xgboost_parity_only;
  for (const r of rows.slice(0, 120)) {
    const out = scoreTrees(r.features, model);
    assert.ok(close(out.bias, r.bias, 1e-4), `bias ${out.bias} vs ${r.bias}`);
    out.contributions.forEach((c, j) => assert.ok(Math.abs(c.contribution - r.contribs[j]) < 1e-4, `${c.feature}: ${c.contribution} vs ${r.contribs[j]}`));
  }
});

test('KNN explanation cannot cancel out: symmetric neighbours still explain the score, and Σ contributions = score', () => {
  const model = { inputs: ['z_A'], mean: [0], scale: [1], k: 2, ref: [-10, 10], threshold: 1 };
  const out = scoreKnn({ z_A: 0 }, model);
  assert.equal(out.score, 10);
  assert.ok(close(out.contributions[0].contribution, 10, 1e-12));
  const real = read(fx.fv_chem_ext.file);
  for (const r of fx.fv_chem_ext.rows.slice(0, 30)) {
    const o = scoreKnn(r.features, real);
    assert.ok(close(o.contributions.reduce((a, c) => a + c.contribution, 0), o.score, 1e-9));
  }
});

test('every scored report gets an explanation, even when all contributions lower the score', () => {
  const model = { kind: 'tree_ensemble', key: 'neg', version: 't', features: ['m_K'], baseMargin: 0, threshold: 0.5, keyTests: [], scope: 'all',
    trees: [[{ f: 0, t: 0.5, op: '<=', mt: 'nan', dl: true, l: 1, r: 2, v: 0, c: 2 }, { leaf: 1, v: 1, c: 1 }, { leaf: -1, v: -1, c: 1 }]] };
  const catalog = read('config/analytes.json');
  const rep = { discipline: 'CHEM', panel: 'CHEM_BASIC', orderedTests: ['K'], context: { sex: 'M', age: 50 },
    results: [{ test: 'K', status: 'RESULTED', value: 4.2, unit: 'mmol/L', measuredAt: '2026-11-16T08:00:00+07:00' }] };
  const res = scoreReport(rep, [], catalog, model);
  assert.equal(res.status, 'SCORED');
  assert.ok(res.top.length >= 1);
  assert.equal(res.top[0].direction, 'DOWN');
});
