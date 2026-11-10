"""At least 20 seeded fault scenarios, each closed by the consistency checker."""

from __future__ import annotations

import unittest

import support
from kvsim.faults import SCENARIO_COUNT, format_report, run_all, run_fault_scenario


class FaultInjectionTest(unittest.TestCase):
    def test_scenario_count_meets_the_bar(self) -> None:
        self.assertGreaterEqual(SCENARIO_COUNT, 20)

    def test_one_scenario_of_each_model_is_reproducible(self) -> None:
        first = run_fault_scenario(1)
        second = run_fault_scenario(1)
        self.assertEqual(first.passed, second.passed)
        self.assertEqual(first.detail, second.detail)
        self.assertEqual(first.model, "eventual")
        linear = run_fault_scenario(2)
        self.assertEqual(linear.model, "linearizable")
        self.assertTrue(first.passed, first.detail)
        self.assertTrue(linear.passed, linear.detail)

    def test_random_fault_suite(self) -> None:
        support  # imported so the package path is installed before the runner
        results = run_all()
        report = format_report(results)
        print("\n" + report)
        self.assertEqual(len(results), SCENARIO_COUNT)
        self.assertGreaterEqual(len(results), 20)
        failed = [result for result in results if not result.passed]
        self.assertEqual(failed, [], report)
        self.assertIn(f"total={SCENARIO_COUNT} passed={SCENARIO_COUNT} failed=0", report)


if __name__ == "__main__":
    unittest.main()
