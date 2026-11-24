import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { findDirectives, resolutionCandidates } from './scadRender';

// M8: which library files can supply custom-module toolbar tools, and how
// each one's modules become callable from the open document. Kept free of
// Electron (like scadRender.ts) so it runs directly under Vitest. Parsing the
// files is the renderer's job (it owns the tree-sitter grammar); this side
// only reads files and follows directives.
//
// OpenSCAD's scoping, checked against the bundled openscad-wasm engine
// (2026-11-24) rather than assumed:
// - `use <a.scad>` makes a's own modules callable, and also those of every
//   file a `include`s (an include is pasted text, so it is part of a).
// - `use` is not transitive: if a.scad itself does `use <b.scad>`, b's
//   modules are NOT callable from the document (OpenSCAD warns "Ignoring
//   unknown module"). They are still offered here, marked with the `use`
//   directive the document would need, which insertion adds.
// - Modules from files the *document* `include`s are not offered. Decided
//   with Jordan (PLAN.md risk 6): `include` also runs the file's geometry
//   and assignments, so it is not a library-of-tools directive.

export interface ModuleSourceFile {
  // Absolute host path.
  path: string;
  contents: string;
  // null when the file's modules are already callable from the document
  // (reached through the document's own `use`s, plus includes inside
  // those). Otherwise the `<...>` text of a `use` directive that would make
  // them callable, written how OpenSCAD resolves it from the document.
  useDirective: string | null;
}

export interface ModuleSourceScan {
  files: ModuleSourceFile[];
  // Every file read while scanning, found or not, so a watcher can pick up
  // a library being created, edited or deleted.
  watchPaths: string[];
}

const MAX_FILES = 500;

async function readIfFile(hostPath: string): Promise<string | null> {
  try {
    return await readFile(hostPath, 'utf8');
  } catch {
    return null;
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

// The `<...>` text a `use` in the document should carry to reach `target`:
// relative to a library folder when it sits inside one (portable, the way
// `use <BOSL2/std.scad>` is written), else relative to the document's
// folder, else (an unsaved document) the absolute path.
export function directiveFor(target: string, documentDir: string | null, libraryDirs: string[]): string {
  for (const lib of libraryDirs) {
    const rel = path.relative(lib, target);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return toPosix(rel);
  }
  if (documentDir) {
    const rel = path.relative(documentDir, target);
    if (rel && !path.isAbsolute(rel)) return toPosix(rel);
  }
  return toPosix(target);
}

// Breadth-first from the document's own `use`s, so a file reachable both
// directly and through another library is reported as already in scope.
export async function scanModuleSources(
  source: string,
  documentDir: string | null,
  libraryDirs: string[],
  read: (hostPath: string) => Promise<string | null> = readIfFile,
): Promise<ModuleSourceScan> {
  const files = new Map<string, ModuleSourceFile>();
  const watch = new Set<string>();
  const cache = new Map<string, string | null>();
  const readCached = async (p: string) => {
    if (!cache.has(p)) cache.set(p, await read(p));
    return cache.get(p)!;
  };
  const resolve = async (rel: string, dir: string | null): Promise<{ path: string; contents: string } | null> => {
    for (const candidate of resolutionCandidates(rel, dir, libraryDirs)) {
      watch.add(candidate);
      const contents = await readCached(candidate);
      if (contents !== null) return { path: candidate, contents };
    }
    return null;
  };

  // Each entry is a file reached through `use`, with the directive that
  // makes it callable (null = already in scope).
  const queue: { path: string; contents: string; useDirective: string | null }[] = [];
  for (const d of findDirectives(source)) {
    if (d.kind !== 'use') continue;
    const found = await resolve(d.path, documentDir);
    if (found) queue.push({ ...found, useDirective: null });
  }

  while (queue.length > 0 && files.size < MAX_FILES) {
    const entry = queue.shift()!;
    if (files.has(entry.path)) continue;
    // A used file plus everything it includes (recursively) shares one
    // scope: includes are pasted text.
    const group: { path: string; contents: string }[] = [];
    const pending = [{ path: entry.path, contents: entry.contents }];
    while (pending.length > 0 && files.size + group.length < MAX_FILES) {
      const file = pending.shift()!;
      if (files.has(file.path) || group.some((g) => g.path === file.path)) continue;
      group.push(file);
      for (const d of findDirectives(file.contents)) {
        const found = await resolve(d.path, path.dirname(file.path));
        if (!found) continue;
        if (d.kind === 'include') pending.push(found);
        else
          queue.push({
            ...found,
            useDirective: directiveFor(found.path, documentDir, libraryDirs),
          });
      }
    }
    for (const g of group) files.set(g.path, { ...g, useDirective: entry.useDirective });
  }

  return { files: [...files.values()], watchPaths: [...watch] };
}
