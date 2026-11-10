# 任务 C：HyperLogLog 基数估计

这个目录从零实现 Flajolet、Fusy、Gandouet、Meunier 2007 年论文中的 **HyperLogLog 程序**（Figure 3），并附带论文对应和多轮验证记录。它不修改 Fun 编译器，也不依赖 `task-b-distributed-kv/`。只使用 Python 3 标准库。

## 论文

Philippe Flajolet, Éric Fusy, Olivier Gandouet, Frédéric Meunier. *HyperLogLog: the analysis of a near-optimal cardinality estimation algorithm.* 2007 Conference on Analysis of Algorithms (AofA 07), DMTCS proc. AH, 2007, pp. 127–146.

核对用的 PDF：<https://algo.inria.fr/flajolet/Publications/FlFuGaMe07.pdf>

期刊页：<https://dmtcs.episciences.org/3545>

实现的是 Figure 3 的实用程序：32 位哈希、`m = 2^b`（`b ∈ [4, 16]`）个寄存器、调和平均原始估计、小范围线性计数、大范围哈希碰撞修正。随机平均（stochastic averaging）、秩 `ρ`、以及按寄存器逐分量取最大来合并，都在这篇论文里。第 2–3 节的泊松化证明没有重写。滑动窗口只被引用到 Datar 等人，论文没有给出算法，这里也不做。2013 年的 HyperLogLog++ 不在范围内。

公式和代码的逐条对应见 [PAPER_MAPPING.md](PAPER_MAPPING.md)。自检过程见 [VERIFICATION_LOG.md](VERIFICATION_LOG.md)。

## 运行验证

在本目录执行：

```bash
cd task-c-hyperloglog
python3 -m unittest discover -s tests -t . -v
python3 -m hll
```

`unittest` 是正确性套件。`python3 -m hll` 打印三组相对误差：偏差、经验标准误、Figure 3 给出的 `1.04/√m`，以及落在 1σ、2σ、3σ 内的比例（Section 4 的正态近似）。

最近一次测量：

```text
  b      m        n trials      bias    emp SE    theory SE ratio    ≤1σ    ≤2σ    ≤3σ
  8    256    20000    200   +0.0057    0.0710    0.0650    1.092  0.645  0.925  0.995
 10   1024    50000    100   +0.0011    0.0316    0.0325    0.971  0.680  0.940  1.000
 12   4096      100    100   -0.0002    0.0100    0.0163    0.613  0.880  1.000  1.000
```

前两行在中间区间，经验标准误与 `1.04/√m` 同量级。第三行是小范围（`n = 100`，`(5/2)m = 10240`），线性计数比这个渐近标准误更紧，所以比值小于 1。

## 模块

| 模块 | 职责 |
| --- | --- |
| `hll/hashing.py` | 定义域编码，以及 SHA-1 的前 32 位 |
| `hll/registers.py` | 按前 `b` 位分桶，计算 `ρ`，维护最大值 |
| `hll/estimate.py` | `α_m`、原始估计、三段修正 |
| `hll/hyperloglog.py` | Figure 3 的一遍扫描，以及分量最大值合并 |
| `hll/analysis.py` | Equation (3) 与 Section 3.2 的数值积分，以及误差抽样 |

```python
from hll import HyperLogLog

sketch = HyperLogLog(precision=14)  # m = 16384，典型相对误差约 1.04/√m ≈ 0.8%
sketch.update(["flow-a", "flow-b", "flow-a"])
print(sketch.count())
```

`add_hash` 直接送入一个 32 位字，对应程序里 `x := h(v)` 已经算完的那一步。误差试验用它生成理想的 32 位均匀字。

## 设计决定

- 估计器使用 Figure 3 印出的常数：`α_16 = 0.673`，`α_32 = 0.697`，`α_64 = 0.709`，`m ≥ 128` 时用 `0.7213 / (1 + 1.079/m)`。Equation (3) 的积分只用于核对这些常数，不参与估计。
- 三个区间互斥，并且都根据**原始**估计 `E` 分支。小范围是 `E ≤ (5/2) m`，大范围是 `E > 2^32/30`。Figure 3 的三个 `if` 如果按落下执行，中间那段 `E* := E` 会把小范围修正盖掉；Section 4 (ii) 要求这个修正保留。详见映射文档。
- 论文里的 `log` 是自然对数。小范围来自 `V ≈ m e^{-μ}`，大范围来自 `E ≈ 2^L (1 - e^{-Λ})`。
- 寄存器下标按论文从 1 计。代码用 0 起始的数组，存的是 `j - 1`，也就是前 `b` 位组成的整数。位序从高位读起：`x1` 是 32 位字的最高位。
- 哈希用引言里点名的 SHA-1，取摘要最前面的 32 位。`bytes` 原样哈希，`str` 用 UTF-8，所以 `"ab"` 和 `b"ab"` 是同一个元素；`int` 用十进制 ASCII。
- 合并是寄存器逐分量取最大（脚注 4）。重叠的两部分也同样成立，因为 `ρ` 的观测本来就是最大值。
- 寄存器值落在 `0 .. 32 - b + 1`，5 位就够（Section 4）。这里用 8 位字节，论文也允许。
- 原始估计一旦 `≥ 2^32`，碰撞修正的对数没有有限值。实现返回 `+∞`，即 `E` 从下方趋向 `2^32` 时公式的极限。`b = 4` 且 16 个桶的余数都是 0 时，这个状态会真实出现。

## 测试里有多少随机用例

种子都固定，监督者重跑得到同一批结果。最近一次 `python3 -m unittest discover -s tests -t .` 为 **47 个测试，全部通过**（约 4.3 秒）。其中随机或属性用例：

| 检查 | 个数 | 判定 |
| --- | --- | --- |
| 中间区间随机基数，相对误差 ≤ `5 × 1.04/√m` | 40 | 通过 |
| 小基数，误差不超过 `max(3, 0.2 n)` | 30 | 通过 |
| 任意排列后寄存器不变 | 30 | 通过 |
| 重复插入不改变寄存器 | 30 | 通过 |
| 合并后的寄存器等于拼接流的寄存器 | 30 | 通过 |

合计 **160** 个随机用例，全部通过。另外有 200 次中间区间试验，用来核对 Theorem 1 的偏差和 `1.04/√m` 标准误，以及 Section 4 所说的大约 65% / 95% / 99% 落在 1σ / 2σ / 3σ 内。

可以手算的锚点（`m = 16`）：

- 空集：原始估计 `0.673 × 16 = 10.768`，修正后为 `0`。
- 一个元素：`16 ln(16/15) ≈ 1.0326163382`。
- 16 个寄存器都是 2：原始估计 `0.673 × 64 = 43.072`，落在中间区间，原样返回。
- 16 个寄存器都是 24：原始估计 `180657061.888`，大范围修正为 `184566526.762`。
