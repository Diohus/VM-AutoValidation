// Runtime inference for the model layer (no npm dependencies). Models are trained OFFLINE in Python (ml/) and exported as JSON.
// - tree_ensemble: XGBoost or LightGBM trees in one normalised format, with a per-report explanation (Saabas path attribution).
// - knn_anomaly:   first-visit anomaly detector (mean distance to the k nearest reference reports, Farrell 2024 style).
// Scores are detector scores inside the synthetic evaluation scope, NOT probabilities that a result is safe.
// Missing values are never imputed: a missing input follows the tree's learned "missing" branch, and a model whose
// key inputs are absent returns NOT_EVALUABLE (never a pass).
import { extractFeatures, featureLabel, coverage, MODEL_TESTS } from './features.js';

export function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
const isMissing = v => v == null || !Number.isFinite(v);
const K_ZERO = 1e-35; // LightGBM kZeroThreshold

/**
 * Next node of one split. Two split semantics, exactly as the libraries implement them:
 *  - XGBoost ('<'):  value is cast to float32, missing → node.miss, else fround(value) < threshold ? yes : no.
 *  - LightGBM ('<='): missing_type 'nan' → NaN takes the default branch; 'zero' → 0 (and NaN, cast to 0) takes it;
 *                     'none' → NaN is treated as 0. Otherwise value <= threshold (double) ? left : right.
 */
export function nextNode(n, value) {
  if (n.op === '<') {
    if (isMissing(value)) return n.miss;
    return Math.fround(value) < n.t ? n.l : n.r;
  }
  let v = isMissing(value) ? NaN : value;
  if (n.mt !== 'nan' && Number.isNaN(v)) v = 0;
  if ((n.mt === 'zero' && Math.abs(v) <= K_ZERO) || (n.mt === 'nan' && Number.isNaN(v))) return n.dl ? n.l : n.r;
  return v <= n.t ? n.l : n.r;
}

/**
 * Score a tree ensemble and explain it. Saabas attribution: along each tree's path, the change of the node value
 * (expected output at that node) is credited to the feature that was split on. Exact by construction:
 * margin = bias + Σ contributions.
 */
export function scoreTrees(featureObj, model) {
  const x = model.features.map(f => featureObj[f]);
  let margin = model.baseMargin, bias = model.baseMargin;
  const contrib = new Float64Array(model.features.length);
  for (const tree of model.trees) {
    let i = 0, node = tree[0];
    bias += node.v;
    while (node.leaf === undefined) {
      const next = nextNode(node, x[node.f]);
      contrib[node.f] += tree[next].v - node.v;
      i = next; node = tree[i];
    }
    margin += node.leaf;
  }
  const contributions = model.features.map((feature, j) => ({ feature, contribution: contrib[j], value: featureObj[feature] ?? null }));
  return { score: sigmoid(margin), margin, bias, contributions };
}

/** Mean Euclidean distance to the k nearest reference points (standardised with the training scaler), as sklearn computes it. */
export function scoreKnn(featureObj, model) {
  const d = model.inputs.length;
  const q = model.inputs.map((f, j) => (featureObj[f] - model.mean[j]) / model.scale[j]);
  const n = model.ref.length / d;
  const best = []; // [dist, index] kept sorted, length ≤ k
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < d; j++) { const t = q[j] - model.ref[i * d + j]; s += t * t; }
    if (best.length < model.k || s < best[best.length - 1][0]) {
      best.push([s, i]); best.sort((a, b) => a[0] - b[0]);
      if (best.length > model.k) best.pop();
    }
  }
  const k = best.length;
  const score = best.reduce((a, [s]) => a + Math.sqrt(s), 0) / k;
  // Explanation, exact by construction: score = (1/k)·Σ_i d_i and d_i = Σ_j Δ_ij²/d_i, so analyte j gets (1/k)·Σ_i Δ_ij²/d_i
  // (its share of the distance to EACH neighbour; deviations in opposite directions cannot cancel out).
  const contrib = new Float64Array(d);
  for (const [s2, i] of best) {
    const di = Math.sqrt(s2);
    if (di === 0) continue;
    for (let j = 0; j < d; j++) { const t = q[j] - model.ref[i * d + j]; contrib[j] += t * t / di / k; }
  }
  const contributions = model.inputs.map((feature, j) => ({ feature, contribution: contrib[j], value: featureObj[feature] ?? null }));
  return { score, contributions };
}

export function scoreFeatures(featureObj, model) {
  if (model.kind === 'tree_ensemble') return scoreTrees(featureObj, model);
  if (model.kind === 'knn_anomaly') return scoreKnn(featureObj, model);
  throw new Error(`Loại mô hình chưa hỗ trợ: ${model.kind}`);
}

/**
 * Evaluate one model on one report. status:
 *  SCORED         → score / threshold / flagged / top contributions
 *  OUT_OF_SCOPE   → e.g. first-visit model on a patient with comparable history (delta check covers them)
 *  NOT_EVALUABLE  → key inputs missing; never treated as a pass
 * Always returns data coverage ("dùng 7/12 chỉ số") and the history status.
 */
export function scoreReport(report, history, catalog, model) {
  const feats = extractFeatures(report, history, catalog);
  const cov = coverage(report, model.coverageTests ?? MODEL_TESTS[report.discipline] ?? [], catalog);
  const hist = feats.hist_avail ? { available: true, label: 'Có lịch sử ≤90 ngày để so sánh' }
    : { available: false, label: 'Không đánh giá được — chưa có lịch sử ≤90 ngày' };
  const base = { threshold: model.threshold, version: model.version, coverage: cov, history: hist, score: null, flagged: false, top: [] };
  if (model.scope === 'noHistory90d' && feats.hist_avail) return { ...base, status: 'OUT_OF_SCOPE', inScope: false,
    reason: 'Người bệnh có lịch sử ≤90 ngày: delta check và các rule lịch sử đánh giá, mô hình người khám lần đầu không áp dụng.' };
  const needed = model.kind === 'knn_anomaly' ? model.inputs : (model.keyTests ?? []).map(t => `m_${t}`);
  const absent = needed.filter(f => model.kind === 'knn_anomaly' ? isMissing(feats[f]) : feats[f] !== 1);
  if (absent.length) return { ...base, status: 'NOT_EVALUABLE', inScope: false,
    reason: `Thiếu dữ liệu then chốt của mô hình: ${absent.map(f => f.replace(/^[mz]_/, '')).join(', ')} — không đánh giá được (không phải đạt).` };
  const { score, contributions } = scoreFeatures(feats, model);
  // Top factors by absolute contribution, with their direction: every scored report gets an explanation, even when all
  // contributions push the score down (a low score is explained too).
  const top = contributions.filter(c => c.contribution !== 0).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 4)
    .map(c => ({ ...c, direction: c.contribution > 0 ? 'UP' : 'DOWN', label: featureLabel(c.feature, catalog) }));
  return { ...base, status: 'SCORED', inScope: true, score, flagged: score >= model.threshold, top };
}
