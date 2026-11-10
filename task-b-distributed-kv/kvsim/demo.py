"""Scripted network-partition demonstrations.

Run ``python -m kvsim demo`` from this directory. Tests import
``run_partition_demo`` and ``run_model_comparison`` and assert on the
returned structure, so the same scenario is what a reviewer executes.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from kvsim.cluster import Cluster, ClusterConfig


@dataclass
class PartitionDemoResult:
    model: str
    narrative: str
    checker_passed: bool
    checker_report: str
    diverged: bool | None = None
    converged: bool | None = None
    minority_status: str | None = None
    majority_status: str | None = None
    during_values: dict[int, str | None] = field(default_factory=dict)
    final_values: dict[int, str | None] = field(default_factory=dict)
    winner: str | None = None
    mid_checker_passed: bool | None = None


def run_partition_demo(model: str = "eventual", seed: int = 1) -> PartitionDemoResult:
    if model == "eventual":
        return _eventual_demo(seed)
    if model == "linearizable":
        return _linearizable_demo(seed)
    raise ValueError(f"unknown model {model!r}")


def _eventual_demo(seed: int) -> PartitionDemoResult:
    cluster = Cluster(
        ClusterConfig(
            n=4,
            model="eventual",
            seed=seed,
            delay_min=1,
            delay_max=3,
            ae_interval=30,
            ae_fanout=0,
            read_fanout=3,
            read_wait=20,
            client_timeout=300,
        )
    )
    cluster.start()
    client = cluster.client("demo")
    lines = ["=== 分区演示：最终一致性（4 节点，LWW + 反熵 + 读修复）===", f"种子 {seed}，节点间延迟 1–3ms，初始无丢包"]
    put = client.put("color", "blue", contact=0)
    lines.append(f"t={cluster.sim.time} 节点 0 写入 color=blue -> {put.status}")
    cluster.run(40)
    before = {node_id: client.get("color", contact=node_id).value for node_id in range(4)}
    lines.append(f"t={cluster.sim.time} 复制后各节点读取 {before}")
    cluster.partition({0, 1}, {2, 3})
    lines.append(f"t={cluster.sim.time} 网络分区 {{0,1}} | {{2,3}}")
    red = client.put("color", "red", contact=0)
    cluster.run(20)
    green = client.put("color", "green", contact=2)
    cluster.run(20)
    during = {
        1: client.get("color", contact=1).value,
        3: client.get("color", contact=3).value,
    }
    lines.append(f"t={cluster.sim.time} 分区内写入 red={red.status} green={green.status}")
    lines.append(f"t={cluster.sim.time} 分区期间读取 节点1={during[1]!r} 节点3={during[3]!r}")
    mid = cluster.verify(durable=False)
    lines.append(f"分区期间收敛检查（预期失败）: {mid}")
    cluster.heal()
    lines.append(f"t={cluster.sim.time} 分区恢复，等待反熵")
    cluster.run(cluster.config.ae_interval * 4 + 40)
    final = {node_id: client.get("color", contact=node_id).value for node_id in range(4)}
    final_check = cluster.verify(durable=True)
    versions = {node.id: node.store.get("color") for node in cluster.nodes}
    winner = next(iter(versions.values()))
    lines.append(f"t={cluster.sim.time} 愈合后各节点读取 {final}")
    if winner is not None:
        lines.append(
            f"胜出版本 value={winner.value} hlc=({winner.wall},{winner.logical}) writer={winner.writer}"
        )
    lines.append(f"愈合后收敛检查: {final_check}")
    lines.append(
        "模型对比：分区两侧都能写入；愈合后按混合逻辑时钟的最后写入者收敛，而不是按墙上时钟强行回滚。"
    )
    narrative = "\n".join(lines)
    return PartitionDemoResult(
        model="eventual",
        narrative=narrative,
        checker_passed=final_check.passed,
        checker_report=str(final_check),
        diverged=during[1] != during[3],
        converged=len(set(final.values())) == 1 and final_check.passed,
        during_values=during,
        final_values=final,
        winner=None if winner is None else winner.value,
        mid_checker_passed=mid.passed,
    )


def _linearizable_demo(seed: int) -> PartitionDemoResult:
    cluster = Cluster(
        ClusterConfig(
            n=3,
            model="linearizable",
            seed=seed,
            delay_min=1,
            delay_max=3,
            heartbeat=30,
            election_min=120,
            election_max=220,
            client_timeout=3000,
            rpc_slice=400,
        )
    )
    cluster.start()
    client = cluster.client("demo")
    leader = cluster.leader_id()
    lines = [
        "=== 分区演示：线性一致性（3 节点 Raft + read-index）===",
        f"种子 {seed}，初始 leader=节点 {leader}",
    ]
    first = client.put("x", "v1")
    lines.append(f"t={cluster.sim.time} 写入 x=v1 -> {first.status}")
    cluster.run(50)
    assert leader is not None
    follower = next(node_id for node_id in range(3) if node_id != leader)
    minority = {leader}
    majority = {node_id for node_id in range(3) if node_id != leader}
    # Isolate a follower? The interesting split is leader-alone vs the other two,
    # because the old leader then loses its quorum and the other side elects.
    cluster.partition(minority, majority)
    lines.append(f"t={cluster.sim.time} 分区 {{leader {leader}}} | {set(majority)}")
    minority_write = client.put("x", "v2", contact=leader, timeout=500)
    lines.append(
        f"t={cluster.sim.time} 少数派（旧 leader）写入 x=v2 -> {minority_write.status}（应为 timeout）"
    )
    prefer = follower if follower in majority else next(iter(majority))
    majority_write = client.put("x", "v3", prefer=prefer, timeout=3000)
    lines.append(f"t={cluster.sim.time} 多数派写入 x=v3 -> {majority_write.status} value={majority_write.value}")
    seen = client.get("x", prefer=prefer, timeout=3000)
    lines.append(f"t={cluster.sim.time} 多数派读取 x -> {seen.status} {seen.value!r}")
    cluster.heal()
    lines.append(f"t={cluster.sim.time} 分区恢复，等待旧 leader 退位并追上日志")
    cluster.run(cluster.config.election_max * 6)
    final = {}
    for node_id in range(3):
        got = client.get("x", prefer=node_id, timeout=3000)
        final[node_id] = got.value if got.status == "ok" else f"<{got.status}>"
    final_check = cluster.verify()
    lines.append(f"t={cluster.sim.time} 愈合后读取 {final}")
    lines.append(f"线性化 + Raft 安全检查: {final_check}")
    lines.append("模型对比：少数派写入不能提交；多数派选出新 leader 后的写入在愈合后仍然可见。")
    narrative = "\n".join(lines)
    values = set(final.values())
    return PartitionDemoResult(
        model="linearizable",
        narrative=narrative,
        checker_passed=final_check.passed,
        checker_report=str(final_check),
        minority_status=minority_write.status,
        majority_status=majority_write.status,
        during_values={prefer: seen.value},
        final_values=final,
        winner=seen.value,
        converged=len(values) == 1 and "v3" in values,
    )


def run_model_comparison(seed: int = 1) -> tuple[PartitionDemoResult, PartitionDemoResult]:
    eventual = run_partition_demo("eventual", seed)
    linear = run_partition_demo("linearizable", seed)
    return eventual, linear


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="分区行为演示")
    parser.add_argument("--model", choices=("eventual", "linearizable", "both"), default="both")
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args(argv)
    models = ["eventual", "linearizable"] if args.model == "both" else [args.model]
    failed = False
    for model in models:
        result = run_partition_demo(model, args.seed)
        print(result.narrative)
        print()
        if not result.checker_passed:
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
