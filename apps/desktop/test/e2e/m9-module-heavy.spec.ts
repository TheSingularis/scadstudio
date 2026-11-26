// A file that builds everything inside one module and calls it once at the
// end (Jordan's rack mount, test/fixtures/rack_mount_single_keystone.scad).
// Before: the whole part was one selectable blob, since the only top-level
// statement is `if ($preview) {...} else { switch_mount(...); }` and the
// modules it is built from are defined inside switch_mount(). Now "Show
// parts" drills to the parts, every sub-module call is its own highlighted
// node, Go to definition finds a nested module, and a false `if (flag)` is
// "empty", not a failure.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, DESKTOP_DIR, type ScadApp } from './fixtures';
import { decodePng } from './png';

const FIXTURE = join(DESKTOP_DIR, 'test/fixtures/rack_mount_single_keystone.scad');

// Set MODULE_HEAVY_SHOTS=<folder> to also save screenshots of each step.
async function shot(scad: ScadApp, name: string): Promise<void> {
  const dir = process.env['MODULE_HEAVY_SHOTS'];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await scad.page.screenshot({ path: join(dir, `${name}.png`) });
}

async function crumbs(scad: ScadApp): Promise<string> {
  return ((await scad.page.getByRole('navigation', { name: 'Breadcrumb' }).textContent()) ?? '').replace('Esc: step out', '').trim();
}

function stats(scad: ScadApp): Promise<{ workingMeshes: number; contextMeshes: number }> {
  return scad.page.evaluate(() => ({ ...(window as unknown as { __scadstudioRenderStats: { workingMeshes: number; contextMeshes: number } }).__scadstudioRenderStats }));
}

/** Scroll the editor to the first line containing `text` and click on its first word (real mouse). */
async function clickEditorText(scad: ScadApp, text: string): Promise<void> {
  await scad.page.evaluate((t) => {
    const editor = (window as unknown as { __testEditor: { getModel(): { getValue(): string; getPositionAt(i: number): { lineNumber: number } }; revealLineInCenter(n: number): void } }).__testEditor;
    const model = editor.getModel();
    editor.revealLineInCenter(model.getPositionAt(model.getValue().indexOf(t)).lineNumber);
  }, text);
  await scad.page.waitForTimeout(300);
  const line = scad.page.locator('.monaco-editor .view-line', { hasText: text }).first();
  const word = line.locator('span span').filter({ hasText: /\S/ }).first();
  await word.click({ position: { x: 3, y: 5 } });
  await scad.page.waitForTimeout(300);
}

/** Viewport pixels in the selection highlight's orange. */
async function highlightedPixels(scad: ScadApp): Promise<number> {
  const img = decodePng(await scad.viewportShot());
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
    if (r > 140 && g > 60 && g < 140 && b < 70 && r - g > 50) n++;
  }
  return n;
}

/** Part-coloured (blue) pixels on the viewport's left and right edges: 0 when the whole part is in view. */
async function partPixelsOnEdges(scad: ScadApp): Promise<number> {
  const img = decodePng(await scad.viewportShot());
  let n = 0;
  for (let y = 0; y < img.height; y++) {
    for (const x of [0, 1, img.width - 2, img.width - 1]) {
      const i = (y * img.width + x) * 4;
      if (img.data[i + 2] > 90 && img.data[i + 2] - img.data[i] > 60) n++;
    }
  }
  return n;
}

test.describe('module-heavy files (rack mount fixture)', () => {
  test('Show parts drills through if ($preview) and the module to the body and the keystone', async ({ scad }) => {
    await scad.stubDialogs({ open: FIXTURE });
    await scad.rendersAfter(() => scad.button('Open .scad file...').click());
    expect(await scad.status()).toBe('Rendered');
    // The camera fits the opened part once it has rendered (it used to fit
    // the previous document and open inside this 254 mm part).
    await expect.poll(() => partPixelsOnEdges(scad)).toBe(0);
    await shot(scad, '1-opened-one-blob');
    // One top-level statement: nothing selected, the offer is for it.
    const showParts = scad.button('Show parts of switch_mount() ▸▸');
    await expect(showParts).toBeVisible();

    await scad.rendersAfter(() => showParts.click());
    expect(await crumbs(scad)).toBe('Assembly›If ($preview) #1›switch_mount() #2›Group #1');
    await expect(scad.page.getByTestId('branch-note')).toHaveText('Inside the else branch of if ($preview): the part as rendered and exported.');
    expect(await scad.status()).toBe('Rendered');
    expect((await stats(scad)).workingMeshes).toBe(2);
    await shot(scad, '2-show-parts');

    // The $preview if itself: both branches are nodes, only the else renders.
    await scad.rendersAfter(() => scad.page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('button', { name: 'If ($preview) #1' }).click());
    expect(await scad.status()).toBe('Rendered (1 empty)');
    await expect(scad.page.getByTestId('branch-note')).toContainText('the else branch is the part as rendered and exported');
    await shot(scad, '3-preview-if');
  });

  test('each sub-module call inside the difference is its own highlighted node, with Go to definition', async ({ scad }) => {
    await scad.stubDialogs({ open: FIXTURE });
    await scad.rendersAfter(() => scad.button('Open .scad file...').click());
    await scad.rendersAfter(() => scad.button('Show parts of switch_mount() ▸▸').click());

    await clickEditorText(scad, 'difference() {');
    await scad.rendersAfter(() => scad.button('Open Difference #1 ▸').click());
    expect(await crumbs(scad)).toBe('Assembly›If ($preview) #1›switch_mount() #2›Group #1›Difference #1');
    const before = await highlightedPixels(scad);

    await clickEditorText(scad, 'main_body();');
    await expect(scad.button('Open main_body() #1 ▸')).toBeVisible();
    // The selected body is drawn in the highlight colour.
    expect(await highlightedPixels(scad)).toBeGreaterThan(before + 2000);
    await shot(scad, '4-main-body-selected');

    await scad.button('Go to main_body() definition').click();
    await expect
      .poll(() => scad.page.evaluate(() => (window as unknown as { __testEditor: { getPosition(): { lineNumber: number } } }).__testEditor.getPosition().lineNumber))
      .toBe(135);
    // The call stays selected while the editor shows the definition.
    await expect(scad.button('Open main_body() #1 ▸')).toBeVisible();
    await shot(scad, '5-go-to-definition');

    await scad.rendersAfter(() => scad.button('Open main_body() #1 ▸').click());
    expect(await crumbs(scad)).toBe('Assembly›If ($preview) #1›switch_mount() #2›Group #1›Difference #1›main_body() #1');
    await expect(scad.page.getByText('Editing module main_body(): changes apply to every main_body() call.')).toBeVisible();
    expect(await scad.status()).toBe('Rendered');
    await shot(scad, '6-inside-main-body');

    // Back out and into the union of cutters.
    await scad.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await scad.rendersAfter(() => scad.page.keyboard.press('Escape'));
    await clickEditorText(scad, 'switch_cutout();');
    await scad.rendersAfter(() => scad.button('Open Union #2 ▸').click());
    // front_wire_holes is false: that cutter renders nothing, which is not a failure.
    expect(await scad.status()).toBe('Rendered (1 empty)');
    expect((await stats(scad)).workingMeshes).toBe(5);
    const cutters = await highlightedPixels(scad);
    await clickEditorText(scad, 'all_rack_holes();');
    // M11: the switch_mount frame is now an evaluated translate, so the
    // Position fields show and the viewport is shorter (about 1,100 px here
    // against 2,500 before M11, the same highlight drawn smaller).
    expect(await highlightedPixels(scad)).toBeGreaterThan(cutters + 700);
    await expect(scad.button('Go to all_rack_holes() definition')).toBeVisible();
    await shot(scad, '7-rack-holes-selected');
  });
});
