// Sketch overlay dots (snap marker, point handles, arc anchors) keep the same
// on-screen size at every zoom (screenScale.ts, ScreenDot in Viewport.tsx),
// so zooming in lets you work on fine detail instead of the dots covering it.
import { test, expect, type ScadApp } from './fixtures';
import { decodePng } from './png';


// Bounding box (image px) of the snap marker's green pixels. The marker's
// label has the same green background, so it's hidden for the capture.
async function snapMarkerBox(scad: ScadApp): Promise<{ w: number; h: number; cx: number; cy: number; dpr: number }> {
  const label = scad.page.getByTestId('sketch-snap-label');
  await expect(label).toBeVisible();
  await label.evaluate((el) => ((el as HTMLElement).style.visibility = 'hidden'));
  const img = decodePng(await scad.viewportShot());
  await label.evaluate((el) => ((el as HTMLElement).style.visibility = ''));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      // Clearly green (the marker renders a little lighter than its
      // #2da44e source color); the model is blue and the grid gray.
      const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
      if (!(g > r + 60 && g > b + 50)) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  const dpr = await scad.page.evaluate(() => window.devicePixelRatio);
  return { w: x1 - x0 + 1, h: y1 - y0 + 1, cx: (x0 + x1) / 2 / dpr, cy: (y0 + y1) / 2 / dpr, dpr };
}

// Hover just off the origin so the marker snaps onto it.
async function hoverOrigin(scad: ScadApp, origin: { dx: number; dy: number }) {
  const c = await scad.viewportCenter();
  await scad.page.mouse.move(c.x + origin.dx + 4, c.y + origin.dy + 3);
  await scad.page.mouse.move(c.x + origin.dx + 3, c.y + origin.dy + 2);
  await scad.page.waitForTimeout(300);
  await expect(scad.page.getByTestId('sketch-snap-label')).toContainText(/\(0, 0\)/);
}

async function zoom(scad: ScadApp, deltaY: number, steps: number) {
  const c = await scad.viewportCenter();
  await scad.page.mouse.move(c.x, c.y);
  for (let i = 0; i < steps; i++) {
    await scad.page.mouse.wheel(0, deltaY);
    await scad.page.waitForTimeout(60);
  }
  await scad.page.waitForTimeout(500);
}

test.describe('Sketch dots keep their screen size', () => {
  test('the snap marker is the same size in pixels zoomed out, at the default view and zoomed far in', async ({ scad }) => {
    await scad.load('cube(1);\n');
    await scad.button('XY').click();
    await expect(scad.page.getByText(/Sketching on XY plane/)).toBeVisible();
    await scad.page.waitForTimeout(1500); // camera animates onto the plane
    const v = await scad.viewport();
    // The XY sketch camera looks at the origin, so it sits at the viewport
    // centre and stays there while zooming (OrbitControls dollies toward it).
    const origin = { dx: 0, dy: 0 };

    await hoverOrigin(scad, origin);
    const base = await snapMarkerBox(scad);
    // Marker centred on the origin, a few CSS px across (4.5 px radius).
    expect(Math.abs(base.cx - v.width / 2)).toBeLessThan(4);
    expect(Math.abs(base.cy - v.height / 2)).toBeLessThan(4);
    expect(base.w / base.dpr).toBeGreaterThanOrEqual(6);
    expect(base.w / base.dpr).toBeLessThanOrEqual(13);

    await zoom(scad, -400, 12); // far in
    await hoverOrigin(scad, origin);
    const zoomedIn = await snapMarkerBox(scad);

    await zoom(scad, 400, 24); // back out, past where it started
    await hoverOrigin(scad, origin);
    const zoomedOut = await snapMarkerBox(scad);

    for (const box of [zoomedIn, zoomedOut]) {
      expect(Math.abs(box.w - base.w), `width ${box.w} vs ${base.w}`).toBeLessThanOrEqual(2);
      expect(Math.abs(box.h - base.h), `height ${box.h} vs ${base.h}`).toBeLessThanOrEqual(2);
    }
  });

  test('a point placed while zoomed far in lands where clicked, beside a point the old fixed-size dot would have covered', async ({ scad }) => {
    await scad.load('cube(1);\n');
    await scad.button('XY').click();
    await expect(scad.page.getByText(/Sketching on XY plane/)).toBeVisible();
    await scad.page.waitForTimeout(1500);
    await zoom(scad, -400, 14);
    // At this zoom the old 0.8-unit handle spanned hundreds of pixels; three
    // clicks 30 px apart each add their own point instead of hitting the
    // first point's handle.
    await scad.page.getByRole('checkbox', { name: 'Points/edges' }).uncheck();
    for (const p of [{ dx: -30, dy: 20 }, { dx: 0, dy: 20 }, { dx: 0, dy: -10 }]) await scad.clickViewport(p.dx, p.dy);
    await expect(scad.page.getByTestId('sketch-hint')).toContainText(/ 3 points\)/);
    const status = await scad.rendersAfter(() => scad.button('Finish Sketch').click());
    expect(status).toBe('Rendered');
    const m = (await scad.source()).match(/polygon\(points=(\[\[.*?\]\])\)/);
    expect(m).not.toBeNull();
    const pts = JSON.parse(m![1]) as number[][];
    expect(pts).toHaveLength(3);
    // All three are within a fraction of a unit of each other: fine detail.
    for (const [u, v] of pts) {
      expect(Math.abs(u)).toBeLessThan(1);
      expect(Math.abs(v)).toBeLessThan(1);
    }
    expect(new Set(pts.map((p) => p.join(','))).size).toBe(3);
  });
});
