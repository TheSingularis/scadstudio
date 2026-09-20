import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import { registerScadLanguage } from '../scadLanguage';
import type { SceneNode } from '../sceneGraph';

let languageRegistered = false;

interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  nodes: SceneNode[];
  selectedIndex: number | null;
  onSelectNode: (index: number | null) => void;
}

export function Editor({ value, onChange, nodes, selectedIndex, onSelectNode }: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSelectNodeRef = useRef(onSelectNode);
  onSelectNodeRef.current = onSelectNode;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  useEffect(() => {
    if (!languageRegistered) {
      registerScadLanguage();
      languageRegistered = true;
    }
    if (!containerRef.current) return;

    const editor = monaco.editor.create(containerRef.current, {
      value,
      language: 'scad',
      theme: 'vs-dark',
      minimap: { enabled: false },
      automaticLayout: true,
      fontSize: 13,
    });
    editorRef.current = editor;
    decorationsRef.current = editor.createDecorationsCollection();
    // Raw Monaco instance, exposed for ad-hoc manual debugging via devtools.
    // SCADSTUDIO_TEST_EDIT (main/index.ts) used to script edits through this
    // (`__testEditor.setValue(...)`), but that relied on
    // onDidChangeModelContent to carry the change into React state — now
    // guarded against isFlush (2026-09-20 double-render fix), which broke
    // it; see App.tsx's window.__testSetSource for the harness's real path.
    (window as unknown as { __testEditor?: typeof editor }).__testEditor = editor;

    // Real bug found 2026-09-20: every programmatic edit in the app (gizmo
    // commits, toolbar inserts, booleans, modifiers, sketch finish/extrude —
    // anything that flows a new `value` down into this component) calls
    // App.tsx's runRender directly *and* triggers this handler a second
    // time, since the `model.setValue()` below fires onDidChangeModelContent
    // indistinguishably from real typing — App.tsx's onChange (this app's
    // handleSourceChange) then schedules a second, redundant debounced
    // render ~400ms later for the exact same content. Every programmatic
    // edit has been double-rendering since M2/M4; this only became visible
    // now because the M7 bare-2D retry path logs a WASM error per attempt,
    // making the duplicate obvious in the console. `isFlush` is Monaco's own
    // flag for "this change came from setValue()," the exact content-change
    // analog of the ContentFlush guard already below for cursor resets.
    const changeSub = editor.onDidChangeModelContent((e) => {
      if (e.isFlush) return;
      onChangeRef.current(editor.getValue());
    });

    // Text -> selection: find which top-level scene node contains the cursor.
    // Every programmatic `model.setValue()` below (i.e. every gizmo/toolbar
    // commit, since those flow back through this component's `value` prop)
    // resets Monaco's cursor to the start of the document as a side effect —
    // reported with reason `ContentFlush`, distinct from a real user-driven
    // move. Without this guard, that reset masquerades as "user clicked at
    // offset 0", which is inside the leading comment (no scene node there),
    // silently deselecting whatever a gizmo drag had just been editing right
    // as its own re-render was about to land.
    const cursorSub = editor.onDidChangeCursorPosition((e) => {
      if (e.reason === monaco.editor.CursorChangeReason.ContentFlush) return;
      const model = editor.getModel();
      if (!model) return;
      const offset = model.getOffsetAt(e.position);
      const hit = nodesRef.current.find((n) => offset >= n.startIndex && offset < n.endIndex);
      onSelectNodeRef.current(hit ? hit.index : null);
    });

    return () => {
      changeSub.dispose();
      cursorSub.dispose();
      editor.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && model.getValue() !== value) {
      model.setValue(value);
    }
  }, [value]);

  // Selection -> text: highlight the selected node's range (doesn't move the
  // cursor, so it doesn't fight with the user if they're editing elsewhere).
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const decorations = decorationsRef.current;
    if (!editor || !model || !decorations) return;

    const node = selectedIndex !== null ? nodes.find((n) => n.index === selectedIndex) : undefined;
    if (!node) {
      decorations.set([]);
      return;
    }
    const range = monaco.Range.fromPositions(model.getPositionAt(node.startIndex), model.getPositionAt(node.endIndex));
    decorations.set([{ range, options: { className: 'scad-selected-node', isWholeLine: false } }]);
    editor.revealRangeInCenterIfOutsideViewport(range);
  }, [selectedIndex, nodes]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
