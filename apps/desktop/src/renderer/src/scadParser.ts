import { Parser, Language, Tree } from 'web-tree-sitter';

let parserPromise: Promise<Parser> | null = null;

async function loadWasmBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  return new Uint8Array(await res.arrayBuffer());
}

// `/foo.wasm` (leading slash) resolves against the OS filesystem root under
// Electron's file:// production loading, not the app bundle — must go through
// Vite's BASE_URL so this works both in dev (http://localhost) and prod (file://).
const base = import.meta.env.BASE_URL;

function getParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init({ locateFile: () => `${base}tree-sitter.wasm` });
      const language = await Language.load(await loadWasmBytes(`${base}tree-sitter-openscad.wasm`));
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })();
  }
  return parserPromise;
}

export interface ParseResult {
  tree: Tree;
  errorCount: number;
}

function countErrors(node: import('web-tree-sitter').Node): number {
  let count = node.type === 'ERROR' || node.isMissing ? 1 : 0;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) count += countErrors(child);
  }
  return count;
}

// M2 scope: incremental parse only (feeding tree.edit() forward isn't wired
// in yet since there's no scene-graph consuming byte ranges until M3 — this
// re-parses fresh each call but reuses the loaded Parser/Language instance).
export async function parseScad(source: string, previousTree?: Tree): Promise<ParseResult> {
  const parser = await getParser();
  const tree = parser.parse(source, previousTree);
  if (!tree) throw new Error('tree-sitter returned no tree');
  return { tree, errorCount: countErrors(tree.rootNode) };
}
