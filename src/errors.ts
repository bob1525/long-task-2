/**
 * Source positions and the single error type shared by every compiler phase.
 *
 * Positions are 1-based line/column so messages match what an editor shows.
 * `offset` is 0-based and is only used internally by the lexer.
 */

export interface Pos {
  offset: number;
  line: number;
  col: number;
}

export interface Span {
  start: Pos;
  end: Pos;
}

export type Phase = "lex" | "parse" | "type" | "compile";

export class CompileError extends Error {
  readonly span?: Span;
  readonly filename: string;
  readonly phase: Phase;

  constructor(message: string, span: Span | undefined, filename: string, phase: Phase) {
    super(message);
    this.name = "CompileError";
    this.span = span;
    this.filename = filename;
    this.phase = phase;
  }
}

export function mergeSpan(a: Span, b: Span): Span {
  return { start: a.start, end: b.end };
}

/** `file:line:col: <phase> error: message` plus the source line and a caret. */
export function formatError(err: CompileError, source?: string): string {
  const phaseLabel =
    err.phase === "lex"
      ? "lex error"
      : err.phase === "parse"
        ? "parse error"
        : err.phase === "type"
          ? "type error"
          : "error";
  if (!err.span) {
    return `${err.filename}: ${phaseLabel}: ${err.message}`;
  }
  const { line, col } = err.span.start;
  const head = `${err.filename}:${line}:${col}: ${phaseLabel}: ${err.message}`;
  if (source === undefined) return head;
  const text = source.split(/\n/)[line - 1] ?? "";
  const caret = `${" ".repeat(Math.max(0, col - 1))}^`;
  return `${head}\n${text}\n${caret}`;
}
