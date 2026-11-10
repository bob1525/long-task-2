"""Numerical checks of the constants in Theorem 1 and Section 3.2.

The estimator does not call this module. Figure 3 hard-codes ``α_m``. These
integrals exist so the tabulated constants can be compared with Equation (3)
and with the standard-error constant ``β_m``.

Section 3.2 defines

    J_s(m) = ∫_0^∞ u^s (log2((2 + u) / (1 + u)))^m du
    α_m = 1 / (m J_0(m))
    β_m = √m * √(J_1(m) / J_0(m)^2 − 1)

and ``β_∞ = √(3 log 2 − 1) .= 1.03896``, where ``log`` is the natural logarithm
(the numerical value matches ``√(3 ln 2 − 1)``, not a base-2 logarithm).
"""

from __future__ import annotations

import functools
import math
import random

from hll.hyperloglog import HyperLogLog

# Theorem 1 (p. 131) publishes these as .= approximations, to three decimals.
PUBLISHED_BETA = {16: 1.106, 32: 1.070, 64: 1.054, 128: 1.046}


def beta_infinity() -> float:
    """``√(3 ln 2 − 1)``, the limit of ``β_m`` in Theorem 1 and Equation (29)."""

    return math.sqrt(3.0 * math.log(2.0) - 1.0)


def typical_relative_error(m: int) -> float:
    """The program's stated typical relative error, ``1.04 / √m`` (Figure 3)."""

    if m <= 0:
        raise ValueError("m must be positive")
    return 1.04 / math.sqrt(m)


def _log2_ratio(u: float) -> float:
    """``f(u) = log2((2 + u) / (1 + u))``, the integrand base of Equation (3)."""

    if u == 0.0:
        return 1.0
    return math.log((2.0 + u) / (1.0 + u)) / math.log(2.0)


def _simpson(integrand, left: float, right: float, steps: int) -> float:
    if steps % 2:
        steps += 1
    width = (right - left) / steps
    total = integrand(left) + integrand(right)
    for index in range(1, steps):
        weight = 4 if index % 2 else 2
        total += weight * integrand(left + index * width)
    return total * width / 3.0


@functools.lru_cache(maxsize=None)
def moment_integral(m: int, s: int) -> float:
    """``J_s(m)`` by Simpson quadrature, refined near the origin.

    ``f(u)^m`` for large ``m`` is concentrated on an interval of width about
    ``1/m``, so a uniform grid over ``[0, ∞)`` under-samples it. The pieces
    below put the fine grid where the mass is. The tail past 120 is negligible
    for every ``m ≥ 16`` used here: ``f(120) < 0.012`` and that to the 16th
    power is already far below ``10^{-30}``.
    """

    if m < 1 or s < 0:
        raise ValueError("m ≥ 1 and s ≥ 0 are required")

    def integrand(u: float) -> float:
        return (u**s) * (_log2_ratio(u) ** m)

    pieces = (
        (0.0, 0.5, 200_000),
        (0.5, 2.0, 100_000),
        (2.0, 8.0, 40_000),
        (8.0, 30.0, 20_000),
        (30.0, 120.0, 10_000),
    )
    return sum(_simpson(integrand, left, right, steps) for left, right, steps in pieces)


def alpha_from_integral(m: int) -> float:
    """``α_m = 1 / (m J_0(m))`` from Equation (3) and Section 3.2."""

    return 1.0 / (m * moment_integral(m, 0))


def beta_from_integral(m: int) -> float:
    """``β_m`` from the formula in Section 3.2."""

    j0 = moment_integral(m, 0)
    j1 = moment_integral(m, 1)
    return math.sqrt(m * (j1 / (j0 * j0) - 1.0))


def sample_relative_errors(
    precision: int, cardinality: int, trials: int, seed: int
) -> list[float]:
    """Relative errors ``(E* − n) / n`` on ideal 32-bit multisets.

    Definition 1 draws continuous uniform hashes. Figure 3 hashes to 32 bits.
    For cardinalities far below ``2^32`` the collision probability is negligible,
    so uniform 32-bit words are the model the program's error statement refers
    to. Each trial uses an independent ``random.Random`` stream.
    """

    if trials <= 0 or cardinality < 0:
        raise ValueError("trials must be positive and cardinality non-negative")
    errors: list[float] = []
    for offset in range(trials):
        rng = random.Random(seed + offset)
        sketch = HyperLogLog(precision)
        for _ in range(cardinality):
            sketch.add_hash(rng.getrandbits(32))
        estimate = sketch.count()
        if cardinality == 0:
            errors.append(estimate)
        else:
            errors.append((estimate - cardinality) / cardinality)
    return errors


def summarize_errors(errors: list[float], m: int) -> dict[str, float]:
    """Bias, empirical standard error, and Gaussian coverage against ``1.04/√m``."""

    count = len(errors)
    if count < 2:
        raise ValueError("need at least two trials")
    mean = sum(errors) / count
    variance = sum((error - mean) ** 2 for error in errors) / (count - 1)
    empirical = math.sqrt(variance)
    theory = typical_relative_error(m)
    coverage = {
        band: sum(abs(error) <= band * theory for error in errors) / count
        for band in (1, 2, 3)
    }
    return {
        "trials": float(count),
        "bias": mean,
        "empirical_se": empirical,
        "theoretical_se": theory,
        "se_ratio": empirical / theory,
        "within_1_sigma": coverage[1],
        "within_2_sigma": coverage[2],
        "within_3_sigma": coverage[3],
    }
