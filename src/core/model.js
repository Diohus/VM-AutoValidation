// L2-regularised logistic regression: training (offline scripts) and inference (runtime).
// The score is a detector score inside the synthetic evaluation scope, NOT a probability that a result is safe.
import { extractFeatures, featureLabel } from './features.js';

export function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

export function vectorize(featureObj, model) {
  return model.features.map((name, i) => {
    const v = featureObj[name];
    if (v == null || !Number.isFinite(v)) return 0; // mean-imputed (standardised space)
    const z = (v - model.mean[i]) / model.sd[i];
    return Math.max(-8, Math.min(8, z));
  });
}

export function scoreFeatures(featureObj, model) {
  if (model.algorithm === 'XGBoost JSON trees') return scoreXgboostFeatures(featureObj, model);
  const x = vectorize(featureObj, model);
  let s = model.bias;
  const contributions = [];
  for (let i = 0; i < x.length; i++) {
    const c = model.weights[i] * x[i];
    s += c;
    contributions.push({ feature: model.features[i], contribution: c, value: featureObj[model.features[i]] ?? null });
  }
  return { score: sigmoid(s), contributions };
}

function scoreXgboostFeatures(featureObj, model) {
  let margin = model.baseMargin;
  for (const tree of model.trees) {
    let node = tree;
    while (node.leaf == null) {
      const value = featureObj[node.split];
      const child = value == null || !Number.isFinite(value)
        ? node.missing
        : value < node.condition ? node.yes : node.no;
      node = node.children.find(c => c.nodeid === child);
    }
    margin += node.leaf;
  }
  const score = sigmoid(margin);
  // Global tree gain is not a per-report explanation; don't present it as one.
  return { score, contributions: [] };
}

export function scoreReport(report, history, catalog, model) {
  const feats = extractFeatures(report, history, catalog);
  if (model.requiresHistory && !feats.hist_avail) return { inScope: false, score: null, threshold: model.threshold, flagged: false, top: [], version: model.version };
  const { score, contributions } = scoreFeatures(feats, model);
  const top = contributions.filter(c => c.contribution > 0).sort((a, b) => b.contribution - a.contribution).slice(0, 4)
    .map(c => ({ ...c, label: featureLabel(c.feature, catalog) }));
  return { inScope: true, score, threshold: model.threshold, flagged: score >= model.threshold, top, version: model.version };
}

/**
 * Train logistic regression with Adam on standardised features.
 * rows: array of feature objects, y: 0/1, featureNames: string[]
 */
export function trainLogReg(rows, y, featureNames, { l2 = 1e-3, epochs = 400, lr = 0.05, posWeight = 1 } = {}) {
  const m = featureNames.length;
  const mean = new Array(m).fill(0), sd = new Array(m).fill(1);
  for (let j = 0; j < m; j++) {
    let s = 0, s2 = 0, n = 0;
    for (const r of rows) { const v = r[featureNames[j]]; if (v != null && Number.isFinite(v)) { s += v; s2 += v * v; n++; } }
    mean[j] = n ? s / n : 0;
    const varr = n ? s2 / n - mean[j] ** 2 : 1;
    sd[j] = Math.sqrt(Math.max(varr, 1e-9)) || 1;
  }
  const model = { features: featureNames, mean, sd, weights: new Array(m).fill(0), bias: 0 };
  const X = rows.map(r => vectorize(r, model));
  const N = X.length;
  const w = model.weights; let b = 0;
  const mw = new Array(m).fill(0), vw = new Array(m).fill(0); let mb = 0, vb = 0;
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  let wsum = 0; for (let i = 0; i < N; i++) wsum += y[i] ? posWeight : 1;
  for (let ep = 1; ep <= epochs; ep++) {
    const g = new Array(m).fill(0); let gb = 0;
    for (let i = 0; i < N; i++) {
      const xi = X[i]; let s = b;
      for (let j = 0; j < m; j++) s += w[j] * xi[j];
      const wi = y[i] ? posWeight : 1;
      const err = (sigmoid(s) - y[i]) * wi;
      for (let j = 0; j < m; j++) g[j] += err * xi[j];
      gb += err;
    }
    for (let j = 0; j < m; j++) {
      const gj = g[j] / wsum + l2 * w[j];
      mw[j] = b1 * mw[j] + (1 - b1) * gj; vw[j] = b2 * vw[j] + (1 - b2) * gj * gj;
      w[j] -= lr * (mw[j] / (1 - b1 ** ep)) / (Math.sqrt(vw[j] / (1 - b2 ** ep)) + eps);
    }
    const gbb = gb / wsum;
    mb = b1 * mb + (1 - b1) * gbb; vb = b2 * vb + (1 - b2) * gbb * gbb;
    b -= lr * (mb / (1 - b1 ** ep)) / (Math.sqrt(vb / (1 - b2 ** ep)) + eps);
  }
  model.bias = b;
  return model;
}
