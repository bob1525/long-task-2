/**
 * Adversarial Hindley-Milner checks: let polymorphism versus lambda
 * monomorphism, recursive generalization, constructor types, the occurs
 * check, and where the error caret is drawn.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CompileError, formatError } from "../src/errors.js";
import { inferProgram } from "../src/typecheck.js";

function typeError(src: string): CompileError {
  try {
    inferProgram(src, "t.fun");
  } catch (err) {
    assert.ok(err instanceof CompileError);
    return err;
  }
  assert.fail("expected a type error");
}

function top(src: string, name: string): string {
  const found = inferProgram(src, "t.fun").bindings.filter((b) => b.topLevel && b.name === name);
  assert.equal(found.length, 1);
  return found[0]!.type;
}

test("let generalizes and a lambda parameter stays monomorphic", () => {
  assert.equal(
    top("let id = fun x -> x\nlet main = if id true then id 1 else 0", "id"),
    "∀a. a -> a",
  );
  const mono = "let main = (fun id -> if id true then id 1 else 0) (fun x -> x)";
  const err = typeError(mono);
  assert.match(err.message, /cannot apply function of type Bool -> Bool to argument of type Int/);
  assert.equal(err.span?.start.col, 39);
});

test("binding a lambda parameter with let does not quantify it", () => {
  const err = typeError("let main = (fun x -> let y = x in if y true then y 1 else 0) (fun z -> z)");
  assert.match(err.message, /cannot apply function of type Bool -> Bool to argument of type Int/);
});

test("a let inside a lambda is still generalized", () => {
  assert.equal(
    top("let main = (fun x -> let id = fun y -> y in if id true then id 1 else x) 0", "main"),
    "Int",
  );
});

test("let rec is polymorphic after its body and monomorphic inside it", () => {
  assert.equal(top("let rec id x = x\nlet main = if id true then id 1 else 0", "id"), "∀a. a -> a");
  assert.equal(top("let rec id x = if true then x else id 1\nlet main = id 2", "id"), "Int -> Int");
  const err = typeError("let rec id x = if true then x else id 1\nlet main = if id true then 1 else 0");
  assert.match(err.message, /cannot apply function of type Int -> Int to argument of type Bool/);
});

test("a recursive function can return a polymorphic function", () => {
  assert.equal(top("let rec f x = fun y -> y\nlet g = f 1\nlet main = if g true then g 1 else 0", "g"), "∀a. a -> a");
});

test("constructor schemes instantiate per use", () => {
  const src = "type List a = Nil | Cons a (List a)\nlet main = Cons true (Cons 1 Nil)";
  assert.match(typeError(src).message, /cannot apply function of type List Bool -> List Bool/);
  assert.equal(
    top("type Pair a b = Mk a b\nlet main = match Mk 1 true with | Mk x y -> if y then x else 0", "main"),
    "Int",
  );
});

test("occurs check rejects self-application and a recursive constructor cycle", () => {
  assert.match(typeError("let main = (fun x -> x x) (fun y -> y)").message, /infinite type/);
  assert.match(typeError("let rec f x = f\nlet main = 1").message, /infinite type/);
  assert.match(typeError("type Box a = Mk a\nlet rec f x = Mk (f x)\nlet main = 1").message, /infinite type/);
});

test("infinite type on let rec points at the body, not the let keyword", () => {
  const src = "let rec f x = f\nlet main = 1";
  const err = typeError(src);
  const text = formatError(err, src);
  assert.equal(err.span?.start.line, 1);
  assert.equal(err.span?.start.col, 15, text);
  assert.match(text, /t\.fun:1:15: type error: infinite type/);
});

test("a rejected annotation points at the annotation", () => {
  const src = "let rec f : a -> a = fun x -> f 1\nlet main = f 2";
  const err = typeError(src);
  const text = formatError(err, src);
  assert.equal(err.span?.start.line, 1);
  assert.equal(err.span?.start.col, 13, text);
  assert.match(err.message, /annotation a -> a does not match inferred type Int -> a/);
});

test("polymorphic equality is quantified and a lambda-bound eq is not", () => {
  assert.equal(top("let eq x y = x == y\nlet main = if eq 1 1 then eq true false else false", "eq"), "∀a. a -> a -> Bool");
  const err = typeError("let main = (fun eq -> if eq 1 1 then eq true false else false) (fun x y -> x == y)");
  assert.match(err.message, /cannot apply function of type Int -> Int -> Bool to argument of type Bool/);
});
