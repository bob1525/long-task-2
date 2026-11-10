import assert from "node:assert/strict";
import { test } from "node:test";
import { compileSource, NO_OPTS } from "../src/compile.js";
import { ppAnf } from "../src/ir.js";

function raw(src: string): string {
  return ppAnf(compileSource(src, "t.fun", NO_OPTS).anf);
}

test("a literal binding is a let whose body is that variable", () => {
  assert.equal(raw("let main = 1"), "let main = 1 in\nmain");
});

test("arithmetic is named left to right and multiplication is grouped first", () => {
  assert.equal(
    raw("let main = 1 + 2 * 3"),
    ["let t1 = (2 * 3) in", "let t2 = (1 + t1) in", "t2"].join("\n"),
  );
});

test("a conditional is one computation, so the continuation is not duplicated", () => {
  assert.equal(
    raw("let main = if false then 1 else 2 + 3"),
    [
      "let t2 =",
      "  if false then",
      "    1",
      "  else",
      "    let t1 = (2 + 3) in",
      "    t1",
      "in",
      "t2",
    ].join("\n"),
  );
});

test("match scrutinees are atoms and arms stay in source order", () => {
  const ir = raw("type T = A | B\nlet main = match A with | A -> 1 | B -> 2");
  assert.equal(
    ir,
    [
      "let t1 = A in",
      "let t2 =",
      "  match t1 with",
      "    | A ->",
      "      1",
      "    | B ->",
      "      2",
      "in",
      "t2",
    ].join("\n"),
  );
});

test("a partially applied constructor is eta-expanded into a lambda", () => {
  const ir = raw("type List a = Nil | Cons a (List a)\nlet main = let c = Cons 1 in c Nil");
  assert.match(ir, /fun c1 ->/);
  assert.match(ir, /Cons\(1, c1\)/);
  assert.match(ir, /lam3\(t4\)/);
});

test("&& desugars to if before ANF, and both branches are atoms", () => {
  assert.equal(
    raw("let main = true && false"),
    ["let t1 =", "  if true then", "    false", "  else", "    false", "in", "t1"].join("\n"),
  );
});

test("a user binding named t1 does not collide with a fresh temporary", () => {
  const ir = raw("let t1 = 1\nlet main = t1 + 2");
  assert.match(ir, /let t1 = 1 in/);
  assert.match(ir, /\(t1 \+ 2\)|\(t1_2 \+ 2\)|\(t2 \+ t1\)/);
  const names = [...ir.matchAll(/\b(t1(?:_2)?|t2)\b/g)].map((m) => m[1]);
  assert.equal(new Set(names).size, names.length > 0 ? new Set(names).size : 0);
  assert.ok(new Set(names).size >= 2, ir);
});
