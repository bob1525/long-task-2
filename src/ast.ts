/**
 * Surface AST for Fun.
 *
 * After parsing, every function has exactly one parameter: `fun x y -> e`
 * and `let f x y = e` are nested single-argument functions. That keeps
 * Hindley-Milner (curried function types), ANF, and JavaScript codegen on
 * one representation.
 *
 * `&&` / `||` are parsed directly into `if`, so short-circuit behavior is
 * ordinary control flow rather than a strict primitive.
 *
 * Data constructors are a separate syntactic class from variables
 * (uppercase vs lowercase). A bare constructor is a value of its curried
 * function type; application nodes supply arguments.
 */

import type { Span } from "./errors.js";

export type TypeExpr =
  | { tag: "tvar"; name: string; span: Span }
  | { tag: "tcon"; name: string; args: TypeExpr[]; span: Span }
  | { tag: "tfun"; arg: TypeExpr; ret: TypeExpr; span: Span };

export type Pattern =
  | { tag: "pwild"; span: Span }
  | { tag: "pvar"; name: string; span: Span }
  | { tag: "pint"; value: number; span: Span }
  | { tag: "pbool"; value: boolean; span: Span }
  | { tag: "pstring"; value: string; span: Span }
  | { tag: "pctor"; name: string; args: Pattern[]; span: Span };

export type Expr =
  | { tag: "int"; value: number; span: Span }
  | { tag: "bool"; value: boolean; span: Span }
  | { tag: "string"; value: string; span: Span }
  | { tag: "var"; name: string; span: Span }
  | { tag: "ctor"; name: string; span: Span }
  | { tag: "app"; fn: Expr; arg: Expr; span: Span }
  | { tag: "prim"; op: PrimOp; args: Expr[]; span: Span }
  | { tag: "fun"; param: string; body: Expr; span: Span }
  | {
      tag: "let";
      rec: boolean;
      name: string;
      ann: TypeExpr | null;
      value: Expr;
      body: Expr;
      span: Span;
    }
  | { tag: "if"; cond: Expr; then: Expr; else: Expr; span: Span }
  | { tag: "match"; scrut: Expr; arms: MatchArm[]; span: Span };

export type PrimOp = "+" | "-" | "*" | "/" | "neg" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "++";

export interface MatchArm {
  pattern: Pattern;
  body: Expr;
  span: Span;
}

export interface Variant {
  name: string;
  argTypes: TypeExpr[];
  span: Span;
}

export type Decl =
  | { tag: "type"; name: string; params: string[]; variants: Variant[]; span: Span }
  | {
      tag: "let";
      rec: boolean;
      name: string;
      ann: TypeExpr | null;
      value: Expr;
      span: Span;
    };

export interface Program {
  decls: Decl[];
  span: Span;
}

export function formatTypeExpr(t: TypeExpr): string {
  switch (t.tag) {
    case "tvar":
      return t.name;
    case "tcon":
      if (t.args.length === 0) return t.name;
      return `${t.name} ${t.args.map(formatTypeAtom).join(" ")}`;
    case "tfun": {
      const left = t.arg.tag === "tfun" ? `(${formatTypeExpr(t.arg)})` : formatTypeExpr(t.arg);
      return `${left} -> ${formatTypeExpr(t.ret)}`;
    }
    default: {
      const _never: never = t;
      return _never;
    }
  }
}

function formatTypeAtom(t: TypeExpr): string {
  if (t.tag === "tcon" && t.args.length > 0) return `(${formatTypeExpr(t)})`;
  if (t.tag === "tfun") return `(${formatTypeExpr(t)})`;
  return formatTypeExpr(t);
}

export function formatPattern(p: Pattern): string {
  switch (p.tag) {
    case "pwild":
      return "_";
    case "pvar":
      return p.name;
    case "pint":
      return String(p.value);
    case "pbool":
      return String(p.value);
    case "pstring":
      return JSON.stringify(p.value);
    case "pctor":
      if (p.args.length === 0) return p.name;
      return `${p.name} ${p.args.map(formatPatternAtom).join(" ")}`;
    default: {
      const _never: never = p;
      return _never;
    }
  }
}

function formatPatternAtom(p: Pattern): string {
  if (p.tag === "pctor" && p.args.length > 0) return `(${formatPattern(p)})`;
  return formatPattern(p);
}

export function formatExpr(e: Expr): string {
  switch (e.tag) {
    case "int":
      return String(e.value);
    case "bool":
      return String(e.value);
    case "string":
      return JSON.stringify(e.value);
    case "var":
      return e.name;
    case "ctor":
      return e.name;
    case "app":
      return `(${formatExpr(e.fn)} ${formatExpr(e.arg)})`;
    case "prim":
      if (e.op === "neg") return `(- ${formatExpr(e.args[0]!)})`;
      return `(${e.op} ${e.args.map(formatExpr).join(" ")})`;
    case "fun":
      return `(fun ${e.param} -> ${formatExpr(e.body)})`;
    case "let": {
      const ann = e.ann ? ` : ${formatTypeExpr(e.ann)}` : "";
      const rec = e.rec ? "rec " : "";
      return `(let ${rec}${e.name}${ann} = ${formatExpr(e.value)} in ${formatExpr(e.body)})`;
    }
    case "if":
      return `(if ${formatExpr(e.cond)} then ${formatExpr(e.then)} else ${formatExpr(e.else)})`;
    case "match": {
      const arms = e.arms
        .map((arm) => `| ${formatPattern(arm.pattern)} -> ${formatExpr(arm.body)}`)
        .join(" ");
      return `(match ${formatExpr(e.scrut)} ${arms})`;
    }
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

export function formatDecl(d: Decl): string {
  switch (d.tag) {
    case "type": {
      const params = d.params.length ? ` ${d.params.join(" ")}` : "";
      const variants = d.variants
        .map((v) => (v.argTypes.length ? `${v.name} ${v.argTypes.map(formatTypeAtom).join(" ")}` : v.name))
        .join(" | ");
      return `type ${d.name}${params} = ${variants}`;
    }
    case "let": {
      const ann = d.ann ? ` : ${formatTypeExpr(d.ann)}` : "";
      const rec = d.rec ? "rec " : "";
      return `let ${rec}${d.name}${ann} = ${formatExpr(d.value)}`;
    }
    default: {
      const _never: never = d;
      return _never;
    }
  }
}

export function formatProgram(p: Program): string {
  return p.decls.map(formatDecl).join("\n");
}
