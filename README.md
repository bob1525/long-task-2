# Fun

Fun is a small functional language. This repository is its compiler: a hand-written lexer and parser, Hindley-Milner inference, an ANF intermediate language, three switchable optimizations, and a JavaScript backend. The compiler does not use a parser generator or an existing compiler framework.

## Build

Requires Node.js 22 or newer.

```bash
npm install
```

## Test

```bash
npm test
```

That runs `tsx --test tests/*.test.ts`. `npm run typecheck` runs `tsc --noEmit`.

## Compile and run

```bash
npx tsx src/cli.ts run examples/factorial.fun
npx tsx src/cli.ts run examples/list_map.fun
npx tsx src/cli.ts run examples/pattern_match.fun
npx tsx src/cli.ts run examples/compose.fun
```

Other commands:

```bash
npx tsx src/cli.ts check examples/factorial.fun
npx tsx src/cli.ts ir examples/compose.fun
npx tsx src/cli.ts compile examples/pattern_match.fun -o /tmp/pattern_match.js
node /tmp/pattern_match.js
```

`run` prints the program result. `check` prints the type of every top-level binding. `ir` prints the optimized ANF. `compile -o` writes a JavaScript file. If a binding named `main` exists, that value is the result; otherwise the result is the last top-level binding.

## Optimization flags

All three passes are on by default, in this order: inlining, constant folding, dead-code elimination.

| Flag | Effect |
| --- | --- |
| `--const-fold` / `--no-const-fold` | Fold primitives and constant `if`s, and propagate literals. Division by zero is left in the IR. |
| `--dce` / `--no-dce` | Delete pure bindings the result does not use. Calls, matches, and division by zero stay. |
| `--inline` / `--no-inline` | Inline a non-recursive function that is applied exactly once and whose body has at most 25 `let`s. |
| `--opt all` | Enable all three (the default). |
| `--opt none` | Disable all three. |
| `--opt const-fold,dce,inline` | Replace the set with the named passes. `all` and `none` cannot be mixed into a list. |

`--opt` replaces the set. A later individual flag overrides it, so `--opt none --const-fold` enables only constant folding. Unknown options, a second input file, and `-o` on a command other than `compile` are errors.

## Syntax

A program is a sequence of top-level `type` and `let` declarations. Comments are `//` to end of line and non-nested `/* ... */`.

```fun
type List a = Nil | Cons a (List a)

let rec map f xs =
  match xs with
  | Nil -> Nil
  | Cons h t -> Cons (f h) (map f t)

let main = map (fun x -> x * 2) (Cons 1 (Cons 2 Nil))
```

Declarations:

```fun
type Name tyvar* = Constructor type* (| Constructor type*)*
let name param* (: type)? = expr
let rec name param+ (: type)? = expr
```

Expressions:

```fun
if expr then expr else expr
let name param* (: type)? = expr in expr
let rec name param+ (: type)? = expr in expr
fun param+ -> expr
match expr with | pattern -> expr (| pattern -> expr)*
expr infix expr
expr expr          (* application, left-associative *)
- expr
( expr )
123  true  false  "string"  name  Constructor
```

Infix operators, from loosest to tightest: `||`, `&&`, `==` `!=`, `<` `<=` `>` `>=`, `+` `-` `++`, `*` `/`. All are left-associative. `&&` and `||` are short-circuit `if` expressions. Application is tighter than infix, and unary minus is between them, so `-f x` means `-(f x)`.

A multi-parameter `fun` or `let` is sugar for nested single-argument functions. `let add x y = x + y` is `let add = fun x -> fun y -> x + y`.

Patterns are `_`, a variable, an integer, boolean, or string literal, or a constructor applied to patterns. A nested constructor that has arguments needs parentheses: `Cons (Cons h t) rest`. A `match` nested in an arm also needs parentheses, because `|` is greedy.

Types are `Int`, `Bool`, `String`, a declared type name applied to types, a lowercase type variable, and `->`. Function types are right-associative. A function type used as a constructor argument is parenthesized: `type Box = Mk (Int -> Int)`.

Names that start with an uppercase letter are constructors and type names. Other names are variables and type variables. `_` is a wildcard pattern. `let rec` must bind a function. Integers must be JavaScript safe integers; the minus sign is unary minus, not part of the token.

## What the compiler does

1. `src/lexer.ts` and `src/parser.ts` produce a positioned AST. Errors look like `file:line:col: parse error: ...` with a caret.
2. `src/typecheck.ts` infers Hindley-Milner types with let-polymorphism. A `let` is generalized; a `let rec` is monomorphic inside its own body and generalized afterwards. There is no value restriction. An annotation is checked against the inferred type.
3. `src/anf.ts` names every intermediate value. `if` and `match` are computations, so their continuation is not duplicated. A partial constructor becomes a lambda.
4. `src/optimize.ts` runs the selected passes.
5. `src/codegen.ts` emits JavaScript. Integers, booleans, and strings are native values. Constructors are `{ $tag, $fields }`. `let rec` is a named function expression.

Printed values: numbers and booleans are unquoted, strings use JSON quotes, nullary constructors are the tag, other constructors are `Tag(arg, ...)`, and functions are `<fun>`. Integer division truncates toward zero. Division by zero and a non-exhaustive match throw at run time.

Lists are ordinary ADTs. The examples declare `List` themselves; there is no prelude.

Deep recursion can overflow the JavaScript stack. The compiler does not do tail-call optimization.
