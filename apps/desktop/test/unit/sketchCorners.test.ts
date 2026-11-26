// M13: sketch corner fillet and chamfer geometry.
import { describe, expect, it } from 'vitest';
import { chamferCorner, cornerInfo, filletCorner, type Vec2 } from '../../src/renderer/src/sketchCorners';

const square: Vec2[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

const area = (pts: Vec2[]) => pts.reduce((s, p, i) => s + (p[0] * pts[(i + 1) % pts.length]![1] - pts[(i + 1) % pts.length]![0] * p[1]), 0) / 2;

describe('cornerInfo', () => {
  it('measures a right angle and what fits', () => {
    const info = cornerInfo(square, 1)!;
    expect(info.angleDeg).toBeCloseTo(90, 9);
    expect(info.maxRadius).toBeCloseTo(10, 9);
    expect(info.maxChamfer).toBe(10);
  });
  it('is null for a point in line with its neighbours', () => {
    expect(cornerInfo([[0, 0], [5, 0], [10, 0], [10, 10]], 1)).toBeNull();
  });
});

describe('filletCorner', () => {
  it('replaces the corner with a tangent arc of the given radius', () => {
    const r = filletCorner(square, 2, 3, 32);
    if (!r.ok) throw new Error(r.why);
    // Quarter circle at 32 segments per turn: 8 steps, 9 points.
    expect(r.loop).toHaveLength(4 - 1 + 9);
    const arc = r.loop.slice(2, 11);
    expect(arc[0]).toEqual([10, 7]);
    expect(arc[arc.length - 1]).toEqual([7, 10]);
    for (const [u, v] of arc) expect(Math.hypot(u - 7, v - 7)).toBeCloseTo(3, 2);
    // Area: the square minus the corner's (r^2 - pi r^2 / 4), up to the
    // chord approximation of the arc.
    expect(area(r.loop)).toBeCloseTo(100 - (9 - (Math.PI * 9) / 4), 0);
  });

  it('rounds an inside (concave) corner too', () => {
    const ell: Vec2[] = [
      [0, 0],
      [10, 0],
      [10, 4],
      [4, 4],
      [4, 10],
      [0, 10],
    ];
    const r = filletCorner(ell, 3, 2, 32);
    if (!r.ok) throw new Error(r.why);
    // Rounding an inside corner adds material.
    expect(area(r.loop)).toBeGreaterThan(area(ell));
    expect(r.loop[3]).toEqual([6, 4]);
  });

  it('refuses a radius that doesn’t fit, naming the most that does', () => {
    const r = filletCorner(square, 0, 11, 32);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toMatch(/most is 10/);
  });

  it('a radius that uses the whole edge doesn’t repeat the neighbour', () => {
    const r = filletCorner(square, 1, 10, 16);
    if (!r.ok) throw new Error(r.why);
    const keys = r.loop.map((p) => p.join(','));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('chamferCorner', () => {
  it('cuts the corner back along both edges', () => {
    const r = chamferCorner(square, 2, 2);
    if (!r.ok) throw new Error(r.why);
    expect(r.loop).toEqual([
      [0, 0],
      [10, 0],
      [10, 8],
      [8, 10],
      [0, 10],
    ]);
    expect(area(r.loop)).toBeCloseTo(98, 6);
  });
});
