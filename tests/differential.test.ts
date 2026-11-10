/**
 * Semantic equivalence across optimization settings.
 *
 * Each program is compiled with the real flag parser: `--opt none`, each
 * pass alone (`inline`, `const-fold`, `dce`, `tco`), and `--opt all`.
 * Status, stdout, and the runtime-error line must match. Programs here all
 * terminate with tail calls disabled, so a deep stack overflow is not a
 * difference this suite is allowed to ignore.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { compileSource, executeJs, flagsFromArgs } from "../src/compile.js";

const CONFIGS: Array<[string, string[]]> = [
  ["none", ["--opt", "none"]],
  ["inline", ["--opt", "inline"]],
  ["const-fold", ["--opt", "const-fold"]],
  ["dce", ["--opt", "dce"]],
  ["tco", ["--opt", "tco"]],
  ["all", ["--opt", "all"]],
];

interface Program {
  name: string;
  src: string;
}

function outcome(src: string, args: string[]): string {
  const js = compileSource(src, "t.fun", flagsFromArgs(args)).js;
  const result = executeJs(js, 2000);
  if (result.timedOut) return "TIMEOUT";
  const err = result.stderr.trim().split("\n")[0] ?? "";
  return `${result.status}|${result.stdout.trim()}|${err}`;
}

function agree(program: Program): void {
  const results = CONFIGS.map(([name, args]) => [name, outcome(program.src, args)] as const);
  const expected = results[0]![1];
  assert.notEqual(expected, "TIMEOUT", program.name);
  for (const [name, value] of results) {
    assert.equal(value, expected, `${program.name} under --opt ${name}\n${program.src}`);
  }
}

const HAND: Program[] = [
  { name: "arith", src: "let main = 1 + 2 * 3 - 4" },
  { name: "neg-div", src: "let main = -5 / 2" },
  { name: "assoc", src: "let main = 8 - 3 - 1" },
  { name: "cmp", src: "let main = 3 >= 3 && 4 > 2 && 1 <= 1 && 0 < 1" },
  { name: "string", src: 'let main = ("ab" ++ "c") == "abc"' },
  { name: "concat", src: 'let main = "a" ++ "b" ++ "c"' },
  { name: "string-match", src: 'let main = match "ab" with | "a" -> 1 | "ab" -> 2 | _ -> 3' },
  { name: "escape", src: 'let main = match "a\\nb" with | "a\\nb" -> 1 | _ -> 0' },
  { name: "closure-shadow", src: "let main = let x = 1 in let f = fun y -> x + y in let x = 10 in f 2" },
  { name: "closure-uses-inner", src: "let main = let x = 1 in let f = fun y -> x + y in let x = 10 in f x" },
  { name: "shadow-in-body", src: "let main = let x = 1 in let f = fun y -> let x = 10 in x + y in f 2" },
  { name: "shadow-param", src: "let main = let x = 1 in let f = fun x -> x + 1 in f 2" },
  { name: "shadow-let", src: "let main = let x = 1 in let y = let x = 2 in x in x + y" },
  { name: "partial-twice", src: "let add x y = x + y\nlet add1 = add 1\nlet main = add1 10 + add1 20" },
  { name: "curried-twice", src: "let add x y = x + y\nlet main = add 1 2 + add 3 4" },
  { name: "compose", src: "let compose f g x = f (g x)\nlet main = compose (fun x -> x + 1) (fun x -> x * 2) 10" },
  { name: "higher", src: "let apply f x = f x\nlet main = apply (fun x -> x * x) 5" },
  { name: "if-fun", src: "let main = (if true then fun x -> x + 1 else fun x -> x) 4" },
  { name: "let-in-fun", src: "let f x = let y = x + 1 in y * 2\nlet main = f 3" },
  { name: "id-poly", src: "let id x = x\nlet main = if id true then id 1 else id 2" },
  { name: "rec-poly", src: "let rec id x = x\nlet main = if id true then id 1 else id 2" },
  { name: "rec-mono-body", src: "let rec id x = if true then x else id 1\nlet main = id 4" },
  { name: "dead-div", src: "let main = if false then 1 / 0 else 2" },
  { name: "live-div", src: "let main = if true then 1 else 1 / 0" },
  { name: "div-product", src: "let main = 10 / (0 * 5)" },
  { name: "div-sub", src: "let main = 10 / (1 - 1)" },
  { name: "div-var", src: "let main = let z = 0 in 10 / z" },
  { name: "div-propagated", src: "let z = 1 + -1\nlet main = 10 / z" },
  { name: "div-direct", src: "let main = 10 / 0" },
  { name: "unused-div", src: "let unused = 1 / 0\nlet main = 2" },
  { name: "div-in-unused-fun", src: "let f x = 1 / 0\nlet main = 2" },
  { name: "div-called", src: "let f x = 1 / 0\nlet main = f 1" },
  { name: "div-curried", src: "let div x y = x / y\nlet main = div 10 0" },
  { name: "dup-arg", src: "let f x = x + x\nlet main = f (1 + 2)" },
  { name: "dup-throw", src: "let f x = x + x\nlet main = f (1 / 0)" },
  { name: "dead-match", src: "let main = if false then (match true with | false -> 1) else 4" },
  { name: "unused-match", src: "let unused = match true with | false -> 1\nlet main = 2" },
  { name: "miss-int", src: "let unused = match 1 with | 2 -> 3\nlet main = 4" },
  { name: "overlap-int", src: "let main = match 1 with | 1 -> 10 | 1 -> 20 | _ -> 30" },
  { name: "wild-middle", src: "type T = A | B | C\nlet main = match B with | A -> 1 | _ -> 2 | C -> 3" },
  { name: "overlap-ctor", src: "type T = A | B\nlet main = match A with | A -> 1 | A -> 2 | B -> 3" },
  { name: "nested-cons", src: "type List a = Nil | Cons a (List a)\nlet main = match Cons 1 (Cons 2 Nil) with | Cons h (Cons h2 Nil) -> h + h2 | _ -> 0" },
  { name: "nested-miss", src: "type List a = Nil | Cons a (List a)\nlet main = match Cons 1 (Cons 2 Nil) with | Nil -> 0 | Cons _ Nil -> 1" },
  { name: "nested-wild", src: "type List a = Nil | Cons a (List a)\nlet main = match Cons 1 (Cons 2 (Cons 3 Nil)) with | Cons _ (Cons x _) -> x | _ -> 0" },
  { name: "deep-pat", src: "type List a = Nil | Cons a (List a)\nlet main = match Cons (Cons 1 Nil) Nil with | Cons (Cons h _) _ -> h | _ -> 0" },
  { name: "bool-matrix", src: "type T = C Bool Bool\nlet main = match C false false with | C true _ -> 1 | C false true -> 2 | C false false -> 3" },
  { name: "option", src: "type Opt a = None | Some a\nlet main = match Some 3 with | None -> 0 | Some x -> x" },
  { name: "get-none", src: "type Opt a = None | Some a\nlet get o = match o with | Some x -> x\nlet main = get None" },
  { name: "pair", src: "type Pair a b = Pair a b\nlet fst p = match p with | Pair a _ -> a\nlet main = fst (Pair 1 true)" },
  { name: "partial-ctor", src: "type P = P Int Int\nlet mk = P 1\nlet main = mk 2" },
  { name: "ctor-eq", src: "type P = P Int Int\nlet main = P 1 2 == P 1 2" },
  { name: "ctor-neq", src: "type P = P Int Int\nlet main = P 1 2 == P 2 1" },
  { name: "ctor-fun", src: "type Box = Mk (Int -> Int)\nlet main = match Mk (fun x -> x + 1) with | Mk f -> f 3" },
  { name: "list-map", src: "type List a = Nil | Cons a (List a)\nlet rec map f xs = match xs with | Nil -> Nil | Cons h t -> Cons (f h) (map f t)\nlet main = map (fun x -> x + 1) (Cons 1 (Cons 2 Nil))" },
  { name: "cf-if", src: "let main = let b = true && false in if b then 1 else 2 + 3" },
  { name: "cf-match", src: "let main = let x = 1 + 2 in match x with | 3 -> 9 | _ -> 0" },
  { name: "cf-prop", src: "let main = let x = 2 + 3 in let y = x * 2 in y - x" },
  { name: "if-drops-div", src: "let main = let x = 1 in if x == 1 then 4 else 1 / 0" },
  { name: "short-circuit", src: "let rec loop x = loop x\nlet main = false && loop 1" },
  { name: "short-or", src: "let rec loop x = loop x\nlet main = true || loop 1" },
  { name: "unused-rec", src: "let rec loop x = loop x\nlet main = 1" },
  { name: "unused-pure", src: "let unused = 1 + 2\nlet main = 3" },
  { name: "fact", src: "let rec fact n = if n <= 1 then 1 else n * fact (n - 1)\nlet main = fact 6" },
  { name: "sum", src: "let rec sum n = if n == 0 then 0 else n + sum (n - 1)\nlet main = sum 10" },
  { name: "tail-20", src: "let rec loop n acc = if n == 0 then acc else loop (n - 1) (acc + 1)\nlet main = loop 20 0" },
  { name: "tail-close", src: "let k = 10\nlet rec add n acc = if n == 0 then acc + k else add (n - 1) (acc + 1)\nlet main = add 5 0" },
  { name: "tail-shadow", src: "let n = 7\nlet rec f x = if x == 0 then n else f (x - 1)\nlet main = f 4" },
  { name: "tail-pat", src: "let rec f n = match n with | 0 -> 0 | n -> f (n - 1)\nlet main = f 6" },
  { name: "tail-match", src: "let rec down n = match n == 0 with | true -> 0 | false -> down (n - 1)\nlet main = down 12" },
  { name: "tail-3", src: "let rec f a b c = if a == 0 then b + c else f (a - 1) (b + 1) c\nlet main = f 4 1 2" },
  { name: "tail-twice", src: "let rec add n acc = if n == 0 then acc else add (n - 1) (acc + 1)\nlet g = add 0\nlet main = g 3 + g 4" },
  { name: "tail-returns-fun", src: "let rec f x = if x == 0 then (fun y -> y + 1) else f (x - 1)\nlet main = f 5 9" },
  { name: "inline-in-loop", src: "let inc x = x + 1\nlet rec loop n acc = if n == 0 then acc else loop (n - 1) (inc acc)\nlet main = loop 30 0" },
  { name: "local-inc", src: "let rec loop n acc = let inc x = x + 1 in if n == 0 then acc else loop (n - 1) (inc acc)\nlet main = loop 30 0" },
  { name: "even", src: "let rec even n = if n == 0 then true else if n == 1 then false else even (n - 2)\nlet main = even 11" },
  { name: "nested-if", src: "let main = if true then if false then 1 else 2 else 3" },
  { name: "nested-match", src: "let main = match true with | true -> (match false with | true -> 1 | false -> 2) | false -> 3" },
  { name: "fun-eq", src: "let main = (fun x -> x) == (fun x -> x)" },
  { name: "unit", src: "type U = U\nlet main = U" },
  { name: "not-eq", src: "let main = 1 != 2" },
  { name: "bool-match", src: "let main = match 1 < 2 with | true -> 1 | false -> 0" },
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genInt(rand: () => number, depth: number, scope: string[]): string {
  if (depth <= 0 || rand() < 0.25) {
    if (scope.length > 0 && rand() < 0.5) return scope[Math.floor(rand() * scope.length)]!;
    return String(Math.floor(rand() * 6));
  }
  const choice = rand();
  if (choice < 0.18) return `(- ${genInt(rand, depth - 1, scope)})`;
  if (choice < 0.45) {
    const op = ["+", "-", "*"][Math.floor(rand() * 3)]!;
    return `(${genInt(rand, depth - 1, scope)} ${op} ${genInt(rand, depth - 1, scope)})`;
  }
  if (choice < 0.55) {
    const denom = [1, 2, 3, -1][Math.floor(rand() * 4)]!;
    return `(${genInt(rand, depth - 1, scope)} / ${denom})`;
  }
  if (choice < 0.75) {
    return `(if ${genBool(rand, depth - 1, scope)} then ${genInt(rand, depth - 1, scope)} else ${genInt(rand, depth - 1, scope)})`;
  }
  if (choice < 0.88 && scope.length < 3) {
    const name = ["a", "b", "c"][scope.length]!;
    return `(let ${name} = ${genInt(rand, depth - 1, scope)} in ${genInt(rand, depth - 1, [...scope, name])})`;
  }
  return `(match ${genBool(rand, depth - 1, scope)} with | true -> (${genInt(rand, depth - 1, scope)}) | false -> (${genInt(rand, depth - 1, scope)}))`;
}

function genBool(rand: () => number, depth: number, scope: string[]): string {
  if (depth <= 0 || rand() < 0.35) return rand() < 0.5 ? "true" : "false";
  const choice = rand();
  if (choice < 0.4) {
    const op = ["<", "<=", ">", ">=", "==", "!="][Math.floor(rand() * 6)]!;
    return `(${genInt(rand, depth - 1, scope)} ${op} ${genInt(rand, depth - 1, scope)})`;
  }
  if (choice < 0.7) return `(if ${genBool(rand, depth - 1, scope)} then ${genBool(rand, depth - 1, scope)} else ${genBool(rand, depth - 1, scope)})`;
  if (choice < 0.85) return `(${genBool(rand, depth - 1, scope)} && ${genBool(rand, depth - 1, scope)})`;
  return `(${genBool(rand, depth - 1, scope)} || ${genBool(rand, depth - 1, scope)})`;
}

const GENERATED: Program[] = [];
for (let seed = 1; seed <= 36; seed++) {
  const rand = mulberry32(seed);
  const kind = rand() < 0.75 ? "int" : "bool";
  const body = kind === "int" ? genInt(rand, 4, []) : genBool(rand, 4, []);
  GENERATED.push({ name: `gen-${seed}`, src: `let main = ${body}` });
}

const PROGRAMS = [...HAND, ...GENERATED];

test("dozens of programs agree under --opt none, each pass, and --opt all", () => {
  assert.ok(PROGRAMS.length >= 50, `expected at least 50 programs, got ${PROGRAMS.length}`);
  for (const program of PROGRAMS) agree(program);
});
