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
    // Manual verification hook: lets SCADSTUDIO_TEST_EDIT (main/index.ts) script
    // an edit via executeJavaScript for screenshot-based milestone verification.
    (window as unknown as { __testEditor?: typeof editor }).__testEditor = editor;

    const changeSub = editor.onDidChangeModelContent(() => {
      onChangeRef.current(editor.getValue());
    });

    // Text -> selection: find which top-level scene node contains the cursor.
    const cursorSub = editor.onDidChangeCursorPosition((e) => {
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
