"""Print a small error measurement for the Figure 3 program.

Run from the ``task-c-hyperloglog`` directory:

    python3 -m hll
"""

from __future__ import annotations

from hll.analysis import sample_relative_errors, summarize_errors, typical_relative_error


def main() -> None:
    rows = (
        (8, 20_000, 200, 20261110),
        (10, 50_000, 100, 20261110),
        (12, 100, 100, 4242),
    )
    print("HyperLogLog relative error against the true cardinality")
    print("theory column is 1.04/√m from Figure 3; coverage is the Section 4 Gaussian rule")
    print(f"{'b':>3} {'m':>6} {'n':>8} {'trials':>6} {'bias':>9} {'emp SE':>9} {'theory':>9} {'SE ratio':>8} {'≤1σ':>6} {'≤2σ':>6} {'≤3σ':>6}")
    for precision, cardinality, trials, seed in rows:
        m = 1 << precision
        errors = sample_relative_errors(precision, cardinality, trials, seed)
        summary = summarize_errors(errors, m)
        print(
            f"{precision:3d} {m:6d} {cardinality:8d} {trials:6d} "
            f"{summary['bias']:+9.4f} {summary['empirical_se']:9.4f} "
            f"{summary['theoretical_se']:9.4f} {summary['se_ratio']:8.3f} "
            f"{summary['within_1_sigma']:6.3f} {summary['within_2_sigma']:6.3f} "
            f"{summary['within_3_sigma']:6.3f}"
        )
    print(f"example: m = 256 → ±{typical_relative_error(256):.2%} typical relative error")


if __name__ == "__main__":
    main()
