"""Print the key tables of reports/benchmark.json (synthetic data only)."""
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")
from pathlib import Path

p = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "reports/benchmark.json"
b = json.loads(p.read_text(encoding="utf-8"))


def pc(r):
    if r is None or r.get("value") is None:
        return "—"
    lo, hi = r.get("ci95_wilson", [None, None])
    ci = f" [{lo * 100:.1f}–{hi * 100:.1f}]" if lo is not None else ""
    return f"{r['k']}/{r['n']} {r['value'] * 100:.1f}%{ci}"


def f3(x):
    return "—" if x is None else f"{x:.3f}"


print(b["disclaimer"])
print("\n== Supervised detectors (test) ==")
for key, d in b["supervised"].items():
    print(f"\n{key}: {d['name']} | split {d['split']}")
    for cfg, algos in d["configs"].items():
        for algo, r in algos.items():
            if "sameAs" in r:
                continue
            t, v = r["test"], r.get("vsRuleOnly", {})
            ci = t.get("prAuc_ci95_subject_bootstrap", [None, None])
            ppv = ", ".join(f"{x['prevalence'] * 100:g}%→{f3(x['ppv'])}" for x in t.get("ppvAtAssumedPrevalence", []))
            print(f"  [{cfg:18s} {algo:8s}] valPR {f3(r['validation']['prAuc'])} | testPR {f3(t.get('prAuc'))} [{f3(ci[0])}–{f3(ci[1])}] "
                  f"| sens {pc(t.get('sensitivity'))} | spec {pc(t.get('specificity'))} | sensFull {pc(t.get('sensitivityFullScope'))}")
            if v:
                print(f"      PPV {ppv}")
                print(f"      added/ruleMissed {pc(v['addedCatchOfRuleMissed'])} | extraFA/cleanAuto {pc(v['extraFalseAlarmOnCleanRuleAuto'])} "
                      f"| FA per1000 {v['extraFalseAlarmPer1000Reports']['value']:.1f} | rule caught {pc(v['ruleCaught'])}")
            if "analyticalBreakdown" in r and cfg == "best_per_algorithm":
                ab = r["analyticalBreakdown"]
                print("      " + " | ".join(f"{k} {pc(x)}" for k, x in ab.items() if k != "byAnalyte"))
            if "byHistoryGroup" in r and cfg == "best_per_algorithm":
                print("      " + " | ".join(f"{g}: det {pc(x['detected'])}" for g, x in r["byHistoryGroup"].items()))

print("\nChosen by train CV AP:", b["chosenAlgorithmByTrainCvAp"])
print("\n== Ablation without acute_setting (test PR-AUC) ==")
for k, v in b["ablationWithoutAcuteSetting_testPrAuc"].items():
    print(" ", k, {c: {a: f3(x) for a, x in al.items()} for c, al in v.items()})

print("\n== First-visit anomaly (test, no history ≤90d) ==")
for panel, d in b["firstVisitAnomaly"].items():
    print(f"\n{panel}: ref {d['trainReference']} | test first-visit {d['testFirstVisit']} (pos {d['testPositives']})")
    for name, r in d["models"].items():
        t, v = r["test"], r["vsRuleOnly"]
        print(f"  {name:8s} PR {f3(t.get('prAuc'))} | sens {pc(t.get('sensitivity'))} | flag {pc(t.get('flagRate'))} "
              f"| added/ruleMissed {pc(v['addedCatchOfRuleMissed'])} | extraFA/cleanAuto {pc(v['extraFalseAlarmOnCleanRuleAuto'])} "
              f"| diseaseAcute {pc(r['flagRateRealDiseaseAcute'])} crit/path {pc(r['flagRateRealDiseaseCriticalOrPathology'])} cleanOPD {pc(r['flagRateCleanOutpatient'])}")
        print(f"           flag trueFirst {pc(r['flagRateTestTrueFirstVisit'])} returning {pc(r['flagRateTestReturningNo90dHistory'])} | det trueFirst {pc(r['detectedTrueFirstVisit'])} returning {pc(r['detectedReturningNo90dHistory'])}")

print("\n== First-visit policy (CHEM, test) ==")
fv = b["firstVisitPolicy"]
print(json.dumps({k: fv[k] for k in ("reports", "heldByFirstVisitRule", "notEvaluableFallback", "releasedByModelFlagOnly")}, ensure_ascii=False))
for n, x in fv["policies"].items():
    print(f"  {n:16s} auto {pc(x['autoApprove'])} | missed errors {pc(x['missedSampleErrors'])} | missed needs-review {pc(x['missedNeedsReview'])}")

print("\n== Combined: rules + chosen detectors (+ first-visit KNN) vs rule-only ==")
for disc, d in b["combinedVsRuleOnly"].items():
    for k in ("supervisedOnly", "supervisedPlusFirstVisitAnomaly"):
        v = d[k]
        print(f"  {disc} {k:32s} targets {v['targetErrors']} | rule caught {pc(v['ruleCaught'])} | added/ruleMissed {pc(v['addedCatchOfRuleMissed'])} "
              f"| extraFA/cleanAuto {pc(v['extraFalseAlarmOnCleanRuleAuto'])} | FA/1000 {v['extraFalseAlarmPer1000Reports']['value']:.1f} "
              f"{v['extraFalseAlarmPer1000Reports']['ci95_subject_bootstrap']} | extra holds/1000 {v['extraHoldsAll']['per1000']:.1f}")
    print("   per type: " + " | ".join(f"{e}: rule {x['ruleCaught']['value'] * 100:.0f}% → +model {x['ruleOrModel']['value'] * 100:.0f}% (n={x['n']})"
                                       for e, x in d["byErrorType"].items()))
