import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import createOpenSCADModule from '@lofcz/openscad-wasm';

// The one place the app touches the OpenSCAD WASM package, so a future
// engine bump changes this file and nothing else.
//
// M15 (2026-11-25): the engine is `@lofcz/openscad-wasm`, which tracks
// openscad/openscad-wasm plus a FreeType "no hinting" patch. The previous
// engine (`openscad-wasm@0.0.4`) aborted the whole WASM module ("null
// function or function signature mismatch") on any TrueType font without a
// hinting program, which is most modern fonts (checked with Source Code Pro;
// test/integration/engine.test.ts pins it). Liberation Sans and CFF .otf
// fonts rendered on both.
//
// The package ships its binary as a separate openscad.wasm. Node (and so
// Electron's utility process) can't fetch the file:// URL the package's own
// loader builds, so the bytes are read here and the module compiled once per
// process. Every render still gets a fresh instance (M0 finding: an instance
// can't be reused after callMain), but instantiating an already compiled
// module is much cheaper than compiling it again.

export interface EngineFS {
  writeFile: (p: string, data: string | ArrayBufferView) => void;
  readFile: {
    (p: string): Uint8Array;
    (p: string, opts: { encoding: 'utf8' }): string;
  };
  mkdir: (p: string) => void;
  mkdirTree?: (p: string) => void;
  analyzePath: (p: string) => { exists: boolean };
  stat: (p: string) => unknown;
}

export interface EngineInstance {
  FS: EngineFS;
  callMain: (args: string[]) => number;
}

export interface EngineOptions {
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  // Environment variables set before OpenSCAD's main() runs (it reads
  // OPENSCADPATH and FONTCONFIG_* once at startup).
  env?: Record<string, string>;
}

const require = createRequire(import.meta.url);

export function engineWasmPath(): string {
  return path.join(path.dirname(require.resolve('@lofcz/openscad-wasm')), 'openscad.wasm');
}

let compiled: Promise<WebAssembly.Module> | null = null;

function compiledModule(): Promise<WebAssembly.Module> {
  if (!compiled) {
    compiled = WebAssembly.compile(readFileSync(engineWasmPath())).catch((err) => {
      // Don't cache a failure, so the next render can retry.
      compiled = null;
      throw err;
    });
  }
  return compiled;
}

export async function createEngine(options: EngineOptions = {}): Promise<EngineInstance> {
  const wasm = await compiledModule();
  const env = options.env ?? {};
  const instance = await createOpenSCADModule({
    noInitialRun: true,
    print: options.print ?? (() => {}),
    printErr: options.printErr ?? (() => {}),
    instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) {
      void WebAssembly.instantiate(wasm, imports).then(done);
      return {};
    },
    preRun: [
      (module: { ENV?: Record<string, string> }) => {
        if (module?.ENV) Object.assign(module.ENV, env);
      },
    ],
  });
  return instance as unknown as EngineInstance;
}
