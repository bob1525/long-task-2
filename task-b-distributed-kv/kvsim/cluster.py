"""Cluster facade: configuration, clients, faults, and verification."""

from __future__ import annotations

from dataclasses import dataclass, field

from kvsim.checker import (
    CheckResult,
    check_convergence,
    check_linearizability,
    check_raft_safety,
    combine,
)
from kvsim.eventual import EventualNode, Version
from kvsim.history import History, OpRecord
from kvsim.network import Network
from kvsim.raft import RaftNode
from kvsim.sim import Simulator
from kvsim.trace import trace


@dataclass
class ClusterConfig:
    n: int = 3
    model: str = "linearizable"
    seed: int = 1
    delay_min: int = 1
    delay_max: int = 5
    drop_prob: float = 0.0
    clock_skews: list[int] | None = None
    client_timeout: int | None = None
    rpc_slice: int | None = None
    ae_interval: int = 50
    ae_fanout: int = 0
    anti_entropy: bool = True
    eager_replicate: bool = True
    read_fanout: int = 2
    read_wait: int = 40
    heartbeat: int = 40
    election_min: int = 200
    election_max: int = 450
    unsafe_stale_reads: bool = False

    def __post_init__(self) -> None:
        if self.n < 1:
            raise ValueError("n must be >= 1")
        if self.model not in ("linearizable", "eventual"):
            raise ValueError(f"unknown model {self.model!r}")
        if self.heartbeat >= self.election_min or self.election_min > self.election_max:
            raise ValueError("need heartbeat < election_min <= election_max")
        if self.clock_skews is not None and len(self.clock_skews) != self.n:
            raise ValueError("clock_skews must have one entry per node")
        if self.unsafe_stale_reads and self.model != "linearizable":
            raise ValueError("unsafe_stale_reads applies only to the linearizable model")

    @property
    def timeout(self) -> int:
        if self.client_timeout is not None:
            return self.client_timeout
        return 6000 if self.model == "linearizable" else 400

    @property
    def slice(self) -> int:
        if self.rpc_slice is not None:
            return self.rpc_slice
        return 700 if self.model == "linearizable" else 120


@dataclass
class Result:
    status: str
    value: str | None = None

    @property
    def ok(self) -> bool:
        return self.status == "ok"


class Cluster:
    def __init__(self, config: ClusterConfig | None = None) -> None:
        self.config = config or ClusterConfig()
        self.sim = Simulator(self.config.seed)
        self.net = Network(
            self.sim,
            self.config.delay_min,
            self.config.delay_max,
            self.config.drop_prob,
        )
        self.history = History()
        self.created: set[tuple[str, int, int, int, str]] = set()
        self.term_leaders: dict[int, int] = {}
        self.committed: dict[int, tuple] = {}
        self._rpc_seq = 0
        self._rpcs: dict[int, object] = {}
        self._op_seq = 0
        skews = self.config.clock_skews or [0] * self.config.n
        nodes: list = []
        for node_id in range(self.config.n):
            peers = [peer for peer in range(self.config.n) if peer != node_id]
            if self.config.model == "linearizable":
                nodes.append(RaftNode(node_id, peers, self))
            else:
                nodes.append(EventualNode(node_id, peers, self, skews[node_id]))
        self.nodes = nodes
        self.net.nodes = nodes

    def start(self) -> None:
        for node in self.nodes:
            node.start()
        if self.config.model == "linearizable" and self.config.n >= 1:
            leader = self.wait_for_leader(max(5000, self.config.election_max * 8))
            if leader is None:
                raise RuntimeError(f"no leader elected\n{self.debug_state()}")

    def run(self, dt: int) -> int:
        return self.sim.run_for(dt)

    def leaders(self) -> list[int]:
        if self.config.model != "linearizable":
            return []
        return [node.id for node in self.nodes if node.alive and node.role == "leader"]

    def leader_id(self) -> int | None:
        found = self.leaders()
        return found[0] if found else None

    def wait_for_leader(self, timeout: int = 5000) -> int | None:
        deadline = self.sim.time + timeout
        self.sim.schedule_at(deadline, lambda: None, label="wait-leader")
        self.sim.run_until(lambda: bool(self.leaders()) or self.sim.time >= deadline)
        return self.leader_id()

    def client(self, client_id: str, timeout: int | None = None) -> Client:
        return Client(self, client_id, timeout)

    def new_rpc(self, callback) -> int:
        self._rpc_seq += 1
        self._rpcs[self._rpc_seq] = callback
        return self._rpc_seq

    def reply(self, rpc_id: int, result: dict) -> None:
        callback = self._rpcs.pop(rpc_id, None)
        if callback is not None:
            callback(result)

    def next_op_id(self) -> int:
        self._op_seq += 1
        return self._op_seq

    def note_created(self, key: str, version: Version) -> None:
        self.created.add((key, version.wall, version.logical, version.writer, version.value))

    def partition(self, *groups: set[int] | list[int]) -> None:
        self.net.set_groups(list(groups))
        trace(self.sim.time, f"partition {list(groups)}")

    def heal(self) -> None:
        self.net.heal()
        trace(self.sim.time, "heal")

    def set_drop(self, probability: float) -> None:
        if not 0.0 <= probability <= 1.0:
            raise ValueError("drop probability out of range")
        self.net.drop_prob = probability

    def crash_node(self, node_id: int) -> None:
        self.nodes[node_id].crash()

    def recover_node(self, node_id: int) -> None:
        self.nodes[node_id].recover()

    def recover_all(self) -> None:
        for node in self.nodes:
            if not node.alive:
                node.recover()

    def monotonic_violations(self) -> list[str]:
        found: list[str] = []
        for node in self.nodes:
            found.extend(node.violations)
        return found

    def alive_stores(self) -> list[tuple[int, dict[str, tuple[int, int, int, str]]]]:
        stores = []
        for node in self.nodes:
            if not node.alive or not hasattr(node, "store"):
                continue
            stores.append((node.id, {key: version.as_tuple() for key, version in node.store.items()}))
        return stores

    def safety_only(self) -> CheckResult:
        """Raft committed-prefix and leader-per-term checks, without replaying history."""

        if self.config.model != "linearizable":
            mono = self.monotonic_violations()
            return CheckResult(not mono, "monotonic", list(mono))
        return check_raft_safety(
            [node.snapshot() for node in self.nodes],
            self.monotonic_violations(),
        )

    def verify(self, durable: bool = True) -> CheckResult:
        monotonic = self.monotonic_violations()
        if self.config.model == "linearizable":
            linear = check_linearizability(self.history)
            safety = check_raft_safety([node.snapshot() for node in self.nodes], monotonic)
            return combine("linearizable", [linear, safety])
        agreement = check_convergence(self.alive_stores(), set(self.created), durable=durable)
        mono = CheckResult(not monotonic, "monotonic", list(monotonic))
        return combine("eventual", [agreement, mono])

    def debug_state(self) -> str:
        lines = [
            f"t={self.sim.time} model={self.config.model} drop={self.net.drop_prob} "
            f"partitioned={self.net.partitioned} history={len(self.history)}"
        ]
        for node in self.nodes:
            if self.config.model == "linearizable":
                lines.append(
                    f"  n{node.id} alive={node.alive} {node.role} term={node.current_term} "
                    f"commit={node.commit_index} leader={node.leader_id} kv={node.kv} "
                    f"log_len={node.last_index()}"
                )
            else:
                brief = {key: (version.value, version.order()) for key, version in node.store.items()}
                lines.append(
                    f"  n{node.id} alive={node.alive} lamport={node.lamport} "
                    f"hlc=({node.hlc.wall},{node.hlc.logical}) store={brief}"
                )
        violations = self.monotonic_violations()
        if violations:
            lines.append("  violations:")
            lines.extend(f"    {item}" for item in violations)
        return "\n".join(lines)


@dataclass
class Client:
    cluster: Cluster
    client_id: str
    timeout: int | None = None
    seq: int = 0
    leader_hint: int = 0

    def put(
        self,
        key: str,
        value: str,
        contact: int | None = None,
        prefer: int | None = None,
        timeout: int | None = None,
    ) -> Result:
        if not isinstance(value, str):
            raise TypeError("put value must be a string")
        return self._call("put", key, value, contact, prefer, timeout)

    def get(
        self,
        key: str,
        contact: int | None = None,
        prefer: int | None = None,
        timeout: int | None = None,
    ) -> Result:
        return self._call("get", key, None, contact, prefer, timeout)

    def _limit(self, timeout: int | None) -> int:
        if timeout is not None:
            return timeout
        if self.timeout is not None:
            return self.timeout
        return self.cluster.config.timeout

    def _select(self, hint: int, contact: int | None):
        nodes = self.cluster.nodes
        if contact is not None:
            node = nodes[contact]
            return node if node.alive else None
        count = len(nodes)
        for offset in range(count):
            node = nodes[(hint + offset) % count]
            if node.alive:
                return node
        return None

    def _next(self, current: int) -> int:
        count = len(self.cluster.nodes)
        for offset in range(1, count + 1):
            candidate = (current + offset) % count
            if self.cluster.nodes[candidate].alive:
                return candidate
        return current

    def _rpc(self, node, kind: str, key: str, value: str | None, req_id: str, deadline: int):
        done: dict = {}
        rpc_id = self.cluster.new_rpc(lambda result: done.setdefault("r", result))
        node.receive(
            {
                "type": "ClientPut" if kind == "put" else "ClientGet",
                "rpc_id": rpc_id,
                "client_id": self.client_id,
                "req_id": req_id,
                "key": key,
                "value": value,
            }
        )
        if "r" in done:
            return done["r"]
        slice_end = min(deadline, self.cluster.sim.time + self.cluster.config.slice)
        flag: dict = {}
        self.cluster.sim.schedule_at(slice_end, lambda: flag.__setitem__("go", True), label="rpc-slice")
        self.cluster.sim.run_until(lambda: "r" in done or flag.get("go", False))
        return done.get("r")

    def _call(
        self,
        kind: str,
        key: str,
        value: str | None,
        contact: int | None,
        prefer: int | None,
        timeout: int | None,
    ) -> Result:
        sim = self.cluster.sim
        start = sim.time
        deadline = start + self._limit(timeout)
        req_id = f"{self.client_id}:{self.seq}:{kind}:{key}"
        ambiguous = False
        status = "unavailable"
        result_value: str | None = None
        if contact is not None:
            hint = contact
        elif prefer is not None:
            hint = prefer
        else:
            hint = self.leader_hint

        while sim.time < deadline:
            node = self._select(hint, contact)
            if node is None:
                break
            response = self._rpc(node, kind, key, value, req_id, deadline)
            if response is None:
                ambiguous = True
                if contact is not None:
                    break
                hint = self._next(node.id)
                continue
            if response["status"] == "ok":
                status = "ok"
                result_value = response.get("value")
                self.leader_hint = node.id
                ambiguous = False
                break
            if response["status"] == "not_leader" and contact is None:
                leader = response.get("leader")
                if isinstance(leader, int) and 0 <= leader < len(self.cluster.nodes):
                    if self.cluster.nodes[leader].alive:
                        hint = leader
                        self.leader_hint = leader
                    else:
                        hint = self._next(node.id)
                else:
                    hint = self._next(node.id)
            elif contact is not None:
                hint = contact
            else:
                hint = self._next(node.id)
            remaining = deadline - sim.time
            if remaining <= 0:
                break
            self.cluster.run(min(40, remaining))

        if status != "ok":
            status = "timeout" if ambiguous else "unavailable"
        end = sim.time
        self.seq += 1
        recorded = value if kind == "put" else result_value
        self.cluster.history.add(
            OpRecord(
                op_id=self.cluster.next_op_id(),
                client_id=self.client_id,
                client_seq=self.seq,
                kind=kind,
                key=key,
                value=recorded,
                start=start,
                end=end,
                status=status,
            )
        )
        trace(sim.time, f"client {self.client_id} {kind} {key}={recorded} -> {status} [{start},{end}]")
        self.cluster.run(1)
        if kind == "put":
            return Result(status, value if status == "ok" else None)
        return Result(status, result_value)
