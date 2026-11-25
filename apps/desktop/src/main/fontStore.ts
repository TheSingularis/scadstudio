import { readFile, stat } from 'node:fs/promises';
import { addFonts } from '@lofcz/openscad-wasm/fonts';

// M15, render-process side: font bytes kept in memory so each render's fresh
// engine instance gets its fonts without decoding or reading disk again.
//
// - Bundled Liberation fonts come from the engine package's addFonts(),
//   which hex-decodes about 4 MB on every call (~500 ms). It is run once
//   against a recording stand-in filesystem and the bytes replayed into each
//   instance afterwards (~1 ms).
// - Other font files (system fonts a document names, `use <font.ttf>`
//   files) are read on first use and kept, keyed by path and checked
//   against size + mtime so an edited font file is picked up.

export const FONT_ROOT = '/fonts';

let bundled: Map<string, Uint8Array> | null = null;

export function bundledFontFiles(): Map<string, Uint8Array> {
  if (bundled) return bundled;
  const files = new Map<string, Uint8Array>();
  const recorder = {
    FS: {
      mkdir() {},
      stat() {
        // addFonts only stats to decide whether to mkdir.
        throw new Error('not found');
      },
      writeFile(p: string, data: Uint8Array) {
        files.set(p, data);
      },
    },
  };
  addFonts(recorder as unknown as Parameters<typeof addFonts>[0]);
  bundled = files;
  return files;
}

interface CachedFile {
  size: number;
  mtimeMs: number;
  bytes: Uint8Array;
}

// Total bytes kept before older files are dropped (a document naming a lot
// of large CJK system fonts shouldn't pin gigabytes).
const MAX_CACHED_BYTES = 512 * 1024 * 1024;

export class FontFileCache {
  private files = new Map<string, CachedFile>();
  private total = 0;
  hits = 0;
  reads = 0;

  async get(hostPath: string): Promise<Uint8Array | null> {
    let s;
    try {
      s = await stat(hostPath);
    } catch {
      return null;
    }
    const cached = this.files.get(hostPath);
    if (cached && cached.size === s.size && cached.mtimeMs === s.mtimeMs) {
      // Refresh recency.
      this.files.delete(hostPath);
      this.files.set(hostPath, cached);
      this.hits++;
      return cached.bytes;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(hostPath));
    } catch {
      return null;
    }
    this.reads++;
    if (cached) this.total -= cached.bytes.byteLength;
    this.files.set(hostPath, { size: s.size, mtimeMs: s.mtimeMs, bytes });
    this.total += bytes.byteLength;
    for (const [key, value] of this.files) {
      if (this.total <= MAX_CACHED_BYTES || key === hostPath) break;
      this.files.delete(key);
      this.total -= value.bytes.byteLength;
    }
    return bytes;
  }
}

export const fontFileCache = new FontFileCache();
