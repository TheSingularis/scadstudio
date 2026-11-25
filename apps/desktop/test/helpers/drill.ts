// M9 helpers: SourceDocs and a module resolver over real parses.
import type { Node } from 'web-tree-sitter';
import { parse } from './parse';
import type { ModuleResolver, SourceDoc } from '../../src/renderer/src/drillIn';

export async function docOf(text: string, kind: 'document' | 'library' = 'document', path: string | null = null): Promise<SourceDoc> {
  return { kind, path, text, tree: await parse(text) };
}

function topModule(doc: SourceDoc, name: string): Node | null {
  for (const stmt of doc.tree.rootNode.children) {
    const def = stmt?.type === 'statement' ? stmt.child(0) : stmt;
    if (def?.type === 'module_definition' && def.childForFieldName('name')?.text === name) return def;
  }
  return null;
}

/** Looks a module up in `from`, then (from the document) in `libraries`, like App.tsx's resolver. */
export function resolverFor(document: SourceDoc, libraries: SourceDoc[] = []): ModuleResolver {
  return (name, from) => {
    const own = topModule(from, name);
    if (own) return { def: own, doc: from };
    if (from.kind !== 'document' && from !== document) return null;
    for (const lib of libraries) {
      const def = topModule(lib, name);
      if (def) return { def, doc: lib };
    }
    return null;
  };
}
