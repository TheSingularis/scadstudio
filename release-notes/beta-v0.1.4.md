Module-heavy files and a crash fix. Unsigned Linux AppImage and Windows portable exe attached.

What is new since beta-v0.1.3:

- **Drill into `if` statements.** Files that wrap the whole part in `if ($preview) { ... } else { ... }` are no longer one selectable blob. Open the `if` and both branches' statements become the parts you work with. ScadStudio renders the exported part, so `$preview` counts as false: the unused branch isn't rendered, inserts go into the branch that is used, and a note says which branch is the real part.
- **Drill into nested modules.** Modules defined inside another module are found by name, innermost first, so their calls can be opened too.
- **Show parts ▸▸.** One click drills through every level that holds a single part, down to the first level with several parts. A file that builds everything in one module and calls it once at the end opens straight to its pieces.
- **Go to definition.** A selected call of a module defined in your file gets "Go to <name>() definition", which jumps the editor to it.
- **Empty is not failure.** A branch that is switched off now shows as "Rendered (1 empty)" instead of an error.
- **Camera fit on open** waits for the new file's first render, so large parts are framed properly instead of opening with the camera inside them.
- **Heavy files no longer freeze the app.** Rendering now runs in a separate process. A big model (such as a detailed 3D-print trophy with `$fn = 120`) can take a while to render, but the window stays responsive while it does. If the engine crashes or runs out of memory, only that render fails, with a readable message, and the next render starts fresh.
- **Lighter renders.** Meshes come back as binary STL (about a quarter of the size), and the render cache is capped by total size.
- **Safety net.** If part of the window hits an error you get a message with Try again and Reload instead of a blank window, and a crashed window says so and reloads.
