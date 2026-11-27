import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

// M10b: one floating window over the 3D viewport, like Onshape's feature
// dialogs. Every tool's UI uses it: the booleans, the extrudes, Distance /
// Align / Pattern, the selected part's properties (parameters, position,
// color, ...) and M13's fillet/chamfer edges.
//
// - Placed in the viewport's top-left corner by default (the breadcrumb and
//   drill-in banners use the bottom left, the nav cube the top right).
// - Dragged by its title bar; the position is remembered per `storageKey`
//   (every tool window shares one key, so they all open where the last one
//   was left) and kept inside the viewport when it is resized.
// - Double-clicking the title bar puts it back in the corner.
// - `collapsible` windows fold to their title bar; that is remembered too.
//
// It positions itself inside the nearest positioned ancestor (the viewport
// pane), so it scrolls its own body rather than growing past the viewport.

export interface FloatingWindowProps {
  title: ReactNode;
  // Extra content in the title bar, after the title (a badge, a count).
  badge?: ReactNode;
  // Where position (and collapsed state) is remembered.
  storageKey: string;
  // Accessible name of the window (role="dialog"); defaults to the title
  // when that is a string.
  label?: string;
  // Buttons at the bottom (Apply / Cancel). Omit for a window without them.
  footer?: ReactNode;
  // Shows a close (×) button in the title bar.
  onClose?: () => void;
  collapsible?: boolean;
  width?: number;
  children: ReactNode;
  testId?: string;
}

const MARGIN = 8;
const DEFAULT_POSITION = { x: MARGIN, y: MARGIN };

interface Stored {
  x: number;
  y: number;
  collapsed?: boolean;
}

function readStored(key: string): Stored | null {
  try {
    const raw = localStorage.getItem(`scadstudio.window.${key}`);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Stored>;
    if (typeof v.x !== 'number' || typeof v.y !== 'number' || !Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
    return { x: v.x, y: v.y, collapsed: v.collapsed === true };
  } catch {
    return null;
  }
}

function writeStored(key: string, value: Stored) {
  try {
    localStorage.setItem(`scadstudio.window.${key}`, JSON.stringify(value));
  } catch {
    // Storage unavailable: the position lasts for this session only.
  }
}

// Keeps at least the title bar reachable: the window may not leave the
// parent's box (it is clamped back when the viewport shrinks).
export function clampPosition(
  pos: { x: number; y: number },
  size: { width: number; height: number },
  bounds: { width: number; height: number },
): { x: number; y: number } {
  const maxX = Math.max(MARGIN, bounds.width - size.width - MARGIN);
  const maxY = Math.max(MARGIN, bounds.height - Math.min(size.height, 32) - MARGIN);
  return {
    x: Math.round(Math.min(Math.max(pos.x, MARGIN), maxX)),
    y: Math.round(Math.min(Math.max(pos.y, MARGIN), maxY)),
  };
}

export function FloatingWindow(props: FloatingWindowProps) {
  const { storageKey } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<Stored>(() => readStored(storageKey) ?? { ...DEFAULT_POSITION, collapsed: false });
  const stateRef = useRef(state);
  stateRef.current = state;
  const drag = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);

  const bounds = useCallback(() => {
    const el = ref.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return null;
    return { size: { width: el.offsetWidth, height: el.offsetHeight }, bounds: { width: parent.clientWidth, height: parent.clientHeight } };
  }, []);

  const place = useCallback(
    (pos: { x: number; y: number }, persist: boolean) => {
      const b = bounds();
      const next = b ? clampPosition(pos, b.size, b.bounds) : pos;
      const value = { ...stateRef.current, ...next };
      setState(value);
      if (persist) writeStored(storageKey, value);
    },
    [bounds, storageKey],
  );

  // A window opened under another key (or after the viewport shrank) is
  // pulled back inside before it paints.
  useLayoutEffect(() => {
    place(stateRef.current, false);
  }, [place]);

  // Keep it inside when the viewport (or the app window) is resized.
  useEffect(() => {
    const parent = ref.current?.offsetParent as HTMLElement | null;
    if (!parent || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => place(stateRef.current, false));
    ro.observe(parent);
    return () => ro.disconnect();
  }, [place]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // The title bar's own buttons (close, collapse) are not drag handles.
    if ((e.target as HTMLElement).closest('button')) return;
    drag.current = { pointerId: e.pointerId, dx: e.clientX - stateRef.current.x, dy: e.clientY - stateRef.current.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    place({ x: e.clientX - d.dx, y: e.clientY - d.dy }, false);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    writeStored(storageKey, stateRef.current);
  };
  const toggleCollapsed = () => {
    const value = { ...stateRef.current, collapsed: !stateRef.current.collapsed };
    setState(value);
    writeStored(storageKey, value);
  };

  const collapsed = props.collapsible === true && state.collapsed === true;
  const label = props.label ?? (typeof props.title === 'string' ? props.title : undefined);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      data-testid={props.testId}
      data-floating-window={storageKey}
      // Clicks and drags inside the window never reach the 3D view under it.
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        left: state.x,
        top: state.y,
        zIndex: 20,
        width: props.width ?? 290,
        maxHeight: `calc(100% - ${MARGIN * 2}px)`,
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(31, 42, 51, 0.97)',
        color: '#ddd',
        fontSize: 12,
        fontFamily: 'sans-serif',
        border: '1px solid #3d5366',
        borderRadius: 6,
        boxShadow: '0 4px 16px rgba(0,0,0,0.45)',
      }}
    >
      <div
        data-testid="window-title-bar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          place(DEFAULT_POSITION, true);
        }}
        title="Drag to move. Double-click to put it back in the corner."
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 6px 5px 10px',
          background: '#25374a',
          borderBottom: collapsed ? 'none' : '1px solid #3d5366',
          borderRadius: collapsed ? 6 : '6px 6px 0 0',
          cursor: 'move',
          userSelect: 'none',
          flex: 'none',
        }}
      >
        <strong style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{props.title}</strong>
        {props.badge}
        <span style={{ flex: 1 }} />
        {props.collapsible && (
          <button
            aria-label={collapsed ? 'Expand window' : 'Collapse window'}
            aria-expanded={!collapsed}
            onClick={toggleCollapsed}
            style={titleButton}
            title={collapsed ? 'Expand' : 'Collapse to the title bar'}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        )}
        {props.onClose && (
          <button aria-label="Close window" onClick={props.onClose} style={titleButton} title="Close (Esc)">
            ×
          </button>
        )}
      </div>
      {!collapsed && (
        <>
          <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', minHeight: 0 }}>{props.children}</div>
          {props.footer && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, padding: '6px 10px', borderTop: '1px solid #3d5366', flex: 'none' }}>{props.footer}</div>
          )}
        </>
      )}
    </div>
  );
}

const titleButton: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#ccc',
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
  padding: '0 4px',
};

// A labeled row inside a window: the label on the left, the control(s) on
// the right. Used by every tool so the windows line up the same way.
export function WindowRow({ label, children, title }: { label: ReactNode; children: ReactNode; title?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }} title={title}>
      <span style={{ opacity: 0.7, minWidth: 64 }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', minWidth: 0 }}>{children}</span>
    </div>
  );
}

// A titled group of rows inside a window.
export function WindowSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.55 }}>{title}</div>
      {children}
    </section>
  );
}
