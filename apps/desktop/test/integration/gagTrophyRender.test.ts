// The model from the crash report (2026-11-25), rendered through the real
// `scad:render` handler. At full detail it takes over a minute and ~1.5 GB
// of engine memory (the e2e suite opens it at full detail); here the detail
// settings are turned down (OpenSCAD uses a file-scope variable's last
// assignment everywhere) so every part renders in a few seconds.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadMainProcess, type MainProcessHarness } from '../helpers/mainProcess';
import { FIXTURES_DIR } from '../helpers/paths';
import { bbox, parseStl, triangleCount } from '../helpers/stl';

const SOURCE = readFileSync(join(FIXTURES_DIR, 'gag_trophy1.scad'), 'utf8');
const lowDetail = (part: string) => `${SOURCE}\npart = "${part}";\n$fn = 16;\ndome_res = 0.6;\n`;

let main: MainProcessHarness;
const render = (source: string) => main.invoke('scad:render', source) as Promise<Uint8Array>;

beforeAll(async () => {
  main = await loadMainProcess();
});

describe('gag_trophy1.scad renders (crash report 2026-11-25)', () => {
  it('the assembly renders as binary STL with the trophy\'s overall size', async () => {
    const bytes = await render(lowDetail('assembly'));
    // Binary STL: 80-byte header, triangle count, 50 bytes per triangle.
    const count = new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true);
    expect(bytes.byteLength).toBe(84 + 50 * count);
    const geom = parseStl(bytes);
    expect(triangleCount(geom)).toBe(count);
    const { min, max } = bbox(geom);
    // Base is 140 x 70; the key's top (foam crown) is ~45 + 115 + 106 mm up.
    expect(max[0] - min[0]).toBeCloseTo(140, 0);
    expect(max[1] - min[1]).toBeCloseTo(70, 0);
    expect(max[2]).toBeGreaterThan(250);
    expect(min[2]).toBeCloseTo(0, 3);
  });

  it.each(['base', 'plaque', 'blade', 'fob_half', 'mug_half', 'foam', 'buttons_grey', 'button_accent'])('part "%s" renders', async (part) => {
    expect(triangleCount(parseStl(await render(lowDetail(part))))).toBeGreaterThan(10);
  });

  it('a 2D part rejects as 2D (the renderer then retries it as a thin extrude, M7)', async () => {
    await expect(render(lowDetail('2d_head'))).rejects.toThrow(/not a 3D object|2D/i);
  });
});
