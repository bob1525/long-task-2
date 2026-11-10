import assert from "node:assert/strict";
import { test } from "node:test";
import { compileSource, type OptFlags } from "../src/compile.js";
import { ppAnf } from "../src/ir.js";

const none: OptFlags = { constFold: false, dce: false, inline: false, tco: false };
const onlyInline: OptFlags = { constFold: false, dce: false, inline: true, tco: false };
const onlyFold: OptFlags = { constFold: true, dce: false, inline: false, tco: false };
const onlyDce: OptFlags = { constFold: false, dce: true, inline: false, tco: false };

function ir(src: string, flags: OptFlags): string {
  return ppAnf(compileSource(src, "t.fun", flags).ir);
}

const arith = "let main = 1 + 2 * 3";
const arithRaw = ["let t1 = (2 * 3) in", "let t2 = (1 + t1) in", "t2"].join("\n");
const arithFolded = ["let t1 = 6 in", "let t2 = 7 in", "7"].join("\n");

test("constant folding rewrites arithmetic and leaves the dead lets for DCE", () => {
  assert.equal(ir(arith, none), arithRaw);
  assert.equal(ir(arith, onlyFold), arithFolded);
  assert.notEqual(ir(arith, none), ir(arith, onlyFold));
  assert.equal(ir(arith, { constFold: true, dce: true, inline: false, tco: false }), "7");
});

test("constant folding does not fold division by zero", () => {
  const src = "let main = 1 / 0";
  const kept = "let t1 = (1 / 0) in\nt1";
  assert.equal(ir(src, none), kept);
  assert.equal(ir(src, onlyFold), kept);
  assert.equal(ir(src, { constFold: true, dce: true, inline: true, tco: true }), kept);
});

test("constant folding of a constant if keeps only the taken branch", () => {
  const src = "let main = if false then 1 else 2 + 3";
  const before = [
    "let t2 =",
    "  if false then",
    "    1",
    "  else",
    "    let t1 = (2 + 3) in",
    "    t1",
    "in",
    "t2",
  ].join("\n");
  const after = ["let t1 = 5 in", "let t2 = 5 in", "5"].join("\n");
  assert.equal(ir(src, none), before);
  assert.equal(ir(src, onlyFold), after);
  assert.notEqual(before, after);
});

test("constant folding reduces a short-circuit && to the taken atom", () => {
  const src = "let main = true && false";
  assert.match(ir(src, none), /if true then/);
  assert.equal(ir(src, onlyFold), "let t1 = false in\nfalse");
});

const inc = "let inc x = x + 1\nlet main = inc 10";
const incRaw = [
  "let inc =",
  "  fun x ->",
  "    let t1 = (x + 1) in",
  "    t1",
  "in",
  "let t2 = inc(10) in",
  "t2",
].join("\n");

test("inlining substitutes a function used at exactly one call", () => {
  assert.equal(ir(inc, none), incRaw);
  assert.equal(ir(inc, onlyInline), "let t1 = (10 + 1) in\nt1");
  assert.notEqual(ir(inc, none), ir(inc, onlyInline));
});

test("inlining leaves a function that is called twice", () => {
  const src = "let inc x = x + 1\nlet main = inc (inc 1)";
  assert.equal(ir(src, none), ir(src, onlyInline));
  assert.match(ir(src, onlyInline), /fun x ->/);
  assert.match(ir(src, onlyInline), /inc\(1\)/);
  assert.match(ir(src, onlyInline), /inc\(t2\)/);
});

test("inlining leaves a function whose only uses are as a value", () => {
  const src = "let id x = x\nlet apply f x = f x\nlet main = (apply id 1) + (apply id 2)";
  const before = ir(src, none);
  const after = ir(src, onlyInline);
  assert.equal(before, after);
  assert.match(after, /fun x ->/);
  assert.match(after, /apply\(id\)/);
});

const unused = "let unused = 1 + 2\nlet main = 3";
const unusedRaw = ["let t1 = (1 + 2) in", "let main = 3 in", "main"].join("\n");

test("dead code elimination drops a pure binding that the result does not use", () => {
  assert.equal(ir(unused, none), unusedRaw);
  assert.equal(ir(unused, onlyDce), "let main = 3 in\nmain");
  assert.notEqual(ir(unused, none), ir(unused, onlyDce));
});

test("dead code elimination keeps an unused call that may diverge", () => {
  const src = "let rec loop x = loop x\nlet unused = loop 1\nlet main = 2";
  const before = ir(src, none);
  const after = ir(src, onlyDce);
  assert.equal(before, after);
  assert.match(after, /loop\(1\)/);
  assert.match(after, /let rec loop/);
});

test("the full pipeline folds, inlines, then deletes the leftovers", () => {
  assert.equal(ir(arith, { constFold: true, dce: true, inline: true, tco: true }), "7");
  assert.equal(ir(inc, { constFold: true, dce: true, inline: true, tco: true }), "11");
  assert.equal(ir(unused, { constFold: true, dce: true, inline: true, tco: true }), "3");
  assert.equal(ir("let main = if false then 1 else 2 + 3", { constFold: true, dce: true, inline: true, tco: true }), "5");
});
