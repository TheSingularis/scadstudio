# OpenSCAD Visual CAD App — Implementation Plan

## Context

Jordan wants to build a desktop CAD application, styled after Onshape, where users visually select/drag/manipulate parts in a 3D viewport, but the persisted artifact is always real, valid OpenSCAD (`.scad`) source code — not a proprietary format. Because OpenSCAD supports user-defined `module` blocks, custom toolbar tools fall out naturally: any module the user (or an imported library) defines should automatically become a draggable/clickable tool.

Before any design work, terminology was verified against the official OpenSCAD User Manual to make sure the mental model driving the app is correct:

- **`module`** — a named, reusable block that performs actions (generates geometry) and returns **no value**: `module name(params) { ... }`, instantiated as `name(args);`, can wrap children via `children()`. This is the correct term for "a reusable part/section" and for "custom toolbar tools."
- **`function`** — returns a single computed value, no geometry: `function name(params) = expr;`. Distinct from a module; custom toolbar tools should be built from modules, not functions.
- **Modifiers** `# % ! *` — highlight / transparent-ghost / show-only-this / disable, prefixed onto any statement.
- **`use <file>` vs `include <file>`** — `use` imports only modules/functions (no variables, no executed geometry) and is the right directive for "a library of custom tools"; `include` executes everything.
- Primitives (`cube`, `sphere`, `cylinder`, `polyhedron`, `square`, `circle`, `polygon`, `text`), transforms (`translate`, `rotate`, `scale`, `mirror`, `color`), booleans (`union`, `difference`, `intersection`), extrusions (`linear_extrude`, `rotate_extrude`).

This is a **greenfield project**. The following architecture decisions were made explicitly by Jordan and are treated as fixed constraints, not open questions:

1. **Electron** for the desktop shell (chosen over Tauri specifically so the bundled Chromium gives consistent WASM/SIMD behavior across OSes, since the render engine depends on it).
2. **Real OpenSCAD compiled to WebAssembly** (`openscad-wasm`) as the geometry/render engine — not a reimplemented JS/WebGL CSG library — so the preview is always byte-for-byte what real OpenSCAD would produce.
3. **MVP scope = "broad" tier**: primitives + transforms + booleans + extrusions + user-defined custom modules surfaced as toolbar tools, with full bidirectional text↔visual sync — this is the actual v1 target.

Two hard technical risks were identified and verified before committing to this plan:
- Does a usable OpenSCAD parser exist for JS/TS? **Yes** — [`openscad/tree-sitter-openscad`](https://github.com/openscad/tree-sitter-openscad) is an actively maintained, org-owned incremental tree-sitter grammar (MIT, JS/Rust/Python/Go bindings) — confirmed live via GitHub.
- Is there a usable WASM build of OpenSCAD with a documented invocation contract? **Yes** — [`openscad/openscad-wasm`](https://github.com/openscad/openscad-wasm), an Emscripten ES6 module: write source to a virtual FS, `callMain(["/input.scad", "--enable=manifold", "-o", "out.stl"])`, read the output back — confirmed live via GitHub, including Manifold-backend support for fast CSG.

## Recommended tech stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Electron (contextIsolation on, no nodeIntegration in renderer) | Fixed constraint; main process only handles fs/menus/window chrome |
| UI | React + TypeScript | Matches the proven `openscad-playground` (OpenSCAD org's own reference UI) pattern of React+Monaco+WASM |
| 3D viewport | `@react-three/fiber` + `@react-three/drei` (TransformControls, OrbitControls) | Declarative scene graph maps directly onto the AST-derived model; gizmos ship out of the box |
| Geometry engine | `openscad-wasm` (Manifold backend, `--enable=manifold`) in a dedicated Web Worker | Fixed constraint; Manifold backend gives the CSG speed needed for iterative editing |
| Mesh transport | Binary STL from WASM → hand-rolled/`STLLoader` → `BufferGeometry` | Simplest format the WASM CLI already emits natively |
| Code editor | Monaco (`@monaco-editor/react`) with a custom OpenSCAD Monarch tokenizer | Same choice as `openscad-playground`; supports decorations for selection sync and inline parse-error diagnostics |
| Parser | `web-tree-sitter` + compiled `tree-sitter-openscad.wasm` | CST with incremental re-parse and full trivia (whitespace/comment) preservation — the property bidirectional sync depends on |
| Semantic layer | Hand-written `scad-ast` walking the CST into typed nodes (ModuleCall, Transform, BooleanOp, ModuleDef, Modifier, etc.) | Tree-sitter gives a generic CST; a thin typed layer on top is needed to reason about "this is a `translate` with 3 args and one child" |
| State | Zustand for UI/selection/camera state; CST/AST/scene-graph held in a dedicated store outside React, subscribed via selectors | The CST is large and patched incrementally — shouldn't live directly in React state or be duplicated across Monaco/scene-graph |
| Packaging | electron-builder; WASM/font/MCAD assets shipped as loose `extraResources`, not bundler-inlined | Multi-MB WASM assets; loose files make future OpenSCAD-WASM version bumps a drop-in replacement |

## Package boundaries (monorepo, pnpm/npm workspaces)

```
packages/
  scad-cst/              parse(text) -> Tree; incremental edit(tree, edits) -> Tree (wraps web-tree-sitter)
  scad-ast/               CST -> typed semantic AST (ModuleCall, ModuleDef, Transform, BooleanOp, Modifier, ...)
  scad-codegen/           typed node -> source fragment; targeted minimal-diff patch engine (nodeId, newParams) -> byte-range edit
  scene-graph/            AST -> UI scene tree: stable node IDs, resolved transform matrices, modifier flags, dirty-tracking
  module-introspection/   scans local file + everything reachable via `use <path>`; infers param widgets; emits ToolDefinition[]
  render-worker/          Web Worker wrapping openscad-wasm; per-node isolated render + full-document render, job queue w/ cancellation
  viewport/               r3f scene; per-node mesh cache; raycast selection; TransformControls binding; modifier material overrides
  toolbar/                built-in ToolDefinition table (cube, sphere, ... union, ... extrude) + dynamic custom-module tools
  editor-pane/            Monaco wrapper; syntax highlighting; diagnostics; decoration sync; cursor<->node mapping
  app-shell/              Electron main + preload: file open/save, `use`d-file watching (chokidar), IPC surface
  desktop-ui/             Electron renderer root; composes viewport+editor-pane+toolbar; owns the central document store
```

Dependency direction: `scad-cst` → `scad-ast` → {`scene-graph`, `scad-codegen`, `module-introspection`} → {`viewport`, `toolbar`, `editor-pane`} → `desktop-ui`. `render-worker` depends only on `scene-graph`, keeping parsing/codegen unit-testable with plain `.scad` fixtures, no Electron/DOM needed.

## Bidirectional sync architecture

**Single source of truth**: the CST (tree-sitter tree) over the raw text buffer, held once in `desktop-ui`'s document store. The semantic AST, scene-graph, Monaco's displayed text, and viewport meshes are all derived/cached projections — never independently-owned copies.

**Text edit path** (Monaco → world): content-change delta → `tree.edit()` incremental re-parse (touches only the changed subtree, tolerates transient invalid syntax via tree-sitter's ERROR nodes) → `scad-ast` re-derives only affected subtrees → `scene-graph` emits a minimal changeset → `viewport`/`toolbar` update only the invalidated nodes. Mid-typing invalid syntax keeps showing the last-known-good mesh for affected nodes rather than erroring; full re-render is debounced (~300-500ms idle).

**Visual edit path** (gizmo/toolbar → world): a UI action targets a scene-graph node id; `scad-codegen`'s targeted patch engine computes the *minimal* text replacement (e.g. `translate([1,2,3])` → replace only the `3` byte range with `3.5`, leaving all other formatting untouched); that edit is applied to the CST via the **same** `tree.edit()` path as the text-edit case, so there is exactly one re-derivation pipeline, not two divergent ones. Monaco's model is updated via `executeEdits(...)` (preserves undo-stack + cursor position) with the identical range/text.

**Comment/whitespace preservation**: achieved by construction — edits are always expressed as `(startByte, endByte, newText)` replacements against specific CST node ranges, so anything not touched (including comments inside untouched argument lists) is never rewritten. This is chosen over a "regenerate whole file from AST + pretty-print" approach, which would require a much harder 100%-round-trip-safe pretty-printer.

**Node identity across edits**: each scene-graph node gets a stable UUID assigned via a structural fingerprint (path-from-root by child-index + call-name, falling back to argument-similarity fuzzy matching), diffed old-vs-new on every re-derive so selection/gizmo state survives edits elsewhere in the file. This side-map is ephemeral/session-only — never written into the `.scad` file.

## Per-node selection & manipulation strategy

The hard problem: `openscad-wasm` only ever emits one flattened mesh, with no per-source-node correlation. Solution — **isolated per-node render passes + a two-layer viewport**:

1. Every top-level statement (and, lazily on selection-expand, its direct geometry children) gets its own **isolated render**: `render-worker` slices that node's exact source byte range, prepends any needed context (variable assignments, `use`/`include` directives — cheap, no geometry side effects), and runs `openscad-wasm` on that synthetic single-node program alone. Result: a mesh containing exactly that node's geometry, with known provenance by construction.
2. Results are cached in `Map<nodeId, {geometry, boundingBox, sourceHash}>`; re-render is skipped whenever the node's own source+context hash is unchanged, so editing one node doesn't invalidate its siblings.
3. **Selection/gizmo layer**: the isolated meshes, invisible or shown as thin outlines, used purely for raycast hit-testing (click → nodeId) and gizmo placement. **Display layer**: the single full-document composite render (real `union`/`difference` fidelity), the one actually shown as the visible surface. Clicking always raycasts against the selection layer — this sidesteps ever needing to attribute triangles of a fused/composite mesh back to a source node.
4. **Gizmos edit AST parameters directly, never mesh vertices.** Dragging a translate gizmo on node N updates node N's `translate([x,y,z])` arguments directly (converting the world-space drag delta into N's local frame via the already-known ancestor transform chain) — the mesh is only ever used for "where to draw the gizmo," never as the edited object. This is the key move that avoids reverse-engineering transforms from geometry.
5. Modifiers map to render/material treatment: `%` → transparent ghost material, excluded from the "real" computed output; `#` → highlight overlay; `!` → short-circuit the full-document render to just that subtree (mirrors OpenSCAD's own semantics); `*` → excluded entirely, shown as a translucent dashed ghost for discoverability.
6. Performance: special-case pure rigid-transform drags (translate/rotate/scale/mirror) to skip WASM entirely during the drag (just move the cached mesh's `Object3D` transform) and only trigger a real re-render on drag-end, since a pure transform of already-known geometry is analytically knowable without re-running CSG.

## Custom module auto-toolbar

1. `module-introspection` scans the open file plus everything transitively reachable via `use <path>` (resolved relative to the document, matching OpenSCAD's own resolution rules; watched live via `chokidar` through the Electron main process's fs IPC).
2. For each `ModuleDef`, extract name/params/defaults/source location.
3. Infer a UI widget per parameter from its default value: boolean literal → checkbox; numeric → number field (degree-slider if name/usage suggests an angle); 3-vector → XYZ widget; string → text field; no default → required generic field, cross-checked against existing call-site argument shapes elsewhere in the project as corroborating evidence.
4. Emit a `ToolDefinition` (same shape used for built-ins) into a distinct "Custom" toolbar section.
5. Instantiation reuses the exact same insertion code path as built-in primitives in `scad-codegen` (inserts `name(param: value, ...)` using named arguments for readability) — custom and built-in tools differ only in where their `ToolDefinition` came from, not in how they're inserted or rendered (the isolated-render step just also prepends the relevant `use` directive so the module is in scope).

## Toolbar

Fixed Onshape-style sections mapping 1:1 to real OpenSCAD operations — no invented abstractions:
- **2D primitives**: square, circle, polygon, text
- **3D primitives**: cube, sphere, cylinder, polyhedron
- **Transform**: translate, rotate, scale, mirror, color
- **Boolean**: union, difference, intersection
- **Extrude**: linear_extrude, rotate_extrude
- **Custom** (dynamic, from module-introspection)

Boolean-op tools operate on multi-selected existing nodes via a "wrap selected source ranges in a new block" structural edit (`difference() { <verbatim selected text> }`) — still a targeted/minimal patch, not a full-file regen.

## Constraints layer ("SCAD+": valid SCAD + app-owned annotations)

Two distinct kinds of constraint, handled very differently, both persisting into the same single `.scad` file with no separate save format:

1. **Directional/DAG constraints** (distance, offset, alignment, "N copies with gap X") — these require no solver at all. They're just SCAD variables and expressions the app generates via `scad-codegen`, e.g. `gap = 10; translate([partA_w + gap, 0, 0]) cube(10);`. The constraint *is* the code the moment it's written — nothing extra to persist, nothing to rehydrate. This is in scope for v1 and needs no new package beyond what's already planned (`scad-codegen`, `scene-graph`).
2. **Solver-based constraints** (tangency, mutual/cyclic relationships — the kind a real 2D sketch constraint solver handles) — OpenSCAD has no language concept of "solve this system," so the app must run its own constraint solver at edit time and write the **solved numeric result** into the file as plain values/expressions. To preserve the *intent* ("these two must stay tangent") for future re-editing, the app also emits a structured comment adjacent to the affected code, e.g.:
   ```
   // @constraint: tangent(circleA, circleB)
   ```
   This is inert to real OpenSCAD (just a comment) but is parsed back out by the app (via `scad-ast`'s comment-node handling) to rehydrate the constraint graph on reopen. This makes the `.scad` file itself the constraint database — no sidecar file — at the cost of the annotation being an app-owned convention that only this app understands or enforces.
   - **Staleness handling**: if the file is hand-edited outside the app (or in vanilla OpenSCAD) such that the annotated values no longer satisfy the constraint, the app must detect the mismatch on reopen/rescan and prompt to re-solve rather than silently trusting stale annotations.
   - **New package**: `constraints/` — constraint type definitions (distance, parallel, perpendicular, tangent, coincident, symmetric), a solver (start minimal: Newton-Raphson over the small DOF sets these operations actually need, not a general-purpose sketch solver), DOF bookkeeping, and over/under-constrained detection surfaced in the UI.
   - **Scope decision**: solver-based constraints are explicitly **out of v1** — v1 ships directional/DAG constraints only, which cover distance/alignment/array use cases with zero solver risk. Full solver-based constraints become their own later milestone (see M10) once the core editor is stable, since a geometric constraint solver is a substantial subsystem in its own right.

## Build order / milestones

- **M0 — Spike (de-risk first)**: get `web-tree-sitter` + compiled `tree-sitter-openscad.wasm` parsing real-world `.scad` files inside Electron; get `openscad-wasm` (Manifold) invoked from a Worker with STL round-tripping into three.js; benchmark render latency. Stress-test the grammar against a real-world corpus (Thingiverse customizer files, MCAD library) — go/no-go checkpoint before building further on top of it.
- **M1 — Static viewer**: open a `.scad` file, full-document render, read-only Monaco with syntax highlighting, camera orbit only.
- **M2 — Live text→visual sync**: editable Monaco, incremental re-parse, debounced whole-document re-render (no per-node concept yet).
- **M3 — Scene-graph + click-to-select**: per-top-level-node isolated rendering, click mesh ↔ highlight text and vice versa (first bidirectional selection milestone).
- **M4 — Translate gizmo**: prove the "gizmo edits AST param via targeted patch" loop end to end, including the skip-WASM-during-drag optimization.
- **M5 — Full transform set + toolbar primitive insertion**: rotate/scale/mirror/color gizmos; built-in toolbar wired to `scad-codegen` insertion; parameter panels.
- **M6 — Booleans**: multi-select, wrap-in-block codegen, lazy isolated-render expansion for boolean children, modifier character support (`# % ! *`).
- **M7 — Extrusions**: linear_extrude/rotate_extrude on 2D-primitive children; needs a 2D "sketch mode" viewport affordance (the one place worth studying Onshape's actual sketch-plane UX as an interaction reference).
- **M8 — Custom module auto-toolbar**: module-introspection, `use`-file watching, dynamic toolbar section, widget inference, instantiation reusing M5's machinery.
- **M9 — Polish**: undo/redo (mostly Monaco's native stack + re-derivation, with explicit transaction grouping for structural edits), invalid-syntax error UX, save/reload/external-change handling, isolated-render cache tuning, jump-to-module-definition, electron-builder packaging.
- **M10 — Directional constraints**: distance/offset/alignment/array-spacing tools that generate plain dependent SCAD variables/expressions (no solver); this is the first constraints milestone and ships as part of the v1 target.
- **M11 — Solver-based constraints (post-v1)**: the `constraints/` package, `@constraint:` comment-annotation convention, minimal geometric solver (tangency, parallel, perpendicular, coincident, symmetric), staleness detection on reopen. Explicitly scoped as a later phase, not v1.

## Critical first files

- `packages/scad-cst/src/index.ts` — grammar loading + incremental parse/edit API; foundation everything depends on.
- `packages/scad-ast/src/nodes.ts` — typed semantic AST node definitions.
- `packages/scad-codegen/src/targetedPatch.ts` — minimal-diff text-patching engine; gates both sync (M2-M4) and toolbar insertion (M5+); needs strong test coverage (round-trip: parse → patch → reparse → assert semantic equivalence + "only intended byte range changed").
- `packages/scene-graph/src/deriveSceneGraph.ts` — AST-to-scene-graph projection + stable-node-id reconciliation.
- `packages/render-worker/src/openscadWorker.ts` — Worker wrapping openscad-wasm; isolated-per-node render + cache; most directly responsible for perceived performance.

## Risks to flag explicitly (not blockers, but track)

1. **Grammar completeness** — tree-sitter-openscad is small/active but not battle-tested at scale; M0 must stress-test real-world files (list comprehensions, `let()`, `each`, string escapes) before committing further milestones.
2. **WASM render latency at scale** — N+1 invocations per edit even with caching/debouncing could lag for large assemblies; the "skip WASM for rigid-transform drags" optimization may need to become mandatory, not optional, pending M0/M3 benchmarks.
3. **Electron WASM/CSP setup** — may need explicit `wasm-unsafe-eval` CSP allowance; if Manifold's WASM build uses threads/SharedArrayBuffer, cross-origin-isolation headers need configuring for Electron's local-file serving — validate in M0, not at packaging time.
4. **Structural-edit codegen correctness** — brace-insertion/indentation-inference for wrap-in-boolean and insert-at-selection is inherently more failure-prone than simple value replacement; needs solid property-based round-trip tests in `scad-codegen`.
5. **Node-identity heuristic isn't provable** — pathological edits (duplicate/reordered identical statements) could cause a selection/gizmo to "jump" to the wrong node; mitigate with a visible confirm-flash on the still-selected node after any external text edit, rather than assuming the fingerprint heuristic is perfect.
6. **`include`-sourced modules for the toolbar** — since `include` executes side effects, aggressively toolbar-ifying modules pulled in via `include` (vs. `use`) risks surfacing modules whose behavior implicitly depends on including-file state; document as a v1 limitation, recommend `use` for tool libraries.
7. **GPL licensing** — OpenSCAD is GPLv2+, and its WASM build inherits that; bundling it inside the Electron app has real distribution/compliance implications that are a licensing/business decision, not a technical one — needs sign-off before shipping, independent of the technical plan.

## M0 spike results (2026-09-02)

Ran the M0 de-risking spike (`spikes/` in this repo: `npm run spike:parse`, `spike:render`, `spike:gaps`) against `web-tree-sitter@0.25.3` + `@holistic-stack/tree-sitter-openscad@0.1.0` (ships a prebuilt `tree-sitter-openscad.wasm`, no local emscripten/docker toolchain needed) and `openscad-wasm@0.0.4` (npm, Emscripten build with the WASM binary embedded as base64 in a single ~14MB `openscad.js`, works directly in plain Node — no Electron needed to validate the engine itself).

**Go decision: proceed with this stack.** 6 of 7 hand-written fixtures (covering primitives, transforms, booleans, extrusions, modifiers `# % ! *`, modules/functions, `use <file>` resolution, string escapes, basic list comprehensions/ranges/`let()`/`if`-filters) parsed with zero grammar errors and rendered to valid non-degenerate STL via openscad-wasm. Tree-sitter's error recovery is confirmed local/isolated — a bad construct on one line does not break parsing of the rest of the file, which validates the planned "keep showing last-known-good mesh for affected nodes only" sync behavior (section: Bidirectional sync architecture).

**Two confirmed grammar gaps** (isolated via `spikes/isolate-gaps.mjs`, cross-checked against openscad-wasm as ground truth — both constructs compile and render fine in real OpenSCAD, so these are genuine tree-sitter-openscad gaps, not invalid fixtures):
1. Bare `each` as a direct list-literal element outside a `for` comprehension: `[each [1,2,3], each [4,5], 6]` → ERROR. (`each` *inside* a `for` comprehension, e.g. `[for (v = [1,2,3]) each [v]]`, works fine.)
2. Chained/nested `for` clauses in one comprehension: `[for (x=[0:2]) for (y=[0:2]) [x,y]]` → ERROR. (The combined multi-variable form `[for (x=[0:2], y=[0:2]) [x,y]]` works fine.)

Both are narrow, real OpenSCAD features but not core to primitives/transforms/booleans/extrusions MVP scope. Treat as known-unsupported syntax for now: such statements will show as an error-recovery ERROR node in the scene-graph (last-known-good mesh retained, per the sync design) rather than blocking the rest of the file. Since the grammar is MIT-licensed and actively maintained, consider upstreaming a fix once the app's own priorities allow it, and re-run `spike:gaps` after any grammar version bump to check if either has been fixed.

**Two engine-integration findings that change the render-worker design**:
1. **A single `createOpenSCAD()` instance cannot be reused across multiple `renderToStl()` calls** — the second call on a reused instance throws (state corruption in the Emscripten module, likely virtual-FS/global state not resetting). Confirmed: a fresh instance per render call works reliably. Since the planned per-node isolated-render strategy already implies many render calls per document, `render-worker` must create a fresh `createOpenSCAD()` instance per render job (or find/implement a reset hook) — this is not an optional optimization, it's required for correctness. **New risk to track**: instance creation cost (parsing/instantiating a ~14MB WASM module) per isolated-node render may be a bigger performance concern than raw CSG time — needs benchmarking before M3, and may push the "special-case pure rigid-transform drags to skip WASM" optimization (already in the per-node selection section) from "nice to have" to "required for usable drag latency."
2. **`addFonts`/`addMCAD` are declared in this package's TypeScript types but not actually implemented/exported** by `openscad-wasm@0.0.4`'s bundle (only `createOpenSCAD` is exported) — `text()` calls fail with a Fontconfig error since no font assets are registered. MCAD library support is similarly unavailable out of the box. This is a real gap versus the plan's assumption of using this package as-is for fonts/MCAD; options to revisit before M7/M8 (extrusions/custom-modules milestones, where `text()` support would matter): build `openscad-wasm` from source with font assets bundled, evaluate `openscad-wasm-prebuilt` (a different npm package) or the openscad-playground project's own build for a version with working font support, or ship without `text()` in early milestones and treat it as a deferred primitive.

## M1 build notes (2026-09-03)

M1 (static viewer) is done: `apps/desktop/` is a real Electron app (electron-vite + React 19 + TypeScript) that opens a `.scad` file (via a native open dialog or a bundled default example), renders it through `openscad-wasm` in the **main process** (not a renderer Web Worker yet — that split is introduced properly at M3+ per the milestone plan; M1 just needs a render pipeline to exist, and doing it in main sidesteps renderer CSP/WASM concerns for now), and displays the result as an STL mesh in a `@react-three/fiber` viewport with orbit controls, next to a read-only Monaco editor with a hand-written OpenSCAD Monarch tokenizer for syntax highlighting (not the tree-sitter CST yet — that's wired up for real parsing/sync starting M2).

**Verified by actually running the built app** (not just compiling it) — this container is headless, so verification required: installing Electron's GUI runtime deps (`libgtk-3-0`, `libnss3`, `libxss1`, `libxtst6`, `libsecret-1-0`, `libasound2`, etc.) plus `xvfb` for a virtual display, both added to `/workspace/.apt-extras/apt-extras.txt` for rebuild persistence; running under `--no-sandbox` (required as root) and `--use-gl=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist` (this sandbox's software Mesa/llvmpipe GL driver is blocklisted by Chromium's WebGL implementation by default — a test-environment artifact, not an app bug real users on real GPUs won't hit); and capturing a screenshot via `webContents.capturePage()` (gated behind a `SCADSTUDIO_SCREENSHOT` env var, harmless no-op otherwise) to confirm the editor shows real syntax highlighting and the viewport shows the geometry the source code actually describes, not just "no errors thrown."

**Bugs found and fixed during verification** (real findings, not hypothetical):
1. `electron-vite`'s preload build output is `index.mjs` (ESM, because the workspace root `package.json` has `"type": "module"`), but `main/index.ts` initially referenced `../preload/index.js` — silent preload-load failure (`window.scadstudio` was `undefined` in the renderer) until fixed.
2. `vite-plugin-monaco-editor-esm` targets `monaco-editor`'s pre-`exports`-map internal layout (`monaco-editor/esm/vs/editor/editor.worker`) and fails to resolve against the current `monaco-editor@0.56` package, which flattened its public `exports` map to `monaco-editor/<subpath>.js` → `esm/vs/<subpath>.js`. Dropped the plugin entirely in favor of Vite's native `?worker` import (`monaco-editor/editor/editor.worker.js?worker` + a manual `self.MonacoEnvironment.getWorker()`), which is also the currently-recommended approach and has no dependency on a third-party plugin's release cadence.
3. Importing the `monaco-editor` package barrel pulls in every built-in language's tokenizer/contribution (500KB+ across ~60 chunk files for languages we'll never use — Kotlin, COBOL-adjacent things, etc.), since the barrel is equivalent to `editor.main.js`. Switched to `monaco-editor/editor/editor.api.js` (core editor API only) since `scadstudio` only ever needs its own custom `scad` Monarch language.
4. CSP: started with `script-src 'self' 'unsafe-eval'` defensively, but M1 doesn't run any WASM or eval-requiring code in the renderer (rendering happens in main), so tightened to plain `script-src 'self'` — confirmed via re-test that nothing broke and Electron's renderer security warning disappeared. **Revisit this when render-worker moves into the renderer as a Web Worker (M3+)** — that's exactly the CSP risk already flagged in the Risks section, now confirmed still open, not yet needed.

**Workspace layout**: converted the repo root to an npm workspace (`"workspaces": ["apps/*"]`) rather than pnpm (per the plan's "pnpm/npm workspaces" either-or) since npm was already the available package manager in this environment and adding pnpm would need a global install; `spikes/` remains a plain script directory outside the workspace (its own flat `node_modules` via the root `package.json`, unrelated to the app).

## Render latency benchmark (2026-09-03, ahead of M2)

Before building M2's live-sync loop, benchmarked `openscad-wasm` render cost (`spikes/bench-render.mjs`, `spikes/bench-isolate.mjs`) since M2's whole point is a responsive editing feel and this was previously unmeasured.

**Good news for the per-node isolated-render strategy (M3+)**: individual constructs rendered in isolation are cheap — a boolean difference is ~18ms, a union with a tessellated cylinder ~163ms, even the most expensive single construct tested (sphere∩cube intersection) was ~264ms. Fresh-instance overhead (the M0 finding that instances can't be reused) is negligible after the first call in a process (~25-40ms steady state, down from ~130ms cold) thanks to V8's WASM module-compile caching on identical bytes.

**Real finding that changes M2's implementation, not just a number to note**: rendering a full document with several *separate top-level statements* (as OpenSCAD implicitly unions all top-level siblings into one final result) costs far more than the sum of its parts — `spikes/fixtures/basics.scad` (5 sibling top-level statements: a union, an intersection, a transform chain, a linear_extrude, a rotate_extrude) took **~1.2s steady-state**, vs. ~460ms if you summed each construct's isolated cost. This is inherent to CSG boolean cost scaling with combined complexity, not a bug — but it means a naive "fire a full-document render on every debounced text change" loop can produce overlapping ~1.2s renders if the user keeps typing through a debounce window, since Electron's main process executes JS/WASM on one thread and concurrent `openscad-wasm` calls contend for the same CPU rather than running in parallel.

**Mitigation implemented in M2**: the render trigger isn't a naive "one render per debounce tick." It's a coalescing queue — at most one render in flight at a time; if new text arrives while a render is running, only the *latest* text is kept and rendered next (any intermediate versions are dropped), rather than queuing every keystroke's render. This directly validates (not just theoretically motivates) the plan's existing two-tier fast-preview/full-render design and the render-worker's planned job-queue-with-cancellation — both were already in the architecture, this benchmark is why they're load-bearing rather than nice-to-haves.

## M2 build notes (2026-09-03)

M2 (live text→visual sync) is done: Monaco is now editable, `apps/desktop` bundles the real `web-tree-sitter` + `tree-sitter-openscad` grammar from the M0 spike (WASM assets copied into `src/renderer/public/`, loaded via `Parser.init` + `Language.load` in a new `scadParser.ts`), and every edit runs incremental parsing plus a debounced (400ms), coalescing-queued re-render (`coalescingRunner.ts`: at most one render in flight, latest text always wins — the mitigation the render latency benchmark above showed was necessary, not optional).

**Verified with a real simulated edit, not just a rebuild-and-look**: added a small, intentionally-kept manual-verification hook (`window.__testEditor`, driven by a `SCADSTUDIO_TEST_EDIT` env var in `main/index.ts` that scripts an edit via `executeJavaScript` before the existing `SCADSTUDIO_SCREENSHOT` capture) to actually exercise the live-edit path end-to-end under Xvfb: changed the cylinder's radius/`$fn` mid-session and confirmed the viewport updated to the new hexagonal-prism geometry, matching the edited source exactly. Separately fed intentionally broken syntax (unbalanced parens) and confirmed graceful degradation: the status bar shows `"1 parse error(s) — Render failed: ..."`, the app doesn't crash, and — as an emergent property of simply not overwriting state on failure, not a deliberate feature yet — the viewport keeps showing the last successful mesh instead of going blank. That's the scene-graph's planned "last-known-good mesh" behavior showing up naturally before the scene-graph itself exists.

**Real bug found and fixed**: the WASM assets (`tree-sitter.wasm`, `tree-sitter-openscad.wasm`) were referenced with a leading-slash absolute path (`/tree-sitter.wasm`), which resolves against the OS filesystem root — not the app bundle — once packaged and loaded via `win.loadFile()` (`file://` protocol), as opposed to Vite's dev server (`http://localhost`) where it happened to work. Fixed by routing through `import.meta.env.BASE_URL` (Vite's documented convention for referencing `public/` assets in a base-aware way), so the same code resolves correctly in both dev and the packaged file:// build.

**Risk #3 confirmed, not just theoretical**: WebAssembly instantiation in the renderer failed outright under the M1-tightened CSP (`script-src 'self'`) with `CompileError: ... violates ... because 'unsafe-eval' is not an allowed source`. Fixed with the narrower `'wasm-unsafe-eval'` CSP source (not the broader `'unsafe-eval'`) — Chromium's dedicated, more secure directive for exactly this case. This is the plan's already-flagged CSP risk, now confirmed real and resolved with the precise fix rather than reopening full eval.

**Known rough edge, not yet fixed**: a failed render (e.g. from broken syntax) surfaces as a generic `[object Object]` IPC error string rather than OpenSCAD's actual stderr message, because the main process's `ipcMain.handle` rejection serializes the raw error oddly across the IPC boundary. Since M2 has no per-node error attribution yet (that's M3's scene-graph), a nicer error surface isn't worth building now — revisit when wiring real diagnostics in M3+.

## Verification

Since this is a from-scratch build, "testing" happens milestone-by-milestone rather than against existing code:
- M0: automated script that parses a corpus of real `.scad` files (including MCAD library files) and asserts no grammar errors on syntax actually used; separately, a script that WASM-renders a sample file and confirms a valid non-degenerate STL comes back.
- M1-M2: manual verification — open a real `.scad` file, confirm the viewport matches what `openscad` (the real desktop app, if available for comparison) renders for the same file; type an edit and confirm the mesh updates.
- M3+: manual click-to-select/text-selection round-trip tests using files with nested transforms/booleans; unit tests in `scad-codegen` for the targeted-patch engine (parse → patch → reparse → diff assertions) should run in CI from M3 onward.
- Each milestone should include a short manual pass in the actual Electron app (not just unit tests) per usual UI-verification practice, since this is fundamentally an interactive-editing product.
