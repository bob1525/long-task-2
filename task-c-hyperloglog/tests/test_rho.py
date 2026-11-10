import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hll.hyperloglog import HyperLogLog
from hll.registers import observe, rho, split_hash


class RhoTests(unittest.TestCase):
    def test_figure3_examples(self):
        # ρ(1···) = 1, ρ(0001···) = 4, ρ(0^K) = K + 1.
        self.assertEqual(rho(0b1, 1), 1)
        self.assertEqual(rho(0b1000, 4), 1)
        self.assertEqual(rho(0b0001, 4), 4)
        self.assertEqual(rho(0b00010000, 8), 4)
        self.assertEqual(rho(0b00010011, 8), 4)
        self.assertEqual(rho(0, 5), 6)
        self.assertEqual(rho(0, 28), 29)

    def test_leftmost_not_rightmost(self):
        # 0b00010111 has its leftmost 1 at position 4. The rightmost 1 is at the end.
        self.assertEqual(rho(0b00010111, 8), 4)

    def test_word_must_fit_in_width(self):
        with self.assertRaises(ValueError):
            rho(0b10000, 4)

    def test_first_b_bits_select_the_register(self):
        # b = 4. Leading bits 0001 → paper index j = 2, stored at offset 1.
        # The next bits are 0001 ···, so ρ(w) = 4. The low bits must not be read as the index.
        word = (0b0001 << 28) | (0b0001 << 24)
        index, rest, width = split_hash(word, 4)
        self.assertEqual(index, 1)
        self.assertEqual(width, 28)
        self.assertEqual(rho(rest, width), 4)

        sketch = HyperLogLog(4)
        sketch.add_hash(word)
        registers = sketch.registers
        self.assertEqual(registers[1], 4)
        self.assertEqual(sum(registers), 4)

    def test_all_zero_remainder_uses_width_plus_one(self):
        # Leading nibble 0001, remaining 28 bits clear: ρ(0^28) = 29.
        word = 0b0001 << 28
        sketch = HyperLogLog(4)
        sketch.add_hash(word)
        self.assertEqual(sketch.registers[1], 29)

    def test_observe_keeps_the_maximum(self):
        registers = bytearray(16)
        low = (0b0010 << 28) | (0b1000 << 24)  # index 2, ρ = 1
        high = (0b0010 << 28) | (0b0001 << 24)  # index 2, ρ = 4
        observe(registers, low, 4)
        observe(registers, high, 4)
        observe(registers, low, 4)
        self.assertEqual(registers[2], 4)

    def test_precision_outside_the_program_is_rejected(self):
        with self.assertRaises(ValueError):
            split_hash(0, 3)
        with self.assertRaises(ValueError):
            split_hash(0, 17)


if __name__ == "__main__":
    unittest.main()
