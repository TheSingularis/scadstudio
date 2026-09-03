import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Editor } from './components/Editor';
import { Viewport } from './components/Viewport';
import { parseScad } from './scadParser';
import { createCoalescingRunner } from './coalescingRunner';

const DEFAULT_SOURCE = `// scadstudio M2 live viewer — edit this, or open a .scad file
module bracket(w=20, h=10, thickness=3) {
    difference() {
        cube([w, h, thickness]);
        translate([thickness, thickness, -1])
            cube([w - 2 * thickness, h - 2 * thickness, thickness + 2]);
    }
}

union() {
    bracket(30, 15, 4);
    translate([0, 0, 10])
        cylinder(h=20, r=5, $fn=32);
}
`;

// Debounce window before a text edit triggers re-parse + re-render. See
// PLAN.md's render latency benchmark: full-document renders can take ~1.2s,
// so this is paired with a coalescing runner (only the latest text ever
// renders, no per-keystroke pile-up) rather than relying on debounce alone.
const RENDER_DEBOUNCE_MS = 400;

export function App(): JSX.Element {
  const [source, setSource] = useState(DEFAULT_SOURCE);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [stlBytes, setStlBytes] = useState<Uint8Array | null>(null);
  const [status, setStatus] = useState('Rendering...');
  const [parseErrorCount, setParseErrorCount] = useState<number | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runRender = useMemo(
    () =>
      createCoalescingRunner(async (src: string) => {
        setStatus('Rendering...');
        try {
          const bytes = await window.scadstudio.renderScad(src);
          setStlBytes(bytes);
          setStatus('Rendered');
        } catch (err) {
          setStatus(`Render failed: ${(err as Error).message}`);
          console.error('[scadstudio] render failed', err);
        }
      }),
    [],
  );

  const parseAndRender = useCallback(
    async (src: string) => {
      const { errorCount } = await parseScad(src);
      setParseErrorCount(errorCount);
      runRender(src);
    },
    [runRender],
  );

  useEffect(() => {
    parseAndRender(source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSourceChange = useCallback(
    (next: string) => {
      setSource(next);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => parseAndRender(next), RENDER_DEBOUNCE_MS);
    },
    [parseAndRender],
  );

  const handleOpen = useCallback(async () => {
    const result = await window.scadstudio.openFile();
    if (!result) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    setFilePath(result.filePath);
    setSource(result.contents);
    parseAndRender(result.contents);
  }, [parseAndRender]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'sans-serif' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '6px 12px',
          background: '#1e1e1e',
          color: '#ccc',
          fontSize: 13,
          borderBottom: '1px solid #333',
        }}
      >
        <button onClick={handleOpen}>Open .scad file...</button>
        <span>{filePath ?? '(unsaved default example)'}</span>
        <span style={{ marginLeft: 'auto', opacity: 0.7 }}>
          {parseErrorCount ? `${parseErrorCount} parse error(s) — ` : ''}
          {status}
        </span>
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Editor value={source} onChange={handleSourceChange} />
        </div>
        <div style={{ flex: 1, minWidth: 0, borderLeft: '1px solid #333' }}>
          <Viewport stlBytes={stlBytes} />
        </div>
      </div>
    </div>
  );
}
