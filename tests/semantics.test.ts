import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compileSource, executeJs, runSource, type OptFlags } from "../src/compile.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

const sets: Array<[string, OptFlags]> = [
  ["all", { constFold: true, dce: true, inline: true }],
  ["none", { constFold: false, dce: false, inline: false }],
  ["const-fold", { constFold: true, dce: false, inline: false }],
  ["dce", { constFold: false, dce: true, inline: false }],
  ["inline", { constFold: false, dce: false, inline: true }],
  ["const-fold+dce", { constFold: true, dce: true, inline: false }],
  ["inline+const-fold", { constFold: true, dce: false, inline: true }],
  ["inline+dce", { constFold: false, dce: true, inline: true }],
];

function agree(src: string, expected: string): void {
  for (const [name, flags] of sets) {
    assert.equal(runSource(src, "t.fun", flags), expected, name);
  }
}

test("optimizations preserve arithmetic, functions, strings, and data", () => {
  agree("let main = 1 + 2 * 3", "7");
  agree("let inc x = x + 1\nlet main = inc 10", "11");
  agree("let unused = 1 + 2\nlet main = 3", "3");
  agree('let main = "a\\nb" ++ "c"', '"a\\nbc"');
  agree("let main = -5 / 2", "-2");
  agree("let main = -5 / -2", "2");
  agree("let main = 8 - 3 - 1", "4");
  agree("let main = 1 < 2", "true");
  agree("let main = true == false && true", "false");
  agree(
    "type List a = Nil | Cons a (List a)\nlet main = let c = Cons 1 in c Nil",
    "Cons(1, Nil)",
  );
  agree(
    "type List a = Nil | Cons a (List a)\nlet main = Cons 1 Nil == Cons 1 Nil",
    "true",
  );
});

test("a constant if and short-circuit operators drop the untaken branch", () => {
  const loop = "let rec loop x = loop x\n";
  agree(`${loop}let main = if false then loop 1 else 4`, "4");
  agree(`${loop}let main = true || loop 1`, "true");
  agree(`${loop}let main = false && loop 1`, "false");
});

test("an unused diverging call is still executed with every flag combination", () => {
  const src = "let rec loop x = loop x\nlet unused = loop 1\nlet main = 2";
  for (const [name, flags] of sets) {
    const result = executeJs(compileSource(src, "t.fun", flags).js, 2000);
    assert.equal(result.timedOut, false, name);
    assert.notEqual(result.status, 0, name);
    assert.notEqual(result.stdout.trim(), "2", name);
    assert.match(result.stderr, /Maximum call stack size exceeded/, name);
  }
});

test("division by zero fails with and without constant folding", () => {
  const src = "let main = 1 / 0";
  for (const flags of [
    { constFold: true, dce: true, inline: true },
    { constFold: false, dce: false, inline: false },
    { constFold: true, dce: false, inline: false },
  ] as const) {
    const result = executeJs(compileSource(src, "t.fun", flags).js);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /division by zero/);
  }
});

test("a non-exhaustive match fails at run time", () => {
  const src = "type T = A | B\nlet main = match A with | B -> 1";
  const result = executeJs(compileSource(src, "t.fun", { constFold: false, dce: false, inline: false }).js);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-exhaustive pattern match/);
});

test("shadowing and closure capture agree with and without optimization", () => {
  agree("let main = let x = 1 in let x = x + 2 in x", "3");
  agree("let main = let n = 1 in let f = fun x -> n + x in let n = 10 in f 1", "2");
  agree("let main = let x = 1 in let f = fun y -> x + y in f 2", "3");
});

function funcc(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [tsx, path.join(root, "src", "cli.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("CLI optimization flags change the printed IR", () => {
  const file = path.join(root, "examples", "compose.fun");
  const folded = funcc(["ir", file]);
  assert.equal(folded.status, 0);
  assert.equal(folded.stdout.trim(), "21");

  const raw = funcc(["ir", file, "--opt", "none"]);
  assert.equal(raw.status, 0);
  assert.match(raw.stdout, /fun /);
  assert.notEqual(raw.stdout.trim(), folded.stdout.trim());

  const foldOnly = funcc(["ir", path.join(root, "examples", "factorial.fun"), "--opt", "none", "--const-fold"]);
  assert.equal(foldOnly.status, 0);
  assert.match(foldOnly.stdout, /factorial/);
  assert.match(foldOnly.stdout, /<=/);
});

test("CLI run honors --opt none and the default pipeline", () => {
  const file = path.join(root, "examples", "factorial.fun");
  const on = funcc(["run", file]);
  const off = funcc(["run", file, "--opt", "none"]);
  assert.equal(on.status, 0);
  assert.equal(off.status, 0);
  assert.equal(on.stdout.trim(), "120");
  assert.equal(off.stdout.trim(), "120");
});

test("unknown options and extra file arguments are rejected", () => {
  const file = path.join(root, "examples", "factorial.fun");
  const bogus = funcc(["run", file, "--bogus"]);
  assert.notEqual(bogus.status, 0);
  assert.match(bogus.stderr, /unknown option '--bogus'/);
  assert.equal(bogus.stdout.trim(), "");

  const typo = funcc(["ir", file, "--no-const-foldd"]);
  assert.notEqual(typo.status, 0);
  assert.match(typo.stderr, /unknown option '--no-const-foldd'/);

  const extra = funcc(["run", file, path.join(root, "examples", "compose.fun")]);
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /unexpected extra argument/);
  assert.equal(extra.stdout.trim(), "");

  const outFlag = funcc(["run", file, "-o", path.join(root, "examples", "ignored.js")]);
  assert.notEqual(outFlag.status, 0);
  assert.match(outFlag.stderr, /-o is only valid with compile/);
  assert.equal(outFlag.stdout.trim(), "");
});

test("a missing input file is reported as a compiler error", () => {
  const missing = path.join(root, "examples", "does-not-exist.fun");
  const result = funcc(["run", missing]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot read/);
  assert.match(result.stderr, /does-not-exist\.fun/);
});

test("compile -o writes JavaScript that node can run", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "funcc-out-"));
  const out = path.join(dir, "pattern_match.js");
  try {
    const compiled = funcc(["compile", path.join(root, "examples", "pattern_match.fun"), "-o", out]);
    assert.equal(compiled.status, 0, compiled.stderr);
    const ran = spawnSync(process.execPath, [out], { encoding: "utf8" });
    assert.equal(ran.status, 0);
    assert.equal((ran.stdout ?? "").trim(), "12");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
