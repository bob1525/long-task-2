# 一致性自检记录

工作目录除另行注明外都是 `task-b-distributed-kv/`。每一轮都是先加一条会失败的测试，记下真实输出，再改实现，再跑同一条测试。没有为了让测试通过而删掉断言，也没有把编译错误或写错的测试算进轮次。

前四轮是一致性语义。第五轮是模拟丢包率，单独标明，不拿来顶替前四轮。

基线是 `8276415f29c1ce3c2ad19d4213a00073b565283e`（Add a discrete-event distributed KV simulator as task B）。那一版的检查器、两种模型和 24 个故障场景是通过的。下面的缺陷是在基线通过之后用新测试挖出来的。

没有记成轮次的检查：

- 线性化测试里，重叠的读写如果写成同一个客户端，会因为程序序失败。检查器是对的。这些用例改成了不同的客户端，不记为缺陷。
- 偏斜时钟的用例最初没有把后写者隔开，反熵让它看见了更大的 HLC，所以后写赢了。期望写错了，不记为缺陷。
- `python3 -m unittest tests.test_checker` 会报 `ModuleNotFoundError: No module named 'support'`。`discover -s tests` 才会把 `tests/` 放进导入路径。这是用法，不是一致性问题。

## 第 1 轮：同名客户端的第二次写入被当成重试

检查方法：两个 `client("c")` 先后对同一个键写 `v1`、`v2`，读必须得到 `v2`，并且线性化检查通过。

命令：

```bash
python3 -m unittest discover -s tests -k test_two_handles_with_the_same_client_name -v
```

下面是把当前这条测试对着基线 `8276415` 的 `kvsim/cluster.py` 再跑一次的原文（跑完已把文件还原）。失败点和修复前一致：第二次写入返回成功，三个节点的状态机都停在 `v1`。

```text
AssertionError: 'v1' != 'v2'
- v1
+ v2
 : t=148 model=linearizable drop=0.0 partitioned=False history=3
  n0 alive=True leader term=1 commit=2 leader=0 kv={'k': 'v1'} log_len=2
  n1 alive=True follower term=1 commit=2 leader=0 kv={'k': 'v1'} log_len=2
  n2 alive=True follower term=1 commit=2 leader=0 kv={'k': 'v1'} log_len=2
FAILED (failures=1)
```

原因：两个句柄的序号都从 0 开始，请求号都是 `c:0:put:k`。Raft 把第二次写入当成第一次的重试，直接返回成功，没有追加日志。历史里两个句柄还共用 `client_id`，线性化检查器的程序序也会把它们绑成同一个客户端。

修复：`61c70ea294adc75faa85d55f620ecbaa00058130`。每个 `client()` 句柄有自己的会话号，请求号是 `s{session}:{seq}:{kind}:{key}`，历史里的客户端是 `{name}#{session}`。同一次调用的重试仍然共用请求号。同一次提交里加了 `test_retry_of_the_same_request_id_does_not_append_twice`，锁住“相同请求号只追加一次”。

复测：同一条命令通过。接着 `python3 -m unittest discover -s tests -k RaftTest -v`，10 条通过。

## 第 2 轮：读索引的心跳丢了之后不再重试

检查方法：提交 `k=v` 之后，丢掉领导者发出的前两条带读标记的 `AppendEntries`，再读 `k`。领导者和提交都还在，读必须成功。

命令：

```bash
python3 -m unittest discover -s tests -k test_lost_read_index_heartbeat_is_retried -v
```

失败输出：

```text
AssertionError: 'timeout' != 'ok'
- timeout
+ ok
 : t=715 model=linearizable drop=0.0 partitioned=False history=2
  n0 alive=True leader term=1 commit=2 leader=0 kv={'k': 'v'} log_len=2
  n1 alive=True follower term=1 commit=2 leader=0 kv={'k': 'v'} log_len=2
  n2 alive=True follower term=1 commit=2 leader=0 kv={'k': 'v'} log_len=2
FAILED (failures=1)
```

原因：第一轮带 `token` 的心跳被丢掉之后，重试和后续心跳用 `token=None` 发出。成功的回复不会计入读仲裁，所以值已经提交、领导者也没换，读仍然超时。

修复：`fa9f7bc1641413201d5ce8a73aa9b61c2bc25cbd`。心跳和日志重试带上当前任期里最大的未完成读标记。回复只计入标记不大于这次发送的那些读，后开始的读不能被更早的回复放过。

复测：同一条命令通过。`python3 -m unittest test_raft test_violations test_demo test_checker -v`（在 `tests/` 下）41 条通过，其中包括少数派读超时、分区下的安全读、以及故意的过期跟随者读。另外用 `drop_prob=0.35` 复看种子 4、8、11、13、23、24、25、28：写入成功且当时有领导者时，读都返回 `v`。修复前这些种子里会出现“写入已成功、读却超时”。

## 第 3 轮：读修复忽略等待期间安装的版本

检查方法：关掉积极复制和反熵。节点 1 只向空节点 0 发读探测，并且探测被丢掉。等待期间，节点 2 上的 `pushed` 被复制进节点 1 的存储。读必须返回 `pushed`。

命令（在 `tests/` 下，`support` 会把包根加进导入路径）：

```bash
python3 -m unittest test_eventual.EventualTest.test_read_observes_a_version_installed_while_it_waits -v
```

失败输出：

```text
AssertionError: None != 'pushed' : t=42 model=eventual drop=0.0 partitioned=False history=2
  n0 alive=True lamport=0 hlc=(0,0) store={}
  n1 alive=True lamport=3 hlc=(3,0) store={'k': ('pushed', (0, 1, 2))}
  n2 alive=True lamport=2 hlc=(0,1) store={'k': ('pushed', (0, 1, 2))}
FAILED (failures=1)
```

原因：读开始时把本地值拍进 `responses[self.id]`。等待期间 `_ingest` 更新了存储，`_finish_get` 仍用那张快照，于是存储里已经是 `pushed`，返回值却是空。

修复：`40f41db96d62dd8a05a3e2a4c4f59d7ac0f2bdf5`。选定最大版本之前重新读本地存储。

复测：`python3 -m unittest test_eventual -v`，12 条通过。

## 第 4 轮：相同版本戳的两个值被收敛检查放过

检查方法：两个副本都存着同一个版本，但 `created` 里同一个 `(wall, logical, writer)` 对应 `a` 和 `b` 两个值。`durable=False` 和 `durable=True` 都必须失败，并且违规说明是冲突，而不是随便挑一个值当最后写入者。

命令（在 `tests/` 下）：

```bash
python3 -m unittest test_checker.ConvergenceCheckerTest.test_same_order_conflicting_values_are_a_conflict -v
```

失败输出：

```text
AssertionError: True is not false : PASS (agreement)
FAILED (failures=1)
```

原因：`check_convergence` 只按 `(wall, logical, writer)` 取最大版本，值不参与比较。副本彼此一致、且存的值确实出现在 `created` 里时，`durable=False` 直接通过。`durable=True` 还会在两个值里任意留一个，另一个就被说成“不是最后写入者”。冲突被漏掉了。

修复：`e236868cd943cfe5d5d8212eb3e3fc3943f0fc0d`。同一戳对应多个值时，无论 `durable` 是否打开，都报告冲突，并且不再对这个键做那次任意的最后写入者比较。

复测：`python3 -m unittest test_checker test_violations test_eventual test_demo -v`，43 条通过。

## 第 5 轮：丢包概率被掷了两次

这一轮不是一致性模型的缺陷。它改的是故障注入实际打到链路上的丢包率。前四轮已经各自成立，这里不拿它充数。

检查方法：`drop_prob=0.5`，发送 4000 条延迟 1ms 的消息。一次掷点应大约送达一半（1600 到 2400）。分区出现在送达之前时，已经在途的消息仍然要丢。

命令：

```bash
python3 -m unittest discover -s tests -k NetworkTest -v
```

失败输出：

```text
AssertionError: 1008 not greater than 1600 : 1008
FAILED (failures=1)
```

`test_partition_drops_a_message_already_in_flight` 在修复前就是通过的。1008/4000 约等于 0.25，也就是 `1-(1-0.5)^2`。

原因：`_drop` 在发送时和送达时各掷一次 `drop_prob`。分区和测试过滤器也在这两处检查；第二次掷点把配置的丢包率平方了。

修复：`56ea2ccc47ca4879f32222a4dbfe3cf1e99cb8e9`。丢包只在发送时掷一次。送达时仍检查分区和测试过滤器，所以在途消息会被后出现的分区丢掉。少掷一次随机数会改变故障场景的随机序列，所以复测包含全部 24 个场景，没有放宽场景。

复测：同一条网络测试通过。然后：

```bash
python3 -m unittest discover -s tests -v
```

59 条通过。故障报告 `total=24 passed=24 failed=0`。`python3 -m kvsim demo --seed 1` 里，最终一致模型分区期间收敛检查失败、愈合后通过；线性一致模型少数派写入超时，愈合后读到多数派的 `v3`，线性化检查通过。
