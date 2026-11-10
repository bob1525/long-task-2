"""Eventually consistent register: replication, anti-entropy, read repair, clocks."""

from __future__ import annotations

import unittest

import support
from kvsim.eventual import Version
from kvsim.sim import HLC


class ClockTest(unittest.TestCase):
    def test_hlc_tick_and_receive(self) -> None:
        clock = HLC().tick(10)
        self.assertEqual(clock, HLC(10, 0))
        clock = clock.tick(10)
        self.assertEqual(clock, HLC(10, 1))
        clock = clock.tick(12)
        self.assertEqual(clock, HLC(12, 0))
        clock = clock.receive(9, 12, 4)
        self.assertEqual(clock, HLC(12, 5))
        clock = clock.receive(20, 11, 0)
        self.assertEqual(clock, HLC(20, 0))


class EventualTest(unittest.TestCase):
    def test_eager_replication_reaches_peers(self) -> None:
        cluster = support.eventual(3, seed=1, anti_entropy=False)
        result = cluster.client("c").put("k", "v", contact=0)
        self.assertTrue(result.ok)
        cluster.run(30)
        for node in cluster.nodes:
            self.assertEqual(node.store["k"].value, "v")
        self.assertTrue(cluster.verify().passed, cluster.verify())

    def test_anti_entropy_converges_without_eager_replication(self) -> None:
        cluster = support.eventual(5, seed=2, eager_replicate=False, ae_fanout=1, ae_interval=10)
        self.assertTrue(cluster.client("c").put("k", "gossip", contact=0).ok)
        cluster.run(10 * 40)
        result = cluster.verify(durable=True)
        self.assertTrue(result.passed, f"{result}\n{cluster.debug_state()}")

    def test_read_repair_without_anti_entropy(self) -> None:
        cluster = support.eventual(
            3,
            seed=3,
            anti_entropy=False,
            eager_replicate=False,
            read_fanout=2,
            read_wait=40,
        )
        self.assertTrue(cluster.client("c").put("k", "repaired", contact=0).ok)
        self.assertIsNone(cluster.nodes[1].store.get("k"))
        got = cluster.client("c").get("k", contact=1)
        self.assertEqual(got.value, "repaired")
        self.assertEqual(cluster.nodes[1].store["k"].value, "repaired")
        self.assertEqual(cluster.nodes[1].store["k"].writer, 0)

    def test_partition_diverges_then_converges_to_later_hlc(self) -> None:
        cluster = support.eventual(4, seed=4, ae_interval=20, read_fanout=3, read_wait=30)
        self.assertTrue(cluster.client("c").put("color", "blue", contact=0).ok)
        cluster.run(30)
        cluster.partition({0, 1}, {2, 3})
        self.assertTrue(cluster.client("c").put("color", "red", contact=0).ok)
        cluster.run(20)
        self.assertTrue(cluster.client("c").put("color", "green", contact=2).ok)
        cluster.run(20)
        left = cluster.client("c").get("color", contact=1)
        right = cluster.client("c").get("color", contact=3)
        self.assertEqual(left.value, "red")
        self.assertEqual(right.value, "green")
        mid = cluster.verify(durable=False)
        self.assertFalse(mid.passed, mid)
        cluster.heal()
        cluster.run(200)
        final = cluster.verify(durable=True)
        self.assertTrue(final.passed, f"{final}\n{cluster.debug_state()}")
        for node in cluster.nodes:
            self.assertEqual(node.store["color"].value, "green")

    def test_skewed_clock_beats_a_later_real_time_write(self) -> None:
        # The writes are concurrent: a partition keeps node 1 from observing
        # node 0's clock. HLC last-writer-wins then keeps the skewed stamp,
        # even though that write happened earlier in simulated real time.
        # If node 1 had observed the stamp, its later write would dominate.
        cluster = support.eventual(
            3,
            seed=5,
            clock_skews=[8000, 0, 0],
            eager_replicate=False,
            ae_interval=20,
        )
        cluster.partition({0}, {1, 2})
        self.assertTrue(cluster.client("c").put("k", "skewed", contact=0).ok)
        cluster.run(30)
        self.assertTrue(cluster.client("c").put("k", "later", contact=1).ok)
        skewed = cluster.nodes[0].store["k"]
        later = cluster.nodes[1].store["k"]
        self.assertGreater(skewed.wall, later.wall)
        cluster.heal()
        cluster.run(300)
        result = cluster.verify(durable=True)
        self.assertTrue(result.passed, f"{result}\n{cluster.debug_state()}")
        for node in cluster.nodes:
            self.assertEqual(node.store["k"].value, "skewed", node.store["k"])
            self.assertEqual(node.store["k"].writer, 0)

    def test_equal_hlc_tie_breaks_on_writer_id(self) -> None:
        cluster = support.eventual(2, seed=1, anti_entropy=False, eager_replicate=False)
        node = cluster.nodes[0]
        self.assertTrue(node._install("k", Version("low", 10, 0, 0), "test"))
        self.assertTrue(node._install("k", Version("high", 10, 0, 1), "test"))
        self.assertFalse(node._install("k", Version("stale", 10, 0, 0), "test"))
        self.assertEqual(node.store["k"].value, "high")
        self.assertEqual(node.violations, [])

    def test_version_does_not_move_backwards(self) -> None:
        cluster = support.eventual(1, seed=1, anti_entropy=False)
        node = cluster.nodes[0]
        node._install("k", Version("new", 5, 1, 0), "test")
        node._install("k", Version("old", 4, 9, 1), "test")
        self.assertEqual(node.store["k"].value, "new")

    def test_crash_keeps_the_only_copy_and_anti_entropy_spreads_it(self) -> None:
        cluster = support.eventual(3, seed=6, eager_replicate=False, ae_interval=20)
        self.assertTrue(cluster.client("c").put("k", "only", contact=0).ok)
        cluster.crash_node(0)
        self.assertTrue(cluster.verify(durable=False).passed)
        held_offline = cluster.verify(durable=True)
        self.assertFalse(held_offline.passed, held_offline)
        cluster.recover_node(0)
        cluster.run(400)
        restored = cluster.verify(durable=True)
        self.assertTrue(restored.passed, f"{restored}\n{cluster.debug_state()}")
        for node_id in range(3):
            self.assertEqual(cluster.client("c").get("k", contact=node_id).value, "only")

    def test_lamport_clocks_advance_across_replication(self) -> None:
        cluster = support.eventual(2, seed=1, anti_entropy=False)
        before = cluster.nodes[1].lamport
        self.assertTrue(cluster.client("c").put("k", "v", contact=0).ok)
        cluster.run(20)
        self.assertGreater(cluster.nodes[0].lamport, 0)
        self.assertGreater(cluster.nodes[1].lamport, before)
        self.assertGreater(cluster.nodes[1].lamport, cluster.nodes[0].last_sent_lamport - 1)

    def test_disabled_sync_does_not_converge(self) -> None:
        cluster = support.eventual(
            3,
            seed=7,
            anti_entropy=False,
            eager_replicate=False,
            read_fanout=0,
        )
        cluster.client("c").put("k", "a", contact=0)
        cluster.client("c").put("k", "b", contact=1)
        cluster.run(100)
        result = cluster.verify(durable=False)
        self.assertFalse(result.passed, result)


if __name__ == "__main__":
    unittest.main()
