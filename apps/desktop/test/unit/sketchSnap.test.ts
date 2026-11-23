// M7.5 slice 4: draw-time snapping priorities and on-plane geometry extraction.
import { describe, expect, it } from 'vitest';
import { BoxGeometry } from 'three';
import {
  DEFAULT_SNAP_SETTINGS,
  EMPTY_PLANE_SNAP_GEOMETRY,
  extractOnPlaneGeometry,
  snapSketchPoint,
  type PlaneSnapGeometry,
} from '../../src/renderer/src/sketchSnap';
import { IDENTITY_TRANSFORM } from '../../src/renderer/src/targetedPatch';

const TOL = 0.5;
const gridOnly = { grid: true, gridSize: 1, geometry: false };
const off = { grid: false, gridSize: 1, geometry: false };

describe('snapSketchPoint (M7.5 snapping)', () => {
  it('rounds to the grid, and never prints -0', () => {
    const r = snapSketchPoint([2.4, -0.3], [], EMPTY_PLANE_SNAP_GEOMETRY, gridOnly, TOL);
    expect(r).toMatchObject({ point: [2, 0], kind: 'grid' });
    expect(Object.is(r.point[1], -0)).toBe(false);
  });

  it('honours the grid size', () => {
    expect(snapSketchPoint([7.4, 2.6], [], EMPTY_PLANE_SNAP_GEOMETRY, { ...gridOnly, gridSize: 5 }, TOL).point).toEqual([5, 5]);
  });

  it('passes the raw point through when everything is off', () => {
    expect(snapSketchPoint([1.23, 4.56], [], EMPTY_PLANE_SNAP_GEOMETRY, off, TOL)).toEqual({
      point: [1.23, 4.56],
      kind: 'none',
      alignedU: null,
      alignedV: null,
    });
  });

  it('closes the loop on the first point once there are 3+ points', () => {
    const pts: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    expect(snapSketchPoint([0.2, 0.3], pts, EMPTY_PLANE_SNAP_GEOMETRY, DEFAULT_SNAP_SETTINGS, TOL).kind).toBe('close');
    expect(snapSketchPoint([0.2, 0.3], pts.slice(0, 2), EMPTY_PLANE_SNAP_GEOMETRY, DEFAULT_SNAP_SETTINGS, TOL).kind).toBe('origin');
    expect(snapSketchPoint([0.2, 0.3], pts, EMPTY_PLANE_SNAP_GEOMETRY, DEFAULT_SNAP_SETTINGS, TOL, false).kind).toBe('origin');
  });

  it('prefers point targets over edges, and edges over alignment and grid', () => {
    const geometry: PlaneSnapGeometry = { points: [[20, 0], [20, 10]], segments: [{ a: [20, 0], b: [20, 10] }] };
    expect(snapSketchPoint([20.1, 0.1], [], geometry, DEFAULT_SNAP_SETTINGS, TOL)).toMatchObject({ kind: 'endpoint', point: [20, 0] });
    expect(snapSketchPoint([20.1, 5.2], [], geometry, DEFAULT_SNAP_SETTINGS, TOL)).toMatchObject({ kind: 'midpoint', point: [20, 5] });
    expect(snapSketchPoint([20.2, 7.3], [], geometry, DEFAULT_SNAP_SETTINGS, TOL)).toMatchObject({ kind: 'edge', point: [20, 7.3] });
  });

  it('aligns horizontally/vertically with already-placed points before gridding', () => {
    const r = snapSketchPoint([5.2, 3.7], [[5.3, 0]], EMPTY_PLANE_SNAP_GEOMETRY, DEFAULT_SNAP_SETTINGS, TOL);
    expect(r.kind).toBe('align');
    expect(r.point).toEqual([5.3, 4]);
    expect(r.alignedU).toEqual([5.3, 0]);
    expect(r.alignedV).toBeNull();
  });
});

describe('extractOnPlaneGeometry (M7.5 snapping)', () => {
  it('finds a box bottom outline on the XY plane, and nothing on an offset plane', () => {
    const box = new BoxGeometry(10, 10, 10).translate(5, 5, 5); // spans 0..10 on every axis
    const shapes = [{ geometry: box, transform: IDENTITY_TRANSFORM }];
    const onXY = extractOnPlaneGeometry(shapes, { origin: [0, 0, 0], rotationDeg: [0, 0, 0] });
    expect(onXY.segments).toHaveLength(4);
    const corners = onXY.points.map((p) => p.map((v) => Math.round(v))).sort();
    expect(corners).toEqual([
      [0, 0],
      [0, 10],
      [10, 0],
      [10, 10],
    ]);
    const above = extractOnPlaneGeometry(shapes, { origin: [0, 0, 5], rotationDeg: [0, 0, 0] });
    expect(above.segments).toHaveLength(0);
  });

  it('applies the node transform and the plane frame', () => {
    const box = new BoxGeometry(2, 2, 2).translate(1, 1, 1);
    const shapes = [{ geometry: box, transform: { ...IDENTITY_TRANSFORM, translate: [0, 0, 3] as [number, number, number] } }];
    // The box's bottom face now sits at z=3; a plane there sees it.
    const plane = extractOnPlaneGeometry(shapes, { origin: [0, 0, 3], rotationDeg: [0, 0, 0] });
    expect(plane.segments).toHaveLength(4);
  });
});
