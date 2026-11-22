#!/usr/bin/env node
// Fetches the real-world .scad corpus (PLAN.md M0 "stress-test the grammar
// against a real-world corpus") into test/corpus/.cache at pinned commits,
// so results are reproducible. Nothing is vendored into this repo.
//
//   node test/corpus/fetch-corpus.mjs      (or: npm run corpus:fetch)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE = join(dirname(fileURLToPath(import.meta.url)), '.cache');

export const SOURCES = [
  { name: 'MCAD', url: 'https://github.com/openscad/MCAD', sha: 'bd0a7ba3f042bfbced5ca1894b236cea08904e26', paths: null },
  { name: 'openscad-examples', url: 'https://github.com/openscad/openscad', sha: 'e1755d21d218b79d437ee31e9bc68ff15aa1ded8', paths: ['examples'] },
  { name: 'BOSL2', url: 'https://github.com/BelfrySCAD/BOSL2', sha: '1351a9f7e5f30a95228e580d167fd4f2e184ad2c', paths: null },
];

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] });

mkdirSync(CACHE, { recursive: true });
for (const src of SOURCES) {
  const dir = join(CACHE, src.name);
  const stamp = join(dir, `.sha-${src.sha}`);
  if (existsSync(stamp)) {
    console.log(`${src.name}: up to date`);
    continue;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'remote', 'add', 'origin', src.url);
  if (src.paths) {
    git(dir, 'config', 'core.sparseCheckout', 'true');
    git(dir, 'sparse-checkout', 'set', '--no-cone', ...src.paths.map((p) => `/${p}/`));
  }
  git(dir, 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', src.sha);
  git(dir, 'checkout', '-q', 'FETCH_HEAD');
  execFileSync('touch', [stamp]);
  console.log(`${src.name}: fetched ${src.sha.slice(0, 7)}`);
}
