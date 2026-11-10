/**
 * Switchable optimization passes over ANF.
 *
 * Order when every pass is enabled:
 *   1. inline    — expose the body of a function at its single call site
 *   2. const-fold — fold primitives and constant `if`s, and propagate literals
 *   3. dce       — drop pure bindings that the previous passes made unused
 *
 * Each pass is semantics-preserving on its own, which is why tests can run
 * them independently and why `run --opt none` must print the same value as
 * `run` with the defaults.
 *
 * Inlining only fires when a non-recursive lambda is applied exactly once and
 * its body is smaller than INLINE_LET_LIMIT. The argument is already an atom,
 * so the call's computation is not duplicated even if the parameter occurs
 * several times. Constant folding does not fold division by zero; that prim
 * stays in the IR and still fails at run time. Dead-code elimination treats
 * calls, matches (they can throw), and division by an unknown denominator as
 * impure, so it will not delete a diverging or failing computation.
 */

import {
  countLets,
  countUses,
  freeVars,
  ppAnf,
  spliceTail,
  substExpr,
  type AnfExpr,
  type Atom,
  type CExp,
} from "./ir.js";

export interface OptFlags {
  constFold: boolean;
  dce: boolean;
  inline: boolean;
}

export const ALL_OPTS: OptFlags = { constFold: true, dce: true, inline: true };
export const NO_OPTS: OptFlags = { constFold: false, dce: false, inline: false };

/** Bodies larger than this stay out of line, so a single use cannot blow up the IR. */
const INLINE_LET_LIMIT = 25;

type ConstVal = { k: "int"; v: number } | { k: "bool"; v: boolean } | { k: "string"; v: string };

export function optimize(expr: AnfExpr, flags: OptFlags): AnfExpr {
  let cur = expr;
  if (flags.inline) cur = inlinePass(cur);
  if (flags.constFold) cur = constFold(cur);
  if (flags.dce) cur = deadCodeElim(cur);
  return cur;
}

export function inlinePass(expr: AnfExpr): AnfExpr {
  return inlineExpr(expr);
}

export function constFold(expr: AnfExpr): AnfExpr {
  return foldExpr(expr, new Map());
}

export function deadCodeElim(expr: AnfExpr): AnfExpr {
  return dceExpr(expr);
}

function inlineExpr(e: AnfExpr): AnfExpr {
  switch (e.tag) {
    case "halt":
      return e;
    case "letrec":
      return { tag: "letrec", name: e.name, param: e.param, body: inlineExpr(e.body), cont: inlineExpr(e.cont) };
    case "let": {
      const value = inlineCExp(e.value);
      const body = inlineExpr(e.body);
      if (
        value.tag === "fun" &&
        countLets(value.body) <= INLINE_LET_LIMIT &&
        countUses(body, e.name) === 1
      ) {
        const replaced = inlineAt(body, e.name, value.param, value.body);
        if (replaced) return inlineExpr(replaced);
      }
      return { tag: "let", name: e.name, value, body };
    }
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

function inlineCExp(c: CExp): CExp {
  switch (c.tag) {
    case "fun":
      return { tag: "fun", param: c.param, body: inlineExpr(c.body) };
    case "if":
      return { tag: "if", cond: c.cond, then: inlineExpr(c.then), else: inlineExpr(c.else) };
    case "match":
      return { tag: "match", scrut: c.scrut, arms: c.arms.map((arm) => ({ pattern: arm.pattern, body: inlineExpr(arm.body) })) };
    default:
      return c;
  }
}

/**
 * Replace the single application `let r = fname(arg)` with the function body.
 * Returns null when the only use is not a call (the function is passed as a value).
 */
function inlineAt(e: AnfExpr, fname: string, param: string, fnBody: AnfExpr): AnfExpr | null {
  let found = false;
  const go = (expr: AnfExpr): AnfExpr => {
    if (found) return expr;
    switch (expr.tag) {
      case "halt":
        return expr;
      case "letrec":
        return { ...expr, body: go(expr.body), cont: go(expr.cont) };
      case "let": {
        if (
          expr.value.tag === "app" &&
          expr.value.fn.tag === "var" &&
          expr.value.fn.name === fname
        ) {
          found = true;
          const substituted = substExpr(fnBody, param, expr.value.arg);
          return spliceTail(substituted, expr.name, expr.body);
        }
        const value = goC(expr.value);
        if (found) return { ...expr, value };
        return { ...expr, body: go(expr.body) };
      }
      default: {
        const _never: never = expr;
        return _never;
      }
    }
  };
  const goC = (c: CExp): CExp => {
    if (found) return c;
    switch (c.tag) {
      case "fun":
        return { ...c, body: go(c.body) };
      case "if":
        return { ...c, then: go(c.then), else: go(c.else) };
      case "match":
        return { ...c, arms: c.arms.map((arm) => ({ pattern: arm.pattern, body: go(arm.body) })) };
      default:
        return c;
    }
  };
  const out = go(e);
  return found ? out : null;
}

function foldExpr(e: AnfExpr, env: Map<string, ConstVal>): AnfExpr {
  switch (e.tag) {
    case "halt":
      return { tag: "halt", atom: resolveAtom(e.atom, env) };
    case "letrec":
      return {
        tag: "letrec",
        name: e.name,
        param: e.param,
        body: foldExpr(e.body, env),
        cont: foldExpr(e.cont, env),
      };
    case "let": {
      const value = foldCExp(e.value, env);
      if (value.tag === "if") {
        const cond = atomConst(resolveAtom(value.cond, env));
        if (cond?.k === "bool") {
          const branch = cond.v ? value.then : value.else;
          return foldExpr(spliceTail(branch, e.name, e.body), env);
        }
      }
      const folded = cexpConst(value, env);
      if (folded) {
        const env2 = new Map(env);
        env2.set(e.name, folded);
        return {
          tag: "let",
          name: e.name,
          value: { tag: "atom", atom: constToAtom(folded) },
          body: foldExpr(e.body, env2),
        };
      }
      return { tag: "let", name: e.name, value, body: foldExpr(e.body, env) };
    }
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

function foldCExp(c: CExp, env: Map<string, ConstVal>): CExp {
  switch (c.tag) {
    case "atom":
      return { tag: "atom", atom: resolveAtom(c.atom, env) };
    case "prim": {
      const args = c.args.map((a) => resolveAtom(a, env));
      const consts = args.map(atomConst);
      if (consts.every((x): x is ConstVal => x !== null)) {
        const result = evalPrim(c.op, consts);
        if (result) return { tag: "atom", atom: constToAtom(result) };
      }
      return { tag: "prim", op: c.op, args };
    }
    case "app":
      return { tag: "app", fn: resolveAtom(c.fn, env), arg: resolveAtom(c.arg, env) };
    case "ctor":
      return { tag: "ctor", name: c.name, args: c.args.map((a) => resolveAtom(a, env)) };
    case "fun":
      return { tag: "fun", param: c.param, body: foldExpr(c.body, env) };
    case "if":
      return {
        tag: "if",
        cond: resolveAtom(c.cond, env),
        then: foldExpr(c.then, env),
        else: foldExpr(c.else, env),
      };
    case "match":
      return {
        tag: "match",
        scrut: resolveAtom(c.scrut, env),
        arms: c.arms.map((arm) => ({ pattern: arm.pattern, body: foldExpr(arm.body, env) })),
      };
    default: {
      const _never: never = c;
      return _never;
    }
  }
}

function resolveAtom(a: Atom, env: Map<string, ConstVal>): Atom {
  if (a.tag !== "var") return a;
  const c = env.get(a.name);
  return c ? constToAtom(c) : a;
}

function atomConst(a: Atom): ConstVal | null {
  switch (a.tag) {
    case "int":
      return { k: "int", v: a.value };
    case "bool":
      return { k: "bool", v: a.value };
    case "string":
      return { k: "string", v: a.value };
    case "var":
      return null;
    default: {
      const _never: never = a;
      return _never;
    }
  }
}

function cexpConst(c: CExp, env: Map<string, ConstVal>): ConstVal | null {
  if (c.tag !== "atom") return null;
  if (c.atom.tag === "var") return env.get(c.atom.name) ?? null;
  return atomConst(c.atom);
}

function constToAtom(c: ConstVal): Atom {
  if (c.k === "int") return { tag: "int", value: c.v };
  if (c.k === "bool") return { tag: "bool", value: c.v };
  return { tag: "string", value: c.v };
}

function evalPrim(op: string, args: ConstVal[]): ConstVal | null {
  if (op === "neg") {
    const a = args[0];
    if (a?.k === "int") return { k: "int", v: -a.v };
    return null;
  }
  const left = args[0];
  const right = args[1];
  if (!left || !right) return null;
  if (left.k === "int" && right.k === "int") {
    switch (op) {
      case "+":
        return { k: "int", v: left.v + right.v };
      case "-":
        return { k: "int", v: left.v - right.v };
      case "*":
        return { k: "int", v: left.v * right.v };
      case "/":
        if (right.v === 0) return null;
        return { k: "int", v: Math.trunc(left.v / right.v) };
      case "<":
        return { k: "bool", v: left.v < right.v };
      case "<=":
        return { k: "bool", v: left.v <= right.v };
      case ">":
        return { k: "bool", v: left.v > right.v };
      case ">=":
        return { k: "bool", v: left.v >= right.v };
      default:
        break;
    }
  }
  if ((op === "==" || op === "!=") && left.k === right.k) {
    const same = left.v === right.v;
    return { k: "bool", v: op === "==" ? same : !same };
  }
  if (op === "++" && left.k === "string" && right.k === "string") {
    return { k: "string", v: left.v + right.v };
  }
  return null;
}

function dceExpr(e: AnfExpr): AnfExpr {
  switch (e.tag) {
    case "halt":
      return e;
    case "letrec": {
      const cont = dceExpr(e.cont);
      if (!freeVars(cont).has(e.name)) return cont;
      return { tag: "letrec", name: e.name, param: e.param, body: dceExpr(e.body), cont };
    }
    case "let": {
      const body = dceExpr(e.body);
      if (!freeVars(body).has(e.name) && isPure(e.value)) return body;
      return { tag: "let", name: e.name, value: dceCExp(e.value), body };
    }
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

function dceCExp(c: CExp): CExp {
  switch (c.tag) {
    case "fun":
      return { tag: "fun", param: c.param, body: dceExpr(c.body) };
    case "if":
      return { tag: "if", cond: c.cond, then: dceExpr(c.then), else: dceExpr(c.else) };
    case "match":
      return { tag: "match", scrut: c.scrut, arms: c.arms.map((arm) => ({ pattern: arm.pattern, body: dceExpr(arm.body) })) };
    default:
      return c;
  }
}

function isPure(c: CExp): boolean {
  switch (c.tag) {
    case "atom":
    case "ctor":
    case "fun":
      return true;
    case "app":
    case "match":
      return false;
    case "prim":
      if (c.op === "/") {
        const denom = c.args[1];
        return !!denom && denom.tag === "int" && denom.value !== 0;
      }
      return true;
    case "if":
      return isPureExpr(c.then) && isPureExpr(c.else);
    default: {
      const _never: never = c;
      return _never;
    }
  }
}

function isPureExpr(e: AnfExpr): boolean {
  switch (e.tag) {
    case "halt":
      return true;
    case "let":
      return isPure(e.value) && isPureExpr(e.body);
    case "letrec":
      return isPureExpr(e.body) && isPureExpr(e.cont);
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

/** Debug helper so a failing IR test can show both sides without importing pp twice. */
export function sameIr(a: AnfExpr, b: AnfExpr): boolean {
  return ppAnf(a) === ppAnf(b);
}
