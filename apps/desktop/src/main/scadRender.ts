import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createEngine, type EngineFS } from './engine';
import { offToColoredStl } from './offMesh';
import { capCsgDetail, readTopLevelProbe, TOP_LEVEL_PROBE, topLevelFactor, topLevelOverrides } from './previewDetail';
import { isFontPath } from './fonts';
import { FONT_ROOT, bundledFontFiles, fontFileCache } from './fontStore';

// Everything the main process needs to turn OpenSCAD source into mesh bytes,
// kept free of Electron imports so it can be exercised directly from Node.
//
// Two things this does that a bare `renderToStl()` call does not:
//
// 1. It runs OpenSCAD with `--backend=Manifold`. PLAN.md names Manifold as a
//    fixed constraint; openscad-wasm's `renderToStl()` helper passes no
//    backend flag, so OpenSCAD fell back to its CGAL default, which measured
//    about 57x slower on basics.scad (QC audit H1).
//
// 2. It copies every file the source pulls in through `use <...>` /
//    `include <...>` into the WASM filesystem before rendering (QC audit H4).
//    The WASM build has only an in-memory filesystem, so before this a file
//    that imported a library rendered nothing. Files are mirrored at a
//    virtual path that mirrors their real absolute path (see toVirtualPath),
//    so relative paths, including `../`, resolve exactly the way they would
//    for desktop OpenSCAD, and library folders are handed to OpenSCAD through
//    its own OPENSCADPATH lookup.
//
// 3. It exports OFF, which carries a color per face (M10a, 2026-11-26), and
//    turns it into binary STL plus a color trailer (offMesh.ts) before it
//    leaves the render process. Binary, not ASCII: a detailed model (the
//    gag-trophy crash report, 2026-11-25) came out as 122 MB of ASCII STL.
//    Before M10a this exported binary STL straight from the engine, which
//    has no colors.

export interface RenderOptions {
  // Absolute path of the document being rendered, or null for an unsaved
  // one. `use`/`include` paths resolve relative to its folder first.
  documentPath?: string | null;
  // OpenSCAD library folders, searched after the including file's own folder.
  libraryDirs?: string[];
  // M15: installed font files this render may need (chosen by the main
  // process from its system font index, see fonts.ts fontFilesWanted).
  fontFiles?: string[];
  // M18: render a quick preview with curve detail capped at this many
  // segments per circle (see previewDetail.ts), or null/absent for the
  // full render.
  previewSegments?: number | null;
}

// M18: a render's mesh plus what the app needs to know about how it was made.
export interface MeshResult {
  bytes: Uint8Array;
  // True when this is a preview with some curve detail lowered. A preview
  // request that found nothing finer than the cap is a full render
  // (reduced false).
  reduced: boolean;
  // Time spent in the engine, in ms (all passes for a preview).
  engineMs: number;
  // A preview: the most any curve's segment count was divided by (see
  // previewDetail.ts capCsgDetail); 1 for a full render.
  detailFactor: number;
}

// M10a: what a render is doing, for the progress bar. The engine prints
// nothing while it works (this build has no progress output; checked on the
// gag trophy, 2026-11-26: silent for 22 s, then the summary), so these are
// the steps around it.
export type RenderStage = 'preparing' | 'engine' | 'mesh';

export interface RenderHooks {
  onStage?: (stage: RenderStage) => void;
}

export class ScadRenderError extends Error {
  constructor(
    message: string,
    readonly log: string[],
  ) {
    super(message);
    this.name = 'ScadRenderError';
  }
}

// Root of the mirrored host filesystem inside the WASM FS.
const VIRTUAL_ROOT = '/host';
// Name the source is written under, next to where the real document lives.
// Unusual enough that it can't shadow a real file the document includes.
const INPUT_NAME = '__scadstudio_render__.scad';
const OUTPUT_PATH = '/__scadstudio_output__.off';
// M18 preview: the evaluated tree (CSG dump), and the capped dump rendered
// next to the document (relative import() paths in it still resolve).
const CSG_PATH = '/__scadstudio_tree__.csg';
const CSG_INPUT_NAME = '__scadstudio_preview__.scad';
// Guards against runaway include graphs (a library that pulls in thousands
// of files, or a pathological loop the visited set somehow misses).
const MAX_DEPENDENCY_FILES = 2000;

// `C:\Users\me\lib.scad` -> `/host/C/Users/me/lib.scad`; `/home/me/lib.scad`
// -> `/host/home/me/lib.scad`.
export function toVirtualPath(hostPath: string): string {
  const resolved = path.resolve(hostPath);
  const drive = /^([A-Za-z]):[\\/]/.exec(resolved);
  if (drive) {
    return `${VIRTUAL_ROOT}/${drive[1].toUpperCase()}/${resolved.slice(3).split(/[\\/]+/).filter(Boolean).join('/')}`;
  }
  return `${VIRTUAL_ROOT}/${resolved.split(/[\\/]+/).filter(Boolean).join('/')}`;
}

// Blanks out comments and string literals (keeping every other character's
// offset), so a `use <x>` inside a comment or a string isn't picked up.
function stripCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < source.length) {
        out += '  ';
        i += 2;
      }
    } else if (c === '"') {
      out += ' ';
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          out += ' ';
          i++;
        }
        if (i < source.length) {
          out += source[i] === '\n' ? '\n' : ' ';
          i++;
        }
      }
      if (i < source.length) {
        out += ' ';
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export interface Directive {
  kind: 'use' | 'include';
  path: string;
}

// Every use/include directive in a file, in order, with its `<...>` target.
export function findDirectives(source: string): Directive[] {
  const stripped = stripCommentsAndStrings(source);
  const found: Directive[] = [];
  const re = /\b(use|include)\s*<([^>\n]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) found.push({ kind: m[1] as Directive['kind'], path: m[2].trim() });
  return found;
}

// The `<...>` targets of every use/include directive in a file, in order.
export function findDependencyPaths(source: string): string[] {
  return findDirectives(source).map((d) => d.path);
}

// Where OpenSCAD finds `rel` when a file in `dir` names it: that folder
// first, then each library folder in order (absolute paths as they are).
export function resolutionCandidates(rel: string, dir: string | null, libraryDirs: string[]): string[] {
  if (path.isAbsolute(rel)) return [path.resolve(rel)];
  return [...(dir ? [path.resolve(dir, rel)] : []), ...libraryDirs.map((lib) => path.resolve(lib, rel))];
}

async function readIfFile(hostPath: string): Promise<string | null> {
  try {
    return await readFile(hostPath, 'utf8');
  } catch {
    return null;
  }
}

// Every file reachable through use/include from `source`, keyed by absolute
// host path. Resolution follows OpenSCAD: the including file's own folder
// first, then each library folder in order. A path that resolves nowhere is
// skipped; OpenSCAD itself then reports it as missing, which is the message
// the user should see.
export async function collectDependencies(
  source: string,
  documentDir: string | null,
  libraryDirs: string[],
  read: (hostPath: string) => Promise<string | null> = readIfFile,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const missing = new Set<string>();
  const queue: { text: string; dir: string | null }[] = [{ text: source, dir: documentDir }];
  while (queue.length > 0 && files.size < MAX_DEPENDENCY_FILES) {
    const { text, dir } = queue.shift()!;
    for (const rel of findDependencyPaths(text)) {
      // `use <font.ttf>` registers a font (M15): binary, not SCAD source.
      if (isFontPath(rel)) continue;
      for (const candidate of resolutionCandidates(rel, dir, libraryDirs)) {
        if (files.has(candidate)) break;
        if (missing.has(candidate)) continue;
        const contents = await read(candidate);
        if (contents === null) {
          missing.add(candidate);
          continue;
        }
        files.set(candidate, contents);
        queue.push({ text: contents, dir: path.dirname(candidate) });
        break;
      }
    }
  }
  return files;
}

async function isFile(hostPath: string): Promise<boolean> {
  try {
    return (await stat(hostPath)).isFile();
  } catch {
    return false;
  }
}

// M15: the font files registered with `use <font.ttf>` by the document or
// any file it pulls in, resolved the same way as a .scad dependency.
export async function collectFontDependencies(
  source: string,
  documentDir: string | null,
  dependencies: Map<string, string>,
  libraryDirs: string[],
  exists: (hostPath: string) => Promise<boolean> = isFile,
): Promise<string[]> {
  const found = new Set<string>();
  const files: { text: string; dir: string | null }[] = [
    { text: source, dir: documentDir },
    ...[...dependencies].map(([p, text]) => ({ text, dir: path.dirname(p) })),
  ];
  for (const { text, dir } of files) {
    for (const d of findDirectives(text)) {
      if (d.kind !== 'use' || !isFontPath(d.path)) continue;
      for (const candidate of resolutionCandidates(d.path, dir, libraryDirs)) {
        if (found.has(candidate) || (await exists(candidate))) {
          found.add(candidate);
          break;
        }
      }
    }
  }
  return [...found];
}

// M15: puts fonts into a fresh engine instance. The bundled Liberation
// fonts always go in (about 1 ms from memory, and text() is unusable without
// them); system fonts go under FONT_ROOT/system, where fontconfig finds them
// alongside the bundled ones; `use <font.ttf>` files go at their mirrored
// path so OpenSCAD's own `use` finds and registers them.
export async function mountFonts(FS: EngineFS, systemFonts: string[], projectFonts: string[]): Promise<void> {
  mkdirTree(FS, FONT_ROOT);
  for (const [p, data] of bundledFontFiles()) FS.writeFile(p, data);
  if (systemFonts.length > 0) mkdirTree(FS, `${FONT_ROOT}/system`);
  let n = 0;
  for (const hostPath of systemFonts) {
    const bytes = await fontFileCache.get(hostPath);
    if (bytes) FS.writeFile(`${FONT_ROOT}/system/${n++}-${path.basename(hostPath).replace(/[^\w.-]/g, '_')}`, bytes);
  }
  for (const hostPath of projectFonts) {
    const bytes = await fontFileCache.get(hostPath);
    if (!bytes) continue;
    const virtual = toVirtualPath(hostPath);
    mkdirTree(FS, path.posix.dirname(virtual));
    FS.writeFile(virtual, bytes);
  }
}

// OpenSCAD's own default user library folder for this platform (the one its
// "Show Library Folder" menu opens), plus anything on OPENSCADPATH.
export function defaultLibraryDirs(documentsDir: string = path.join(homedir(), 'Documents')): string[] {
  const dirs: string[] = [];
  const envPath = process.env['OPENSCADPATH'];
  if (envPath) dirs.push(...envPath.split(path.delimiter).filter(Boolean));
  if (process.platform === 'win32' || process.platform === 'darwin') {
    dirs.push(path.join(documentsDir, 'OpenSCAD', 'libraries'));
  } else {
    const dataHome = process.env['XDG_DATA_HOME'] || path.join(homedir(), '.local', 'share');
    dirs.push(path.join(dataHome, 'OpenSCAD', 'libraries'));
  }
  return dirs;
}

function mkdirTree(fs: { mkdirTree?: (p: string) => void; mkdir: (p: string) => void; analyzePath: (p: string) => { exists: boolean } }, dir: string): void {
  if (fs.mkdirTree) {
    fs.mkdirTree(dir);
    return;
  }
  let current = '';
  for (const part of dir.split('/').filter(Boolean)) {
    current += `/${part}`;
    if (!fs.analyzePath(current).exists) fs.mkdir(current);
  }
}

// The lines worth showing a user from OpenSCAD's log: errors and warnings,
// or the tail of the log if it printed neither.
export function summarizeLog(log: string[]): string {
  const important = log.filter((l) => /^(ERROR|WARNING|Parser error|Can't|Execution aborted|Current top level object)/i.test(l.trim()));
  const lines = important.length > 0 ? important : log.slice(-3);
  const text = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    // The virtual paths mean nothing to the user; show real-looking ones.
    .replaceAll(`/${INPUT_NAME}`, '')
    .replaceAll(`/${CSG_INPUT_NAME}`, '')
    .replaceAll(`${VIRTUAL_ROOT}/`, '/');
  return text || 'OpenSCAD produced no output';
}

// M0 spike finding: a single createOpenSCAD() instance corrupts state after
// one render, so every render gets its own fresh instance (checked again
// 2026-11-27: a second callMain fails with "program has already aborted!").
//
// Returns binary STL with a per-face color trailer (see offMesh.ts).
export async function renderScadToMesh(source: string, options: RenderOptions = {}, hooks: RenderHooks = {}): Promise<Uint8Array> {
  return (await renderScadToMeshResult(source, options, hooks)).bytes;
}

interface PreparedRender {
  // A fresh engine instance with the dependencies, fonts and `source`
  // written into its filesystem; `log` collects its output.
  instance: Awaited<ReturnType<typeof createEngine>>;
  inputPath: string;
  log: string[];
}

export async function renderScadToMeshResult(source: string, options: RenderOptions = {}, hooks: RenderHooks = {}): Promise<MeshResult> {
  hooks.onStage?.('preparing');
  const documentPath = options.documentPath ? path.resolve(options.documentPath) : null;
  const documentDir = documentPath ? path.dirname(documentPath) : null;
  const libraryDirs = (options.libraryDirs ?? []).map((d) => path.resolve(d));
  const dependencies = await collectDependencies(source, documentDir, libraryDirs);
  const projectFonts = await collectFontDependencies(source, documentDir, dependencies, libraryDirs);
  const openscadPath = libraryDirs.map(toVirtualPath).join(':');

  const prepare = async (text: string, name = INPUT_NAME): Promise<PreparedRender> => {
    const log: string[] = [];
    const instance = await createEngine({
      print: (line: string) => log.push(line),
      printErr: (line: string) => log.push(line),
      // OpenSCAD reads OPENSCADPATH once at startup, so it has to be in the
      // environment before main runs.
      env: openscadPath ? { OPENSCADPATH: openscadPath } : {},
    });
    const { FS } = instance;
    for (const [hostPath, contents] of dependencies) {
      const virtual = toVirtualPath(hostPath);
      mkdirTree(FS, path.posix.dirname(virtual));
      FS.writeFile(virtual, contents);
    }
    await mountFonts(FS, options.fontFiles ?? [], projectFonts);
    // Next to the real document, so relative use/include/import paths
    // resolve as they do for desktop OpenSCAD.
    const inputDir = documentDir ? toVirtualPath(documentDir) : '/untitled';
    mkdirTree(FS, inputDir);
    const inputPath = `${inputDir}/${name}`;
    FS.writeFile(inputPath, text);
    return { instance, inputPath, log };
  };

  // Runs OpenSCAD once and returns the output file, or throws with the
  // log's errors.
  const run = (prepared: PreparedRender, args: string[], output: string): Uint8Array => {
    let exitCode: number;
    try {
      exitCode = prepared.instance.callMain([prepared.inputPath, ...args, '-o', output]);
    } catch (err) {
      // Emscripten throws its own non-Error objects (ExitStatus, a bare
      // number) on abort, which used to reach the renderer as
      // "[object Object]" (QC audit M4).
      const detail = err instanceof Error ? err.message : JSON.stringify(err);
      throw new ScadRenderError(`${summarizeLog(prepared.log)}${detail ? `\n(${detail})` : ''}`, prepared.log);
    }
    let out: Uint8Array | null = null;
    try {
      out = prepared.instance.FS.readFile(output);
    } catch {
      out = null;
    }
    if (exitCode !== 0 || !out || out.byteLength === 0) {
      throw new ScadRenderError(summarizeLog(prepared.log), prepared.log);
    }
    return out;
  };

  const meshArgs = ['--backend=Manifold', '--export-format=off'];
  const started = performance.now();
  let off: Uint8Array;
  let reduced = false;
  let detailFactor = 1;
  let log: string[];
  hooks.onStage?.('engine');
  const segments = options.previewSegments ?? null;
  if (segments === null) {
    const prepared = await prepare(source);
    log = prepared.log;
    off = run(prepared, meshArgs, OUTPUT_PATH);
  } else {
    // M18 preview: dump the evaluated tree, lower its curve detail, render
    // that. `$preview` stays false, as in every render the app makes (M9
    // follow-up: it shows the exported part); the CSG export would
    // otherwise evaluate with it true.
    const dumped = await prepare(`${source}\n${TOP_LEVEL_PROBE}\n`);
    let csgBytes = run(dumped, ['-D', '$preview=false'], CSG_PATH);
    const probe = readTopLevelProbe(dumped.log);
    const overrides = topLevelOverrides(probe, segments);
    if (overrides.length > 0) {
      // The top level is finer than the cap: dump again with it capped, so
      // SCAD code that builds geometry from $fn (BOSL2) sees the cap too.
      csgBytes = run(await prepare(`${source}\n`), ['-D', '$preview=false', ...overrides], CSG_PATH);
    }
    const capped = capCsgDetail(new TextDecoder().decode(csgBytes), segments);
    reduced = capped.reduced || overrides.length > 0;
    detailFactor = Math.max(capped.factor, topLevelFactor(probe, segments));
    const rendered = await prepare(capped.text, CSG_INPUT_NAME);
    // Warnings from evaluating the source (an unknown module, a failed
    // assert) are printed by the dump pass; keep them in front of the
    // render's own lines, so errors read the same as for a full render.
    rendered.log.push(...dumped.log.filter((l) => !l.includes('__scadstudio_detail__')));
    log = rendered.log;
    off = run(rendered, meshArgs, OUTPUT_PATH);
  }
  const engineMs = performance.now() - started;
  hooks.onStage?.('mesh');
  try {
    return { bytes: offToColoredStl(off), reduced, engineMs, detailFactor };
  } catch (err) {
    throw new ScadRenderError(err instanceof Error ? err.message : String(err), log);
  }
}
