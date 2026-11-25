Milestone M9 (drill-in navigation) is complete. Unsigned Linux AppImage and Windows portable exe attached.

What is new since beta-v0.1.2:

- **Drill into nested parts.** Select a boolean, an extrusion, a group or a module call and click "Open ... ▸" (or double-click it in the 3D view). Its children become the parts you select, move and edit, and the rest of the model is dimmed in the view and in the editor.
- **Breadcrumb and Escape.** A breadcrumb such as "Assembly › bracket() #1 › Difference #1" links back to every level. Escape steps out one level and reselects where you came from.
- **Pick the cutter in a difference.** Inside a difference the base is see-through, and clicking through it picks the cutter behind it.
- **Edit module definitions in place.** Drilling into a module defined in your file edits its definition, and a banner reminds you that every call of it changes. Modules from a `use`d library are view-only, with a button to open the library file to edit them.
- **Insert and sketch inside.** Toolbar shapes and finished sketches go inside the part you are drilled into, in its own coordinates, at your file's indentation.
- **Fast edits.** Editing one part re-renders only that part; everything else comes from a cache.
- **Typed edits keep your place.** Typing in the editor keeps the drill-in and selection on the same parts, and the selection flashes briefly so you can see it followed.
