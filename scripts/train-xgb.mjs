// Paper-informed XGBoost experiments for CBC WBIT and chemistry errors.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractFeatures, MODEL_TESTS } from '../src/core/features.js';
import { scoreFeatures } from '../src/core/model.js';
import { buildHistoryIndex, historyFor } from '../src/core/history.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = p => JSON.parse(readFileSync(root + p, 'utf8'));
const ds = read('data/synthetic/dataset.json'), catalog = read('config/analytes.json');
const index = buildHistoryIndex(ds.reports);
const historyFeatures = new Set(['hist_avail', 'n_deltas', 'delta_ms', 'delta_max_abs', 'log_days_since_prev', 'acute_setting', 'recent_transfusion']);
const tasks = [
  { key: 'heme_wbit_xgb', baseline: 'heme_wbit', discipline: 'HEME', name: 'WBIT — CBC', targets: ['wbit'], recallTarget: 0.8, scope: 'CBC với lịch sử ≤90 ngày', requiresHistory: true, paper: 'Graham et al. 2025, Clinical Chemistry, doi:10.1093/clinchem/hvae210', keep: f => f.startsWith('d_') || f.startsWith('ad_') || historyFeatures.has(f) },
  { key: 'chem_wbit_xgb', baseline: 'chem_wbit', discipline: 'CHEM', name: 'WBIT — hóa sinh', targets: ['wbit'], recallTarget: 0.8, scope: 'Hóa sinh với lịch sử ≤90 ngày', requiresHistory: true, paper: 'Tortosa-Carreres et al. 2026, CCLM, doi:10.1515/cclm-2025-0564', keep: f => f.startsWith('ad_') || historyFeatures.has(f) },
  { key: 'chem_contam_xgb', baseline: 'chem_contam', discipline: 'CHEM', name: 'Nhiễm mẫu — EDTA / dịch truyền', targets: ['edta', 'saline', 'd5w'], recallTarget: 0.9, scope: 'Hóa sinh có dữ liệu hợp lệ', requiresHistory: false, paper: 'Farrell et al. 2026, Ann Clin Biochem, doi:10.1177/00045632261488751; Spies et al. 2025, Clinical Chemistry, doi:10.1093/clinchem/hvae168', keep: f => !f.startsWith('ad_') },
];
const examples = [];
for (const report of ds.reports) {
  if (report.split === 'scenario') continue;
  const history = historyFor(index, report, catalog);
  examples.push({ report, history, values: extractFeatures(report, history, catalog) });
}

function confusion(xs, score, threshold) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const x of xs) {
    const y = x.task.targets.includes(x.report.truth.sampleError) ? 1 : 0;
    const pred = score(x) >= threshold;
    if (pred && y) tp++; else if (pred) fp++; else if (y) fn++; else tn++;
  }
  return { tp, fp, fn, tn, sensitivity: tp / (tp + fn), specificity: tn / (tn + fp) };
}
const python = root + '.venv/Scripts/python.exe', trainer = root + 'scripts/train-xgb.py';
const summaries = {};
for (const task of tasks) {
  const eligible = x => x.report.discipline === task.discipline && !x.report.truth.dataIssue && (!task.requiresHistory || x.values.hist_avail);
  const subset = examples.filter(eligible);
  if (!subset.length) throw new Error(`No eligible rows for ${task.key}`);
  const features = Object.keys(subset[0].values).filter(task.keep);
  task.targets = task.targets;
  const payload = JSON.stringify({ ...task, features, rows: subset.map(x => ({ split: x.report.split, label: task.targets.includes(x.report.truth.sampleError) ? 1 : 0, values: features.map(f => x.values[f] ?? null) })) });
  const model = JSON.parse(execFileSync(python, [trainer], { input: payload, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }));
  // Model names/scopes contain Vietnamese; restore from Node's UTF-8 task definition
  // to avoid Windows Python stdin code-page corruption.
  model.name = task.name;
  model.scope = task.scope;
  model.paperBasis = task.paper;
  writeFileSync(root + `models/${task.key}.json`, JSON.stringify(model, null, 1));
  const baseline = read(`models/${task.baseline}.json`);
  const test = subset.filter(x => x.report.split === 'test').map(x => ({ ...x, task }));
  summaries[task.key] = {
    name: task.name, discipline: task.discipline, paper: task.paper,
    scope: 'Same synthetic test reports and 80% (or 90% for contamination) validation recall target for thresholds.',
    logisticRegression: { threshold: baseline.threshold, ...confusion(test, x => scoreFeatures(x.values, baseline).score, baseline.threshold) },
    xgboost: { threshold: model.threshold, ...model.syntheticTest },
    train: model.trainedOn,
  };
  console.log(`${task.key}: train=${model.trainedOn.train} (${model.trainedOn.positives}+), test sensitivity ${(model.syntheticTest.sensitivity * 100).toFixed(1)}%, specificity ${(model.syntheticTest.specificity * 100).toFixed(1)}%`);
}
writeFileSync(root + 'reports/xgb_comparison.json', JSON.stringify({ generatedAt: new Date().toISOString(), disclaimer: 'Synthetic benchmark only; no clinical validation.', tasks: summaries }, null, 1));
console.log('Saved XGBoost detectors and reports/xgb_comparison.json.');
