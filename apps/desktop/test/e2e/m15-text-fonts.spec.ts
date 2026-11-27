// M15: text() and fonts in the running app. The Text tool (Insert toolbar
// and sketch mode), the Text panel's font picker (bundled, project and
// installed fonts) and alignment dropdowns, the "not installed" note, and
// Settings > Fonts for the code editor. The fixture launches the app with
// test/fixtures/fonts as its only "installed" font folder, so Source Code
// Pro (an unhinted TrueType font, the kind the old engine crashed on) is
// the one installed font.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FONT_FIXTURES_DIR, test, expect, type ScadApp } from './fixtures';

// Set M15_SHOTS=<folder> to also save screenshots of each step.
async function shot(scad: ScadApp, name: string): Promise<void> {
  const dir = process.env['M15_SHOTS'];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await scad.page.screenshot({ path: join(dir, `${name}.png`) });
}

const insert = (scad: ScadApp) => scad.page.getByRole('group', { name: 'Insert' });
const param = (scad: ScadApp, name: string) => scad.page.getByLabel(`Parameter ${name}`, { exact: true });

async function viewportInk(scad: ScadApp): Promise<number> {
  // Pixels that differ clearly from the viewport's background, a cheap
  // "something was drawn" measure.
  const { decodePng } = await import('./png');
  const img = decodePng(await scad.viewportShot());
  const bg = [img.data[0], img.data[1], img.data[2]];
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (Math.abs(img.data[i] - bg[0]) + Math.abs(img.data[i + 1] - bg[1]) + Math.abs(img.data[i + 2] - bg[2]) > 60) n++;
  }
  return n;
}

test.describe('M15 text and fonts', () => {
  test('Insert > Text adds flat text in Liberation Sans, renders it and opens its panel', async ({ scad }) => {
    await scad.load('');
    const status = await scad.rendersAfter(() => insert(scad).getByRole('button', { name: 'Text', exact: true }).click());
    expect(status).toBe('Rendered');
    expect(await scad.source()).toContain('text("Text", size=10, font="Liberation Sans");');
    expect(await scad.selectedCall()).toBe('text');
    await expect(param(scad, 'text')).toHaveValue('Text');
    await expect(param(scad, 'font')).toHaveValue('Liberation Sans');
    await expect(param(scad, 'halign')).toHaveValue('left');
    await scad.resetView();
    expect(await viewportInk(scad)).toBeGreaterThan(500);
    await shot(scad, '1-inserted-text');
  });

  test('the font picker lists bundled and installed fonts and writes the choice into the code', async ({ scad }) => {
    await scad.load('text("Hello", size=10, font="Liberation Sans");\n');
    await scad.clickEditorLine(1);
    expect(await scad.selectedCall()).toBe('text');
    const font = param(scad, 'font');
    await expect.poll(() => font.evaluate((el) => (el as HTMLSelectElement).querySelectorAll('optgroup').length)).toBeGreaterThan(0);
    const groups = await font.evaluate((el) =>
      [...(el as HTMLSelectElement).querySelectorAll('optgroup')].map((g) => [g.label, [...g.querySelectorAll('option')].map((o) => o.value)]),
    );
    expect(groups).toEqual([
      [
        'Bundled with ScadStudio',
        expect.arrayContaining(['Liberation Sans', 'Liberation Sans:style=Bold', 'Liberation Serif', 'Liberation Mono:style=Bold Italic']),
      ],
      ['Installed on this computer', ['Source Code Pro']],
    ]);
    const status = await scad.rendersAfter(() => font.selectOption('Source Code Pro'));
    expect(status).toBe('Rendered');
    expect(await scad.source()).toContain('font="Source Code Pro"');
    await expect(param(scad, 'font')).toHaveValue('Source Code Pro');

    await scad.rendersAfter(() => param(scad, 'halign').selectOption('center'));
    expect(await scad.source()).toMatch(/halign\s*=\s*"center"/);
    await expect(param(scad, 'halign')).toHaveValue('center');
    await shot(scad, '2-font-and-align');
  });

  test('a font that is not installed still renders, and the panel says so', async ({ scad }) => {
    const status = await scad.load('text("Hello", size=10, font="Not A Real Font:style=Bold");\n');
    expect(status).toBe('Rendered');
    await scad.clickEditorLine(1);
    await expect(param(scad, 'font')).toHaveValue('Not A Real Font:style=Bold');
    await expect(scad.page.getByRole('note').filter({ hasText: 'Not installed here' })).toBeVisible();
    await shot(scad, '3-not-installed');
  });

  test('use <font.ttf> next to the document adds a "This project" font', async ({ scad, tmpDir }) => {
    copyFileSync(join(FONT_FIXTURES_DIR, 'SourceCodePro-Regular.ttf'), join(tmpDir, 'label-font.ttf'));
    const docPath = join(tmpDir, 'label.scad');
    writeFileSync(docPath, 'use <label-font.ttf>\ntext("Hi", size=10, font="Source Code Pro");\n');
    await scad.stubDialogs({ open: docPath });
    const status = await scad.rendersAfter(() => scad.button('Open .scad file...').click());
    expect(status).toBe('Rendered');
    await scad.clickEditorLine(2);
    expect(await scad.selectedCall()).toBe('text');
    const font = param(scad, 'font');
    await expect(font).toHaveValue('Source Code Pro');
    await expect
      .poll(() => font.evaluate((el) => [...(el as HTMLSelectElement).querySelectorAll('optgroup')].map((g) => g.label)))
      .toEqual(['Bundled with ScadStudio', 'This project (use <font file>)']);
    await expect(scad.page.getByRole('note').filter({ hasText: 'Not installed here' })).toHaveCount(0);
    await shot(scad, '4-project-font');
  });

  test('Extrude on selected text makes it solid', async ({ scad }) => {
    await scad.load('text("Hi", size=10, font="Liberation Sans");\n');
    await scad.clickEditorLine(1);
    await scad.startExtrude('Linear');
    const status = await scad.applyTool();
    expect(status).toBe('Rendered');
    expect(await scad.source()).toMatch(/linear_extrude\([^)]*\)\s*\{?\s*text\("Hi"/);
    await shot(scad, '5-extruded');
  });

  test('sketch mode: the Text tool places text where you click, on the sketch plane', async ({ scad }) => {
    await scad.load('cube([1, 1, 1]);\n');
    await scad.button('XY').click();
    await expect(scad.page.getByText(/Sketching on XY plane/)).toBeVisible();
    await scad.page.waitForTimeout(1500); // camera animates onto the plane
    await scad.page.getByRole('group', { name: 'Sketch tools' }).getByRole('button', { name: 'Text' }).click();
    const status = await scad.rendersAfter(() => scad.clickViewport(0, 0));
    expect(status).toBe('Rendered');
    const src = await scad.source();
    expect(src).toMatch(/(translate\(\[[-\d., ]+\]\) )?text\("Text", size=10, font="Liberation Sans"\);\n$/);
    // Nothing else was drawn, so sketch mode ends with the text selected.
    await expect(scad.page.getByText(/Sketching on XY plane/)).toBeHidden();
    expect(await scad.selectedCall()).toBe('text');
    await scad.resetView();
    await shot(scad, '6-sketch-text');
  });

  test('Settings > Fonts sets the code editor font and size, and keeps them', async ({ scad }) => {
    await scad.button('Settings').click();
    const dialog = scad.page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    const fontSelect = dialog.getByLabel('Editor font', { exact: true });
    await expect(fontSelect).toBeEnabled();
    await fontSelect.selectOption('Source Code Pro');
    await dialog.getByLabel('Editor font size').fill('18');
    await shot(scad, '7-settings');
    await dialog.getByRole('button', { name: 'Close settings' }).click();
    await expect(dialog).toBeHidden();
    const style = await scad.page.locator('.monaco-editor .view-lines').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { family: cs.fontFamily, size: cs.fontSize };
    });
    expect(style.family).toContain('Source Code Pro');
    expect(style.size).toBe('18px');
    // Persisted in the app's settings file.
    const userData = await scad.app.evaluate(({ app }) => app.getPath('userData'));
    const file = join(userData, 'settings.json');
    await expect.poll(() => existsSync(file) && JSON.parse(readFileSync(file, 'utf8'))).toEqual({ editorFontFamily: 'Source Code Pro', editorFontSize: 18, previewMode: 'auto', previewSegments: 24 });
    await shot(scad, '8-editor-font');
  });
});
