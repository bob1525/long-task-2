# 任务 C：HyperLogLog 基数估计

这个目录从零实现 Flajolet、Fusy、Gandouet、Meunier 2007 年论文里的 HyperLogLog 程序（Figure 3），并附带论文对应说明和正确性验证。它不修改 Fun 编译器，也不依赖 `task-b-distributed-kv/`。实现只用 Python 3 标准库。

论文、设计决策和验证步骤在实现稳定后写全。当前入口：

```bash
cd task-c-hyperloglog
python3 -m unittest discover -s tests -t . -v
```
