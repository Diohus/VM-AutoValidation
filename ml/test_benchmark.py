"""Regression tests for ml/benchmark.py (run: .venv/Scripts/python -m unittest ml/test_benchmark.py)."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benchmark as B  # noqa: E402


def frame(**cols):
    return B.Frame({k: np.asarray(v) for k, v in cols.items()})


class ThresholdTests(unittest.TestCase):
    def test_threshold_is_the_largest_reaching_recall(self):
        # Codex round 1: "smallest threshold reaching recall" would flag everything.
        scores = np.array([0.9, 0.8, 0.7, 0.6, 0.1, 0.05])
        y = np.array([1, 1, 1, 1, 0, 0])
        self.assertEqual(B.pick_threshold(scores, y, 0.75), 0.7)
        self.assertEqual(B.pick_threshold(scores, y, 1.0), 0.6)
        self.assertIsNone(B.pick_threshold(scores, np.zeros(6, dtype=int), 0.9))


class AllowListTests(unittest.TestCase):
    def test_unknown_export_column_is_refused(self):
        # Codex round 2: a stray f_* column (e.g. a label or ivInfusion) must never be learned from silently.
        df = frame(f_z_K=[1.0], f_ivInfusion=[1.0])
        with self.assertRaises(SystemExit):
            B.check_export_columns(df)
        B.check_export_columns(frame(f_z_K=[1.0], f_mchc_dev=[0.2], meta_x=["a"]))

    def test_all_missing_columns_dropped_using_train_only(self):
        # Codex round 2: column selection must not look at val/test.
        train = frame(f_z_K=[1.0, 2.0], f_z_CA=[np.nan, np.nan], f_acute_setting=[0.0, 1.0])
        cols = B.feature_columns(train, "CHEM")
        self.assertIn("f_z_K", cols)
        self.assertNotIn("f_z_CA", cols)
        self.assertNotIn("f_acute_setting", B.feature_columns(train, "CHEM", drop_acute=True))
        self.assertTrue(all(c in B.allowed_features("CHEM") for c in cols))


class StratifiedTests(unittest.TestCase):
    def test_no_imputation_and_unseen_stratum_is_not_evaluable(self):
        rng = np.random.default_rng(0)
        n = 200
        x = rng.normal(size=n)
        y = (x > 0.5).astype(int)
        tr = frame(meta_panel=np.array(["CHEM_EXT"] * n, dtype=object), hist=np.zeros(n, dtype=int), f_z_K=x, f_d_K=np.full(n, np.nan))
        m = B.Stratified(B.maker("logreg", {"C": 1.0}, 1.0), ["f_z_K", "f_d_K"]).fit(tr, y)
        self.assertEqual(m.used["CHEM_EXT|0"], [0])  # the always-missing delta column is not used (nothing imputed)
        te = frame(meta_panel=np.array(["CHEM_EXT", "CHEM_BASIC"], dtype=object), hist=np.array([0, 0]),
                   f_z_K=np.array([2.0, 2.0]), f_d_K=np.array([np.nan, np.nan]))
        p = m.predict(te)
        self.assertTrue(np.isfinite(p[0]))
        self.assertTrue(np.isnan(p[1]))  # stratum never seen in training → NOT_EVALUABLE, not a score


class IncrementalTests(unittest.TestCase):
    def test_added_catch_and_false_alarm_denominators(self):
        # 4 reports: target error missed by rule & flagged (added), target caught by rule, clean auto flagged (FA), clean auto not flagged.
        te = frame(rule_auto=np.array([True, False, True, True]), clean=np.array([False, False, True, True]),
                   meta_subject=np.array(["a", "b", "c", "d"], dtype=object))
        flagged = np.array([True, False, True, False])
        target = np.array([True, True, False, False])
        r = B.incremental(te, flagged, target, n_boot=20)
        self.assertEqual((r["addedCatchOfRuleMissed"]["k"], r["addedCatchOfRuleMissed"]["n"]), (1, 1))
        self.assertEqual((r["addedCatchOfAllTarget"]["k"], r["addedCatchOfAllTarget"]["n"]), (1, 2))
        self.assertEqual((r["extraFalseAlarmOnCleanRuleAuto"]["k"], r["extraFalseAlarmOnCleanRuleAuto"]["n"]), (1, 2))
        self.assertEqual(r["extraHoldsAll"]["k"], 2)


class FirstVisitPolicyTests(unittest.TestCase):
    def test_model_flag_only_falls_back_when_not_evaluable(self):
        # Codex round 1: a report held by CHEM-H02 must stay held when the anomaly model cannot score it.
        df = frame(meta_split=np.array(["test"] * 3, dtype=object), meta_discipline=np.array(["CHEM"] * 3, dtype=object),
                   hist=np.zeros(3, dtype=int), _row=np.arange(3),
                   rule_decision=np.array(["MANUAL_REVIEW"] * 3, dtype=object),
                   rule_decision_without_first_visit=np.array([B.AUTO] * 3, dtype=object),
                   rule_first_visit_failed=np.ones(3), label_requires_review=np.zeros(3),
                   errors=np.array([frozenset()] * 3, dtype=object))
        flags = {0: False, 1: True}  # row 2: not evaluable
        r = B.first_visit_policy(df, flags, "knn")
        self.assertEqual(r["notEvaluableFallback"], 1)
        self.assertEqual(r["releasedByModelFlagOnly"]["n"], 1)  # only row 0 (evaluable, not flagged) is released
        self.assertEqual(r["policies"]["ALWAYS_REVIEW"]["autoApprove"]["k"], 0)


if __name__ == "__main__":
    unittest.main()
