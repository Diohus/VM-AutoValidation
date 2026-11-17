// JS inference must reproduce the Python libraries (XGBoost / LightGBM, scikit-learn KNN) on synthetic reports,
// and every score must come with a per-report explanation. Fixture: tests/fixtures/model-parity.json (ml/train_runtime.py),
// generated for exactly the models deployed in models/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { scoreTrees, scoreKnn, nextNode, scoreReport } from '../src/core/model.js';

const read = p => JSON.parse(readFileSync(new URL('../' + p, import.meta.url), 'utf8'));
const fx = read('tests/fixtures/model-parity.json').models;
const close = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const treeKeys = Object.keys(fx).filter(k => fx[k].file && read(fx[k].file).kind === 'tree_ensemble');
const knnKeys = Object.keys(fx).filter(k => fx[k].file && read(fx[k].file).kind === 'knn_anomaly');

test('fixture covers every deployed model', () => {
  const deployed = readdirSync(new URL('../models', import.meta.url)).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort();
  assert.deepEqual([...treeKeys, ...knnKeys].sort(), deployed);
  assert.ok(treeKeys.length >= 1 && knnKeys.length === 3);
});

test('tree models: JS margin equals the library on synthetic reports (incl. missing features)', () => {
  let withNull = 0;
  for (const key of treeKeys) {
    const model = read(fx[key].file);
    const tol = model.source === 'xgboost' ? 1e-5 : 1e-9; // XGBoost sums float32 leaves
    assert.ok(fx[key].rows.length >= 100, key);
    for (const r of fx[key].rows) {
      if (Object.values(r.features).some(v => v == null)) withNull++;
      const out = scoreTrees(r.features, model);
      assert.ok(close(out.margin, r.margin, tol), `${key}: ${out.margin} vs ${r.margin}`);
    }
  }
  // The missing-value branch must be exercised (CBC with history has no missing inputs; chemistry panels do).
  assert.ok(withNull > 0, 'fixture must include reports with missing features');
});

test('XGBoost per-feature contributions equal the library\'s own Saabas (approx_contribs), one by one', () => {
  let n = 0;
  for (const key of treeKeys.filter(k => fx[k].source === 'xgboost')) {
    const model = read(fx[key].file);
    for (const r of fx[key].rows.slice(0, 120)) {
      const out = scoreTrees(r.features, model);
      assert.ok(close(out.bias, r.bias, 1e-4), `${key} bias ${out.bias} vs ${r.bias}`);
      out.contributions.forEach((c, j) => assert.ok(Math.abs(c.contribution - r.contribs[j]) < 1e-4, `${key} ${c.feature}: ${c.contribution} vs ${r.contribs[j]}`));
      n++;
    }
  }
  assert.ok(n > 0, 'at least one XGBoost model is deployed');
});

test('XGBoost split compares in float32: a value equal to the threshold only after float32 rounding goes right', () => {
  const t = Math.fround(0.1); // 0.100000001490116...
  const node = { op: '<', t, l: 1, r: 2, miss: 1 };
  assert.equal(nextNode(node, 0.1), 2);        // fround(0.1) === t → not "<" → right (double 0.1 < t would wrongly go left)
  assert.equal(nextNode(node, 0.09), 1);
  assert.equal(nextNode(node, null), 1);       // missing → learned default branch
});

test('every tree score has an exact explanation, and node values are true expectations (Saabas)', () => {
  for (const key of treeKeys) {
    const model = read(fx[key].file);
    for (const r of fx[key].rows.slice(0, 40)) {
      const out = scoreTrees(r.features, model);
      assert.ok(close(out.contributions.reduce((a, c) => a + c.contribution, out.bias), out.margin, 1e-9));
    }
    for (const tree of model.trees) for (const nd of tree) {
      if (nd.leaf !== undefined) continue;
      const L = tree[nd.l], R = tree[nd.r];
      assert.ok(close(nd.v, (L.c * L.v + R.c * R.v) / (L.c + R.c), 1e-9), `${key}: node value is not the cover/count-weighted mean`);
    }
  }
});

test('first-visit KNN (3 panels): JS score equals scikit-learn, with an analyte-level explanation', () => {
  for (const key of knnKeys) {
    const model = read(fx[key].file);
    for (const r of fx[key].rows) {
      const out = scoreKnn(r.features, model);
      assert.ok(close(out.score, r.score, 1e-9), `${key}: ${out.score} vs ${r.score}`);
      assert.ok(close(out.contributions.reduce((a, c) => a + c.contribution, 0), out.score, 1e-9));
    }
  }
});

test('KNN explanation cannot cancel out: symmetric neighbours still explain the score', () => {
  const model = { inputs: ['z_A'], mean: [0], scale: [1], k: 2, ref: [-10, 10], threshold: 1 };
  const out = scoreKnn({ z_A: 0 }, model);
  assert.equal(out.score, 10);
  assert.ok(close(out.contributions[0].contribution, 10, 1e-12));
});

test('every scored report gets an explanation, even when all contributions lower the score', () => {
  const model = { kind: 'tree_ensemble', key: 'neg', version: 't', features: ['m_K'], baseMargin: 0, threshold: 0.5, keyTests: [], scope: 'all',
    trees: [[{ f: 0, t: 0.5, op: '<', miss: 1, l: 1, r: 2, v: 0, c: 2 }, { leaf: 1, v: 1, c: 1 }, { leaf: -1, v: -1, c: 1 }]] };
  const catalog = read('config/analytes.json');
  const rep = { discipline: 'CHEM', panel: 'CHEM_BASIC', orderedTests: ['K'], context: { sex: 'M', age: 50 },
    results: [{ test: 'K', status: 'RESULTED', value: 4.2, unit: 'mmol/L', measuredAt: '2026-11-16T08:00:00+07:00' }] };
  const res = scoreReport(rep, [], catalog, model);
  assert.equal(res.status, 'SCORED');
  assert.ok(res.top.length >= 1);
  assert.equal(res.top[0].direction, 'DOWN');
});

test('rules and deployed models match exactly (no model without a rule, no rule pointing at a missing model)', () => {
  const referenced = new Set();
  for (const f of ['config/rules.chem.json', 'config/rules.heme.json'])
    for (const r of read(f).rules.filter(x => x.type === 'model_score'))
      for (const k of r.params.modelByPanel ? Object.values(r.params.modelByPanel) : [r.params.model]) referenced.add(k);
  const deployed = readdirSync(new URL('../models', import.meta.url)).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  assert.deepEqual([...referenced].sort(), deployed.sort());
});
