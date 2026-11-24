// M8: the Custom toolbar section (modules from the document and its `use`d
// files), insertion through the shared tool path, live library watching, and
// the parameter panel's real parameter names and inferred widgets.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type ScadApp } from './fixtures';

// Set M8_SHOTS=<folder> to also save screenshots of each step.
async function shot(scad: ScadApp, name: string): Promise<void> {
  const dir = process.env['M8_SHOTS'];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await scad.page.screenshot({ path: join(dir, `${name}.png`) });
}

function custom(scad: ScadApp) {
  return scad.page.getByRole('group', { name: 'Custom modules' });
}

function param(scad: ScadApp, name: string) {
  return scad.page.getByLabel(`Parameter ${name}`, { exact: true });
}

async function panelLabels(scad: ScadApp): Promise<string[]> {
  return scad.page.evaluate(() =>
    [...document.querySelectorAll('span')]
      .filter((s) => (s as HTMLElement).style.opacity === '0.6' && /^[#$\w]+:$/.test(s.textContent ?? ''))
      .map((s) => s.textContent!.slice(0, -1)),
  );
}

test.describe('M8 custom module toolbar', () => {
  test('the default example lists its own module, and the panel names positional arguments', async ({ scad }) => {
    await expect(custom(scad).getByRole('button', { name: 'bracket' })).toBeVisible();
    await scad.clickEditorLine(11); // bracket(30, 15, 4);
    expect(await scad.selectedCall()).toBe('bracket');
    const labels = await panelLabels(scad);
    expect(labels).toEqual(expect.arrayContaining(['w', 'h', 'thickness']));
    expect(labels.some((l) => l.startsWith('#'))).toBe(false);
    await expect(param(scad, 'w')).toHaveValue('30');
    await shot(scad, '1-default-panel-names');
  });

  test('clicking a Custom tool inserts a named-argument call, renders and selects it', async ({ scad }) => {
    const before = await scad.source();
    const status = await scad.rendersAfter(() => custom(scad).getByRole('button', { name: 'bracket' }).click());
    expect(status).toBe('Rendered');
    expect(await scad.source()).toBe(`${before}\nbracket(w = 20, h = 10, thickness = 3);\n`);
    expect(await scad.selectedCall()).toBe('bracket');
    await shot(scad, '2-inserted-bracket');
  });

  test('used library files supply tools, a nested use adds its directive, edits on disk refresh the toolbar', async ({ scad, tmpDir }) => {
    mkdirSync(join(tmpDir, 'lib'));
    writeFileSync(
      join(tmpDir, 'lib/parts.scad'),
      [
        'use <knobs.scad>',
        '// A round peg, optionally hollow',
        'module peg(d=6, len=12, hollow=false, offset=[0, 0, 0]) {',
        '    translate(offset) difference() {',
        '        cylinder(d=d, h=len, $fn=32);',
        '        if (hollow) translate([0, 0, -1]) cylinder(d=d/2, h=len+2, $fn=32);',
        '    }',
        '}',
        'module _private_helper() {}',
        '',
      ].join('\n'),
    );
    writeFileSync(join(tmpDir, 'lib/knobs.scad'), 'module knob(r=4, tilt=0) { rotate([tilt, 0, 0]) sphere(r=r, $fn=24); }\n');
    const doc = join(tmpDir, 'main.scad');
    writeFileSync(doc, 'use <lib/parts.scad>\n\ncube(2);\n');
    await scad.stubDialogs({ open: doc });
    await scad.rendersAfter(() => scad.button('Open .scad file...').click());
    await scad.resetView();

    await expect(custom(scad).getByRole('button', { name: 'peg' })).toBeVisible();
    await expect(custom(scad).getByRole('button', { name: 'knob' })).toBeVisible();
    await expect(custom(scad).getByRole('button', { name: '_private_helper' })).toHaveCount(0);
    await shot(scad, '3-library-tools');

    // knob lives behind parts.scad's own `use`, so the document needs one too.
    expect(await scad.rendersAfter(() => custom(scad).getByRole('button', { name: 'knob' }).click())).toBe('Rendered');
    expect(await scad.source()).toBe('use <lib/parts.scad>\nuse <lib/knobs.scad>\n\ncube(2);\n\nknob(r = 4, tilt = 0);\n');
    await expect(param(scad, 'tilt slider')).toBeVisible(); // angle widget: used inside rotate()

    expect(await scad.rendersAfter(() => custom(scad).getByRole('button', { name: 'peg' }).click())).toBe('Rendered');
    expect(await scad.source()).toMatch(/\npeg\(d = 6, len = 12, hollow = false, offset = \[0, 0, 0\]\);\n$/);

    // Inferred widgets: checkbox for the bool, X/Y/Z for the 3-vector.
    await scad.rendersAfter(() => param(scad, 'hollow').check());
    expect(await scad.source()).toMatch(/peg\(d = 6, len = 12, hollow = true, offset = \[0, 0, 0\]\);/);
    await scad.rendersAfter(async () => {
      await param(scad, 'offset Y').fill('20');
      await param(scad, 'offset Y').press('Enter');
    });
    expect(await scad.source()).toMatch(/peg\(d = 6, len = 12, hollow = true, offset = \[0, 20, 0\]\);/);
    await scad.resetView();
    await shot(scad, '4-peg-widgets');

    // Editing the library on disk refreshes the Custom section.
    writeFileSync(join(tmpDir, 'lib/parts.scad'), `${'module washer(od=10, id=5, t=1) { difference() { cylinder(d=od, h=t); cylinder(d=id, h=t); } }\n'}`, {
      flag: 'a',
    });
    await expect(custom(scad).getByRole('button', { name: 'washer' })).toBeVisible({ timeout: 15_000 });
    await shot(scad, '5-library-edited-on-disk');
  });

  test('a parameter the call leaves out is listed with its default and added when edited', async ({ scad }) => {
    await scad.load('module plate(size=[20, 10, 2], rounded=false, label="A") { cube(size); }\nplate();\n');
    await scad.clickEditorLine(2);
    expect(await scad.selectedCall()).toBe('plate');
    await expect(param(scad, 'size X')).toHaveAttribute('placeholder', '20');
    await scad.rendersAfter(() => param(scad, 'rounded').check());
    expect(await scad.source()).toBe('module plate(size=[20, 10, 2], rounded=false, label="A") { cube(size); }\nplate(rounded = true);\n');
    await scad.rendersAfter(async () => {
      await param(scad, 'label').fill('Lid "B"');
      await param(scad, 'label').press('Enter');
    });
    expect(await scad.source()).toBe('module plate(size=[20, 10, 2], rounded=false, label="A") { cube(size); }\nplate(rounded = true, label = "Lid \\"B\\"");\n');
  });

  test('a large library gets a filter box', async ({ scad, tmpDir }) => {
    const names = Array.from({ length: 20 }, (_, i) => `part_${String.fromCharCode(97 + i)}`);
    writeFileSync(join(tmpDir, 'many.scad'), names.map((n, i) => `module ${n}(s=${i + 1}) { cube(s); }\n`).join(''));
    const doc = join(tmpDir, 'main.scad');
    writeFileSync(doc, 'use <many.scad>\ncube(1);\n');
    await scad.stubDialogs({ open: doc });
    await scad.rendersAfter(() => scad.button('Open .scad file...').click());
    const filter = scad.page.getByLabel('Filter custom modules');
    await expect(filter).toBeVisible();
    await expect(custom(scad).getByRole('button')).toHaveCount(12);
    await filter.fill('part_t');
    await expect(custom(scad).getByRole('button')).toHaveCount(1);
    expect(await scad.rendersAfter(() => custom(scad).getByRole('button', { name: 'part_t' }).click())).toBe('Rendered');
    expect(await scad.source()).toBe('use <many.scad>\ncube(1);\n\npart_t(s = 20);\n');
  });
});
