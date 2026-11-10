/**
 * Exhaustiveness warnings. Bool and algebraic types are finite, including
 * constructors nested under other constructors. Int is open. A warning does
 * not reject the program; a missed value still fails at run time.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { compileSource, executeJs, NO_OPTS } from "../src/compile.js";
import { inferProgram } from "../src/typecheck.js";

function warnings(src: string): string[] {
  return inferProgram(src, "t.fun").warnings;
}

function missing(src: string): string[] {
  return warnings(src).map((warning) => {
    const hit = warning.match(/missing (.+)$/);
    assert.ok(hit, warning);
    return hit[1]!;
  });
}

test("a complete match draws no warning", () => {
  assert.deepEqual(warnings("let main = match true with | true -> 1 | false -> 2"), []);
  assert.deepEqual(
    warnings("type Opt a = None | Some a\nlet main = match Some 1 with | None -> 0 | Some x -> x"),
    [],
  );
  assert.deepEqual(
    warnings(
      "type List a = Nil | Cons a (List a)\nlet main = match Nil with | Nil -> 0 | Cons _ _ -> 1",
    ),
    [],
  );
  assert.deepEqual(
    warnings("type T = A Bool\nlet main = match A true with | A true -> 1 | A false -> 2"),
    [],
  );
  assert.deepEqual(
    warnings(
      "type List a = Nil | Cons a (List a)\nlet main = match Nil with | Nil -> 0 | Cons _ Nil -> 1 | Cons _ (Cons _ _) -> 2",
    ),
    [],
  );
});

test("missing top-level constructors are named", () => {
  assert.deepEqual(missing("let main = match true with | true -> 1"), ["false"]);
  assert.deepEqual(
    missing("type Opt a = None | Some a\nlet get o = match o with | Some x -> x\nlet main = get None"),
    ["None"],
  );
  assert.deepEqual(
    missing("type T = A | B | C\nlet main = match A with | A -> 1 | C -> 2"),
    ["B"],
  );
});

test("nested constructor coverage is not just the outer tag", () => {
  assert.deepEqual(
    missing(
      "type List a = Nil | Cons a (List a)\nlet main = match Cons 1 Nil with | Nil -> 0 | Cons _ Nil -> 1",
    ),
    ["Cons _ (Cons _ _)"],
  );
  assert.deepEqual(
    missing("type T = A Bool Int\nlet main = match A false 2 with | A true _ -> 0 | A false 1 -> 1"),
    ["A false _"],
  );
  assert.deepEqual(
    missing("type T = C Bool Bool\nlet main = match C true false with | C true _ -> 1 | C false true -> 2"),
    ["C false false"],
  );
  assert.deepEqual(
    missing("type T = C Bool Bool\nlet main = match C false false with | C true _ -> 1 | C _ true -> 2"),
    ["C false false"],
  );
});

test("an open type is covered only by a variable or wildcard", () => {
  assert.deepEqual(missing("let main = match 1 with | 0 -> 1 | 1 -> 2"), ["_"]);
  assert.deepEqual(warnings("let main = match 1 with | 0 -> 1 | _ -> 2"), []);
  assert.deepEqual(warnings("type T = A Int\nlet main = match A 0 with | A 0 -> 1 | A _ -> 2"), []);
  assert.deepEqual(missing("type T = A Int\nlet main = match A 1 with | A 0 -> 1"), ["A _"]);
});

test("overlapping arms stay first-match and a wildcard covers the rest", () => {
  assert.deepEqual(warnings("type T = A | B | C\nlet main = match B with | A -> 1 | _ -> 2 | C -> 3"), []);
  const src = "type T = A | B | C\nlet main = match B with | A -> 1 | _ -> 2 | C -> 3";
  const result = executeJs(compileSource(src, "t.fun", NO_OPTS).js);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "2");
});

test("a nested miss fails at the match, with the warning's witness", () => {
  const src = "type List a = Nil | Cons a (List a)\nlet main = match Cons 1 (Cons 2 Nil) with | Nil -> 0 | Cons _ Nil -> 1";
  assert.deepEqual(missing(src), ["Cons _ (Cons _ _)"]);
  const result = executeJs(compileSource(src, "n.fun", NO_OPTS).js);
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr.trim(), "runtime error: non-exhaustive pattern match at n.fun:2:12");
  assert.doesNotMatch(result.stderr, /prog\.js/);
});
