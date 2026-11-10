"""Task B: a discrete-event distributed key-value simulator.

Two switchable consistency models:

* ``eventual`` — last-writer-wins registers, eager replication, anti-entropy, read repair
* ``linearizable`` — Raft-replicated registers with read-index reads

Operation histories are recorded for every client call and checked by
``kvsim.checker``.
"""

__version__ = "1.0.0"
