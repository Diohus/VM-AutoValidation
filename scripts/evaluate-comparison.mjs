// Compare rule-only, legacy logistic, and active XGBoost stacks on the same synthetic test reports.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateReport, DECISIONS } from '../src/core/engine.js';
import { buildHistoryIndex, historyFor } from '../src/core/history.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = p => JSON.parse(readFileSync(root + p, 'utf8'));
const ds = read('data/synthetic/dataset.json'), catalog = read('config/analytes.json');
const rulesBase = { CHEM: read('config/rules.chem.json'), HEME: read('config/rules.heme.json') };
const models = Object.fromEntries(['chem_wbit','chem_contam','heme_wbit','chem_wbit_xgb','chem_contam_xgb','heme_wbit_xgb'].map(k => [k, read(`models/${k}.json`)]));
const index = buildHistoryIndex(ds.reports);
const byModel = keys => Object.fromEntries(Object.entries(rulesBase).map(([disc, rules]) => [disc, {
  ...rules,
  rules: rules.rules.map(r => r.type === 'model_score' ? { ...r, params: { ...r.params, model: keys[disc][r.code] } } : r)
}]));
const logisticRules = byModel({ CHEM: { 'CHEM-M01':'chem_wbit', 'CHEM-M02':'chem_contam' }, HEME: { 'HEME-M01':'heme_wbit' } });
const xgbRules = byModel({ CHEM: { 'CHEM-M01':'chem_wbit_xgb', 'CHEM-M02':'chem_contam_xgb' }, HEME: { 'HEME-M01':'heme_wbit_xgb' } });
const rows = ds.reports.filter(r => r.split === 'test').map(r => {
  const history = historyFor(index, r, catalog);
  const env = (rulesets, modelEnabled) => ({ catalog, rulesets, qcLog: ds.qcLog, history, models, settings: { modelEnabled } });
  return { report: r,
    rule: evaluateReport(r, env(rulesBase, false)),
    logistic: evaluateReport(r, env(logisticRules, true)),
    xgb: evaluateReport(r, env(xgbRules, true)) };
});
const rate = (k,n) => {
  if (!n) return { k, n, value: null, ci95: [null, null] };
  const z=1.96, p=k/n, d=1+z*z/n, c=p+z*z/(2*n), m=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n));
  return { k, n, value:p, ci95:[(c-m)/d,(c+m)/d] };
};
const POLICY_RULES = new Set(['av_limits', 'history_required_if_abnormal']);
function summarize(xs, key) {
  const eligible = xs.filter(x => x[key].decision === DECISIONS.AUTO);
  const needs = xs.filter(x => x.report.truth.requiresReview);
  const clean = xs.filter(x => !x.report.truth.requiresReview);
  const errors = xs.filter(x => x.report.truth.sampleError);
  return {
    reports: xs.length,
    autoApproveRate: rate(eligible.length, xs.length),
    falsePassPerAutoApproved: rate(eligible.filter(x => x.report.truth.requiresReview).length, eligible.length),
    missedAmongNeedsReview: rate(needs.filter(x => x[key].decision === DECISIONS.AUTO).length, needs.length),
    missedSampleErrors: rate(errors.filter(x => x[key].decision === DECISIONS.AUTO).length, errors.length),
    unnecessaryHold: rate(clean.filter(x => x[key].decision !== DECISIONS.AUTO).length, clean.length),
    holdCleanPolicyOnly: rate(clean.filter(x => { const a=x[key].checks.filter(c=>c.action); return a.length && a.every(c=>POLICY_RULES.has(c.type)); }).length, clean.length),
    holdCleanOther: rate(clean.filter(x => { const a=x[key].checks.filter(c=>c.action); return a.length && !a.every(c=>POLICY_RULES.has(c.type)); }).length, clean.length),
    blockedRate: rate(xs.filter(x => x[key].decision === DECISIONS.BLOCKED).length, xs.length),
    manualReviewRate: rate(xs.filter(x => x[key].decision === DECISIONS.REVIEW).length, xs.length),
  };
}
const errorTypes = [...new Set(rows.map(x => x.report.truth.sampleError).filter(Boolean))].sort();
const disciplines = {};
for (const discipline of ['CHEM','HEME']) {
  const xs = rows.filter(x => x.report.discipline === discipline);
  const perErrorType = {};
  for (const error of errorTypes) {
    const sub = xs.filter(x => x.report.truth.sampleError === error);
    if (!sub.length) continue;
    perErrorType[error] = { n: sub.length,
      ruleOnlyCaught: rate(sub.filter(x => x.rule.decision !== DECISIONS.AUTO).length, sub.length),
      logisticCaught: rate(sub.filter(x => x.logistic.decision !== DECISIONS.AUTO).length, sub.length),
      xgboostCaught: rate(sub.filter(x => x.xgb.decision !== DECISIONS.AUTO).length, sub.length) };
  }
  disciplines[discipline] = { reports: xs.length, ruleOnly: summarize(xs,'rule'), ruleLogistic: summarize(xs,'logistic'), ruleXgboost: summarize(xs,'xgb'), perErrorType };
}
const out = { generatedAt: new Date().toISOString(), seed: ds.meta.seed,
  disclaimer: 'Same synthetic test set for all columns. Synthetic error prevalence is enriched; these results are not clinical performance or real-world predictive values.',
  variants: { ruleOnly: 'Rule engine with all model checks disabled', ruleLogistic: 'Rules plus the retained legacy logistic-regression detectors', ruleXgboost: 'Rules plus the XGBoost detectors currently used by the app' },
  disciplines, papers: {
    heme_wbit_xgb: 'Graham et al. 2025, doi:10.1093/clinchem/hvae210',
    chem_wbit_xgb: 'Tortosa-Carreres et al. 2026, doi:10.1515/cclm-2025-0564',
    chem_contam_xgb: 'Farrell et al. 2026, doi:10.1177/00045632261488751; Spies et al. 2025, doi:10.1093/clinchem/hvae168'
  },
  definitions: read('reports/evaluation.json').definitions,
  logisticDetectorReports: read('reports/evaluation.json').detectors,
  xgbDetectorReports: Object.fromEntries(['chem_wbit_xgb','chem_contam_xgb','heme_wbit_xgb'].map(k => { const m=models[k]; return [k,{name:m.name,targets:m.targets,scope:m.scope,threshold:m.threshold,recallTarget:m.recallTarget,trainedOn:m.trainedOn,syntheticTest:m.syntheticTest,paperBasis:m.paperBasis,paperUrl:k==='heme_wbit_xgb'?'https://doi.org/10.1093/clinchem/hvae210':k==='chem_wbit_xgb'?'https://doi.org/10.1515/cclm-2025-0564':'https://doi.org/10.1177/00045632261488751'}]; }))
};
writeFileSync(root + 'reports/evaluation-comparison.json', JSON.stringify(out, null, 1));
console.log(`Saved reports/evaluation-comparison.json for ${rows.length} synthetic test reports.`);
