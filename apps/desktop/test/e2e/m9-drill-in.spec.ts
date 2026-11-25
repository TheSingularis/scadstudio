// M9: drill-in navigation. Double-click (or "Open ... ▸") makes a nested
// block's children the working set; the breadcrumb shows where you are and
// every level but the current one is a link back; Escape steps out one
// level; everything outside the working set is dimmed and unclickable; a
// library module is view-only, with an explicit action to open its file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type ScadApp } from './fixtures';

// Set M9_SHOTS=<folder> to also save screenshots of each step.
async function shot(scad: ScadApp, name: string): Promise<void> {
  const dir = process.env['M9_SHOTS'];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await scad.page.screenshot({ path: join(dir, `${name}.png`) });
}

interface Stats {
  engineCalls: number;
  cacheHits: number;
  flashes: number;
  workingMeshes: number;
  contextMeshes: number;
}

function stats(scad: ScadApp): Promise<Stats> {
  return scad.page.evaluate(() => ({ ...(window as unknown as { __scadstudioRenderStats: Stats }).__scadstudioRenderStats }));
}

function breadcrumb(scad: ScadApp) {
  return scad.page.getByRole('navigation', { name: 'Breadcrumb' });
}

async function crumbs(scad: ScadApp): Promise<string> {
  return ((await breadcrumb(scad).textContent()) ?? '').replace('Esc: step out', '').trim();
}

function param(scad: ScadApp, name: string) {
  return scad.page.getByLabel(`Parameter ${name}`, { exact: true });
}

/** Escape with focus outside the editor (the editor keeps Escape for itself). */
async function escape(scad: ScadApp): Promise<void> {
  await scad.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await scad.rendersAfter(() => scad.page.keyboard.press('Escape'));
}

async function drillSelected(scad: ScadApp, label: string): Promise<void> {
  await scad.rendersAfter(() => scad.button(`Open ${label} ▸`).click());
}

const BOOLEAN_SCENE = [
  'difference() {',
  '    cube([20, 20, 20], center=true);',
  '    translate([0, 0, 8]) cylinder(h=10, r=4, $fn=24);',
  '}',
  'translate([40, 0, 0]) sphere(r=5);',
  '',
].join('\n');

test.describe('M9 drill-in navigation', () => {
  test('drilling into a boolean makes its children the working set, dims the rest, and Escape steps back out', async ({ scad }) => {
    await scad.load(BOOLEAN_SCENE);
    await scad.clickEditorLine(1);
    await expect(scad.button('Open Difference #1 ▸')).toBeVisible();
    await shot(scad, '1-boolean-selected');
    await drillSelected(scad, 'Difference #1');

    expect(await crumbs(scad)).toBe('Assembly›Difference #1');
    await expect(breadcrumb(scad).getByRole('button', { name: 'Assembly' })).toBeVisible();
    await expect(breadcrumb(scad).locator('[aria-current="location"]')).toHaveText('Difference #1');
    // The cube and the cylinder are the working set; the sphere is dimmed context.
    expect((await stats(scad)).workingMeshes).toBe(2);
    expect((await stats(scad)).contextMeshes).toBe(1);

    await scad.clickEditorLine(3);
    expect(await scad.selectedCall()).toBe('cylinder');
    await scad.resetView();
    await shot(scad, '2-drilled-child-selected');

    await escape(scad);
    await expect(breadcrumb(scad)).toBeHidden();
    // Stepping out selects the node you were in.
    await expect(scad.button('Open Difference #1 ▸')).toBeVisible();
    expect((await stats(scad)).workingMeshes).toBe(2);
    expect((await stats(scad)).contextMeshes).toBe(0);
  });

  test("editing a child changes only its own line and re-renders only that child", async ({ scad }) => {
    await scad.load(BOOLEAN_SCENE);
    await scad.clickEditorLine(1);
    await drillSelected(scad, 'Difference #1');
    await scad.clickEditorLine(3);
    expect(await scad.selectedCall()).toBe('cylinder');

    const before = await stats(scad);
    await scad.rendersAfter(async () => {
      await param(scad, 'r').fill('6');
      await param(scad, 'r').press('Enter');
    });
    expect(await scad.source()).toBe(BOOLEAN_SCENE.replace('r=4,', 'r=6,'));
    const after = await stats(scad);
    // The cube and the dimmed sphere come from the per-node cache.
    expect(after.engineCalls - before.engineCalls).toBe(1);
    expect(after.cacheHits - before.cacheHits).toBe(2);

    // Position edits write the child's own translate, at its indentation.
    await scad.rendersAfter(async () => {
      await scad.positionInputs().nth(0).fill('3');
      await scad.positionInputs().nth(0).press('Enter');
    });
    expect(await scad.source()).toContain('    translate([3, 0, 8])\n        cylinder(h=10, r=6, $fn=24);\n}');
    expect(await scad.selectedCall()).toBe('cylinder');
  });

  test('double-click drills in, and a click inside a difference picks the cutter behind the base', async ({ scad }) => {
    await scad.load('difference() {\n    cube(10, center=true);\n    translate([0, 0, 2]) cylinder(h=10, r=3, $fn=24);\n}\n');
    const c = await scad.viewportCenter();
    await scad.rendersAfter(() => scad.page.mouse.dblclick(c.x, c.y));
    await expect(breadcrumb(scad)).toBeVisible();
    await scad.clickViewport(0, 0);
    expect(await scad.selectedCall()).toBe('cylinder');
    await shot(scad, '3-cutter-selected');
  });

  test('the breadcrumb links back to every level; drilling into a module edits its definition', async ({ scad }) => {
    const source = [
      'module bracket(w=20, h=10, thickness=3) {',
      '    difference() {',
      '        cube([w, h, thickness]);',
      '        translate([thickness, thickness, -1])',
      '            cube([w - 2 * thickness, h - 2 * thickness, thickness + 2]);',
      '    }',
      '}',
      '',
      'bracket(30, 15, 4);',
      'translate([40, 0, 0]) sphere(r=8);',
      '',
    ].join('\n');
    await scad.load(source);
    await scad.clickEditorLine(9);
    await drillSelected(scad, 'bracket() #1');
    await expect(scad.page.getByText('Editing module bracket(): changes apply to every bracket() call.')).toBeVisible();
    await scad.clickEditorLine(2);
    await drillSelected(scad, 'Difference #1');
    expect(await crumbs(scad)).toBe('Assembly›bracket() #1›Difference #1');
    await scad.resetView();
    await shot(scad, '4-two-levels-in-module');

    await scad.clickEditorLine(3);
    expect(await scad.selectedCall()).toBe('cube');
    await scad.rendersAfter(async () => {
      await scad.positionInputs().nth(1).fill('2');
      await scad.positionInputs().nth(1).press('Enter');
    });
    expect(await scad.source()).toBe(source.replace('        cube([w, h, thickness]);', '        translate([0, 2, 0])\n            cube([w, h, thickness]);'));

    // Middle crumb: back one level, with the difference selected.
    await scad.rendersAfter(() => breadcrumb(scad).getByRole('button', { name: 'bracket() #1' }).click());
    expect(await crumbs(scad)).toBe('Assembly›bracket() #1');
    await expect(scad.button('Open Difference #1 ▸')).toBeVisible();
    // First crumb: all the way out, with the bracket call selected.
    await scad.rendersAfter(() => breadcrumb(scad).getByRole('button', { name: 'Assembly' }).click());
    await expect(breadcrumb(scad)).toBeHidden();
    expect(await scad.selectedCall()).toBe('bracket');
  });

  test('a module from a used library is view-only, with an explicit action to open its file', async ({ scad, tmpDir }) => {
    mkdirSync(join(tmpDir, 'lib'));
    const lib = 'module peg(d=6, len=12) {\n    difference() {\n        cylinder(d=d, h=len, $fn=32);\n        translate([0, 0, -1]) cylinder(d=d/2, h=len+2, $fn=32);\n    }\n}\n';
    writeFileSync(join(tmpDir, 'lib/parts.scad'), lib);
    const doc = join(tmpDir, 'main.scad');
    writeFileSync(doc, 'use <lib/parts.scad>\n\npeg(d=10);\ntranslate([20, 0, 0]) cube(4);\n');
    await scad.stubDialogs({ open: doc });
    await scad.rendersAfter(() => scad.button('Open .scad file...').click());
    await expect(scad.page.getByRole('group', { name: 'Custom modules' }).getByRole('button', { name: 'peg' })).toBeVisible();
    await scad.clickEditorLine(3);
    await drillSelected(scad, 'peg() #1');

    await expect(scad.page.getByText('peg() comes from parts.scad, a library: view-only here.')).toBeVisible();
    await expect(scad.button('Cube')).toBeHidden(); // no inserting into a library module
    await expect(scad.button('Move')).toBeHidden(); // no gizmo
    expect((await stats(scad)).workingMeshes).toBe(1); // the difference() inside peg
    await expect(scad.button('Open Difference #1 ▸')).toBeHidden(); // nothing selected yet
    await scad.resetView();
    await shot(scad, '5-library-view-only');
    expect(await scad.source()).toBe('use <lib/parts.scad>\n\npeg(d=10);\ntranslate([20, 0, 0]) cube(4);\n');

    await scad.rendersAfter(() => scad.button('Open parts.scad to edit').click());
    expect(await scad.source()).toBe(lib);
    await expect(breadcrumb(scad)).toBeHidden();
    await expect(scad.button('Cube')).toBeVisible();
  });

  test('inserting while drilled in adds to the working set', async ({ scad }) => {
    await scad.load(BOOLEAN_SCENE);
    await scad.clickEditorLine(1);
    await drillSelected(scad, 'Difference #1');
    await scad.rendersAfter(() => scad.button('Sphere').click());
    expect(await scad.source()).toBe(BOOLEAN_SCENE.replace('$fn=24);\n}', '$fn=24);\n    sphere(r=5);\n}'));
    expect(await scad.selectedCall()).toBe('sphere');
    expect((await stats(scad)).workingMeshes).toBe(3);
  });

  test('typed edits keep the drill-in and selection on the same nodes, and flash the selection', async ({ scad }) => {
    await scad.load(BOOLEAN_SCENE);
    await scad.clickEditorLine(1);
    await drillSelected(scad, 'Difference #1');
    await scad.clickEditorLine(3);
    expect(await scad.selectedCall()).toBe('cylinder');

    // Type inside the selected cylinder's own arguments: r=4 -> r=4.5.
    const flashes = (await stats(scad)).flashes;
    await scad.rendersAfter(async () => {
      await scad.page.keyboard.press('End');
      // Back over `, $fn=24);` to just after the 4.
      for (let i = 0; i < ', $fn=24);'.length; i++) await scad.page.keyboard.press('ArrowLeft');
      await scad.page.keyboard.type('.5');
    });
    expect(await scad.source()).toContain('cylinder(h=10, r=4.5, $fn=24);');
    expect(await scad.selectedCall()).toBe('cylinder');
    expect((await stats(scad)).flashes).toBe(flashes + 1);

    // A new statement typed above the drilled-into node: the focus follows it.
    await scad.rendersAfter(async () => {
      await scad.page.keyboard.press('Control+Home');
      await scad.page.keyboard.type('cube(1);\n');
    });
    expect(await crumbs(scad)).toBe('Assembly›Difference #2');
    expect((await stats(scad)).workingMeshes).toBe(2);

    // Deleting the drilled-into node itself leaves the drill-in.
    await scad.rendersAfter(async () => {
      await scad.page.keyboard.press('Control+a');
      await scad.page.keyboard.type('sphere(3);\n');
    });
    await expect(breadcrumb(scad)).toBeHidden();
    expect(await scad.status()).toMatch(/^Left drill-in/);
  });

  test('sketching while drilled in writes the sketch into the focused node, in its own frame; Escape leaves an untouched sketch', async ({ scad }) => {
    await scad.load('translate([10, 0, 0]) union() {\n    cube([4, 4, 4]);\n}\n');
    await scad.clickEditorLine(1);
    await drillSelected(scad, 'Union #1');

    await scad.button('XY').click();
    await scad.page.waitForTimeout(1200);
    await expect(breadcrumb(scad).locator('[aria-current="location"]')).toHaveText('Sketch');
    await escape(scad).catch(() => {}); // no render: nothing to wait for
    await expect(scad.button('XY')).toBeVisible(); // left the sketch
    await expect(breadcrumb(scad)).toBeVisible(); // still drilled in

    await scad.button('XY').click();
    await scad.page.waitForTimeout(1200);
    await scad.button('Rectangle').click();
    await scad.clickViewport(-60, -40);
    await scad.clickViewport(60, 40);
    await shot(scad, '6-sketch-in-focus');
    await scad.rendersAfter(() => scad.button('Finish Sketch').click());
    const source = await scad.source();
    // Inside the union, written relative to its translate([10, 0, 0]).
    expect(source).toMatch(/^translate\(\[10, 0, 0\]\) union\(\) \{\n    cube\(\[4, 4, 4\]\);\n    translate\(\[-10, 0, 0\]\) polygon\(points=\[\[[^\n]+\]\]\);\n\}\n$/);
    expect((await stats(scad)).workingMeshes).toBe(2);
  });
});
