"""Train an experimental binary XGBoost detector; JSON in/out for Node integration."""
import json
import math
import sys

import numpy as np
import xgboost as xgb

sys.stdout.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8")
payload = json.load(sys.stdin)
features, rows = payload["features"], payload["rows"]
train = [r for r in rows if r["split"] == "train"]
val = [r for r in rows if r["split"] == "val"]
test = [r for r in rows if r["split"] == "test"]

def matrix(items):
    vals = [[np.nan if v is None else v for v in r["values"]] for r in items]
    return xgb.DMatrix(np.asarray(vals, dtype=float), label=[r["label"] for r in items], feature_names=features)

positive = sum(r["label"] for r in train)
params = {"objective": "binary:logistic", "eval_metric": "logloss", "tree_method": "hist",
          "max_depth": 3, "eta": 0.05, "subsample": 0.8, "colsample_bytree": 0.8,
          "lambda": 1.0, "scale_pos_weight": max(1.0, (len(train) - positive) / max(1, positive)),
          "seed": 20261116, "nthread": 1}
booster = xgb.train(params, matrix(train), num_boost_round=200, verbose_eval=False)
recall_target = payload.get("recallTarget", 0.8)
scores = booster.predict(matrix(val))
positive_scores = sorted(s for s, r in zip(scores, val) if r["label"])
if not positive_scores:
    raise ValueError("Validation split has no positive examples for " + payload["key"])
threshold = positive_scores[max(0, len(positive_scores) - math.ceil(recall_target * len(positive_scores)))]
test_scores = booster.predict(matrix(test))
y = [r["label"] for r in test]
pred = [int(s >= threshold) for s in test_scores]
tp = sum(bool(a and b) for a, b in zip(y, pred)); fp = sum(bool((not a) and b) for a, b in zip(y, pred))
fn = sum(bool(a and (not b)) for a, b in zip(y, pred)); tn = len(y) - tp - fp - fn

cfg = json.loads(booster.save_config())
base = float(cfg["learner"]["learner_model_param"]["base_score"].strip("[]").split(",")[0])
base_margin = math.log(base / (1 - base))
def compact(node):
    if "leaf" in node: return {"nodeid": node["nodeid"], "leaf": node["leaf"]}
    return {"nodeid": node["nodeid"], "split": node["split"], "condition": node["split_condition"],
            "yes": node["yes"], "no": node["no"], "missing": node["missing"],
            "children": [compact(c) for c in node["children"]]}

model = {
    "key": payload["key"], "name": payload["name"], "version": payload["key"] + "-xgboost-0.1.0",
    "algorithm": "XGBoost JSON trees", "discipline": payload["discipline"], "targets": payload["targets"],
    "requiresHistory": payload["requiresHistory"], "scope": payload["scope"], "features": features,
    "trees": [compact(json.loads(t)) for t in booster.get_dump(dump_format="json")], "baseMargin": base_margin,
    "threshold": float(threshold), "recallTarget": recall_target,
    "trainedOn": {"train": len(train), "positives": positive, "validation": len(val), "test": len(test)},
    "syntheticTest": {"tp": int(tp), "fp": int(fp), "fn": int(fn), "tn": int(tn),
                      "sensitivity": tp / (tp + fn) if tp + fn else None,
                      "specificity": tn / (tn + fp) if tn + fp else None},
    "status": "NGHIÊN CỨU — dữ liệu giả lập; chỉ được nâng lên MANUAL_REVIEW; chưa thẩm định",
}
json.dump(model, sys.stdout, ensure_ascii=True)
