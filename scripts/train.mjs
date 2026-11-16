// Offline training + evaluation on SYNTHETIC data. Results describe the simulation only.
// - One logistic-regression (L2) detector per error family (not a single "correct/incorrect" classifier).
// - Subject-level split (train/val/test) fixed before error injection.
// - Threshold pre-specified by a recall target on the validation split, within the detector's scope.
// - Compare rule-only vs rule+models on the same test split, with denominators and Wilson 95% CI.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateReport, DECISIONS } from '../src/core/engine.js';
import { extractFeatures } from '../src/core/features.js';
import { trainLogReg, scoreFeatures } from '../src/core/model.js';
import { buildHistoryIndex, historyFor } from '../src/core/history.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = p => JSON.parse(readFileSync(root + p, 'utf8'));
const catalog = read('config/analytes.json');
const rulesets = { CHEM: read('config/rules.chem.json'), HEME: read('config/rules.heme.json') };
const ds = read('data/synthetic/dataset.json');

const HIST_FEATS = ['hist_avail', 'n_deltas', 'delta_ms', 'delta_max_abs', 'log_days_since_prev', 'acute_setting'];
export const DETECTORS = [
  { key: 'chem_wbit', discipline: 'CHEM', name: 'Nghi nhầm mẫu (WBIT) — hóa sinh', targets: ['wbit'], recallTarget: 0.8, scope: 'history',
    scopeNote: 'chỉ ca có lịch sử ≤90 ngày (không có lịch sử thì không thể so sánh)',
    features: f => f.startsWith('ad_') || HIST_FEATS.includes(f) },
  { key: 'chem_contam', discipline: 'CHEM', name: 'Nghi nhiễm EDTA / lẫn dịch truyền — hóa sinh', targets: ['edta', 'saline', 'd5w'], recallTarget: 0.9, scope: 'all',
    scopeNote: 'mọi phiếu hóa sinh có dữ liệu hợp lệ', features: f => !f.startsWith('ad_') },
  { key: 'heme_wbit', discipline: 'HEME', name: 'Nghi nhầm mẫu (WBIT) — CBC', targets: ['wbit'], recallTarget: 0.8, scope: 'history',
    scopeNote: 'chỉ ca có lịch sử ≤90 ngày', features: f => f.startsWith('ad_') || f.startsWith('d_') || [...HIST_FEATS, 'recent_transfusion'].includes(f) }
];

const index = buildHistoryIndex(ds.reports);
const rows = [];
for (const r of ds.reports) {
  if (r.split === 'scenario') continue;
  const history = historyFor(index, r, catalog);
  rows.push({ r, history, feats: extractFeatures(r, history, catalog) });
}
console.log(`Featurised ${rows.length} synthetic reports.`);

function rocPr(scores, labels) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);
  const P = labels.filter(Boolean).length, N = labels.length - P;
  let tp = 0, fp = 0, prevFpr = 0, prevTpr = 0, auc = 0, ap = 0, prevRecall = 0;
  for (const i of idx) {
    if (labels[i]) tp++; else fp++;
    const tpr = P ? tp / P : 0, fpr = N ? fp / N : 0;
    auc += (fpr - prevFpr) * (tpr + prevTpr) / 2; prevFpr = fpr; prevTpr = tpr;
    if (labels[i]) { ap += (tpr - prevRecall) * (tp / (tp + fp)); prevRecall = tpr; }
  }
  return { rocAuc: auc, prAuc: ap, positives: P, negatives: N };
}
function wilson(k, n, z = 1.96) {
  if (!n) return [null, null];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}
const rate = (k, n) => ({ k, n, value: n ? k / n : null, ci95: wilson(k, n) });

const models = {};
const detectorReports = {};
for (const det of DETECTORS) {
  const inScope = x => x.r.discipline === det.discipline && !x.r.truth.dataIssue && (det.scope !== 'history' || x.feats.hist_avail);
  const subset = rows.filter(inScope);
  const featureNames = Object.keys(subset[0].feats).filter(det.features);
  const y = x => det.targets.includes(x.r.truth.sampleError) ? 1 : 0;
  const train = subset.filter(x => x.r.split === 'train');
  const val = subset.filter(x => x.r.split === 'val');
  const test = subset.filter(x => x.r.split === 'test');
  const pos = train.filter(y).length;
  const model = trainLogReg(train.map(x => x.feats), train.map(y), featureNames, { l2: 2e-3, epochs: 600, lr: 0.05, posWeight: Math.min(25, (train.length - pos) / pos / 4) });
  const valScores = val.map(x => scoreFeatures(x.feats, model).score);
  const posScores = val.map((x, i) => y(x) ? valScores[i] : null).filter(v => v != null).sort((a, b) => b - a);
  const threshold = posScores[Math.max(0, Math.ceil(det.recallTarget * posScores.length) - 1)];
  Object.assign(model, {
    key: det.key, name: det.name, version: `${det.key}-logreg-0.2.0`, requiresHistory: det.scope === 'history', discipline: det.discipline, targets: det.targets, scope: det.scopeNote,
    algorithm: 'Logistic regression, L2, Adam; z-score theo thống kê tập train; giá trị thiếu = trung bình train (kèm đặc trưng "có lịch sử")',
    threshold, recallTarget: det.recallTarget, trainedAt: new Date().toISOString(),
    trainedOn: `synthetic seed ${ds.meta.seed}, split=train (${train.length} phiếu trong phạm vi, ${pos} dương tính)`,
    thresholdSelection: `Ngưỡng nhỏ nhất đạt recall ≥ ${det.recallTarget * 100}% trên ${posScores.length} ca dương tính của tập validation (${val.length} phiếu trong phạm vi; ${det.scopeNote}).`,
    status: 'NGHIÊN CỨU — chỉ được nâng lên MANUAL_REVIEW, chưa được thẩm định'
  });
  models[det.key] = model;
  const testScores = test.map(x => scoreFeatures(x.feats, model).score), testLabels = test.map(y);
  let tp = 0, fp = 0, fn = 0, tn = 0;
  testScores.forEach((s, i) => { if (s >= threshold) testLabels[i] ? tp++ : fp++; else testLabels[i] ? fn++ : tn++; });
  const sens = tp / (tp + fn), spec = tn / (tn + fp);
  const ppvAt = p => (sens * p) / (sens * p + (1 - spec) * (1 - p));
  detectorReports[det.key] = {
    key: det.key, name: det.name, discipline: det.discipline, targets: det.targets, scope: det.scopeNote, version: model.version,
    threshold, recallTarget: det.recallTarget, thresholdSelection: model.thresholdSelection,
    train: { n: train.length, positives: pos }, validation: { n: val.length, positives: posScores.length, ...rocPr(valScores, val.map(y)) },
    test: { n: test.length, ...rocPr(testScores, testLabels), sensitivity: rate(tp, tp + fn), specificity: rate(tn, tn + fp), flagRate: rate(tp + fp, test.length), tp, fp, fn, tn },
    ppvAtAssumedPrevalence: [0.01, 0.001, 0.0003].map(p => ({ prevalence: p, ppv: ppvAt(p) })),
    ppvNote: 'PPV ước tính từ độ nhạy/đặc hiệu trên tập test giả lập với tỷ lệ lỗi GIẢ ĐỊNH — không đo trực tiếp; bất định lớn (cỡ mẫu dương tính nhỏ).',
    topWeights: model.features.map((f, i) => ({ feature: f, weight: model.weights[i] })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 10)
  };
  const d = detectorReports[det.key];
  console.log(`${det.key.padEnd(12)} train ${train.length}/${pos}+ · val PR-AUC ${d.validation.prAuc.toFixed(3)} · thr ${threshold.toFixed(3)} · test sens ${sens.toFixed(2)} spec ${spec.toFixed(3)} flag ${(d.test.flagRate.value * 100).toFixed(1)}% (n=${test.length}, pos=${tp + fn})`);
}

// ---------- end-to-end evaluation on the test split ----------
const testRows = rows.filter(x => x.r.split === 'test');
const env = (history, modelEnabled, personalMode = 'OFF') => ({ catalog, rulesets, qcLog: ds.qcLog, history, models, settings: { modelEnabled, personalMode } });
// Variants: population thresholds (OFF) vs personalized intervals (TIGHTEN / ADAPT), each without and with the AI layer.
const VARIANTS = [['OFF', false], ['OFF', true], ['TIGHTEN', false], ['TIGHTEN', true], ['ADAPT', false], ['ADAPT', true]];
const evals = testRows.map(x => {
  const e = { x };
  for (const [pm, me] of VARIANTS) e[`${pm}_${me ? 'ai' : 'rule'}`] = evaluateReport(x.r, env(x.history, me, pm));
  e.rule = e.OFF_rule; e.combo = e.OFF_ai;
  return e;
});

const POLICY_RULES = new Set(['av_limits', 'history_required_if_abnormal']);
function summarise(list, key) {
  const n = list.length;
  const auto = list.filter(e => e[key].decision === DECISIONS.AUTO);
  const needs = list.filter(e => e.x.r.truth.requiresReview);
  const clean = list.filter(e => !e.x.r.truth.requiresReview);
  const errs = list.filter(e => e.x.r.truth.sampleError);
  return {
    reports: n,
    autoApproveRate: rate(auto.length, n),
    blockedRate: rate(list.filter(e => e[key].decision === DECISIONS.BLOCKED).length, n),
    manualReviewRate: rate(list.filter(e => e[key].decision === DECISIONS.REVIEW).length, n),
    falsePassPerAutoApproved: rate(auto.filter(e => e.x.r.truth.requiresReview).length, auto.length),
    missedAmongNeedsReview: rate(needs.filter(e => e[key].decision === DECISIONS.AUTO).length, needs.length),
    missedSampleErrors: rate(errs.filter(e => e[key].decision === DECISIONS.AUTO).length, errs.length),
    unnecessaryHold: rate(clean.filter(e => e[key].decision !== DECISIONS.AUTO).length, clean.length),
    // Of the clean reports, those held ONLY by configured policy rules (outside AV limits / history required):
    // holding them is what the (illustrative) policy asks for, so they are reported separately, not as "wrong".
    holdCleanPolicyOnly: rate(clean.filter(e => { const a = e[key].checks.filter(c => c.action); return a.length && a.every(c => POLICY_RULES.has(c.type)); }).length, clean.length),
    holdCleanOther: rate(clean.filter(e => { const a = e[key].checks.filter(c => c.action); return a.length && !a.every(c => POLICY_RULES.has(c.type)); }).length, clean.length),
    agreementWithSimulatedReviewer: rate(list.filter(e => (e.x.r.reviewer?.action === 'HOLD') === (e[key].decision !== DECISIONS.AUTO)).length, n)
  };
}

const errorTypes = [...new Set(testRows.map(x => x.r.truth.sampleError).filter(Boolean))].sort();
const evaluation = {
  generatedAt: new Date().toISOString(), seed: ds.meta.seed,
  disclaimer: 'Kết quả trên dữ liệu GIẢ LẬP với tỷ lệ lỗi được làm giàu (≈10–50× thực tế). Không phản ánh hiệu năng trên dữ liệu thật; không dùng làm tiêu chí nghiệm thu.',
  definitions: {
    autoApproveRate: 'Số phiếu AUTO_APPROVE_ELIGIBLE / tổng phiếu',
    falsePassPerAutoApproved: 'Số phiếu tự duyệt mà ground truth cần xem xét / số phiếu tự duyệt',
    missedAmongNeedsReview: 'Số phiếu cần xem xét bị tự duyệt / tổng số phiếu cần xem xét (lỗi mẫu + dữ liệu + tới hạn + cờ bệnh lý)',
    missedSampleErrors: 'Số phiếu có lỗi mẫu/phân tích bị tự duyệt / tổng phiếu có lỗi mẫu',
    unnecessaryHold: 'Số phiếu KHÔNG có lỗi mẫu/dữ liệu/tới hạn/cờ bệnh lý (theo nhãn giả lập) nhưng bị giữ / tổng số phiếu đó. Bao gồm cả các phiếu bị giữ đúng theo chính sách (ngoài giới hạn tự duyệt, thiếu lịch sử bắt buộc).',
    holdCleanPolicyOnly: 'Phần của chỉ số trên chỉ do rule chính sách (ngoài giới hạn tự duyệt, thiếu lịch sử bắt buộc) — giữ theo cấu hình, không phải "sai".',
    holdCleanOther: 'Phần còn lại: phiếu không có lỗi bị giữ bởi delta check, nhất quán, HIL, mô hình… — đây mới là "báo động giả" thực sự cần giảm.',
    agreementWithSimulatedReviewer: 'Tỷ lệ trùng quyết định giữ/duyệt với người duyệt MÔ PHỎNG (có nhiễu) — "người duyệt đã duyệt" ≠ "kết quả đúng"'
  },
  splits: Object.fromEntries(['train', 'val', 'test'].map(sp => [sp, rows.filter(x => x.r.split === sp).length])),
  detectors: detectorReports,
  disciplines: {}
};
for (const disc of ['CHEM', 'HEME']) {
  const list = evals.filter(e => e.x.r.discipline === disc);
  const perType = {};
  for (const t of errorTypes) {
    const sub = list.filter(e => e.x.r.truth.sampleError === t);
    if (sub.length) perType[t] = { n: sub.length, withHistory: sub.filter(e => e.x.feats.hist_avail).length,
      ruleOnlyCaught: rate(sub.filter(e => e.rule.decision !== DECISIONS.AUTO).length, sub.length),
      ruleModelCaught: rate(sub.filter(e => e.combo.decision !== DECISIONS.AUTO).length, sub.length) };
  }
  const ruleTriggerCounts = {};
  for (const e of list) for (const c of e.combo.checks) if (c.action) ruleTriggerCounts[c.code] = (ruleTriggerCounts[c.code] ?? 0) + 1;
  const variants = VARIANTS.map(([pm, me]) => ({ personalMode: pm, modelEnabled: me, ...summarise(list, `${pm}_${me ? 'ai' : 'rule'}`) }));
  evaluation.disciplines[disc] = { ruleOnly: summarise(list, 'rule'), ruleModel: summarise(list, 'combo'), variants, perErrorType: perType, ruleTriggerCounts };
  for (const v of variants) console.log(`  [${v.personalMode.padEnd(7)} ${v.modelEnabled ? '+AI' : '   '}] auto ${(v.autoApproveRate.value * 100).toFixed(1)}% | false-pass/auto ${(v.falsePassPerAutoApproved.value * 1000).toFixed(1)}‰ | missed err ${(v.missedSampleErrors.value * 100).toFixed(1)}% | false alarm ${(v.holdCleanOther.value * 100).toFixed(1)}% | policy hold ${(v.holdCleanPolicyOnly.value * 100).toFixed(1)}%`);
  const ro = evaluation.disciplines[disc].ruleOnly, rm = evaluation.disciplines[disc].ruleModel;
  const pc = v => (v.value * 100).toFixed(1) + '%';
  console.log(`\n${disc} test (${list.length} phiếu)`);
  console.log(`  rule-only : auto ${pc(ro.autoApproveRate)} | false-pass/auto ${(ro.falsePassPerAutoApproved.value * 1000).toFixed(1)}‰ | missed sample err ${pc(ro.missedSampleErrors)} | unnecessary hold ${pc(ro.unnecessaryHold)}`);
  console.log(`  rule+model: auto ${pc(rm.autoApproveRate)} | false-pass/auto ${(rm.falsePassPerAutoApproved.value * 1000).toFixed(1)}‰ | missed sample err ${pc(rm.missedSampleErrors)} | unnecessary hold ${pc(rm.unnecessaryHold)}`);
  for (const [t, v] of Object.entries(perType)) console.log(`   ${t.padEnd(13)} n=${String(v.n).padStart(3)} rule ${pc(v.ruleOnlyCaught)} → rule+model ${pc(v.ruleModelCaught)} (có lịch sử ${v.withHistory})`);
}

mkdirSync(root + 'models', { recursive: true });
mkdirSync(root + 'reports', { recursive: true });
for (const [k, m] of Object.entries(models)) writeFileSync(root + `models/${k}.json`, JSON.stringify(m, null, 1));
writeFileSync(root + 'reports/evaluation.json', JSON.stringify(evaluation, null, 1));
console.log('\nSaved models/*.json and reports/evaluation.json');
