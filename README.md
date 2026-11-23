# scadstudio

A visual CAD editor (Onshape-style) that reads and writes real, valid OpenSCAD (`.scad`) source code — no proprietary save format.

Status: beta-v0.1.1 (see [RELEASING.md](./RELEASING.md)); earlier betas were v0.1.0-beta.1 to .7 and beta-v0.1.0. M0–M7.5 done: sketch mode has line, arc, rectangle and circle tools, multi-loop sketches with holes, Offset, on-plane editing, draw-time snapping and a nav cube. Next is M8; see progress-dashboard.html. See [PLAN.md](./PLAN.md) for the full architecture and milestone breakdown.

## Layout

- `apps/desktop/` — the Electron app (main/preload/renderer). `cd apps/desktop && npm run dev` to launch it, `npm run build` to produce a production bundle in `apps/desktop/out/`.
- `spikes/` — throwaway M0 de-risking scripts and `.scad` fixtures (`npm run spike:parse|render|gaps` from the repo root). Not part of the app; see PLAN.md "M0 spike results" for what they proved.

## Running headless (no display attached)

Electron needs a small set of GUI libs even to launch (see PLAN.md's environment notes / this repo's apt-extras manifest if running in a container). Under a virtual display:

```
xvfb-run -a npx electron --no-sandbox apps/desktop/out/main/index.js
```

Software WebGL (`--use-gl=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`) is needed on top of that if there's no real GPU available to the container.

## License

ScadStudio is licensed under the GNU General Public License, version 3 or (at your option) any later version (GPL-3.0-or-later); see [LICENSE](LICENSE). The app bundles the OpenSCAD engine (openscad-wasm, GPL), whose WebAssembly build includes GPLv3+ components such as CGAL, so distributed builds are covered by GPLv3 terms.
