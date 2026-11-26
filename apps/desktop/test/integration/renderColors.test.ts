// M10a: renders keep the colors the source gives (they used to export binary
// STL, which has none), through the real `scad:render` handler and engine.
import { beforeAll, describe, expect, it } from 'vitest';
import { loadMainProcess, type MainProcessHarness } from '../helpers/mainProcess';
import { ENGINE_DEFAULT_RGB, readFaceColors } from '../../src/renderer/src/meshColors';

let main: MainProcessHarness;
const render = (source: string) => main.invoke('scad:render', source) as Promise<Uint8Array>;

function colorsOf(bytes: Uint8Array): Set<string> {
  const faces = readFaceColors(bytes)!;
  const seen = new Set<string>();
  for (let i = 0; i < faces.length; i += 4) seen.add([...faces.subarray(i, i + 4)].join(','));
  return seen;
}

beforeAll(async () => {
  main = await loadMainProcess();
});

describe('render colors (M10a)', () => {
  it('colors inside a module, a vector color, and uncolored parts', async () => {
    const seen = colorsOf(
      await render(`module m() { color("goldenrod") cube(5); translate([0,0,6]) color([0.1, 0.2, 0.9]) cube(2); }
m(); translate([20,0,0]) cube(3);`),
    );
    // The engine truncates 0-1 values to bytes (0.9 -> 229).
    expect(seen).toEqual(new Set(['218,165,32,255', '25,51,229,255', `${ENGINE_DEFAULT_RGB.join(',')},255`]));
  });

  it('a difference(): the base keeps its color and the cut faces take the cutter\'s, as in OpenSCAD', async () => {
    const seen = colorsOf(await render('difference() { color("red") cube(8); color("green") translate([4,4,4]) cube(8); }'));
    expect(seen).toEqual(new Set(['255,0,0,255', '0,128,0,255']));
  });

  it('alpha comes through, and an outer color() wins over inner ones', async () => {
    expect(colorsOf(await render('color([1, 0, 0, 0.5]) cube(2);'))).toEqual(new Set(['255,0,0,127']));
    expect(colorsOf(await render('color("red") { color("blue") cube(2); translate([3,0,0]) cube(2); }'))).toEqual(new Set(['255,0,0,255']));
  });

  it('tells the window which step the render is on', async () => {
    main.replies.length = 0;
    await render('cube(1);');
    expect(main.replies.filter((r) => r.channel === 'scad:renderStage').map((r) => r.args[0])).toEqual(['preparing', 'engine', 'mesh']);
  });
});

describe('named colors match the engine (M10a)', () => {
  it('every name in namedColors.ts renders as that color', async () => {
    const { NAMED_COLORS } = await import('../../src/renderer/src/namedColors');
    const names = Object.keys(NAMED_COLORS);
    const source = names.map((n, i) => `translate([${i * 3}, 0, 0]) color("${n}") cube(1);`).join('\n');
    const seen = colorsOf(await render(source));
    const expected = new Set(names.map((n) => {
      const v = NAMED_COLORS[n];
      return `${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},255`;
    }));
    expect(seen).toEqual(expected);
  });
});
