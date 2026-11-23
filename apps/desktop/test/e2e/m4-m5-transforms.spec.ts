// M4 translate gizmo (drag → targeted patch → re-render) and M5 rotate/scale,
// mirror, colour, position fields, primitive insertion and the parameter panel.
import { test, expect, audit } from './fixtures';

const CENTERED_CUBE = 'cube(10, center=true);\n';

test.describe('M4 translate gizmo', () => {
  test('dragging the X arrow writes a translate() with only X changed', async ({ scad }) => {
    await scad.load(CENTERED_CUBE);
    await scad.clickViewport();
    expect(await scad.selectedCall()).toBe('cube');
    await scad.page.waitForTimeout(500);
    const handle = await scad.axisHandle('x');
    expect(handle.count, 'red X arrow visible').toBeGreaterThan(20);
    // Drag outward along the arrow's own screen direction.
    const len = Math.hypot(handle.dx, handle.dy);
    const to = { dx: handle.dx + (handle.dx / len) * 120, dy: handle.dy + (handle.dy / len) * 120 };
    const status = await scad.rendersAfter(() => scad.dragViewport(handle, to));
    expect(status).toBe('Rendered');
    const src = await scad.source();
    const m = src.match(/^translate\(\[([-\d.]+), ([-\d.]+), ([-\d.]+)\]\)\n {4}cube\(10, center=true\);\n$/);
    expect(m, src).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(1);
    expect([Number(m![2]), Number(m![3])]).toEqual([0, 0]);
    // The position field shows the committed value and the node stays selected.
    await expect(scad.positionInputs().first()).toHaveValue(m![1]);
  });

  test('a second drag patches the same translate instead of nesting another', async ({ scad }) => {
    await scad.load('translate([5, 0, 0]) cube(10, center=true);\n');
    await scad.resetView();
    const c = await scad.viewportCenter();
    await scad.page.mouse.click(c.x, c.y);
    await scad.page.waitForTimeout(500);
    const handle = await scad.axisHandle('x');
    const len = Math.hypot(handle.dx, handle.dy);
    await scad.rendersAfter(() => scad.dragViewport(handle, { dx: handle.dx + (handle.dx / len) * 80, dy: handle.dy + (handle.dy / len) * 80 }));
    const src = await scad.source();
    expect(src.match(/translate/g)).toHaveLength(1);
  });

  test(audit('H2', 'a gizmo edit on translate(v) { ... } does not nest a duplicate translate'), async ({ scad }) => {
    test.fail();
    await scad.load('translate([30, 0, 0]) { cube(5, center=true); }\n');
    await scad.clickEditorLine(1);
    const x = scad.positionInputs().first();
    await scad.rendersAfter(async () => {
      await x.fill('40');
      await x.press('Enter');
    });
    expect((await scad.source()).match(/translate/g)).toHaveLength(1);
  });
});

test.describe('M5 transforms, insertion and parameters', () => {
  test('Rotate and Scale gizmo modes show their handles', async ({ scad }) => {
    await scad.load(CENTERED_CUBE);
    await scad.clickViewport();
    for (const mode of ['Rotate', 'Scale', 'Move']) {
      await scad.button(mode).click();
      await scad.page.waitForTimeout(300);
      await expect(scad.button(mode)).toHaveCSS('font-weight', '700');
      expect((await scad.axisHandle('x')).count, `${mode} gizmo X handle`).toBeGreaterThan(20);
    }
    await scad.button('Rotate').click();
    await expect(scad.button('Local')).toBeVisible();
    await expect(scad.button('World')).toBeVisible();
  });

  test('Position fields write translate()', async ({ scad }) => {
    await scad.load(CENTERED_CUBE);
    await scad.clickViewport();
    const [x, , z] = [scad.positionInputs().nth(0), null, scad.positionInputs().nth(2)];
    await scad.rendersAfter(async () => {
      await x.fill('12');
      await x.press('Enter');
    });
    await scad.clickEditorLine(2);
    await scad.rendersAfter(async () => {
      await z.fill('-3.5');
      await z.press('Enter');
    });
    expect(await scad.source()).toBe('translate([12, 0, -3.5])\n    cube(10, center=true);\n');
  });

  test('Mirror buttons toggle mirror() wraps', async ({ scad }) => {
    await scad.load(CENTERED_CUBE);
    await scad.clickViewport();
    await scad.rendersAfter(() => scad.button('Mirror X').click());
    expect(await scad.source()).toBe('mirror([1, 0, 0])\n    cube(10, center=true);\n');
    await scad.rendersAfter(() => scad.button('Mirror X').click());
    expect(await scad.source()).toBe('cube(10, center=true);\n');
  });

  test('Color picker writes color() and Clear removes it', async ({ scad }) => {
    await scad.load(CENTERED_CUBE);
    await scad.clickViewport();
    await scad.rendersAfter(() => scad.page.locator('input[type=color]').fill('#ff0000'));
    expect(await scad.source()).toBe('color([1, 0, 0])\n    cube(10, center=true);\n');
    await scad.rendersAfter(() => scad.button('Clear').click());
    expect(await scad.source()).toBe('cube(10, center=true);\n');
  });

  for (const [label, call] of [
    ['Cube', 'cube'],
    ['Sphere', 'sphere'],
    ['Cylinder', 'cylinder'],
    ['Square', 'square'],
    ['Circle', 'circle'],
  ] as const) {
    test(`Insert ${label} appends, renders and selects it`, async ({ scad }) => {
      await scad.load('cube(1);\n', { fit: false });
      const status = await scad.rendersAfter(() => scad.button(label).click());
      expect(status).toBe('Rendered');
      expect(await scad.source()).toMatch(new RegExp(`^cube\\(1\\);\\n\\n${call}\\(`));
      expect(await scad.selectedCall()).toBe(call);
    });
  }

  test('editing a parameter in the panel patches only that argument', async ({ scad }) => {
    await scad.load('translate([0, 0, 0]) cylinder(h=20, r=5, $fn=32); // keep\n');
    await scad.clickEditorLine(1);
    expect(await scad.selectedCall()).toBe('cylinder');
    const r = scad.page.locator('input[type=text]').nth(1);
    await expect(r).toHaveValue('5');
    await scad.rendersAfter(async () => {
      await r.fill('7.5');
      await r.press('Enter');
    });
    expect(await scad.source()).toBe('translate([0, 0, 0]) cylinder(h=20, r=7.5, $fn=32); // keep\n');
  });
});
