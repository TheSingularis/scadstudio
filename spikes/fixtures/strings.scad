// string escapes; geometry sized from a string-derived value so this still
// renders without needing font assets (text() needs addFonts(), see spike notes)
label1 = "line1\nline2\ttabbed";
label2 = "quote: \" backslash: \\ unicode: é";
echo(label1, label2, str("value = ", 42));

cube([len(label1), 5, 5]);
