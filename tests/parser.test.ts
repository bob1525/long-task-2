import assert from "node:assert/strict";
import { test } from "node:test";
import type { Expr } from "../src/ast.js";
import { formatProgram } from "../src/ast.js";
import { CompileError, formatError } from "../src/errors.js";
import { parse } from "../src/parser.js";

function letValue(src: string): Expr {
  const prog = parse(src);
  const decl = prog.decls[0];
  assert.ok(decl && decl.tag === "let");
  return decl.value;
}

test("parses arithmetic with standard precedence and left associativity", () => {
  const e = letValue("let main = 1 + 2 * 3 - 4");
  assert.equal(e.tag, "prim");
  if (e.tag !== "prim") return;
  assert.equal(e.op, "-");
  const left = e.args[0]!;
  assert.equal(left.tag, "prim");
  if (left.tag !== "prim") return;
  assert.equal(left.op, "+");
  const mul = left.args[1]!;
  assert.equal(mul.tag, "prim");
  if (mul.tag !== "prim") return;
  assert.equal(mul.op, "*");
});

test("application binds tighter than infix and unary minus", () => {
  const e = letValue("let main = -f x + 1");
  assert.equal(e.tag, "prim");
  if (e.tag !== "prim") return;
  assert.equal(e.op, "+");
  const neg = e.args[0]!;
  assert.equal(neg.tag, "prim");
  if (neg.tag !== "prim") return;
  assert.equal(neg.op, "neg");
  const app = neg.args[0]!;
  assert.equal(app.tag, "app");
  if (app.tag !== "app") return;
  assert.equal(app.fn.tag, "var");
  assert.equal(app.arg.tag, "var");
});

test("desugars && and || into short-circuit if expressions", () => {
  const e = letValue("let main = a && b || c");
  assert.equal(e.tag, "if");
  if (e.tag !== "if") return;
  // || is looser than &&, so this is (a && b) || c.
  assert.equal(e.then.tag, "bool");
  assert.equal(e.else.tag, "var");
  assert.equal(e.cond.tag, "if");
});

test("desugars multi-parameter fun and let into nested functions", () => {
  const e = letValue("let add x y = x + y");
  assert.equal(e.tag, "fun");
  if (e.tag !== "fun") return;
  assert.equal(e.param, "x");
  assert.equal(e.body.tag, "fun");
  if (e.body.tag !== "fun") return;
  assert.equal(e.body.param, "y");
});

test("parses algebraic type declarations, including a leading bar", () => {
  const prog = parse(`
    type List a =
      | Nil
      | Cons a (List a)
  `);
  assert.equal(prog.decls.length, 1);
  const d = prog.decls[0]!;
  assert.equal(d.tag, "type");
  if (d.tag !== "type") return;
  assert.equal(d.name, "List");
  assert.deepEqual(d.params, ["a"]);
  assert.equal(d.variants[0]!.name, "Nil");
  assert.equal(d.variants[0]!.argTypes.length, 0);
  assert.equal(d.variants[1]!.name, "Cons");
  assert.equal(d.variants[1]!.argTypes.length, 2);
  assert.equal(d.variants[1]!.argTypes[1]!.tag, "tcon");
});

test("parses match arms and requires parentheses around a nested match", () => {
  const prog = parse(`
    let main = match x with
      | A -> (match y with | B -> 1 | C -> 2)
      | D -> 3
  `);
  const decl = prog.decls[0]!;
  assert.equal(decl.tag, "let");
  if (decl.tag !== "let") return;
  assert.equal(decl.value.tag, "match");
  if (decl.value.tag !== "match") return;
  assert.equal(decl.value.arms.length, 2);
  assert.equal(decl.value.arms[0]!.body.tag, "match");
  if (decl.value.arms[0]!.body.tag !== "match") return;
  assert.equal(decl.value.arms[0]!.body.arms.length, 2);
  assert.equal(decl.value.arms[1]!.pattern.tag, "pctor");
});

test("parses nested constructor patterns only when parenthesized", () => {
  const e = letValue(`
    let main = match xs with
      | Cons (Cons h t) rest -> h
      | Nil -> 0
  `);
  assert.equal(e.tag, "match");
  if (e.tag !== "match") return;
  const pat = e.arms[0]!.pattern;
  assert.equal(pat.tag, "pctor");
  if (pat.tag !== "pctor") return;
  assert.equal(pat.args.length, 2);
  assert.equal(pat.args[0]!.tag, "pctor");
  if (pat.args[0]!.tag !== "pctor") return;
  assert.equal(pat.args[0]!.args.length, 2);
});

test("parses let rec, if, annotations, and string concatenation", () => {
  const text = formatProgram(
    parse(`
      let rec factorial : Int -> Int = fun n ->
        if n <= 1 then 1 else n * factorial (n - 1)
      let main = "a" ++ "b"
    `),
  );
  assert.match(text, /let rec factorial : Int -> Int = \(fun n -> \(if/);
  assert.match(text, /\(\+\+ "a" "b"\)/);
});

test("consecutive top-level declarations are not parsed as applications", () => {
  const prog = parse(`
    let x = 1
    let y = x + 2
  `);
  assert.equal(prog.decls.length, 2);
  assert.equal(prog.decls[0]!.tag, "let");
  assert.equal(prog.decls[1]!.tag, "let");
});

test("function types are right-associative", () => {
  const prog = parse("let id : a -> b -> c = fun x -> x");
  const decl = prog.decls[0]!;
  assert.equal(decl.tag, "let");
  if (decl.tag !== "let") return;
  assert.ok(decl.ann);
  assert.equal(decl.ann!.tag, "tfun");
  if (decl.ann!.tag !== "tfun") return;
  assert.equal(decl.ann!.ret.tag, "tfun");
});

test("parse error points at the offending token", () => {
  const src = "let x =\n  + 1\n";
  try {
    parse(src, "bad.fun");
    assert.fail("expected a parse error");
  } catch (err) {
    assert.ok(err instanceof CompileError);
    assert.equal(err.phase, "parse");
    assert.equal(err.span?.start.line, 2);
    assert.equal(err.span?.start.col, 3);
    const text = formatError(err, src);
    assert.match(text, /bad\.fun:2:3: parse error: expected an expression, found '\+'/);
  }
});

test("let rec of a non-function is rejected at parse time", () => {
  try {
    parse("let rec x = 1");
    assert.fail("expected a parse error");
  } catch (err) {
    assert.ok(err instanceof CompileError);
    assert.match(err.message, /let rec must bind a function/);
  }
});

test("negative integer patterns", () => {
  const e = letValue("let main = match n with | -1 -> 0 | _ -> n");
  assert.equal(e.tag, "match");
  if (e.tag !== "match") return;
  assert.equal(e.arms[0]!.pattern.tag, "pint");
  if (e.arms[0]!.pattern.tag !== "pint") return;
  assert.equal(e.arms[0]!.pattern.value, -1);
  assert.equal(e.arms[1]!.pattern.tag, "pwild");
});
