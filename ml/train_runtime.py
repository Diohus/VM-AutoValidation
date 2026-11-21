"""Train the DEPLOYED models with exactly the configuration that was benchmarked, and export them as JSON for the
dependency-free JS runtime (src/core/model.js). Also writes tests/fixtures/model-parity.json: library scores on a few
hundred synthetic reports, so the JS inference is checked against XGBoost / scikit-learn.

Deployed (decision 17/11/2026):
- supervised models listed in reports/benchmark.json → "deployed" (XGBoost; PR #2 configuration kept unless clearly beaten).
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


DEPLOY_META = {
    "chem_wbit": {"name": "Nghi nhầm mẫu (WBIT) — hóa sinh", "paper": "Tortosa-Carreres (CCLM), theo tổng quan nghiên cứu",
                  "scopeNote": "Chỉ phiếu có lịch sử ≤90 ngày (không có lịch sử thì không so sánh được); đặc trưng độ lệch so với lần trước."},
    "heme_wbit": {"name": "Nghi nhầm mẫu (WBIT) — CBC", "paper": "Graham 2025 (Clinical Chemistry), theo tổng quan nghiên cứu",
                  "scopeNote": "Chỉ phiếu có lịch sử ≤90 ngày; đặc trưng thay đổi có hướng và độ lớn so với lần trước, truyền máu gần đây."},
    "chem_ivfluid": {"name": "Nghi lẫn dịch truyền (NaCl 0,9% / glucose 5%) — hóa sinh", "paper": "Spies 2025 (Clinical Chemistry), theo tổng quan nghiên cứu",
                     "scopeNote": "Mọi phiếu hóa sinh có Na, Cl, glucose; dùng thêm lịch sử ≤90 ngày khi có (thiếu thì nhánh 'thiếu' của cây, không điền giá trị)."},
    "chem_contam": {"name": "Nghi nhiễm mẫu gộp (EDTA / NaCl / glucose 5%) — hóa sinh", "paper": "Spies 2025; Farrell 2024 (theo tổng quan)",
                    "scopeNote": "Mọi phiếu hóa sinh có dữ liệu hợp lệ."},
}


def main():
    t0 = time.time()
    bench = json.loads((ROOT / "reports/benchmark.json").read_text(encoding="utf-8"))
    df = B.load(ROOT / "data/synthetic/bench/features.jsonl")
    B.check_export_columns(df)
    MODELS.mkdir(exist_ok=True)
    for old in MODELS.glob("*.json"):  # only what the benchmark selected stays deployed
        old.unlink()
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    fixture = {"note": "Điểm do thư viện Python tính trên phiếu giả lập; test JS phải khớp.", "models": {}}

    # ---------------- supervised models chosen by the benchmark (reports/benchmark.json → "deployed") ----------------
    for key, algo in bench["deployed"].items():
        det = next(d for d in B.DETECTORS if d["key"] == key)
        meta = DEPLOY_META[key]
        res = bench["supervised"][key]["configs"]["best_per_algorithm"][algo]
        hp, cols = res["hyperparameters"], res["features"]
        disc = det["discipline"]
        d = df.sub((df["meta_discipline"] == disc) & df["no_data_issue"])
        y = B.has_any(d["errors"], det["targets"]).astype(int)
        key_ok = B.in_key_scope(d, det)
        split = d["meta_split"]
        trm, vam, tem = (split == "train") & key_ok, (split == "val") & key_ok, (split == "test") & key_ok
        tr, va, te = d.sub(trm), d.sub(vam), d.sub(tem)
        pos_ratio = (len(y[trm]) - y[trm].sum()) / max(1, y[trm].sum())
        if algo not in ("xgb_teammate", "xgboost"):
            raise SystemExit(f"{key}: {algo} has no JS exporter (the runtime only scores XGBoost trees; add an exporter + JS branch first)")
        model = B.build(algo, "best_per_algorithm", hp, cols, pos_ratio).fit(tr, y[trm])
        sva = model.predict(va)
        thr = B.pick_threshold(sva, y[vam], det["recall"])
        val_ap = float(average_precision_score(y[vam], sva))
        assert abs(val_ap - res["validation"]["prAuc"]) < 1e-9, (key, val_ap, res["validation"]["prAuc"])  # identical to the benchmarked model
        names = [c[2:] for c in cols]
        g = B.rng()
        idx = np.unique(np.concatenate([g.choice(len(te), min(250, len(te)), replace=False), np.flatnonzero(y[tem] == 1)[:50]]))
        booster = model.model.get_booster()
        exp = export_xgboost(booster)
        dm = xgb.DMatrix(te.matrix(cols)[idx])
        raw = booster.predict(dm, output_margin=True)
        con = booster.predict(dm, pred_contribs=True, approx_contribs=True)  # XGBoost's own Saabas, checked one by one in JS
        rows = [{"features": feats_obj(te, cols, i), "margin": float(m), "contribs": [float(v) for v in c[:-1]], "bias": float(c[-1])}
                for i, m, c in zip(idx, raw, con)]
        algo_txt = "XGBoost — cấu hình PR #2 (depth 3, 200 cây, eta 0,05)" if algo == "xgb_teammate" else "XGBoost"
        t = res["test"]
        out = {
            "key": key, "kind": "tree_ensemble", **exp, "features": names, "name": meta["name"], "version": f"{key}-{algo}-1.0.0",
            "algorithm": f"{algo_txt}, suy luận bằng JS từ JSON; giải thích theo từng phiếu bằng phân bổ theo đường đi (Saabas)",
            "discipline": disc, "targets": sorted(det["targets"]), "scope": "history" if det.get("requires_history") else "all",
            "keyTests": det["key_tests"], "coverageTests": B.MODEL_TESTS[disc], "scopeNote": meta["scopeNote"], "paperBasis": meta.get("paper"),
            "threshold": thr, "recallTarget": det["recall"], "hyperparameters": hp,
            "selection": bench["selection"][key]["reason"],
            "thresholdSelection": f"Ngưỡng lớn nhất đạt recall ≥ {det['recall']:.0%} trên {int(y[vam].sum())} ca dương tính của tập validation (bộ benchmark).",
            "trainedOn": {"dataset": "bench seed 20261117", "train": int(trm.sum()), "positives": int(y[trm].sum()), "validation": int(vam.sum())},
            "benchmarkTest": {"prAuc": t.get("prAuc"), "sensitivity": t["sensitivity"], "specificity": t["specificity"],
                              "addedCatchOfRuleMissed": res["vsRuleOnly"]["addedCatchOfRuleMissed"],
                              "extraFalseAlarmOnCleanRuleAuto": res["vsRuleOnly"]["extraFalseAlarmOnCleanRuleAuto"]},
            "trainedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "status": STATUS, "disclaimer": DISCLAIMER,
        }
        (MODELS / f"{key}.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
        fixture["models"][key] = {"file": f"models/{key}.json", "source": exp["source"], "rows": rows}
        print(f"{key}: {algo}, thr {thr:.4f}, val AP {val_ap:.3f}, {len(exp['trees'])} trees")

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

    # Rules ↔ models must match exactly (Codex r4): a deployed model no rule calls, or a rule pointing at a model that is not
    # deployed, would silently run rules only for that error family.
    referenced = set()
    for f in ("config/rules.chem.json", "config/rules.heme.json"):
        for r in json.loads((ROOT / f).read_text(encoding="utf-8"))["rules"]:
            if r["type"] == "model_score":
                referenced |= set(r["params"].get("modelByPanel", {}).values()) | ({r["params"]["model"]} if "model" in r["params"] else set())
    exported = {p.stem for p in MODELS.glob("*.json")}
    if referenced != exported:
        raise SystemExit(f"Rules and models disagree — referenced only by rules: {sorted(referenced - exported)}; "
                         f"exported but not used by any rule: {sorted(exported - referenced)}. Update config/rules.*.json first.")
    FIXTURE.write_text(json.dumps(fixture), encoding="utf-8")
    print(f"Saved models/*.json and {FIXTURE.relative_to(ROOT)} in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
