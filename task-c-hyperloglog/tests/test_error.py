import math
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hll.hyperloglog import HyperLogLog
from hll.analysis import (
    PUBLISHED_BETA,
    alpha_from_integral,
    beta_from_integral,
    beta_infinity,
    sample_relative_errors,
    summarize_errors,
)


class IntegralTests(unittest.TestCase):
    def test_beta_infinity_matches_theorem1(self):
        # √(3 ln 2 − 1) .= 1.03896.
        self.assertAlmostEqual(beta_infinity(), 1.03896, delta=1e-5)

    def test_figure3_alphas_round_the_equation3_integral(self):
        # Equation (3) evaluated numerically, then rounded to the three decimals
        # printed in Figure 3. m = 16, 32, 64 are the tabulated exceptions.
        published = {16: 0.673, 32: 0.697, 64: 0.709}
        for m, constant in published.items():
            with self.subTest(m=m):
                self.assertEqual(round(alpha_from_integral(m), 3), constant)

    def test_large_m_formula_tracks_the_integral(self):
        # Figure 3's closed form for m ≥ 128 against Equation (3).
        for m in (128, 256, 1024, 4096):
            formula = 0.7213 / (1.0 + 1.079 / m)
            with self.subTest(m=m):
                self.assertAlmostEqual(alpha_from_integral(m), formula, delta=1e-4)

    def test_published_betas_match_section32(self):
        # Theorem 1 gives β_m to three decimals with the .= sign. The integral
        # formula of Section 3.2 lands within 0.001 of each published figure
        # (β_32 integrates to about 1.0708, which is why the tolerance is 0.001
        # rather than half a unit in the last place).
        for m, published in PUBLISHED_BETA.items():
            with self.subTest(m=m):
                self.assertAlmostEqual(beta_from_integral(m), published, delta=1e-3)


class ErrorMeasurementTests(unittest.TestCase):
    def test_intermediate_bias_and_standard_error(self):
        # Theorem 1: asymptotically almost unbiased, standard error β_m/√m,
        # and the program quotes the practical value 1.04/√m. m = 256, n = 20000
        # is inside the intermediate range ((5/2) m = 640, and 2^32/30 ≈ 1.43e8).
        precision = 8
        cardinality = 20_000
        trials = 200
        errors = sample_relative_errors(precision, cardinality, trials, seed=20261110)
        summary = summarize_errors(errors, 1 << precision)
        self.assertLess(abs(summary["bias"]), 0.015)
        self.assertGreater(summary["se_ratio"], 0.75)
        self.assertLess(summary["se_ratio"], 1.25)
        # Section 4: about 65% / 95% / 99% of estimates fall inside 1σ / 2σ / 3σ.
        # The bands below leave room for a sample of 200 while still rejecting
        # an estimator whose spread is a small constant times the prediction.
        self.assertGreater(summary["within_1_sigma"], 0.50)
        self.assertLess(summary["within_1_sigma"], 0.85)
        self.assertGreater(summary["within_2_sigma"], 0.90)
        self.assertGreater(summary["within_3_sigma"], 0.96)

    def test_relative_standard_error_shrinks_like_one_over_sqrt_m(self):
        # Same cardinality family, two register counts. The empirical SE should
        # move with 1/√m. Comparing the ratio of SEs avoids depending on one seed's bias.
        small = summarize_errors(sample_relative_errors(8, 30_000, 80, seed=7), 256)
        large = summarize_errors(sample_relative_errors(10, 30_000, 80, seed=7), 1024)
        # √(1024/256) = 2. Allow a wide factor so only a flat error curve fails.
        ratio = small["empirical_se"] / large["empirical_se"]
        self.assertGreater(ratio, 1.4)
        self.assertLess(ratio, 2.8)
        self.assertAlmostEqual(math.sqrt(1024 / 256), 2.0)

    def test_estimates_stay_sane_across_the_small_range_boundary(self):
        # m = 256, so (5/2)m = 640. The program switches on the raw estimate,
        # and both sides of that switch should stay near the stated error
        # rather than falling back to the uncorrected α_m m bias.
        precision = 8
        for cardinality in (400, 640, 800):
            errors = []
            for trial in range(20):
                rng = random.Random(1000 * cardinality + trial)
                sketch = HyperLogLog(precision)
                for _ in range(cardinality):
                    sketch.add_hash(rng.getrandbits(32))
                errors.append((sketch.count() - cardinality) / cardinality)
            mean = sum(errors) / len(errors)
            self.assertLess(abs(mean), 0.05)
            self.assertLess(max(abs(error) for error in errors), 0.30)


if __name__ == "__main__":
    unittest.main()
