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
 * `if` and `match` are immediately-invoked functions. That keeps them in
 * expression position (`const r = (() => { ... })()`) without duplicating the
 * code that consumes the result. Match tests are ordered outer constructor
 * first and combined with `&&`, so a nested field is only read after the
 * outer tag check succeeds.
 *
 * The generated script prints `$show` of the program result. Strings are
 * shown with quotes; nullary constructors are bare tags; other constructors
 * are `Tag(arg, ...)`.
 */

import type { Pattern, PrimOp } from "./ast.js";
import type { AnfExpr, Atom, CExp } from "./ir.js";

export function codegen(expr: AnfExpr): string {
  const body = emitExpr(expr).map((line) => `  ${line}`);
  return `${RUNTIME}\nfunction $prog() {\n${body.join("\n")}\n}\nconsole.log($show($prog()));\n`;
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
      return emitPrim(c.op, c.args);
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
      return emitMatch(c.scrut, c.arms);
    default: {
      const _never: never = c;
      return _never;
    }
  }
}

function emitMatch(scrut: Atom, arms: { pattern: Pattern; body: AnfExpr }[]): string {
  const chunks: string[] = ["(() => {", `  const $s = ${emitAtom(scrut)};`];
  for (const arm of arms) {
    const compiled = compilePattern(arm.pattern, "$s");
    const cond = compiled.conds.length > 0 ? compiled.conds.join(" && ") : "true";
    chunks.push(`  if (${cond}) {`);
    for (const bind of compiled.binds) chunks.push(`    ${bind}`);
    for (const line of emitExpr(arm.body)) chunks.push(`    ${line}`);
    chunks.push("  }");
  }
  chunks.push('  throw new Error("non-exhaustive pattern match");');
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

function emitPrim(op: PrimOp, args: Atom[]): string {
  const a = args.map(emitAtom);
  switch (op) {
    case "+":
      return `(${a[0]} + ${a[1]})`;
    case "-":
      return `(${a[0]} - ${a[1]})`;
    case "*":
      return `(${a[0]} * ${a[1]})`;
    case "/":
      return `$div(${a[0]}, ${a[1]})`;
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
function $div(a, b) {
  if (b === 0) throw new Error("division by zero");
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
