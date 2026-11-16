First release under the `beta-v0.1.x` naming (see RELEASING.md). Unsigned Linux AppImage and Windows portable exe attached.

What is in it, on top of v0.1.0-beta.7:

- **Orientation nav cube and shading modes.** A cube in the viewport corner snaps the camera to any face, edge or corner, with arrows to turn or roll the view in 90 degree steps. Shaded, shaded with edges and wireframe modes. The viewport is now Z-up, like OpenSCAD.
- **On-plane sketch editing.** "Edit Sketch" reopens a placed sketch on its plane with draggable points: drag to move, click an edge to insert a point, double-click to delete. "Save Sketch" rewrites only that polygon's points.
- **Draw-time snapping.** While drawing a sketch, points snap to existing points, midpoints and edges, grid, horizontal/vertical alignment and the first point to close the loop, on all plane kinds.

Planning changes (docs only): v1 scope now includes BOSL2 fillets/chamfers (M13) and text/font support (M15). See PLAN.md.
