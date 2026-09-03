# scadstudio

A visual CAD editor (Onshape-style) that reads and writes real, valid OpenSCAD (`.scad`) source code — no proprietary save format.

Status: M1 (static viewer) done. See [PLAN.md](./PLAN.md) for the full architecture and milestone breakdown.

## Layout

- `apps/desktop/` — the Electron app (main/preload/renderer). `cd apps/desktop && npm run dev` to launch it, `npm run build` to produce a production bundle in `apps/desktop/out/`.
- `spikes/` — throwaway M0 de-risking scripts and `.scad` fixtures (`npm run spike:parse|render|gaps` from the repo root). Not part of the app; see PLAN.md "M0 spike results" for what they proved.

## Running headless (no display attached)

Electron needs a small set of GUI libs even to launch (see PLAN.md's environment notes / this repo's apt-extras manifest if running in a container). Under a virtual display:

```
xvfb-run -a npx electron --no-sandbox apps/desktop/out/main/index.js
```

Software WebGL (`--use-gl=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`) is needed on top of that if there's no real GPU available to the container.
