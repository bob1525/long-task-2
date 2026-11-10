import assert from "node:assert/strict";
import { test } from "node:test";
import { CompileError, formatError } from "../src/errors.js";
import { lex } from "../src/lexer.js";

function kinds(src: string): string[] {
  return lex(src)
    .filter((t) => t.kind !== "eof")
    .map((t) => t.kind);
}

test("lexes keywords, identifiers, constructors, and operators", () => {
  const tokens = lex("let rec f x = x + 1", "ex.fun");
  assert.deepEqual(
    tokens.map((t) => t.kind),
    ["let", "rec", "ident", "ident", "eq", "ident", "plus", "int", "eof"],
  );
  assert.equal(tokens[2]!.value, "f");
  assert.equal(tokens[5]!.value, "x");
  assert.equal(tokens[0]!.span.start.line, 1);
  assert.equal(tokens[0]!.span.start.col, 1);
  assert.equal(tokens[2]!.span.start.col, 9);
});

test("distinguishes constructors from variables and the wildcard", () => {
  const tokens = lex("Cons _x _ Nil");
  assert.deepEqual(
    tokens.filter((t) => t.kind !== "eof").map((t) => [t.kind, t.value]),
    [
      ["ctor", "Cons"],
      ["ident", "_x"],
      ["underscore", "_"],
      ["ctor", "Nil"],
    ],
  );
});

test("longest-match operators", () => {
  assert.deepEqual(kinds("-> == != <= >= && || ++"), [
    "arrow",
    "eqeq",
    "neq",
    "le",
    "ge",
    "andand",
    "oror",
    "plusplus",
  ]);
});

test("string escapes and raw content", () => {
  const tokens = lex(String.raw`"hi\n\"there\\"`);
  assert.equal(tokens[0]!.kind, "string");
  assert.equal(tokens[0]!.value, "hi\n\"there\\");
});

test("comments do not produce tokens and do not disturb positions", () => {
  const src = "// comment\nlet /* block\n still */ x";
  const tokens = lex(src).filter((t) => t.kind !== "eof");
  assert.deepEqual(
    tokens.map((t) => t.kind),
    ["let", "ident"],
  );
  assert.equal(tokens[0]!.span.start.line, 2);
  assert.equal(tokens[0]!.span.start.col, 1);
  assert.equal(tokens[1]!.span.start.line, 3);
  assert.equal(tokens[1]!.value, "x");
  assert.equal(tokens[1]!.span.start.col, 11);
});

test("rejects an unexpected character with a caret pointing at it", () => {
  const src = "let x = @";
  try {
    lex(src, "bad.fun");
    assert.fail("expected a lex error");
  } catch (err) {
    assert.ok(err instanceof CompileError);
    assert.equal(err.phase, "lex");
    assert.equal(err.span?.start.line, 1);
    assert.equal(err.span?.start.col, 9);
    const text = formatError(err, src);
    assert.match(text, /bad\.fun:1:9: lex error: unexpected character '@'/);
    assert.match(text, /\nlet x = @\n {8}\^/);
  }
});

test("rejects an unterminated string on its opening line", () => {
  const src = "let s = \"abc\nlet x = 1";
  try {
    lex(src, "bad.fun");
    assert.fail("expected a lex error");
  } catch (err) {
    assert.ok(err instanceof CompileError);
    assert.match(err.message, /unterminated string/);
    assert.equal(err.span?.start.line, 1);
    assert.equal(err.span?.start.col, 9);
  }
});

test("rejects integers that do not fit in a safe integer", () => {
  try {
    lex("9007199254740993");
    assert.fail("expected a lex error");
  } catch (err) {
    assert.ok(err instanceof CompileError);
    assert.match(err.message, /out of range/);
  }
});

test("true and false are keywords, not identifiers", () => {
  assert.deepEqual(kinds("true false"), ["true", "false"]);
});
