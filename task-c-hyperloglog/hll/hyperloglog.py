"""The HyperLogLog program of Figure 3, plus register-wise merge.

One pass over a multiset maintains ``m = 2^b`` registers (``b ∈ [4 .. 16]``,
as the program assumes). Each element is hashed once; the first ``b`` bits
select the register and ``ρ`` of the remaining bits is kept as a maximum.
That is stochastic averaging (introduction, pp. 128–129): one hash, a constant
amount of work per element, ``m`` substreams.

Footnote 4 (p. 143): given a partition of the multiset, the register vector of
the union is the component-wise maximum of the parts. The same maximum is the
union when parts overlap, because the observable in Equation (1) is itself a
maximum and therefore idempotent.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Callable

from hll.estimate import Estimate, estimate_registers
from hll.hashing import encode_item, hash32
from hll.registers import observe

HashFunction = Callable[[bytes], int]


class HyperLogLog:
    """Cardinality sketch dimensioned as in Figure 3.

    ``precision`` is ``b``, so the sketch holds ``m = 2^b`` registers.
    ``hash_fn`` defaults to the SHA-1 truncation described in ``hll.hashing``.
    The paper treats ``h`` as a fixed parameter of the algorithm; a caller that
    already has a 32-bit word (or wants the ideal-multiset model of Definition 1
    on 32-bit words) should pass that word to :meth:`add_hash` instead.
    """

    def __init__(self, precision: int = 14, hash_fn: HashFunction | None = None) -> None:
        if not isinstance(precision, int) or isinstance(precision, bool):
            raise TypeError("precision b must be an int")
        if precision < 4 or precision > 16:
            raise ValueError("Figure 3 assumes b ∈ [4 .. 16]")
        self.precision = precision
        self._hash = hash32 if hash_fn is None else hash_fn
        # Figure 3: initialize M[1], …, M[m] to 0. Section 4 (i) explains why
        # this replaces the −∞ initialization of Figure 2.
        self._registers = bytearray(1 << precision)

    @property
    def m(self) -> int:
        return len(self._registers)

    @property
    def registers(self) -> tuple[int, ...]:
        """Snapshot of ``M[1] .. M[m]`` in order, as a 0-based tuple."""

        return tuple(self._registers)

    @classmethod
    def from_registers(
        cls, registers: Sequence[int], *, precision: int | None = None
    ) -> HyperLogLog:
        """Build a sketch whose state is an existing register vector.

        The vector is the whole state of the program after the scan. Values
        outside the range a 32-bit hash can produce are accepted so the
        corrections can be checked against the formulas directly; a normal
        ``add`` / ``add_hash`` only writes ranks in ``0 .. (32 - b) + 1``.
        """

        values = list(registers)
        m = len(values)
        if precision is None:
            if m < 16 or m & (m - 1):
                raise ValueError("register count must be 2^b with b ∈ [4 .. 16]")
            precision = m.bit_length() - 1
        sketch = cls(precision)
        if m != sketch.m:
            raise ValueError(f"expected {sketch.m} registers for b = {precision}, got {m}")
        for rank in values:
            if isinstance(rank, bool) or not isinstance(rank, int) or rank < 0 or rank > 255:
                raise ValueError("register values must be integers in 0 .. 255")
        sketch._registers[:] = values
        return sketch

    def add(self, item: bytes | bytearray | memoryview | str | int) -> None:
        """Hash one multiset element and update the registers."""

        self.add_hash(self._hash(encode_item(item)))

    def add_hash(self, word: int) -> None:
        """Observe an already computed 32-bit hash ``x = h(v)`` (Figure 3)."""

        observe(self._registers, word, self.precision)

    def update(self, items: Iterable[bytes | bytearray | memoryview | str | int]) -> None:
        for item in items:
            self.add(item)

    def estimate(self) -> Estimate:
        return estimate_registers(self._registers)

    def count(self) -> float:
        """Return the cardinality estimate ``E*``."""

        return self.estimate().value

    def copy(self) -> HyperLogLog:
        return HyperLogLog.from_registers(self._registers, precision=self.precision)

    def merge(self, other: HyperLogLog) -> HyperLogLog:
        """Component-wise maximum with ``other`` (footnote 4). Neither sketch is modified."""

        if self.precision != other.precision:
            raise ValueError("component-wise max requires equal precision b")
        merged = bytearray(self._registers)
        for index, rank in enumerate(other._registers):
            if rank > merged[index]:
                merged[index] = rank
        return HyperLogLog.from_registers(merged, precision=self.precision)

    def __repr__(self) -> str:
        return f"HyperLogLog(precision={self.precision}, m={self.m})"
