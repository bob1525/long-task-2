/**
 * Pipeline and process execution.
 *
 * parse → Hindley-Milner → ANF → the selected optimization passes → JS.
 * `runSource` executes that JS in a separate Node process so a diverging
 * program can be timed out without taking down the compiler.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { toAnf } from "./anf.js";
import { codegen } from "./codegen.js";
import { CompileError } from "./errors.js";
import { ppAnf, type AnfExpr } from "./ir.js";
import { ALL_OPTS, optimize, type OptFlags } from "./optimize.js";
import { inferProgram, type CheckedProgram } from "./typecheck.js";

export type { OptFlags } from "./optimize.js";
export { ALL_OPTS, NO_OPTS } from "./optimize.js";

export interface Compiled {
  checked: CheckedProgram;
  /** ANF before optimization. */
  anf: AnfExpr;
  /** ANF after the selected passes. */
  ir: AnfExpr;
  js: string;
}

export function compileSource(source: string, filename = "<input>", flags: OptFlags = ALL_OPTS): Compiled {
  const checked = inferProgram(source, filename);
  const anf = toAnf(checked.expr, checked.ctors);
  const ir = optimize(anf, flags);
  const js = codegen(ir);
  return { checked, anf, ir, js };
}

export function irText(source: string, filename = "<input>", flags: OptFlags = ALL_OPTS): string {
  return ppAnf(compileSource(source, filename, flags).ir);
}

export interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  timedOut: boolean;
}

export function executeJs(js: string, timeoutMs = 3000): RunResult {
  const dir = mkdtempSync(path.join(tmpdir(), "funcc-"));
  const file = path.join(dir, "prog.js");
  writeFileSync(file, js);
  try {
    const result = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: timeoutMs });
    const timedOut = !!result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return {
      stdout: result.stdout ?? "",
      stderr: `${result.stderr ?? ""}${result.error && !timedOut ? result.error.message : ""}`,
      status: result.status,
      timedOut,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Compile and run. Returns the program's stdout without the trailing newline. */
export function runSource(source: string, filename = "<input>", flags: OptFlags = ALL_OPTS, timeoutMs = 3000): string {
  const js = compileSource(source, filename, flags).js;
  const result = executeJs(js, timeoutMs);
  if (result.timedOut) {
    throw new CompileError("program timed out", undefined, filename, "compile");
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new CompileError(detail || `program exited with status ${result.status}`, undefined, filename, "compile");
  }
  return result.stdout.replace(/\n$/, "");
}

const OPT_NAMES = new Set(["const-fold", "dce", "inline", "all", "none"]);

/**
 * Interpret optimization flags.
 *
 * Defaults are all on. `--opt` replaces the enabled set (`all`, `none`, or a
 * comma-separated list). Later individual flags override that set, so
 * `--opt none --const-fold` enables only constant folding.
 */
export function flagsFromArgs(args: string[]): OptFlags {
  const opts: OptFlags = { constFold: true, dce: true, inline: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--const-fold") opts.constFold = true;
    else if (arg === "--no-const-fold") opts.constFold = false;
    else if (arg === "--dce") opts.dce = true;
    else if (arg === "--no-dce") opts.dce = false;
    else if (arg === "--inline") opts.inline = true;
    else if (arg === "--no-inline") opts.inline = false;
    else if (arg === "--opt" || arg.startsWith("--opt=")) {
      const value = arg === "--opt" ? args[++i] : arg.slice("--opt=".length);
      if (!value) {
        throw new CompileError("--opt requires a value (all, none, or a comma-separated list)", undefined, "<cli>", "compile");
      }
      applyOptList(opts, value);
    }
  }
  return opts;
}

function applyOptList(opts: OptFlags, value: string): void {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new CompileError("--opt requires a value (all, none, or a comma-separated list)", undefined, "<cli>", "compile");
  }
  for (const part of parts) {
    if (!OPT_NAMES.has(part)) {
      throw new CompileError(
        `unknown optimization '${part}' (expected const-fold, dce, inline, all, or none)`,
        undefined,
        "<cli>",
        "compile",
      );
    }
  }
  if (parts.length === 1 && parts[0] === "all") {
    opts.constFold = true;
    opts.dce = true;
    opts.inline = true;
    return;
  }
  if (parts.length === 1 && parts[0] === "none") {
    opts.constFold = false;
    opts.dce = false;
    opts.inline = false;
    return;
  }
  if (parts.includes("all") || parts.includes("none")) {
    throw new CompileError("use 'all' or 'none' alone, or list const-fold, dce, and inline", undefined, "<cli>", "compile");
  }
  opts.constFold = false;
  opts.dce = false;
  opts.inline = false;
  for (const part of parts) {
    if (part === "const-fold") opts.constFold = true;
    if (part === "dce") opts.dce = true;
    if (part === "inline") opts.inline = true;
  }
}
