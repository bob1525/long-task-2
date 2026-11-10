/**
 * Command-line driver.
 *
 *   npx tsx src/cli.ts run     <file> [flags]
 *   npx tsx src/cli.ts compile <file> -o <out.js> [flags]
 *   npx tsx src/cli.ts ir      <file> [flags]
 *   npx tsx src/cli.ts check   <file>
 *
 * Optimization flags (all on by default):
 *   --const-fold / --no-const-fold
 *   --dce        / --no-dce
 *   --inline     / --no-inline
 *   --tco        / --no-tco
 *   --opt all | none | const-fold,dce,inline,tco
 *
 * Unknown options, extra file arguments, and `-o` on a command other than
 * `compile` are errors. A missing file is reported as a compiler error
 * instead of a raw runtime exception.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { compileSource, executeJs, flagsFromArgs } from "./compile.js";
import { CompileError, formatError } from "./errors.js";
import { ppAnf } from "./ir.js";

interface ParsedArgs {
  command: string;
  file: string | undefined;
  extra: string[];
  out: string | undefined;
  optArgs: string[];
}

function usage(): string {
  return `Fun compiler

Usage:
  funcc run <file.fun> [options]
  funcc compile <file.fun> -o <out.js> [options]
  funcc ir <file.fun> [options]
  funcc check <file.fun>

Options:
  --const-fold, --no-const-fold     constant folding (default on)
  --dce, --no-dce                   dead code elimination (default on)
  --inline, --no-inline             inlining of once-used functions (default on)
  --tco, --no-tco                   self tail-call optimization (default on)
  --opt all|none|const-fold,dce,inline,tco
                                    replace the enabled set; later flags override
  -o, --out <file>                  JavaScript output for compile
`;
}

function parseCli(argv: string[]): ParsedArgs {
  const command = argv[0] ?? "";
  const optArgs: string[] = [];
  const positional: string[] = [];
  let out: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-o" || arg === "--out") {
      out = argv[++i];
      if (!out) throw new CompileError("-o requires a file path", undefined, "<cli>", "compile");
    } else if (arg === "--opt") {
      const value = argv[++i];
      if (!value) throw new CompileError("--opt requires a value", undefined, "<cli>", "compile");
      optArgs.push("--opt", value);
    } else if (arg.startsWith("--opt=")) {
      optArgs.push(arg);
    } else if (arg.startsWith("-")) {
      optArgs.push(arg);
    } else {
      positional.push(arg);
    }
  }
  return { command, file: positional[0], extra: positional.slice(1), out, optArgs };
}

function main(argv: string[]): void {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(usage());
    return;
  }
  const parsed = parseCli(argv);
  if (!parsed.file) {
    throw new CompileError("missing input file", undefined, "<cli>", "compile");
  }
  if (parsed.extra.length > 0) {
    throw new CompileError(`unexpected extra argument '${parsed.extra[0]}'`, undefined, "<cli>", "compile");
  }
  if (!["run", "compile", "ir", "check"].includes(parsed.command)) {
    throw new CompileError(`unknown command '${parsed.command}'`, undefined, "<cli>", "compile");
  }
  if (parsed.out && parsed.command !== "compile") {
    throw new CompileError("-o is only valid with compile", undefined, "<cli>", "compile");
  }
  const source = readSource(parsed.file);
  const flags = flagsFromArgs(parsed.optArgs);
  if (parsed.command === "check") {
    const checked = compileSource(source, parsed.file, flags).checked;
    reportWarnings(checked.warnings);
    for (const binding of checked.bindings.filter((b) => b.topLevel)) {
      process.stdout.write(`${binding.name} : ${binding.type}\n`);
    }
    process.stdout.write(`result ${checked.resultName} : ${checked.result}\n`);
    return;
  }
  const compiled = compileSource(source, parsed.file, flags);
  reportWarnings(compiled.checked.warnings);
  if (parsed.command === "ir") {
    process.stdout.write(`${ppAnf(compiled.ir)}\n`);
    return;
  }
  if (parsed.command === "compile") {
    if (!parsed.out) throw new CompileError("compile requires -o <file>", undefined, "<cli>", "compile");
    writeFileSync(parsed.out, compiled.js);
    return;
  }
  const result = executeJs(compiled.js);
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.timedOut) process.exitCode = 124;
  else if (result.status !== 0) process.exitCode = result.status ?? 1;
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof CompileError) {
    const source = err.filename !== "<cli>" && err.filename !== "<input>" ? safeRead(err.filename) : undefined;
    process.stderr.write(`${formatError(err, source)}\n`);
    process.exitCode = 1;
  } else {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

function reportWarnings(warnings: string[]): void {
  for (const warning of warnings) process.stderr.write(`${warning}\n`);
}

function readSource(filename: string): string {
  try {
    return readFileSync(filename, "utf8");
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "error";
    throw new CompileError(`cannot read '${filename}' (${code})`, undefined, "<cli>", "compile");
  }
}

function safeRead(filename: string): string | undefined {
  try {
    return readFileSync(filename, "utf8");
  } catch {
    return undefined;
  }
}
