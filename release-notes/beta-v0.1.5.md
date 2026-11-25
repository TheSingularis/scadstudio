Text and fonts. Unsigned Linux AppImage and Windows portable exe attached.

What is new since beta-v0.1.4:

- **Text tool.** Insert > Text adds flat 2D `text()`, which you extrude like any other sketch (the usual CAD flow: sketch text, then extrude). Sketch mode has Text too: one click places it on the sketch plane.
- **Font dropdown.** The Text panel's font picker lists the bundled fonts (Liberation Sans, Serif and Mono), your project's fonts (`use <font.ttf>`) and the fonts installed on your computer. Alignment (`halign`, `valign`) and `spacing` are dropdowns and fields too. A font that isn't installed on this computer is flagged: it renders in a substitute font.
- **Files with `text()` now render.** Before this, the engine had no font files to draw them with. Installed fonts are indexed by name once at start, and a render loads only the fonts the file names, cached in memory.
- **Settings > Fonts.** The new Settings button sets the code editor's font and size. It is the app's first saved setting.
- **Patched engine.** Rendering now uses a pinned build of OpenSCAD's WebAssembly engine (`@lofcz/openscad-wasm` 0.0.2, OpenSCAD 2026.09.03) with a one-line FreeType fix. The stock build crashed on most modern fonts (any TrueType font without hinting instructions); this one renders them. The fix has been proposed upstream (openscad/openscad#7289, #7290), and ScadStudio will switch back to the official engine once it ships there.
