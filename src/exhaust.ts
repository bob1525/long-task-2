/**
 * Exhaustiveness of pattern matches.
 *
 * Bool and algebraic datatypes are finite, so a missing constructor (including
 * one nested under another constructor) can be named. Int, String, functions,
 * and type variables are open: only a wildcard or a variable covers them.
 * The witness is a pattern that the arms do not match. Overlapping arms are
 * allowed; the first match still wins at run time.
 */

import type { Pattern } from "./ast.js";
import type { Span } from "./errors.js";

export type ExType = { k: "open" } | { k: "bool" } | { k: "adt"; name: string };

export interface ExVariant {
  name: string;
  fields: ExType[];
}

const DUMMY: Span = {
  start: { offset: 0, line: 1, col: 1 },
  end: { offset: 0, line: 1, col: 1 },
};
const WILD: Pattern = { tag: "pwild", span: DUMMY };

function irrefutable(p: Pattern): boolean {
  return p.tag === "pwild" || p.tag === "pvar";
}

function formatCtor(name: string, fields: string[]): string {
  if (fields.length === 0) return name;
  const shown = fields.map((field) => (field.includes(" ") ? `(${field})` : field));
  return `${name} ${shown.join(" ")}`;
}

/** A pattern the arms miss, or null when the match covers `type`. */
export function missingPattern(
  type: ExType,
  pats: Pattern[],
  variants: Map<string, ExVariant[]>,
): string | null {
  if (pats.some(irrefutable)) return null;
  if (type.k === "open") return "_";
  if (type.k === "bool") {
    if (!pats.some((p) => p.tag === "pbool" && p.value)) return "true";
    if (!pats.some((p) => p.tag === "pbool" && !p.value)) return "false";
    return null;
  }
  const ctors = variants.get(type.name);
  if (!ctors) return null;
  for (const ctor of ctors) {
    const rows: Pattern[][] = [];
    for (const pat of pats) {
      if (pat.tag === "pctor" && pat.name === ctor.name && pat.args.length === ctor.fields.length) {
        rows.push(pat.args);
      }
    }
    const hole = missingProduct(ctor.fields, rows, variants, 0);
    if (hole) return formatCtor(ctor.name, hole);
  }
  return null;
}

function missingProduct(
  types: ExType[],
  rows: Pattern[][],
  variants: Map<string, ExVariant[]>,
  depth: number,
): string[] | null {
  if (depth > 32) return types.map(() => "_");
  if (types.length === 0) return rows.length === 0 ? [] : null;
  if (rows.some((row) => row.every(irrefutable))) return null;
  const head = types[0]!;
  if (head.k === "bool" || head.k === "adt") {
    const cases: { label: string; fields: ExType[]; take: (p: Pattern) => Pattern[] | null }[] =
      head.k === "bool"
        ? [
            {
              label: "true",
              fields: [],
              take: (p) => (p.tag === "pbool" && p.value ? [] : null),
            },
            {
              label: "false",
              fields: [],
              take: (p) => (p.tag === "pbool" && !p.value ? [] : null),
            },
          ]
        : (variants.get(head.name) ?? []).map((ctor) => ({
            label: ctor.name,
            fields: ctor.fields,
            take: (p: Pattern) =>
              p.tag === "pctor" && p.name === ctor.name && p.args.length === ctor.fields.length ? p.args : null,
          }));
    if (head.k === "adt" && cases.length === 0) return null;
    for (const ctor of cases) {
      const sub: Pattern[][] = [];
      for (const row of rows) {
        const cell = row[0]!;
        if (irrefutable(cell)) sub.push([...ctor.fields.map(() => WILD), ...row.slice(1)]);
        else {
          const taken = ctor.take(cell);
          if (taken) sub.push([...taken, ...row.slice(1)]);
        }
      }
      const hole = missingProduct([...ctor.fields, ...types.slice(1)], sub, variants, depth + 1);
      if (hole) {
        const rendered = formatCtor(ctor.label, hole.slice(0, ctor.fields.length));
        return [rendered, ...hole.slice(ctor.fields.length)];
      }
    }
    return null;
  }
  const wide = rows.filter((row) => irrefutable(row[0]!));
  if (wide.length === 0) return ["_", ...types.slice(1).map(() => "_")];
  const rest = missingProduct(
    types.slice(1),
    wide.map((row) => row.slice(1)),
    variants,
    depth + 1,
  );
  if (!rest) return null;
  return ["_", ...rest];
}
