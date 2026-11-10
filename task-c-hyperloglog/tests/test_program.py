import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hll.hashing import encode_item, hash32
from hll.hyperloglog import HyperLogLog


class ProgramTests(unittest.TestCase):
    def test_precision_bounds_match_figure3(self):
        HyperLogLog(4)
        HyperLogLog(16)
        for bad in (3, 17, 0, -1):
            with self.assertRaises(ValueError):
                HyperLogLog(bad)

    def test_string_and_bytes_are_one_element_and_ints_use_decimal(self):
        self.assertEqual(encode_item("ab"), b"ab")
        self.assertEqual(encode_item(b"ab"), b"ab")
        self.assertEqual(encode_item(12), b"12")
        self.assertEqual(encode_item(-3), b"-3")
        left = HyperLogLog(8)
        right = HyperLogLog(8)
        left.add("flow")
        right.add(b"flow")
        self.assertEqual(left.registers, right.registers)
        with self.assertRaises(TypeError):
            left.add(True)  # type: ignore[arg-type]

    def test_add_matches_add_hash_of_sha1(self):
        item = "flow-42"
        via_item = HyperLogLog(6)
        via_word = HyperLogLog(6)
        via_item.add(item)
        via_word.add_hash(hash32(encode_item(item)))
        self.assertEqual(via_item.registers, via_word.registers)

    def test_one_hash_evaluation_per_element(self):
        # Stochastic averaging (pp. 128–129) uses one hash per element, not m hashes.
        calls: list[bytes] = []

        def counting_hash(data: bytes) -> int:
            calls.append(data)
            return 0

        sketch = HyperLogLog(8, hash_fn=counting_hash)
        for index in range(100):
            sketch.add(f"item-{index}")
        self.assertEqual(len(calls), 100)
        self.assertEqual(len(set(calls)), 100)

    def test_replications_do_not_change_registers(self):
        # An observable depends only on the underlying set (introduction, p. 128).
        sketch = HyperLogLog(5)
        sketch.add_hash(0x12345678)
        once = sketch.registers
        for _ in range(10):
            sketch.add_hash(0x12345678)
        self.assertEqual(sketch.registers, once)

    def test_out_of_range_hash_word_is_rejected(self):
        sketch = HyperLogLog(4)
        with self.assertRaises(ValueError):
            sketch.add_hash(-1)
        with self.assertRaises(ValueError):
            sketch.add_hash(1 << 32)

    def test_merge_is_componentwise_max_and_matches_the_union(self):
        # Footnote 4: collect the register values and take a component-wise max.
        left = HyperLogLog(6)
        right = HyperLogLog(6)
        whole = HyperLogLog(6)
        for word in range(0, 500, 2):
            left.add_hash(word)
            whole.add_hash(word)
        for word in range(1, 500, 2):
            right.add_hash(word)
            whole.add_hash(word)
        merged = left.merge(right)
        self.assertEqual(merged.registers, whole.registers)
        # The operands are not modified.
        fresh_left = HyperLogLog(6)
        for word in range(0, 500, 2):
            fresh_left.add_hash(word)
        self.assertEqual(left.registers, fresh_left.registers)

    def test_overlapping_merge_matches_the_set_union(self):
        left = HyperLogLog(5)
        right = HyperLogLog(5)
        union = HyperLogLog(5)
        for word in range(200):
            left.add_hash(word)
            union.add_hash(word)
        for word in range(100, 300):
            right.add_hash(word)
            union.add_hash(word)
        self.assertEqual(left.merge(right).registers, union.registers)

    def test_merge_rejects_different_precision(self):
        with self.assertRaises(ValueError):
            HyperLogLog(4).merge(HyperLogLog(5))

    def test_from_registers_round_trip(self):
        sketch = HyperLogLog(4)
        for word in (1, 2, 3, 99, 1000):
            sketch.add_hash(word)
        clone = HyperLogLog.from_registers(sketch.registers)
        self.assertEqual(clone.registers, sketch.registers)
        self.assertEqual(clone.count(), sketch.count())

    def test_last_register_is_addressable(self):
        # The first b bits all equal to 1 select j = m, i.e. the last slot.
        sketch = HyperLogLog(4)
        word = 0xF0000001
        sketch.add_hash(word)
        self.assertEqual(sketch.registers[15] > 0, True)
        self.assertEqual(sum(rank > 0 for rank in sketch.registers), 1)


if __name__ == "__main__":
    unittest.main()
