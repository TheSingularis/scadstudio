import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import { registerScadLanguage } from '../scadLanguage';

let languageRegistered = false;

interface EditorProps {
  value: string;
}

export function Editor({ value }: EditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    if (!languageRegistered) {
      registerScadLanguage();
      languageRegistered = true;
    }
    if (!containerRef.current) return;

    editorRef.current = monaco.editor.create(containerRef.current, {
      value,
      language: 'scad',
      theme: 'vs-dark',
      readOnly: true, // M1 scope: read-only viewer. Editable sync arrives in M2.
      minimap: { enabled: false },
      automaticLayout: true,
      fontSize: 13,
    });

    return () => {
      editorRef.current?.dispose();
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
