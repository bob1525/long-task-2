"""Seeded fault-injection scenarios.

Each scenario bootstraps a healthy cluster, applies a deterministic mix of
partitions, crashes, and packet loss, then heals, recovers every node, and
runs the consistency checker. ``python -m kvsim faults`` prints the summary
a reviewer can compare against the test log.
"""

from __future__ import annotations

from dataclasses import dataclass

from kvsim.checker import CheckResult
from kvsim.cluster import Cluster, ClusterConfig

SCENARIO_COUNT = 24


@dataclass
class ScenarioResult:
    seed: int
    model: str
    nodes: int
    drop: float
    passed: bool
    detail: str
    operations: int
    checker: str


def run_fault_scenario(seed: int) -> ScenarioResult:
    import random

    rng = random.Random(10_000 + seed)
    model = "linearizable" if seed % 2 == 0 else "eventual"
    nodes = 5 if seed % 4 == 0 else 3
    drop = (0.0, 0.05, 0.10, 0.15)[seed % 4]
    delay_max = (3, 8, 15, 25)[seed % 4]
    skew_span = (seed % 5) * 20
    skews = [((index * 13 + seed * 3) % (2 * skew_span + 1)) - skew_span for index in range(nodes)]
    heartbeat = 40
    election_min = max(180, heartbeat + delay_max + 80)
    election_max = election_min + 220
    config = ClusterConfig(
        n=nodes,
        model=model,
        seed=seed,
        delay_min=1,
        delay_max=delay_max,
        drop_prob=0.0,
        clock_skews=skews if model == "eventual" else None,
        client_timeout=7000 if model == "linearizable" else 500,
        rpc_slice=800 if model == "linearizable" else 150,
        ae_interval=40,
        ae_fanout=0,
        read_fanout=nodes - 1,
        read_wait=30 + delay_max,
        heartbeat=heartbeat,
        election_min=election_min,
        election_max=election_max,
    )
    try:
        cluster = Cluster(config)
        cluster.start()
    except Exception as exc:  # noqa: BLE001 — scenario report, not a crash of the runner
        return ScenarioResult(seed, model, nodes, drop, False, f"startup failed: {exc}", 0, "")

    cluster.set_drop(drop)
    keys = [f"k{index}" for index in range(1 + seed % 3)]
    clients = [cluster.client(f"c{index}") for index in range(1 + seed % 2)]
    steps = 6 + seed % 3
    notes: list[str] = []
    for step in range(steps):
        cluster.run(rng.randint(15, 70))
        roll = rng.random()
        if roll < 0.28:
            kind = rng.choice(["partition", "crash", "recover", "drop"])
            if kind == "partition":
                order = list(range(nodes))
                rng.shuffle(order)
                cut = rng.randint(1, nodes - 1)
                cluster.partition(set(order[:cut]), set(order[cut:]))
                notes.append(f"partition@{cluster.sim.time}")
            elif kind == "crash":
                alive = [index for index in range(nodes) if cluster.nodes[index].alive]
                if len(alive) > 1:
                    victim = rng.choice(alive)
                    cluster.crash_node(victim)
                    notes.append(f"crash {victim}")
            elif kind == "recover":
                dead = [index for index in range(nodes) if not cluster.nodes[index].alive]
                if dead:
                    cluster.recover_node(rng.choice(dead))
                    notes.append("recover")
                else:
                    cluster.heal()
                    notes.append("heal")
            else:
                cluster.set_drop(min(0.45, drop + 0.25))
                notes.append("loss-spike")
        else:
            client = rng.choice(clients)
            key = rng.choice(keys)
            if rng.random() < 0.6:
                result = client.put(key, f"s{seed}-{step}")
                notes.append(f"put {key} {result.status}")
            else:
                result = client.get(key)
                notes.append(f"get {key} {result.status}")
        if model == "linearizable":
            safety = cluster.safety_only()
            if not safety.passed:
                return ScenarioResult(
                    seed,
                    model,
                    nodes,
                    drop,
                    False,
                    f"checker failed during step {step} ({', '.join(notes[-4:])}): {safety}",
                    len(cluster.history),
                    str(safety),
                )
        else:
            monotonic = cluster.monotonic_violations()
            if monotonic:
                return ScenarioResult(
                    seed,
                    model,
                    nodes,
                    drop,
                    False,
                    f"version went backwards: {monotonic}",
                    len(cluster.history),
                    "; ".join(monotonic),
                )

    cluster.heal()
    cluster.set_drop(0.0)
    cluster.net.filter = None
    cluster.recover_all()
    if model == "linearizable":
        cluster.run(election_max * 8)
        leader = cluster.wait_for_leader(election_max * 4)
        if leader is None:
            return ScenarioResult(
                seed, model, nodes, drop, False, "no leader after quiesce", len(cluster.history), ""
            )
        for key in keys:
            outcome = clients[0].get(key, timeout=5000)
            if outcome.status != "ok":
                return ScenarioResult(
                    seed,
                    model,
                    nodes,
                    drop,
                    False,
                    f"final read {key} -> {outcome.status}\n{cluster.debug_state()}",
                    len(cluster.history),
                    "",
                )
        checked = cluster.verify()
    else:
        wait = config.ae_interval * 4 + delay_max * 6 + 80
        cluster.run(wait)
        checked = cluster.verify(durable=True)
        failed_read = None
        if checked.passed:
            for node_id in range(nodes):
                for key in keys:
                    outcome = clients[0].get(key, contact=node_id)
                    if outcome.status != "ok":
                        failed_read = (node_id, key, outcome.status)
                        break
                if failed_read is not None:
                    break
        if failed_read is not None:
            node_id, key, status = failed_read
            checked = CheckResult(
                False,
                checked.kind,
                checked.violations + [f"read {key} from node {node_id} -> {status}"],
            )
    return ScenarioResult(
        seed,
        model,
        nodes,
        drop,
        checked.passed,
        "ok" if checked.passed else f"{checked}\n{cluster.debug_state()}",
        len(cluster.history),
        str(checked),
    )


def run_all(seeds: range | None = None) -> list[ScenarioResult]:
    chosen = list(seeds) if seeds is not None else list(range(1, SCENARIO_COUNT + 1))
    return [run_fault_scenario(seed) for seed in chosen]


def format_report(results: list[ScenarioResult]) -> str:
    lines = [
        "seed  model          nodes  drop   ops  result",
        "----  -------------  -----  -----  ---  ------",
    ]
    for result in results:
        status = "PASS" if result.passed else "FAIL"
        lines.append(
            f"{result.seed:<4}  {result.model:<13}  {result.nodes:>5}  {result.drop:<5.2f}  "
            f"{result.operations:>3}  {status}"
        )
        if not result.passed:
            lines.append(f"      {result.detail.replace(chr(10), chr(10) + '      ')}")
    passed = sum(1 for result in results if result.passed)
    lines.append(
        f"total={len(results)} passed={passed} failed={len(results) - passed}"
    )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="运行故障注入场景并打印一致性检查报告")
    parser.add_argument("--seed", type=int, default=None, help="只跑一个种子")
    args = parser.parse_args(argv)
    if args.seed is not None:
        results = [run_fault_scenario(args.seed)]
    else:
        results = run_all()
    print(format_report(results))
    return 0 if all(result.passed for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
