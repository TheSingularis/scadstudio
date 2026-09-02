import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language } from 'web-tree-sitter';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');
const wasmPath = path.join(
  __dirname,
  '..',
  'node_modules',
  '@holistic-stack',
  'tree-sitter-openscad',
  'tree-sitter-openscad.wasm',
);

function collectErrors(node, source, errors) {
  if (node.type === 'ERROR' || node.isMissing) {
    errors.push({
      type: node.isMissing ? 'MISSING' : 'ERROR',
      startPosition: node.startPosition,
      endPosition: node.endPosition,
      text: source.slice(node.startIndex, node.endIndex).slice(0, 80),
    });
  }
  for (let i = 0; i < node.childCount; i++) {
    collectErrors(node.child(i), source, errors);
  }
}

async function main() {
  await Parser.init();
  // web-tree-sitter 0.25.3's ESM build can't dynamic-require("fs/promises") when
  // given a path string, so read the wasm bytes ourselves and pass a Buffer.
  const wasmBytes = await readFile(wasmPath);
  const language = await Language.load(wasmBytes);
  const parser = new Parser();
  parser.setLanguage(language);

  const files = (await readdir(fixturesDir)).filter((f) => f.endsWith('.scad'));
  let anyFailed = false;

  for (const file of files) {
    const filePath = path.join(fixturesDir, file);
    const source = await readFile(filePath, 'utf8');
    const tree = parser.parse(source);
    const errors = [];
    collectErrors(tree.rootNode, source, errors);

    if (errors.length > 0) {
      anyFailed = true;
      console.log(`\n[FAIL] ${file} — ${errors.length} error/missing node(s):`);
      for (const e of errors) {
        console.log(
          `  ${e.type} at ${e.startPosition.row + 1}:${e.startPosition.column + 1} — "${e.text.replace(/\n/g, '\\n')}"`,
        );
      }
    } else {
      console.log(`[OK]   ${file} — clean parse, ${tree.rootNode.childCount} top-level nodes`);
    }
  }

  // Sanity: confirm incremental edit API works, since bidirectional sync depends on it.
  const before = 'cube([10, 10, 10]);\n';
  const after = 'cube([10, 10, 25]);\n';
  const tree1 = parser.parse(before);
  const editStart = before.indexOf('10]);') + 0; // position of the second "10"
  const startIndex = before.lastIndexOf('10');
  tree1.edit({
    startIndex,
    oldEndIndex: startIndex + 2,
    newEndIndex: startIndex + 2,
    startPosition: { row: 0, column: startIndex },
    oldEndPosition: { row: 0, column: startIndex + 2 },
    newEndPosition: { row: 0, column: startIndex + 2 },
  });
  const tree2 = parser.parse(after, tree1);
  const editErrors = [];
  collectErrors(tree2.rootNode, after, editErrors);
  if (editErrors.length > 0) {
    anyFailed = true;
    console.log('\n[FAIL] incremental edit sanity check produced errors:', editErrors);
  } else {
    console.log('\n[OK]   incremental tree.edit() + reparse sanity check passed');
  }

  console.log(anyFailed ? '\nRESULT: grammar has gaps, see failures above' : '\nRESULT: all fixtures parsed cleanly');
  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error('Spike crashed:', err);
  process.exit(2);
});
