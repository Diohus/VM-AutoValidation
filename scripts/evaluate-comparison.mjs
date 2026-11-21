// One evaluation report for the "Đánh giá mô hình" tab (reports/evaluation-comparison.json), Node only:
// 1) End-to-end on the RUNTIME dataset (seed 20261116, independent of the benchmark data the models were trained on):
//    rule-only vs rule + deployed models (models/*.json), same test reports, with personalised-threshold variants.
// 2) The offline benchmark summary (reports/benchmark.json, ml/benchmark.py): LR vs XGBoost vs LightGBM, first-visit anomaly.
// All numbers describe SYNTHETIC data only.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateReport, DECISIONS } from '../src/core/engine.js';
import { buildHistoryIndex, historyFor } from '../src/core/history.js';
import { loadModels, stackFingerprint } from '../src/core/load-models.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = p => JSON.parse(readFileSync(root + p, 'utf8'));
const ds = read('data/synthetic/dataset.json'), catalog = read('config/analytes.json');
const rulesets = { CHEM: read('config/rules.chem.json'), HEME: read('config/rules.heme.json') };
const models = loadModels(root + 'models');
const index = buildHistoryIndex(ds.reports);

const wilson = (k, n, z = 1.96) => { if (!n) return [null, null]; const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - m) / d, (c + m) / d]; };
const rate = (k, n) => ({ k, n, value: n ? k / n : null, ci95: wilson(k, n) });
const errorsOf = r => r.truth.errors ?? (r.truth.sampleError ? [r.truth.sampleError] : []);

const VARIANTS = [['OFF', false], ['OFF', true], ['TIGHTEN', false], ['TIGHTEN', true], ['ADAPT', false], ['ADAPT', true]];
const rows = ds.reports.filter(r => r.split === 'test').map(r => {
  const history = historyFor(index, r, catalog);
  const x = { r, hist: null };
  for (const [pm, me] of VARIANTS) x[`${pm}_${me ? 'ai' : 'rule'}`] = evaluateReport(r, { catalog, rulesets, qcLog: ds.qcLog, history, models, settings: { modelEnabled: me, personalMode: pm } });
  x.rule = x.OFF_rule; x.combo = x.OFF_ai;
  return x;
});

const POLICY_RULES = new Set(['av_limits', 'history_required_if_abnormal']);
function summarise(list, key) {
  const auto = list.filter(e => e[key].decision === DECISIONS.AUTO);
  const needs = list.filter(e => e.r.truth.requiresReview), clean = list.filter(e => !e.r.truth.requiresReview);
  const errs = list.filter(e => errorsOf(e.r).length);
  const actions = e => e[key].checks.filter(c => c.action);
  return {
    reports: list.length,
    autoApproveRate: rate(auto.length, list.length),
    blockedRate: rate(list.filter(e => e[key].decision === DECISIONS.BLOCKED).length, list.length),
    falsePassPerAutoApproved: rate(auto.filter(e => e.r.truth.requiresReview).length, auto.length),
    missedAmongNeedsReview: rate(needs.filter(e => e[key].decision === DECISIONS.AUTO).length, needs.length),
    missedSampleErrors: rate(errs.filter(e => e[key].decision === DECISIONS.AUTO).length, errs.length),
    unnecessaryHold: rate(clean.filter(e => e[key].decision !== DECISIONS.AUTO).length, clean.length),
    holdCleanPolicyOnly: rate(clean.filter(e => { const a = actions(e); return a.length && a.every(c => POLICY_RULES.has(c.type)); }).length, clean.length),
    holdCleanOther: rate(clean.filter(e => { const a = actions(e); return a.length && !a.every(c => POLICY_RULES.has(c.type)); }).length, clean.length),
  };
}

const disciplines = {};
for (const disc of ['CHEM', 'HEME']) {
  const list = rows.filter(e => e.r.discipline === disc);
  const types = [...new Set(list.flatMap(e => errorsOf(e.r)))].sort();
  const perErrorType = Object.fromEntries(types.map(t => {
    const sub = list.filter(e => errorsOf(e.r).includes(t));
    return [t, { n: sub.length, ruleOnlyCaught: rate(sub.filter(e => e.rule.decision !== DECISIONS.AUTO).length, sub.length),
      ruleModelCaught: rate(sub.filter(e => e.combo.decision !== DECISIONS.AUTO).length, sub.length) }];
  }));
  // Model layer outcomes on this discipline: how often each model scored / was not evaluable / flagged.
  const modelUse = {};
  for (const e of list) for (const m of e.combo.models) {
    const u = modelUse[m.key] ??= { scored: 0, notEvaluable: 0, outOfScope: 0, flagged: 0, flaggedRuleAuto: 0 };
    if (m.status === 'SCORED') u.scored++; else if (m.status === 'NOT_EVALUABLE') u.notEvaluable++; else u.outOfScope++;
    if (m.flagged) { u.flagged++; if (e.rule.decision === DECISIONS.AUTO) u.flaggedRuleAuto++; }
  }
  disciplines[disc] = { reports: list.length, ruleOnly: summarise(list, 'rule'), ruleModel: summarise(list, 'combo'),
    variants: VARIANTS.map(([pm, me]) => ({ personalMode: pm, modelEnabled: me, ...summarise(list, `${pm}_${me ? 'ai' : 'rule'}`) })),
    perErrorType, modelUse };
}

// Compact benchmark summary (the full file stays in reports/benchmark.json).
let benchmark = null;
if (existsSync(root + 'reports/benchmark.json')) {
  const b = read('reports/benchmark.json');
  const pick = r => r && !r.sameAs ? { prAuc: r.test.prAuc ?? null, sensitivity: r.test.sensitivity, specificity: r.test.specificity,
    addedCatchOfRuleMissed: r.vsRuleOnly?.addedCatchOfRuleMissed, extraFalseAlarmOnCleanRuleAuto: r.vsRuleOnly?.extraFalseAlarmOnCleanRuleAuto,
    ppvAtAssumedPrevalence: r.test.ppvAtAssumedPrevalence } : null;
  benchmark = {
    disclaimer: b.disclaimer, data: b.data, deployed: b.deployed,
    selection: Object.fromEntries(Object.entries(b.selection).map(([k, v]) => [k, { chosen: v.chosen, default: v.default, reason: v.reason }])),
    contaminationSplitVsCombined: { chosen: b.contaminationSplitVsCombined.chosen, reason: b.contaminationSplitVsCombined.reason,
      combined_PR2: b.contaminationSplitVsCombined.combined_PR2.test, split: b.contaminationSplitVsCombined.split_rule_EDTA_plus_ivfluid.test },
    notDeployed: { chem_edta: 'Rule K–Ca đã bắt hết trên tập test giả lập; giữ bằng rule.', chem_analytical: 'Quá nhiều báo động giả ở ngưỡng recall 80%.', heme_analytical: 'Báo động giả thêm cao; chưa đủ lợi.', chem_contam: 'Mô hình gộp của PR #2: xem so sánh tách/gộp.' },
    detectors: Object.fromEntries(Object.entries(b.supervised).map(([k, d]) => [k, { name: d.name, targets: d.targets, split: d.split,
      algorithms: Object.fromEntries(Object.entries(d.configs.best_per_algorithm).map(([a, r]) => [a, pick(r)])),
      sameInput: Object.fromEntries(Object.entries(d.configs.same_input).map(([a, r]) => [a, pick(r)])) }])),
    firstVisitAnomaly: Object.fromEntries(Object.entries(b.firstVisitAnomaly).map(([p, d]) => [p, { testFirstVisit: d.testFirstVisit, testPositives: d.testPositives,
      models: Object.fromEntries(Object.entries(d.models).map(([m, r]) => [m, { ...pick(r), flagRate: r.test.flagRate, flagRateRealDiseaseAcute: r.flagRateRealDiseaseAcute }])) }])),
    firstVisitPolicy: b.firstVisitPolicy,
  };
}

const out = {
  generatedAt: new Date().toISOString(), seed: ds.meta.seed, fingerprint: stackFingerprint(models, rulesets, catalog),
  disclaimer: 'Dữ liệu GIẢ LẬP, tỷ lệ lỗi làm giàu. Không phản ánh hiệu năng thật, không dùng làm tiêu chí nghiệm thu.',
  endToEndNote: 'Tập test của bộ dữ liệu demo (seed 20261116). Mô hình được huấn luyện trên bộ benchmark khác (seed 20261117), nên đây là kiểm tra trên dữ liệu độc lập.',
  models: Object.values(models).map(m => ({ key: m.key, name: m.name, version: m.version, kind: m.kind })),
  definitions: {
    autoApproveRate: 'Số phiếu AUTO_APPROVE_ELIGIBLE / tổng phiếu',
    falsePassPerAutoApproved: 'Số phiếu tự duyệt mà ground truth cần xem xét / số phiếu tự duyệt',
    missedAmongNeedsReview: 'Số phiếu cần xem xét bị tự duyệt / tổng số phiếu cần xem xét',
    missedSampleErrors: 'Số phiếu có lỗi mẫu/phân tích (truth.errors) bị tự duyệt / tổng phiếu có lỗi',
    unnecessaryHold: 'Phiếu không có lỗi mẫu/dữ liệu/tới hạn/cờ bệnh lý nhưng bị giữ / tổng số phiếu đó (gồm cả giữ theo chính sách)',
    holdCleanPolicyOnly: 'Phần giữ chỉ do rule chính sách (ngoài giới hạn tự duyệt, thiếu lịch sử bắt buộc)',
    holdCleanOther: 'Báo động giả: phiếu không lỗi bị giữ bởi delta, nhất quán, HIL, mô hình…',
    modelUse: 'Số lần mỗi mô hình chấm điểm / không đánh giá được (thiếu dữ liệu then chốt) / ngoài phạm vi (có lịch sử); gắn cờ trên phiếu rule cho qua = phần mô hình giữ thêm',
  },
  disciplines, benchmark,
};
writeFileSync(root + 'reports/evaluation-comparison.json', JSON.stringify(out, null, 1));
for (const [d, D] of Object.entries(disciplines)) {
  const pc = r => `${(r.value * 100).toFixed(1)}%`;
  console.log(`${d}: rule-only auto ${pc(D.ruleOnly.autoApproveRate)} missed-err ${pc(D.ruleOnly.missedSampleErrors)} false-alarm ${pc(D.ruleOnly.holdCleanOther)} | +models auto ${pc(D.ruleModel.autoApproveRate)} missed-err ${pc(D.ruleModel.missedSampleErrors)} false-alarm ${pc(D.ruleModel.holdCleanOther)}`);
  console.log('   model use', JSON.stringify(D.modelUse));
}
console.log('Saved reports/evaluation-comparison.json');
