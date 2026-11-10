"""Path setup and cluster builders shared by the task B tests."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kvsim.cluster import Cluster, ClusterConfig  # noqa: E402
from kvsim.history import History, OpRecord  # noqa: E402


def raft(n: int = 3, seed: int = 1, **kwargs) -> Cluster:
    config = ClusterConfig(
        n=n,
        model="linearizable",
        seed=seed,
        delay_min=1,
        delay_max=kwargs.pop("delay_max", 3),
        heartbeat=kwargs.pop("heartbeat", 30),
        election_min=kwargs.pop("election_min", 120),
        election_max=kwargs.pop("election_max", 240),
        client_timeout=kwargs.pop("client_timeout", 4000),
        rpc_slice=kwargs.pop("rpc_slice", 500),
        **kwargs,
    )
    cluster = Cluster(config)
    cluster.start()
    return cluster


def eventual(n: int = 3, seed: int = 1, **kwargs) -> Cluster:
    config = ClusterConfig(
        n=n,
        model="eventual",
        seed=seed,
        delay_min=1,
        delay_max=kwargs.pop("delay_max", 3),
        ae_interval=kwargs.pop("ae_interval", 30),
        read_fanout=kwargs.pop("read_fanout", n - 1),
        read_wait=kwargs.pop("read_wait", 25),
        client_timeout=kwargs.pop("client_timeout", 400),
        **kwargs,
    )
    cluster = Cluster(config)
    cluster.start()
    return cluster


def history(*rows: tuple) -> History:
    """Build a history.

    Each row is ``(kind, value, start, end, status="ok", client="c", seq=None, key="k")``.
    ``seq`` defaults to the 1-based position among rows of that client.
    """

    per_client: dict[str, int] = {}
    built = History()
    for index, row in enumerate(rows, start=1):
        kind, value, start, end = row[0], row[1], row[2], row[3]
        status = row[4] if len(row) > 4 else "ok"
        client = row[5] if len(row) > 5 else "c"
        seq = row[6] if len(row) > 6 else None
        key = row[7] if len(row) > 7 else "k"
        if seq is None:
            per_client[client] = per_client.get(client, 0) + 1
            seq = per_client[client]
        built.add(
            OpRecord(
                op_id=index,
                client_id=client,
                client_seq=seq,
                kind=kind,
                key=key,
                value=value,
                start=start,
                end=end,
                status=status,
            )
        )
    return built
