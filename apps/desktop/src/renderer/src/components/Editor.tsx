import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import { registerScadLanguage } from '../scadLanguage';

let languageRegistered = false;

interface EditorProps {
  value: string;
  onChange: (value: string) => void;
}

export function Editor({ value, onChange }: EditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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
    // Manual verification hook: lets SCADSTUDIO_TEST_EDIT (main/index.ts) script
    // an edit via executeJavaScript for screenshot-based milestone verification.
    (window as unknown as { __testEditor?: typeof editor }).__testEditor = editor;

    const subscription = editor.onDidChangeModelContent(() => {
      onChangeRef.current(editor.getValue());
    });

    return () => {
      subscription.dispose();
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

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
