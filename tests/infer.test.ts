import assert from "node:assert/strict";
import { test } from "node:test";
import { CompileError, formatError } from "../src/errors.js";
import { inferProgram } from "../src/typecheck.js";

function top(src: string, name: string): string {
  const found = inferProgram(src, "t.fun").bindings.filter((b) => b.topLevel && b.name === name);
  assert.equal(found.length, 1, `missing top-level binding ${name}`);
  return found[0]!.type;
}

function nested(src: string, name: string): string {
  const found = inferProgram(src, "t.fun").bindings.filter((b) => b.name === name);
  assert.ok(found.length >= 1, `missing binding ${name}`);
  return found[found.length - 1]!.type;
}

function typeError(src: string): CompileError {
  try {
    inferProgram(src, "t.fun");
  } catch (err) {
    assert.ok(err instanceof CompileError, err instanceof Error ? err.message : String(err));
    assert.equal(err.phase, "type");
    return err;
  }
  assert.fail("expected a type error");
}

test("integer literal", () => {
  assert.equal(top("let main = 1", "main"), "Int");
});

test("boolean literal", () => {
  assert.equal(top("let main = true", "main"), "Bool");
});

test("string literal", () => {
  assert.equal(top('let main = "hi"', "main"), "String");
});

test("arithmetic and comparisons", () => {
  assert.equal(top("let main = 1 + 2 * 3", "main"), "Int");
  assert.equal(top("let main = 1 < 2", "main"), "Bool");
  assert.equal(top("let main = -5", "main"), "Int");
});

test("string concatenation", () => {
  assert.equal(top('let main = "a" ++ "b"', "main"), "String");
});

test("if expression unifies branch types", () => {
  assert.equal(top("let main = if true then 1 else 2", "main"), "Int");
});

test("identity is polymorphic", () => {
  assert.equal(top("let id = fun x -> x\nlet main = id", "id"), "∀a. a -> a");
  assert.equal(top("let id = fun x -> x\nlet main = id", "main"), "∀a. a -> a");
});

test("let-polymorphism: one binding used at Int and Bool", () => {
  const src = `
    let id = fun x -> x
    let n = id 1
    let b = id true
    let main = n
  `;
  assert.equal(top(src, "id"), "∀a. a -> a");
  assert.equal(top(src, "n"), "Int");
  assert.equal(top(src, "b"), "Bool");
});

test("polymorphic self-application id id", () => {
  const src = `
    let id = fun x -> x
    let main = id id
  `;
  assert.equal(top(src, "main"), "∀a. a -> a");
});

test("let generalization inside a lambda, used at two types", () => {
  const src = `
    let apply = fun x ->
      let id = fun y -> y in
      if id true then id x else x
    let main = apply 1
  `;
  assert.equal(nested(src, "id"), "∀a. a -> a");
  assert.equal(top(src, "apply"), "∀a. a -> a");
  assert.equal(top(src, "main"), "Int");
});

test("higher-order twice", () => {
  assert.equal(
    top("let twice f x = f (f x)\nlet main = twice", "twice"),
    "∀a. (a -> a) -> a -> a",
  );
});

test("recursive factorial is Int -> Int", () => {
  const src = `
    let rec factorial n =
      if n <= 1 then 1 else n * factorial (n - 1)
    let main = factorial 5
  `;
  assert.equal(top(src, "factorial"), "Int -> Int");
  assert.equal(top(src, "main"), "Int");
});

test("polymorphic equality", () => {
  const src = `
    let eq x y = x == y
    let main = eq 1 2
    let b = eq true false
  `;
  assert.equal(top(src, "eq"), "∀a. a -> a -> Bool");
  assert.equal(top(src, "main"), "Bool");
  assert.equal(top(src, "b"), "Bool");
});

test("ADT construction and pattern matching", () => {
  const src = `
    type Shape = Circle Int | Rect Int Int
    let area s =
      match s with
      | Circle r -> r * r
      | Rect w h -> w * h
    let main = area (Rect 3 4)
  `;
  assert.equal(top(src, "area"), "Shape -> Int");
  assert.equal(top(src, "main"), "Int");
});

test("lists are ordinary ADTs and map is polymorphic", () => {
  const src = `
    type List a = Nil | Cons a (List a)
    let rec map f xs =
      match xs with
      | Nil -> Nil
      | Cons h t -> Cons (f h) (map f t)
    let main = map (fun x -> x * 2) (Cons 1 (Cons 2 Nil))
    let flags = map (fun x -> x == 0) (Cons 1 Nil)
  `;
  assert.equal(top(src, "map"), "∀a b. (a -> b) -> List a -> List b");
  assert.equal(top(src, "main"), "List Int");
  assert.equal(top(src, "flags"), "List Bool");
});

test("a conditional function is still generalized", () => {
  const src = `
    let id = if true then fun x -> x else fun y -> y
    let main = id true
  `;
  assert.equal(top(src, "id"), "∀a. a -> a");
  assert.equal(top(src, "main"), "Bool");
});

test("inner let shadows an outer binding", () => {
  assert.equal(top("let main = let x = 1 in let x = true in x", "main"), "Bool");
});

test("annotation accepts the principal type and a valid instantiation", () => {
  assert.equal(top("let id : a -> a = fun x -> x\nlet main = id 1", "id"), "∀a. a -> a");
  assert.equal(top("let inc : Int -> Int = fun x -> x + 1\nlet main = inc 1", "inc"), "Int -> Int");
});

test("if condition must be Bool", () => {
  const err = typeError("let main = if 1 then true else false");
  assert.match(err.message, /if condition must be Bool, but got Int/);
  assert.equal(err.span?.start.line, 1);
});

test("if branches must agree", () => {
  const err = typeError("let main = if true then 1 else false");
  assert.match(err.message, /if branches have different types: Int and Bool/);
});

test("arithmetic rejects Bool", () => {
  const src = "let main = 1 + true";
  const err = typeError(src);
  assert.match(err.message, /operator '\+' expects Int and Int, but got Int and Bool/);
  const text = formatError(err, src);
  // "let main = " is 11 columns, so the operator expression starts at column 12.
  assert.match(text, /t\.fun:1:12: type error:/);
  assert.match(text, /\n {11}\^/);
});

test("unbound variable points at the use", () => {
  const src = "let main =\n  missing";
  const err = typeError(src);
  assert.match(err.message, /unbound variable 'missing'/);
  assert.equal(err.span?.start.line, 2);
  assert.equal(err.span?.start.col, 3);
  assert.match(formatError(err, src), /type error: unbound variable 'missing'/);
});

test("self-application of a parameter is an infinite type", () => {
  const err = typeError("let main = fun x -> x x");
  assert.match(err.message, /infinite type/);
});

test("constructor pattern arity is checked", () => {
  const src = `
    type List a = Nil | Cons a (List a)
    let main = match Nil with
      | Cons h -> h
      | Nil -> 0
  `;
  const err = typeError(src);
  assert.match(err.message, /constructor 'Cons' expects 2 argument\(s\) but pattern has 1/);
});

test("annotation that is too general is rejected", () => {
  const err = typeError("let id : a -> b = fun x -> x\nlet main = id");
  assert.match(err.message, /annotation a -> b does not match inferred type a -> a/);
});

test("a monomorphic annotation rejects a use at another type", () => {
  const err = typeError("let id : Int -> Int = fun x -> x\nlet main = id true");
  assert.match(err.message, /cannot apply function of type Int -> Int to argument of type Bool/);
});

test("annotation that is more specific than the implementation is rejected", () => {
  const err = typeError("let inc : a -> a = fun x -> x + 1\nlet main = inc 1");
  assert.match(err.message, /annotation a -> a does not match inferred type Int -> Int/);
});

test("duplicate top-level binding", () => {
  const err = typeError("let x = 1\nlet x = true\nlet main = x");
  assert.match(err.message, /duplicate top-level binding 'x'/);
});

test("unknown type and unsaturated type constructor in an annotation", () => {
  assert.match(typeError("let main : Foo = 1").message, /unknown type 'Foo'/);
  const err = typeError("type List a = Nil | Cons a (List a)\nlet main : List = Nil");
  assert.match(err.message, /type 'List' expects 1 argument/);
});

test("match arms with different result types", () => {
  const src = `
    type Shape = Circle Int | Rect Int Int
    let bad s =
      match s with
      | Circle r -> r
      | Rect w h -> true
    let main = bad (Circle 1)
  `;
  const err = typeError(src);
  assert.match(err.message, /match arms have different types: Int and Bool/);
});

test("duplicate pattern variable", () => {
  const src = `
    type List a = Nil | Cons a (List a)
    let main = match Cons 1 Nil with
      | Cons x x -> x
      | Nil -> 0
  `;
  assert.match(typeError(src).message, /duplicate pattern variable 'x'/);
});
