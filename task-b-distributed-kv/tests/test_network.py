"""The simulated link drops a message at most once, and still honors partitions."""

from __future__ import annotations

import unittest

import support
from kvsim.network import Network
from kvsim.sim import Simulator


class _Node:
    def __init__(self) -> None:
        self.alive = True
        self.got: list[dict] = []

    def receive(self, msg: dict) -> None:
        self.got.append(msg)


class NetworkTest(unittest.TestCase):
    def setUp(self) -> None:
        # support inserts the package root; the import is the path hook.
        self.assertTrue(support.ROOT.is_dir())
    def test_drop_probability_is_applied_once(self) -> None:
        sim = Simulator(seed=1)
        net = Network(sim, delay_min=1, delay_max=1, drop_prob=0.5)
        src, dst = _Node(), _Node()
        net.nodes = [src, dst]
        sent = 4000
        for i in range(sent):
            net.send(0, 1, {"type": "ping", "i": i})
        sim.run_for(5)
        delivered = len(dst.got)
        # One roll of 0.5 lands near half. A second independent roll lands near a quarter.
        self.assertGreater(delivered, 1600, delivered)
        self.assertLess(delivered, 2400, delivered)

    def test_partition_drops_a_message_already_in_flight(self) -> None:
        sim = Simulator(seed=1)
        net = Network(sim, delay_min=5, delay_max=5, drop_prob=0.0)
        src, dst = _Node(), _Node()
        net.nodes = [src, dst]
        net.send(0, 1, {"type": "ping"})
        net.set_groups([{0}, {1}])
        sim.run_for(10)
        self.assertEqual(dst.got, [])


if __name__ == "__main__":
    unittest.main()
