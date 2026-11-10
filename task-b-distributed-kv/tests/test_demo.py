"""Partition demonstrations are callable from tests and from ``python -m kvsim demo``."""

from __future__ import annotations

import unittest

import support
from kvsim.demo import run_model_comparison, run_partition_demo


class PartitionDemoTest(unittest.TestCase):
    def test_eventual_demo_diverges_then_converges(self) -> None:
        result = run_partition_demo("eventual", seed=1)
        self.assertIn("最终一致性", result.narrative)
        self.assertTrue(result.diverged, result.narrative)
        self.assertEqual(result.during_values[1], "red")
        self.assertEqual(result.during_values[3], "green")
        self.assertFalse(result.mid_checker_passed, result.checker_report)
        self.assertTrue(result.converged, result.narrative)
        self.assertEqual(result.winner, "green")
        self.assertTrue(result.checker_passed, result.checker_report)

    def test_linearizable_demo_minority_loses(self) -> None:
        result = run_partition_demo("linearizable", seed=1)
        self.assertIn("线性一致性", result.narrative)
        self.assertEqual(result.minority_status, "timeout", result.narrative)
        self.assertEqual(result.majority_status, "ok", result.narrative)
        self.assertEqual(result.winner, "v3", result.narrative)
        self.assertTrue(result.converged, result.narrative)
        self.assertTrue(result.checker_passed, result.checker_report)

    def test_models_are_switchable_on_the_same_entry_point(self) -> None:
        eventual, linear = run_model_comparison(seed=1)
        self.assertNotEqual(eventual.model, linear.model)
        self.assertTrue(eventual.diverged)
        self.assertEqual(linear.minority_status, "timeout")
        self.assertTrue(eventual.checker_passed)
        self.assertTrue(linear.checker_passed)

    def test_demo_helpers_match_a_manually_driven_cluster(self) -> None:
        # The demo is not a special code path: the same calls are public.
        cluster = support.eventual(3, seed=9, ae_interval=20)
        client = cluster.client("c")
        self.assertTrue(client.put("k", "a", contact=0).ok)
        cluster.partition({0}, {1, 2})
        self.assertTrue(client.put("k", "b", contact=1).ok)
        self.assertFalse(cluster.verify(durable=False).passed)
        cluster.heal()
        cluster.run(200)
        self.assertTrue(cluster.verify(durable=True).passed, cluster.debug_state())


if __name__ == "__main__":
    unittest.main()
