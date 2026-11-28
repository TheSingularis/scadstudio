import { OrthographicCamera, PerspectiveCamera, Vector3, type Camera } from 'three';

// Sketch overlay markers (point handles, snap dot, arc anchors) and dash
// patterns are sized in screen pixels, not model units, so they stay the
// same size on screen at every zoom: zooming in makes them smaller relative
// to the model, which is what lets you work on fine detail. See
// components/ScreenDot.tsx.

// Sizes, as radii in CSS pixels.
export const SKETCH_HANDLE_RADIUS_PX = 5;
// Circles and arcs put many points close together; their handles are drawn
// smaller so the outline stays readable.
export const SKETCH_DENSE_HANDLE_RADIUS_PX = 3.5;
export const SKETCH_ACTIVE_HANDLE_RADIUS_PX = 7;
// Every handle is grabbable within at least this radius, even when drawn
// smaller, so the small dense-loop handles aren't fiddly to hit.
export const SKETCH_HANDLE_HIT_RADIUS_PX = 7;
export const SNAP_MARKER_RADIUS_PX = 4.5;
export const SNAP_CLOSE_MARKER_RADIUS_PX = 8;
export const SKETCH_ANCHOR_RADIUS_PX = 4.5;

const scratch = new Vector3();

// World units covered by one screen pixel at `point`, for a canvas
// `viewportHeightPx` tall. Perspective uses the point's view-space depth
// (distance along the camera's look direction, not straight-line distance,
// which overstates it off-axis); orthographic is the same everywhere.
// Returns a small positive number even for a point at or behind the camera,
// so callers never scale anything to zero or negative.
export function worldUnitsPerPixel(camera: Camera, point: Vector3, viewportHeightPx: number): number {
  const height = Math.max(1, viewportHeightPx);
  if (camera instanceof OrthographicCamera) {
    return (camera.top - camera.bottom) / (camera.zoom * height);
  }
  const fov = camera instanceof PerspectiveCamera ? camera.fov : 45;
  const zoom = camera instanceof PerspectiveCamera ? camera.zoom : 1;
  camera.updateMatrixWorld();
  const depth = Math.max(1e-6, -scratch.copy(point).applyMatrix4(camera.matrixWorldInverse).z);
  return (2 * depth * Math.tan((fov * Math.PI) / 360)) / (zoom * height);
}
