// Dev helper: which rules hold CLEAN test reports, and do pinned scenarios behave as expected?
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateReport } from '../src/core/engine.js';
import { buildHistoryIndex, historyFor } from '../src/core/history.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const R = p => JSON.parse(readFileSync(root + p, 'utf8'));
const catalog = R('config/analytes.json'), rulesets = { CHEM: R('config/rules.chem.json'), HEME: R('config/rules.heme.json') };
const ds = R('data/synthetic/dataset.json');
const models = Object.fromEntries(['chem_wbit', 'chem_contam', 'heme_wbit', 'chem_wbit_xgb', 'chem_contam_xgb', 'heme_wbit_xgb'].filter(k => existsSync(root + `models/${k}.json`)).map(k => [k, R(`models/${k}.json`)]));
const idx = buildHistoryIndex(ds.reports);
const cnt = {}, tests = {};
let n = 0;
for (const r of ds.reports) {
  if (r.split !== 'test' || r.truth.requiresReview) continue;
  const e = evaluateReport(r, { catalog, rulesets, qcLog: ds.qcLog, history: historyFor(idx, r, catalog), settings: { modelEnabled: false } });
  n++;
  for (const c of e.checks) if (c.action) {
    const k = `${r.discipline} ${c.code} ${c.status}`; cnt[k] = (cnt[k] ?? 0) + 1;
    for (const a of c.analytes) { const kk = `${c.code}:${a}`; tests[kk] = (tests[kk] ?? 0) + 1; }
  }
}
console.log('clean test reports:', n, cnt);
console.log(Object.entries(tests).sort((a, b) => b[1] - a[1]).slice(0, 25));
let bad = 0;
for (const r of ds.reports.filter(r => r.scenario)) {
  const e = evaluateReport(r, { catalog, rulesets, qcLog: ds.qcLog, history: historyFor(idx, r, catalog), models });
  const adapt = evaluateReport(r, { catalog, rulesets, qcLog: ds.qcLog, history: historyFor(idx, r, catalog), models, settings: { personalMode: "ADAPT" } });
  const ok = e.decision === r.scenario.expect; if (!ok) bad++;
  console.log(r.scenario.code.padEnd(5), r.scenario.expect.padEnd(22), e.decision.padEnd(22), ok ? 'OK' : 'XX',
    e.checks.filter(c => c.action).map(c => c.code).join(','),
    e.models.map(m => `${m.key}=${m.inScope ? m.score.toFixed(3) : "n/a"}`).join(' '),
    '| ADAPT →', adapt.decision, adapt.checks.filter(c => c.action).map(c => c.code).join(','));
}
process.exitCode = bad ? 1 : 0;
