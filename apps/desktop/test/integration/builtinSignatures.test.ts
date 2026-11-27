// M8: the parameter panel names built-ins' positional arguments from
// BUILTIN_SIGNATURES. Each order is pinned here against the bundled engine,
// by rendering a positional call and its named equivalent and comparing.
import { describe, expect, it } from 'vitest';
import { renderScadToMesh } from '../../src/main/scadRender';
import { bbox, parseStl } from '../helpers/stl';
import { BUILTIN_SIGNATURES } from '../../src/renderer/src/tools';

const CASES: { name: string; values: string[]; wrap?: (call: string) => string }[] = [
  { name: 'cube', values: ['[1, 2, 3]', 'true'] },
  { name: 'cylinder', values: ['10', '2', '5', 'true'] },
  { name: 'square', values: ['[2, 3]', 'true'], wrap: (c) => `linear_extrude(1) ${c}` },
  { name: 'circle', values: ['3'], wrap: (c) => `linear_extrude(1) ${c}` },
  { name: 'sphere', values: ['4'] },
  { name: 'polygon', values: ['[[0,0],[4,0],[0,4],[10,10],[11,10],[10,11]]', '[[3,4,5]]'], wrap: (c) => `linear_extrude(1) ${c}` },
  { name: 'offset', values: ['2'], wrap: (c) => `linear_extrude(1) ${c} square(1)` },
  { name: 'linear_extrude', values: ['7'], wrap: (c) => `${c} square(2)` },
  { name: 'rotate_extrude', values: ['180'], wrap: (c) => `${c} translate([5, 0]) square(1)` },
  // halign/valign/spacing are named-only (namedOnly in BUILTIN_SIGNATURES).
  { name: 'text', values: ['"Hi"', '12', '"Liberation Serif"'], wrap: (c) => `linear_extrude(1) ${c}` },
];

function box(source: string) {
  return renderScadToMesh(source).then((stl) => bbox(parseStl(stl)));
}

describe('M8 built-in positional signatures (engine-checked)', () => {
  it('a named-only parameter really is (text halign as a 4th positional is ignored)', async () => {
    const plain = await box('linear_extrude(1) text("Hi", 12, "Liberation Sans");');
    expect(await box('linear_extrude(1) text("Hi", 12, "Liberation Sans", "center");')).toEqual(plain);
    expect(await box('linear_extrude(1) text("Hi", 12, "Liberation Sans", halign="center");')).not.toEqual(plain);
  });

  it('covers every signature', () => {
    expect(CASES.map((c) => c.name).sort()).toEqual(Object.keys(BUILTIN_SIGNATURES).sort());
  });
  for (const { name, values, wrap = (c: string) => c } of CASES) {
    it(`${name}(${BUILTIN_SIGNATURES[name].filter((p) => !p.namedOnly).map((p) => p.name).join(', ')})`, async () => {
      const params = BUILTIN_SIGNATURES[name].filter((p) => !p.namedOnly);
      expect(values).toHaveLength(params.length);
      const positional = `${wrap(`${name}(${values.join(', ')})`)};`;
      const named = `${wrap(`${name}(${values.map((v, i) => `${params[i].name}=${v}`).join(', ')})`)};`;
      expect(await box(positional)).toEqual(await box(named));
    });
  }
});
