# Testing

ScadStudio has three layers of automated tests. All of them run in CI on
every pull request (`.github/workflows/tests.yml`) and on `main`.

| Layer | Runner | Where | What it proves |
| --- | --- | --- | --- |
| Unit | Vitest (Node) | `apps/desktop/test/unit/` | Pure TypeScript logic against the real tree-sitter grammar: parsing, scene graph, the targeted-patch engine round-trip, codegen, sketch editing and snapping, render coalescing. |
| Integration | Vitest (Node) | `apps/desktop/test/integration/` | The real main-process render handler (`scad:render` in `src/main/index.ts`, with Electron faked) and openscad-wasm: render results, backend choice, timing budget, error reporting, and that a decomposed node plus its three.js transform matches OpenSCAD's own render. |

## Running locally

From the repo root, after `npm ci`:

```sh
npm test                                   # unit + integration
npm run test:unit -w @scadstudio/desktop   # unit only (~1 s)
npm run test:integration -w @scadstudio/desktop
npm run test:watch -w @scadstudio/desktop  # re-run on save
npm run typecheck:test -w @scadstudio/desktop
```

Run one file or one test by name:

```sh
cd apps/desktop
npx vitest run test/unit/targetedPatch.test.ts
npx vitest run -t "stacked"
```

## Known bugs are expected failures

Bugs found by the 2026-11-22 QC audit are written as tests of the **correct**
behaviour, marked as expected failures and tagged with the audit id, for
example:

```ts
it.fails(audit('H2', 'translate(v) { ... } is not double-applied (block body)'), ...)
```

`it.fails` passes while the bug is present, so CI stays green. When a fix
lands, the test starts passing and Vitest reports it as a failure
("expected to fail"). The fix PR then changes `it.fails` to `it`, and from
then on the test guards against the bug coming back. Never delete one of
these tests to get green; flip it.

The audit ids map to the findings in the QC audit doc
(https://claude.ai/artifact/CGiC34t3N2yqqpfPHtSZ7P). `test/helpers/audit.ts`
lists the ids in use.

## Writing tests

- Get a syntax tree with `test/helpers/parse.ts` (`parse`, `parseWithGraph`,
  `nodeAt`, `expectCleanParse`). It uses the app's own `parseScad()` and the
  grammar in `src/renderer/public`, so tests never drift from what the app
  parses.
- For any edit to source text, re-parse the result with `expectCleanParse`
  and read the edited value back. A patch that produces invalid OpenSCAD, or
  that reads back differently, is a bug even if the string "looks right".
- To test the main process, use `loadMainProcess()` from
  `test/helpers/mainProcess.ts` and call handlers with `invoke('scad:render', source)`.
  `engineLog` holds the engine's stdout/stderr per render.
- `test/helpers/stl.ts` parses STL output and applies a node transform the
  same way the viewport does.
- Name tests after the milestone they guard (`describe('... (M4)')`) so a
  failure points at the feature that regressed.

## Coverage by milestone

| Milestone | Unit | Integration |
| --- | --- | --- |
| M0 spike (grammar, engine) | `parser.test.ts` (fixtures, known grammar gaps) | `engine.test.ts` (Manifold flag, use/include in the FS, twist recheck, text() gap) |
| M1 static viewer | | `renderIpc.test.ts` (fixtures render to valid STL) |
| M2 live sync | `coalescingRunner.test.ts`, `parser.test.ts` (error recovery) | `renderIpc.test.ts` (sequential renders, errors: audit M4) |
| M3 scene graph + select | `sceneGraph.test.ts`, `targetedPatch.test.ts` (primitiveOnlySlice) | `decomposition.test.ts` |
| M4 translate gizmo | `targetedPatch.test.ts` (patchTransform round-trip; audit H2, M1) | `decomposition.test.ts` (audit H2, M1) |
| M5 transforms, insert, params | `targetedPatch.test.ts` (rotation order, mirror, color: audit M2, params), `primitives.test.ts` | `decomposition.test.ts` |
| M6 booleans, modifiers | `targetedPatch.test.ts` (wrapInBoolean: audit L1, modifiers) | `decomposition.test.ts` (modifier) |
| M7 extrusions | `targetedPatch.test.ts` (wrapInExtrude, thin extrude), `primitives.test.ts` | `decomposition.test.ts` (2D retry) |
| M7.5 sketch mode | `targetedPatch.test.ts` (sketch profiles), `primitives.test.ts`, `sketchEditing.test.ts`, `sketchSnap.test.ts` | |
| Render backend / speed | | `renderIpc.test.ts` (audit H1) |
