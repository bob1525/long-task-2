"""Client-observed operation history."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class OpRecord:
    """One client call.

    ``status`` is ``ok``, ``timeout``, or ``unavailable``.
    A timed-out put is indeterminate: it may still take effect after the
    client gave up. A timed-out get observed no value and is ignored by the
    linearizability checker. ``unavailable`` means the request never reached
    a live node, so it has no effect.

    For puts, ``value`` is the value written (or attempted). For gets, ``value``
    is the value returned (``None`` if the key was absent).
    """

    op_id: int
    client_id: str
    client_seq: int
    kind: str
    key: str
    value: str | None
    start: int
    end: int
    status: str


@dataclass
class History:
    ops: list[OpRecord] = field(default_factory=list)

    def add(self, record: OpRecord) -> None:
        self.ops.append(record)

    def __len__(self) -> int:
        return len(self.ops)

    def __iter__(self):
        return iter(self.ops)
