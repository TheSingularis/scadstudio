// Sketch overlay markers are sized in screen pixels (screenScale.ts): the
// world size of one pixel must track zoom so a dot stays the same on screen.
import { describe, expect, it } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { worldUnitsPerPixel } from '../../src/renderer/src/screenScale';

function cameraAt(distance: number, fov = 45): PerspectiveCamera {
  const camera = new PerspectiveCamera(fov, 16 / 9, 0.1, 10_000);
  camera.position.set(0, 0, distance);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

// Screen-space radius (px) of a world-space radius at `point`.
function projectedRadiusPx(camera: PerspectiveCamera, point: Vector3, worldRadius: number, heightPx: number): number {
  const a = point.clone().project(camera);
  const b = point.clone().add(new Vector3(0, worldRadius, 0)).project(camera);
  return ((b.y - a.y) / 2) * heightPx;
}

describe('worldUnitsPerPixel', () => {
  it('matches the perspective frustum height at the point depth', () => {
    const camera = cameraAt(60);
    const expected = (2 * 60 * Math.tan((45 * Math.PI) / 360)) / 900;
    expect(worldUnitsPerPixel(camera, new Vector3(0, 0, 0), 900)).toBeCloseTo(expected, 10);
  });

  it('scales linearly with distance, so a marker sized with it keeps a constant pixel size at any zoom', () => {
    for (const distance of [0.5, 5, 60, 2000]) {
      const camera = cameraAt(distance);
      const point = new Vector3(0, 0, 0);
      const radiusWorld = 5 * worldUnitsPerPixel(camera, point, 900);
      expect(projectedRadiusPx(camera, point, radiusWorld, 900)).toBeCloseTo(5, 3);
    }
  });

  it('uses view depth, not straight-line distance, for off-axis points', () => {
    const camera = cameraAt(60);
    const offAxis = new Vector3(20, 0, 0);
    const radiusWorld = 5 * worldUnitsPerPixel(camera, offAxis, 900);
    expect(projectedRadiusPx(camera, offAxis, radiusWorld, 900)).toBeCloseTo(5, 3);
    // Same depth as the on-axis point, so the same size.
    expect(worldUnitsPerPixel(camera, offAxis, 900)).toBeCloseTo(worldUnitsPerPixel(camera, new Vector3(), 900), 10);
  });

  it('accounts for camera.zoom and the canvas height', () => {
    const camera = cameraAt(60);
    const base = worldUnitsPerPixel(camera, new Vector3(), 900);
    camera.zoom = 2;
    camera.updateProjectionMatrix();
    expect(worldUnitsPerPixel(camera, new Vector3(), 900)).toBeCloseTo(base / 2, 10);
    expect(worldUnitsPerPixel(camera, new Vector3(), 1800)).toBeCloseTo(base / 4, 10);
  });

  it('is constant across depth for an orthographic camera', () => {
    const camera = new OrthographicCamera(-80, 80, 45, -45, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.zoom = 3;
    camera.updateProjectionMatrix();
    expect(worldUnitsPerPixel(camera, new Vector3(0, 0, 0), 900)).toBeCloseTo(90 / (3 * 900), 10);
    expect(worldUnitsPerPixel(camera, new Vector3(0, 0, -50), 900)).toBeCloseTo(90 / (3 * 900), 10);
  });

  it('never returns zero or a negative size for points at or behind the camera, or a zero-height canvas', () => {
    const camera = cameraAt(10);
    expect(worldUnitsPerPixel(camera, new Vector3(0, 0, 10), 900)).toBeGreaterThan(0);
    expect(worldUnitsPerPixel(camera, new Vector3(0, 0, 50), 900)).toBeGreaterThan(0);
    expect(Number.isFinite(worldUnitsPerPixel(camera, new Vector3(), 0))).toBe(true);
  });
});
