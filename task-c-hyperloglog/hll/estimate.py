"""Raw harmonic-mean estimate and the range corrections of Figure 3.

Figure 2 defines the estimator. The program in Figure 3 (Section 4) is the
one implemented here: registers start at 0, and two corrections are applied
to the raw estimate. With the indicator of Equation (2),

    Z = (sum_j 2^{-M[j]})^{-1}

Equation (3) and the program both return the normalized harmonic mean

    E = α_m * m^2 * Z.

Figure 3 states the constants that the program actually uses:

    α_16 = 0.673,  α_32 = 0.697,  α_64 = 0.709,
    α_m = 0.7213 / (1 + 1.079/m)   for m ≥ 128.

That closed form is the Laplace approximation (28)–(29): ``0.7213 ≈ 1/(2 ln 2)``
and ``1.079 ≈ 3 ln 2 − 1``. The integral definition of ``α_m`` in Equation (3)
is evaluated separately in ``hll.analysis``; the estimator itself follows the
program's tabulated values.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

# Figure 3 hashes onto 32-bit words, so the large-range model uses L = 32.
HASH_SPACE = 1 << 32


@dataclass(frozen=True)
class Estimate:
    """The value ``E*`` returned by Figure 3, plus the inputs of that decision.

    ``raw`` is the uncorrected ``E``. ``regime`` is ``small``, ``intermediate``,
    or ``large``, matching the three braces in the program. ``empty_registers``
    is ``V``, the number of registers still equal to their initial 0.
    """

    value: float
    raw: float
    regime: str
    empty_registers: int


def alpha_m(m: int) -> float:
    """Bias-correction constant from the program in Figure 3, not a recomputed integral."""

    if m == 16:
        return 0.673
    if m == 32:
        return 0.697
    if m == 64:
        return 0.709
    if m >= 128:
        return 0.7213 / (1.0 + 1.079 / m)
    raise ValueError(f"Figure 3 defines α_m for m = 16, 32, 64 and m ≥ 128, not m = {m}")


def raw_estimate(registers: Sequence[int]) -> float:
    """``E = α_m m^2 (sum 2^{-M[j]})^{-1}`` (Equation 3, Figure 3)."""

    m = len(registers)
    harmonic = 0.0
    for rank in registers:
        # 2^{-M[j]}. ldexp is exact for these exponents.
        harmonic += math.ldexp(1.0, -int(rank))
    return alpha_m(m) * m * m / harmonic


def empty_register_count(registers: Sequence[int]) -> int:
    """``V`` in Figure 3: registers that still hold the initial value 0."""

    return sum(1 for rank in registers if rank == 0)


def apply_corrections(raw: float, empty: int, m: int) -> tuple[float, str]:
    """Map the raw estimate ``E`` to the returned estimate ``E*``.

    The three branches are the small, intermediate, and large ranges printed
    in Figure 3. ``log`` in that figure is the natural logarithm: Section 4 (ii)
    inverts ``V ≈ m e^{-μ}``, and Section 4 (iii) inverts ``E ≈ 2^L (1 - e^{-Λ})``.
    """

    small_limit = 2.5 * m  # (5/2) m
    large_limit = HASH_SPACE / 30.0  # (1/30) * 2^32
    # The figure prints three separate ``if`` statements. Read as fall-through,
    # the intermediate assignment ``E* := E`` overwrites the small-range
    # correction whenever E ≤ 2^32/30, which includes every small E. Section 4
    # (ii) says that correction is part of the program and is exactly what
    # stops n = 0 from being reported as α_m m. The three braces are therefore
    # three mutually exclusive ranges. The small-range comparison itself still
    # follows the prose, which describes the distortion for n < (5/2) m.
    if raw < small_limit:
        if empty != 0:
            # Section 4 (ii): μ = ln(m/V), hence n ≈ m ln(m/V).
            value = m * math.log(m / empty)
        else:
            value = raw
        regime = "small"
    elif raw <= large_limit:
        value = raw
        regime = "intermediate"
    else:
        ratio = raw / HASH_SPACE
        value = -HASH_SPACE * math.log2(1.0 - ratio)
        regime = "large"
    return value, regime


def estimate_registers(registers: Sequence[int]) -> Estimate:
    """Run the arithmetic half of Figure 3 on a finished register vector."""

    m = len(registers)
    if m < 16 or m & (m - 1):
        raise ValueError("m must be a power of two and at least 16")
    raw = raw_estimate(registers)
    empty = empty_register_count(registers)
    value, regime = apply_corrections(raw, empty, m)
    return Estimate(value=value, raw=raw, regime=regime, empty_registers=empty)
