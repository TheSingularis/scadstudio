Faster rendering while you edit. Unsigned Linux AppImage and Windows portable exe attached.

What is new since beta-v0.1.7:

- **Quick preview.** Slow parts now render as a quick preview with curves drawn with fewer segments (24 by default), so edits come back much faster. It is still real OpenSCAD geometry, with `$preview` false and model colors kept. On the test machine the gag trophy opens in about 4.5 s as a preview instead of about 28 s.
- **Only where it helps.** By default (Auto), a part previews only if its full render takes 2 s or more. Small files render in full, exactly as before.
- **Preview badge and Render (F6).** The bottom right of the viewport shows **Full**, or an amber **Preview** with a **Render** button. Render or F6 draws everything at full detail. Nothing re-renders at full detail on its own.
- **Settings > Rendering.** Quick preview can be Auto, Always or Off, and preview detail can be 16, 24 or 32 segments.
- **Measuring tools.** While Distance, Align or Pattern is open, the parts it uses render at full detail.
