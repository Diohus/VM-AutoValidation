"""Train the DEPLOYED models with exactly the configuration that was benchmarked, and export them as JSON for the
dependency-free JS runtime (src/core/model.js). Also writes tests/fixtures/model-parity.json: library scores on a few
hundred synthetic reports, so the JS inference is checked against XGBoost / LightGBM / scikit-learn.

Deployed (decision 17/11/2026):
- chem_ivfluid  : LightGBM, NaCl 0.9% / glucose 5% contamination (hyper-parameters = benchmark's train-CV choice).
- fv_chem_basic, fv_chem_ext, fv_cbc : first-visit KNN anomaly detectors (k=10, 5% flag rate on val true first visits).
Not deployed: EDTA (rules catch it), single-analyte analytical error (too many false alarms at the pre-set recall).

Run: .venv\\Scripts\\python ml/train_runtime.py   (after npm run bench:data and npm run bench)
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path

import numpy as np
import xgboost as xgb
from sklearn.metrics import average_precision_score

import benchmark as B

ROOT = B.ROOT
MODELS = ROOT / "models"
FIXTURE = ROOT / "tests/fixtures/model-parity.json"
STATUS = "NGHIÊN CỨU — dữ liệu giả lập; chỉ được nâng lên MANUAL_REVIEW; chưa thẩm định"
DISCLAIMER = "Huấn luyện và chọn ngưỡng trên dữ liệu GIẢ LẬP (bộ benchmark 10.000 người bệnh, seed 20261117)."


# ---------------------------------------------------------------- exporters (normalised tree format, see model.js)
def export_lightgbm(booster, n_features):
    dump = booster.dump_model()
    assert dump["objective"].startswith("binary"), dump["objective"]
    trees = []
    for info in dump["tree_info"]:
        nodes = []

        def walk(nd):
            i = len(nodes)
            nodes.append(None)
            if "leaf_value" in nd:
                nodes[i] = {"leaf": nd["leaf_value"], "v": nd["leaf_value"], "c": nd.get("leaf_count", 1)}
                return i
            assert nd["decision_type"] == "<=", nd["decision_type"]  # numerical splits only
            l = walk(nd["left_child"])
            r = walk(nd["right_child"])
            cl, cr = nodes[l]["c"], nodes[r]["c"]
            # Saabas needs E[output | node] = training-count-weighted mean of the leaves below (as LightGBM's
            # ExpectedValue); LightGBM's internal_value is the node's own fitted output, not that expectation (Codex r3).
            v = (cl * nodes[l]["v"] + cr * nodes[r]["v"]) / (cl + cr) if cl + cr > 0 else 0.5 * (nodes[l]["v"] + nodes[r]["v"])
            nodes[i] = {"f": nd["split_feature"], "t": nd["threshold"], "op": "<=", "mt": nd["missing_type"].lower(),
                        "dl": bool(nd["default_left"]), "l": l, "r": r, "v": v, "c": cl + cr}
            return i

        walk(info["tree_structure"])
        trees.append(nodes)
    assert all(0 <= n["f"] < n_features for t in trees for n in t if "f" in n)
    return {"source": "lightgbm", "baseMargin": 0.0, "trees": trees}


def export_xgboost(booster):
    cfg = json.loads(booster.save_config())
    base = float(cfg["learner"]["learner_model_param"]["base_score"].strip("[]").split(",")[0])
    trees = []
    for text in booster.get_dump(dump_format="json", with_stats=True):
        root = json.loads(text)
        nodes = []

        def walk(nd):
            i = len(nodes)
            nodes.append(None)
            if "leaf" in nd:
                nodes[i] = {"leaf": nd["leaf"], "v": nd["leaf"], "cover": nd["cover"]}
                return i
            kids = {c["nodeid"]: c for c in nd["children"]}
            l = walk(kids[nd["yes"]])
            r = walk(kids[nd["no"]])
            miss = l if nd["missing"] == nd["yes"] else r
            cl, cr = nodes[l]["cover"], nodes[r]["cover"]
            v = (cl * nodes[l]["v"] + cr * nodes[r]["v"]) / (cl + cr)  # expected output at the node (Saabas)
            nodes[i] = {"f": int(str(nd["split"]).lstrip("f")), "t": float(np.float32(nd["split_condition"])), "op": "<",
                        "miss": miss, "l": l, "r": r, "v": v, "cover": nd["cover"]}
            return i

        walk(root)
        for n in nodes:
            n["c"] = n.pop("cover")
        trees.append(nodes)
    return {"source": "xgboost", "baseMargin": math.log(base / (1 - base)), "trees": trees}


def feats_obj(df, cols, i):
    """Row i as the JS feature object (names without the f_ prefix, NaN → null)."""
    return {c[2:]: (None if np.isnan(df[c][i]) else float(df[c][i])) for c in cols}


def main():
    t0 = time.time()
    bench = json.loads((ROOT / "reports/benchmark.json").read_text(encoding="utf-8"))
    df = B.load(ROOT / "data/synthetic/bench/features.jsonl")
    B.check_export_columns(df)
    MODELS.mkdir(exist_ok=True)
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    fixture = {"note": "Điểm do thư viện Python tính trên phiếu giả lập; test JS phải khớp.", "models": {}}

    # ---------------- chem_ivfluid (LightGBM) ----------------
    det = next(d for d in B.DETECTORS if d["key"] == "chem_ivfluid")
    res = bench["supervised"]["chem_ivfluid"]["configs"]["best_per_algorithm"]["lightgbm"]
    hp = res["hyperparameters"]
    d = df.sub((df["meta_discipline"] == "CHEM") & df["no_data_issue"])
    y = B.has_any(d["errors"], det["targets"]).astype(int)
    key_ok = B.in_key_scope(d, det)
    split = d["meta_split"]
    cols = B.feature_columns(d.sub(split == "train"), "CHEM")
    assert cols == bench["supervised"]["chem_ivfluid"]["features"], "feature list differs from the benchmark"
    trm, vam, tem = (split == "train") & key_ok, (split == "val") & key_ok, (split == "test") & key_ok
    tr, va, te = d.sub(trm), d.sub(vam), d.sub(tem)
    pos_ratio = (len(y[trm]) - y[trm].sum()) / max(1, y[trm].sum())
    model = B.build("lightgbm", "best_per_algorithm", hp, cols, pos_ratio).fit(tr, y[trm])
    sva = model.predict(va)
    thr = B.pick_threshold(sva, y[vam], det["recall"])
    val_ap = float(average_precision_score(y[vam], sva))
    assert abs(val_ap - res["validation"]["prAuc"]) < 1e-9, (val_ap, res["validation"]["prAuc"])  # identical to the benchmarked model
    exp = export_lightgbm(model.model.booster_, len(cols))
    names = [c[2:] for c in cols]
    t = res["test"]
    out = {
        "key": "chem_ivfluid", "kind": "tree_ensemble", **exp, "features": names,
        "name": "Nghi lẫn dịch truyền (NaCl 0,9% / glucose 5%) — hóa sinh", "version": "chem_ivfluid-lightgbm-1.0.0",
        "algorithm": "LightGBM (cây quyết định tăng cường), suy luận bằng JS từ JSON; giải thích theo từng phiếu bằng phân bổ theo đường đi (Saabas)",
        "discipline": "CHEM", "targets": sorted(det["targets"]), "scope": "all", "keyTests": det["key_tests"], "coverageTests": B.MODEL_TESTS["CHEM"],
        "scopeNote": "Mọi phiếu hóa sinh có Na, Cl, glucose; dùng thêm lịch sử ≤90 ngày khi có (thiếu thì nhánh 'thiếu' của cây, không điền giá trị).",
        "threshold": thr, "recallTarget": det["recall"], "hyperparameters": hp,
        "thresholdSelection": f"Ngưỡng lớn nhất đạt recall ≥ {det['recall']:.0%} trên {int(y[vam].sum())} ca dương tính của tập validation (bộ benchmark).",
        "trainedOn": {"dataset": "bench seed 20261117", "train": int(trm.sum()), "positives": int(y[trm].sum()), "validation": int(vam.sum())},
        "benchmarkTest": {"prAuc": t.get("prAuc"), "sensitivity": t["sensitivity"], "specificity": t["specificity"],
                          "addedCatchOfRuleMissed": res["vsRuleOnly"]["addedCatchOfRuleMissed"],
                          "extraFalseAlarmOnCleanRuleAuto": res["vsRuleOnly"]["extraFalseAlarmOnCleanRuleAuto"]},
        "trainedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "status": STATUS, "disclaimer": DISCLAIMER,
    }
    (MODELS / "chem_ivfluid.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    # parity rows: random test reports + every positive + reports with zeros / missing history
    g = B.rng()
    idx = np.unique(np.concatenate([g.choice(len(te), 250, replace=False), np.flatnonzero(y[tem] == 1)[:50]]))
    raw = model.model.booster_.predict(te.matrix(cols)[idx], raw_score=True)
    fixture["models"]["chem_ivfluid"] = {"file": "models/chem_ivfluid.json",
                                         "rows": [{"features": feats_obj(te, cols, i), "margin": float(m)} for i, m in zip(idx, raw)]}
    print(f"chem_ivfluid: thr {thr:.4f}, val AP {val_ap:.3f}, {len(exp['trees'])} trees")

    # ---------------- small XGBoost model: exercises the float32 path of the shared scorer (not deployed) ----------------
    xb = xgb.XGBClassifier(max_depth=3, n_estimators=40, learning_rate=0.1, tree_method="hist", random_state=B.SEED, n_jobs=2)
    xb.fit(tr.matrix(cols), y[trm])
    xexp = export_xgboost(xb.get_booster())
    dm = xgb.DMatrix(te.matrix(cols)[idx])
    xraw = xb.get_booster().predict(dm, output_margin=True)
    # XGBoost's own Saabas attribution (approx_contribs): per-feature contributions + bias column, checked one by one in JS.
    xcon = xb.get_booster().predict(dm, pred_contribs=True, approx_contribs=True)
    fixture["models"]["xgboost_parity_only"] = {"model": {"key": "xgboost_parity_only", "kind": "tree_ensemble", "features": names, **xexp},
                                                "rows": [{"features": feats_obj(te, cols, i), "margin": float(m), "contribs": [float(v) for v in c[:-1]],
                                                          "bias": float(c[-1])} for i, m, c in zip(idx, xraw, xcon)]}

    # ---------------- first-visit KNN per panel ----------------
    for panel, tests in B.PANEL_TESTS.items():
        key = {"CHEM_BASIC": "fv_chem_basic", "CHEM_EXT": "fv_chem_ext", "CBC": "fv_cbc"}[panel]
        incols = [f"f_z_{t}" for t in tests]
        base = (df["meta_panel"] == panel) & df["no_data_issue"]
        X = df.matrix(incols)
        base &= ~np.isnan(X).any(axis=1)
        tr_idx = np.flatnonzero(base & (df["meta_split"] == "train"))
        if len(tr_idx) > B.REF_SUBSAMPLE:
            tr_idx = np.sort(B.rng().choice(tr_idx, B.REF_SUBSAMPLE, replace=False))  # same subset as the benchmark
        va_m = base & (df["meta_split"] == "val") & (df["meta_prior_ever"] == 0)
        m = B.KnnScorer(k=10).fit(X[tr_idx])
        thr = float(np.quantile(m.score(X[va_m]), 0.95))
        bres = bench["firstVisitAnomaly"][panel]["models"]["knn"]
        assert abs(thr - bres["threshold"]) < 1e-9, (panel, thr, bres["threshold"])
        ref = m.scaler.transform(X[tr_idx])
        disc = "CHEM" if panel.startswith("CHEM") else "HEME"
        out = {
            "key": key, "kind": "knn_anomaly", "panel": panel, "discipline": disc,
            "name": f"Bất thường đa chỉ số — người khám lần đầu ({panel})", "version": f"{key}-knn-1.0.0",
            "algorithm": "KNN: khoảng cách trung bình tới 10 phiếu tham chiếu gần nhất (chuẩn hóa theo train), theo Farrell 2024",
            "targets": sorted(B.CONTAM_ANALYTICAL), "scope": "noHistory90d", "coverageTests": tests,
            "inputs": [c[2:] for c in incols], "mean": m.scaler.mean_.tolist(), "scale": m.scaler.scale_.tolist(),
            "k": 10, "ref": [float(v) for v in ref.ravel()], "threshold": thr,
            "thresholdSelection": f"Phân vị 95% trên {int(va_m.sum())} phiếu người khám lần đầu thật của tập validation (tỷ lệ gắn cờ 5%).",
            "trainedOn": {"dataset": "bench seed 20261117", "reference": int(len(tr_idx)), "note": "Dữ liệu thường quy tập train, không lọc theo nhãn"},
            "benchmarkTest": {"prAuc": bres["test"].get("prAuc"), "sensitivity": bres["test"]["sensitivity"], "flagRate": bres["test"]["flagRate"],
                              "addedCatchOfRuleMissed": bres["vsRuleOnly"]["addedCatchOfRuleMissed"],
                              "extraFalseAlarmOnCleanRuleAuto": bres["vsRuleOnly"]["extraFalseAlarmOnCleanRuleAuto"]},
            "trainedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "status": STATUS, "disclaimer": DISCLAIMER,
        }
        (MODELS / f"{key}.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
        te_idx = np.flatnonzero(base & (df["meta_split"] == "test") & (df["hist"] == 0))[:100]
        fixture["models"][key] = {"file": f"models/{key}.json",
                                  "rows": [{"features": {c[2:]: float(X[i, j]) for j, c in enumerate(incols)}, "score": float(s)}
                                           for i, s in zip(te_idx, m.score(X[te_idx]))]}
        print(f"{key}: thr {thr:.4f}, ref {len(tr_idx)}")

    FIXTURE.write_text(json.dumps(fixture), encoding="utf-8")
    print(f"Saved models/*.json and {FIXTURE.relative_to(ROOT)} in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
