/**
 * Switchable optimization passes over ANF.
 *
 * Order when every pass is enabled:
 *   1. inline     — expose the body of a function at its single call site
 *   2. const-fold — fold primitives and constant `if`s, and propagate literals
 *   3. tco        — rewrite saturated self tail calls into jumps
 *   4. dce        — drop pure bindings that the previous passes made unused
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
  tco: boolean;
}

export const ALL_OPTS: OptFlags = { constFold: true, dce: true, inline: true, tco: true };
export const NO_OPTS: OptFlags = { constFold: false, dce: false, inline: false, tco: false };

/** Bodies larger than this stay out of line, so a single use cannot blow up the IR. */
const INLINE_LET_LIMIT = 25;

type ConstVal = { k: "int"; v: number } | { k: "bool"; v: boolean } | { k: "string"; v: string };

export function optimize(expr: AnfExpr, flags: OptFlags): AnfExpr {
  let cur = expr;
  if (flags.inline) cur = inlinePass(cur);
  if (flags.constFold) cur = constFold(cur);
  if (flags.tco) cur = tailCallPass(cur);
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
    case "jump":
      return e;
    case "letrec":
      return { tag: "letrec", name: e.name, param: e.param, body: inlineExpr(e.body), cont: inlineExpr(e.cont) };
    case "loop":
      return { tag: "loop", name: e.name, params: e.params, body: inlineExpr(e.body), cont: inlineExpr(e.cont) };
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
      return {
        tag: "match",
        scrut: c.scrut,
        span: c.span,
        arms: c.arms.map((arm) => ({ pattern: arm.pattern, body: inlineExpr(arm.body) })),
      };
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
      case "jump":
        return expr;
      case "letrec":
        return { ...expr, body: go(expr.body), cont: go(expr.cont) };
      case "loop":
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
    case "jump":
      return { tag: "jump", args: e.args.map((a) => resolveAtom(a, env)) };
    case "letrec":
      return {
        tag: "letrec",
        name: e.name,
        param: e.param,
        body: foldExpr(e.body, env),
        cont: foldExpr(e.cont, env),
      };
    case "loop":
      return {
        tag: "loop",
        name: e.name,
        params: e.params,
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
      return { tag: "prim", op: c.op, args, span: c.span };
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
        span: c.span,
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
    case "loop": {
      const cont = dceExpr(e.cont);
      if (!freeVars(cont).has(e.name)) return cont;
      return { tag: "loop", name: e.name, params: e.params, body: dceExpr(e.body), cont };
    }
    case "jump":
      return e;
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
      return {
        tag: "match",
        scrut: c.scrut,
        span: c.span,
        arms: c.arms.map((arm) => ({ pattern: arm.pattern, body: dceExpr(arm.body) })),
      };
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
    case "jump":
      return true;
    case "let":
      return isPure(e.value) && isPureExpr(e.body);
    case "letrec":
    case "loop":
      return isPureExpr(e.body) && isPureExpr(e.cont);
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

/**
 * Rewrite saturated self tail calls.
 *
 * `let rec f x y = ... f a b` is curried in ANF: `f` returns a lambda, and the
 * call is the chain `let t1 = f(a) in let t2 = t1(b) in t2`. When that chain
 * is the result of the innermost function (or of an `if` / `match` arm), it
 * becomes `jump(a, b)` inside a multi-parameter `loop`. Calls that are not
 * saturated, or whose result is used by another computation, stay ordinary
 * applications, so partial application and non-tail recursion are unchanged.
 */
export function tailCallPass(expr: AnfExpr): AnfExpr {
  return tcoExpr(expr);
}

function tcoExpr(e: AnfExpr): AnfExpr {
  switch (e.tag) {
    case "halt":
    case "jump":
      return e;
    case "let":
      return { ...e, value: tcoCExp(e.value), body: tcoExpr(e.body) };
    case "letrec": {
      const body = tcoExpr(e.body);
      const cont = tcoExpr(e.cont);
      const peeled = peelParams(body, [e.param]);
      const rewritten = rewriteTail(peeled.inner, e.name, peeled.params.length);
      if (!rewritten.jumped) return { ...e, body, cont };
      return { tag: "loop", name: e.name, params: peeled.params, body: rewritten.expr, cont };
    }
    case "loop":
      return { ...e, body: tcoExpr(e.body), cont: tcoExpr(e.cont) };
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

function tcoCExp(c: CExp): CExp {
  switch (c.tag) {
    case "fun":
      return { ...c, body: tcoExpr(c.body) };
    case "if":
      return { ...c, then: tcoExpr(c.then), else: tcoExpr(c.else) };
    case "match":
      return { ...c, arms: c.arms.map((arm) => ({ ...arm, body: tcoExpr(arm.body) })) };
    default:
      return c;
  }
}

function peelParams(body: AnfExpr, params: string[]): { params: string[]; inner: AnfExpr } {
  if (
    body.tag === "let" &&
    body.value.tag === "fun" &&
    body.body.tag === "halt" &&
    body.body.atom.tag === "var" &&
    body.body.atom.name === body.name
  ) {
    return peelParams(body.value.body, [...params, body.value.param]);
  }
  return { params, inner: body };
}

function rewriteTail(expr: AnfExpr, fname: string, arity: number): { expr: AnfExpr; jumped: boolean } {
  const args = parseSaturated(expr, { tag: "var", name: fname }, arity, []);
  if (args) return { expr: { tag: "jump", args }, jumped: true };
  if (expr.tag === "let" && isResult(expr) && expr.value.tag === "if") {
    const thenB = rewriteTail(expr.value.then, fname, arity);
    const elseB = rewriteTail(expr.value.else, fname, arity);
    return {
      expr: { ...expr, value: { ...expr.value, then: thenB.expr, else: elseB.expr } },
      jumped: thenB.jumped || elseB.jumped,
    };
  }
  if (expr.tag === "let" && isResult(expr) && expr.value.tag === "match") {
    let jumped = false;
    const arms = expr.value.arms.map((arm) => {
      const armB = rewriteTail(arm.body, fname, arity);
      jumped = jumped || armB.jumped;
      return { ...arm, body: armB.expr };
    });
    return { expr: { ...expr, value: { ...expr.value, arms } }, jumped };
  }
  if (expr.tag === "let") {
    const body = rewriteTail(expr.body, fname, arity);
    return { expr: { ...expr, body: body.expr }, jumped: body.jumped };
  }
  if (expr.tag === "letrec" || expr.tag === "loop") {
    const cont = rewriteTail(expr.cont, fname, arity);
    return { expr: { ...expr, cont: cont.expr }, jumped: cont.jumped };
  }
  return { expr, jumped: false };
}

function isResult(e: Extract<AnfExpr, { tag: "let" }>): boolean {
  return e.body.tag === "halt" && e.body.atom.tag === "var" && e.body.atom.name === e.name;
}

function atomEq(a: Atom, b: Atom): boolean {
  if (a.tag !== b.tag) return false;
  if (a.tag === "var" && b.tag === "var") return a.name === b.name;
  if (a.tag === "int" && b.tag === "int") return a.value === b.value;
  if (a.tag === "bool" && b.tag === "bool") return a.value === b.value;
  if (a.tag === "string" && b.tag === "string") return a.value === b.value;
  return false;
}

/** A chain `f(a)(b)...` of exactly `need` applications whose final result is halted. */
function parseSaturated(expr: AnfExpr, expectFn: Atom, need: number, acc: Atom[]): Atom[] | null {
  if (need === 0) {
    return expr.tag === "halt" && atomEq(expr.atom, expectFn) ? acc : null;
  }
  if (expr.tag !== "let" || expr.value.tag !== "app" || !atomEq(expr.value.fn, expectFn)) return null;
  return parseSaturated(expr.body, { tag: "var", name: expr.name }, need - 1, [...acc, expr.value.arg]);
}

/** Debug helper so a failing IR test can show both sides without importing pp twice. */
export function sameIr(a: AnfExpr, b: AnfExpr): boolean {
  return ppAnf(a) === ppAnf(b);
}
