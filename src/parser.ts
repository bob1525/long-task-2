/**
 * Recursive-descent parser with a Pratt-style precedence climb for infix operators.
 *
 * The grammar is expression-oriented. Top-level `let` / `type` declarations are
 * the only "statements"; everything else is an expression, so `if`, `let`, and
 * `match` all produce values.
 *
 * Precedence, tightest last among the infix operators:
 *   ||  &&  == !=  < <= > >=  + - ++  * /
 * Application is tighter than every infix operator and is left-associative.
 * Unary minus is tighter than infix operators and looser than application,
 * so `-f x` is `-(f x)`.
 *
 * Nested `match` is greedy about `|` arms. A match that appears in an arm of
 * another match must be parenthesized; otherwise the inner match would consume
 * the outer arms. This is the same parenthesis rule OCaml uses.
 *
 * Constructor patterns are space-separated (`Cons h t`). A nested constructor
 * pattern with arguments must be parenthesized: `Cons (Cons h t) rest`.
 */

import {
  formatPattern,
  type Decl,
  type Expr,
  type MatchArm,
  type Pattern,
  type PrimOp,
  type Program,
  type TypeExpr,
  type Variant,
} from "./ast.js";
import { CompileError, mergeSpan, type Span } from "./errors.js";
import { lex, type Token, type TokenKind } from "./lexer.js";

const INFIX: Partial<Record<TokenKind, { prec: number; op: PrimOp | "&&" | "||" }>> = {
  oror: { prec: 1, op: "||" },
  andand: { prec: 2, op: "&&" },
  eqeq: { prec: 3, op: "==" },
  neq: { prec: 3, op: "!=" },
  lt: { prec: 4, op: "<" },
  gt: { prec: 4, op: ">" },
  le: { prec: 4, op: "<=" },
  ge: { prec: 4, op: ">=" },
  plus: { prec: 5, op: "+" },
  minus: { prec: 5, op: "-" },
  plusplus: { prec: 5, op: "++" },
  star: { prec: 6, op: "*" },
  slash: { prec: 6, op: "/" },
};

export function parse(source: string, filename = "<input>"): Program {
  const tokens = lex(source, filename);
  return new Parser(tokens, filename).parseProgram();
}

class Parser {
  private i = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly filename: string,
  ) {}

  parseProgram(): Program {
    const start = this.at().span.start;
    const decls: Decl[] = [];
    while (!this.check("eof")) {
      if (this.check("type")) decls.push(this.parseTypeDecl());
      else if (this.check("let")) decls.push(this.parseLetDecl());
      else {
        throw this.fail(
          `expected a top-level 'type' or 'let' declaration, found ${this.describe()}`,
          this.at().span,
        );
      }
    }
    const end = this.at().span.end;
    return { decls, span: { start, end } };
  }

  private parseTypeDecl(): Decl {
    const startTok = this.expect("type");
    const nameTok = this.expect("ctor", "type name");
    const params: string[] = [];
    while (this.check("ident")) params.push(this.expect("ident").value);
    this.expect("eq");
    if (this.check("bar")) this.advance();
    const variants: Variant[] = [];
    if (this.check("eof") || this.check("let") || this.check("type")) {
      throw this.fail("expected a constructor after '='", this.at().span);
    }
    variants.push(this.parseVariant());
    while (this.eat("bar")) {
      if (this.check("eof") || this.check("let") || this.check("type")) {
        throw this.fail("expected a constructor after '|'", this.at().span);
      }
      variants.push(this.parseVariant());
    }
    return {
      tag: "type",
      name: nameTok.value,
      params,
      variants,
      span: mergeSpan(startTok.span, variants[variants.length - 1]!.span),
    };
  }

  private parseVariant(): Variant {
    const nameTok = this.expect("ctor", "constructor name");
    const argTypes: TypeExpr[] = [];
    while (this.isTypeAtomStart()) argTypes.push(this.parseTypeAtom());
    const span =
      argTypes.length === 0
        ? nameTok.span
        : mergeSpan(nameTok.span, argTypes[argTypes.length - 1]!.span);
    return { name: nameTok.value, argTypes, span };
  }

  private parseLetDecl(): Decl {
    const parsed = this.parseLet(false);
    return {
      tag: "let",
      rec: parsed.rec,
      name: parsed.name,
      ann: parsed.ann,
      value: parsed.value,
      span: parsed.span,
    };
  }

  /**
   * `let rec? name params? (: type)? = expr (in expr)?`
   * Parameters desugar immediately into nested single-argument funs so the
   * rest of the compiler never sees multi-argument lambdas.
   */
  private parseLet(inExpr: boolean): Extract<Expr, { tag: "let" }> {
    const startTok = this.expect("let");
    const rec = this.eat("rec");
    const nameTok = this.expect("ident", "binding name");
    const params: { name: string; span: Span }[] = [];
    while (this.check("ident")) {
      const tok = this.expect("ident");
      params.push({ name: tok.value, span: tok.span });
    }
    let ann: TypeExpr | null = null;
    if (this.eat("colon")) ann = this.parseType();
    this.expect("eq");
    let value = this.parseExpr();
    for (let p = params.length - 1; p >= 0; p--) {
      const param = params[p]!;
      value = {
        tag: "fun",
        param: param.name,
        body: value,
        span: mergeSpan(param.span, value.span),
      };
    }
    let body: Expr;
    let endSpan: Span;
    if (inExpr) {
      this.expect("in");
      body = this.parseExpr();
      endSpan = body.span;
    } else {
      // A top-level declaration has no body. The dummy is replaced when the
      // program is lowered to a single expression; it is never type-checked
      // on its own. Using the value keeps spans honest if it leaks.
      body = value;
      endSpan = value.span;
    }
    if (rec && !isFun(value)) {
      throw this.fail("let rec must bind a function (fun x -> ... or let rec f x = ...)", startTok.span);
    }
    return {
      tag: "let",
      rec,
      name: nameTok.value,
      ann,
      value,
      body,
      span: { start: startTok.span.start, end: endSpan.end },
    };
  }

  private parseExpr(): Expr {
    return this.parseBin(0);
  }

  private parseBin(minPrec: number): Expr {
    let left = this.parseUnary();
    for (;;) {
      const spec = INFIX[this.at().kind];
      if (!spec || spec.prec < minPrec) break;
      const opTok = this.advance();
      const right = this.parseBin(spec.prec + 1);
      const span = mergeSpan(left.span, right.span);
      if (spec.op === "&&") {
        left = {
          tag: "if",
          cond: left,
          then: right,
          else: { tag: "bool", value: false, span: opTok.span },
          span,
        };
      } else if (spec.op === "||") {
        left = {
          tag: "if",
          cond: left,
          then: { tag: "bool", value: true, span: opTok.span },
          else: right,
          span,
        };
      } else {
        left = { tag: "prim", op: spec.op, args: [left, right], span };
      }
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.check("minus")) {
      const tok = this.advance();
      const expr = this.parseUnary();
      return {
        tag: "prim",
        op: "neg",
        args: [expr],
        span: { start: tok.span.start, end: expr.span.end },
      };
    }
    return this.parseApp();
  }

  private parseApp(): Expr {
    let expr = this.parseAtom();
    while (this.startsAtom(this.at())) {
      const arg = this.parseAtom();
      expr = { tag: "app", fn: expr, arg, span: mergeSpan(expr.span, arg.span) };
    }
    return expr;
  }

  private parseAtom(): Expr {
    const tok = this.at();
    switch (tok.kind) {
      case "int": {
        this.advance();
        return { tag: "int", value: Number(tok.value), span: tok.span };
      }
      case "string": {
        this.advance();
        return { tag: "string", value: tok.value, span: tok.span };
      }
      case "true":
      case "false": {
        this.advance();
        return { tag: "bool", value: tok.kind === "true", span: tok.span };
      }
      case "ident": {
        this.advance();
        return { tag: "var", name: tok.value, span: tok.span };
      }
      case "ctor": {
        this.advance();
        return { tag: "ctor", name: tok.value, span: tok.span };
      }
      case "lparen": {
        this.advance();
        const expr = this.parseExpr();
        this.expect("rparen");
        return expr;
      }
      case "if":
        return this.parseIf();
      case "let":
        return this.parseLet(true);
      case "fun":
        return this.parseFun();
      case "match":
        return this.parseMatch();
      default:
        throw this.fail(`expected an expression, found ${this.describe()}`, tok.span);
    }
  }

  private parseIf(): Expr {
    const startTok = this.expect("if");
    const cond = this.parseExpr();
    this.expect("then");
    const then = this.parseExpr();
    this.expect("else");
    const elseE = this.parseExpr();
    return {
      tag: "if",
      cond,
      then,
      else: elseE,
      span: { start: startTok.span.start, end: elseE.span.end },
    };
  }

  private parseFun(): Expr {
    const startTok = this.expect("fun");
    const params: { name: string; span: Span }[] = [];
    if (!this.check("ident")) {
      throw this.fail("expected a function parameter after 'fun'", this.at().span);
    }
    while (this.check("ident")) {
      const tok = this.expect("ident");
      params.push({ name: tok.value, span: tok.span });
    }
    this.expect("arrow");
    let body = this.parseExpr();
    for (let p = params.length - 1; p >= 0; p--) {
      const param = params[p]!;
      body = {
        tag: "fun",
        param: param.name,
        body,
        span: { start: p === 0 ? startTok.span.start : param.span.start, end: body.span.end },
      };
    }
    // The outermost span should start at `fun` even after wrapping.
    if (body.tag === "fun") {
      body = { ...body, span: { start: startTok.span.start, end: body.span.end } };
    }
    return body;
  }

  private parseMatch(): Expr {
    const startTok = this.expect("match");
    const scrut = this.parseExpr();
    this.expect("with");
    if (this.check("bar")) this.advance();
    const arms: MatchArm[] = [];
    arms.push(this.parseArm());
    while (this.eat("bar")) arms.push(this.parseArm());
    return {
      tag: "match",
      scrut,
      arms,
      span: { start: startTok.span.start, end: arms[arms.length - 1]!.span.end },
    };
  }

  private parseArm(): MatchArm {
    const pattern = this.parsePattern();
    this.expect("arrow");
    const body = this.parseExpr();
    return { pattern, body, span: mergeSpan(pattern.span, body.span) };
  }

  private parsePattern(): Pattern {
    if (this.check("ctor")) {
      const nameTok = this.advance();
      const args: Pattern[] = [];
      while (this.startsPatAtom(this.at())) args.push(this.parsePatAtom());
      const span =
        args.length === 0 ? nameTok.span : mergeSpan(nameTok.span, args[args.length - 1]!.span);
      return { tag: "pctor", name: nameTok.value, args, span };
    }
    return this.parsePatAtom();
  }

  private parsePatAtom(): Pattern {
    const tok = this.at();
    switch (tok.kind) {
      case "underscore":
        this.advance();
        return { tag: "pwild", span: tok.span };
      case "ident":
        this.advance();
        return { tag: "pvar", name: tok.value, span: tok.span };
      case "int":
        this.advance();
        return { tag: "pint", value: Number(tok.value), span: tok.span };
      case "minus": {
        const neg = this.advance();
        const num = this.expect("int", "integer");
        const value = -Number(num.value);
        return { tag: "pint", value, span: mergeSpan(neg.span, num.span) };
      }
      case "true":
      case "false":
        this.advance();
        return { tag: "pbool", value: tok.kind === "true", span: tok.span };
      case "string":
        this.advance();
        return { tag: "pstring", value: tok.value, span: tok.span };
      case "ctor":
        this.advance();
        return { tag: "pctor", name: tok.value, args: [], span: tok.span };
      case "lparen": {
        this.advance();
        const pat = this.parsePattern();
        this.expect("rparen");
        return pat;
      }
      default:
        throw this.fail(`expected a pattern, found ${this.describe()}`, tok.span);
    }
  }

  private parseType(): TypeExpr {
    const left = this.parseTypeApp();
    if (this.eat("arrow")) {
      const right = this.parseType();
      return { tag: "tfun", arg: left, ret: right, span: mergeSpan(left.span, right.span) };
    }
    return left;
  }

  private parseTypeApp(): TypeExpr {
    if (this.check("ctor")) {
      const nameTok = this.advance();
      const args: TypeExpr[] = [];
      while (this.isTypeAtomStart()) args.push(this.parseTypeAtom());
      const span =
        args.length === 0 ? nameTok.span : mergeSpan(nameTok.span, args[args.length - 1]!.span);
      return { tag: "tcon", name: nameTok.value, args, span };
    }
    return this.parseTypeAtom();
  }

  private parseTypeAtom(): TypeExpr {
    const tok = this.at();
    if (tok.kind === "ident") {
      this.advance();
      return { tag: "tvar", name: tok.value, span: tok.span };
    }
    if (tok.kind === "ctor") {
      this.advance();
      return { tag: "tcon", name: tok.value, args: [], span: tok.span };
    }
    if (tok.kind === "lparen") {
      this.advance();
      const t = this.parseType();
      this.expect("rparen");
      return t;
    }
    throw this.fail(`expected a type, found ${this.describe()}`, tok.span);
  }

  private isTypeAtomStart(): boolean {
    const k = this.at().kind;
    return k === "ident" || k === "ctor" || k === "lparen";
  }

  /**
   * Arguments in a juxtaposition application. `if` / `let` / `fun` / `match`
   * are excluded so that a following top-level declaration is not swallowed
   * as an argument (`let x = 1` newline `let y = 2`). Pass those forms in
   * parentheses: `f (fun x -> x)`.
   */
  private startsAtom(tok: Token): boolean {
    switch (tok.kind) {
      case "int":
      case "string":
      case "true":
      case "false":
      case "ident":
      case "ctor":
      case "lparen":
        return true;
      default:
        return false;
    }
  }

  private startsPatAtom(tok: Token): boolean {
    switch (tok.kind) {
      case "underscore":
      case "ident":
      case "int":
      case "minus":
      case "true":
      case "false":
      case "string":
      case "ctor":
      case "lparen":
        return true;
      default:
        return false;
    }
  }

  private at(): Token {
    return this.tokens[this.i] ?? this.tokens[this.tokens.length - 1]!;
  }

  private check(kind: TokenKind): boolean {
    return this.at().kind === kind;
  }

  private advance(): Token {
    const tok = this.at();
    if (tok.kind !== "eof") this.i += 1;
    return tok;
  }

  private eat(kind: TokenKind): boolean {
    if (this.check(kind)) {
      this.advance();
      return true;
    }
    return false;
  }

  private expect(kind: TokenKind, what?: string): Token {
    if (this.check(kind)) return this.advance();
    const name = what ?? kind;
    throw this.fail(`expected ${name}, found ${this.describe()}`, this.at().span);
  }

  private describe(): string {
    const tok = this.at();
    if (tok.kind === "eof") return "end of file";
    if (tok.kind === "string") return `string ${JSON.stringify(tok.value)}`;
    if (tok.kind === "int" || tok.kind === "ident" || tok.kind === "ctor") return `'${tok.value}'`;
    return `'${tok.value || tok.kind}'`;
  }

  private fail(message: string, span: Span): CompileError {
    return new CompileError(message, span, this.filename, "parse");
  }
}

function isFun(e: Expr): boolean {
  return e.tag === "fun";
}

/** Used by tests that want a readable pattern dump without importing formatters ad hoc. */
export function patternText(p: Pattern): string {
  return formatPattern(p);
}
