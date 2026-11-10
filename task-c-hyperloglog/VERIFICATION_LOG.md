# 验证日志

对照文本是 Flajolet、Fusy、Gandouet、Meunier，*HyperLogLog: the analysis of a near-optimal cardinality estimation algorithm*，AofA 07，DMTCS proc. AH，2007，pp. 127–146。页码按这份 PDF：<https://algo.inria.fr/flajolet/Publications/FlFuGaMe07.pdf>。

命令都在 `task-c-hyperloglog/` 下执行。套件命令是：

```bash
python3 -m unittest discover -s tests -t .
```

测试从第一轮就按论文的预期来写，后面没有为了让失败消失而放宽或删掉断言。每一轮只改估计器里和该轮偏差对应的那一处。

## 第 1 轮：小范围修正被后续赋值盖掉

**检查什么。** Section 4 (ii) 写明，寄存器初值为 0 时，原始估计在 `n = 0` 恒为 `α_m m ≈ 0.7m`，程序必须改用线性计数。Figure 3 的小范围分支是 `E ≤ (5/2)m` 且 `V ≠ 0` 时 `E* = m log(m/V)`。

**起点。** `e6efa99393e4990354f51ee54160bbf9fbb1eb0d`。`apply_corrections` 按 Figure 3 版面上的三个独立 `if` 顺序执行：先尝试小范围，再在 `E ≤ 2^{32}/30` 时执行 `E* := E`，最后才处理大范围。

**命令与结果。** 上述 unittest 命令。

```text
Ran 44 tests in 4.280s
FAILED (failures=36, errors=1)
```

36 个失败里，30 个是同一个随机测试的子用例，其余是小范围的直接断言。代表性输出：

```text
FAIL: test_zero_cardinality_is_corrected_to_zero
AssertionError: 'intermediate' != 'small'
- intermediate
+ small

FAIL: test_one_element_uses_linear_counting
AssertionError: 'intermediate' != 'small'

FAIL: test_branch_uses_the_raw_estimate_not_the_corrected_value
AssertionError: 'intermediate' != 'small'

FAIL: test_thirty_small_cardinalities_track_linear_counting (case=0 .. case=29)
AssertionError: 'intermediate' != 'small'
```

30 个小基数子用例全部如此，`n` 从 1 到 300、`m = 4096`，原始估计仍远低于 `(5/2)m`，却都被标成中间区间。

同一轮里原始调和平均是对的：`test_empty_raw_estimate_is_alpha_times_m` 和 `test_raw_formula_is_alpha_m_squared_over_the_sum` 通过。中间区间的 200 次试验 `test_intermediate_bias_and_standard_error` 也通过。偏差在修正的控制流，不在 `E = α_m m² / Σ 2^{−M[j]}`。

**和论文哪里不一致。** 第二个 `if` 在 `E ≤ 2^{32}/30` 时把 `E*` 写回原始 `E`。空集的原始值是 `0.673 × 16 = 10.768`，远小于 `2^{32}/30 ≈ 1.43×10^8`，于是线性计数被盖掉，区间变成 intermediate。Section 4 (ii) 说这个修正写在 Figure 3 里，作用就是避免 `n = 0` 报出约 `0.7m`。Figure 4 的说明也写了模拟包含 low cardinality correction。三个花括号标的是 small / intermediate / large，是三个范围，不是三次覆盖。

这一轮的输出里还有两处别的失败，当时没有一起改：大范围数值 `266273212.87397844 != 184566526.7622363`，以及极点上的 `ValueError: math domain error`。它们留在第 2 轮和第 4 轮。

**修复。** `f34908678d6fef1468b81c4e9c2c14772c32ba17`。三个 `if` 改成互斥的 `if / elif / else`。小范围阈值这一轮仍是严格小于，大范围仍用 `log2`。

**复测。**

```text
Ran 44 tests in 4.256s
FAILED (failures=2, errors=1)
```

空集、单元素、`V = 0` 的小范围、30 个小基数随机用例都通过。剩下：

```text
FAIL: test_large_range_inverts_the_collision_formula
ERROR: test_large_range_pole_follows_the_limit
FAIL: test_small_range_includes_the_endpoint
```

## 第 2 轮：大范围修正用了 log2

**检查什么。** Section 4 (iii) 的碰撞反演：`E` 估计的是不同哈希值的个数，约为 `2^L (1 − e^{−n/2^L})`，所以 `n = −2^L log(1 − E/2^L)`。

**失败输出。** 第 1 轮就出现，第 1 轮复测后原样还在。寄存器 16 个都是 24：

```text
FAIL: test_large_range_inverts_the_collision_formula
AssertionError: False is not true : 266273212.87397844 != 184566526.7622363
```

手算：`E = 0.673 × 16 × 2^{24} = 180657061.888`，自然对数修正为 `184566526.7622363`。实现给出的 `266273212.87397844` 与正确值之比是 `1.4426950408889634`，等于 `1/ln 2`。也就是公式里的 `log` 被做成了 `log2`。

**和论文哪里不一致。** 反演的指数是 `e^{−Λ}`，对数必须是自然对数。同一篇 Theorem 1 写 `β_∞ = √(3 log 2 − 1) ≈ 1.03896`，而 `√(3 ln 2 − 1) = 1.03896176…`。全文的 `log` 是 `ln`。`log2` 会把基数放大 `1/ln 2` 倍，和 Section 4 (iii) 的反函数不是同一个数。

**修复。** `0582ebc2006e5b21b279bc9ccb747885127fa90c`。大范围改为 `−2^{32} math.log(1 − E/2^{32})`。

**复测。**

```text
Ran 44 tests in 4.199s
FAILED (failures=1, errors=1)
```

有限的大范围数值通过，`E*` 大于原始 `E`。剩下端点不等式，以及 `E ≥ 2^{32}` 时 `math.log` 仍然抛 `ValueError`。

## 第 3 轮：小范围端点用了严格小于

**检查什么。** `E` 恰好等于 `(5/2)m` 时属于哪一段。

**失败输出。** 第 1 轮复测之后就只剩这一条断言失败（极点是另一条错误）：

```text
FAIL: test_small_range_includes_the_endpoint
  File ".../tests/test_corrections.py", line 96, in test_small_range_includes_the_endpoint
    self.assertEqual(regime, "small")
AssertionError: 'intermediate' != 'small'
```

调用是 `apply_corrections(raw=40.0, empty=8, m=16)`。`40 = (5/2) × 16`。`V = 8` 时线性计数是 `16 ln 2 ≈ 11.09`，和原始值 40 不同，所以区间判错会改变返回值。

**和论文哪里不一致。** 实现写成 `raw < (5/2)m`。Section 4 (ii) 的正文说渐近区间在基数等于 `(5/2)m` 时已经达到，失真出现在更小的基数。Figure 3 的程序写的是 `if E ≤ (5/2) m`。要执行的是这张程序图，端点留在小范围。

**修复。** `5453f1e659d2f6fdde274379291b8430a11d557f`。条件改为 `raw <= (5/2) m`。

**复测。**

```text
Ran 44 tests in 4.134s
FAILED (errors=1)
```

唯一剩下的是极点上的 `ValueError`。端点测试通过。

## 第 4 轮：大范围公式在 E ≥ 2^32 处没有定义

**检查什么。** Section 4 (iii) 的反函数在原始估计越过哈希空间时做什么。`test_large_range_pole_follows_the_limit` 从 `e6efa99` 起就是 `ERROR`，前三轮没有改它。

**失败输出。** 第 3 轮复测，也就是 `5453f1e` 上的代码：

```text
ERROR: test_large_range_pole_follows_the_limit
  File ".../hll/estimate.py", line 113, in apply_corrections
    value = -HASH_SPACE * math.log(1.0 - ratio)
ValueError: math domain error
```

这个向量不是只能靠直接填寄存器到达。在 `5453f1e` 上对 `b = 4` 的每个桶写入一个余数为 0 的字（`index << 28`）：

```text
registers (29, 29, 29, 29, 29, 29, 29, 29, 29, 29, 29, 29, 29, 29, 29, 29)
ValueError: math domain error
raw 5781025980.416
raw >= 2^32 True
```

`ρ(0^{28}) = 29` 来自 Figure 3 的 `ρ(0^K) = K + 1`。16 个这样的哈希使原始估计变成 `0.673 × 16 × 2^{29} = 5781025980.416`，大于 `2^{32} = 4294967296`。

**和论文哪里不一致。** Section 4 (iii) 把 `E` 建模成 `2^L (1 − e^{−n/2^L})`，因此公式只在 `E < 2^L` 时给出有限基数。`E` 趋向 `2^L` 时基数趋向正无穷。抛 `ValueError` 不是这个反函数；退回原始估计也会停在一个模型里已经不可能的“不同哈希值个数”上。与公式一致的延拓是返回极限 `+∞`。

**修复。** `4d896b3b406c01fa2de95f4258599c6d00c60ce3`。`E ≥ 2^{32}` 时返回 `math.inf`。同一个提交里加上 `test_zero_remainder_in_every_bucket_is_a_reachable_pole`，把“16 个零余数哈希能到达这个状态”留在套件里。

**复测。** 该提交上的套件：

```text
Ran 45 tests in 4.511s
OK
```

（计时来自提交前一次、与该提交内容相同的运行。）160 个随机用例都在这 45 个测试里面，全部通过。

## 第 5 轮：阈值两侧和 SHA-1，没有新的偏差

**检查什么。** 前四轮修的是公式和分支。这一轮看两件套件当时还没单独钉住的事：

1. 真实基数跨过 `(5/2)m` 时，估计会不会在线性计数和原始 HyperLogLog 之间跳到 Section 4 所说的那种未修正偏差（约 `0.7m`）。
2. 引言允许的 SHA-1，取前 32 位之后，经验标准误是否还在 `1.04/√m` 的量级。
3. `b = 16` 是 Figure 3 的上界。Section 4 说寄存器取值到 `L + 1 − log₂ m = 17`。最高桶、余数为 0 时，`ρ` 是否等于 17。

**命令。** 在第 4 轮修复已经在树上的代码上运行。过渡区用均匀 32 位字，每个基数 30 个种子；SHA-1 用元素 `f"{trial}:{i}"`。

**结果。** `m = 256`，阈值 640，`1.04/√m = 0.065`：

```text
n=      1 bias=+0.002 se=0.000 maxabs=0.002 regimes={'small': 30}
n=     10 bias=+0.006 se=0.036 maxabs=0.084 regimes={'small': 30}
n=     50 bias=+0.009 se=0.030 maxabs=0.063 regimes={'small': 30}
n=    100 bias=+0.010 se=0.038 maxabs=0.084 regimes={'small': 30}
n=    200 bias=-0.006 se=0.047 maxabs=0.082 regimes={'small': 30}
n=    400 bias=+0.011 se=0.066 maxabs=0.152 regimes={'small': 30}
n=    640 bias=+0.018 se=0.069 maxabs=0.181 regimes={'intermediate': 23, 'small': 7}
n=    800 bias=+0.006 se=0.048 maxabs=0.114 regimes={'intermediate': 30}
n=   1000 bias=-0.014 se=0.045 maxabs=0.089 regimes={'intermediate': 30}
n=   2000 bias=+0.003 se=0.054 maxabs=0.165 regimes={'intermediate': 30}
n=   5000 bias=-0.001 se=0.061 maxabs=0.177 regimes={'intermediate': 30}
n=  20000 bias=+0.011 se=0.062 maxabs=0.129 regimes={'intermediate': 30}
```

`n = 640` 有 7 次走小范围、23 次走中间范围，因为分支看的是原始估计而不是真实 `n`。偏差仍是 `+0.018`，最大绝对相对误差 `0.181`，没有退回 `α_m m / n ≈ 0.28` 那种未修正偏差。

SHA-1，`b = 10`，`n = 8000`，40 次：

```text
bias=-0.0076 se=0.0258 theory=0.0325 ratio=0.793 max=0.0722
```

经验标准误低于 `1.04/√m`，40 个样本下这是波动，不是放大。同一元素经 `add` 两次与一次，寄存器相同。

`b = 16`，字 `0xFFFF0000`：下标 `65535`，余数 0，`ρ = 17`，只有最后一个寄存器非零。这就是 `33 − 16 = 17`。

**结论。** 没有新的算法偏差，所以没有改估计公式。两处检查随后留在套件里：`test_estimates_stay_sane_across_the_small_range_boundary`（`n ∈ {400, 640, 800}`，20 个固定种子，平均相对偏差绝对值 `< 0.05`，最大绝对相对误差 `< 0.30`）和 `test_widest_program_register_matches_section4`。

**最终复测。** 加上这两个测试之后：

```text
Ran 47 tests in 4.274s
OK
```

`python3 -m hll`：

```text
  b      m        n trials      bias    emp SE    theory SE ratio    ≤1σ    ≤2σ    ≤3σ
  8    256    20000    200   +0.0057    0.0710    0.0650    1.092  0.645  0.925  0.995
 10   1024    50000    100   +0.0011    0.0316    0.0325    0.971  0.680  0.940  1.000
 12   4096      100    100   -0.0002    0.0100    0.0163    0.613  0.880  1.000  1.000
```

前两行在中间区间，标准误与 `1.04/√m` 的比值是 1.092 和 0.971，1σ 覆盖约 0.65 和 0.68，对应 Section 4 的约 65%。第三行 `n = 100`、`m = 4096` 在小范围，线性计数比渐近标准误更紧，比值 0.613 不是中间区间的偏差。

随机用例 160 个（40 + 30 + 30 + 30 + 30）在这次运行中全部通过。
