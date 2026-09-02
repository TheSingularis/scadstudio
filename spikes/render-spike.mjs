import { readFile, readdir, writeFile as fsWriteFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenSCAD } from 'openscad-wasm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');

function isPlausibleStl(stlText) {
  if (typeof stlText !== 'string') return stlText && stlText.length > 84; // binary STL header is 84 bytes
  return stlText.includes('solid') && stlText.includes('endsolid');
}

async function main() {
  const files = (await readdir(fixturesDir)).filter((f) => f.endsWith('.scad'));
  // Skip lib.scad — it's a `use`d library with no top-level geometry, nothing to render.
  const renderable = files.filter((f) => f !== 'lib.scad');

  let anyFailed = false;

  for (const file of renderable) {
    const messages = [];
    // NOTE: a single createOpenSCAD() instance reused across multiple renderToStl()
    // calls corrupts state after the first call (confirmed via spike — see PLAN.md
    // risk notes). Isolated-per-node rendering already implies many render calls per
    // document, so a fresh instance per call is required, not just a workaround here.
    const openscad = await createOpenSCAD({
      print: (t) => messages.push(`[stdout] ${t}`),
      printErr: (t) => messages.push(`[stderr] ${t}`),
    });

    const filePath = path.join(fixturesDir, file);
    const source = await readFile(filePath, 'utf8');

    // main-with-use.scad needs lib.scad alongside it in the virtual FS.
    if (file === 'main-with-use.scad') {
      const libSource = await readFile(path.join(fixturesDir, 'lib.scad'), 'utf8');
      openscad.getInstance().FS.writeFile('/lib.scad', libSource);
    }

    try {
      const stl = await openscad.renderToStl(source);
      const ok = isPlausibleStl(stl);
      const size = typeof stl === 'string' ? stl.length : stl.byteLength;
      console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${file} — STL output ${size} bytes`);
      if (!ok) {
        anyFailed = true;
        console.log('  messages:', messages.join('\n  '));
      }
    } catch (err) {
      anyFailed = true;
      console.log(`[FAIL] ${file} — threw: ${err.message}`);
      console.log('  messages:', messages.join('\n  '));
    }
  }

  console.log(anyFailed ? '\nRESULT: some fixtures failed to render' : '\nRESULT: all fixtures rendered valid STL');
  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error('Spike crashed:', err);
  process.exit(2);
});
