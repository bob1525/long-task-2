/**
 * Hand-written lexer.
 *
 * Design choices:
 * - Keywords are reserved, so a later parser can be a straight recursive descent
 *   without a feedback loop from the symbol table.
 * - Constructors and type names are any identifier that starts with an uppercase
 *   letter. Variables and type variables start with a lowercase letter or `_`
 *   (except the lone `_`, which is the wildcard pattern).
 * - Multi-character operators are matched longest-first (`==` before `=`).
 * - Comments (`//` and non-nested block comments) and whitespace carry no tokens,
 *   but every token keeps the source span of its lexeme so parse and type errors
 *   can point at the offending text.
 * - Integers are decimal and must fit in a JS safe integer. Fun has no floats;
 *   unary minus is a parser concern, so `-1` is minus followed by `1`.
 */

import { CompileError, type Pos, type Span } from "./errors.js";

export type TokenKind =
  | "let"
  | "rec"
  | "in"
  | "if"
  | "then"
  | "else"
  | "fun"
  | "match"
  | "with"
  | "type"
  | "true"
  | "false"
  | "ident"
  | "ctor"
  | "underscore"
  | "int"
  | "string"
  | "lparen"
  | "rparen"
  | "colon"
  | "eq"
  | "arrow"
  | "bar"
  | "plus"
  | "minus"
  | "star"
  | "slash"
  | "plusplus"
  | "eqeq"
  | "neq"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "andand"
  | "oror"
  | "eof";

export interface Token {
  kind: TokenKind;
  /** Identifier text, decoded string contents, or the raw lexeme. */
  value: string;
  span: Span;
}

const KEYWORDS: Record<string, TokenKind> = {
  let: "let",
  rec: "rec",
  in: "in",
  if: "if",
  then: "then",
  else: "else",
  fun: "fun",
  match: "match",
  with: "with",
  type: "type",
  true: "true",
  false: "false",
};

export function lex(source: string, filename = "<input>"): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  let line = 1;
  let col = 1;

  const here = (): Pos => ({ offset, line, col });

  const bump = (): string => {
    const ch = source[offset] ?? "";
    offset += 1;
    if (ch === "\n") {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
    return ch;
  };

  const peek = (k = 0): string => source[offset + k] ?? "";

  const fail = (message: string, start: Pos): never => {
    throw new CompileError(message, { start, end: here() }, filename, "lex");
  };

  const push = (kind: TokenKind, value: string, start: Pos): void => {
    tokens.push({ kind, value, span: { start, end: here() } });
  };

  while (offset < source.length) {
    const ch = peek();

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      bump();
      continue;
    }

    if (ch === "/" && peek(1) === "/") {
      while (offset < source.length && peek() !== "\n") bump();
      continue;
    }

    if (ch === "/" && peek(1) === "*") {
      const start = here();
      bump();
      bump();
      let closed = false;
      while (offset < source.length) {
        if (peek() === "*" && peek(1) === "/") {
          bump();
          bump();
          closed = true;
          break;
        }
        bump();
      }
      if (!closed) fail("unterminated block comment", start);
      continue;
    }

    const start = here();

    if (ch === '"') {
      bump();
      let value = "";
      let closed = false;
      while (offset < source.length) {
        const c = peek();
        if (c === "\n") break;
        if (c === '"') {
          bump();
          closed = true;
          break;
        }
        if (c === "\\") {
          bump();
          const esc = peek();
          if (esc === "") fail("unterminated string", start);
          bump();
          switch (esc) {
            case "n":
              value += "\n";
              break;
            case "t":
              value += "\t";
              break;
            case "r":
              value += "\r";
              break;
            case "\\":
              value += "\\";
              break;
            case '"':
              value += '"';
              break;
            case "0":
              value += "\0";
              break;
            default:
              fail(`unknown string escape '\\${esc}'`, start);
          }
          continue;
        }
        value += bump();
      }
      if (!closed) fail("unterminated string", start);
      push("string", value, start);
      continue;
    }

    if (isDigit(ch)) {
      let lexeme = "";
      while (isDigit(peek())) lexeme += bump();
      const n = Number(lexeme);
      // Number() silently rounds values past 2^53. Reject those instead of
      // compiling a different integer than the one written in the source.
      if (!Number.isSafeInteger(n) || BigInt(lexeme) !== BigInt(n)) {
        fail(`integer ${lexeme} is out of range`, start);
      }
      push("int", lexeme, start);
      continue;
    }

    if (isIdentStart(ch)) {
      let lexeme = "";
      while (isIdentCont(peek())) lexeme += bump();
      if (lexeme === "_") {
        push("underscore", lexeme, start);
        continue;
      }
      const kw = KEYWORDS[lexeme];
      if (kw) {
        push(kw, lexeme, start);
        continue;
      }
      if (lexeme[0]! >= "A" && lexeme[0]! <= "Z") push("ctor", lexeme, start);
      else push("ident", lexeme, start);
      continue;
    }

    const two = ch + peek(1);
    if (two === "->") {
      bump();
      bump();
      push("arrow", two, start);
      continue;
    }
    if (two === "==") {
      bump();
      bump();
      push("eqeq", two, start);
      continue;
    }
    if (two === "!=") {
      bump();
      bump();
      push("neq", two, start);
      continue;
    }
    if (two === "<=") {
      bump();
      bump();
      push("le", two, start);
      continue;
    }
    if (two === ">=") {
      bump();
      bump();
      push("ge", two, start);
      continue;
    }
    if (two === "&&") {
      bump();
      bump();
      push("andand", two, start);
      continue;
    }
    if (two === "||") {
      bump();
      bump();
      push("oror", two, start);
      continue;
    }
    if (two === "++") {
      bump();
      bump();
      push("plusplus", two, start);
      continue;
    }

    bump();
    switch (ch) {
      case "(":
        push("lparen", ch, start);
        break;
      case ")":
        push("rparen", ch, start);
        break;
      case ":":
        push("colon", ch, start);
        break;
      case "=":
        push("eq", ch, start);
        break;
      case "|":
        push("bar", ch, start);
        break;
      case "+":
        push("plus", ch, start);
        break;
      case "-":
        push("minus", ch, start);
        break;
      case "*":
        push("star", ch, start);
        break;
      case "/":
        push("slash", ch, start);
        break;
      case "<":
        push("lt", ch, start);
        break;
      case ">":
        push("gt", ch, start);
        break;
      default:
        fail(`unexpected character '${ch}'`, start);
    }
  }

  push("eof", "", here());
  return tokens;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_";
}

function isIdentCont(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}
