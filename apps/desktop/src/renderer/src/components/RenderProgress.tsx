import { useEffect, useState, type RefObject } from 'react';

// M10a: what the viewport shows while a render runs (Jordan, 2026-11-26:
// opening the gag trophy showed only a small "Rendering..." at the end of
// the top bar for over a minute, over the previous file's model).
//
// The engine reports no percentage (it prints nothing until it is done), so
// the bar is indeterminate. What it can say honestly: how long it has been
// running, which part of how many (when the working set has several), and
// which step a part is on.

export type RenderStage = 'preparing' | 'engine' | 'mesh';

export interface RenderProgress {
  // performance.now() when the render started.
  startedAt: number;
  // 1-based part being rendered, of `parts` (0 until the parts are known).
  part: number;
  parts: number;
  // The current part's step, from the render process; null for a part that
  // came from the cache.
  stage: RenderStage | null;
  // Rendering the dimmed parts around a drill-in, after the working set.
  context: boolean;
}

// Renders quicker than this (most edits) show no overlay and no grey-out,
// so typing doesn't flicker the viewport.
export const RENDER_PROGRESS_DELAY_MS = 400;

const STAGE_LABELS: Record<RenderStage, string> = {
  preparing: 'Loading files and fonts',
  engine: 'OpenSCAD is building the geometry',
  mesh: 'Reading the mesh',
};

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function progressLabel(p: RenderProgress): string {
  const parts: string[] = [];
  if (p.parts > 1) parts.push(p.context ? `surrounding part ${p.part} of ${p.parts}` : `part ${p.part} of ${p.parts}`);
  else if (p.context) parts.push('surrounding parts');
  if (p.stage) parts.push(STAGE_LABELS[p.stage]);
  return parts.join(' · ');
}

// True once a render started at `startedAt` (performance.now(), or null when
// idle) has been running for RENDER_PROGRESS_DELAY_MS.
export function useRenderIsSlow(startedAt: number | null): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (startedAt === null) return;
    const wait = Math.max(0, RENDER_PROGRESS_DELAY_MS - (performance.now() - startedAt));
    const timer = setTimeout(() => setSlow(true), wait);
    return () => clearTimeout(timer);
  }, [startedAt]);
  return slow;
}

// Reads the progress from a ref on its own 250 ms timer (see App.tsx).
export function RenderProgressOverlay({ progressRef, onCancel }: { progressRef: RefObject<RenderProgress | null>; onCancel: () => void }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const progress = progressRef.current;
  if (!progress) return null;
  const label = progressLabel(progress);
  return (
    <div
      role="status"
      aria-label="Render progress"
      data-testid="render-progress"
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 24,
        transform: 'translateX(-50%)',
        width: 'min(420px, calc(100% - 32px))',
        background: 'rgba(24,26,30,0.92)',
        color: '#e8e8e8',
        border: '1px solid #3a3f47',
        borderRadius: 6,
        padding: '10px 12px',
        font: '13px system-ui, sans-serif',
        boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
        zIndex: 5,
        pointerEvents: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontWeight: 600 }}>Rendering</strong>
        <span data-testid="render-elapsed" style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.8 }}>
          {formatElapsed(now - progress.startedAt)}
        </span>
        <button onClick={onCancel} style={{ marginLeft: 'auto' }} title="Stop this render. The model keeps showing the last finished render.">
          Cancel
        </button>
      </div>
      <div
        style={{ position: 'relative', height: 4, marginTop: 8, background: '#2c3036', borderRadius: 2, overflow: 'hidden' }}
        aria-hidden
      >
        <div className="scadstudio-progress-bar" />
      </div>
      {label && (
        <div data-testid="render-stage" style={{ marginTop: 6, opacity: 0.75, fontSize: 12 }}>
          {label}
        </div>
      )}
      <style>{`
        .scadstudio-progress-bar {
          position: absolute; top: 0; bottom: 0; width: 35%;
          background: #4a90d9; border-radius: 2px;
          animation: scadstudio-progress 1.4s ease-in-out infinite;
        }
        @keyframes scadstudio-progress {
          0% { left: -35%; }
          100% { left: 100%; }
        }
      `}</style>
    </div>
  );
}
