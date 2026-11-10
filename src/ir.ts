/**
 * Administrative normal form.
 *
 * Every intermediate value is an atom (a variable or a literal). `let` binds
 * one computation: a primitive, a call, a constructor, a lambda, a conditional,
 * or a match. `if` and `match` are computations rather than nested expressions
 * so their join point is the surrounding `let` and the continuation is not
 * duplicated.
 *
 * Names are globally unique after ANF conversion. Optimizations can substitute
 * atoms and move `let` bindings without capture. That is the reason inlining
 * and constant folding are written as local tree rewrites.
 *
 * `loop` is a curried self-recursive function whose saturated tail calls were
 * rewritten to `jump`. Codegen copies the arguments into locals and runs the
 * body in a `while` loop, so a tail-recursive loop does not grow the stack.
 * `span` on a primitive or a match is the source position reported if that
 * computation fails at run time.
 */

import { formatPattern, type Pattern, type PrimOp } from "./ast.js";
import type { Span } from "./errors.js";

export type Atom =
  | { tag: "var"; name: string }
  | { tag: "int"; value: number }
  | { tag: "bool"; value: boolean }
  | { tag: "string"; value: string };

export type CExp =
  | { tag: "atom"; atom: Atom }
  | { tag: "prim"; op: PrimOp; args: Atom[]; span?: Span }
  | { tag: "app"; fn: Atom; arg: Atom }
  | { tag: "ctor"; name: string; args: Atom[] }
  | { tag: "fun"; param: string; body: AnfExpr }
  | { tag: "if"; cond: Atom; then: AnfExpr; else: AnfExpr }
  | { tag: "match"; scrut: Atom; arms: AnfArm[]; span?: Span };

export interface AnfArm {
  pattern: Pattern;
  body: AnfExpr;
}

export type AnfExpr =
  | { tag: "halt"; atom: Atom }
  | { tag: "jump"; args: Atom[] }
  | { tag: "let"; name: string; value: CExp; body: AnfExpr }
  | { tag: "letrec"; name: string; param: string; body: AnfExpr; cont: AnfExpr }
  | { tag: "loop"; name: string; params: string[]; body: AnfExpr; cont: AnfExpr };

export function ppAtom(a: Atom): string {
  switch (a.tag) {
    case "var":
      return a.name;
    case "int":
      return String(a.value);
    case "bool":
      return String(a.value);
    case "string":
      return JSON.stringify(a.value);
    default: {
      const _never: never = a;
      return _never;
    }
  }
}

export function ppAnf(e: AnfExpr): string {
  return ppExpr(e, 0);
}

function pad(n: number): string {
  return "  ".repeat(n);
}

function ppExpr(e: AnfExpr, ind: number): string {
  switch (e.tag) {
    case "halt":
      return pad(ind) + ppAtom(e.atom);
    case "let": {
      const rhs = ppCExp(e.value, ind + 1);
      const body = ppExpr(e.body, ind);
      if (rhs.includes("\n")) return `${pad(ind)}let ${e.name} =\n${rhs}\n${pad(ind)}in\n${body}`;
      return `${pad(ind)}let ${e.name} = ${rhs} in\n${body}`;
    }
    case "letrec":
      return `${pad(ind)}let rec ${e.name} = fun ${e.param} ->\n${ppExpr(e.body, ind + 1)}\n${pad(ind)}in\n${ppExpr(e.cont, ind)}`;
    case "loop":
      return `${pad(ind)}let rec ${e.name}(${e.params.join(", ")}) =\n${ppExpr(e.body, ind + 1)}\n${pad(ind)}in\n${ppExpr(e.cont, ind)}`;
    case "jump":
      return `${pad(ind)}jump(${e.args.map(ppAtom).join(", ")})`;
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

function ppCExp(c: CExp, ind: number): string {
  switch (c.tag) {
    case "atom":
      return ppAtom(c.atom);
    case "prim":
      if (c.op === "neg") return `(- ${ppAtom(c.args[0]!)})`;
      if (c.op === "++") return `(${ppAtom(c.args[0]!)} ++ ${ppAtom(c.args[1]!)})`;
      return `(${ppAtom(c.args[0]!)} ${c.op} ${ppAtom(c.args[1]!)})`;
    case "app":
      return `${ppAtom(c.fn)}(${ppAtom(c.arg)})`;
    case "ctor":
      return c.args.length === 0 ? c.name : `${c.name}(${c.args.map(ppAtom).join(", ")})`;
    case "fun":
      return `${pad(ind)}fun ${c.param} ->\n${ppExpr(c.body, ind + 1)}`;
    case "if":
      return `${pad(ind)}if ${ppAtom(c.cond)} then\n${ppExpr(c.then, ind + 1)}\n${pad(ind)}else\n${ppExpr(c.else, ind + 1)}`;
    case "match": {
      const arms = c.arms
        .map((arm) => `${pad(ind + 1)}| ${formatPattern(arm.pattern)} ->\n${ppExpr(arm.body, ind + 2)}`)
        .join("\n");
      return `${pad(ind)}match ${ppAtom(c.scrut)} with\n${arms}`;
    }
    default: {
      const _never: never = c;
      return _never;
    }
  }
}

/** Bind the atom produced by `branch` to `resultName` and continue with `cont`. */
export function spliceTail(branch: AnfExpr, resultName: string, cont: AnfExpr): AnfExpr {
  switch (branch.tag) {
    case "halt":
      if (branch.atom.tag === "var") return substExpr(cont, resultName, branch.atom);
      return { tag: "let", name: resultName, value: { tag: "atom", atom: branch.atom }, body: cont };
    case "let":
      return {
        tag: "let",
        name: branch.name,
        value: branch.value,
        body: spliceTail(branch.body, resultName, cont),
      };
    case "letrec":
      return { ...branch, cont: spliceTail(branch.cont, resultName, cont) };
    case "loop":
      return { ...branch, cont: spliceTail(branch.cont, resultName, cont) };
    case "jump":
      return branch;
    default: {
      const _never: never = branch;
      return _never;
    }
  }
}

/** Replace free occurrences of variable `name` with an atom. Binders shadow. */
export function substExpr(e: AnfExpr, name: string, rep: Atom): AnfExpr {
  switch (e.tag) {
    case "halt":
      return { tag: "halt", atom: substAtom(e.atom, name, rep) };
    case "let":
      return {
        tag: "let",
        name: e.name,
        value: substCExp(e.value, name, rep),
        body: e.name === name ? e.body : substExpr(e.body, name, rep),
      };
    case "letrec": {
      const bodyShadow = e.name === name || e.param === name;
      return {
        tag: "letrec",
        name: e.name,
        param: e.param,
        body: bodyShadow ? e.body : substExpr(e.body, name, rep),
        cont: e.name === name ? e.cont : substExpr(e.cont, name, rep),
      };
    }
    case "loop": {
      const bodyShadow = e.name === name || e.params.includes(name);
      return {
        tag: "loop",
        name: e.name,
        params: e.params,
        body: bodyShadow ? e.body : substExpr(e.body, name, rep),
        cont: e.name === name ? e.cont : substExpr(e.cont, name, rep),
      };
    }
    case "jump":
      return { tag: "jump", args: e.args.map((a) => substAtom(a, name, rep)) };
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

function substCExp(c: CExp, name: string, rep: Atom): CExp {
  switch (c.tag) {
    case "atom":
      return { tag: "atom", atom: substAtom(c.atom, name, rep) };
    case "prim":
      return { tag: "prim", op: c.op, args: c.args.map((a) => substAtom(a, name, rep)), span: c.span };
    case "app":
      return { tag: "app", fn: substAtom(c.fn, name, rep), arg: substAtom(c.arg, name, rep) };
    case "ctor":
      return { tag: "ctor", name: c.name, args: c.args.map((a) => substAtom(a, name, rep)) };
    case "fun":
      return { tag: "fun", param: c.param, body: c.param === name ? c.body : substExpr(c.body, name, rep) };
    case "if":
      return {
        tag: "if",
        cond: substAtom(c.cond, name, rep),
        then: substExpr(c.then, name, rep),
        else: substExpr(c.else, name, rep),
      };
    case "match":
      return {
        tag: "match",
        scrut: substAtom(c.scrut, name, rep),
        span: c.span,
        arms: c.arms.map((arm) => ({
          pattern: arm.pattern,
          body: patternBinds(arm.pattern).has(name) ? arm.body : substExpr(arm.body, name, rep),
        })),
      };
    default: {
      const _never: never = c;
      return _never;
    }
  }
}

function substAtom(a: Atom, name: string, rep: Atom): Atom {
  if (a.tag === "var" && a.name === name) return rep;
  return a;
}

export function patternBinds(p: Pattern): Set<string> {
  const out = new Set<string>();
  const walk = (pat: Pattern): void => {
    if (pat.tag === "pvar") out.add(pat.name);
    else if (pat.tag === "pctor") pat.args.forEach(walk);
  };
  walk(p);
  return out;
}

export function freeVars(e: AnfExpr): Set<string> {
  switch (e.tag) {
    case "halt":
      return freeAtom(e.atom);
    case "let": {
      const free = freeVars(e.body);
      free.delete(e.name);
      for (const name of freeCExp(e.value)) free.add(name);
      return free;
    }
    case "letrec": {
      const free = freeVars(e.cont);
      free.delete(e.name);
      const body = freeVars(e.body);
      body.delete(e.name);
      body.delete(e.param);
      for (const name of body) free.add(name);
      return free;
    }
    case "loop": {
      const free = freeVars(e.cont);
      free.delete(e.name);
      const body = freeVars(e.body);
      body.delete(e.name);
      for (const param of e.params) body.delete(param);
      for (const name of body) free.add(name);
      return free;
    }
    case "jump":
      return unionAtoms(e.args);
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

function freeCExp(c: CExp): Set<string> {
  switch (c.tag) {
    case "atom":
      return freeAtom(c.atom);
    case "prim":
      return unionAtoms(c.args);
    case "app":
      return unionAtoms([c.fn, c.arg]);
    case "ctor":
      return unionAtoms(c.args);
    case "fun": {
      const free = freeVars(c.body);
      free.delete(c.param);
      return free;
    }
    case "if": {
      const free = freeAtom(c.cond);
      for (const name of freeVars(c.then)) free.add(name);
      for (const name of freeVars(c.else)) free.add(name);
      return free;
    }
    case "match": {
      const free = freeAtom(c.scrut);
      for (const arm of c.arms) {
        const body = freeVars(arm.body);
        for (const bound of patternBinds(arm.pattern)) body.delete(bound);
        for (const name of body) free.add(name);
      }
      return free;
    }
    default: {
      const _never: never = c;
      return _never;
    }
  }
}

function freeAtom(a: Atom): Set<string> {
  const free = new Set<string>();
  if (a.tag === "var") free.add(a.name);
  return free;
}

function unionAtoms(atoms: Atom[]): Set<string> {
  const free = new Set<string>();
  for (const atom of atoms) {
    if (atom.tag === "var") free.add(atom.name);
  }
  return free;
}

export function countUses(e: AnfExpr, name: string): number {
  switch (e.tag) {
    case "halt":
      return atomUses(e.atom, name);
    case "let":
      return cexpUses(e.value, name) + (e.name === name ? 0 : countUses(e.body, name));
    case "letrec": {
      const inBody = e.name === name || e.param === name ? 0 : countUses(e.body, name);
      const inCont = e.name === name ? 0 : countUses(e.cont, name);
      return inBody + inCont;
    }
    case "loop": {
      const inBody = e.name === name || e.params.includes(name) ? 0 : countUses(e.body, name);
      const inCont = e.name === name ? 0 : countUses(e.cont, name);
      return inBody + inCont;
    }
    case "jump":
      return e.args.reduce((n, a) => n + atomUses(a, name), 0);
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

function cexpUses(c: CExp, name: string): number {
  switch (c.tag) {
    case "atom":
      return atomUses(c.atom, name);
    case "prim":
      return c.args.reduce((n, a) => n + atomUses(a, name), 0);
    case "app":
      return atomUses(c.fn, name) + atomUses(c.arg, name);
    case "ctor":
      return c.args.reduce((n, a) => n + atomUses(a, name), 0);
    case "fun":
      return c.param === name ? 0 : countUses(c.body, name);
    case "if":
      return atomUses(c.cond, name) + countUses(c.then, name) + countUses(c.else, name);
    case "match":
      return (
        atomUses(c.scrut, name) +
        c.arms.reduce((n, arm) => n + (patternBinds(arm.pattern).has(name) ? 0 : countUses(arm.body, name)), 0)
      );
    default: {
      const _never: never = c;
      return _never;
    }
  }
}

function atomUses(a: Atom, name: string): number {
  return a.tag === "var" && a.name === name ? 1 : 0;
}

export function countLets(e: AnfExpr): number {
  switch (e.tag) {
    case "halt":
      return 0;
    case "let":
      return 1 + countLetsC(e.value) + countLets(e.body);
    case "letrec":
      return 1 + countLets(e.body) + countLets(e.cont);
    case "loop":
      return 1 + countLets(e.body) + countLets(e.cont);
    case "jump":
      return 0;
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

function countLetsC(c: CExp): number {
  switch (c.tag) {
    case "fun":
      return countLets(c.body);
    case "if":
      return countLets(c.then) + countLets(c.else);
    case "match":
      return c.arms.reduce((n, arm) => n + countLets(arm.body), 0);
    default:
      return 0;
  }
}
