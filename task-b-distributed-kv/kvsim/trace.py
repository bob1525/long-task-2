"""Optional event trace. Enable with KVSIM_TRACE=1."""

from __future__ import annotations

import os

ENABLED = os.environ.get("KVSIM_TRACE", "") not in ("", "0", "false", "False")


def trace(sim_time: int, message: str) -> None:
    if ENABLED:
        print(f"t={sim_time:>6}  {message}")
