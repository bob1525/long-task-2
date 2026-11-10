/**
 * Inlining does fire on a curried call that is applied once. A partial
 * application whose function value is used twice inlines only the applied
 * prefix; the remaining lambda stays, because a value used twice is not
 * duplicated. Recursive functions, and functions passed into another
 * function, are not inlined.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compileSource, NO_OPTS, runSource } from "../src/compile.js";
import { ppAnf } from "../src/ir.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inline = { constFold: false, dce: false, inline: true, tco: false };

const COMPOSE_NONE = `let compose =
  fun f ->
    let lam4 =
      fun g ->
        let lam3 =
          fun x ->
            let t1 = g(x) in
            let t2 = f(t1) in
            t2
        in
        lam3
    in
    lam4
in
let inc =
  fun x_2 ->
    let t5 = (x_2 + 1) in
    t5
in
let double =
  fun x_3 ->
    let t6 = (x_3 * 2) in
    t6
in
let t7 = compose(inc) in
let t8 = t7(double) in
let t9 = t8(10) in
t9`;

const COMPOSE_INLINE = `let t6 = (10 * 2) in
let t5 = (t6 + 1) in
t5`;

test("compose inlines a once-applied curried call", () => {
  const src = readFileSync(path.join(root, "examples", "compose.fun"), "utf8");
  const raw = ppAnf(compileSource(src, "compose.fun", NO_OPTS).ir);
  const opt = ppAnf(compileSource(src, "compose.fun", inline).ir);
  assert.equal(raw, COMPOSE_NONE);
  assert.equal(opt, COMPOSE_INLINE);
  assert.notEqual(raw, opt);
  assert.equal(runSource(src, "compose.fun", NO_OPTS), "21");
  assert.equal(runSource(src, "compose.fun", inline), "21");
});

test("a fully applied curried function inlines to the primitive", () => {
  const src = "let add x y = x + y\nlet main = add 1 41\n";
  const raw = ppAnf(compileSource(src, "t.fun", NO_OPTS).ir);
  const opt = ppAnf(compileSource(src, "t.fun", inline).ir);
  assert.match(raw, /add\(1\)/);
  assert.equal(opt, "let t1 = (1 + 41) in\nt1");
  assert.equal(runSource(src, "t.fun", inline), "42");
});

test("a partial application used twice inlines only the applied prefix", () => {
  const src = "let add x y = x + y\nlet add1 = add 1\nlet main = add1 10 + add1 20\n";
  const raw = ppAnf(compileSource(src, "t.fun", NO_OPTS).ir);
  const opt = ppAnf(compileSource(src, "t.fun", inline).ir);
  assert.match(raw, /add\(1\)/);
  assert.equal(
    opt,
    `let lam2 =
  fun y ->
    let t1 = (1 + y) in
    t1
in
let t4 = lam2(10) in
let t5 = lam2(20) in
let t6 = (t4 + t5) in
t6`,
  );
  assert.match(opt, /fun y ->/);
  assert.equal(runSource(src, "t.fun", NO_OPTS), "32");
  assert.equal(runSource(src, "t.fun", inline), "32");
});

test("a recursive function and a function passed to map stay out of line", () => {
  const fact = readFileSync(path.join(root, "examples", "factorial.fun"), "utf8");
  const factIr = ppAnf(compileSource(fact, "factorial.fun", inline).ir);
  assert.match(factIr, /factorial/);
  assert.match(factIr, /fun /);

  const map = readFileSync(path.join(root, "examples", "list_map.fun"), "utf8");
  const raw = ppAnf(compileSource(map, "list_map.fun", NO_OPTS).ir);
  const opt = ppAnf(compileSource(map, "list_map.fun", inline).ir);
  assert.equal(raw, opt);
  assert.match(opt, /fun x/);
});
