// Regression test for the two tree-sitter-openscad grammar gaps found during the
// M0 spike (see PLAN.md "M0 spike results"). Re-run after bumping the grammar
// version to check whether either has been fixed upstream.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language } from 'web-tree-sitter';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(__dirname, '..', 'node_modules', '@holistic-stack', 'tree-sitter-openscad', 'tree-sitter-openscad.wasm');

function hasError(node) {
  if (node.type === 'ERROR' || node.isMissing) return true;
  for (let i = 0; i < node.childCount; i++) if (hasError(node.child(i))) return true;
  return false;
}

await Parser.init();
const language = await Language.load(await readFile(wasmPath));
const parser = new Parser();
parser.setLanguage(language);

const cases = {
  'bare each in list literal': 'flattened = [each [1, 2, 3], each [4, 5], 6];',
  'each only (no bare literal)': 'flattened = [for (v = [1,2,3]) each [v]];',
  'chained for-for comprehension': 'nested = [for (x = [0:2]) for (y = [0:2]) [x, y]];',
  'combined multi-var for comprehension': 'nested = [for (x = [0:2], y = [0:2]) [x, y]];',
};

for (const [label, code] of Object.entries(cases)) {
  const tree = parser.parse(code);
  console.log(`${hasError(tree.rootNode) ? '[ERROR]' : '[OK]   '} ${label}`);
}
