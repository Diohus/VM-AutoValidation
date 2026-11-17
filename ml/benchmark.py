"""Offline benchmark of the model layer on SYNTHETIC data. Numbers describe the simulation only.

Input: data/synthetic/bench/features.jsonl written by scripts/export-features.mjs (features from the runtime JS code,
rule-only decisions from the runtime JS engine). Output: reports/benchmark.json.

Principles (see docs/MODEL_REDESIGN_PLAN.md):
- Subject-level split fixed before error injection (train / val / test). Test is used once.
- Hyper-parameters: small fixed grid, GroupKFold(5) by subject on TRAIN only. Val is used only for thresholds
  and for the pre-specified choice of algorithm per detector.
- Supervised threshold: the LARGEST threshold t with recall(score >= t) >= target on val positives.
- Anomaly threshold: 95th percentile of val first-visit scores, per panel (fixed 5% flag rate).
- Labels: simulated ground truth (truth.errors), never the simulated reviewer's action.
- No imputation. Trees take NaN natively; LR is stratified (panel x history) so each sub-model only sees columns
  that are always present in its stratum.
numpy only (no pandas): pandas' compiled modules are blocked by Application Control on the development machine.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
import lightgbm as lgb
import xgboost as xgb
from sklearn.covariance import EmpiricalCovariance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.model_selection import GroupKFold
from sklearn.neighbors import NearestNeighbors
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import OneClassSVM

ROOT = Path(__file__).resolve().parents[1]
SEED = 20261117
PREVALENCES = [0.01, 0.001, 0.0003]
N_BOOT = 1000

MODEL_TESTS = {
    "CHEM": ["GLU", "URE", "CRE", "NA", "K", "CL", "CA", "MG", "ALB", "ALP", "AST", "ALT"],
    "HEME": ["WBC", "RBC", "HGB", "HCT", "MCV", "MCH", "MCHC", "RDW", "PLT", "NEU", "LYM"],
}
PANEL_TESTS = {
    "CHEM_BASIC": ["GLU", "URE", "CRE", "NA", "K", "CL"],
    "CHEM_EXT": MODEL_TESTS["CHEM"],
    "CBC": MODEL_TESTS["HEME"],
}
CONTAM_ANALYTICAL = frozenset({"edta", "saline", "d5w", "analytical_single"})
AUTO = "AUTO_APPROVE_ELIGIBLE"

DETECTORS = [
    dict(key="chem_edta", discipline="CHEM", name="Nhiễm EDTA", targets=frozenset({"edta"}), recall=0.90, key_tests=["K", "CA"], min_tests=0),
    dict(key="chem_ivfluid", discipline="CHEM", name="Lẫn dịch truyền (NaCl 0,9% / glucose 5%)", targets=frozenset({"saline", "d5w"}),
         recall=0.90, key_tests=["NA", "CL", "GLU"], min_tests=0),
    dict(key="chem_analytical", discipline="CHEM", name="Lỗi phân tích đơn chỉ số — hóa sinh", targets=frozenset({"analytical_single"}),
         recall=0.80, key_tests=[], min_tests=6),
    dict(key="heme_analytical", discipline="HEME", name="Lỗi phân tích đơn chỉ số — CBC", targets=frozenset({"analytical_single"}),
         recall=0.80, key_tests=[], min_tests=6),
]

GRIDS = {
    "logreg": [dict(C=c) for c in (0.01, 0.1, 1.0, 10.0)],
    "xgboost": [dict(max_depth=d, n_estimators=n) for d in (3, 6) for n in (150, 400)],
    "lightgbm": [dict(num_leaves=l, n_estimators=n) for l in (15, 63) for n in (150, 400)],
}


def rng():
    return np.random.default_rng(SEED)


# ---------------------------------------------------------------- statistics
def wilson(k: int, n: int, z: float = 1.96):
    if not n:
        return [None, None]
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return [(c - m) / d, (c + m) / d]


def rate(k, n):
    k, n = int(k), int(n)
    return {"k": k, "n": n, "value": (k / n) if n else None, "ci95_wilson": wilson(k, n)}


def subject_boot_indices(subjects: np.ndarray, n_boot: int = N_BOOT):
    """Cluster bootstrap by subject (several reports of one subject are correlated)."""
    _, inv = np.unique(subjects, return_inverse=True)
    order = np.argsort(inv, kind="stable")
    bounds = np.searchsorted(inv[order], np.arange(inv.max() + 2))
    rows_of = [order[bounds[i]:bounds[i + 1]] for i in range(inv.max() + 1)]
    g = rng()
    for _ in range(n_boot):
        pick = g.integers(0, len(rows_of), len(rows_of))
        yield np.concatenate([rows_of[i] for i in pick])


def boot_ci(values):
    v = np.asarray([x for x in values if x is not None and np.isfinite(x)], dtype=float)
    return [float(np.quantile(v, 0.025)), float(np.quantile(v, 0.975))] if len(v) else [None, None]


def ppv_at(sens, spec, p):
    if sens is None or spec is None:
        return None
    den = sens * p + (1 - spec) * (1 - p)
    return sens * p / den if den > 0 else None


def pick_threshold(scores, y, target):
    """Largest t such that recall(score >= t) >= target among positives (ties: >= keeps all tied scores)."""
    pos = np.sort(scores[y == 1])[::-1]
    if not len(pos):
        return None
    k = max(1, math.ceil(target * len(pos)))
    return float(pos[k - 1])


# ---------------------------------------------------------------- data
class Frame:
    """Minimal column store."""

    def __init__(self, cols):
        self.cols = cols

    def __getitem__(self, k):
        return self.cols[k]

    def __len__(self):
        return len(next(iter(self.cols.values())))

    @property
    def columns(self):
        return list(self.cols)

    def sub(self, sel):
        return Frame({k: v[sel] for k, v in self.cols.items()})

    def matrix(self, names):
        return np.column_stack([self.cols[n] for n in names]).astype(float) if names else np.zeros((len(self), 0))


NUMERIC_META = ("meta_prior_ever", "meta_coverage_used", "meta_coverage_total", "label_requires_review", "rule_first_visit_failed", "label_critical")


def load(path: Path) -> Frame:
    rows = [json.loads(line) for line in path.open(encoding="utf-8")]
    keys = list(dict.fromkeys(k for r in rows for k in r))
    cols = {}
    for k in keys:
        vals = [r.get(k) for r in rows]
        if k.startswith("f_") or k in NUMERIC_META:
            cols[k] = np.array([np.nan if v is None else float(v) for v in vals])
        else:
            a = np.empty(len(vals), dtype=object)
            a[:] = vals
            cols[k] = a
    cols["errors"] = np.empty(len(rows), dtype=object)
    cols["errors"][:] = [frozenset(e or []) for e in cols["label_errors"]]
    cols["hist"] = cols["f_hist_avail"].astype(int)
    cols["clean"] = cols["label_requires_review"] == 0
    cols["rule_auto"] = cols["rule_decision"] == AUTO
    cols["no_data_issue"] = np.array([v is None for v in cols["label_data_issue"]])
    cols["acute"] = np.isin(cols["meta_ward"], ["IPD", "ER"])
    cols["_row"] = np.arange(len(rows))
    return Frame(cols)


def has_any(errors, targets):
    return np.array([bool(e & targets) for e in errors], dtype=bool)


COMMON_FEATURES = ["hist_avail", "n_deltas", "delta_ms", "delta_max_abs", "log_days_since_prev", "acute_setting", "age_dec", "sex_m"]
DISCIPLINE_FEATURES = {"CHEM": ["dilution_score", "na_cl_gap", "k_minus_ca", "k_minus_alp"], "HEME": ["recent_transfusion", "mchc_dev"]}


def allowed_features(discipline):
    """FIXED allow-list (exact names). Anything else exported with an f_ prefix is never learned from."""
    names = COMMON_FEATURES + DISCIPLINE_FEATURES[discipline]
    names += [f"{k}_{t}" for t in MODEL_TESTS[discipline] for k in ("m", "z", "d", "ad")]
    return ["f_" + n for n in names]


def check_export_columns(df: Frame):
    """Refuse unknown f_ columns: a new export column must be reviewed and added to the allow-list on purpose."""
    known = set(allowed_features("CHEM")) | set(allowed_features("HEME"))
    unknown = sorted(c for c in df.columns if c.startswith("f_") and c not in known)
    if unknown:
        raise SystemExit(f"Unknown feature columns in export (not in allow-list): {unknown}")


def feature_columns(train: Frame, discipline: str, drop_acute: bool = False):
    """Allow-listed columns of this discipline; a column entirely missing is dropped based on TRAIN only."""
    cols = [c for c in allowed_features(discipline) if c in train.cols and not np.isnan(train[c]).all()]
    if drop_acute:
        cols = [c for c in cols if c != "f_acute_setting"]
    return cols


def in_key_scope(df: Frame, det) -> np.ndarray:
    """Key features present → evaluable. Otherwise NOT_EVALUABLE (never PASS)."""
    ok = np.ones(len(df), dtype=bool)
    for t in det["key_tests"]:
        ok &= df[f"f_m_{t}"] == 1
    if det["min_tests"]:
        ok &= df["meta_coverage_used"] >= det["min_tests"]
    return ok


# ---------------------------------------------------------------- models
class Stratified:
    """One sub-model per (panel x history) stratum, each on the columns never missing in that stratum (no imputation)."""

    def __init__(self, make, cols):
        self.make, self.cols, self.models, self.used = make, cols, {}, {}

    @staticmethod
    def strata(df):
        return np.array([f"{p}|{h}" for p, h in zip(df["meta_panel"], df["hist"])])

    def fit(self, df, y):
        s = self.strata(df)
        X = df.matrix(self.cols)
        for key in np.unique(s):
            m = s == key
            sub, yy = X[m], y[m]
            use = [j for j in range(len(self.cols)) if not np.isnan(sub[:, j]).any() and np.unique(sub[:, j]).size > 1]
            if yy.sum() == 0 or yy.sum() == len(yy):
                self.models[key] = ("const", float(yy.mean()))
                continue
            model = self.make()
            model.fit(sub[:, use], yy)
            self.models[key], self.used[key] = ("model", model), use
        return self

    def predict(self, df):
        out = np.full(len(df), np.nan)
        s = self.strata(df)
        X = df.matrix(self.cols)
        for key, (kind, m) in self.models.items():
            idx = np.flatnonzero(s == key)
            if not len(idx):
                continue
            if kind == "const":
                out[idx] = m
                continue
            Xs = X[idx][:, self.used[key]]
            ok = ~np.isnan(Xs).any(axis=1)  # a column unexpectedly missing → not evaluable for this row
            if ok.any():
                out[idx[ok]] = m.predict_proba(Xs[ok])[:, 1]
        return out


class Native:
    """Single model that receives NaN directly (trees)."""

    def __init__(self, make, cols):
        self.make, self.cols = make, cols

    def fit(self, df, y):
        self.model = self.make()
        self.model.fit(df.matrix(self.cols), y)
        return self

    def predict(self, df):
        return self.model.predict_proba(df.matrix(self.cols))[:, 1]


def maker(algo, hp, pos_ratio):
    spw = float(min(25.0, max(1.0, pos_ratio / 4)))
    if algo == "logreg":
        return lambda: make_pipeline(StandardScaler(), LogisticRegression(C=hp["C"], max_iter=3000, class_weight="balanced"))
    if algo == "xgboost":
        return lambda: xgb.XGBClassifier(max_depth=hp["max_depth"], n_estimators=hp["n_estimators"], learning_rate=0.05, subsample=0.8,
                                         colsample_bytree=0.8, min_child_weight=2, scale_pos_weight=spw, tree_method="hist",
                                         eval_metric="aucpr", random_state=SEED, n_jobs=4, verbosity=0)
    if algo == "lightgbm":
        return lambda: lgb.LGBMClassifier(num_leaves=hp["num_leaves"], n_estimators=hp["n_estimators"], learning_rate=0.05, subsample=0.8,
                                          subsample_freq=1, colsample_bytree=0.8, min_child_samples=10, scale_pos_weight=spw,
                                          random_state=SEED, n_jobs=4, verbose=-1)
    raise ValueError(algo)


def build(algo, config, hp, cols, pos_ratio):
    mk = maker(algo, hp, pos_ratio)
    if config == "same_input" or algo == "logreg":
        return Stratified(mk, cols)
    return Native(mk, cols)


def cv_select(algo, config, cols, train, y):
    """GroupKFold(5) by subject on train; the hyper-parameters with the best mean average precision."""
    pos_ratio = (len(y) - y.sum()) / max(1, y.sum())
    folds = list(GroupKFold(n_splits=5).split(np.zeros(len(y)), y, groups=train["meta_subject"]))
    best, best_ap, table = None, -1.0, []
    for hp in GRIDS[algo]:
        aps = []
        for tr, va in folds:
            m = build(algo, config, hp, cols, pos_ratio).fit(train.sub(tr), y[tr])
            p = m.predict(train.sub(va))
            ok = ~np.isnan(p)
            if 0 < y[va][ok].sum() < ok.sum():
                aps.append(average_precision_score(y[va][ok], p[ok]))
        ap = float(np.mean(aps)) if aps else float("nan")
        table.append({**hp, "cv_ap": ap})
        if ap > best_ap:
            best, best_ap = hp, ap
    return best, table, pos_ratio


# ---------------------------------------------------------------- evaluation helpers
def incremental(test: Frame, flagged: np.ndarray, target_mask: np.ndarray, n_boot: int = 500):
    """Primary criterion: errors caught in addition to rules, and extra false alarms, vs rule-only (engine, model OFF)."""
    auto, clean = test["rule_auto"], test["clean"]
    n_target = int(target_mask.sum())
    missed_by_rule = target_mask & auto
    added = missed_by_rule & flagged
    extra_hold = auto & flagged
    false_alarm = extra_hold & clean
    b_added, b_fa = [], []
    for idx in subject_boot_indices(test["meta_subject"], n_boot):
        m = missed_by_rule[idx].sum()
        b_added.append(added[idx].sum() / m if m else None)
        b_fa.append(1000 * false_alarm[idx].sum() / len(idx))
    return {
        "reports": int(len(test)),
        "targetErrors": n_target,
        "ruleCaught": rate((target_mask & ~auto).sum(), n_target),
        "addedCatchOfAllTarget": rate(added.sum(), n_target),
        "addedCatchOfRuleMissed": {**rate(added.sum(), missed_by_rule.sum()), "ci95_subject_bootstrap": boot_ci(b_added)},
        "stillMissedAfterModel": rate((missed_by_rule & ~flagged).sum(), n_target),
        "extraHoldsAll": {**rate(extra_hold.sum(), len(test)), "per1000": 1000 * extra_hold.sum() / max(1, len(test))},
        "extraFalseAlarmOnCleanRuleAuto": rate(false_alarm.sum(), (clean & auto).sum()),
        "extraFalseAlarmPer1000Reports": {"value": 1000 * false_alarm.sum() / max(1, len(test)), "ci95_subject_bootstrap": boot_ci(b_fa)},
        "extraHoldsOnOtherReviewNeeded": int((extra_hold & ~clean & ~target_mask).sum()),
    }


def classifier_metrics(scores, y, thr, subjects, boot=True):
    ev = ~np.isnan(scores)
    s, yy = scores[ev], y[ev]
    out = {"evaluable": rate(ev.sum(), len(scores)), "positives": int(yy.sum()), "n": int(len(yy))}
    if 0 < yy.sum() < len(yy):
        out["prAuc"] = float(average_precision_score(yy, s))
        out["rocAuc"] = float(roc_auc_score(yy, s))
        out["prevalenceInSet"] = float(yy.mean())
        if boot:
            boots = [average_precision_score(yy[i], s[i]) for i in subject_boot_indices(subjects[ev]) if 0 < yy[i].sum() < len(i)]
            out["prAuc_ci95_subject_bootstrap"] = boot_ci(boots)
    if thr is not None:
        flag = s >= thr
        tp, fn = int((flag & (yy == 1)).sum()), int((~flag & (yy == 1)).sum())
        fp, tn = int((flag & (yy == 0)).sum()), int((~flag & (yy == 0)).sum())
        sens, spec = rate(tp, tp + fn), rate(tn, tn + fp)
        out.update(threshold=thr, tp=tp, fp=fp, fn=fn, tn=tn, sensitivity=sens, specificity=spec, flagRate=rate(tp + fp, len(yy)),
                   ppvAtAssumedPrevalence=[{"prevalence": p, "ppv": ppv_at(sens["value"], spec["value"], p)} for p in PREVALENCES],
                   sensitivityFullScope=rate(tp, int(y.sum())))  # NOT_EVALUABLE positives count as missed
    return out


def by_group(test, flagged, target_mask):
    auto = test["rule_auto"]
    groups = {"withHistory": test["hist"] == 1, "noHistory90d": test["hist"] == 0, "trueFirstVisit": test["meta_prior_ever"] == 0}
    return {g: {"reports": int(m.sum()), "detected": rate((flagged & target_mask & m).sum(), (target_mask & m).sum()),
                "addedVsRule": rate((flagged & target_mask & m & auto).sum(), (target_mask & m & auto).sum()),
                "extraFalseAlarmOnCleanRuleAuto": rate((flagged & m & auto & test["clean"]).sum(), (m & auto & test["clean"]).sum())}
            for g, m in groups.items()}


def by_error_type(test, flagged):
    out = {}
    auto = test["rule_auto"]
    for e in sorted(set().union(*test["errors"])):
        m = has_any(test["errors"], frozenset({e}))
        out[e] = {"n": int(m.sum()), "ruleCaught": rate((m & ~auto).sum(), m.sum()), "modelFlagged": rate((m & flagged).sum(), m.sum()),
                  "ruleOrModel": rate((m & (~auto | flagged)).sum(), m.sum()), "addedVsRule": rate((m & auto & flagged).sum(), m.sum())}
    return out


def analytical_breakdown(test, flagged):
    m = has_any(test["errors"], frozenset({"analytical_single"}))
    info = test["label_analytical"]
    out = {}
    for lo, hi in ((0.08, 0.2), (0.2, 0.35), (0.35, 0.61)):
        sel = np.array([bool(mm and isinstance(i, dict) and lo <= i["magnitude"] < hi) for mm, i in zip(m, info)])
        out[f"magnitude_{round(lo * 100)}-{round(min(hi, 0.6) * 100)}%"] = rate((sel & flagged).sum(), sel.sum())
    for name, want in (("seenAnalytes", False), ("holdoutAnalytes_testOnly", True)):
        sel = np.array([bool(mm and isinstance(i, dict) and i.get("holdoutAnalyte") == want) for mm, i in zip(m, info)])
        out[name] = rate((sel & flagged).sum(), sel.sum())
    by_test = {}
    for mm, i, f in zip(m, info, flagged):
        if mm and isinstance(i, dict):
            b = by_test.setdefault(i["test"], [0, 0])
            b[0] += int(f)
            b[1] += 1
    out["byAnalyte"] = {t: rate(k, n) for t, (k, n) in sorted(by_test.items())}
    return out


# ---------------------------------------------------------------- supervised detectors
def run_supervised(df, ablation_drop_acute=False, boot=True):
    results, flags = {}, {}
    for det in DETECTORS:
        t0 = time.time()
        d = df.sub((df["meta_discipline"] == det["discipline"]) & df["no_data_issue"])
        y_all = has_any(d["errors"], det["targets"]).astype(int)
        key_ok = in_key_scope(d, det)
        split = d["meta_split"]
        cols = feature_columns(d.sub(split == "train"), det["discipline"], drop_acute=ablation_drop_acute)
        tr_m, va_m, te_m = (split == "train") & key_ok, (split == "val") & key_ok, split == "test"
        tr, va, te = d.sub(tr_m), d.sub(va_m), d.sub(te_m)
        ytr, yva, yte = y_all[tr_m], y_all[va_m], y_all[te_m]
        te_key = key_ok[te_m]
        det_res = {"name": det["name"], "discipline": det["discipline"], "targets": sorted(det["targets"]), "recallTarget": det["recall"],
                   "keyFeatures": det["key_tests"], "minTests": det["min_tests"], "features": cols,
                   "split": {k: {"n": int((split == k).sum()), "positives": int(y_all[split == k].sum()),
                                 "evaluable": int(((split == k) & key_ok).sum()), "evaluablePositives": int(y_all[(split == k) & key_ok].sum())}
                             for k in ("train", "val", "test")},
                   "configs": {}}
        if yva.sum() < 10:
            det_res["warning"] = f"Chỉ có {int(yva.sum())} ca dương tính ở val — ngưỡng không tin cậy."
        for config in ("best_per_algorithm", "same_input"):
            det_res["configs"][config] = {}
            for algo in ("logreg", "xgboost", "lightgbm"):
                if config == "same_input" and algo == "logreg":
                    det_res["configs"][config][algo] = {"sameAs": "best_per_algorithm.logreg (LR luôn theo tầng panel × lịch sử)"}
                    continue
                hp, table, pos_ratio = cv_select(algo, config, cols, tr, ytr)
                model = build(algo, config, hp, cols, pos_ratio).fit(tr, ytr)
                sva = model.predict(va)
                okv = ~np.isnan(sva)
                thr = pick_threshold(sva[okv], yva[okv], det["recall"])
                ste = model.predict(te)
                ste[~te_key] = np.nan  # NOT_EVALUABLE: key features missing
                flagged = (~np.isnan(ste)) & (np.nan_to_num(ste, nan=-np.inf) >= (thr if thr is not None else np.inf))
                target = yte == 1
                res = {
                    "hyperparameters": hp, "cvTable": table,
                    "validation": {"positives": int(yva[okv].sum()), "n": int(okv.sum()),
                                   "prAuc": float(average_precision_score(yva[okv], sva[okv])) if 0 < yva[okv].sum() < okv.sum() else None},
                    "thresholdSelection": f"Ngưỡng lớn nhất sao cho điểm ≥ ngưỡng đạt recall ≥ {det['recall']:.0%} trên {int(yva[okv].sum())} ca dương tính val",
                    "test": classifier_metrics(ste, yte, thr, te["meta_subject"], boot=boot),
                }
                if boot:
                    res.update(vsRuleOnly=incremental(te, flagged, target), byHistoryGroup=by_group(te, flagged, target),
                               byErrorType=by_error_type(te, flagged))
                    if "analytical_single" in det["targets"]:
                        res["analyticalBreakdown"] = analytical_breakdown(te, flagged)
                det_res["configs"][config][algo] = res
                if config == "best_per_algorithm":
                    flags.setdefault(det["key"], {})[algo] = (te["_row"], flagged, max(r["cv_ap"] for r in table))
        results[det["key"]] = det_res
        print(f"  {det['key']:16s} {time.time() - t0:6.1f}s", flush=True)
    return results, flags


# ---------------------------------------------------------------- first-visit anomaly detection (Farrell 2024 style)
class GaussianScorer:
    def fit(self, X):
        self.cov = EmpiricalCovariance().fit(X)
        return self

    def score(self, X):
        return self.cov.mahalanobis(X)


class KnnScorer:
    def __init__(self, k=10):
        self.k = k

    def fit(self, X):
        self.scaler = StandardScaler().fit(X)
        self.nn = NearestNeighbors(n_neighbors=self.k).fit(self.scaler.transform(X))
        return self

    def score(self, X):
        d, _ = self.nn.kneighbors(self.scaler.transform(X))
        return d.mean(axis=1)


class OcsvmScorer:
    def fit(self, X):
        self.scaler = StandardScaler().fit(X)
        self.svm = OneClassSVM(kernel="rbf", nu=0.05, gamma="scale").fit(self.scaler.transform(X))
        return self

    def score(self, X):
        return -self.svm.decision_function(self.scaler.transform(X))


ANOMALY = {"gaussian": GaussianScorer, "knn": KnnScorer, "ocsvm": OcsvmScorer}
REF_SUBSAMPLE = 3000  # the same reference subset would be shipped to the JS runtime (KNN / OCSVM support vectors)


def run_anomaly(df):
    out, flags_all = {}, {name: {} for name in ANOMALY}
    for panel, tests in PANEL_TESTS.items():
        cols = [f"f_z_{t}" for t in tests]
        base = (df["meta_panel"] == panel) & df["no_data_issue"]
        X_all = df.matrix(cols)
        base &= ~np.isnan(X_all).any(axis=1)
        tr_idx = np.flatnonzero(base & (df["meta_split"] == "train"))  # routine data, NOT filtered by label (as Farrell 2024)
        if len(tr_idx) > REF_SUBSAMPLE:
            tr_idx = np.sort(rng().choice(tr_idx, REF_SUBSAMPLE, replace=False))
        # Threshold calibrated on TRUE first visits of val (never seen before); applied to every report without
        # comparable history ≤90 days, which is reported split into true first visits vs returning patients.
        va_m = base & (df["meta_split"] == "val") & (df["meta_prior_ever"] == 0)
        te_m = base & (df["meta_split"] == "test") & (df["hist"] == 0)
        te = df.sub(te_m)
        y = has_any(te["errors"], CONTAM_ANALYTICAL).astype(int)
        out[panel] = {"inputs": cols, "trainReference": int(len(tr_idx)), "valFirstVisit": int(va_m.sum()), "testFirstVisit": int(te_m.sum()),
                      "testPositives": int(y.sum()), "models": {}}
        for name, cls in ANOMALY.items():
            m = cls().fit(X_all[tr_idx])
            thr = float(np.quantile(m.score(X_all[va_m]), 0.95))
            ste = m.score(X_all[te_m]).astype(float)
            flagged = ste >= thr
            target = y == 1
            clean, acute = te["clean"], te["acute"]
            no_err = np.array([not e for e in te["errors"]])  # no sample/analytical error (data issues already excluded)
            path = (te["label_critical"] == 1) | np.array([p is not None for p in te["label_pathology"]])
            first = te["meta_prior_ever"] == 0
            out[panel]["models"][name] = {
                "thresholdSelection": "Phân vị 95% điểm bất thường trên phiếu người khám lần đầu thật (chưa từng có kết quả) của val — tỷ lệ gắn cờ cố định 5%",
                "threshold": thr,
                "test": classifier_metrics(ste, y, thr, te["meta_subject"]),
                "vsRuleOnly": incremental(te, flagged, target),
                "byErrorType": by_error_type(te, flagged),
                "flagRateTestTrueFirstVisit": rate((flagged & first).sum(), first.sum()),
                "flagRateTestReturningNo90dHistory": rate((flagged & ~first).sum(), (~first).sum()),
                "detectedTrueFirstVisit": rate((flagged & target & first).sum(), (target & first).sum()),
                "detectedReturningNo90dHistory": rate((flagged & target & ~first).sum(), (target & ~first).sum()),
                # Real disease, correct specimen: no sample error / data issue, but acute admission or critical/pathology flag.
                "flagRateRealDiseaseAcute": rate((flagged & no_err & acute).sum(), (no_err & acute).sum()),
                "flagRateRealDiseaseCriticalOrPathology": rate((flagged & no_err & path).sum(), (no_err & path).sum()),
                "flagRateCleanOutpatient": rate((flagged & clean & ~acute).sum(), (clean & ~acute).sum()),
                "flagRateOtherSampleErrors": rate((flagged & ~no_err & ~target).sum(), (~no_err & ~target).sum()),
            }
            flags_all[name].update(zip(te["_row"].tolist(), flagged.tolist()))
        print(f"  anomaly {panel} done", flush=True)
    return out, flags_all


def first_visit_policy(df, anomaly_flags, model_name):
    """ALWAYS_REVIEW (default) vs MODEL_FLAG_ONLY, CHEM first-visit test reports (the scope of CHEM-H02)."""
    te = df.sub((df["meta_split"] == "test") & (df["meta_discipline"] == "CHEM") & (df["hist"] == 0))
    f = [anomaly_flags.get(int(r)) for r in te["_row"]]
    evaluable = np.array([v is not None for v in f])
    flagged = np.array([bool(v) for v in f])
    rule = te["rule_decision"] != AUTO
    rule_wo = te["rule_decision_without_first_visit"] != AUTO
    h02 = te["rule_first_visit_failed"] == 1
    always = rule | flagged
    # MODEL_FLAG_ONLY: CHEM-H02 replaced by the anomaly flag; NOT_EVALUABLE → fall back to ALWAYS_REVIEW (keep H02).
    only = rule_wo | flagged | (h02 & ~evaluable)
    err = np.array([bool(e) for e in te["errors"]])
    needs = te["label_requires_review"] == 1
    released = always & ~only
    return {
        "anomalyModel": model_name, "reports": int(len(te)), "heldByFirstVisitRule": int(h02.sum()),
        "notEvaluableFallback": int((h02 & ~evaluable).sum()),
        "policies": {n: {"autoApprove": rate((~h).sum(), len(te)), "missedSampleErrors": rate((~h & err).sum(), err.sum()),
                         "missedNeedsReview": rate((~h & needs).sum(), needs.sum())} for n, h in (("ALWAYS_REVIEW", always), ("MODEL_FLAG_ONLY", only))},
        "releasedByModelFlagOnly": {"n": int(released.sum()), "withSampleError": int((released & err).sum()),
                                    "withAnyReviewNeed": int((released & needs).sum()),
                                    "errorTypes": sorted({e for e, r in zip(te["errors"], released) if r for e in e})},
    }


def combined(df, sup_flags, choice, anomaly_flags):
    """Rules + every chosen supervised detector (union, counted once) + first-visit anomaly model."""
    out = {}
    for disc in ("CHEM", "HEME"):
        te = df.sub((df["meta_split"] == "test") & (df["meta_discipline"] == disc))
        pos = {int(r): i for i, r in enumerate(te["_row"])}
        sup = np.zeros(len(te), dtype=bool)
        for key, algo in choice.items():
            if not key.startswith(disc.lower()):
                continue
            rows, f, _ = sup_flags[key][algo]
            for r, ff in zip(rows, f):
                if ff:
                    sup[pos[int(r)]] = True
        both = sup.copy()
        for r, ff in anomaly_flags.items():
            if ff and r in pos:
                both[pos[r]] = True
        target = has_any(te["errors"], CONTAM_ANALYTICAL)
        out[disc] = {"supervisedOnly": incremental(te, sup, target), "supervisedPlusFirstVisitAnomaly": incremental(te, both, target),
                     "byErrorType": by_error_type(te, both)}
    return out


def to_json(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.ndarray,)):
        return o.tolist()
    if isinstance(o, (set, frozenset)):
        return sorted(o)
    return str(o)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--features", default=str(ROOT / "data/synthetic/bench/features.jsonl"))
    ap.add_argument("--out", default=str(ROOT / "reports/benchmark.json"))
    a = ap.parse_args()
    t0 = time.time()
    df = load(Path(a.features))
    check_export_columns(df)
    print(f"Loaded {len(df)} reports", flush=True)
    sup, sup_flags = run_supervised(df)
    print("Ablation: without acute_setting (ward)", flush=True)
    sup_abl, _ = run_supervised(df, ablation_drop_acute=True, boot=False)
    ano, ano_flags = run_anomaly(df)
    # Pre-specified: per detector, the algorithm with the best GroupKFold CV average precision on TRAIN (val only sets thresholds);
    # anomaly model: KNN (best overall in Farrell 2024), fixed before running.
    choice = {k: max(v.items(), key=lambda kv: (kv[1][2] if kv[1][2] is not None else -1))[0] for k, v in sup_flags.items()}
    report = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "disclaimer": "Mọi con số chỉ đúng trên dữ liệu GIẢ LẬP (tỷ lệ lỗi làm giàu ≈10–50× thực tế, lỗi do chính generator tiêm vào). "
                      "Không phản ánh hiệu năng trên dữ liệu thật; không dùng làm tiêu chí nghiệm thu.",
        "data": {"features": Path(a.features).relative_to(ROOT).as_posix() if Path(a.features).is_relative_to(ROOT) else a.features,
                 "reports": int(len(df)), "splits": {s: int((df["meta_split"] == s).sum()) for s in ("train", "val", "test")},
                 "note": "Bộ benchmark riêng: 10.000 người bệnh giả lập, seed 20261117, không có WBIT."},
        "definitions": {
            "addedCatchOfRuleMissed": "Số lỗi mục tiêu rule cho AUTO nhưng mô hình gắn cờ / số lỗi mục tiêu rule cho AUTO",
            "addedCatchOfAllTarget": "Như trên nhưng mẫu số là toàn bộ lỗi mục tiêu",
            "extraFalseAlarmOnCleanRuleAuto": "Phiếu không có lỗi mẫu/dữ liệu/tới hạn/cờ bệnh lý, rule cho AUTO, mô hình gắn cờ / số phiếu sạch rule cho AUTO",
            "extraHoldsAll": "Mọi phiếu rule cho AUTO mà mô hình gắn cờ (gồm cả bệnh thật, lỗi khác)",
            "sensitivityFullScope": "Độ nhạy tính cả ca dương tính NOT_EVALUABLE (thiếu đặc trưng then chốt) là bỏ sót",
            "configs": "best_per_algorithm: LR theo tầng panel × lịch sử, cây nhận NaN trực tiếp; same_input: cả ba thuật toán cùng tầng và cùng cột",
            "ci": "ci95_wilson: Wilson (coi các phiếu độc lập); ci95_subject_bootstrap: bootstrap cụm theo người bệnh",
        },
        "supervised": sup,
        "ablationWithoutAcuteSetting_testPrAuc": {k: {c: {al: (v.get("test", {}).get("prAuc")) for al, v in cfg.items()} for c, cfg in d["configs"].items()}
                                                  for k, d in sup_abl.items()},
        "firstVisitAnomaly": ano,
        "chosenAlgorithmByTrainCvAp": choice,
        "firstVisitPolicy": first_visit_policy(df, ano_flags["knn"], "knn"),
        "combinedVsRuleOnly": combined(df, sup_flags, choice, ano_flags["knn"]),
    }
    report["runtimeSeconds"] = round(time.time() - t0, 1)
    Path(a.out).write_text(json.dumps(report, ensure_ascii=False, indent=1, default=to_json), encoding="utf-8")
    print(f"Saved {a.out} in {report['runtimeSeconds']}s", flush=True)


if __name__ == "__main__":
    main()
