import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runSource, type OptFlags } from "../src/compile.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const examples = ["factorial", "list_map", "pattern_match", "compose"] as const;

const sets: Array<[string, OptFlags]> = [
  ["all", { constFold: true, dce: true, inline: true, tco: true }],
  ["none", { constFold: false, dce: false, inline: false, tco: false }],
  ["const-fold", { constFold: true, dce: false, inline: false, tco: false }],
  ["dce", { constFold: false, dce: true, inline: false, tco: false }],
  ["inline", { constFold: false, dce: false, inline: true, tco: false }],
  ["tco", { constFold: false, dce: false, inline: false, tco: true }],
];

for (const name of examples) {
  test(`${name} matches its expected output with optimizations on, off, and each pass alone`, () => {
    const src = readFileSync(path.join(root, "examples", `${name}.fun`), "utf8");
    const expected = readFileSync(path.join(root, "examples", `${name}.expected`), "utf8").trim();
    for (const [label, flags] of sets) {
      assert.equal(runSource(src, `${name}.fun`, flags), expected, label);
    }
  });
}
