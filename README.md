# Fun

Fun is a small functional language. This repository is its compiler: a hand-written lexer and parser, Hindley-Milner inference, an ANF intermediate language, four switchable optimizations, and a JavaScript backend. The compiler does not use a parser generator or an existing compiler framework.

Task B, a distributed key-value simulator with two consistency models and automated consistency checking, is in [`task-b-distributed-kv/`](task-b-distributed-kv/) and does not modify the compiler.

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

All four passes are on by default, in this order: inlining, constant folding, tail-call optimization, dead-code elimination.

| Flag | Effect |
| --- | --- |
| `--const-fold` / `--no-const-fold` | Fold primitives and constant `if`s, and propagate literals. Division by zero is left in the IR. |
| `--dce` / `--no-dce` | Delete pure bindings the result does not use. Calls, matches, and division by zero stay. |
| `--inline` / `--no-inline` | Inline a non-recursive function that is applied exactly once and whose body has at most 25 `let`s. |
| `--tco` / `--no-tco` | Turn a saturated self tail call into a loop. |
| `--opt all` | Enable all four (the default). |
| `--opt none` | Disable all four. |
| `--opt const-fold,dce,inline,tco` | Replace the set with the named passes. `all` and `none` cannot be mixed into a list. |

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
5. `src/codegen.ts` emits JavaScript. Integers, booleans, and strings are native values. Constructors are `{ $tag, $fields }`. `let rec` is a named function expression. A tail-call loop is a `while` whose parameters are copied into locals.

Printed values: numbers and booleans are unquoted, strings use JSON quotes, nullary constructors are the tag, other constructors are `Tag(arg, ...)`, and functions are `<fun>`. Integer division truncates toward zero.

Lists are ordinary ADTs. The examples declare `List` themselves; there is no prelude.

## Runtime errors

`run` and a file produced by `compile -o` print one line and exit non-zero. The Node stack is not shown.

```text
runtime error: division by zero at div.fun:1:12
runtime error: non-exhaustive pattern match at get.fun:2:13
runtime error: stack overflow
```

The match and division messages include the source file, line, and column. A non-tail recursion that exceeds the JavaScript stack becomes `runtime error: stack overflow`.

`check`, `run`, `ir`, and `compile` also warn when a match does not cover every constructor of a boolean or algebraic type, including constructors nested under other constructors. Integers, strings, and functions are open: only a variable or `_` covers them. A warning does not reject the program.

```fun
type Opt a = None | Some a
let get o = match o with | Some x -> x
```

```text
get.fun:2:13: warning: non-exhaustive pattern match; missing None
```

`type List a = Nil | Cons a (List a)` matched by `Nil` and `Cons _ Nil` warns `missing Cons _ (Cons _ _)`.

## Inlining

Inlining fires when a non-recursive function is applied at exactly one call. Curried calls are ordinary nested applications, so a fully applied call inlines through every argument. This program:

```fun
let add x y = x + y
let main = add 1 41
```

has this IR with `--opt none`:

```text
let add =
  fun x ->
    let lam2 =
      fun y ->
        let t1 = (x + y) in
        t1
    in
    lam2
in
let t3 = add(1) in
let t4 = t3(41) in
t4
```

and this IR with `--opt inline`:

```text
let t1 = (1 + 41) in
t1
```

`examples/compose.fun` does the same thing. `--opt inline` reduces `compose inc double 10` to `(10 * 2)` followed by `(t6 + 1)`. The snapshot is locked in `tests/inline-exhibit.test.ts`. `factorial` is recursive, so it is not inlined. In `list_map`, the mapped function is passed into `map` and applied once per element, so that lambda is not inlined either.

A partial application whose result is used twice inlines only the applied prefix. `let add1 = add 1` in `add1 10 + add1 20` becomes `fun y -> 1 + y`, and the two calls of that function remain. Inlining it at both calls would duplicate the function; the pass only inlines a value that occurs once.

## Tail calls

A saturated self tail call becomes a loop. This is the fourth pass (`--tco` / `--no-tco`):

```fun
let rec loop n acc = if n == 0 then acc else loop (n - 1) (acc + 1)
let main = loop 100000 0
```

`--opt none` keeps `let t4 = loop(t2) in let t5 = t4(t3) in t5`. `--opt tco` prints `let rec loop(n, acc) = ... jump(t2, t3)`. The default `run` prints `100000`. `--opt none` prints `runtime error: stack overflow` and exits non-zero, because 100000 recursive calls overflow the JavaScript stack.

The call has to be a self call with every parameter supplied, and the call's result has to be the result of the function (or of an `if` / `match` arm). `n * fact (n - 1)` is not a tail call and stays a recursive function. A partial application such as `loop (n - 1)`, whose result is returned without being applied to the remaining argument, is not rewritten. Those programs still use the JavaScript stack.
