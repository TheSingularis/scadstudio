import { useEffect, useMemo, useState } from 'react';
import { GizmoHelper } from '@react-three/drei';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { CanvasTexture, Matrix4, Quaternion, Vector3 } from 'three';

export type Vec3 = [number, number, number];

// A camera orientation, independent of where it's looking or how far away it
// sits: `direction` points from the look-at target toward the camera, `up` is
// screen-up. Viewport.tsx's animateCameraTo turns this plus a target/distance
// into an actual camera move — the one "animate to an orientation" primitive
// shared by the nav cube, its step arrows, and sketch-mode's plane lock.
export interface CameraView {
  direction: Vec3;
  up: Vec3;
}

// OpenSCAD's own conventions (Z-up, front looks toward +Y), not three.js's
// Y-up defaults — see PLAN.md's M7.5 nav-cube notes. Top/Bottom take a
// horizontal screen-up (the camera looks straight down/up Z, so Z can't be
// it); Top's +Y matches what tilting the Front view up by 90° lands on, and
// Bottom's -Y is the same tilt downward.
export const NAMED_VIEWS = {
  top: { direction: [0, 0, 1], up: [0, 1, 0] },
  bottom: { direction: [0, 0, -1], up: [0, -1, 0] },
  front: { direction: [0, -1, 0], up: [0, 0, 1] },
  back: { direction: [0, 1, 0], up: [0, 0, 1] },
  right: { direction: [1, 0, 0], up: [0, 0, 1] },
  left: { direction: [-1, 0, 0], up: [0, 0, 1] },
} satisfies Record<string, CameraView>;

export type NamedView = keyof typeof NAMED_VIEWS;

const FACES: { view: NamedView; label: string }[] = [
  { view: 'top', label: 'TOP' },
  { view: 'bottom', label: 'BOTTOM' },
  { view: 'front', label: 'FRONT' },
  { view: 'back', label: 'BACK' },
  { view: 'right', label: 'RIGHT' },
  { view: 'left', label: 'LEFT' },
];

// Edge and corner hit-boxes, same layout as drei's GizmoViewcube: small boxes
// poking just past the cube's surface (0.38 + half of 0.25 > 0.5) so they win
// the raycast near an edge/corner, invisible until hovered.
const EDGE_OFFSET = 0.38;
const EDGES: Vec3[] = [
  [1, 1, 0], [1, -1, 0], [-1, 1, 0], [-1, -1, 0],
  [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1],
  [0, 1, 1], [0, 1, -1], [0, -1, 1], [0, -1, -1],
];
const CORNERS: Vec3[] = [
  [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1],
  [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1],
];

const FACE_COLOR = '#dcdcdc';
const HOVER_TINT = '#8fbbe8';
const CUBE_SIZE_PX = 60;
// Distance of the cube's center from the canvas's top and right edges.
// Shared with Viewport.tsx's HTML overlay (step arrows, shading dropdown),
// which positions itself around that same center.
export const NAV_CUBE_MARGIN_PX = 90;

function faceTexture(label: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = FACE_COLOR;
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, 128, 128);
  ctx.fillStyle = '#222';
  ctx.font = `bold ${label.length > 5 ? 20 : 24}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 64, 66);
  return new CanvasTexture(canvas);
}

// One plane per face, placed and oriented explicitly from its named view
// (rather than a single BoxGeometry, whose per-face UVs assume three.js's
// Y-up framing and would print RIGHT/LEFT sideways and BACK upside-down here):
// the plane's local +X/+Y/+Z become the view's screen-right/screen-up/
// direction, so each label reads upright exactly when its face is clicked.
function CubeFace({ view, label, onPick }: { view: NamedView; label: string; onPick: (view: CameraView) => void }) {
  const [hover, setHover] = useState(false);
  const texture = useMemo(() => faceTexture(label), [label]);
  useEffect(() => () => texture.dispose(), [texture]);
  const { position, quaternion } = useMemo(() => {
    const normal = new Vector3(...NAMED_VIEWS[view].direction);
    const up = new Vector3(...NAMED_VIEWS[view].up);
    const right = up.clone().cross(normal);
    return {
      position: normal.clone().multiplyScalar(0.5),
      quaternion: new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, up, normal)),
    };
  }, [view]);
  return (
    <mesh
      position={position}
      quaternion={quaternion}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
      }}
      onPointerOut={() => setHover(false)}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        onPick(NAMED_VIEWS[view]);
      }}
    >
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial map={texture} color={hover ? HOVER_TINT : 'white'} />
    </mesh>
  );
}

function CubeHotspot({ axes, onPick }: { axes: Vec3; onPick: (view: CameraView) => void }) {
  const [hover, setHover] = useState(false);
  const position = axes.map((a) => a * EDGE_OFFSET) as Vec3;
  const dimensions = axes.map((a) => (a === 0 ? 0.5 : 0.25)) as Vec3;
  return (
    <mesh
      position={position}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
      }}
      onPointerOut={() => setHover(false)}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        // Every edge/corner has a horizontal component, so world +Z is never
        // parallel to the view direction and is always a valid screen-up.
        const direction = new Vector3(...axes).normalize();
        onPick({ direction: [direction.x, direction.y, direction.z], up: [0, 0, 1] });
      }}
    >
      <boxGeometry args={dimensions} />
      <meshBasicMaterial color={HOVER_TINT} transparent opacity={0.7} visible={hover} />
    </mesh>
  );
}

// Fixed top-right overlay cube that mirrors the main camera's orientation
// (GizmoHelper renders it in its own HUD scene and keeps its rotation synced
// to the main camera every frame). Clicking a face/edge/corner reports the
// corresponding view; the caller decides how to animate there. drei's own
// GizmoViewcube isn't used directly because its labels and face order assume
// three.js's Y-up convention.
export function NavCube({ onPick, disabled }: { onPick: (view: CameraView) => void; disabled: boolean }) {
  const gl = useThree((state) => state.gl);
  const pick = (view: CameraView) => {
    if (!disabled) onPick(view);
  };
  return (
    <GizmoHelper alignment="top-right" margin={[NAV_CUBE_MARGIN_PX, NAV_CUBE_MARGIN_PX]}>
      <group
        scale={CUBE_SIZE_PX}
        onPointerOver={() => {
          if (!disabled) gl.domElement.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          gl.domElement.style.cursor = '';
        }}
      >
        {FACES.map(({ view, label }) => (
          <CubeFace key={view} view={view} label={label} onPick={pick} />
        ))}
        {[...EDGES, ...CORNERS].map((axes) => (
          <CubeHotspot key={axes.join(',')} axes={axes} onPick={pick} />
        ))}
      </group>
    </GizmoHelper>
  );
}
