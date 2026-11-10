import math
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hll.hyperloglog import HyperLogLog


def ideal_sketch(words, precision: int) -> HyperLogLog:
    sketch = HyperLogLog(precision)
    for word in words:
        sketch.add_hash(word)
    return sketch


class RandomTests(unittest.TestCase):
    """Property and Monte Carlo cases. Every subTest is one random case."""

    def test_forty_intermediate_cardinalities_stay_within_five_sigma(self):
        # Figure 3: typical relative error 1.04/√m. Five sigma still rejects a
        # constant-factor bug and, under the Section 4 Gaussian model, is not a
        # flake for 40 draws (a standard normal exceeds 5 about once in 1.7e6 trials).
        rng = random.Random(20261110)
        precision = 10
        sigma = 1.04 / math.sqrt(1 << precision)
        for case in range(40):
            cardinality = rng.randint(4_000, 60_000)
            seed = rng.randrange(2**31)
            words = _words(cardinality, seed)
            with self.subTest(case=case, n=cardinality, seed=seed):
                estimate = ideal_sketch(words, precision).estimate()
                self.assertEqual(estimate.regime, "intermediate")
                relative = abs(estimate.value - cardinality) / cardinality
                self.assertLessEqual(relative, 5 * sigma)

    def test_thirty_small_cardinalities_track_linear_counting(self):
        # n ≤ 300 and m = 4096 lie well below the (5/2) m threshold. The raw
        # estimator is several times too large here (Section 4 (ii)); linear
        # counting is not. The allowance is several times the error observed
        # for this regime and still far below the uncorrected bias.
        rng = random.Random(4242)
        precision = 12
        for case in range(30):
            cardinality = rng.randint(1, 300)
            seed = rng.randrange(2**31)
            with self.subTest(case=case, n=cardinality, seed=seed):
                estimate = ideal_sketch(_words(cardinality, seed), precision).estimate()
                self.assertEqual(estimate.regime, "small")
                self.assertLessEqual(abs(estimate.value - cardinality), max(3.0, 0.2 * cardinality))

    def test_thirty_permutations_leave_the_registers_unchanged(self):
        rng = random.Random(11)
        for case in range(30):
            precision = rng.randint(4, 12)
            count = rng.randint(1, 400)
            words = _words(count, rng.randrange(2**31))
            shuffled = list(words)
            rng.shuffle(shuffled)
            with self.subTest(case=case, b=precision, n=count):
                self.assertEqual(
                    ideal_sketch(words, precision).registers,
                    ideal_sketch(shuffled, precision).registers,
                )

    def test_thirty_replicated_streams_match_the_underlying_set(self):
        rng = random.Random(13)
        for case in range(30):
            precision = rng.randint(4, 12)
            count = rng.randint(1, 200)
            words = _words(count, rng.randrange(2**31))
            replicated: list[int] = []
            for word in words:
                replicated.extend([word] * rng.randint(1, 5))
            rng.shuffle(replicated)
            with self.subTest(case=case, b=precision, n=count):
                self.assertEqual(
                    ideal_sketch(words, precision).registers,
                    ideal_sketch(replicated, precision).registers,
                )

    def test_thirty_random_merges_match_the_union_registers(self):
        # Footnote 4, including overlapping parts: component-wise max equals the
        # sketch of the concatenated stream.
        rng = random.Random(17)
        for case in range(30):
            precision = rng.randint(4, 10)
            left_n = rng.randint(1, 250)
            right_n = rng.randint(1, 250)
            left_words = _words(left_n, rng.randrange(2**31))
            right_words = _words(right_n, rng.randrange(2**31))
            if rng.randrange(2):
                # Force a shared block so the parts are not a partition.
                share = left_words[: max(1, left_n // 3)]
                right_words = share + right_words
            with self.subTest(case=case, b=precision):
                left = ideal_sketch(left_words, precision)
                right = ideal_sketch(right_words, precision)
                union = ideal_sketch(left_words + right_words, precision)
                self.assertEqual(left.merge(right).registers, union.registers)


def _words(count: int, seed: int) -> list[int]:
    rng = random.Random(seed)
    return [rng.getrandbits(32) for _ in range(count)]


if __name__ == "__main__":
    unittest.main()
