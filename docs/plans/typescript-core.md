# Core in TypeScript, built with tsrs and gated by Oxc

**Outcome.** `@lumen-timeline/core` is written in strict TypeScript, type-checked and emitted by tsrs, and ships JavaScript plus declarations with unchanged runtime behavior. Formatting, lint, types, module boundaries and the public API surface are checked by tools on every commit and pull request, so a reviewer, human or LLM, no longer has to verify them by reading.

**Starting point.** At `f418d7f`, the core is eleven ES modules (935 lines) with 66 `node:test` tests across the workspace. There is no build, formatter or linter. CI runs the unit suite and three Playwright verifications on Node 22. Browser pages load `/packages/core/*.mjs` through import maps, and several experiments import `time.mjs` and `interval-index.mjs` directly. The design currently promises "pure JavaScript ES modules" with optional declarations. This plan replaces that contract. [Design](../design.md#packages-and-ownership) · [Core architecture](../core-architecture.md) · [CI](../../.github/workflows/test.yml)

## Toolchain, observed on 2026-11-21

| Tool                                        | Exact pin                                                                     | Role                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [tsrs](https://github.com/oxc-project/tsrs) | `7.1.0-beta.tsrs4` (TypeScript 7.1 beta, `microsoft/TypeScript@3e9236361fa9`) | Type check, JS and `.d.ts` emit, `tsrs-lint` backend for Oxlint     |
| typescript                                  | `7.1.0-beta`                                                                  | Reference compiler for parity checks only                           |
| oxlint                                      | `1.94.0`                                                                      | Lint, type-aware through `tsrs-lint` (needs ≥ 1.92)                 |
| oxfmt                                       | `0.79.0`                                                                      | Formatter (pre-1.0)                                                 |
| lefthook                                    | `2.2.2`                                                                       | Git hooks                                                           |
| @types/node                                 | `26.x`                                                                        | Test files only                                                     |
| Node                                        | 26 LTS                                                                        | Runs `.ts` sources by type stripping. Local is 26.13.1, CI is on 22 |

Before writing this plan, we tried each tool on scratch copies of the repository. None of these trials were committed.

| Trial                                     | Observation                                                                                                                                                                                                                                                                                                                                                                                                                      | Consequence                                                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| tsrs `checkJs` + `strict` on today's core | 206 diagnostics, 166 of them implicit-`any` parameters. With an ES-only `lib`, `queueMicrotask`, `globalThis.crypto` and `globalThis.reportError` are undeclared.                                                                                                                                                                                                                                                                | The rewrite is mostly annotation. Optional host globals need one typed access point.                                               |
| Strict flag set below on sample modules   | `erasableSyntaxOnly`, `isolatedDeclarations`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` each produced their expected diagnostic (TS1294, TS9013, TS2532, TS2412). In matching runs, tsrs and `tsc` 7.1 beta agreed on diagnostics and exit codes.                                                                                                                                                              | The full strict set is usable from day one.                                                                                        |
| Emit                                      | tsrs and `tsc` 7.1 beta output (JS, `.d.ts`, maps) was byte-identical. `./x.ts` imports become `./x.js` in JS. Declarations keep `./x.ts`, which both compilers resolve for a consumer that has only `dist/`.                                                                                                                                                                                                                    | tsrs can be the only build compiler. `tsc` is an exit path.                                                                        |
| Node 26 + workspace link                  | `.ts` tests ran with no warning. A JS consumer resolved `@lumen-timeline/core` to `src/` under `--conditions=@lumen-timeline/source` and to `dist/` without it.                                                                                                                                                                                                                                                                  | Tests run on source without a build, and again on the emitted output.                                                              |
| `oxlint --type-aware --type-check`        | `tsrs-lint` was used automatically. It reported `no-floating-promises`, `switch-exhaustiveness-check` and TypeScript errors in 0.6 s. It flagged every top-level `node:test` `test()`, and an `allowForKnownSafeCalls` override cleared those reports.                                                                                                                                                                           | Type-aware rules are cheap enough for pre-commit. Tests need the override.                                                         |
| `oxlint` defaults on today's code         | Six warnings. The first trial read only the last four lines of output and missed two. Four are `unicorn/no-useless-spread` on listener-set snapshots (`editor.mjs` ×3, `audio.mjs`). One is the same rule on `[...pcm.slice()]` in `experiments/sync/browser.mjs`, a false positive: the spread turns a `Float32Array` into a plain array for JSON. One is `no-unused-expressions` on a ternary statement in `video-driver.mjs`. | Keep the snapshots behind reasoned suppressions. Make the typed-array conversion explicit with `Array.from` instead of autofixing. |
| oxfmt                                     | With the defaults, 73 tracked files changed (+6,820/−4,460). Before and after, the ASTs of every JS file, the parsed JSON and the rendered Markdown prose were identical, and all 66 tests passed. `--check` finishes in milliseconds.                                                                                                                                                                                           | Adopt the defaults. Format in one isolated commit, before the TypeScript diff, and list it in `.git-blame-ignore-revs`.            |
| lefthook pre-commit                       | Format check and lint of staged files plus the full unit suite took 0.93 s. An unused variable blocked the commit.                                                                                                                                                                                                                                                                                                               | The whole fast gate fits in pre-commit.                                                                                            |

## Decisions

1. **Erasable TypeScript only.** No enums, namespaces, parameter properties or decorators (`erasableSyntaxOnly`). Emit is type erasure, so tsrs emit, Node type stripping and `tsc` all execute the same code.
2. **Runtime validation stays authoritative.** Projects arrive as JSON and JS callers bypass types. Keep every `requireEdit`, safe-integer check and `Object.freeze`. Types describe runtime truth. For example, `EditFailure.target` is `unknown`, because `invalid-id` and `invalid-track` echo host input. Narrowing it would be a separate behavior change.
3. **Ticks are `type Tick = number`, not a brand.** Positions round-trip through JSON and host arithmetic. A brand would force casts in every host and test. Reconsider only if unit mix-ups appear in practice.
4. **The compiler enforces a headless core.** Compile `src/` with `lib: ["es2024"]` and `types: []`. DOM and Node globals then fail to type-check. The editor declares the one bare global it calls, `queueMicrotask`, and reads the optional `crypto.randomUUID` and `reportError` through a typed view of `globalThis`, keeping today's fallbacks.
5. **Pin compilers in pairs.** Pin `tsrs` and `typescript` to the same TypeScript version, without a caret. CI uses tsrs default mode and never `--fast`, which tsrs documents can change diagnostics. Upgrade both together in a dedicated PR that runs the parity job.
6. **Source and dist are selected by a scoped condition.** `@lumen-timeline/source` maps exports to `src/*.ts` for tests and type-checking. Without the condition, Node, browsers and bundlers get `dist/`. A scoped name can't collide with a consumer's own `source` condition.
7. **Formatting follows the oxfmt defaults.** The output is Prettier-compatible with `printWidth` 100. There is no style to debate and no options to migrate when oxfmt changes. The config only adds the schema reference and excludes recorded measurement data.
8. **No assertions.** Sources and tests use no `as` assertions except `as const`, and no non-null `!`, definite assignment or non-optional `declare` fields.
   - **Enforcement.** Oxlint rejects the first two with `consistent-type-assertions` (`assertionStyle: "never"`) and `no-non-null-assertion`. Review covers the rest.
   - **JSON boundary.** Loading parses JSON into new typed records. It checks every typed field, including track names, mute, solo and gain, and clip names, take and continuity IDs and extensions, so a snapshot's types describe its contents.
   - **Invariants.** A value that internal code guarantees goes through a `defined()` invariant check instead of `!`.
   - **Host globals.** The core reads `crypto.randomUUID`, `reportError` and `queueMicrotask` through `Reflect.get` and `typeof` checks.

## Target layout

```
tsconfig.base.json      shared options below
tsconfig.json           solution: references packages/core and packages/core/test
packages/core/
  package.json          exports "." and "./internal"
  tsconfig.json         src → dist, composite, declarations and maps
  src/                  types.ts, index.ts, internal.ts and the ten modules as .ts
  test/                 *.test.ts, tsconfig.json (noEmit, types: ["node"])
  dist/                 git-ignored build output
.oxfmtrc.json  .oxlintrc.json  lefthook.yml  .node-version  .git-blame-ignore-revs
```

Set every option explicitly. TypeScript 6 and 7 changed several defaults and removed `baseUrl`, ES5 and AMD/UMD/System.

```jsonc
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024"],
    "types": [],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "customConditions": ["@lumen-timeline/source"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noPropertyAccessFromIndexSignature": true,
    "noFallthroughCasesInSwitch": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "isolatedDeclarations": true,
    "rewriteRelativeImportExtensions": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true,
  },
}
```

```json
"exports": {
  ".": { "@lumen-timeline/source": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./internal": { "@lumen-timeline/source": "./src/internal.ts", "types": "./dist/internal.d.ts", "default": "./dist/internal.js" }
}
```

The source condition comes first. TypeScript also matches `types` under a custom condition, so it would otherwise always resolve to `dist/`. Node ignores `types`.

`exactOptionalPropertyTypes` matches the core's existing distinction between an absent field and `undefined`. Examples are the optional `trackId` on a move, the deleted `entityData` and the entity-data journal's use of `undefined` for absence. `./internal` is explicitly unstable. It exports `visitRange` and `splitClip`, which tests and the query benchmark use today through deep relative paths.

## Public type model

Derive `src/types.ts` from current runtime behavior, not from the prose docs.

- **Document.** `ProjectInput` is schema-v1 JSON. `ProjectSnapshot` is the frozen form with a required `revision` and readonly arrays. `Track` has `overlap`, `locked`, `accepts`, `mute`, `solo` and `gain`. `Clip` has `id`, `trackId`, `kind`, `start`, `duration`, `contentIn`, `contentBounds`, `activeTakeId`, `continuityId` and `extensions`. Use `JsonValue` for entity data and extension payloads. Unknown fields are still preserved at runtime but are not typed.
- **Commands.** `EditCommand` is the union of `move | trim | split | set-data | remove-data`. `PreviewCommand` is `move | trim`. Type each `commands.*` factory as `(args: Omit<C, 'type'>) => C`.
- **Results.** `EditResult` is `EditCommit | EditUnchanged | EditFailure`, discriminated by `ok` and `unchanged`. `EditCommit.history` is `'record' | 'ignore' | 'undo' | 'redo'`. The patch, data-patch and affected-interval types are readonly.
- **Error codes.** `EditErrorCode` is a union of the 28 codes the core raises today: `unknown-command`, `invalid-selection`, `invalid-delta`, `missing-clip`, `locked-track`, `missing-track`, `invalid-edge`, `invalid-range`, `split-policy-required`, `invalid-id`, `disposed`, `stale-revision`, `revision-overflow`, `unsupported-preview`, `invalid-history-policy`, `empty-history`, `history-conflict`, `invalid-project`, `unsupported-schema`, `invalid-timebase`, `invalid-track`, `invalid-clip`, `incompatible-kind`, `source-bounds`, `overlap`, `invalid-data-key`, `invalid-history` and `foreign-snapshot`. Planner issues are a separate union: `invalid-gain`, `unresolved-take` and `invalid-take`.
- **Reads.** The types are `ReadHandle` (`revision`, `clipsIn`, `planAudio`), `TakeCatalog`, `TakeBinding`, `AudioPlan` and `AudioSpan`.
- **Editor.** `Editor` covers `getSnapshot`, `preview`, `session`, `read`, `dispatch`, `history`, `subscribe` and `dispose`. With `isolatedDeclarations`, every export states its type, so the declaration diff is the API diff.

## Quality gates

Every enabled rule must have zero findings at merge and protect a stated invariant. Add rules one at a time with their fixes, never as a bulk category switch.

| Concern                  | Check                                                                                                                                                                                  | Pre-commit   | CI  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --- |
| Formatting               | `oxfmt --check` with the default configuration. `docs/measurements` is excluded.                                                                                                       | Staged files | All |
| Lint correctness         | Oxlint `correctness: error`, `--deny-warnings`, `--report-unused-disable-directives`. A suppression must carry `-- reason`.                                                            | Staged files | All |
| Module boundaries        | In core, `no-restricted-imports` bans `node:*`, `@lumen-timeline/media` and `@lumen-timeline/timeline`. In package sources, `import/no-nodejs-modules`. Everywhere, `import/no-cycle`. | ✓            | ✓   |
| Headless core            | tsconfig `lib`/`types` (decision 4)                                                                                                                                                    | ✓            | ✓   |
| Type soundness           | tsrs strict. In core `src/`: `typescript/no-explicit-any`, `ban-ts-comment` and `no-unsafe-{assignment,argument,call,member-access,return}`.                                           | ✓            | ✓   |
| Async and exhaustiveness | `no-floating-promises` (with the `node:test` allowance in `test/`), `switch-exhaustiveness-check`, `only-throw-error`, `no-unnecessary-type-assertion`                                 | ✓            | ✓   |
| Behavior                 | `node:test` on source. Then on `dist/` after `tsrs -b`, followed by Playwright on `dist/`.                                                                                             | Source suite | All |
| Public API drift         | Emitted `dist/*.d.ts` compared with a committed `packages/core/api/` snapshot                                                                                                          |              | ✓   |
| Compiler parity          | `tsc` 7.1 beta: same diagnostics, and byte-identical emit compared with tsrs                                                                                                           |              | ✓   |

These measured candidates stay off for now. `no-await-in-loop` has 50 hits, from sequential browser verification by design. `unicorn/consistent-function-scoping` has 14, from closures inside the `createEditor` factory. `eslint/no-shadow` has 15. Revisit each one separately.

The hook only checks. It never rewrites or re-stages files, so partially staged files are never folded into a commit. `npm run fix` runs `oxlint --fix` and then `oxfmt`. `git commit --no-verify` bypasses hooks, so CI is the authority. Branch protection is unavailable for this private repository on its current GitHub plan, so a failing CI job cannot block a merge yet. Upgrading the plan or making the repository public would allow required status checks. Humans and agents run one local entry point, `npm run check`.

```yaml
# lefthook.yml after PR I. PR G installs the format job, PR H adds lint,
# and PR I adds --type-aware/--type-check and the types job, which need tsrs.
pre-commit:
  parallel: true
  jobs:
    - name: format
      glob: "*.{js,mjs,ts,json,css,html,yml,yaml}"
      run: npx oxfmt --check --no-error-on-unmatched-pattern {staged_files}
    - name: lint
      glob: "*.{js,mjs,ts}"
      run: npx oxlint --type-aware --type-check --deny-warnings {staged_files}
    - name: types
      glob: "*.ts"
      run: npx tsrs -b
    - name: unit
      run: npm test --silent
```

## PR G — Format with oxfmt

- Add pinned `oxfmt` and `lefthook`, an `.oxfmtrc.json` that keeps the defaults, and the `fmt` and `fmt:check` scripts.
- One commit contains only `oxfmt` output. #11 was squash-merged, so `.git-blame-ignore-revs` lists the squash commit `efd71b2` instead. Blame then returns 9,061 of 9,297 pre-existing lines to their original commits. Twelve hand-written new lines in the CI job, README and `package.json`, plus 269 lockfile lines, point at a neighboring older commit.
- The lefthook format job checks staged files. Lefthook hides unstaged changes while the hook runs, so a partially staged file is judged by its staged content. npm 11 blocks dependency install scripts by default, so `allowScripts` denies lefthook's postinstall and the root `prepare` script runs `lefthook install`.
- A `quality` CI job runs `npm run fmt:check` next to the existing test job.

## PR H — Lint the current JavaScript with Oxlint

- Add pinned `oxlint` and `.oxlintrc.json`, add a lint job to lefthook, and add a lint step to `quality`.
- Resolve the six default findings: reasoned `oxlint-disable-next-line` comments on the four listener snapshots, `Array.from` for the typed-array copy, and `if`/`else` for the ternary statement. Enable the boundary rules and check that each one rejects a probe import.

## PR I — Core in TypeScript, built by tsrs

- Add pinned `tsrs`, `typescript` and `@types/node`, plus the tsconfig solution. Set `.node-version` to 26 and move CI to it, because tests run `.ts` through type stripping. Commit 1 moves every module with `git mv packages/core/x.mjs packages/core/src/x.ts` and changes only import specifiers, so `git log --follow` keeps history. Later commits add `types.ts`, annotations and the typed `host` view.
- Switch core `exports` to the conditional map. Repoint consumers:
  - import maps in `examples/vanilla/*.html` and `experiments/sync/run.mjs` → `dist/`
  - `server.mjs` → allow `dist/` paths and serve `.js` and `.map`
  - route allowlists in `experiments/sync/run.mjs` and `experiments/wasm/run.mjs`
  - deep imports in experiments → `@lumen-timeline/core` or `@lumen-timeline/core/internal`
- Scripts: `build` = `tsrs -b`; `test` runs `node --test` with the source condition; `test:dist` runs it without; `parity` emits with `tsc -p` into a scratch directory and diffs against tsrs output. `prepare` builds, so a fresh `npm ci` can serve the examples. Enable type-aware lint for core.
- Keep core tests as `.mjs` in this PR. They are the behavior oracle, and only their import lines may change. Media and timeline stay JavaScript and consume the emitted declarations.
- Update the README, the [design](../design.md#packages-and-ownership), the [architecture](../core-architecture.md) and the [verification guide](../clock-and-wasm.md) commands.

## PR J — Typed tests and a locked API surface

- Move core tests to `packages/core/test/*.test.ts`. Import through `@lumen-timeline/core` and `./internal` only, so the same suite runs on `src/` and `dist/`. Each malformed-command test keeps its runtime assertion and adds `@ts-expect-error`. Each such case then proves both guards. Tests keep the strict base options except `noUncheckedIndexedAccess` and `noPropertyAccessFromIndexSignature`, because their assertions index fixtures directly.
- Add `api:check`, which follows imports from each entry point's `dist/*.d.ts`, strips source-map comments and compares the result with `packages/core/api/`. `api:update` regenerates the snapshot. An intended API change shows up as a reviewed declaration diff in the same PR.
- Two ill-typed fixtures still type-check, and the tests keep them as runtime-only rejections. `schemaVersion++` passes because TypeScript does not check increments against literal types. A `Map` stored in an unknown project field passes because unknown fields are typed `unknown`.

## Merge gates

| Gate                     | Evidence required                                                                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR G: neutral formatting | The format commit contains only `oxfmt` output. Before and after, JS ASTs, parsed JSON and rendered Markdown prose are identical. 66 unit tests, the 3,840-sample PCM comparison and both vanilla browser workflows pass unchanged. `git blame` skips the commit. |
| PR G: working gate       | An unformatted staged file fails the hook, and an unformatted file fails `quality` in CI.                                                                                                                                                                         |
| PR H: lint               | Oxlint reports zero warnings with `--deny-warnings`. An unused variable and a `node:*` import into core each fail the hook and CI, with inline PR annotations. The hook stays under 2 s on this repository.                                                       |
| PR I: types              | `tsrs -b` reports zero diagnostics under the base config. Core `src/` has no `any`, `@ts-ignore` or `no-unsafe-*` finding.                                                                                                                                        |
| PR I: identical behavior | Test files differ only in import lines. All tests pass on source and on `dist/`. The PCM, timeline and audio verifications pass against `dist/`.                                                                                                                  |
| PR I: compiler parity    | `tsc` 7.1 beta reports the same zero diagnostics. tsrs and `tsc` emit byte-identical JS, declarations and maps.                                                                                                                                                   |
| PR J: typed oracle       | Tests type-check under `test/tsconfig.json`. The test count does not drop. Every runtime rejection of an ill-typed command also has a passing `@ts-expect-error`.                                                                                                 |
| PR J: API lock           | Changing any exported signature fails `api:check` until the snapshot is regenerated in the same PR.                                                                                                                                                               |

## Risks and exits

| Risk                                                                                          | Mitigation and exit                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tsrs is a prerelease with roughly two-day releases. Upstream accepts bug reports but not PRs. | Exact pins and the parity job. Exit by swapping `tsrs` for `tsc` in the scripts, using the same tsconfig and identical emit, and by running Oxlint on its `tsgolint` backend.                                                             |
| oxfmt is 0.x and output can shift between versions                                            | Exact pin. Each formatter bump gets its own PR containing only formatter output, so a merge commit or a squash both leave a pure formatting commit. A follow-up commit records the SHA that landed on `main` in `.git-blame-ignore-revs`. |
| Rule autofixes can change intent, as with the subscriber snapshots                            | Never bulk `--fix` newly enabled rules. Review each fix. Suppressions need a reason, and unused suppressions fail CI.                                                                                                                     |
| Oxlint JS plugins are alpha                                                                   | Express architectural rules with native rules and compiler settings only.                                                                                                                                                                 |
| Declarations keep `.ts` specifiers                                                            | Verified for dist-only consumers in both compilers. Re-verify against `npm pack` output before the first publish.                                                                                                                         |
| Type stripping needs Node ≥ 22.18                                                             | Development and CI use Node 26 LTS. Published `dist/` is plain ES2024 and needs no stripping.                                                                                                                                             |

Media and timeline follow the same recipe in a separate plan after PR J: the conversion order, the shared base config and their own API snapshots. [Roadmap](../../ROADMAP.md#milestones)
