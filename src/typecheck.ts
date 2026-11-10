/**
 * Hindley-Milner type inference with let-polymorphism.
 *
 * Levels (a standard way to implement generalization without a separate
 * free-variable scan of the environment):
 * - Every `let` enters a new level while its right-hand side is inferred.
 * - Fresh variables are born at the current level.
 * - Generalization quantifies variables whose level is strictly deeper than
 *   the level outside the let. Lambda parameters are allocated at the
 *   surrounding level, so they stay monomorphic.
 * - When a deep variable is unified with an outer one, its level is lowered.
 *   That stops a variable that has escaped into an outer scope from being
 *   generalized. Recursive bindings are monomorphic inside their own body
 *   (no polymorphic recursion) and generalized afterwards.
 *
 * Annotations are checked by skolemization: the annotated type's variables
 * are replaced by rigid constructors and unified with a *copy* of the
 * inferred type. Unification against the copy cannot leak skolem constants
 * back into the program, and a too-general annotation (`a -> b` for the
 * identity) fails because the two skolems cannot be unified.
 *
 * The language is pure, so there is no value restriction: every let is
 * generalized, including ones whose right-hand side is not a syntactic value.
 */

import type { Expr, Pattern, Program, TypeExpr } from "./ast.js";
import { missingPattern, type ExType, type ExVariant } from "./exhaust.js";
import { parse } from "./parser.js";
import { CompileError, type Span } from "./errors.js";

const GENERIC = -1;

type TVar = {
  kind: "var";
  id: number;
  level: number;
  link: Type | null;
  name?: string;
};
type TCon = { kind: "con"; name: string; args: Type[] };
type TFun = { kind: "fun"; arg: Type; ret: Type };
type Type = TVar | TCon | TFun;

interface CtorInfo {
  arity: number;
  scheme: Type;
}

interface Binding {
  name: string;
  scheme: Type;
  topLevel: boolean;
  span: Span;
}

export interface BindingType {
  name: string;
  type: string;
  topLevel: boolean;
}

export interface CheckedProgram {
  filename: string;
  expr: Expr;
  /** Displayed let-schemes, in source order. Nested lets are included. */
  bindings: BindingType[];
  /** Scheme of `main`, or of the last top-level binding when `main` is absent. */
  resultName: string;
  result: string;
  ctors: { name: string; arity: number }[];
  /** Non-exhaustive matches. They do not fail type checking. */
  warnings: string[];
}

const BUILTIN_ARITY: Record<string, number> = { Int: 0, Bool: 0, String: 0 };

export function inferProgram(source: string, filename = "<input>"): CheckedProgram {
  const program = parse(source, filename);
  return new Checker(filename).check(program);
}

class Env {
  private constructor(private readonly map: Map<string, Type>) {}

  static empty(): Env {
    return new Env(new Map());
  }

  extend(name: string, type: Type): Env {
    const map = new Map(this.map);
    map.set(name, type);
    return new Env(map);
  }

  /** Returns the stored scheme. Callers that need a fresh type must instantiate. */
  get(name: string): Type | undefined {
    return this.map.get(name);
  }
}

class Checker {
  private nextId = 1;
  private currentLevel = 0;
  private readonly ctors = new Map<string, CtorInfo>();
  private readonly typeArity = new Map<string, number>(Object.entries(BUILTIN_ARITY));
  private readonly variantNames = new Map<string, string[]>();
  private readonly warnings: string[] = [];
  private exTable: Map<string, ExVariant[]> | null = null;

  constructor(private readonly filename: string) {}

  check(program: Program): CheckedProgram {
    this.collectTypes(program);
    const lets = program.decls.filter((d): d is Extract<typeof d, { tag: "let" }> => d.tag === "let");
    if (lets.length === 0) {
      throw new CompileError("program has no value to evaluate", program.span, this.filename, "type");
    }
    const seen = new Set<string>();
    for (const decl of lets) {
      if (seen.has(decl.name)) {
        throw new CompileError(`duplicate top-level binding '${decl.name}'`, decl.span, this.filename, "type");
      }
      seen.add(decl.name);
    }
    const resultName = seen.has("main") ? "main" : lets[lets.length - 1]!.name;
    const resultSpan = lets.find((d) => d.name === resultName)!.span;
    let expr: Expr = { tag: "var", name: resultName, span: resultSpan };
    for (let i = lets.length - 1; i >= 0; i--) {
      const decl = lets[i]!;
      expr = {
        tag: "let",
        rec: decl.rec,
        name: decl.name,
        ann: decl.ann,
        value: decl.value,
        body: expr,
        span: decl.span,
      };
    }

    const bindings: Binding[] = [];
    this.infer(expr, Env.empty(), bindings, true);
    const rendered = bindings.map((b) => ({
      name: b.name,
      type: this.showType(b.scheme),
      topLevel: b.topLevel,
    }));
    const resultBinding = rendered.filter((b) => b.topLevel && b.name === resultName).at(-1);
    return {
      filename: this.filename,
      expr,
      bindings: rendered,
      resultName,
      result: resultBinding?.type ?? "?",
      ctors: [...this.ctors.entries()].map(([name, info]) => ({ name, arity: info.arity })),
      warnings: this.warnings,
    };
  }

  private collectTypes(program: Program): void {
    const decls = program.decls.filter((d): d is Extract<typeof d, { tag: "type" }> => d.tag === "type");
    for (const decl of decls) {
      if (BUILTIN_ARITY[decl.name] !== undefined) {
        throw new CompileError(`cannot redefine built-in type '${decl.name}'`, decl.span, this.filename, "type");
      }
      if (this.typeArity.has(decl.name)) {
        throw new CompileError(`duplicate type '${decl.name}'`, decl.span, this.filename, "type");
      }
      const params = new Set<string>();
      for (const p of decl.params) {
        if (params.has(p)) {
          throw new CompileError(`duplicate type parameter '${p}'`, decl.span, this.filename, "type");
        }
        params.add(p);
      }
      this.typeArity.set(decl.name, decl.params.length);
      this.variantNames.set(
        decl.name,
        decl.variants.map((variant) => variant.name),
      );
    }
    for (const decl of decls) {
      const paramVars = new Map<string, TVar>();
      for (const p of decl.params) paramVars.set(p, this.genericVar(p));
      const result: Type = {
        kind: "con",
        name: decl.name,
        args: decl.params.map((p) => paramVars.get(p)!),
      };
      for (const variant of decl.variants) {
        if (this.ctors.has(variant.name)) {
          throw new CompileError(
            `duplicate constructor '${variant.name}'`,
            variant.span,
            this.filename,
            "type",
          );
        }
        let scheme: Type = result;
        for (let i = variant.argTypes.length - 1; i >= 0; i--) {
          const arg = this.typeExprToType(variant.argTypes[i]!, paramVars, false);
          scheme = { kind: "fun", arg, ret: scheme };
        }
        this.ctors.set(variant.name, { arity: variant.argTypes.length, scheme });
      }
    }
  }

  private infer(e: Expr, env: Env, bindings: Binding[], topLevel: boolean): Type {
    switch (e.tag) {
      case "int":
        return this.con("Int");
      case "bool":
        return this.con("Bool");
      case "string":
        return this.con("String");
      case "var": {
        const sch = env.get(e.name);
        if (!sch) {
          throw new CompileError(`unbound variable '${e.name}'`, e.span, this.filename, "type");
        }
        return this.instantiate(sch);
      }
      case "ctor": {
        const info = this.ctors.get(e.name);
        if (!info) {
          throw new CompileError(`unknown constructor '${e.name}'`, e.span, this.filename, "type");
        }
        return this.instantiate(info.scheme);
      }
      case "app":
        return this.inferApp(e, env, bindings);
      case "prim":
        return this.inferPrim(e, env, bindings);
      case "fun": {
        const param = this.freshVar(e.param);
        const body = this.infer(e.body, env.extend(e.param, param), bindings, false);
        return { kind: "fun", arg: param, ret: body };
      }
      case "let":
        return this.inferLet(e, env, bindings, topLevel);
      case "if":
        return this.inferIf(e, env, bindings);
      case "match":
        return this.inferMatch(e, env, bindings);
      default: {
        const _never: never = e;
        return _never;
      }
    }
  }

  private inferLet(
    e: Extract<Expr, { tag: "let" }>,
    env: Env,
    bindings: Binding[],
    topLevel: boolean,
  ): Type {
    if (e.rec && e.value.tag !== "fun") {
      throw new CompileError(
        "let rec must bind a function (fun x -> ... or let rec f x = ...)",
        e.span,
        this.filename,
        "type",
      );
    }
    this.currentLevel += 1;
    let rhs: Type;
    if (e.rec) {
      const recVar = this.freshVar(e.name);
      rhs = this.infer(e.value, env.extend(e.name, recVar), bindings, false);
      // The occurs check fires while unifying the recursive assumption with
      // the inferred function type. Point at the body (the recursive use),
      // not at the `let` keyword.
      this.unify(recVar, rhs, innermost(e.value).span);
    } else {
      rhs = this.infer(e.value, env, bindings, false);
    }
    this.currentLevel -= 1;
    const scheme = e.ann ? this.checkAnnotation(rhs, e.ann, e.ann.span) : this.generalize(rhs);
    const recorded: Binding = { name: e.name, scheme, topLevel, span: e.span };
    bindings.push(recorded);
    return this.infer(e.body, env.extend(e.name, scheme), bindings, topLevel);
  }

  private inferApp(e: Extract<Expr, { tag: "app" }>, env: Env, bindings: Binding[]): Type {
    const ft = this.infer(e.fn, env, bindings, false);
    const at = this.infer(e.arg, env, bindings, false);
    const rt = this.freshVar();
    const shownFn = this.showType(ft);
    const shownArg = this.showType(at);
    try {
      this.unify(ft, { kind: "fun", arg: at, ret: rt }, e.span);
    } catch (err) {
      if (isInfinite(err)) throw err;
      throw new CompileError(
        `cannot apply function of type ${shownFn} to argument of type ${shownArg}`,
        e.span,
        this.filename,
        "type",
      );
    }
    return rt;
  }

  private inferPrim(e: Extract<Expr, { tag: "prim" }>, env: Env, bindings: Binding[]): Type {
    const argTypes = e.args.map((arg) => this.infer(arg, env, bindings, false));
    const shown = argTypes.map((t) => this.showType(t));
    try {
      let ty: Type = this.instantiate(primScheme(e.op, () => this.genericVar()));
      for (const arg of argTypes) {
        const rt = this.freshVar();
        this.unify(ty, { kind: "fun", arg, ret: rt }, e.span);
        ty = rt;
      }
      return ty;
    } catch (err) {
      if (isInfinite(err)) throw err;
      const expect = primExpect(e.op);
      throw new CompileError(
        `operator '${e.op}' expects ${expect}, but got ${shown.join(" and ")}`,
        e.span,
        this.filename,
        "type",
      );
    }
  }

  private inferIf(e: Extract<Expr, { tag: "if" }>, env: Env, bindings: Binding[]): Type {
    const ct = this.infer(e.cond, env, bindings, false);
    const shownCond = this.showType(ct);
    try {
      this.unify(ct, this.con("Bool"), e.cond.span);
    } catch (err) {
      if (isInfinite(err)) throw err;
      throw new CompileError(
        `if condition must be Bool, but got ${shownCond}`,
        e.cond.span,
        this.filename,
        "type",
      );
    }
    const tThen = this.infer(e.then, env, bindings, false);
    const tElse = this.infer(e.else, env, bindings, false);
    const shownThen = this.showType(tThen);
    const shownElse = this.showType(tElse);
    try {
      this.unify(tThen, tElse, e.span);
    } catch (err) {
      if (isInfinite(err)) throw err;
      throw new CompileError(
        `if branches have different types: ${shownThen} and ${shownElse}`,
        e.span,
        this.filename,
        "type",
      );
    }
    return tThen;
  }

  private inferMatch(e: Extract<Expr, { tag: "match" }>, env: Env, bindings: Binding[]): Type {
    if (e.arms.length === 0) {
      throw new CompileError("match expression has no arms", e.span, this.filename, "type");
    }
    const scrut = this.infer(e.scrut, env, bindings, false);
    const result = this.freshVar();
    let first = true;
    for (const arm of e.arms) {
      this.checkDuplicatePatVars(arm.pattern, new Set());
      const armEnv = this.inferPat(arm.pattern, scrut, env);
      const armTy = this.infer(arm.body, armEnv, bindings, false);
      if (first) {
        this.unify(result, armTy, arm.span);
        first = false;
        continue;
      }
      const shownArm = this.showType(armTy);
      const shownPrev = this.showType(result);
      try {
        this.unify(result, armTy, arm.span);
      } catch (err) {
        if (isInfinite(err)) throw err;
        throw new CompileError(
          `match arms have different types: ${shownPrev} and ${shownArm}`,
          arm.span,
          this.filename,
          "type",
        );
      }
    }
    this.warnIfNonExhaustive(e.span, scrut, e.arms.map((arm) => arm.pattern));
    return result;
  }

  private warnIfNonExhaustive(span: Span, scrut: Type, pats: Pattern[]): void {
    const hole = missingPattern(this.toEx(scrut), pats, this.variantTable());
    if (!hole) return;
    const { line, col } = span.start;
    this.warnings.push(
      `${this.filename}:${line}:${col}: warning: non-exhaustive pattern match; missing ${hole}`,
    );
  }

  private variantTable(): Map<string, ExVariant[]> {
    if (this.exTable) return this.exTable;
    const table = new Map<string, ExVariant[]>();
    for (const [typeName, names] of this.variantNames) {
      table.set(
        typeName,
        names.map((name) => {
          const peeled = this.peelCtor(name);
          return { name, fields: peeled ? peeled.fields.map((field) => this.toEx(field)) : [] };
        }),
      );
    }
    this.exTable = table;
    return table;
  }

  private peelCtor(name: string): { fields: Type[] } | null {
    const info = this.ctors.get(name);
    if (!info) return null;
    let ty = this.instantiate(info.scheme);
    const fields: Type[] = [];
    for (let i = 0; i < info.arity; i++) {
      const fun = prune(ty);
      if (fun.kind !== "fun") return null;
      fields.push(fun.arg);
      ty = fun.ret;
    }
    return { fields };
  }

  private toEx(t: Type): ExType {
    const p = prune(t);
    if (p.kind !== "con") return { k: "open" };
    if (p.name === "Bool") return { k: "bool" };
    if (this.variantNames.has(p.name)) return { k: "adt", name: p.name };
    return { k: "open" };
  }

  private inferPat(p: import("./ast.js").Pattern, expected: Type, env: Env): Env {
    switch (p.tag) {
      case "pwild":
        return env;
      case "pvar":
        return env.extend(p.name, expected);
      case "pint":
        this.unify(expected, this.con("Int"), p.span);
        return env;
      case "pbool":
        this.unify(expected, this.con("Bool"), p.span);
        return env;
      case "pstring":
        this.unify(expected, this.con("String"), p.span);
        return env;
      case "pctor": {
        const info = this.ctors.get(p.name);
        if (!info) {
          throw new CompileError(`unknown constructor '${p.name}'`, p.span, this.filename, "type");
        }
        if (p.args.length !== info.arity) {
          throw new CompileError(
            `constructor '${p.name}' expects ${info.arity} argument(s) but pattern has ${p.args.length}`,
            p.span,
            this.filename,
            "type",
          );
        }
        let ty = this.instantiate(info.scheme);
        const argTypes: Type[] = [];
        for (let i = 0; i < info.arity; i++) {
          const fun = prune(ty);
          if (fun.kind !== "fun") {
            throw new CompileError(`internal: constructor '${p.name}' is not a function type`, p.span, this.filename, "type");
          }
          argTypes.push(fun.arg);
          ty = fun.ret;
        }
        this.unify(expected, ty, p.span);
        let next = env;
        for (let i = 0; i < p.args.length; i++) next = this.inferPat(p.args[i]!, argTypes[i]!, next);
        return next;
      }
      default: {
        const _never: never = p;
        return _never;
      }
    }
  }

  private checkDuplicatePatVars(p: import("./ast.js").Pattern, seen: Set<string>): void {
    switch (p.tag) {
      case "pvar":
        if (seen.has(p.name)) {
          throw new CompileError(`duplicate pattern variable '${p.name}'`, p.span, this.filename, "type");
        }
        seen.add(p.name);
        return;
      case "pctor":
        for (const arg of p.args) this.checkDuplicatePatVars(arg, seen);
        return;
      case "pwild":
      case "pint":
      case "pbool":
      case "pstring":
        return;
      default: {
        const _never: never = p;
        return _never;
      }
    }
  }

  private checkAnnotation(inferred: Type, ann: TypeExpr, span: Span): Type {
    const bound = new Map<string, TVar>();
    const scheme = this.typeExprToType(ann, bound, true);
    const skolem = this.skolemize(ann);
    const copy = this.deepCopy(inferred);
    const shown = this.showType(inferred);
    try {
      this.unify(copy, skolem, span);
    } catch {
      throw new CompileError(
        `annotation ${formatAnn(ann)} does not match inferred type ${shown}`,
        span,
        this.filename,
        "type",
      );
    }
    return scheme;
  }

  /** Replace annotation variables with rigid 0-arg constructors that cannot be unified together. */
  private skolemize(t: TypeExpr): Type {
    const skolems = new Map<string, Type>();
    const go = (ty: TypeExpr): Type => {
      switch (ty.tag) {
        case "tvar": {
          let s = skolems.get(ty.name);
          if (!s) {
            s = { kind: "con", name: `#${ty.name}`, args: [] };
            skolems.set(ty.name, s);
          }
          return s;
        }
        case "tfun":
          return { kind: "fun", arg: go(ty.arg), ret: go(ty.ret) };
        case "tcon":
          return { kind: "con", name: ty.name, args: ty.args.map(go) };
        default: {
          const _never: never = ty;
          return _never;
        }
      }
    };
    return go(t);
  }

  private typeExprToType(t: TypeExpr, bound: Map<string, TVar>, allowFree: boolean): Type {
    switch (t.tag) {
      case "tvar": {
        const existing = bound.get(t.name);
        if (existing) return existing;
        if (!allowFree) {
          throw new CompileError(`unbound type variable '${t.name}'`, t.span, this.filename, "type");
        }
        const created = this.genericVar(t.name);
        bound.set(t.name, created);
        return created;
      }
      case "tfun":
        return {
          kind: "fun",
          arg: this.typeExprToType(t.arg, bound, allowFree),
          ret: this.typeExprToType(t.ret, bound, allowFree),
        };
      case "tcon": {
        const arity = this.typeArity.get(t.name);
        if (arity === undefined) {
          throw new CompileError(`unknown type '${t.name}'`, t.span, this.filename, "type");
        }
        if (t.args.length !== arity) {
          throw new CompileError(
            `type '${t.name}' expects ${arity} argument(s) but got ${t.args.length}`,
            t.span,
            this.filename,
            "type",
          );
        }
        return { kind: "con", name: t.name, args: t.args.map((a) => this.typeExprToType(a, bound, allowFree)) };
      }
      default: {
        const _never: never = t;
        return _never;
      }
    }
  }

  private freshVar(name?: string): TVar {
    return { kind: "var", id: this.nextId++, level: this.currentLevel, link: null, name };
  }

  private genericVar(name?: string): TVar {
    return { kind: "var", id: this.nextId++, level: GENERIC, link: null, name };
  }

  private con(name: string, args: Type[] = []): TCon {
    return { kind: "con", name, args };
  }

  private instantiate(t: Type): Type {
    return this.copyType(t, (v) => (v.level === GENERIC ? this.freshVar(v.name) : "share"));
  }

  private generalize(t: Type): Type {
    const level = this.currentLevel;
    return this.copyType(t, (v) => {
      if (v.level > level) return { kind: "var", id: this.nextId++, level: GENERIC, link: null, name: v.name };
      return "share";
    });
  }

  private copyType(t: Type, onVar: (v: TVar) => Type | "share"): Type {
    const varMap = new Map<number, Type>();
    const go = (ty: Type): Type => {
      const p = prune(ty);
      if (p.kind === "var") {
        const hit = varMap.get(p.id);
        if (hit) return hit;
        const mapped = onVar(p);
        if (mapped === "share") {
          varMap.set(p.id, p);
          return p;
        }
        varMap.set(p.id, mapped);
        return mapped;
      }
      if (p.kind === "fun") return { kind: "fun", arg: go(p.arg), ret: go(p.ret) };
      return { kind: "con", name: p.name, args: p.args.map(go) };
    };
    return go(t);
  }

  private deepCopy(t: Type): Type {
    const varMap = new Map<number, TVar>();
    const go = (ty: Type): Type => {
      const p = prune(ty);
      if (p.kind === "var") {
        let copy = varMap.get(p.id);
        if (!copy) {
          copy = { kind: "var", id: this.nextId++, level: p.level, link: null, name: p.name };
          varMap.set(p.id, copy);
        }
        return copy;
      }
      if (p.kind === "fun") return { kind: "fun", arg: go(p.arg), ret: go(p.ret) };
      return { kind: "con", name: p.name, args: p.args.map(go) };
    };
    return go(t);
  }

  private unify(a: Type, b: Type, span: Span): void {
    a = prune(a);
    b = prune(b);
    if (a.kind === "var" && b.kind === "var") {
      if (a.id === b.id) return;
      if (a.level === GENERIC || b.level === GENERIC) {
        throw new CompileError("internal: tried to unify a generic type variable", span, this.filename, "type");
      }
      if (a.level < b.level) this.bindVar(b, a, span);
      else this.bindVar(a, b, span);
      return;
    }
    if (a.kind === "var") {
      this.bindVar(a, b, span);
      return;
    }
    if (b.kind === "var") {
      this.bindVar(b, a, span);
      return;
    }
    if (a.kind === "fun" && b.kind === "fun") {
      this.unify(a.arg, b.arg, span);
      this.unify(a.ret, b.ret, span);
      return;
    }
    if (a.kind === "con" && b.kind === "con" && a.name === b.name && a.args.length === b.args.length) {
      for (let i = 0; i < a.args.length; i++) this.unify(a.args[i]!, b.args[i]!, span);
      return;
    }
    throw new CompileError(`cannot unify ${this.showType(a)} with ${this.showType(b)}`, span, this.filename, "type");
  }

  private bindVar(v: TVar, t: Type, span: Span): void {
    if (v.level === GENERIC) {
      throw new CompileError("internal: tried to unify a generic type variable", span, this.filename, "type");
    }
    if (t.kind === "var" && t.id === v.id) return;
    if (this.occurs(v, t)) {
      throw new CompileError(
        `infinite type: a type variable occurs in ${this.showType(t)}`,
        span,
        this.filename,
        "type",
      );
    }
    this.adjustLevel(t, v.level);
    v.link = t;
  }

  private occurs(v: TVar, t: Type): boolean {
    t = prune(t);
    if (t.kind === "var") return t.id === v.id;
    if (t.kind === "fun") return this.occurs(v, t.arg) || this.occurs(v, t.ret);
    return t.args.some((arg) => this.occurs(v, arg));
  }

  private adjustLevel(t: Type, level: number): void {
    t = prune(t);
    if (t.kind === "var") {
      if (t.level !== GENERIC && t.level > level) t.level = level;
      return;
    }
    if (t.kind === "fun") {
      this.adjustLevel(t.arg, level);
      this.adjustLevel(t.ret, level);
      return;
    }
    for (const arg of t.args) this.adjustLevel(arg, level);
  }

  /** Pretty-print a type. Generic variables are universally quantified in order of appearance. */
  private showType(t: Type): string {
    const names = new Map<number, string>();
    const generics: string[] = [];
    const nextName = (id: number, generic: boolean): string => {
      let name = names.get(id);
      if (!name) {
        const i = names.size;
        name = i < 26 ? String.fromCharCode(97 + i) : `a${i - 25}`;
        names.set(id, name);
        if (generic) generics.push(name);
      }
      return name;
    };
    const go = (ty: Type, argPos: boolean): string => {
      const p = prune(ty);
      if (p.kind === "var") return nextName(p.id, p.level === GENERIC);
      if (p.kind === "fun") {
        const text = `${go(p.arg, true)} -> ${go(p.ret, false)}`;
        return argPos ? `(${text})` : text;
      }
      if (p.args.length === 0) return p.name;
      const args = p.args
        .map((arg) => {
          const inner = go(arg, false);
          const ap = prune(arg);
          if (ap.kind === "fun" || (ap.kind === "con" && ap.args.length > 0)) return `(${inner})`;
          return inner;
        })
        .join(" ");
      return `${p.name} ${args}`;
    };
    const text = go(t, false);
    return generics.length === 0 ? text : `∀${generics.join(" ")}. ${text}`;
  }
}

function innermost(e: Expr): Expr {
  let cur = e;
  while (cur.tag === "fun") cur = cur.body;
  return cur;
}

function prune(t: Type): Type {
  if (t.kind === "var" && t.link) {
    const p = prune(t.link);
    t.link = p;
    return p;
  }
  return t;
}

function primScheme(op: string, freshGeneric: () => TVar): Type {
  const int = con0("Int");
  const bool = con0("Bool");
  const str = con0("String");
  const fun = (arg: Type, ret: Type): Type => ({ kind: "fun", arg, ret });
  switch (op) {
    case "+":
    case "-":
    case "*":
    case "/":
      return fun(int, fun(int, int));
    case "neg":
      return fun(int, int);
    case "<":
    case "<=":
    case ">":
    case ">=":
      return fun(int, fun(int, bool));
    case "++":
      return fun(str, fun(str, str));
    case "==":
    case "!=": {
      const a = freshGeneric();
      return fun(a, fun(a, bool));
    }
    default:
      throw new Error(`unknown primitive ${op}`);
  }
}

function primExpect(op: string): string {
  switch (op) {
    case "+":
    case "-":
    case "*":
    case "/":
      return "Int and Int";
    case "neg":
      return "Int";
    case "<":
    case "<=":
    case ">":
    case ">=":
      return "Int and Int";
    case "++":
      return "String and String";
    case "==":
    case "!=":
      return "two arguments of the same type";
    default:
      return "different arguments";
  }
}

function con0(name: string): TCon {
  return { kind: "con", name, args: [] };
}

function isInfinite(err: unknown): boolean {
  return err instanceof CompileError && err.message.startsWith("infinite type");
}

function formatAnn(t: TypeExpr): string {
  switch (t.tag) {
    case "tvar":
      return t.name;
    case "tcon":
      return t.args.length === 0 ? t.name : `${t.name} ${t.args.map(formatAnn).join(" ")}`;
    case "tfun": {
      const left = t.arg.tag === "tfun" ? `(${formatAnn(t.arg)})` : formatAnn(t.arg);
      return `${left} -> ${formatAnn(t.ret)}`;
    }
    default: {
      const _never: never = t;
      return _never;
    }
  }
}
