Variables, patterns and (experimental) Distance/Align. Unsigned Linux AppImage and Windows portable exe attached.

What is new since beta-v0.1.5:

- **Variables panel.** A sidebar on the left lists the file's variables. It reads OpenSCAD Customizer comments: `// [min:max]` gives a slider, `// [a, b]` a dropdown, and `/* [Tab] */` groups them (`[Hidden]` too). Rename a variable and every use changes. Deleting one that is still used shows where, and offers to put its value back in. New variables go in one block at the top of the file, so the file still works in OpenSCAD's Customizer.
- **Scopes.** The panel shows the variables of the module your cursor is in (its parameters read-only), and read-only sections for each file you `include`. It flags a variable your file assigns again.
- **Make variable.** The ƒx button next to a parameter or Position field turns that number into a named variable.
- **Pattern.** Copies of a part in a row (center-to-center pitch, or a gap) or around an axis, written as a `for` loop. Select the pattern to change its count and spacing, and drag it like any part.
- **Expressions in positions.** Position fields take an expression (`w * 2 + 5`) as well as a number, and transforms written with variables are now editable instead of baked. The gizmo hides the handle of an axis set by an expression it can't move.
- **Distance and Align (experimental).** Place one part relative to another along one axis, as an expression that follows it. With Follow, Distance locks the two parts together: drag either one in any direction and the other comes along. These two tools are temporary: they will be redone with a real constraint solver (picking faces, with dimension lines). Files they write stay plain OpenSCAD and keep working.
