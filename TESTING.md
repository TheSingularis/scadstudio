# Testing

ScadStudio has three layers of automated tests. All of them run in CI on
every pull request (`.github/workflows/tests.yml`) and on `main`.

| Layer | Runner | Where | What it proves |
| --- | --- | --- | --- |
| Unit | Vitest (Node) | `apps/desktop/test/unit/` | Pure TypeScript logic against the real tree-sitter grammar: parsing, scene graph, the targeted-patch engine round-trip, codegen, sketch editing and snapping, render coalescing. |
| Integration | Vitest (Node) | `apps/desktop/test/integration/` | The real main-process render handler (`scad:render` in `src/main/index.ts`, with Electron faked and the render process's handler run in-process) and the OpenSCAD engine (`src/main/engine.ts`): render results, text() with bundled, project and installed fonts, backend choice, timing budget, error reporting, and that a decomposed node plus its three.js transform matches OpenSCAD's own render. |
| Corpus | Vitest (Node) | `apps/desktop/test/corpus/` | 159 real-world files (MCAD, OpenSCAD's examples, BOSL2, fetched at pinned commits): parse errors may not exceed `baseline.json`, and on every cleanly parsed file each scene-graph reader runs on every node and a no-op gizmo commit round-trips. |
| End-to-end | Playwright + Electron | `apps/desktop/test/e2e/` | The built app under Xvfb, driven with real mouse and keyboard input: open, type, select, gizmo drag, toolbar edits, booleans, modifiers, extrusions, sketch mode, nav cube, plus the audit bugs that only show in the running app (undo, save, use/include, tokenizer, render speed), and crash safety (a heavy model keeps the window responsive; a dead render process or renderer is reported and recovered). |

## Running locally

From the repo root, after `npm ci`:

```sh
npm test                                   # unit + integration
npm run test:unit -w @scadstudio/desktop   # unit only (~1 s)
npm run test:integration -w @scadstudio/desktop
npm run test:watch -w @scadstudio/desktop  # re-run on save
npm run typecheck:test -w @scadstudio/desktop

npm run corpus:fetch -w @scadstudio/desktop  # once; needs git + network
npm run test:corpus -w @scadstudio/desktop

npm run test:e2e -w @scadstudio/desktop      # builds the app, then runs Playwright
```

The end-to-end tests launch real Electron windows. On a Linux machine
without a display (CI, a cloud container, SSH), wrap them in Xvfb:

```sh
xvfb-run -a --server-args="-screen 0 1920x1080x24" npm run test:e2e -w @scadstudio/desktop
cd apps/desktop && xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test -g "sketch"   # one group, app already built
```

Each e2e test starts its own app, so the suite takes a few minutes. On a
failure, Playwright attaches a screenshot and the renderer console to the
report (`apps/desktop/test-results/`; in CI, the `e2e-report` artifact).

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

`it.fails` passes while the bug is present, so CI stays green. The e2e suite
does the same with a `test.fail();` line at the top of the test body. When a fix
lands, the test starts passing and Vitest reports it as a failure
("expected to fail"). The fix PR then changes `it.fails` to `it`, and from
then on the test guards against the bug coming back (for e2e, delete the
`test.fail();` line). Never delete one of these tests to get green; flip it.

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
- E2E: use the `scad` fixture in `test/e2e/fixtures.ts`. `scad.load(source)`
  loads a document and waits for its render, `scad.rendersAfter(action)` runs
  an action and waits for the render it triggers, `scad.clickViewport(dx, dy)`
  clicks relative to the viewport centre (after `load`, the camera is fitted
  so a single centred shape is under the centre), `scad.axisHandle('x')`
  finds a gizmo handle by its colour, and `scad.stubDialogs()` answers the
  native open/save dialogs. Assert what a user sees: editor text
  (`scad.source()`), the status line, toolbar state.
- Name tests after the milestone they guard (`describe('... (M4)')`) so a
  failure points at the feature that regressed.

## Coverage by milestone

| Milestone | Unit / corpus | Integration | End-to-end |
| --- | --- | --- | --- |
| M0 spike (grammar, engine) | `parser.test.ts` (fixtures, known grammar gaps), `corpus.test.ts` | `engine.test.ts` (Manifold flag, use/include in the FS, twist recheck, text() gap) | |
| M1 static viewer | | `renderIpc.test.ts` (fixtures render to valid STL) | `m1-m3-...spec.ts`: launch + default scene, Open dialog, orbit |
| M2 live sync | `coalescingRunner.test.ts`, `parser.test.ts` (error recovery) | `renderIpc.test.ts` (sequential renders, errors: audit M4) | typing re-renders, syntax error isolated; `audit-known-bugs.spec.ts`: M3 race, M4 errors |
| M3 scene graph + select | `sceneGraph.test.ts`, `targetedPatch.test.ts` (primitiveOnlySlice) | `decomposition.test.ts` | click mesh ↔ editor highlight, click empty to clear, caret selects |
| M4 translate gizmo | `targetedPatch.test.ts` (patchTransform round-trip; audit H2, M1) | `decomposition.test.ts` (audit H2, M1) | `m4-m5-transforms.spec.ts`: real X-arrow drag, second drag, audit H2 |
| M5 transforms, insert, params | `targetedPatch.test.ts` (rotation order, mirror, color: audit M2, params), `primitives.test.ts` | `decomposition.test.ts` | gizmo modes, Position fields, Mirror, Color, every Insert button, parameter panel |
| M6 booleans, modifiers | `targetedPatch.test.ts` (wrapInBoolean: audit L1, modifiers) | `decomposition.test.ts` (modifier) | `m6-m7-...spec.ts`: shift/ctrl multi-select, Union/Difference/Intersection, # % ! * |
| M7 extrusions | `targetedPatch.test.ts` (wrapInExtrude, thin extrude), `primitives.test.ts` | `decomposition.test.ts` (2D retry) | Linear/Rotate Extrude insert and wrap-selection, bare 2D renders, audit L2 |
| M7.5 sketch mode | `targetedPatch.test.ts` (sketch profiles), `primitives.test.ts`, `sketchEditing.test.ts`, `sketchSnap.test.ts` | | `m7_5-sketch.spec.ts`: draw + Finish, grid snap, Alt bypass, Undo/Exit, Edit Sketch insert + Save, extrude a sketch, XZ/YZ, Pick Face, nav cube, step arrows, shading |
| Sketch dots at any zoom | `screenScale.test.ts` (world size of a pixel: perspective depth, zoom, canvas height, orthographic, degenerate cases) | | `sketch-screen-size.spec.ts`: snap marker the same pixel size zoomed out, default and far in; close-together points placed while zoomed far in |
| M8 custom modules | `moduleIntrospection.test.ts` (definitions, angle use, widget inference, call-site evidence, call formatting), `tools.test.ts` (shared insertion path, `use` directive), `paramPanel.test.ts` (real names, unset params, `addNamedArgument`) | `moduleSources.test.ts` (use/include scoping checked by rendering, directive paths, chokidar watching), `builtinSignatures.test.ts` (positional names checked against the engine) | `m8-custom-modules.spec.ts`: Custom section, insert, library tools + nested use, widgets (checkbox, X/Y/Z, text), on-disk edit refreshes the toolbar, filter box; corpus: `customModules.test.ts` (BOSL2 via `use <BOSL2/std.scad>` finds every module a text search finds; every MCAD file) |
| M9 drill-in | `drillIn.test.ts` (drillability, labels, frames, baked prefix, module scope, library view-only, resolveFocus, insertIntoContainer), `nodeIdentity.test.ts`, `structuralEdits.property.test.ts` (fast-check round trips on every reachable working set; `PROPERTY_RUNS` sets the run count, default 120) | `drillInRender.test.ts` (nested isolated renders match the engine's full render by bounding box) | `m9-drill-in.spec.ts`: drill, dim and Escape out, one engine call per child edit, double-click and cutter picking, module levels and breadcrumb links, library view-only + open, insert and sketch while drilled in, typed edits keep focus and flash |
| M13 BOSL2 (part 1, logic) | `bosl2Edges.test.ts` (BOSL2's edge order, selectors read and written, all 4096 sets round-trip), `bosl2Shapes.test.ts` (cuboid/cyl/prismoid edges and positions, minimal argument edits), `bosl2Convert.test.ts`, `bosl2Usage.test.ts` (reachability rules), `sketchCorners.test.ts` | `bosl2.test.ts` (with the bundled BOSL2: written selectors vs listing edges, edge positions vs rendered bounds, cube/cylinder conversion renders the same solid, every redefined built-in and each part of a mixed file renders the same without the include) | (part 2, after M10b) |
| Render backend / speed | | `renderIpc.test.ts` (audit H1) | `audit-known-bugs.spec.ts` (audit H1, in-app budget) |
| Undo, Save, use/include, highlighting | | | `audit-known-bugs.spec.ts` (audit H3, H4, H5, M5) |

## Known gaps

- Rotate and Scale gizmo *drags* are not driven end to end (their handles
  are checked, and the rotate/scale maths is covered by unit and
  integration tests). Same for dragging a sketch point handle; Edit Sketch is
  covered through edge-click insertion.
- Windows is covered only by the packaged-app smoke test in
  `build-desktop.yml`; the e2e suite runs on Linux.
- The corpus baseline records real grammar gaps rather than failing on
  them: 50 of 67 BOSL2 files and 9 of 42 MCAD files parse with errors
  (MCAD's are identifiers that start with a digit, such as `8bit_str`). All
  50 OpenSCAD examples parse cleanly. This matters for M8 (reading a `use`d
  library's modules) and M13 (BOSL2).
- Screenshots are compared only for "did the view change", not against
  golden images, so a rendering regression that still draws something passes.
