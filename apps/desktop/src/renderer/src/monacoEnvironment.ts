import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

// Monaco needs a worker for basic editing-model services even with no
// language-specific (e.g. TS/JSON) features enabled. M1 only uses the plain
// editorWorkerService — no scad-specific worker yet (that's the real
// tree-sitter-backed parser from later milestones, not a Monaco worker).
self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};
