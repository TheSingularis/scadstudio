#!/usr/bin/env node
// M13: refreshes the bundled copy of BOSL2 in resources/libraries/BOSL2 from
// a pinned release tag. Only the library itself is kept (the top-level .scad
// files, LICENSE and README.md); its docs, examples, tests and images are
// not shipped. Run it to move to a newer BOSL2, then update the tag here,
// in resources/libraries/BOSL2/VERSION and in PLAN.md's M13 notes.
//
//   node scripts/vendor-bosl2.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = 'v2.0.788';
const SHA = '1351a9f7e5f30a95228e580d167fd4f2e184ad2c';
const URL = 'https://github.com/BelfrySCAD/BOSL2';
const DEST = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'libraries', 'BOSL2');

const work = mkdtempSync(join(tmpdir(), 'bosl2-'));
const git = (...args) => execFileSync('git', args, { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] });
try {
  git('init', '-q');
  git('remote', 'add', 'origin', URL);
  git('fetch', '-q', '--depth', '1', 'origin', SHA);
  git('checkout', '-q', 'FETCH_HEAD');
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  const keep = readdirSync(work).filter((f) => f.endsWith('.scad') || f === 'LICENSE' || f === 'README.md');
  for (const f of keep) cpSync(join(work, f), join(DEST, f));
  writeFileSync(join(DEST, 'VERSION'), `BOSL2 ${TAG} (${SHA})\n${URL}\nLicense: BSD 2-Clause (see LICENSE)\n`);
  console.log(`BOSL2 ${TAG}: ${keep.length} files copied to ${DEST}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
