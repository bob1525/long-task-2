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
