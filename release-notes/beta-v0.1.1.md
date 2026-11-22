Milestone M7.5 (sketch mode) is complete. Unsigned Linux AppImage and Windows portable exe attached.

What is new since beta-v0.1.0:

- **More sketch tools.** Sketch mode has a tool row: Line, Arc (3-point), Rectangle, Circle and Edit Points. A hint next to the buttons says what the next click does. Circles and arcs have a 16/32/64 segment setting.
- **Several loops per sketch, with holes.** Closing a loop no longer ends the sketch. Finish Sketch writes one `polygon(points, paths)`, so a circle drawn inside a rectangle becomes a hole once extruded. Edit Sketch reopens every loop and can add new ones.
- **Offset.** Wraps a selected sketch in `offset(r=1)`. Change r in the parameter panel; a negative value insets. The sketch stays editable.
- **Snapping to your own sketch.** Loops you have already closed in the session are snap targets, so a new loop can share a corner or an edge with them.
