/**
 * Runtime failures must be one `runtime error:` line. A non-exhaustive match
 * names the source match. The Node stack and the temporary prog.js path stay
 * off the user's screen, and the process exits non-zero.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

const GET = `type Opt a = None | Some a
let get o = match o with | Some x -> x
let main = get None
`;

function funcc(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [tsx, path.join(root, "src", "cli.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function withFile(name: string, source: string, run: (file: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "funcc-src-"));
  const file = path.join(dir, name);
  writeFileSync(file, source);
  try {
    run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertCleanRuntime(stderr: string): void {
  assert.doesNotMatch(stderr, /prog\.js/);
  assert.doesNotMatch(stderr, /RangeError/);
  assert.doesNotMatch(stderr, /Maximum call stack/);
  assert.doesNotMatch(stderr, /^\s+at /m);
  assert.doesNotMatch(stderr, /node:internal/);
}

test("division by zero is a positioned runtime error", () => {
  withFile("div.fun", "let main = 10 / 0\n", (file) => {
    const result = funcc(["run", file]);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.trim(), "");
    assert.equal(result.stderr.trim(), `runtime error: division by zero at ${file}:1:12`);
    assertCleanRuntime(result.stderr);
  });
});

test("a non-exhaustive match names the match and exits non-zero", () => {
  withFile("get.fun", GET, (file) => {
    const result = funcc(["run", file]);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.trim(), "");
    assert.match(result.stderr, /warning: non-exhaustive pattern match; missing None/);
    assert.match(result.stderr, new RegExp(`runtime error: non-exhaustive pattern match at ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:2:13`));
    assertCleanRuntime(result.stderr);
  });
});

test("check warns about a missing constructor and still accepts the program", () => {
  withFile("get.fun", GET, (file) => {
    const result = funcc(["check", file]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`${path.basename(file)}:2:13: warning: non-exhaustive pattern match; missing None`));
    assert.match(result.stdout, /get : ∀a\. Opt a -> a/);
    assert.match(result.stdout, /main : ∀a\. a/);
  });
});

test("compiled JavaScript reports the same runtime error", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "funcc-out-"));
  const src = path.join(dir, "div.fun");
  const out = path.join(dir, "div.js");
  writeFileSync(src, "let main = 10 / 0\n");
  try {
    const compiled = funcc(["compile", src, "-o", out]);
    assert.equal(compiled.status, 0, compiled.stderr);
    const ran = spawnSync(process.execPath, [out], { encoding: "utf8" });
    assert.notEqual(ran.status, 0);
    assert.equal((ran.stderr ?? "").trim(), `runtime error: division by zero at ${src}:1:12`);
    assert.equal((ran.stdout ?? "").trim(), "");
    assertCleanRuntime(ran.stderr ?? "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
