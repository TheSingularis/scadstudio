// Shared parsing helpers: every test that needs a CST gets it from the app's
// own parseScad() (real tree-sitter-openscad grammar from src/renderer/public),
// so targetedPatch/sceneGraph are always tested against real trees.
import type { Tree } from 'web-tree-sitter';
import { parseScad } from '../../src/renderer/src/scadParser';
import { buildSceneGraph, type SceneGraph, type SceneNode } from '../../src/renderer/src/sceneGraph';

export interface Parsed {
  source: string;
  tree: Tree;
  errorCount: number;
  graph: SceneGraph;
}

export async function parse(source: string): Promise<Tree> {
  return (await parseScad(source)).tree;
}

export async function parseWithGraph(source: string): Promise<Parsed> {
  const { tree, errorCount } = await parseScad(source);
  return { source, tree, errorCount, graph: buildSceneGraph(tree, source) };
}

export async function sceneNodes(source: string): Promise<SceneNode[]> {
  return (await parseWithGraph(source)).graph.nodes;
}

/** Parse `source` and return its tree plus top-level scene node `index`. */
export async function nodeAt(source: string, index = 0): Promise<Parsed & { node: SceneNode }> {
  const parsed = await parseWithGraph(source);
  const node = parsed.graph.nodes[index];
  if (!node) throw new Error(`no scene node ${index} in:\n${source}`);
  return { ...parsed, node };
}

/** Parse, assert the result is syntactically clean, and return it. */
export async function expectCleanParse(source: string): Promise<Parsed> {
  const parsed = await parseWithGraph(source);
  if (parsed.errorCount !== 0) throw new Error(`expected a clean parse, got ${parsed.errorCount} error(s):\n${source}`);
  return parsed;
}
