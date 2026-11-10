"""Discrete-event simulator and per-node clocks."""

from __future__ import annotations

import heapq
import random
from dataclasses import dataclass


@dataclass(frozen=True)
class HLC:
    """Hybrid logical clock timestamp (Kulkarni et al.)."""

    wall: int = 0
    logical: int = 0

    def key(self) -> tuple[int, int]:
        return (self.wall, self.logical)

    def tick(self, physical: int) -> HLC:
        if physical > self.wall:
            return HLC(physical, 0)
        return HLC(self.wall, self.logical + 1)

    def receive(self, physical: int, other_wall: int, other_logical: int) -> HLC:
        wall = max(physical, self.wall, other_wall)
        if wall == self.wall and wall == other_wall:
            logical = max(self.logical, other_logical) + 1
        elif wall == self.wall:
            logical = self.logical + 1
        elif wall == other_wall:
            logical = other_logical + 1
        else:
            logical = 0
        return HLC(wall, logical)


class Simulator:
    """Single-threaded event queue. Time is an integer millisecond clock.

    Handlers may schedule events but must not call ``run_for`` / ``run_until``
    (the queue is not re-entrant).
    """

    def __init__(self, seed: int = 0) -> None:
        self.time = 0
        self.rng = random.Random(seed)
        self._seq = 0
        self._q: list[tuple[int, int, str, object]] = []
        self._in_run = False

    def schedule(self, delay: int, fn, label: str = "") -> int:
        if delay < 0:
            delay = 0
        self._seq += 1
        heapq.heappush(self._q, (self.time + delay, self._seq, label, fn))
        return self._seq

    def schedule_at(self, when: int, fn, label: str = "") -> int:
        return self.schedule(when - self.time, fn, label)

    def _enter(self) -> None:
        if self._in_run:
            raise RuntimeError("re-entrant simulation step; handlers must not wait")
        self._in_run = True

    def _leave(self) -> None:
        self._in_run = False

    def run_for(self, dt: int, limit: int = 1_000_000) -> int:
        if dt < 0:
            raise ValueError("dt must be >= 0")
        self._enter()
        try:
            target = self.time + dt
            steps = 0
            while self._q and self._q[0][0] <= target:
                t, _seq, _label, fn = heapq.heappop(self._q)
                if t < self.time:
                    t = self.time
                self.time = t
                fn()
                steps += 1
                if steps > limit:
                    raise RuntimeError("simulation step limit exceeded")
            if self.time < target:
                self.time = target
            return steps
        finally:
            self._leave()

    def run_until(self, predicate, limit: int = 1_000_000) -> int:
        self._enter()
        try:
            steps = 0
            while not predicate():
                if not self._q:
                    break
                t, _seq, _label, fn = heapq.heappop(self._q)
                if t < self.time:
                    t = self.time
                self.time = t
                fn()
                steps += 1
                if steps > limit:
                    raise RuntimeError("simulation step limit exceeded")
            return steps
        finally:
            self._leave()
