// QC-audit findings that only show up in the running app. Each test asserts
// the correct behaviour and is marked test.fail() until its fix lands; the
// fix PR removes the test.fail() line. See TESTING.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, audit } from './fixtures';

/** Answer any "unsaved changes?" prompt with Don't Save, and record that it was asked. */
async function answerUnsavedPrompts(scad: import('./fixtures').ScadApp, response: number) {
  await scad.app.evaluate(({ dialog }, r) => {
    const g = globalThis as unknown as { __e2ePrompted: number };
    g.__e2ePrompted = 0;
    dialog.showMessageBox = (async () => {
      g.__e2ePrompted++;
      return { response: r, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    dialog.showMessageBoxSync = (() => {
      g.__e2ePrompted++;
      return r;
    }) as typeof dialog.showMessageBoxSync;
  }, response);
}

// Each part takes ~750 ms on CGAL and ~35 ms on Manifold (dev machine), so
// 12 isolated node renders land around 9 s versus 1-2 s: a 4 s budget
// separates the two with room for slow CI runners.
test(audit('H1', 'a 12-part boolean file renders in the app within 4 s'), async ({ scad }) => {
  test.fail();
  const parts = Array.from(
    { length: 12 },
    (_, i) => `translate([${(i % 4) * 15}, ${Math.floor(i / 4) * 15}, 0]) difference() { cube(10, center=true); sphere(r=6.5, $fn=48); }`,
  ).join('\n');
  const t0 = Date.now();
  const status = await scad.load(parts, { fit: false });
  const ms = Date.now() - t0;
  expect(status).toBe('Rendered');
  expect(ms).toBeLessThan(4000);
});

test(audit('H3', 'a visual edit can be undone with Ctrl+Z, and typed history survives it'), async ({ scad }) => {
  test.fail();
  await scad.load('cube(1);\n', { fit: false });
  await scad.rendersAfter(() => scad.typeAtEnd('// typed\n'));
  await scad.rendersAfter(() => scad.button('Sphere').click());
  expect(await scad.source()).toContain('sphere(');
  await scad.page.locator('.monaco-editor .view-lines').click();
  await scad.page.keyboard.press('Control+z');
  await expect.poll(() => scad.source()).not.toContain('sphere(');
  expect(await scad.source()).toContain('// typed');
  // Typing may be split into several undo steps; a few more presses must
  // take the typed text back out too.
  for (let i = 0; i < 10 && (await scad.source()) !== 'cube(1);\n'; i++) {
    await scad.page.keyboard.press('Control+z');
    await scad.page.waitForTimeout(150);
  }
  expect(await scad.source()).toBe('cube(1);\n');
});

test(audit('H4', 'opening a file with use <lib.scad> renders the library geometry'), async ({ scad, tmpDir }) => {
  test.fail();
  mkdirSync(join(tmpDir, 'libs'));
  writeFileSync(join(tmpDir, 'lib.scad'), 'module peg(h) { cylinder(h=h, r=2, $fn=16); }\n');
  writeFileSync(join(tmpDir, 'libs', 'plate.scad'), 'module plate() { cube([10, 10, 1]); }\n');
  const file = join(tmpDir, 'main.scad');
  writeFileSync(file, 'use <lib.scad>\ninclude <libs/plate.scad>\npeg(5);\nplate();\n');
  await answerUnsavedPrompts(scad, 1);
  await scad.stubDialogs({ open: file });
  const status = await scad.rendersAfter(() => scad.button('Open .scad file...').click());
  expect(await scad.source()).toContain('use <lib.scad>');
  expect(status).toMatch(/^Rendered$/);
});

test(audit('H5', 'Ctrl+S saves the document to disk'), async ({ scad, tmpDir }) => {
  test.fail();
  const target = join(tmpDir, 'saved.scad');
  await scad.stubDialogs({ save: target });
  await scad.load('cube(3);\n', { fit: false });
  await scad.typeAtEnd('sphere(2);\n');
  await scad.page.keyboard.press('Control+s');
  await expect.poll(() => existsSync(target), { timeout: 10_000 }).toBe(true);
  expect(readFileSync(target, 'utf8')).toBe(await scad.source());
});

test(audit('H5', 'closing with unsaved changes asks first'), async ({ scad }) => {
  test.fail();
  await scad.typeAtEnd('// unsaved\n');
  await answerUnsavedPrompts(scad, 2); // the fix's Cancel button: keep the window open
  await scad.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await scad.page.waitForTimeout(1000);
  const prompted = await scad.app.evaluate(() => (globalThis as unknown as { __e2ePrompted: number }).__e2ePrompted).catch(() => 0);
  expect(prompted).toBeGreaterThan(0);
});

test(audit('M3', 'a toolbar edit right after typing (inside the debounce) does not corrupt the file'), async ({ scad }) => {
  test.fail();
  await scad.load('cube(10, center=true);\n');
  await scad.clickViewport();
  expect(await scad.selectedCall()).toBe('cube');
  // Type at the very start (shifting every byte offset), then immediately
  // use a toolbar action that patches the selected node by offset.
  await scad.page.locator('.monaco-editor .view-lines').click();
  await scad.page.keyboard.press('Control+Home');
  await scad.page.keyboard.type('a = 1;\n');
  await scad.button('Mirror X').click();
  await scad.page.waitForTimeout(1500);
  await expect.poll(() => scad.status()).toMatch(/Rendered/);
  expect(await scad.source()).toBe('a = 1;\nmirror([1, 0, 0])\n    cube(10, center=true);\n');
});

test(audit('M4', 'a node that fails to render says which node and why'), async ({ scad }) => {
  test.fail();
  const status = await scad.load('cube(5);\nnot_a_module(3);\n', { fit: false });
  expect(status).toMatch(/Rendered 1\/2 nodes/);
  expect(status).toMatch(/not_a_module|unknown module/i);
  expect(scad.consoleLines.join('\n')).not.toContain('[object Object]');
});

test(audit('M5', 'comments are highlighted as comments, not as code'), async ({ scad }) => {
  test.fail();
  await scad.load('// for comment here\nfor (i = [0:1]) cube(1);\n', { fit: false });
  const classes = await scad.page.evaluate(() => {
    const lines = [...document.querySelectorAll('.monaco-editor .view-line')];
    const classOf = (line: Element | undefined, text: string) =>
      [...(line?.querySelectorAll('span span') ?? [])].find((s) => s.textContent?.includes(text))?.className ?? '';
    // Monaco renders spaces as U+00A0.
    const comment = lines.find((l) => l.textContent?.replace(/\u00a0/g, ' ').includes('comment here'));
    const code = lines.find((l) => l.textContent?.includes('cube'));
    return { inComment: classOf(comment, 'for'), keyword: classOf(code, 'for') };
  });
  expect(classes.keyword).not.toBe('');
  expect(classes.inComment).not.toBe('');
  expect(classes.inComment).not.toBe(classes.keyword);
});
