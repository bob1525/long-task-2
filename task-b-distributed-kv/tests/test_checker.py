"""Linearizability checker: legal histories pass, illegal ones fail.

These cases are the ones a simplified "last completed write" checker gets
wrong: overlapping stale reads are legal, a read of a newer value followed
in real time by a read of an older value is not, and a timed-out put may
take effect after the client has already moved on.
"""

from __future__ import annotations

import unittest

import support
from kvsim.checker import check_linearizability, check_raft_safety


def check(rows):
    return check_linearizability(support.history(*rows))


class LinearizabilityCheckerTest(unittest.TestCase):
    def test_empty_history_passes(self) -> None:
        self.assertTrue(check(()).passed)

    def test_sequential_puts_and_gets_pass(self) -> None:
        result = check(
            (
                ("put", "a", 0, 1),
                ("get", "a", 2, 3),
                ("put", "b", 4, 5),
                ("get", "b", 6, 7),
            )
        )
        self.assertTrue(result.passed, result)

    def test_stale_read_after_a_completed_write_fails(self) -> None:
        result = check(
            (
                ("put", "a", 0, 1, "ok", "w", 1),
                ("get", None, 2, 3, "ok", "r", 1),
            )
        )
        self.assertFalse(result.passed, result)
        self.assertIn("not linearizable", result.violations[0])

    def test_stale_read_overlapping_a_write_passes(self) -> None:
        # The read can be linearized before the write. A checker that rejects
        # every old value once a write has started is a false positive.
        # Different clients: one client's calls are totally ordered.
        result = check(
            (
                ("put", "a", 0, 10, "ok", "w", 1),
                ("get", None, 1, 2, "ok", "r", 1),
            )
        )
        self.assertTrue(result.passed, result)

    def test_newer_read_then_older_read_fails(self) -> None:
        result = check(
            (
                ("put", "a", 0, 10, "ok", "w", 1),
                ("get", "a", 1, 3, "ok", "r1", 1),
                ("get", None, 4, 5, "ok", "r2", 1),
            )
        )
        self.assertFalse(result.passed, result)

    def test_overlapping_newer_and_older_reads_pass(self) -> None:
        # Neither read precedes the other, so "old then new" is a legal order.
        result = check(
            (
                ("put", "a", 0, 10, "ok", "w", 1),
                ("get", "a", 1, 6, "ok", "r1", 1),
                ("get", None, 2, 5, "ok", "r2", 1),
            )
        )
        self.assertTrue(result.passed, result)

    def test_read_of_a_future_write_fails(self) -> None:
        result = check((("get", "a", 0, 1), ("put", "a", 2, 3)))
        self.assertFalse(result.passed, result)

    def test_latest_of_two_identical_values_passes(self) -> None:
        result = check(
            (
                ("put", "a", 0, 1),
                ("put", "b", 2, 3),
                ("put", "a", 4, 5),
                ("get", "a", 6, 7),
            )
        )
        self.assertTrue(result.passed, result)

    def test_read_of_overwritten_duplicate_fails(self) -> None:
        result = check(
            (
                ("put", "a", 0, 1),
                ("put", "b", 2, 3),
                ("put", "a", 4, 5),
                ("get", "b", 6, 7),
            )
        )
        self.assertFalse(result.passed, result)

    def test_timeout_put_may_explain_a_later_read(self) -> None:
        result = check(
            (
                ("put", "a", 0, 5, "timeout"),
                ("get", "a", 6, 7),
            )
        )
        self.assertTrue(result.passed, result)

    def test_timeout_put_may_be_absent(self) -> None:
        result = check(
            (
                ("put", "a", 0, 5, "timeout"),
                ("get", None, 6, 7),
            )
        )
        self.assertTrue(result.passed, result)

    def test_timeout_put_cannot_be_forgotten_after_it_was_observed(self) -> None:
        result = check(
            (
                ("put", "a", 0, 1),
                ("put", "b", 2, 8, "timeout"),
                ("get", "b", 3, 4),
                ("get", "a", 5, 6),
            )
        )
        self.assertFalse(result.passed, result)

    def test_timeout_put_may_take_effect_after_a_later_successful_put(self) -> None:
        # The client gave up at t=5, but the write can still land after put "b".
        # Treating the timeout timestamp as a response produces a false violation.
        result = check(
            (
                ("put", "a", 0, 5, "timeout"),
                ("put", "b", 6, 7),
                ("get", "a", 8, 9),
            )
        )
        self.assertTrue(result.passed, result)

    def test_same_client_program_order_is_enforced(self) -> None:
        result = check(
            (
                ("put", "a", 0, 1, "ok", "c", 1),
                ("get", None, 2, 3, "ok", "c", 2),
            )
        )
        self.assertFalse(result.passed, result)

    def test_unavailable_put_does_not_explain_a_value(self) -> None:
        result = check(
            (
                ("put", "ghost", 0, 1, "unavailable"),
                ("get", "ghost", 2, 3),
            )
        )
        self.assertFalse(result.passed, result)

    def test_timed_out_get_is_ignored(self) -> None:
        result = check(
            (
                ("put", "a", 0, 1),
                ("get", None, 2, 3, "timeout"),
                ("get", "a", 4, 5),
            )
        )
        self.assertTrue(result.passed, result)

    def test_keys_are_checked_independently(self) -> None:
        good = check(
            (
                ("put", "a", 0, 1, "ok", "c", 1, "k"),
                ("put", "b", 0, 1, "ok", "d", 1, "q"),
                ("get", "a", 2, 3, "ok", "c", 2, "k"),
                ("get", "b", 2, 3, "ok", "d", 2, "q"),
            )
        )
        self.assertTrue(good.passed, good)
        bad = check(
            (
                ("put", "a", 0, 1, "ok", "c", 1, "k"),
                ("get", "a", 2, 3, "ok", "c", 2, "k"),
                ("put", "b", 0, 1, "ok", "d", 1, "q"),
                ("get", None, 2, 3, "ok", "d", 2, "q"),
            )
        )
        self.assertFalse(bad.passed, bad)
        self.assertTrue(any("q" in item for item in bad.violations))

    def test_concurrent_puts_can_resolve_to_either_value(self) -> None:
        result = check(
            (
                ("put", "a", 0, 5, "ok", "c1", 1),
                ("put", "b", 0, 5, "ok", "c2", 1),
                ("get", "b", 6, 7, "ok", "c3", 1),
            )
        )
        self.assertTrue(result.passed, result)

    def test_endpoint_touching_operations_are_concurrent(self) -> None:
        # resp(get None) == inv(get a) == 1, so neither precedes the other.
        result = check(
            (
                ("put", "a", 0, 2, "ok", "w", 1),
                ("get", "a", 0, 1, "ok", "r1", 1),
                ("get", None, 1, 2, "ok", "r2", 1),
            )
        )
        self.assertTrue(result.passed, result)

    def test_raft_safety_flags_divergent_committed_prefix(self) -> None:
        sentinel = (0, None, None, None)
        snapshot = [
            {
                "id": 0,
                "commit": 1,
                "last_applied": 1,
                "log": [sentinel, (1, "k", "a", "r1")],
                "kv": {"k": "a"},
                "alive": True,
                "role": "leader",
                "term": 1,
            },
            {
                "id": 1,
                "commit": 1,
                "last_applied": 1,
                "log": [sentinel, (1, "k", "b", "r2")],
                "kv": {"k": "b"},
                "alive": True,
                "role": "follower",
                "term": 1,
            },
        ]
        result = check_raft_safety(snapshot)
        self.assertFalse(result.passed, result)

    def test_raft_safety_flags_kv_that_disagrees_with_the_log(self) -> None:
        sentinel = (0, None, None, None)
        snapshot = [
            {
                "id": 0,
                "commit": 1,
                "last_applied": 1,
                "log": [sentinel, (1, "k", "a", "r1")],
                "kv": {"k": "b"},
                "alive": True,
                "role": "leader",
                "term": 1,
            }
        ]
        result = check_raft_safety(snapshot)
        self.assertFalse(result.passed, result)

    def test_raft_safety_accepts_a_consistent_prefix(self) -> None:
        sentinel = (0, None, None, None)
        entry = (1, "k", "a", "r1")
        snapshot = [
            {
                "id": 0,
                "commit": 1,
                "last_applied": 1,
                "log": [sentinel, entry, (1, "k", "b", "r2")],
                "kv": {"k": "a"},
                "alive": True,
                "role": "leader",
                "term": 1,
            },
            {
                "id": 1,
                "commit": 1,
                "last_applied": 1,
                "log": [sentinel, entry],
                "kv": {"k": "a"},
                "alive": True,
                "role": "follower",
                "term": 1,
            },
        ]
        result = check_raft_safety(snapshot)
        self.assertTrue(result.passed, result)


if __name__ == "__main__":
    unittest.main()
