"""Raft-replicated key-value store with read-index linearizable reads.

The implementation follows Ongaro & Ousterhout:

* terms, voted-for, and the log are durable across crashes
* a candidate's log must be at least as up to date as the voter's
* a leader only advances commitIndex to an entry from its current term
  (the Figure 8 rule); that advance also commits the prefix
* a read is served only by a leader that has committed an entry from its
  current term and has just received heartbeats from a majority

``unsafe_stale_reads`` bypasses that read path and answers from local state
on any replica. It exists so tests can prove the checker rejects a real
stale read; it is not a consistency model.
"""

from __future__ import annotations

from dataclasses import dataclass

from kvsim.trace import trace


@dataclass(frozen=True)
class LogEntry:
    term: int
    key: str | None
    value: str | None
    req_id: str | None


def _entry_tuple(entry: LogEntry) -> tuple:
    return (entry.term, entry.key, entry.value, entry.req_id)


class RaftNode:
    def __init__(self, node_id: int, peers: list[int], cluster) -> None:
        self.id = node_id
        self.peers = list(peers)
        self.cluster = cluster
        self.sim = cluster.sim
        self.net = cluster.net
        self.n = len(peers) + 1
        self.alive = True
        self.role = "follower"
        self.leader_id: int | None = None
        self.current_term = 0
        self.voted_for: int | None = None
        self.log: list[LogEntry] = [LogEntry(0, None, None, None)]
        self.commit_index = 0
        self.last_applied = 0
        self.kv: dict[str, str] = {}
        self.next_index: dict[int, int] = {}
        self.match_index: dict[int, int] = {}
        self.votes: set[int] = set()
        self.pending_client: dict[str, int] = {}
        self.read_queue: list[dict] = []
        self.pending_reads: list[dict] = []
        self.read_acks: dict[int, set[int]] = {}
        self._read_token = 0
        self.election_gen = 0
        self.hb_gen = 0
        self.lamport = 0
        self.last_sent_lamport = 0
        self.violations: list[str] = []

    def majority(self) -> int:
        return self.n // 2 + 1

    def last_index(self) -> int:
        return len(self.log) - 1

    def start(self) -> None:
        self._arm_election()

    def crash(self) -> None:
        self.alive = False
        self.role = "follower"
        self.leader_id = None
        self.votes.clear()
        self.pending_client.clear()
        self.read_queue.clear()
        self.pending_reads.clear()
        self.read_acks.clear()
        self.election_gen += 1
        self.hb_gen += 1
        trace(self.sim.time, f"n{self.id} crash term={self.current_term} commit={self.commit_index}")

    def recover(self) -> None:
        if self.alive:
            return
        self.alive = True
        self.role = "follower"
        self.leader_id = None
        trace(self.sim.time, f"n{self.id} recover term={self.current_term} commit={self.commit_index}")
        self._arm_election()

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
        if kind == "ClientGet" and self.cluster.config.unsafe_stale_reads:
            self.cluster.reply(
                msg["rpc_id"],
                {"status": "ok", "value": self.kv.get(msg["key"])},
            )
            trace(self.sim.time, f"n{self.id} UNSAFE get {msg['key']} -> {self.kv.get(msg['key'])}")
            return
        if kind == "ClientPut":
            self._client_put(msg)
        elif kind == "ClientGet":
            self._client_get(msg)
        elif kind == "RequestVote":
            self._on_request_vote(msg)
        elif kind == "RequestVoteReply":
            self._on_vote_reply(msg)
        elif kind == "AppendEntries":
            self._on_append(msg)
        elif kind == "AppendEntriesReply":
            self._on_append_reply(msg)
        else:
            self.violations.append(f"node {self.id} unknown message {kind}")

    def _arm_election(self) -> None:
        self.election_gen += 1
        gen = self.election_gen
        config = self.cluster.config
        delay = self.sim.rng.randint(config.election_min, config.election_max)

        def fire() -> None:
            if not self.alive or gen != self.election_gen or self.role == "leader":
                return
            self._start_election()

        self.sim.schedule(delay, fire, label=f"election-{self.id}")

    def _arm_heartbeat(self) -> None:
        self.hb_gen += 1
        gen = self.hb_gen
        interval = self.cluster.config.heartbeat

        def fire() -> None:
            if not self.alive or gen != self.hb_gen or self.role != "leader":
                return
            self._replicate_all(token=None)
            self.sim.schedule(interval, fire, label=f"hb-{self.id}")

        self.sim.schedule(interval, fire, label=f"hb-{self.id}")

    def _start_election(self) -> None:
        self.role = "candidate"
        self.current_term += 1
        self.voted_for = self.id
        self.leader_id = None
        self.votes = {self.id}
        self.read_queue.clear()
        self.pending_reads.clear()
        trace(self.sim.time, f"n{self.id} candidate term={self.current_term}")
        self._arm_election()
        if len(self.votes) >= self.majority():
            self._become_leader()
            return
        for peer in self.peers:
            self.emit(
                peer,
                {
                    "type": "RequestVote",
                    "term": self.current_term,
                    "candidate_id": self.id,
                    "last_log_index": self.last_index(),
                    "last_log_term": self.log[-1].term,
                },
            )

    def _become_follower(self, term: int, leader_id: int | None = None) -> None:
        if term < self.current_term:
            return
        # votedFor is durable for the term. Clearing it on a same-term
        # AppendEntries would let a node vote twice and elect two leaders.
        if term > self.current_term:
            self.current_term = term
            self.voted_for = None
        self.role = "follower"
        self.leader_id = leader_id
        self.votes.clear()
        self.read_queue.clear()
        self.pending_reads.clear()
        self.read_acks.clear()
        self.hb_gen += 1
        self._arm_election()

    def _become_leader(self) -> None:
        previous = self.cluster.term_leaders.get(self.current_term)
        if previous is not None and previous != self.id:
            self.violations.append(
                f"two leaders in term {self.current_term}: {previous} and {self.id}"
            )
        self.cluster.term_leaders[self.current_term] = self.id
        self.role = "leader"
        self.leader_id = self.id
        # nextIndex points at the slot where the no-op will be placed.
        noop_index = self.last_index() + 1
        self.next_index = {peer: noop_index for peer in self.peers}
        self.match_index = {peer: 0 for peer in self.peers}
        self.log.append(LogEntry(self.current_term, None, None, None))
        self.election_gen += 1
        trace(self.sim.time, f"n{self.id} leader term={self.current_term} noop={noop_index}")
        self._replicate_all(token=None)
        self._advance_commit()
        self._arm_heartbeat()

    def _on_request_vote(self, msg: dict) -> None:
        if msg["term"] > self.current_term:
            self._become_follower(msg["term"])
        granted = False
        if msg["term"] == self.current_term:
            voted = self.voted_for is None or self.voted_for == msg["candidate_id"]
            if voted and self._log_ok(msg["last_log_term"], msg["last_log_index"]):
                granted = True
                self.voted_for = msg["candidate_id"]
                self._arm_election()
        self.emit(
            msg["src"],
            {
                "type": "RequestVoteReply",
                "term": self.current_term,
                "granted": granted,
            },
        )

    def _log_ok(self, last_term: int, last_index: int) -> bool:
        my_term = self.log[-1].term
        if last_term != my_term:
            return last_term > my_term
        return last_index >= self.last_index()

    def _on_vote_reply(self, msg: dict) -> None:
        if msg["term"] > self.current_term:
            self._become_follower(msg["term"])
            return
        if self.role != "candidate" or msg["term"] != self.current_term:
            return
        if msg.get("granted"):
            self.votes.add(msg["src"])
            if len(self.votes) >= self.majority() and self.role == "candidate":
                self._become_leader()

    def _client_put(self, msg: dict) -> None:
        if self.role != "leader":
            self.cluster.reply(
                msg["rpc_id"],
                {"status": "not_leader", "leader": self.leader_id},
            )
            return
        req_id = msg["req_id"]
        for index, entry in enumerate(self.log):
            if entry.req_id is not None and entry.req_id == req_id:
                self.pending_client[req_id] = msg["rpc_id"]
                if index <= self.commit_index:
                    self._reply_put(entry)
                else:
                    self._replicate_all(token=None)
                return
        self.log.append(LogEntry(self.current_term, msg["key"], msg["value"], req_id))
        self.pending_client[req_id] = msg["rpc_id"]
        trace(self.sim.time, f"n{self.id} append {msg['key']}={msg['value']} index={self.last_index()}")
        self._replicate_all(token=None)
        self._advance_commit()

    def _client_get(self, msg: dict) -> None:
        if self.role != "leader":
            self.cluster.reply(
                msg["rpc_id"],
                {"status": "not_leader", "leader": self.leader_id},
            )
            return
        if not self._committed_current_term():
            self.read_queue.append(msg)
            self._replicate_all(token=None)
            return
        self._begin_read(msg)

    def _committed_current_term(self) -> bool:
        return self.commit_index >= 1 and self.log[self.commit_index].term == self.current_term

    def _begin_read(self, msg: dict) -> None:
        self._read_token += 1
        token = self._read_token
        self.read_acks[token] = {self.id}
        self.pending_reads.append(
            {
                "token": token,
                "rpc_id": msg["rpc_id"],
                "key": msg["key"],
                "read_index": self.commit_index,
                "term": self.current_term,
            }
        )
        self._replicate_all(token=token)
        self._check_reads()

    def _replicate_all(self, token: int | None) -> None:
        if self.role != "leader" or not self.alive:
            return
        for peer in self.peers:
            self._replicate_to(peer, token)

    def _replicate_to(self, peer: int, token: int | None) -> None:
        next_index = self.next_index.get(peer, self.last_index() + 1)
        if next_index < 1:
            next_index = 1
        if next_index > self.last_index() + 1:
            next_index = self.last_index() + 1
        prev = next_index - 1
        self.emit(
            peer,
            {
                "type": "AppendEntries",
                "term": self.current_term,
                "leader_id": self.id,
                "prev_index": prev,
                "prev_term": self.log[prev].term,
                "entries": list(self.log[next_index:]),
                "leader_commit": self.commit_index,
                "token": token,
                "probed_prev": prev,
            },
        )

    def _on_append(self, msg: dict) -> None:
        if msg["term"] < self.current_term:
            self._reply_append(msg, success=False, match_index=0, conflict_index=self.last_index(), conflict_term=self.log[-1].term)
            return
        if msg["term"] > self.current_term or self.role != "follower":
            self._become_follower(msg["term"], leader_id=msg["leader_id"])
        else:
            self.leader_id = msg["leader_id"]
            self._arm_election()
        prev = msg["prev_index"]
        if prev < 0 or prev >= len(self.log) or self.log[prev].term != msg["prev_term"]:
            if prev >= len(self.log):
                conflict_index = len(self.log)
                conflict_term = None
            else:
                conflict_term = self.log[prev].term if prev >= 0 else None
                conflict_index = max(prev, 0)
                while conflict_index > 0 and self.log[conflict_index - 1].term == conflict_term:
                    conflict_index -= 1
            self._reply_append(
                msg,
                success=False,
                match_index=0,
                conflict_index=conflict_index,
                conflict_term=conflict_term,
            )
            return
        index = prev + 1
        for entry in msg["entries"]:
            if not isinstance(entry, LogEntry):
                entry = LogEntry(entry["term"], entry["key"], entry["value"], entry["req_id"])
            if index < len(self.log):
                if self.log[index].term != entry.term or self.log[index].req_id != entry.req_id:
                    if not self._truncate(index):
                        self._reply_append(
                            msg,
                            success=False,
                            match_index=self.commit_index,
                            conflict_index=self.commit_index + 1,
                            conflict_term=self.log[self.commit_index].term,
                        )
                        return
                    self.log.append(entry)
                # Matching entry: keep the local one.
            else:
                self.log.append(entry)
            index += 1
        match_index = prev + len(msg["entries"])
        new_commit = min(msg["leader_commit"], match_index)
        if new_commit > self.commit_index:
            self._set_commit(new_commit)
        self._reply_append(msg, success=True, match_index=match_index, conflict_index=None, conflict_term=None)

    def _truncate(self, index: int) -> bool:
        if index <= self.commit_index:
            self.violations.append(
                f"node {self.id} refused to truncate committed index {index} (commit {self.commit_index})"
            )
            return False
        removed = self.log[index:]
        del self.log[index:]
        for entry in removed:
            if entry.req_id is not None:
                self.pending_client.pop(entry.req_id, None)
        return True

    def _reply_append(
        self,
        msg: dict,
        success: bool,
        match_index: int,
        conflict_index: int | None,
        conflict_term: int | None,
    ) -> None:
        self.emit(
            msg["leader_id"],
            {
                "type": "AppendEntriesReply",
                "term": self.current_term,
                "success": success,
                "match_index": match_index,
                "conflict_index": conflict_index if conflict_index is not None else 1,
                "conflict_term": conflict_term,
                "token": msg.get("token"),
                "probed_prev": msg.get("probed_prev"),
            },
        )

    def _on_append_reply(self, msg: dict) -> None:
        if msg["term"] > self.current_term:
            self._become_follower(msg["term"])
            return
        if self.role != "leader" or msg["term"] != self.current_term:
            return
        src = msg["src"]
        if msg.get("success"):
            match_index = int(msg["match_index"])
            if match_index > self.match_index.get(src, 0):
                self.match_index[src] = match_index
            self.next_index[src] = max(self.next_index.get(src, 1), self.match_index[src] + 1)
            token = msg.get("token")
            if token is not None:
                self.read_acks.setdefault(token, set()).add(src)
            self._advance_commit()
            self._check_reads()
            return
        # Ignore stale failures that are not about the prefix we are probing.
        probed = msg.get("probed_prev")
        expected = self.next_index.get(src, 1) - 1
        if probed is not None and probed != expected:
            return
        hint = int(msg.get("conflict_index") or 1)
        conflict_term = msg.get("conflict_term")
        if conflict_term is None:
            new_next = hint
        else:
            found = None
            for index in range(self.last_index(), 0, -1):
                if self.log[index].term == conflict_term:
                    found = index
                    break
                if self.log[index].term < conflict_term:
                    break
            new_next = found + 1 if found is not None else hint
        new_next = max(1, min(new_next, self.last_index() + 1))
        if new_next >= self.next_index.get(src, 1):
            new_next = max(1, self.next_index.get(src, 1) - 1)
        self.next_index[src] = new_next
        self._replicate_to(src, token=None)

    def _advance_commit(self) -> None:
        if self.role != "leader":
            return
        for index in range(self.last_index(), self.commit_index, -1):
            if self.log[index].term != self.current_term:
                continue
            count = 1
            for match in self.match_index.values():
                if match >= index:
                    count += 1
            if count >= self.majority():
                self._set_commit(index)
                return

    def _set_commit(self, index: int) -> None:
        if index < self.commit_index:
            self.violations.append(f"node {self.id} commit moved backwards to {index}")
            return
        if index == self.commit_index:
            return
        self.commit_index = index
        self._apply()

    def _apply(self) -> None:
        while self.last_applied < self.commit_index:
            self.last_applied += 1
            entry = self.log[self.last_applied]
            identity = _entry_tuple(entry)
            known = self.cluster.committed.get(self.last_applied)
            if known is None:
                self.cluster.committed[self.last_applied] = identity
            elif known != identity:
                self.violations.append(
                    f"node {self.id} commit index {self.last_applied} is {identity}, already committed as {known}"
                )
            if entry.key is not None:
                self.kv[entry.key] = entry.value if entry.value is not None else ""
            if entry.req_id is not None and entry.req_id in self.pending_client:
                self._reply_put(entry)
        self._flush_reads()

    def _reply_put(self, entry: LogEntry) -> None:
        if entry.req_id is None:
            return
        rpc = self.pending_client.pop(entry.req_id, None)
        if rpc is None:
            return
        trace(self.sim.time, f"n{self.id} commit-reply {entry.key}={entry.value}")
        self.cluster.reply(rpc, {"status": "ok", "value": entry.value})

    def _flush_reads(self) -> None:
        if self.role != "leader" or not self._committed_current_term():
            self._check_reads()
            return
        queued = self.read_queue
        self.read_queue = []
        for msg in queued:
            self._begin_read(msg)
        self._check_reads()

    def _check_reads(self) -> None:
        if self.role != "leader":
            return
        still: list[dict] = []
        for pending in self.pending_reads:
            if pending["term"] != self.current_term:
                continue
            acks = self.read_acks.get(pending["token"], set())
            if len(acks) >= self.majority() and self.last_applied >= pending["read_index"]:
                value = self.kv.get(pending["key"])
                trace(self.sim.time, f"n{self.id} read-index {pending['key']} -> {value}")
                self.cluster.reply(pending["rpc_id"], {"status": "ok", "value": value})
            else:
                still.append(pending)
        self.pending_reads = still

    def snapshot(self) -> dict:
        return {
            "id": self.id,
            "commit": self.commit_index,
            "last_applied": self.last_applied,
            "log": [_entry_tuple(entry) for entry in self.log],
            "kv": dict(self.kv),
            "alive": self.alive,
            "role": self.role,
            "term": self.current_term,
        }
