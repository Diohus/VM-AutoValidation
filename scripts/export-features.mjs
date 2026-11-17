// Export one row per synthetic report for the offline Python benchmark (ml/).
// Features come from the SAME src/core/features.js used at runtime; the rule-only baseline comes from the SAME
// engine (model layer OFF). Python never recomputes features, so training and runtime cannot drift apart.
// Label/meta columns are prefixed so the Python side can enforce a feature allow-list (no label leakage).
//   node scripts/export-features.mjs --dataset=data/synthetic/bench/dataset.json --out=data/synthetic/bench/features.jsonl
import { readFileSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateReport, DECISIONS } from '../src/core/engine.js';
import { extractFeatures, MODEL_TESTS, coverage } from '../src/core/features.js';
import { buildHistoryIndex, historyFor } from '../src/core/history.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const read = p => JSON.parse(readFileSync(root + p, 'utf8'));
const catalog = read('config/analytes.json');
const rulesets = { CHEM: read('config/rules.chem.json'), HEME: read('config/rules.heme.json') };
const ds = read(args.dataset ?? 'data/synthetic/dataset.json');
const out = createWriteStream(root + (args.out ?? 'data/synthetic/features.jsonl'));

// Guard (Codex round 2): duplicate pseudonymous tokens would merge two people's histories.
if (ds.subjects && new Set(ds.subjects.map(x => x.token)).size !== ds.subjects.length) throw new Error('Duplicate subject tokens in dataset — regenerate it');
const index = buildHistoryIndex(ds.reports);
const FIRST_VISIT_RULE = 'history_required_if_abnormal';
const decide = checks => {
  const acts = checks.map(c => c.action).filter(Boolean);
  return acts.includes('BLOCK') ? DECISIONS.BLOCKED : acts.some(a => a === 'REVIEW' || a === 'CRITICAL') ? DECISIONS.REVIEW : DECISIONS.AUTO;
};

let n = 0;
for (const r of ds.reports) {
  if (r.split === 'scenario') continue;
  const history = historyFor(index, r, catalog);
  const feats = extractFeatures(r, history, catalog);
  const ev = evaluateReport(r, { catalog, rulesets, qcLog: ds.qcLog, history, models: {}, settings: { modelEnabled: false } });
  const held = ev.checks.filter(c => c.action);
  const t0 = Math.min(...r.results.map(x => Date.parse(x.measuredAt)).filter(Number.isFinite));
  const priorEver = (index.get(r.subjectToken) ?? []).some(o => o.reportId !== r.reportId && o.discipline === r.discipline
    && o.results.some(x => Date.parse(x.measuredAt) < t0));
  const cov = coverage(r, MODEL_TESTS[r.discipline], catalog);
  const row = {
    meta_report_id: r.reportId, meta_subject: r.subjectToken, meta_split: r.split, meta_discipline: r.discipline, meta_panel: r.panel,
    meta_ward: r.ward, meta_prior_ever: priorEver ? 1 : 0, meta_coverage_used: cov.used, meta_coverage_total: cov.total,
    label_errors: r.truth.errors ?? (r.truth.sampleError ? [r.truth.sampleError] : []), label_primary: r.truth.sampleError,
    label_data_issue: r.truth.dataIssue, label_critical: r.truth.criticalValue ? 1 : 0, label_pathology: r.truth.pathologyFlag,
    label_requires_review: r.truth.requiresReview ? 1 : 0, label_analytical: r.truth.analytical ?? null,
    rule_decision: ev.decision, rule_held_by: held.map(c => c.code),
    // Same report under firstVisitAbnormalPolicy = MODEL_FLAG_ONLY: the first-visit rule (CHEM-H02) is switched off.
    rule_first_visit_failed: ev.checks.some(c => c.type === FIRST_VISIT_RULE && c.action) ? 1 : 0,
    rule_decision_without_first_visit: decide(ev.checks.filter(c => c.type !== FIRST_VISIT_RULE)),
    ...Object.fromEntries(Object.entries(feats).map(([k, v]) => ['f_' + k, v]))
  };
  out.write(JSON.stringify(row) + '\n');
  n++;
}
out.end(() => console.log(`Exported ${n} reports → ${args.out ?? 'data/synthetic/features.jsonl'}`));
