/**
 * Self tail calls become a loop. The IR comparison is the pass on its own.
 * A deep accumulator agrees with a small one, and turning the pass off
 * restores a recursive function that overflows as a clean runtime error.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compileSource, executeJs, flagsFromArgs, NO_OPTS, runSource } from "../src/compile.js";
import { ppAnf } from "../src/ir.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const onlyTco = { constFold: false, dce: false, inline: false, tco: true };

const LOOP = `let rec loop n acc = if n == 0 then acc else loop (n - 1) (acc + 1)
let main = loop 5 0
`;

const LOOP_NONE = `let rec loop = fun n ->
  let lam7 =
    fun acc ->
      let t1 = (n == 0) in
      let t6 =
        if t1 then
          acc
        else
          let t2 = (n - 1) in
          let t3 = (acc + 1) in
          let t4 = loop(t2) in
          let t5 = t4(t3) in
          t5
      in
      t6
  in
  lam7
in
let t8 = loop(5) in
let t9 = t8(0) in
t9`;

const LOOP_TCO = `let rec loop(n, acc) =
  let t1 = (n == 0) in
  let t6 =
    if t1 then
      acc
    else
      let t2 = (n - 1) in
      let t3 = (acc + 1) in
      jump(t2, t3)
  in
  t6
in
let t8 = loop(5) in
let t9 = t8(0) in
t9`;

test("tail-call optimization rewrites a saturated self call into a jump", () => {
  const raw = ppAnf(compileSource(LOOP, "t.fun", NO_OPTS).ir);
  const opt = ppAnf(compileSource(LOOP, "t.fun", onlyTco).ir);
  assert.equal(raw, LOOP_NONE);
  assert.equal(opt, LOOP_TCO);
  assert.match(raw, /loop\(t2\)/);
  assert.doesNotMatch(raw, /jump\(/);
  assert.match(opt, /jump\(t2, t3\)/);
  assert.doesNotMatch(opt, /loop\(t2\)/);
});

test("a non-tail recursion is left as a call", () => {
  const src = "let rec fact n = if n <= 1 then 1 else n * fact (n - 1)\nlet main = fact 6\n";
  const opt = ppAnf(compileSource(src, "t.fun", onlyTco).ir);
  assert.doesNotMatch(opt, /jump\(/);
  assert.match(opt, /fact\(/);
  assert.equal(runSource(src, "t.fun", NO_OPTS), "720");
  assert.equal(runSource(src, "t.fun", onlyTco), "720");
});

test("small and deep tail loops agree, and the same closure can be called twice", () => {
  const small = "let rec loop n acc = if n == 0 then acc else loop (n - 1) (acc + 1)\nlet main = loop 20 0\n";
  assert.equal(runSource(small, "t.fun", NO_OPTS), "20");
  assert.equal(runSource(small, "t.fun", onlyTco), "20");

  const deep = "let rec loop n acc = if n == 0 then acc else loop (n - 1) (acc + 1)\nlet main = loop 100000 0\n";
  assert.equal(runSource(deep, "t.fun", onlyTco), "100000");
  assert.equal(runSource(deep, "loop.fun"), "100000");

  const twice = "let rec add n acc = if n == 0 then acc else add (n - 1) (acc + 1)\nlet g = add 0\nlet main = g 3 + g 4\n";
  assert.equal(runSource(twice, "t.fun", NO_OPTS), "7");
  assert.equal(runSource(twice, "t.fun", onlyTco), "7");

  const match = "let rec down n = match n == 0 with | true -> 0 | false -> down (n - 1)\nlet main = down 10000\n";
  assert.equal(runSource(match, "t.fun", onlyTco), "0");
  const three = "let rec f a b c = if a == 0 then b + c else f (a - 1) (b + 1) c\nlet main = f 10000 0 2\n";
  assert.equal(runSource(three, "t.fun", onlyTco), "10002");
  assert.equal(runSource(three.replace("10000", "3"), "t.fun", NO_OPTS), "5");
});

test("--opt none disables tail calls and a deep loop overflows cleanly", () => {
  const src = "let rec loop n acc = if n == 0 then acc else loop (n - 1) (acc + 1)\nlet main = loop 100000 0\n";
  const none = ppAnf(compileSource(src, "t.fun", flagsFromArgs(["--opt", "none"])).ir);
  const all = ppAnf(compileSource(src, "t.fun", flagsFromArgs(["--no-tco", "--opt", "all"])).ir);
  const off = ppAnf(compileSource(src, "t.fun", flagsFromArgs(["--opt", "all", "--no-tco"])).ir);
  assert.match(none, /let rec loop = fun n ->/);
  assert.doesNotMatch(none, /jump\(/);
  assert.match(all, /let rec loop\(n, acc\)/);
  assert.match(all, /jump\(/);
  assert.doesNotMatch(off, /jump\(/);

  const overflow = executeJs(compileSource(src, "t.fun", flagsFromArgs(["--opt", "none"])).js, 4000);
  assert.equal(overflow.timedOut, false);
  assert.notEqual(overflow.status, 0);
  assert.equal(overflow.stderr.trim(), "runtime error: stack overflow");
  assert.doesNotMatch(overflow.stderr, /prog\.js/);
  assert.doesNotMatch(overflow.stderr, /RangeError/);
});

test("the CLI runs a deep tail loop and --opt none reports the overflow", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "funcc-tco-"));
  const file = path.join(dir, "loop.fun");
  writeFileSync(
    file,
    "let rec loop n acc = if n == 0 then acc else loop (n - 1) (acc + 1)\nlet main = loop 100000 0\n",
  );
  const cli = path.join(root, "src", "cli.ts");
  try {
    const on = spawnSync(process.execPath, [tsx, cli, "run", file], { encoding: "utf8" });
    assert.equal(on.status, 0, on.stderr);
    assert.equal((on.stdout ?? "").trim(), "100000");

    const off = spawnSync(process.execPath, [tsx, cli, "run", file, "--opt", "none"], { encoding: "utf8" });
    assert.notEqual(off.status, 0);
    assert.equal((off.stderr ?? "").trim(), "runtime error: stack overflow");
    assert.equal((off.stdout ?? "").trim(), "");
    assert.doesNotMatch(off.stderr ?? "", /prog\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
