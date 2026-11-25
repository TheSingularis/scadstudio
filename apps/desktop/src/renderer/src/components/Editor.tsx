import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import { registerScadLanguage } from '../scadLanguage';
import type { SceneNode } from '../sceneGraph';
import { minimalReplacement } from '../textDiff';

let languageRegistered = false;

interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  nodes: SceneNode[];
  selectedIndex: number | null;
  onSelectNode: (index: number | null) => void;
  // Changes when a different document is loaded (File > Open). Only then is
  // the editor's undo history reset; every other `value` change is a visual
  // edit, applied as an undoable edit on top of the existing history.
  documentKey?: string | number;
  // M9: while drilled in, the drilled-into node's body; everything outside
  // it is dimmed, the editor's version of the viewport's dimmed context.
  focusRange?: { start: number; end: number } | null;
}

export function Editor({ value, onChange, nodes, selectedIndex, onSelectNode, documentKey, focusRange = null }: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const focusDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSelectNodeRef = useRef(onSelectNode);
  onSelectNodeRef.current = onSelectNode;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  // True while this component itself is writing `value` into the model, so
  // the change and cursor events that write fires are not mistaken for the
  // user typing or clicking.
  const applyingValueRef = useRef(false);
  // Texts this editor has itself reported through onChange since the last
  // visual edit. React can commit a render for an older keystroke after the
  // user has already typed the next one; that stale `value` must not be
  // written back over the newer text (doing so deleted typed characters).
  const emittedRef = useRef<string[]>([]);
  const documentKeyRef = useRef(documentKey);

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
    focusDecorationsRef.current = editor.createDecorationsCollection();
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
    //
    // Visual edits now go through executeEdits (see the value effect below),
    // which is not a flush, so applyingValueRef covers them instead.
    const changeSub = editor.onDidChangeModelContent((e) => {
      if (e.isFlush || applyingValueRef.current) return;
      const text = editor.getValue();
      emittedRef.current.push(text);
      if (emittedRef.current.length > 200) emittedRef.current.shift();
      onChangeRef.current(text);
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
      if (e.reason === monaco.editor.CursorChangeReason.ContentFlush || applyingValueRef.current) return;
      const model = editor.getModel();
      if (!model) return;
      // A click in a line's indentation means that line's statement (M9:
      // drilled-in statements are indented, and clicking at the start of
      // their line should select them).
      const indentEnd = model.getLineFirstNonWhitespaceColumn(e.position.lineNumber);
      const position = indentEnd > 0 && e.position.column < indentEnd ? { lineNumber: e.position.lineNumber, column: indentEnd } : e.position;
      const offset = model.getOffsetAt(position);
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

  // Programmatic edits (gizmo commits, toolbar inserts, booleans, modifiers,
  // sketches) arrive as a new `value`. They used to go through
  // model.setValue(), which wipes Monaco's undo stack, so no visual edit
  // could be undone and the typed history before it was lost too (QC audit
  // H3). PLAN.md's visual edit path specifies executeEdits: each visual edit
  // becomes one undo step of its own, between undo stops, so Ctrl+Z steps
  // back through visual and typed edits alike. Only loading a different
  // document (documentKey changes) starts a fresh history.
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const newDocument = documentKeyRef.current !== documentKey;
    documentKeyRef.current = documentKey;
    const current = model.getValue();
    if (current === value) return;
    // An echo of the user's own typing, possibly a keystroke behind: the
    // model already holds that text or newer, so leave it alone.
    if (!newDocument && emittedRef.current.includes(value)) return;
    emittedRef.current = [];
    applyingValueRef.current = true;
    try {
      if (newDocument) {
        model.setValue(value);
        return;
      }
      const { start, end, text } = minimalReplacement(current, value);
      const range = monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(end));
      editor.pushUndoStop();
      editor.executeEdits('scadstudio-visual-edit', [{ range, text, forceMoveMarkers: true }]);
      editor.pushUndoStop();
    } finally {
      applyingValueRef.current = false;
    }
  }, [value, documentKey]);

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

  useEffect(() => {
    const model = editorRef.current?.getModel();
    const decorations = focusDecorationsRef.current;
    if (!model || !decorations) return;
    if (!focusRange) {
      decorations.set([]);
      return;
    }
    const length = model.getValueLength();
    const ranges: [number, number][] = [
      [0, Math.min(focusRange.start, length)],
      [Math.min(focusRange.end, length), length],
    ];
    decorations.set(
      ranges
        .filter(([a, b]) => b > a)
        .map(([a, b]) => ({
          range: monaco.Range.fromPositions(model.getPositionAt(a), model.getPositionAt(b)),
          options: { inlineClassName: 'scad-out-of-focus' },
        })),
    );
  }, [focusRange?.start, focusRange?.end, value]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
