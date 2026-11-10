"""Eventually consistent LWW register with anti-entropy and read repair.

A write is accepted by one replica (W=1), stamped with that replica's hybrid
logical clock, and ordered by ``(wall, logical, writer_id)``. Eager
replication, periodic push-pull anti-entropy, and read repair all merge with
the same monotonic rule: a replica never replaces a version with an older one.
"""

from __future__ import annotations

from dataclasses import dataclass

from kvsim.sim import HLC, Simulator
from kvsim.trace import trace


@dataclass(frozen=True)
class Version:
    value: str
    wall: int
    logical: int
    writer: int

    def order(self) -> tuple[int, int, int]:
        return (self.wall, self.logical, self.writer)

    def as_tuple(self) -> tuple[int, int, int, str]:
        return (self.wall, self.logical, self.writer, self.value)


class EventualNode:
    def __init__(self, node_id: int, peers: list[int], cluster, skew_ms: int) -> None:
        self.id = node_id
        self.peers = list(peers)
        self.cluster = cluster
        self.sim: Simulator = cluster.sim
        self.net = cluster.net
        self.skew_ms = skew_ms
        self.alive = True
        self.store: dict[str, Version] = {}
        self.hlc = HLC()
        self.lamport = 0
        self.last_sent_lamport = 0
        self.violations: list[str] = []
        self.pending_gets: dict[int, dict] = {}
        self._gen = 0
        self._ae_gen = 0
        self._get_gen = 0

    def local_wall(self) -> int:
        return self.sim.time + self.skew_ms

    def start(self) -> None:
        if self.cluster.config.anti_entropy:
            self._arm_ae()

    def crash(self) -> None:
        self.alive = False
        self._ae_gen += 1
        pending = list(self.pending_gets.values())
        self.pending_gets.clear()
        for state in pending:
            self.cluster.reply(state["rpc_id"], {"status": "unavailable"})
        trace(self.sim.time, f"n{self.id} crash (eventual)")

    def recover(self) -> None:
        if self.alive:
            return
        self.alive = True
        trace(self.sim.time, f"n{self.id} recover (eventual)")
        if self.cluster.config.anti_entropy:
            self._arm_ae()

    def _arm_ae(self) -> None:
        self._ae_gen += 1
        gen = self._ae_gen
        interval = self.cluster.config.ae_interval

        def fire() -> None:
            if gen != self._ae_gen:
                return
            if self.alive:
                self._anti_entropy()
            if gen == self._ae_gen:
                self.sim.schedule(interval, fire, label=f"ae-{self.id}")

        self.sim.schedule(interval, fire, label=f"ae-{self.id}")

    def emit(self, dst: int, msg: dict) -> None:
        self.lamport += 1
        self.last_sent_lamport = self.lamport
        msg = dict(msg)
        msg["lamport"] = self.lamport
        msg["src"] = self.id
        self.net.send(self.id, dst, msg)

    def receive(self, msg: dict) -> None:
        if not self.alive:
            rpc = msg.get("rpc_id")
            if rpc is not None:
                self.cluster.reply(rpc, {"status": "unavailable"})
            return
        remote = msg.get("lamport")
        if isinstance(remote, int):
            self.lamport = max(self.lamport, remote) + 1
        else:
            self.lamport += 1
        kind = msg.get("type")
        if kind == "ClientPut":
            self._client_put(msg)
        elif kind == "ClientGet":
            self._client_get(msg)
        elif kind == "replicate":
            self._ingest(msg["key"], Version(**msg["version"]), "replicate")
        elif kind == "ae":
            self._on_ae(msg)
        elif kind == "read_probe":
            version = self.store.get(msg["key"])
            self.emit(
                msg["src"],
                {
                    "type": "read_probe_reply",
                    "token": msg["token"],
                    "key": msg["key"],
                    "version": None if version is None else _version_dict(version),
                },
            )
        elif kind == "read_probe_reply":
            self._on_probe_reply(msg)
        else:
            self.violations.append(f"node {self.id} unknown message {kind}")

    def _client_put(self, msg: dict) -> None:
        self.hlc = self.hlc.tick(self.local_wall())
        version = Version(msg["value"], self.hlc.wall, self.hlc.logical, self.id)
        self._install(msg["key"], version, "local-put")
        self.cluster.note_created(msg["key"], version)
        if self.cluster.config.eager_replicate:
            encoded = _version_dict(version)
            for peer in self.peers:
                self.emit(peer, {"type": "replicate", "key": msg["key"], "version": encoded})
        trace(self.sim.time, f"n{self.id} put {msg['key']}={msg['value']} {version.order()}")
        self.cluster.reply(msg["rpc_id"], {"status": "ok", "value": msg["value"]})

    def _client_get(self, msg: dict) -> None:
        token = msg["rpc_id"]
        fanout = self.cluster.config.read_fanout
        peers = list(self.peers)
        if fanout >= 0 and len(peers) > fanout:
            peers = self.sim.rng.sample(peers, fanout)
        self._get_gen += 1
        state = {
            "key": msg["key"],
            "rpc_id": msg["rpc_id"],
            "gen": self._get_gen,
            "responses": {self.id: self.store.get(msg["key"])},
            "expected": set(peers) | {self.id},
        }
        self.pending_gets[token] = state
        for peer in peers:
            self.emit(peer, {"type": "read_probe", "key": msg["key"], "token": token})
        gen = state["gen"]
        wait = self.cluster.config.read_wait

        def finish() -> None:
            self._finish_get(token, gen)

        self.sim.schedule(wait, finish, label=f"read-{self.id}")
        if not peers:
            self._finish_get(token, gen)

    def _on_probe_reply(self, msg: dict) -> None:
        state = self.pending_gets.get(msg["token"])
        if state is None:
            return
        raw = msg.get("version")
        version = None if raw is None else Version(**raw)
        state["responses"][msg["src"]] = version
        if set(state["responses"]) >= state["expected"]:
            self._finish_get(msg["token"], state["gen"])

    def _finish_get(self, token: int, gen: int) -> None:
        state = self.pending_gets.get(token)
        if state is None or state["gen"] != gen:
            return
        self.pending_gets.pop(token, None)
        best: Version | None = None
        for version in state["responses"].values():
            if version is not None and (best is None or version.order() > best.order()):
                best = version
        key = state["key"]
        if best is not None:
            self._ingest(key, best, "read-repair")
            encoded = _version_dict(best)
            for node_id, version in state["responses"].items():
                if node_id == self.id:
                    continue
                if version is None or version.order() < best.order():
                    self.emit(node_id, {"type": "replicate", "key": key, "version": encoded})
        value = None if best is None else best.value
        trace(self.sim.time, f"n{self.id} get {key} -> {value}")
        self.cluster.reply(state["rpc_id"], {"status": "ok", "value": value})

    def _anti_entropy(self) -> None:
        peers = list(self.peers)
        fanout = self.cluster.config.ae_fanout
        if not peers:
            return
        if fanout > 0 and len(peers) > fanout:
            peers = self.sim.rng.sample(peers, fanout)
        snapshot = {key: _version_dict(version) for key, version in self.store.items()}
        for peer in peers:
            self.emit(peer, {"type": "ae", "store": snapshot, "reply": True})

    def _on_ae(self, msg: dict) -> None:
        for key, raw in msg.get("store", {}).items():
            self._ingest(key, Version(**raw), "anti-entropy")
        if msg.get("reply"):
            snapshot = {key: _version_dict(version) for key, version in self.store.items()}
            self.emit(msg["src"], {"type": "ae", "store": snapshot, "reply": False})

    def _ingest(self, key: str, version: Version, origin: str) -> None:
        self.hlc = self.hlc.receive(self.local_wall(), version.wall, version.logical)
        self._install(key, version, origin)

    def _install(self, key: str, version: Version, origin: str) -> bool:
        current = self.store.get(key)
        if current is not None:
            if version.order() < current.order():
                return False
            if version.order() == current.order():
                if version.value != current.value:
                    self.violations.append(
                        f"node {self.id} key {key!r} version collision {current} vs {version} via {origin}"
                    )
                return False
        self.store[key] = version
        return True


def _version_dict(version: Version) -> dict:
    return {
        "value": version.value,
        "wall": version.wall,
        "logical": version.logical,
        "writer": version.writer,
    }
