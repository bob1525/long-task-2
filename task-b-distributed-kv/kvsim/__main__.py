"""``python -m kvsim demo`` and ``python -m kvsim faults``."""

from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in {"-h", "--help"}:
        print(
            "用法:\n"
            "  python -m kvsim demo [--model eventual|linearizable|both] [--seed N]\n"
            "  python -m kvsim faults [--seed N]\n"
            "\n"
            "测试:\n"
            "  python -m unittest discover -s tests -v"
        )
        return 0
    command, rest = args[0], args[1:]
    if command == "demo":
        from kvsim.demo import main as demo_main

        return demo_main(rest)
    if command == "faults":
        from kvsim.faults import main as faults_main

        return faults_main(rest)
    print(f"未知命令 {command!r}。用 python -m kvsim --help。", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
