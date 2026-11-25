import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createEngine, type EngineFS } from './engine';
import { isFontPath } from './fonts';
import { FONT_ROOT, bundledFontFiles, fontFileCache } from './fontStore';

// Everything the main process needs to turn OpenSCAD source into STL bytes,
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
// 3. It exports binary STL, not OpenSCAD's default ASCII: about a quarter of
//    the size and much cheaper for the viewport to parse. A detailed model
//    (the gag-trophy crash report, 2026-11-25) came out as 122 MB of ASCII.

export interface RenderOptions {
  // Absolute path of the document being rendered, or null for an unsaved
  // one. `use`/`include` paths resolve relative to its folder first.
  documentPath?: string | null;
  // OpenSCAD library folders, searched after the including file's own folder.
  libraryDirs?: string[];
  // M15: installed font files this render may need (chosen by the main
  // process from its system font index, see fonts.ts fontFilesWanted).
  fontFiles?: string[];
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
const OUTPUT_PATH = '/__scadstudio_output__.stl';
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
    .replaceAll(`${VIRTUAL_ROOT}/`, '/');
  return text || 'OpenSCAD produced no output';
}

// M0 spike finding: a single createOpenSCAD() instance corrupts state after
// one render, so every render gets its own fresh instance.
export async function renderScadToStl(source: string, options: RenderOptions = {}): Promise<Uint8Array> {
  const documentPath = options.documentPath ? path.resolve(options.documentPath) : null;
  const documentDir = documentPath ? path.dirname(documentPath) : null;
  const libraryDirs = (options.libraryDirs ?? []).map((d) => path.resolve(d));
  const dependencies = await collectDependencies(source, documentDir, libraryDirs);
  const projectFonts = await collectFontDependencies(source, documentDir, dependencies, libraryDirs);

  const log: string[] = [];
  const openscadPath = libraryDirs.map(toVirtualPath).join(':');
  const instance = await createEngine({
    print: (text: string) => log.push(text),
    printErr: (text: string) => log.push(text),
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

  const inputDir = documentDir ? toVirtualPath(documentDir) : '/untitled';
  mkdirTree(FS, inputDir);
  const inputPath = `${inputDir}/${INPUT_NAME}`;
  FS.writeFile(inputPath, source);

  let exitCode: number;
  try {
    exitCode = instance.callMain([inputPath, '--backend=Manifold', '--export-format=binstl', '-o', OUTPUT_PATH]);
  } catch (err) {
    // Emscripten throws its own non-Error objects (ExitStatus, a bare
    // number) on abort, which used to reach the renderer as
    // "[object Object]" (QC audit M4).
    const detail = err instanceof Error ? err.message : JSON.stringify(err);
    throw new ScadRenderError(`${summarizeLog(log)}${detail ? `\n(${detail})` : ''}`, log);
  }
  let stl: Uint8Array | null = null;
  try {
    stl = FS.readFile(OUTPUT_PATH);
  } catch {
    stl = null;
  }
  if (exitCode !== 0 || !stl || stl.byteLength === 0) {
    throw new ScadRenderError(summarizeLog(log), log);
  }
  return stl;
}
