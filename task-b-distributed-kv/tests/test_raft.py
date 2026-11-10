"""Raft linearizable KV: elections, partitions, crashes, read-your-writes."""

from __future__ import annotations

import unittest

import support


class RaftTest(unittest.TestCase):
    def test_single_node_put_get(self) -> None:
        cluster = support.raft(1, seed=1)
        client = cluster.client("c")
        self.assertTrue(client.put("k", "v").ok)
        self.assertEqual(client.get("k").value, "v")
        self.assertTrue(cluster.verify().passed, cluster.verify())

    def test_three_nodes_read_your_writes(self) -> None:
        cluster = support.raft(3, seed=2)
        client = cluster.client("c")
        self.assertTrue(client.put("k", "v1").ok)
        self.assertEqual(client.get("k").value, "v1")
        self.assertTrue(client.put("k", "v2").ok)
        self.assertEqual(client.get("k").value, "v2")
        self.assertIsNone(client.get("missing").value)
        result = cluster.verify()
        self.assertTrue(result.passed, f"{result}\n{cluster.debug_state()}")

    def test_two_clients_two_keys(self) -> None:
        cluster = support.raft(3, seed=3)
        a = cluster.client("a")
        b = cluster.client("b")
        self.assertTrue(a.put("x", "1").ok)
        self.assertTrue(b.put("y", "2").ok)
        self.assertEqual(b.get("x").value, "1")
        self.assertEqual(a.get("y").value, "2")
        self.assertTrue(cluster.verify().passed, cluster.verify())

    def test_leader_crash_preserves_committed_write(self) -> None:
        for seed in range(1, 4):
            with self.subTest(seed=seed):
                cluster = support.raft(3, seed=seed)
                client = cluster.client("c")
                self.assertTrue(client.put("k", "kept").ok)
                cluster.run(80)
                leader = cluster.leader_id()
                self.assertIsNotNone(leader)
                cluster.crash_node(leader)
                cluster.run(800)
                got = client.get("k", timeout=3000)
                self.assertEqual(got.status, "ok", cluster.debug_state())
                self.assertEqual(got.value, "kept")
                result = cluster.verify()
                self.assertTrue(result.passed, f"{result}\n{cluster.debug_state()}")

    def test_minority_cannot_commit_and_majority_write_survives_heal(self) -> None:
        cluster = support.raft(3, seed=4)
        client = cluster.client("c")
        self.assertTrue(client.put("k", "v1").ok)
        cluster.run(60)
        leader = cluster.leader_id()
        assert leader is not None
        others = {node_id for node_id in range(3) if node_id != leader}
        cluster.partition({leader}, others)
        minority = client.put("k", "minor", contact=leader, timeout=400)
        self.assertEqual(minority.status, "timeout", cluster.debug_state())
        prefer = min(others)
        majority = client.put("k", "major", prefer=prefer, timeout=3000)
        self.assertEqual(majority.status, "ok", cluster.debug_state())
        self.assertEqual(client.get("k", prefer=prefer).value, "major")
        cluster.heal()
        cluster.run(1500)
        for node_id in range(3):
            got = client.get("k", prefer=node_id, timeout=3000)
            self.assertEqual(got.value, "major", f"node {node_id} {got} {cluster.debug_state()}")
        result = cluster.verify()
        self.assertTrue(result.passed, f"{result}\n{cluster.debug_state()}")

    def test_acked_write_survives_minority_crash(self) -> None:
        cluster = support.raft(5, seed=5)
        client = cluster.client("c")
        self.assertTrue(client.put("k", "durable").ok)
        cluster.run(100)
        leader = cluster.leader_id()
        assert leader is not None
        victims = [leader] + [node_id for node_id in range(5) if node_id != leader][:1]
        for victim in victims:
            cluster.crash_node(victim)
        cluster.run(1200)
        got = client.get("k", timeout=4000)
        self.assertEqual(got.status, "ok", cluster.debug_state())
        self.assertEqual(got.value, "durable")
        result = cluster.verify()
        self.assertTrue(result.passed, f"{result}\n{cluster.debug_state()}")

    def test_isolated_follower_catches_up_after_heal(self) -> None:
        cluster = support.raft(3, seed=6)
        client = cluster.client("c")
        self.assertTrue(client.put("k", "base").ok)
        cluster.run(50)
        leader = cluster.leader_id()
        assert leader is not None
        follower = next(node_id for node_id in range(3) if node_id != leader)
        cluster.partition({follower}, {node_id for node_id in range(3) if node_id != follower})
        self.assertTrue(client.put("k", "next", prefer=leader).ok)
        self.assertLess(cluster.nodes[follower].commit_index, cluster.nodes[leader].commit_index)
        cluster.heal()
        cluster.run(800)
        self.assertEqual(cluster.nodes[follower].kv.get("k"), "next")
        self.assertTrue(cluster.verify().passed, cluster.verify())

    def test_two_handles_with_the_same_client_name_do_not_collapse_writes(self) -> None:
        cluster = support.raft(3, seed=1)
        first = cluster.client("c")
        second = cluster.client("c")
        self.assertTrue(first.put("k", "v1").ok)
        second_put = second.put("k", "v2")
        self.assertTrue(second_put.ok, second_put)
        got = cluster.client("reader").get("k")
        self.assertEqual(got.value, "v2", cluster.debug_state())
        result = cluster.verify()
        self.assertTrue(result.passed, f"{result}\n{cluster.debug_state()}")

    def test_retry_of_the_same_request_id_does_not_append_twice(self) -> None:
        cluster = support.raft(1, seed=1)
        client = cluster.client("c")
        self.assertTrue(client.put("k", "once").ok)
        leader = cluster.nodes[0]
        req_id = next(entry.req_id for entry in leader.log if entry.req_id)
        done: dict = {}
        rpc = cluster.new_rpc(lambda result: done.setdefault("r", result))
        leader.receive(
            {
                "type": "ClientPut",
                "rpc_id": rpc,
                "req_id": req_id,
                "client_id": "c",
                "key": "k",
                "value": "twice",
            }
        )
        self.assertEqual(done["r"]["status"], "ok")
        self.assertEqual(done["r"]["value"], "once")
        self.assertEqual(sum(1 for entry in leader.log if entry.key == "k"), 1)
        self.assertEqual(client.get("k").value, "once")

    def test_same_request_is_not_applied_twice(self) -> None:
        cluster = support.raft(3, seed=7)
        client = cluster.client("c")
        self.assertTrue(client.put("k", "once").ok)
        # A second logical put of a different value must replace, not duplicate-apply
        # into a torn state. The committed kv matches the log replay.
        self.assertTrue(client.put("k", "twice").ok)
        result = cluster.verify()
        self.assertTrue(result.passed, result)
        self.assertEqual(client.get("k").value, "twice")


if __name__ == "__main__":
    unittest.main()
