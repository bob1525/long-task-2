"""Stochastic averaging and the rank observable ρ.

Section 1 and Figures 2–3 split each hashed word and keep, per substream, the
maximum rank

    Max(N) = max_{x in N} ρ(x)     (Equation 1)

with the program's register initial value 0 (Figure 3), not −∞ (Figure 2).

The paper writes the 32-bit word as ``x1 x2 … x32`` with ``x1`` the leading
bit, then

    j = 1 + <x1 … xb>_2
    w = x_{b+1} x_{b+2} …

Registers here are stored 0-based: index ``j - 1`` equals the integer value of
the first ``b`` bits, and ``registers[0 .. m-1]`` is the paper's ``M[1] .. M[m]``.
"""

from __future__ import annotations

HASH_BITS = 32


def rho(word: int, width: int) -> int:
    """Position of the leftmost 1-bit in a ``width``-bit string.

    Figure 3: ``ρ(1···) = 1``, ``ρ(0001···) = 4``, and ``ρ(0^K) = K + 1``.
    Equivalently, one plus the number of leading zeros (Section 1).
    """

    if width < 0:
        raise ValueError("width must be non-negative")
    if word < 0 or word >> width:
        raise ValueError("word does not fit in the given width")
    if word == 0:
        return width + 1
    return width - word.bit_length() + 1


def split_hash(word: int, precision: int) -> tuple[int, int, int]:
    """Split ``x`` into ``(index, w, width of w)``.

    ``index`` is ``<x1 … xb>_2`` (the 0-based form of Figure 3's ``j``).
    ``w`` is the remaining ``32 - b`` bits, still aligned to the left of that
    field, which is what ``ρ`` then reads.
    """

    if precision < 4 or precision > 16:
        raise ValueError("Figure 3 assumes b ∈ [4 .. 16]")
    if word < 0 or word > 0xFFFFFFFF:
        raise ValueError("h(v) must be a 32-bit word")
    width = HASH_BITS - precision
    index = word >> width
    rest = word & ((1 << width) - 1)
    return index, rest, width


def observe(registers: bytearray, word: int, precision: int) -> None:
    """Fold one hashed value into the registers: ``M[j] = max(M[j], ρ(w))``."""

    index, rest, width = split_hash(word, precision)
    rank = rho(rest, width)
    if rank > registers[index]:
        registers[index] = rank
