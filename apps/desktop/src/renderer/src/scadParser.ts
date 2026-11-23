import { Parser, Language, Tree } from 'web-tree-sitter';

let parserPromise: Promise<Parser> | null = null;
// The same Parser once it has loaded, for parseScadSync below.
let loadedParser: Parser | null = null;

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
      loadedParser = parser;
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

// Re-parses from scratch on each call, reusing the loaded Parser/Language
// instance. Not incremental: that would need tree.edit() fed with each
// change's byte ranges, and a full parse of a typical file is a few ms.
export async function parseScad(source: string): Promise<ParseResult> {
  const parser = await getParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error('tree-sitter returned no tree');
  return { tree, errorCount: countErrors(tree.rootNode) };
}

// Synchronous parse for edit handlers that must work on a tree matching the
// latest text right now, not the one the last async render parsed (QC audit
// M3). Null only before the grammar has finished loading, which is before
// the first render, so before any visual edit is possible.
export function parseScadSync(source: string): Tree | null {
  return loadedParser?.parse(source) ?? null;
}
