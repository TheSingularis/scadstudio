// M7.5 sketch mode: plane picking, click-to-place drawing → polygon(),
// snapping, on-plane editing of a committed sketch, pick-face planes, the nav
// cube and shading modes.
import { test, expect } from './fixtures';
import type { ScadApp } from './fixtures';

const TRIANGLE_PX = [
  { dx: -80, dy: 60 },
  { dx: 80, dy: 60 },
  { dx: 0, dy: -80 },
];

function polygonPoints(src: string): number[][] {
  const m = src.match(/polygon\(points=(\[\[.*?\]\])\)/);
  if (!m) throw new Error(`no polygon in:\n${src}`);
  return JSON.parse(m[1]);
}

async function drawTriangleOnXY(scad: ScadApp) {
  await scad.button('XY').click();
  await expect(scad.page.getByText(/Sketching on XY plane/)).toBeVisible();
  await scad.page.waitForTimeout(1500); // camera animates onto the plane
  for (const p of TRIANGLE_PX) await scad.clickViewport(p.dx, p.dy);
  await expect(scad.page.getByTestId('sketch-hint')).toContainText(/ 3 points\)/);
}

test.describe('M7.5 sketch mode', () => {
  test('draw on XY, Finish Sketch writes a grid-snapped polygon()', async ({ scad }) => {
    await scad.load('cube(1);\n');
    await drawTriangleOnXY(scad);
    const status = await scad.rendersAfter(() => scad.button('Finish Sketch').click());
    expect(status).toBe('Rendered');
    const src = await scad.source();
    expect(src).toMatch(/^cube\(1\);\n\npolygon\(points=\[\[/);
    const pts = polygonPoints(src);
    expect(pts).toHaveLength(3);
    for (const [u, v] of pts) {
      expect(Number.isInteger(u) && Number.isInteger(v), `grid snap: ${u}, ${v}`).toBe(true);
    }
    // Screen-space layout is preserved: two base points share v, apex is above.
    expect(pts[0][1]).toBe(pts[1][1]);
    expect(pts[1][0]).toBeGreaterThan(pts[0][0]);
    expect(pts[2][1]).toBeGreaterThan(pts[0][1]);
    expect(await scad.selectedCall()).toBe('polygon');
  });

  test('Undo removes the last point and Exit Sketch discards the drawing', async ({ scad }) => {
    await scad.load('cube(1);\n');
    await drawTriangleOnXY(scad);
    await scad.button('Undo').click();
    await expect(scad.page.getByTestId('sketch-hint')).toContainText(/ 2 points\)/);
    await expect(scad.button('Finish Sketch')).toBeDisabled();
    await scad.button('Exit Sketch').click();
    await expect(scad.button('XY')).toBeVisible();
    expect(await scad.source()).toBe('cube(1);\n');
  });

  test('holding Alt places a point without snapping', async ({ scad }) => {
    await scad.load('cube(1);\n');
    await scad.button('XY').click();
    await scad.page.waitForTimeout(1500);
    await scad.clickViewport(-83, 61, ['Alt']);
    await scad.clickViewport(77, 59, ['Alt']);
    await scad.clickViewport(3, -79, ['Alt']);
    await scad.rendersAfter(() => scad.button('Finish Sketch').click());
    const pts = polygonPoints(await scad.source());
    expect(pts.flat().some((n) => !Number.isInteger(n))).toBe(true);
  });

  test('Edit Sketch: click near an edge inserts a vertex and Save Sketch patches the points in place', async ({ scad }) => {
    await scad.load('cube(1);\n');
    await drawTriangleOnXY(scad);
    await scad.rendersAfter(() => scad.button('Finish Sketch').click());
    const before = polygonPoints(await scad.source());
    await expect(scad.button('Edit Sketch')).toBeVisible();
    await scad.button('Edit Sketch').click();
    await expect(scad.page.getByText(/Editing sketch on XY plane/)).toBeVisible();
    await scad.page.waitForTimeout(1500);
    // Click a little below the middle of the base edge.
    await scad.clickViewport(0, 70);
    await expect(scad.page.getByTestId('sketch-hint')).toContainText(/ 4 points\)/);
    await scad.rendersAfter(() => scad.button('Save Sketch').click());
    const src = await scad.source();
    const after = polygonPoints(src);
    expect(after).toHaveLength(4);
    expect(after).toEqual(expect.arrayContaining(before));
    expect(src.match(/polygon/g)).toHaveLength(1); // patched in place, not appended
  });

  test('a finished sketch extrudes into a solid that can still be edited as a sketch', async ({ scad }) => {
    await scad.load('cube(1);\n');
    await drawTriangleOnXY(scad);
    await scad.rendersAfter(() => scad.button('Finish Sketch').click());
    const status = await scad.rendersAfter(() => scad.button('Linear Extrude').click());
    expect(status).toBe('Rendered');
    expect(await scad.source()).toMatch(/linear_extrude\(height=10\) \{\n {4}polygon\(points=/);
    await expect(scad.button('Edit Sketch')).toBeVisible();
  });

  test('XZ and YZ planes enter sketch mode on their own plane', async ({ scad }) => {
    for (const plane of ['XZ', 'YZ']) {
      await scad.button(plane).click();
      await expect(scad.page.getByText(`Sketching on ${plane} plane`)).toBeVisible();
      await scad.button('Exit Sketch').click();
    }
  });

  test('Pick Face starts a sketch on a clicked face', async ({ scad }) => {
    await scad.load('cube(20, center=true);\n');
    await scad.button('Pick Face').click();
    await expect(scad.page.getByText(/Click a face of an existing shape/)).toBeVisible();
    await scad.clickViewport();
    await expect(scad.page.getByText('Sketching on picked face')).toBeVisible();
  });

  test('nav cube, view step arrows and shading modes change the view', async ({ scad }) => {
    await scad.load('cube([20, 10, 5]);\n');
    let shot = await scad.viewportShot();
    const v = await scad.viewport();
    // The nav cube sits in the viewport's top-right corner, centred about
    // (-90, +90) px from it; the default view already looks at its
    // TOP/FRONT/RIGHT corner, so click the TOP face just above that.
    await scad.page.mouse.click(v.x + v.width - 90, v.y + 62);
    await scad.page.waitForTimeout(1300);
    let next = await scad.viewportShot();
    expect(next.equals(shot), 'nav cube click moves the camera').toBe(false);
    shot = next;
    await scad.page.getByTitle('Rotate view right 90°').click();
    await scad.page.waitForTimeout(1300);
    next = await scad.viewportShot();
    expect(next.equals(shot), 'step arrow moves the camera').toBe(false);
    shot = next;
    await scad.page.locator('select').last().selectOption({ label: 'Wireframe' });
    await scad.page.waitForTimeout(500);
    expect((await scad.viewportShot()).equals(shot), 'wireframe shading').toBe(false);
  });
});
