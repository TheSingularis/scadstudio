import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// M15: which fonts a render can use, and how they get into the engine.
//
// Three sources, all usable from text(font="..."):
// - Bundled: Liberation Sans / Serif / Mono, OpenSCAD's own default fonts, so
//   a file renders the same here as in desktop OpenSCAD. They come from the
//   engine package (see bundledFontFiles in fontStore.ts).
// - Project: font files the document registers with `use <font.ttf>`, the
//   OpenSCAD way to ship a font next to a model.
// - System: fonts installed on this computer. Copying a whole system font
//   folder into every render would be slow (often hundreds of MB, and
//   fontconfig re-reads every file each time the engine starts), so the main
//   process indexes names only, and a render gets just the families whose
//   names appear as string literals in the document or its libraries.
//
// Kept free of Electron so it runs directly under Vitest.

export const FONT_EXTENSIONS = ['.ttf', '.otf', '.ttc', '.otc'];

export function isFontPath(p: string): boolean {
  return FONT_EXTENSIONS.includes(path.extname(p).toLowerCase());
}

export interface FontFace {
  family: string;
  style: string;
  // From the 'post' table: every glyph the same width (a code font).
  monospace?: boolean;
}

export interface FontFileEntry {
  path: string;
  faces: FontFace[];
}

// ---- sfnt name table ----------------------------------------------------

// Reads `length` bytes at `offset` (a whole file in memory, or a file handle
// read in pieces so indexing a 30 MB CJK font doesn't load all of it).
export type ByteReader = (offset: number, length: number) => Promise<Uint8Array>;

function u16(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}
function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}
function tag(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

function decodeName(bytes: Uint8Array, platformId: number): string {
  if (platformId === 0 || platformId === 3) {
    let s = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(u16(bytes, i));
    return s;
  }
  // Mac Roman: the ASCII range is all a family name realistically uses.
  return String.fromCharCode(...bytes);
}

// The family/style of the one font starting at `offset` (0 for a plain
// .ttf/.otf; each entry of a collection's offset table otherwise).
async function readFace(read: ByteReader, offset: number): Promise<FontFace | null> {
  const header = await read(offset, 12);
  if (header.length < 12) return null;
  const numTables = u16(header, 4);
  if (numTables === 0 || numTables > 512) return null;
  const dir = await read(offset + 12, numTables * 16);
  let nameOffset = -1;
  let nameLength = 0;
  let postOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const t = tag(dir, i * 16);
    if (t === 'name') {
      nameOffset = u32(dir, i * 16 + 8);
      nameLength = u32(dir, i * 16 + 12);
    } else if (t === 'post') postOffset = u32(dir, i * 16 + 8);
  }
  if (nameOffset < 0 || nameLength < 6 || nameLength > 1 << 20) return null;
  const table = await read(nameOffset, nameLength);
  const count = u16(table, 2);
  const strings = u16(table, 4);
  // Best record per name id: Windows English first, then any Windows or
  // Unicode record, then Mac.
  const best = new Map<number, { score: number; value: string }>();
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (r + 12 > table.length) break;
    const platformId = u16(table, r);
    const languageId = u16(table, r + 4);
    const nameId = u16(table, r + 6);
    if (nameId !== 1 && nameId !== 2 && nameId !== 16 && nameId !== 17) continue;
    const length = u16(table, r + 8);
    const start = strings + u16(table, r + 10);
    if (start + length > table.length) continue;
    const score = platformId === 3 ? (languageId === 0x409 ? 3 : 2) : platformId === 0 ? 2 : 1;
    const prev = best.get(nameId);
    if (prev && prev.score >= score) continue;
    const value = decodeName(table.subarray(start, start + length), platformId).replace(/\0/g, '').trim();
    if (value) best.set(nameId, { score, value });
  }
  // Typographic family/subfamily (16/17) group e.g. "Roboto Light" under
  // "Roboto"; fontconfig matches on those too.
  const family = best.get(16)?.value ?? best.get(1)?.value;
  const style = best.get(17)?.value ?? best.get(2)?.value ?? 'Regular';
  if (!family) return null;
  let monospace = false;
  if (postOffset >= 0) {
    const post = await read(postOffset, 16);
    monospace = post.length >= 16 && u32(post, 12) !== 0;
  }
  return { family, style, monospace };
}

// Every face in a font file (one, or several for a .ttc collection).
export async function readFontFaces(read: ByteReader): Promise<FontFace[]> {
  const head = await read(0, 12);
  if (head.length < 12) return [];
  if (tag(head, 0) === 'ttcf') {
    const n = Math.min(u32(head, 8), 64);
    const offsets = await read(12, n * 4);
    const faces: FontFace[] = [];
    for (let i = 0; i < n; i++) {
      const face = await readFace(read, u32(offsets, i * 4));
      if (face) faces.push(face);
    }
    return faces;
  }
  const version = u32(head, 0);
  if (version !== 0x00010000 && tag(head, 0) !== 'OTTO' && tag(head, 0) !== 'true') return [];
  const face = await readFace(read, 0);
  return face ? [face] : [];
}

export function bytesReader(bytes: Uint8Array): ByteReader {
  return async (offset, length) => bytes.subarray(offset, offset + length);
}

export async function readFontFileFaces(filePath: string): Promise<FontFace[]> {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch {
    return [];
  }
  try {
    return await readFontFaces(async (offset, length) => {
      const buf = new Uint8Array(length);
      const { bytesRead } = await handle.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    });
  } catch {
    return [];
  } finally {
    await handle.close();
  }
}

// The fonts the engine package bundles (Liberation 2.x), listed here so the
// main process can offer them without loading the 8 MB package module.
// test/unit/fonts.test.ts checks this against the real bundled files.
export const BUNDLED_FONT_FACES: FontFace[] = ['Sans', 'Serif', 'Mono'].flatMap((kind) =>
  ['Regular', 'Bold', 'Italic', 'Bold Italic'].map((style) => ({ family: `Liberation ${kind}`, style, monospace: kind === 'Mono' })),
);

// ---- system fonts -------------------------------------------------------

// Where this platform keeps installed fonts (per-user folders included).
// SCADSTUDIO_SYSTEM_FONT_DIRS (path-delimited) replaces the list; the
// tests use it to get a known set of "installed" fonts.
export function systemFontDirs(platform: NodeJS.Platform = process.platform, home: string = homedir(), env = process.env): string[] {
  const override = env['SCADSTUDIO_SYSTEM_FONT_DIRS'];
  if (override) return override.split(path.delimiter).filter(Boolean);
  if (platform === 'win32') {
    const windir = env['WINDIR'] || env['SystemRoot'] || 'C:\\Windows';
    const local = env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
    return [path.join(windir, 'Fonts'), path.join(local, 'Microsoft', 'Windows', 'Fonts')];
  }
  if (platform === 'darwin') {
    return ['/System/Library/Fonts', '/Library/Fonts', path.join(home, 'Library', 'Fonts')];
  }
  const dataHome = env['XDG_DATA_HOME'] || path.join(home, '.local', 'share');
  return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(dataHome, 'fonts'), path.join(home, '.fonts')];
}

const MAX_FONT_FILES = 10_000;

async function walkFontFiles(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 6 || out.length >= MAX_FONT_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkFontFiles(full, out, depth + 1);
    else if ((e.isFile() || e.isSymbolicLink()) && isFontPath(e.name)) out.push(full);
    if (out.length >= MAX_FONT_FILES) return;
  }
}

export async function scanFontDirs(dirs: string[]): Promise<FontFileEntry[]> {
  const files: string[] = [];
  for (const d of dirs) await walkFontFiles(d, files);
  const entries: FontFileEntry[] = [];
  for (const f of files) {
    const faces = await readFontFileFaces(f);
    if (faces.length > 0) entries.push({ path: f, faces });
  }
  return entries;
}

// The system font index, built once on first use and then kept: the main
// process lives for the whole session. `refresh` rebuilds it (a font
// installed while the app runs).
export class SystemFontIndex {
  private entries: Promise<FontFileEntry[]> | null = null;

  constructor(private readonly dirs: () => string[] = () => systemFontDirs()) {}

  get(): Promise<FontFileEntry[]> {
    if (!this.entries) this.entries = scanFontDirs(this.dirs());
    return this.entries;
  }

  refresh(): Promise<FontFileEntry[]> {
    this.entries = null;
    return this.get();
  }
}

// ---- which fonts a document wants --------------------------------------

// The contents of every string literal in OpenSCAD source (comments
// skipped, escapes left as written: a family name has none).
export function stringLiterals(source: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          s += source[j] + source[j + 1];
          j += 2;
        } else s += source[j++];
      }
      out.push(s);
      i = j + 1;
    } else i++;
  }
  return out;
}

// The family part of a fontconfig name: "Arial:style=Bold" -> "arial".
export function fontFamilyKey(name: string): string {
  return name.split(':')[0].trim().toLowerCase();
}

// Font files whose family is named by some string literal in `texts`.
// Matching every literal (not just `font=` arguments) also covers a font
// chosen through a variable or module parameter (`f = "Arial"; text(font=f)`).
// A name built from pieces at run time (`str("Ari", "al")`) is not found.
export function fontFilesWanted(texts: string[], index: FontFileEntry[]): string[] {
  const wanted = new Set<string>();
  for (const t of texts) for (const lit of stringLiterals(t)) if (lit.length > 0 && lit.length < 200) wanted.add(fontFamilyKey(lit));
  if (wanted.size === 0) return [];
  return index.filter((e) => e.faces.some((f) => wanted.has(f.family.toLowerCase()))).map((e) => e.path);
}

export async function fileStamp(p: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const s = await stat(p);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}
