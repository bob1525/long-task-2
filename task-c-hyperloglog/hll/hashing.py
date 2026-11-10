"""Hash data to the 32-bit words consumed by the HyperLogLog program.

Figure 3 fixes a hash ``h : D → {0, 1}^32``. The introduction (p. 128) treats
the bits as fair and independent, and names SHA-1 as one practical
construction that is acceptable under that model. The leading 32 bits of the
SHA-1 digest are that word: the first four bytes, interpreted big-endian, so
bit 31 of the integer is the first bit ``x1``.
"""

from __future__ import annotations

import hashlib


def encode_item(item: bytes | bytearray | memoryview | str | int) -> bytes:
    """Map a Python value to the domain element that is hashed.

    ``bytes`` are taken as-is. ``str`` is UTF-8, so the string ``"ab"`` is the
    same element as the byte string ``b"ab"``. ``int`` is its decimal ASCII
    form, so ``1`` and ``"1"`` are the same element. The paper's domain ``D``
    is arbitrary; this encoding is only the concrete ``D`` of the public API.
    """

    if isinstance(item, str):
        return item.encode("utf-8")
    if isinstance(item, (bytes, bytearray, memoryview)):
        return bytes(item)
    if isinstance(item, int) and not isinstance(item, bool):
        return str(item).encode("ascii")
    raise TypeError(f"unsupported item type: {type(item).__name__}")


def hash32(data: bytes) -> int:
    """Leading 32 bits of SHA-1, as an integer in ``0 .. 2^32 - 1``."""

    digest = hashlib.sha1(data).digest()
    return int.from_bytes(digest[:4], "big")
