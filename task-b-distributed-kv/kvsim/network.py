"""Simulated network: delay, loss, partitions, and test filters."""

from __future__ import annotations

from collections.abc import Callable

from kvsim.sim import Simulator
from kvsim.trace import trace


class Network:
    def __init__(
        self,
        sim: Simulator,
        delay_min: int,
        delay_max: int,
        drop_prob: float,
    ) -> None:
        if delay_min < 0 or delay_max < delay_min:
            raise ValueError("invalid delay range")
        if not 0.0 <= drop_prob <= 1.0:
            raise ValueError("drop_prob must be in [0, 1]")
        self.sim = sim
        self.delay_min = delay_min
        self.delay_max = delay_max
        self.drop_prob = drop_prob
        self.nodes: list = []
        self.filter: Callable[[int, int, dict], bool] | None = None
        self.partitioned = False
        self.group_of: dict[int, int] = {}
        self.sent = 0
        self.dropped = 0

    def set_groups(self, groups: list[set[int] | list[int]]) -> None:
        self.partitioned = True
        self.group_of = {}
        for index, group in enumerate(groups):
            for node_id in group:
                self.group_of[int(node_id)] = index

    def heal(self) -> None:
        self.partitioned = False
        self.group_of = {}

    def can_reach(self, src: int, dst: int) -> bool:
        if src == dst:
            return True
        if not self.partitioned:
            return True
        # Unlisted nodes are each isolated in their own component.
        return self.group_of.get(src, 10_000 + src) == self.group_of.get(dst, 10_000 + dst)

    def send(self, src: int, dst: int, msg: dict) -> None:
        if self._drop(src, dst, msg):
            self.dropped += 1
            trace(self.sim.time, f"drop {src}->{dst} {msg.get('type')}")
            return
        delay = self.delay_min if self.delay_min == self.delay_max else self.sim.rng.randint(
            self.delay_min, self.delay_max
        )
        self.sent += 1
        payload = msg

        def deliver() -> None:
            if self._drop(src, dst, payload):
                self.dropped += 1
                trace(self.sim.time, f"drop-in-flight {src}->{dst} {payload.get('type')}")
                return
            node = self.nodes[dst]
            if not node.alive:
                return
            trace(self.sim.time, f"deliver {src}->{dst} {payload.get('type')}")
            node.receive(payload)

        self.sim.schedule(delay, deliver, label=str(msg.get("type")))

    def _drop(self, src: int, dst: int, msg: dict) -> bool:
        if not self.can_reach(src, dst):
            return True
        if self.filter is not None and self.filter(src, dst, msg):
            return True
        if self.drop_prob > 0.0 and self.sim.rng.random() < self.drop_prob:
            return True
        return False
