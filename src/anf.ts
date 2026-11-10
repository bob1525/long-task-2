/**
 * Conversion to ANF.
 *
 * The converter is written in the usual "name this expression and pass the
 * atom to a continuation" style. Continuations are built as nested `let`s, so
 * `if` / `match` in non-tail position become the right-hand side of a join
 * binding instead of duplicating the code that uses their result.
 *
 * User bindings are renamed to be unique. A `let` whose right-hand side is
 * already a variable does not allocate another binding: the source name is an
 * alias of that variable. That keeps the IR small enough that the inliner can
 * see `let f = fun x -> ... in f 1` directly.
 *
 * Saturated constructor applications and primitive operators become a single
 * computation. A partially applied constructor is eta-expanded into ordinary
 * lambdas, so the backend only has to know nullary and fully applied `ctor`
 * nodes plus normal calls.
 */

import type { Expr, Pattern } from "./ast.js";
import {
  type AnfArm,
  type AnfExpr,
  type Atom,
  type CExp,
} from "./ir.js";

export interface CtorArity {
  name: string;
  arity: number;
}

class Supply {
  private n = 0;
  private readonly used = new Set<string>();

  unique(base: string): string {
    if (!this.used.has(base)) {
      this.used.add(base);
      return base;
    }
    let i = 2;
    while (this.used.has(`${base}_${i}`)) i += 1;
    const name = `${base}_${i}`;
    this.used.add(name);
    return name;
  }

  fresh(prefix: string): string {
    let name = "";
    do {
      this.n += 1;
      name = `${prefix}${this.n}`;
    } while (this.used.has(name));
    this.used.add(name);
    return name;
  }
}

class Scope {
  constructor(private readonly map = new Map<string, string>()) {}

  get(name: string): string | undefined {
    return this.map.get(name);
  }

  with(name: string, unique: string): Scope {
    const map = new Map(this.map);
    map.set(name, unique);
    return new Scope(map);
  }
}

type Kont = (atom: Atom) => AnfExpr;

export function toAnf(expr: Expr, ctors: CtorArity[]): AnfExpr {
  const arity = new Map(ctors.map((c) => [c.name, c.arity]));
  const supply = new Supply();
  return anf(expr, (atom) => ({ tag: "halt", atom }), new Scope(), supply, arity);
}

function anf(e: Expr, k: Kont, scope: Scope, supply: Supply, arity: Map<string, number>): AnfExpr {
  switch (e.tag) {
    case "int":
      return k({ tag: "int", value: e.value });
    case "bool":
      return k({ tag: "bool", value: e.value });
    case "string":
      return k({ tag: "string", value: e.value });
    case "var": {
      const name = scope.get(e.name);
      if (!name) throw new Error(`internal: unbound variable '${e.name}' during ANF conversion`);
      return k({ tag: "var", name });
    }
    case "ctor":
      return anfCtor(e.name, [], k, supply, arity);
    case "prim":
      return anfList(
        e.args,
        (args) => {
          const name = supply.fresh("t");
          return bind(name, { tag: "prim", op: e.op, args }, k({ tag: "var", name }));
        },
        scope,
        supply,
        arity,
      );
    case "app": {
      const spine = flattenApp(e);
      if (spine.fn.tag === "ctor") {
        const ctorName = spine.fn.name;
        return anfList(spine.args, (args) => anfCtor(ctorName, args, k, supply, arity), scope, supply, arity);
      }
      return anf(
        spine.fn,
        (fn) =>
          anfList(
            spine.args,
            (args) => emitCurried(fn, args, k, supply),
            scope,
            supply,
            arity,
          ),
        scope,
        supply,
        arity,
      );
    }
    case "fun": {
      const param = supply.unique(e.param);
      const body = anf(e.body, halt, scope.with(e.param, param), supply, arity);
      const name = supply.fresh("lam");
      return bind(name, { tag: "fun", param, body }, k({ tag: "var", name }));
    }
    case "let": {
      if (e.rec) {
        if (e.value.tag !== "fun") throw new Error("internal: let rec reached ANF without a function");
        const uname = supply.unique(e.name);
        const param = supply.unique(e.value.param);
        const body = anf(
          e.value.body,
          halt,
          scope.with(e.name, uname).with(e.value.param, param),
          supply,
          arity,
        );
        const cont = anf(e.body, k, scope.with(e.name, uname), supply, arity);
        return { tag: "letrec", name: uname, param, body, cont };
      }
      if (e.value.tag === "fun") {
        const uname = supply.unique(e.name);
        const param = supply.unique(e.value.param);
        const body = anf(e.value.body, halt, scope.with(e.value.param, param), supply, arity);
        const cont = anf(e.body, k, scope.with(e.name, uname), supply, arity);
        return bind(uname, { tag: "fun", param, body }, cont);
      }
      return anf(
        e.value,
        (atom) => {
          if (atom.tag === "var") return anf(e.body, k, scope.with(e.name, atom.name), supply, arity);
          const uname = supply.unique(e.name);
          return bind(uname, { tag: "atom", atom }, anf(e.body, k, scope.with(e.name, uname), supply, arity));
        },
        scope,
        supply,
        arity,
      );
    }
    case "if":
      return anf(
        e.cond,
        (cond) => {
          const then = anf(e.then, halt, scope, supply, arity);
          const elseB = anf(e.else, halt, scope, supply, arity);
          const name = supply.fresh("t");
          return bind(name, { tag: "if", cond, then, else: elseB }, k({ tag: "var", name }));
        },
        scope,
        supply,
        arity,
      );
    case "match":
      return anf(
        e.scrut,
        (scrut) => {
          const arms: AnfArm[] = e.arms.map((arm) => {
            const renamed = renamePattern(arm.pattern, scope, supply);
            return { pattern: renamed.pattern, body: anf(arm.body, halt, renamed.scope, supply, arity) };
          });
          const name = supply.fresh("t");
          return bind(name, { tag: "match", scrut, arms }, k({ tag: "var", name }));
        },
        scope,
        supply,
        arity,
      );
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

function anfCtor(
  name: string,
  args: Atom[],
  k: Kont,
  supply: Supply,
  arity: Map<string, number>,
): AnfExpr {
  const full = arity.get(name);
  if (full === undefined) throw new Error(`internal: unknown constructor '${name}' during ANF conversion`);
  if (args.length === full) {
    const t = supply.fresh("t");
    return bind(t, { tag: "ctor", name, args }, k({ tag: "var", name: t }));
  }
  if (args.length > full) {
    const t = supply.fresh("t");
    return bind(
      t,
      { tag: "ctor", name, args: args.slice(0, full) },
      emitCurried({ tag: "var", name: t }, args.slice(full), k, supply),
    );
  }
  const params: string[] = [];
  for (let i = args.length; i < full; i++) params.push(supply.fresh("c"));
  const all: Atom[] = [...args, ...params.map((p) => ({ tag: "var" as const, name: p }))];
  const result = supply.fresh("t");
  let body: AnfExpr = bind(result, { tag: "ctor", name, args: all }, halt({ tag: "var", name: result }));
  for (let i = params.length - 1; i >= 1; i--) {
    const lam = supply.fresh("lam");
    body = bind(lam, { tag: "fun", param: params[i]!, body }, halt({ tag: "var", name: lam }));
  }
  const outer = supply.fresh("lam");
  const param = params[0];
  if (!param) throw new Error("internal: eta-expansion of a saturated constructor");
  return bind(outer, { tag: "fun", param, body }, k({ tag: "var", name: outer }));
}

function emitCurried(fn: Atom, args: Atom[], k: Kont, supply: Supply): AnfExpr {
  if (args.length === 0) return k(fn);
  const go = (index: number, acc: Atom): AnfExpr => {
    const name = supply.fresh("t");
    const next: Atom = { tag: "var", name };
    const rest = index + 1 === args.length ? k(next) : go(index + 1, next);
    return bind(name, { tag: "app", fn: acc, arg: args[index]! }, rest);
  };
  return go(0, fn);
}

function anfList(
  exprs: Expr[],
  k: (atoms: Atom[]) => AnfExpr,
  scope: Scope,
  supply: Supply,
  arity: Map<string, number>,
): AnfExpr {
  if (exprs.length === 0) return k([]);
  return anf(
    exprs[0]!,
    (atom) => anfList(exprs.slice(1), (rest) => k([atom, ...rest]), scope, supply, arity),
    scope,
    supply,
    arity,
  );
}

function renamePattern(p: Pattern, scope: Scope, supply: Supply): { pattern: Pattern; scope: Scope } {
  switch (p.tag) {
    case "pvar": {
      const name = supply.unique(p.name);
      return { pattern: { ...p, name }, scope: scope.with(p.name, name) };
    }
    case "pctor": {
      let next = scope;
      const args: Pattern[] = [];
      for (const arg of p.args) {
        const renamed = renamePattern(arg, next, supply);
        args.push(renamed.pattern);
        next = renamed.scope;
      }
      return { pattern: { ...p, args }, scope: next };
    }
    case "pwild":
    case "pint":
    case "pbool":
    case "pstring":
      return { pattern: p, scope };
    default: {
      const _never: never = p;
      return _never;
    }
  }
}

function flattenApp(e: Expr): { fn: Expr; args: Expr[] } {
  const args: Expr[] = [];
  let cur = e;
  while (cur.tag === "app") {
    args.unshift(cur.arg);
    cur = cur.fn;
  }
  return { fn: cur, args };
}

function bind(name: string, value: CExp, body: AnfExpr): AnfExpr {
  return { tag: "let", name, value, body };
}

function halt(atom: Atom): AnfExpr {
  return { tag: "halt", atom };
}
