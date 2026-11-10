"""The checker must reject real violations, not only accept happy paths.

Pure histories cover the false-positive traps. The executions below are
produced by the simulator: an eventually consistent read across a split, and
a deliberately unsafe follower read, both of which linearizability forbids.
"""

from __future__ import annotations

import unittest

import support
from kvsim.checker import check_linearizability


class DeliberateViolationTest(unittest.TestCase):
    def test_eventual_execution_is_not_linearizable(self) -> None:
        cluster = support.eventual(
            3,
            seed=1,
            anti_entropy=False,
            eager_replicate=False,
            read_fanout=0,
        )
        client = cluster.client("c")
        self.assertTrue(client.put("k", "v", contact=0).ok)
        got = client.get("k", contact=1)
        self.assertEqual(got.status, "ok")
        self.assertIsNone(got.value)
        linear = check_linearizability(cluster.history)
        self.assertFalse(linear.passed, linear)
        self.assertFalse(cluster.verify(durable=False).passed)

    def test_safe_read_under_partition_stays_linearizable(self) -> None:
        cluster = support.raft(3, seed=8)
        client = cluster.client("c")
        self.assertTrue(client.put("k", "v1").ok)
        cluster.run(80)
        leader = cluster.leader_id()
        assert leader is not None
        follower = next(node_id for node_id in range(3) if node_id != leader)
        rest = {node_id for node_id in range(3) if node_id != follower}
        cluster.partition({follower}, rest)
        self.assertTrue(client.put("k", "v2", prefer=leader).ok)
        got = client.get("k", prefer=follower, timeout=3000)
        self.assertEqual(got.status, "ok", cluster.debug_state())
        self.assertEqual(got.value, "v2")
        result = cluster.verify()
        self.assertTrue(result.passed, f"{result}\n{cluster.debug_state()}")

    def test_unsafe_follower_read_is_caught(self) -> None:
        cluster = support.raft(3, seed=8, unsafe_stale_reads=True)
        client = cluster.client("c")
        self.assertTrue(client.put("k", "v1").ok)
        cluster.run(80)
        leader = cluster.leader_id()
        assert leader is not None
        follower = next(node_id for node_id in range(3) if node_id != leader)
        rest = {node_id for node_id in range(3) if node_id != follower}
        cluster.partition({follower}, rest)
        written = client.put("k", "v2", prefer=leader)
        self.assertTrue(written.ok, cluster.debug_state())
        stale = client.get("k", contact=follower)
        self.assertEqual(stale.status, "ok")
        self.assertNotEqual(stale.value, "v2")
        linear = check_linearizability(cluster.history)
        self.assertFalse(
            linear.passed,
            f"checker missed a stale follower read {stale.value!r}\n{linear}",
        )

    def test_agreement_checker_rejects_a_fabricated_version(self) -> None:
        from kvsim.checker import check_convergence

        created = {("k", 1, 0, 0, "real")}
        stores = [
            (0, {"k": (1, 0, 0, "real")}),
            (1, {"k": (1, 0, 0, "forged")}),
        ]
        result = check_convergence(stores, created, durable=False)
        self.assertFalse(result.passed, result)


if __name__ == "__main__":
    unittest.main()
