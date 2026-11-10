/**
 * JavaScript backend.
 *
 * Values:
 * - Int, Bool, and String are JS numbers, booleans, and strings.
 * - Constructors are `{ $tag, $fields }`. Partial application was eta-expanded
 *   in ANF, so codegen only emits fully applied constructor objects.
 * - Lambdas are arrow functions. `let rec` is a named function expression so
 *   the recursive binding is in scope inside the body and is still legal in a
 *   block (a `function` declaration would be hoisted differently).
 *
 * `if` and `match` are immediately-invoked functions when their result is
 * used. Inside a tail-call loop, a tail `if` or `match` is a statement, so
 * `return` and `continue` belong to that loop. Match tests are ordered outer
 * constructor first and combined with `&&`, so a nested field is only read
 * after the outer tag check succeeds.
 *
 * Division by zero and a failed match throw `FUN_RUNTIME:...`. The wrapper
 * prints `runtime error: ...` and exits 1. A `RangeError` becomes
 * `runtime error: stack overflow`. The Node stack is not printed.
 *
 * The generated script prints `$show` of the program result. Strings are
 * shown with quotes; nullary constructors are bare tags; other constructors
 * are `Tag(arg, ...)`.
 */

import type { Pattern, PrimOp } from "./ast.js";
import type { Span } from "./errors.js";
import type { AnfExpr, Atom, CExp } from "./ir.js";

let currentFile = "<input>";

export function codegen(expr: AnfExpr, filename = "<input>"): string {
  currentFile = filename;
  const body = emitExpr(expr).map((line) => `  ${line}`);
  return `${RUNTIME}\nfunction $prog() {\n${body.join("\n")}\n}\ntry {\n  console.log($show($prog()));\n} catch ($e) {\n  const $msg = $e && typeof $e.message === "string" ? $e.message : String($e);\n  const $text = $msg.startsWith("FUN_RUNTIME:") ? $msg.slice("FUN_RUNTIME:".length) : ($e && $e.name === "RangeError" ? "stack overflow" : $msg.split("\\n")[0]);\n  console.error("runtime error: " + $text);\n  process.exit(1);\n}\n`;
}

function sourceAt(span: Span | undefined): string {
  if (!span) return currentFile;
  return `${currentFile}:${span.start.line}:${span.start.col}`;
}

function emitExpr(e: AnfExpr): string[] {
  switch (e.tag) {
    case "halt":
      return [`return ${emitAtom(e.atom)};`];
    case "let":
      return [...emitConst(e.name, e.value), ...emitExpr(e.body)];
    case "letrec": {
      const name = jsIdent(e.name);
      const param = jsIdent(e.param);
      const inner = emitExpr(e.body).map((line) => `  ${line}`);
      return [`const ${name} = function ${name}(${param}) {`, ...inner, `};`, ...emitExpr(e.cont)];
    }
    case "loop":
      return [...emitLoop(e), ...emitExpr(e.cont)];
    case "jump":
      return [`throw new Error("FUN_RUNTIME:internal jump outside a loop");`];
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

function emitConst(name: string, value: CExp): string[] {
  const rhs = emitCExp(value);
  const lines = rhs.split("\n");
  if (lines.length === 1) return [`const ${jsIdent(name)} = ${lines[0]};`];
  const head = `const ${jsIdent(name)} = ${lines[0]}`;
  const mid = lines.slice(1, -1);
  const last = `${lines[lines.length - 1]};`;
  return [head, ...mid, last];
}

function emitCExp(c: CExp): string {
  switch (c.tag) {
    case "atom":
      return emitAtom(c.atom);
    case "prim":
      return emitPrim(c.op, c.args, c.op === "/" ? sourceAt(c.span) : "");
    case "app":
      return `${emitAtom(c.fn)}(${emitAtom(c.arg)})`;
    case "ctor":
      return `({ $tag: ${JSON.stringify(c.name)}, $fields: [${c.args.map(emitAtom).join(", ")}] })`;
    case "fun": {
      const inner = emitExpr(c.body).map((line) => `  ${line}`);
      return `(${jsIdent(c.param)}) => {\n${inner.join("\n")}\n}`;
    }
    case "if": {
      const thenLines = emitExpr(c.then).map((line) => `    ${line}`);
      const elseLines = emitExpr(c.else).map((line) => `    ${line}`);
      return `(() => {\n  if (${emitAtom(c.cond)}) {\n${thenLines.join("\n")}\n  } else {\n${elseLines.join("\n")}\n  }\n})()`;
    }
    case "match":
      return emitMatch(c.scrut, c.arms, c.span);
    default: {
      const _never: never = c;
      return _never;
    }
  }
}

function emitMatch(scrut: Atom, arms: { pattern: Pattern; body: AnfExpr }[], span: Span | undefined): string {
  const chunks: string[] = ["(() => {", `  const $s = ${emitAtom(scrut)};`];
  for (const arm of arms) {
    const compiled = compilePattern(arm.pattern, "$s");
    const cond = compiled.conds.length > 0 ? compiled.conds.join(" && ") : "true";
    chunks.push(`  if (${cond}) {`);
    for (const bind of compiled.binds) chunks.push(`    ${bind}`);
    for (const line of emitExpr(arm.body)) chunks.push(`    ${line}`);
    chunks.push("  }");
  }
  chunks.push(`  throw new Error(${JSON.stringify(`FUN_RUNTIME:non-exhaustive pattern match at ${sourceAt(span)}`)});`);
  chunks.push("})()");
  return chunks.join("\n");
}

function compilePattern(pat: Pattern, val: string): { conds: string[]; binds: string[] } {
  switch (pat.tag) {
    case "pwild":
      return { conds: [], binds: [] };
    case "pvar":
      return { conds: [], binds: [`const ${jsIdent(pat.name)} = ${val};`] };
    case "pint":
      return { conds: [`(${val} === ${pat.value})`], binds: [] };
    case "pbool":
      return { conds: [`(${val} === ${pat.value ? "true" : "false"})`], binds: [] };
    case "pstring":
      return { conds: [`(${val} === ${JSON.stringify(pat.value)})`], binds: [] };
    case "pctor": {
      const conds = [`$is(${val}, ${JSON.stringify(pat.name)}, ${pat.args.length})`];
      const binds: string[] = [];
      pat.args.forEach((arg, i) => {
        const field = `${val}.$fields[${i}]`;
        const sub = compilePattern(arg, field);
        conds.push(...sub.conds);
        binds.push(...sub.binds);
      });
      return { conds, binds };
    }
    default: {
      const _never: never = pat;
      return _never;
    }
  }
}

function emitPrim(op: PrimOp, args: Atom[], at: string): string {
  const a = args.map(emitAtom);
  switch (op) {
    case "+":
      return `(${a[0]} + ${a[1]})`;
    case "-":
      return `(${a[0]} - ${a[1]})`;
    case "*":
      return `(${a[0]} * ${a[1]})`;
    case "/":
      return `$div(${a[0]}, ${a[1]}, ${JSON.stringify(at)})`;
    case "neg":
      return `(-(${a[0]}))`;
    case "==":
      return `$eq(${a[0]}, ${a[1]})`;
    case "!=":
      return `(!$eq(${a[0]}, ${a[1]}))`;
    case "<":
      return `(${a[0]} < ${a[1]})`;
    case "<=":
      return `(${a[0]} <= ${a[1]})`;
    case ">":
      return `(${a[0]} > ${a[1]})`;
    case ">=":
      return `(${a[0]} >= ${a[1]})`;
    case "++":
      return `(${a[0]} + ${a[1]})`;
    default: {
      const _never: never = op;
      return _never;
    }
  }
}

function emitAtom(a: Atom): string {
  switch (a.tag) {
    case "var":
      return jsIdent(a.name);
    case "int":
      return String(a.value);
    case "bool":
      return a.value ? "true" : "false";
    case "string":
      return JSON.stringify(a.value);
    default: {
      const _never: never = a;
      return _never;
    }
  }
}

function jsIdent(name: string): string {
  return `v_${name.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/**
 * A loop's parameters are copied into locals on every entry. Jumps assign
 * those locals and `continue`, so calling the same closure twice does not
 * observe the previous iteration's arguments.
 */
function emitLoop(e: Extract<AnfExpr, { tag: "loop" }>): string[] {
  const formals = e.params.map((_, i) => `$a${i}`);
  const inits = e.params.map((param, i) => `let ${jsIdent(param)} = ${formals[i]};`);
  const body = emitStmt(e.body, e.params).map((line) => `  ${line}`);
  let inner = [...inits, "while (true) {", ...body, "}"].join("\n");
  for (let i = e.params.length - 1; i >= 1; i--) {
    inner = `return function (${formals[i]}) {\n${indentLines(inner)}\n}`;
  }
  const src = `const ${jsIdent(e.name)} = function ${jsIdent(e.name)}(${formals[0]}) {\n${indentLines(inner)}\n};`;
  return src.split("\n");
}

function indentLines(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? line : `  ${line}`))
    .join("\n");
}

function emitStmt(e: AnfExpr, params: string[]): string[] {
  switch (e.tag) {
    case "halt":
      return [`return ${emitAtom(e.atom)};`];
    case "jump": {
      const temps = e.args.map((arg, i) => `const $j${i} = ${emitAtom(arg)};`);
      const sets = params.map((param, i) => `${jsIdent(param)} = $j${i};`);
      return [...temps, ...sets, "continue;"];
    }
    case "let":
      if (
        e.body.tag === "halt" &&
        e.body.atom.tag === "var" &&
        e.body.atom.name === e.name &&
        (e.value.tag === "if" || e.value.tag === "match")
      ) {
        return e.value.tag === "if" ? emitTailIf(e.value, params) : emitTailMatch(e.value, params);
      }
      return [...emitConst(e.name, e.value), ...emitStmt(e.body, params)];
    case "letrec": {
      const name = jsIdent(e.name);
      const param = jsIdent(e.param);
      const inner = emitExpr(e.body).map((line) => `  ${line}`);
      return [`const ${name} = function ${name}(${param}) {`, ...inner, `};`, ...emitStmt(e.cont, params)];
    }
    case "loop":
      return [...emitLoop(e), ...emitStmt(e.cont, params)];
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

function emitTailIf(c: Extract<CExp, { tag: "if" }>, params: string[]): string[] {
  const thenLines = emitStmt(c.then, params).map((line) => `  ${line}`);
  const elseLines = emitStmt(c.else, params).map((line) => `  ${line}`);
  return [`if (${emitAtom(c.cond)}) {`, ...thenLines, "} else {", ...elseLines, "}"];
}

function emitTailMatch(c: Extract<CExp, { tag: "match" }>, params: string[]): string[] {
  const lines = [`const $s = ${emitAtom(c.scrut)};`];
  for (const arm of c.arms) {
    const compiled = compilePattern(arm.pattern, "$s");
    const cond = compiled.conds.length > 0 ? compiled.conds.join(" && ") : "true";
    lines.push(`if (${cond}) {`);
    for (const bind of compiled.binds) lines.push(`  ${bind}`);
    for (const line of emitStmt(arm.body, params)) lines.push(`  ${line}`);
    lines.push("}");
  }
  lines.push(`throw new Error(${JSON.stringify(`FUN_RUNTIME:non-exhaustive pattern match at ${sourceAt(c.span)}`)});`);
  return lines;
}

const RUNTIME = `"use strict";
function $is(v, tag, n) {
  return v !== null && typeof v === "object" && v.$tag === tag && Array.isArray(v.$fields) && v.$fields.length === n;
}
function $eq(a, b) {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return a === b;
  if (a.$tag && b.$tag) {
    if (a.$tag !== b.$tag || a.$fields.length !== b.$fields.length) return false;
    for (let i = 0; i < a.$fields.length; i++) if (!$eq(a.$fields[i], b.$fields[i])) return false;
    return true;
  }
  return a === b;
}
function $div(a, b, at) {
  if (b === 0) throw new Error("FUN_RUNTIME:division by zero" + (at ? " at " + at : ""));
  return Math.trunc(a / b);
}
function $show(v) {
  if (typeof v === "number") return Object.is(v, -0) ? "0" : String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "function") return "<fun>";
  if (v && typeof v === "object" && typeof v.$tag === "string" && Array.isArray(v.$fields)) {
    if (v.$fields.length === 0) return v.$tag;
    return v.$tag + "(" + v.$fields.map($show).join(", ") + ")";
  }
  return String(v);
}`;
