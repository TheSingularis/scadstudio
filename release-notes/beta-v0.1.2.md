Milestone M8 (custom module toolbar) is complete. Unsigned Linux AppImage and Windows portable exe attached.

What is new since beta-v0.1.1:

- **Your modules become tools.** A new Custom section in the toolbar lists every `module` in the open file and in the files it pulls in with `use <...>`. Click one to insert a call with named arguments, for example `bracket(w = 20, h = 10, thickness = 3);`. Hover a button to see its parameters, where it is defined and the comment above it. Large libraries get a filter box.
- **Libraries reload live.** Edit a used library in another editor and the Custom section and the 3D view update on their own.
- **Modules behind a nested `use`.** OpenSCAD's `use` does not pass through a library's own `use` lines. Those modules are still listed (in italics), and inserting one also adds the `use <...>` line your file needs, so it works in desktop OpenSCAD too. Modules from files you `include` are not listed.
- **Real parameter names.** The parameter panel shows `w`, `h`, `thickness` instead of `#1`, `#2`, `#3` for a module called with positional arguments, and names the positional arguments of built-ins such as `cube`, `cylinder` and `square`. Parameters a call leaves out are listed with their defaults; editing one adds it to the call.
- **Fitting controls.** True/false parameters get a checkbox, numbers a number field (angles also get a slider), 3-vectors get X/Y/Z fields and strings a text field. Anything else, or an expression, stays a plain text field.
