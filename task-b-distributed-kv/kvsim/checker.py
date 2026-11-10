"""Consistency checkers.

Linearizability
---------------
A history is linearizable (Herlihy & Wing) when each key, viewed as its own
read/write register, has a total order that:

* extends real-time precedence (a successful operation whose response time is
  strictly earlier than another operation's invocation must come first; the
  same client's successful calls are also in program order), and
* obeys the sequential register specification (a get returns the value of the
  latest preceding put, or ``None`` when no put precedes it).

Locality (Herlihy & Wing) lets us check one key at a time. The search is the
classic Wing/Gong backtracking search with a memoized ``(value, linearized
set)`` state. Indeterminate puts — the client timed out, so the write may or
may not have happened, and if it happened it may have happened *after* the
client gave up — are completed the way Jepsen/Knossos complete them: every
subset of those puts is tried, and a subset is legal when the required
operations plus that subset are linearizable. An indeterminate put does not
precede later operations, because there was no response.

Eventual consistency
--------------------
After writes stop, every recovered replica must hold, for every key, the
maximum hybrid-logical-clock version that any replica accepted. Versions
present in a store must be versions some replica actually created, and a
replica's version for a key must be monotonic.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from kvsim.history import History, OpRecord


@dataclass
class CheckResult:
    passed: bool
    kind: str
    violations: list[str] = field(default_factory=list)
    inconclusive: bool = False

    def __str__(self) -> str:
        if self.inconclusive:
            head = f"INCONCLUSIVE ({self.kind})"
        elif self.passed:
            return f"PASS ({self.kind})"
        else:
            head = f"FAIL ({self.kind})"
        if not self.violations:
            return head
        body = "\n  ".join(self.violations)
        return f"{head}\n  {body}"


def combine(kind: str, results: list[CheckResult]) -> CheckResult:
    violations: list[str] = []
    inconclusive = False
    for result in results:
        violations.extend(result.violations)
        inconclusive = inconclusive or result.inconclusive
    passed = all(result.passed for result in results) and not inconclusive
    return CheckResult(passed, kind, violations, inconclusive)


class SearchLimit(Exception):
    pass


@dataclass(frozen=True)
class _Op:
    client_id: str
    client_seq: int
    kind: str
    value: str | None
    start: int
    end: int | None
    optional: bool


def _precedes(earlier: _Op, later: _Op) -> bool:
    """Whether ``earlier`` must be ordered before ``later`` when both happen.

    Indeterminate operations have no response, so they are not predecessors of
    anything. They can still be forced to follow a successful operation.
    """

    if earlier.optional:
        return False
    if earlier.client_id == later.client_id and earlier.client_seq < later.client_seq:
        return True
    if earlier.end is not None and later.start is not None and earlier.end < later.start:
        return True
    return False


def _linearizable_fixed(ops: list[_Op], limit: int) -> bool:
    """All ``ops`` are required. Returns whether some legal order exists."""

    count = len(ops)
    if count == 0:
        return True
    preds = [0] * count
    for i in range(count):
        for j in range(count):
            if i != j and _precedes(ops[j], ops[i]):
                preds[i] |= 1 << j
    full = (1 << count) - 1
    cache: dict[tuple[str | None, int], bool] = {}
    calls = 0

    def rec(value: str | None, done: int) -> bool:
        nonlocal calls
        calls += 1
        if calls > limit:
            raise SearchLimit()
        if done == full:
            return True
        key = (value, done)
        cached = cache.get(key)
        if cached is not None:
            return cached
        for index in range(count):
            bit = 1 << index
            if done & bit:
                continue
            if preds[index] & ~done:
                continue
            op = ops[index]
            if op.kind == "get":
                if op.value != value:
                    continue
                if rec(value, done | bit):
                    cache[key] = True
                    return True
            else:
                if rec(op.value, done | bit):
                    cache[key] = True
                    return True
        cache[key] = False
        return False

    return rec(None, 0)


def _ops_from_records(records: list[OpRecord]) -> dict[str, list[_Op]]:
    grouped: dict[str, list[_Op]] = {}
    for record in records:
        if record.kind == "put":
            if record.status == "ok":
                op = _Op(
                    record.client_id,
                    record.client_seq,
                    "put",
                    record.value,
                    record.start,
                    record.end,
                    False,
                )
            elif record.status == "timeout":
                op = _Op(
                    record.client_id,
                    record.client_seq,
                    "put",
                    record.value,
                    record.start,
                    None,
                    True,
                )
            else:
                continue
        elif record.kind == "get":
            if record.status != "ok":
                continue
            op = _Op(
                record.client_id,
                record.client_seq,
                "get",
                record.value,
                record.start,
                record.end,
                False,
            )
        else:
            continue
        grouped.setdefault(record.key, []).append(op)
    return grouped


def _format_ops(ops: list[_Op]) -> str:
    parts = []
    for op in ops:
        span = f"[{op.start},{'-' if op.end is None else op.end}]"
        flag = " timeout" if op.optional else ""
        parts.append(
            f"{op.kind}({op.value!r}) client={op.client_id}#{op.client_seq} {span}{flag}"
        )
    return "; ".join(parts)


def check_linearizability(history: History, search_limit: int = 2_000_000) -> CheckResult:
    """Return whether ``history`` is linearizable as a per-key register store."""

    violations: list[str] = []
    inconclusive = False
    grouped = _ops_from_records(list(history.ops))
    for key in sorted(grouped):
        ops = grouped[key]
        required = [op for op in ops if not op.optional]
        optional = [op for op in ops if op.optional]
        if len(optional) > 18:
            inconclusive = True
            violations.append(
                f"key {key!r}: {len(optional)} indeterminate puts, search not exhaustive"
            )
            continue
        found = False
        hit_limit = False
        masks = 1 << len(optional)
        for mask in range(masks):
            chosen = list(required)
            for index, op in enumerate(optional):
                if mask & (1 << index):
                    chosen.append(op)
            try:
                if _linearizable_fixed(chosen, search_limit):
                    found = True
                    break
            except SearchLimit:
                hit_limit = True
                break
        if hit_limit:
            inconclusive = True
            violations.append(f"key {key!r}: linearizability search exceeded {search_limit} states")
        elif not found:
            violations.append(
                f"key {key!r}: history is not linearizable: {_format_ops(ops)}"
            )
    return CheckResult(not violations and not inconclusive, "linearizability", violations, inconclusive)


VersionTuple = tuple[int, int, int, str]


def check_convergence(
    stores: list[tuple[int, dict[str, tuple[int, int, int, str]]]],
    created: set[tuple[str, int, int, int, str]],
    durable: bool = True,
) -> CheckResult:
    """Eventual-consistency check over alive replicas.

    ``stores`` maps a node id to ``key -> (wall, logical, writer, value)``.
    ``created`` contains ``(key, wall, logical, writer, value)`` for every
    write a replica accepted.

    Alive replicas must agree. Every stored version must be one that some
    replica created. When ``durable`` is true (the check to use after every
    replica that accepted a write has recovered), every alive replica must
    also hold the maximum created version of each key. While a replica that
    holds the unique maximum is still down, pass ``durable=False``: the
    remaining replicas may agree on a lower version, and that is not yet a
    durability failure.
    """

    violations: list[str] = []
    by_key: dict[str, list[VersionTuple]] = {}
    for key, wall, logical, writer, value in created:
        by_key.setdefault(key, []).append((wall, logical, writer, value))

    for node_id, store in stores:
        for key, version in store.items():
            wall, logical, writer, value = version
            marker = (key, wall, logical, writer, value)
            if marker not in created:
                violations.append(
                    f"node {node_id} key {key!r} holds version {version} which no replica created"
                )

    keys: set[str] = set()
    for _node_id, store in stores:
        keys.update(store)
    for key in sorted(keys):
        observed = [(node_id, store.get(key)) for node_id, store in stores]
        distinct = {value for _node_id, value in observed}
        if len(distinct) > 1:
            violations.append(f"key {key!r} has not converged: {observed}")

    if durable:
        for key, versions in sorted(by_key.items()):
            want = max(versions, key=lambda item: (item[0], item[1], item[2]))
            for node_id, store in stores:
                have = store.get(key)
                if have != want:
                    violations.append(
                        f"node {node_id} key {key!r} has {have}, expected LWW version {want}"
                    )
    deduped: list[str] = []
    seen: set[str] = set()
    for item in violations:
        if item not in seen:
            seen.add(item)
            deduped.append(item)
    kind = "convergence" if durable else "agreement"
    return CheckResult(not deduped, kind, deduped, False)


def check_raft_safety(snapshot: list[dict], violations_already: list[str] | None = None) -> CheckResult:
    """Committed-prefix agreement, apply/kv agreement, and single leader per term.

    ``snapshot`` entries have ``id``, ``commit``, ``last_applied``, ``log``
    (list of ``(term, key, value, req_id)`` including the index-0 sentinel),
    ``kv``, ``alive``, ``role``, and ``term``.
    """

    violations: list[str] = list(violations_already or [])
    leaders: dict[int, list[int]] = {}
    max_commit = 0
    for node in snapshot:
        max_commit = max(max_commit, int(node["commit"]))
        if node["alive"] and node["role"] == "leader":
            leaders.setdefault(int(node["term"]), []).append(int(node["id"]))
        if int(node["last_applied"]) != int(node["commit"]):
            violations.append(
                f"node {node['id']} last_applied={node['last_applied']} commit={node['commit']}"
            )
        replay: dict[str, str] = {}
        log = node["log"]
        commit = int(node["commit"])
        if commit >= len(log):
            violations.append(f"node {node['id']} commit_index {commit} past log length {len(log) - 1}")
            continue
        for index in range(1, commit + 1):
            term, key, value, _req = log[index]
            if key is not None:
                replay[key] = value
        if replay != node["kv"]:
            violations.append(
                f"node {node['id']} kv {node['kv']} does not match committed log {replay}"
            )
    for term, ids in leaders.items():
        if len(ids) > 1:
            violations.append(f"two live leaders in term {term}: {ids}")
    for index in range(1, max_commit + 1):
        seen: dict[tuple, list[int]] = {}
        for node in snapshot:
            if int(node["commit"]) < index:
                continue
            log = node["log"]
            if index >= len(log):
                violations.append(f"node {node['id']} committed index {index} but log is shorter")
                continue
            entry = log[index]
            seen.setdefault(entry, []).append(int(node["id"]))
        if len(seen) > 1:
            violations.append(f"committed index {index} diverges: {seen}")
    return CheckResult(not violations, "raft-safety", violations, False)
