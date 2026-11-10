# Self-check

Each round is a failure that was actually observed, then a fix, then the command that was run again. The compiler phases before these rounds had already been tested: `npx tsx --test tests/lexer.test.ts tests/parser.test.ts` (9 lexer + 13 parser) and `npx tsx --test tests/infer.test.ts` (31 cases) passed before ANF work started, and `npx tsc --noEmit` was clean on that code.

## Round 1

Checked: `npx tsc --noEmit` while finishing `Checker.collectTypes` in `src/typecheck.ts`. Reconfirmed in this session by changing `let scheme: Type = result` to `let scheme = result` and running:

```bash
npx tsc --noEmit --pretty false
```

Problem: TypeScript narrowed `scheme` to the constructor type of `result`. The assignment that builds a constructor's function type failed at `src/typecheck.ts(191,22)`:

```text
src/typecheck.ts(191,22): error TS2322: Type '"fun"' is not assignable to type '"con"'.
```

`tsc` exited 2.

Fix: keep the annotation `let scheme: Type = result` so the binding stays a `Type` while constructor arguments are wrapped as function types. That annotation is the code in commit `efa2946`. The temporary edit was reverted with `git checkout -- src/typecheck.ts`.

Re-run: `npx tsc --noEmit` exited 0.

## Round 2

Checked, on commit `b5d520a`:

```bash
npx tsx --test tests/*.test.ts
```

Problem: `tests/semantics.test.ts`, test `shadowing and closure capture agree with and without optimization`. The source started with `let x = 1 in let x = x + 2 in x` as a top-level declaration. `Parser.parseProgram` (`src/parser.ts`) only accepts `type` and `let` declarations, and `Parser.fail` rejected the `in`:

```text
not ok 80 - shadowing and closure capture agree with and without optimization
error: "expected a top-level 'type' or 'let' declaration, found 'in'"
stack:
  Parser.fail (/workspace/src/parser.ts:525:12)
  Parser.parseProgram (/workspace/src/parser.ts:72:20)
  parse (/workspace/src/parser.ts:54:39)
  inferProgram (/workspace/src/typecheck.ts:75:19)
  compileSource (/workspace/src/compile.ts:33:19)
  runSource (/workspace/src/compile.ts:71:14)
  agree (/workspace/tests/semantics.test.ts:24:18)
```

The suite ended `# tests 85`, `# pass 82`, `# fail 3`.

Fix: `let ... in` is an expression. The three programs in that test are now bindings of `main`, for example `let main = let x = 1 in let x = x + 2 in x`.

Re-run: the same test is `ok 80` in the suite below (about 523 ms). Commit `c250b72`.

## Round 3

Checked, on commit `b5d520a`, as part of the same `npx tsx --test tests/*.test.ts` run, plus these commands before the fix:

```bash
npx tsx src/cli.ts run examples/factorial.fun --bogus
npx tsx src/cli.ts ir examples/factorial.fun --no-const-foldd
npx tsx src/cli.ts run examples/factorial.fun -o /tmp/should-not-write.js
npx tsx src/cli.ts run examples/factorial.fun examples/compose.fun
```

Problem: `flagsFromArgs` in `src/compile.ts` skipped any token it did not recognize, and `parseCli` / `main` in `src/cli.ts` used only `positional[0]` and ignored `-o` unless the command was `compile`. The test `unknown options and extra file arguments are rejected` failed on the first assertion:

```text
not ok 83 - unknown options and extra file arguments are rejected
error: 'Expected "actual" to be strictly unequal to: 0'
expected: 0
actual: 0
operator: 'notStrictEqual'
at TestContext.<anonymous> (/workspace/tests/semantics.test.ts:130:10)
```

The direct commands agreed. `--bogus` exited 0 and printed `120`. `--no-const-foldd` exited 0 and printed the factorial IR, starting `let rec factorial = fun n ->`. `-o /tmp/should-not-write.js` exited 0, printed `120`, and did not create the file (`ls` reported `No such file or directory`). `run examples/factorial.fun examples/compose.fun` exited 0 and printed `120`, dropping `compose.fun`.

Fix: `flagsFromArgs` throws `unknown option '...'`. `main` throws `unexpected extra argument '...'` when a second file is present, and `-o is only valid with compile` when `-o` is used with `run`, `ir`, or `check`.

Re-run after commit `c250b72`:

```text
<cli>: error: unknown option '--bogus'
<cli>: error: unknown option '--no-const-foldd'
<cli>: error: unexpected extra argument 'examples/compose.fun'
<cli>: error: -o is only valid with compile
```

Each command exited 1, and the `--bogus` / extra-argument runs printed no stdout. The suite test is `ok 83`.

## Round 4

Checked, on commit `b5d520a`, in the same test run:

```bash
npx tsx --test tests/*.test.ts
```

The test `a missing input file is reported as a compiler error` calls `run` on `examples/does-not-exist.fun`.

Problem: `main` in `src/cli.ts` called `readFileSync` directly. The outer `catch` printed `Error.message` for anything that was not a `CompileError`, so the failure was a raw Node exception:

```text
not ok 84 - a missing input file is reported as a compiler error
The input did not match the regular expression /cannot read/. Input:

"ENOENT: no such file or directory, open '/workspace/examples/does-not-exist.fun'\n"
```

Fix: `readSource` in `src/cli.ts` catches the filesystem error and throws `CompileError` with `cannot read '<path>' (<code>)`. `formatError` then prints it like the other CLI errors.

Re-run after commit `c250b72`:

```bash
npx tsx src/cli.ts run examples/does-not-exist.fun
```

```text
<cli>: error: cannot read 'examples/does-not-exist.fun' (ENOENT)
```

Exit code 1. The suite test is `ok 84`.

## Suite after the fixes

```bash
npx tsc --noEmit
npx tsx --test tests/*.test.ts
```

`tsc` exited 0. The test process exited 0 with:

```text
# tests 85
# suites 0
# pass 85
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`npm test` runs that same `tsx --test tests/*.test.ts` command. A later `npm test` also exited 0 and printed `# tests 85`, `# pass 85`, `# fail 0`.

## Round 5

Checked Hindley-Milner soundness with a new adversarial file, before the caret fix:

```bash
npx tsx --test tests/hm-soundness.test.ts
```

The file covers let generalization against a monomorphic lambda parameter, a `let` inside a lambda, `let rec` quantified only after the body, constructor instantiation, the occurs check, and the column of the caret.

Eight tests passed. Two failed because `inferLet` unified the recursive assumption at `e.span` (the `let` keyword) and `checkAnnotation` used that same span:

```text
not ok 8 - infinite type on let rec points at the body, not the let keyword
  location: '/workspace/tests/hm-soundness.test.ts:77:1'
  error: |-
    t.fun:1:1: type error: infinite type: a type variable occurs in a -> b
    let rec f x = f
    ^

    1 !== 15
  expected: 15
  actual: 1
  stack: |-
    TestContext.<anonymous> (/workspace/tests/hm-soundness.test.ts:82:10)

not ok 9 - a rejected annotation points at the annotation
  location: '/workspace/tests/hm-soundness.test.ts:86:1'
  error: |-
    t.fun:1:1: type error: annotation a -> a does not match inferred type Int -> a
    let rec f : a -> a = fun x -> f 1
    ^

    1 !== 13
  expected: 13
  actual: 1
  stack: |-
    TestContext.<anonymous> (/workspace/tests/hm-soundness.test.ts:91:10)
```

The suite ended `# tests 10`, `# pass 8`, `# fail 2`. The inferred type `Int -> a` for `f 1` inside the recursive body is the monomorphic type; the failure was the column.

Fix: commit `e282731` (`e282731e982bc99637782a41104d752b85280128`). `inferLet` unifies at `innermost(e.value).span`, and `checkAnnotation` uses `e.ann.span`.

Re-run:

```bash
npx tsx --test tests/hm-soundness.test.ts tests/infer.test.ts
```

```text
# tests 41
# pass 41
# fail 0
```

Exit code 0. The caret for `let rec f x = f` is column 15, and the caret for the rejected annotation is column 13.

## Round 6

Checked pattern-match compilation by running the non-exhaustive `get` program and `10 / 0` through `src/cli.ts`, on the compiler from commit `7979498` (before the runtime wrapper). `check` was run on the same `get` program.

```fun
type Opt a = None | Some a
let get o = match o with | Some x -> x
let main = get None
```

`npx tsx src/cli.ts run` exited 1 and printed the Node stack of the temporary program:

```text
/tmp/funcc-SCdeKL/prog.js:37
    throw new Error("non-exhaustive pattern match");
    ^

Error: non-exhaustive pattern match
    at /tmp/funcc-SCdeKL/prog.js:37:11
    at $prog (/tmp/funcc-SCdeKL/prog.js:38:5)
    at Object.<anonymous> (/tmp/funcc-SCdeKL/prog.js:41:19)
    at Module._compile (node:internal/modules/cjs/loader:1781:14)
```

`npx tsx src/cli.ts check` exited 0, printed `get : ∀a. Opt a -> a` and `result main : ∀a. a`, and wrote nothing to stderr. `let main = 10 / 0` exited 1 with:

```text
/tmp/funcc-IBMPIj/prog.js:15
  if (b === 0) throw new Error("division by zero");
               ^

Error: division by zero
    at $div (/tmp/funcc-IBMPIj/prog.js:15:22)
    at $prog (/tmp/funcc-IBMPIj/prog.js:30:16)
```

Fix: commit `422f0ed` (`422f0edeb2d7a3f10cda5414709312aa63823a28`). `src/exhaust.ts` names a missing boolean or constructor, including a constructor nested under another constructor, and `Checker.inferMatch` records a warning. `codegen` throws `FUN_RUNTIME:...` with the match or division span, and the generated script prints only `runtime error: ...` before `process.exit(1)`.

Re-run of `run` on `10 / 0` exited 1 with:

```text
runtime error: division by zero at /tmp/tmp.2EIwEBbjuk/div.fun:1:12
```

`run` on `get` exited 1 with:

```text
/tmp/tmp.S4Bc5UP9Nx/get.fun:2:13: warning: non-exhaustive pattern match; missing None
runtime error: non-exhaustive pattern match at /tmp/tmp.S4Bc5UP9Nx/get.fun:2:13
```

`check` on `get` exited 0, kept the same types, and printed the warning. Neither stderr contains `prog.js` or a `at Module._compile` frame. The same commit's tests cover a nested miss (`Cons _ Nil` warns `missing Cons _ (Cons _ _)`) and an overlapping wildcard, which returns the first matching arm.

## Round 7

Checked self tail calls with:

```fun
let rec loop n acc = if n == 0 then acc else loop (n - 1) (acc + 1)
let main = loop 100000 0
```

On commit `7979498`, both the default `run` and `run --opt none` exited 1. The default stderr began:

```text
/tmp/funcc-9tMWXh/prog.js:6
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return a === b;
  ^

RangeError: Maximum call stack size exceeded
    at $eq (/tmp/funcc-9tMWXh/prog.js:6:3)
    at v_lam7 (/tmp/funcc-9tMWXh/prog.js:32:20)
    at /tmp/funcc-9tMWXh/prog.js:40:24
    at v_lam7 (/tmp/funcc-9tMWXh/prog.js:43:9)
```

`--opt none` was the same `RangeError` from `/tmp/funcc-amZ85U/prog.js`. The overflow is the recursive call, surfaced inside `$eq` because `n == 0` is the first call of each frame.

Fix: commit `422f0ed`. `tailCallPass` in `src/optimize.ts` rewrites a saturated self tail call (`let t4 = loop(t2) in let t5 = t4(t3) in t5`, including the same shape in a tail `if` or `match` arm) into `jump(t2, t3)` inside `let rec loop(n, acc)`. Codegen emits a `while` loop and copies parameters into locals, so a closure produced by a partial application can be called twice. `n * fact (n - 1)` is left as a call. The pass is `--tco` / `--no-tco` and is on by default.

Re-run: default `run` exited 0 and printed `100000`. `run --opt none` exited 1 and printed `runtime error: stack overflow`, with an empty stdout and no `prog.js` line. `tests/tco.test.ts` locks the before/after IR for `loop 5 0` and checks that `fact 6` stays `720` with no `jump`.

## Round 8

Checked the new flag parser against the tail-call pass, before `applyOptList` updated `tco`. Command:

```bash
npx tsx src/cli.ts ir /tmp/fun-evidence/optnone.fun --opt none
npx tsx src/cli.ts run /tmp/fun-evidence/optnone.fun --opt none
```

The program was the loop from round 7. `--opt none` still printed a loop and the run succeeded:

```text
let rec loop(n, acc) =
  let t1 = (n == 0) in
  let t6 =
    if t1 then
      acc
    else
      let t2 = (n - 1) in
      let t3 = (acc + 1) in
      jump(t2, t3)
```

`run --opt none` exited 0 and printed `100000`. `ir --no-tco --opt all` printed `let rec loop = fun n ->`, so `--opt all` did not turn the pass back on. `flagsFromArgs` starts from all passes enabled, and the `all` / `none` branches set constant folding, dead-code elimination, and inlining only.

Fix: the same commit `422f0ed`, in `applyOptList` in `src/compile.ts`. `all` sets `tco` true and `none` sets `tco` false.

Re-run: `ir --opt none` begins `let rec loop = fun n ->` and contains no `jump`. `run --opt none` exits 1 with `runtime error: stack overflow`. `ir --no-tco --opt all` begins `let rec loop(n, acc)`. `ir --opt all --no-tco` begins `let rec loop = fun n ->`.

## Round 9

Checked whether each pass preserves results. `tests/differential.test.ts` compiles 118 programs (82 written out, 36 from a seeded generator of integer and boolean expressions with `let`, `if`, and `match`) under the flag parser:

```text
--opt none
--opt inline
--opt const-fold
--opt dce
--opt tco
--opt all
```

The written programs include closure capture under shadowing, constant `if` that drops `1 / 0`, dead `1 / 0` and a dead non-exhaustive match, overlapping patterns, nested `Cons` patterns, partial application used twice, and tail loops of depth at most 30. A tail loop of depth 100000 is not in this set: with the pass off it overflows, and with the pass on it returns a value. That pair is round 7 and `tests/tco.test.ts`.

Command, after the flag fix in round 8:

```bash
npx tsx --test tests/differential.test.ts
```

No program disagreed. The test passed:

```text
ok 1 - dozens of programs agree under --opt none, each pass, and --opt all
# tests 1
# pass 1
# fail 0
```

Exit code 0. The full suite, which includes this test, is below.

## Suite after rounds 5–9

```bash
npx tsc --noEmit
npm test
```

`tsc` exited 0. `npm test` exited 0 with:

```text
# tests 115
# suites 0
# pass 115
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

The 30 tests added after the 85-test suite are `tests/hm-soundness.test.ts` (10), `tests/runtime.test.ts` (4), `tests/exhaustiveness.test.ts` (6), `tests/tco.test.ts` (5), `tests/inline-exhibit.test.ts` (4), and `tests/differential.test.ts` (1, covering 118 programs). No earlier test was removed or weakened. The diverging-call test still requires a non-zero status when tail calls are left recursive; its expected stderr is now `runtime error: stack overflow`.
