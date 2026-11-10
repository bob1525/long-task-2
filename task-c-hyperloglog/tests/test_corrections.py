import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hll.estimate import HASH_SPACE, alpha_m, apply_corrections, raw_estimate
from hll.hyperloglog import HyperLogLog


def near(testcase: unittest.TestCase, actual: float, expected: float) -> None:
    testcase.assertTrue(
        math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-9),
        msg=f"{actual} != {expected}",
    )


class AlphaTests(unittest.TestCase):
    def test_figure3_constants(self):
        self.assertEqual(alpha_m(16), 0.673)
        self.assertEqual(alpha_m(32), 0.697)
        self.assertEqual(alpha_m(64), 0.709)
        near(self, alpha_m(128), 0.7213 / (1.0 + 1.079 / 128))
        near(self, alpha_m(256), 0.7213 / (1.0 + 1.079 / 256))
        near(self, alpha_m(65536), 0.7213 / (1.0 + 1.079 / 65536))

    def test_m64_does_not_use_the_large_m_formula(self):
        # The formula is stated for m ≥ 128. At m = 64 it already differs from 0.709
        # in the fourth decimal, so substituting it is visible.
        formula = 0.7213 / (1.0 + 1.079 / 64)
        self.assertGreater(abs(formula - 0.709), 1e-4)
        self.assertEqual(alpha_m(64), 0.709)

    def test_undefined_sizes_are_rejected(self):
        with self.assertRaises(ValueError):
            alpha_m(8)


class RawEstimateTests(unittest.TestCase):
    def test_raw_formula_is_alpha_m_squared_over_the_sum(self):
        registers = [0, 1, 2, 3, 4, 5, 0, 2, 1, 6, 2, 0, 3, 1, 4, 2]
        harmonic = sum(math.ldexp(1.0, -rank) for rank in registers)
        expected = 0.673 * 16 * 16 / harmonic
        near(self, raw_estimate(registers), expected)

    def test_empty_raw_estimate_is_alpha_times_m(self):
        # Section 4 (ii): registers initialized at 0 return α_m * m ≈ 0.7 m when n = 0.
        for precision, alpha in ((4, 0.673), (5, 0.697), (6, 0.709)):
            sketch = HyperLogLog(precision)
            near(self, sketch.estimate().raw, alpha * sketch.m)


class CorrectionTests(unittest.TestCase):
    def test_zero_cardinality_is_corrected_to_zero(self):
        sketch = HyperLogLog(4)
        estimate = sketch.estimate()
        near(self, estimate.raw, 0.673 * 16)
        self.assertEqual(estimate.empty_registers, 16)
        self.assertEqual(estimate.regime, "small")
        self.assertEqual(estimate.value, 0.0)

    def test_one_element_uses_linear_counting(self):
        # A single observation leaves V = m − 1, whatever ρ it produced.
        # Section 4 (ii): E* = m ln(m / V) while the raw estimate is still ≤ (5/2) m.
        sketch = HyperLogLog(4)
        sketch.add_hash(0)
        estimate = sketch.estimate()
        self.assertEqual(estimate.empty_registers, 15)
        self.assertEqual(estimate.regime, "small")
        near(self, estimate.value, 16 * math.log(16 / 15))

    def test_small_range_without_empty_registers_keeps_the_raw_estimate(self):
        # All registers equal to 1: V = 0, so the inner branch of Figure 3 keeps E.
        # E = α_m * 2 * m = 21.536 ≤ (5/2)*16 = 40, which is still the small range.
        sketch = HyperLogLog.from_registers([1] * 16)
        estimate = sketch.estimate()
        self.assertEqual(estimate.empty_registers, 0)
        self.assertEqual(estimate.regime, "small")
        near(self, estimate.raw, 0.673 * 2 * 16)
        near(self, estimate.value, estimate.raw)

    def test_branch_uses_the_raw_estimate_not_the_corrected_value(self):
        # V = 1 and a small raw E. Linear counting returns m ln(m), which is above
        # (5/2) m, but Figure 3 decides the branch from E and only then replaces E*.
        value, regime = apply_corrections(10.0, empty=1, m=16)
        self.assertEqual(regime, "small")
        near(self, value, 16 * math.log(16 / 1))
        self.assertGreater(value, 2.5 * 16)

    def test_small_range_includes_the_endpoint(self):
        # Figure 3: ``if E ≤ (5/2) m``. At exact equality the linear correction still applies.
        m = 16
        raw = 2.5 * m
        value, regime = apply_corrections(raw, empty=m // 2, m=m)
        self.assertEqual(regime, "small")
        near(self, value, m * math.log(m / (m // 2)))

    def test_intermediate_range_returns_the_raw_estimate(self):
        # All registers equal to 2: E = α_m * 4 * m = 43.072, just above (5/2)*16.
        sketch = HyperLogLog.from_registers([2] * 16)
        estimate = sketch.estimate()
        self.assertEqual(estimate.regime, "intermediate")
        near(self, estimate.raw, 0.673 * 4 * 16)
        near(self, estimate.value, estimate.raw)

    def test_large_range_threshold_is_strict(self):
        # Figure 3 applies the collision correction only for E > (1/30) 2^32.
        raw = HASH_SPACE / 30.0
        value, regime = apply_corrections(raw, empty=0, m=16)
        self.assertEqual(regime, "intermediate")
        near(self, value, raw)

    def test_large_range_inverts_the_collision_formula(self):
        # All registers 24. E = α_16 * m * 2^24, which sits between 2^32/30 and 2^32.
        # Section 4 (iii): E* = −2^32 ln(1 − E/2^32), and this is larger than E.
        sketch = HyperLogLog.from_registers([24] * 16)
        estimate = sketch.estimate()
        raw = 0.673 * 16 * 16 / (16 * math.ldexp(1.0, -24))
        expected = -HASH_SPACE * math.log(1.0 - raw / HASH_SPACE)
        self.assertEqual(estimate.regime, "large")
        near(self, estimate.raw, raw)
        near(self, estimate.value, expected)
        self.assertGreater(estimate.value, estimate.raw)

    def test_large_range_pole_follows_the_limit(self):
        # ρ(0^28) = 29 is reachable (b = 4 and a zero remainder). All sixteen such
        # hashes push every register to 29 and the raw harmonic mean past 2^32.
        # The inversion in Section 4 (iii) is only defined for E < 2^32; its limit is +∞.
        sketch = HyperLogLog.from_registers([29] * 16)
        estimate = sketch.estimate()
        self.assertGreaterEqual(estimate.raw, HASH_SPACE)
        self.assertEqual(estimate.regime, "large")
        self.assertTrue(math.isinf(estimate.value) and estimate.value > 0)

    def test_zero_remainder_in_every_bucket_is_a_reachable_pole(self):
        # The same vector produced by the hash split, not by writing registers directly.
        # index << 28 puts that index in the leading 4 bits and zeros in w.
        sketch = HyperLogLog(4)
        for index in range(16):
            sketch.add_hash(index << 28)
        self.assertEqual(sketch.registers, tuple(29 for _ in range(16)))
        estimate = sketch.estimate()
        self.assertEqual(estimate.regime, "large")
        self.assertTrue(math.isinf(estimate.value) and estimate.value > 0)

    def test_an_untouched_register_does_not_zero_the_estimate(self):
        # Section 4 (i): initializing at −∞ would force E = 0 as soon as any
        # substream is empty. The program initializes at 0, so one zero register
        # leaves a finite positive estimate.
        sketch = HyperLogLog.from_registers([0] + [10] * 15)
        self.assertGreater(sketch.count(), 1.0)
        self.assertNotEqual(sketch.estimate().raw, 0.0)


if __name__ == "__main__":
    unittest.main()
