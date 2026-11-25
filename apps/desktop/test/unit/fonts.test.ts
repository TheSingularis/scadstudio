// M15: font name reading, the system font index, and which installed fonts
// a document asks for (src/main/fonts.ts), plus settings validation.
import path, { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_FONT_FACES,
  bytesReader,
  fontFamilyKey,
  fontFilesWanted,
  isFontPath,
  readFontFaces,
  readFontFileFaces,
  scanFontDirs,
  stringLiterals,
  systemFontDirs,
} from '../../src/main/fonts';
import { bundledFontFiles } from '../../src/main/fontStore';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../src/main/settings';
import { FIXTURES_DIR } from '../helpers/paths';

const FONT_DIR = join(FIXTURES_DIR, 'fonts');
const SCP = join(FONT_DIR, 'SourceCodePro-Regular.ttf');

describe('font names (sfnt name table)', () => {
  it('reads family, style and the monospace flag from a font file', async () => {
    expect(await readFontFileFaces(SCP)).toEqual([{ family: 'Source Code Pro', style: 'Regular', monospace: true }]);
  });

  it('BUNDLED_FONT_FACES matches the fonts the engine package actually bundles', async () => {
    const faces = [];
    for (const [p, bytes] of bundledFontFiles()) if (p.endsWith('.ttf')) faces.push(...(await readFontFaces(bytesReader(bytes))));
    const key = (f: { family: string; style: string; monospace?: boolean }) => `${f.family}|${f.style}|${f.monospace}`;
    expect(faces.map(key).sort()).toEqual(BUNDLED_FONT_FACES.map(key).sort());
  });

  it('rejects files that are not fonts', async () => {
    expect(await readFontFaces(bytesReader(new TextEncoder().encode('cube(10); // not a font at all')))).toEqual([]);
    expect(await readFontFileFaces(join(FIXTURES_DIR, 'gag_trophy1.scad'))).toEqual([]);
    expect(await readFontFileFaces(join(FONT_DIR, 'missing.ttf'))).toEqual([]);
  });

  it('isFontPath knows font extensions only', () => {
    expect(['a.ttf', 'B.OTF', 'c.ttc', 'dir/d.otc'].every(isFontPath)).toBe(true);
    expect(['a.scad', 'ttf', 'a.ttf.scad', 'font.woff2'].some(isFontPath)).toBe(false);
  });
});

describe('system font folders', () => {
  it('per platform, including per-user folders', () => {
    expect(systemFontDirs('win32', 'C:\\Users\\j', { WINDIR: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\j\\AppData\\Local' })).toEqual([
      path.join('C:\\Windows', 'Fonts'),
      path.join('C:\\Users\\j\\AppData\\Local', 'Microsoft', 'Windows', 'Fonts'),
    ]);
    expect(systemFontDirs('darwin', '/Users/j', {})).toEqual(['/System/Library/Fonts', '/Library/Fonts', '/Users/j/Library/Fonts']);
    expect(systemFontDirs('linux', '/home/j', {})).toEqual(['/usr/share/fonts', '/usr/local/share/fonts', '/home/j/.local/share/fonts', '/home/j/.fonts']);
  });

  it('SCADSTUDIO_SYSTEM_FONT_DIRS replaces the list (tests)', () => {
    expect(systemFontDirs('linux', '/home/j', { SCADSTUDIO_SYSTEM_FONT_DIRS: ['/a', '/b'].join(path.delimiter) })).toEqual(['/a', '/b']);
  });

  it('scanFontDirs indexes every font file in a folder tree', async () => {
    const entries = await scanFontDirs([FONT_DIR, join(FONT_DIR, 'does-not-exist')]);
    expect(entries).toEqual([{ path: SCP, faces: [{ family: 'Source Code Pro', style: 'Regular', monospace: true }] }]);
  });
});

describe('which installed fonts a document names', () => {
  const index = [
    { path: '/fonts/arial.ttf', faces: [{ family: 'Arial', style: 'Regular' }] },
    { path: '/fonts/arialbd.ttf', faces: [{ family: 'Arial', style: 'Bold' }] },
    { path: '/fonts/impact.ttf', faces: [{ family: 'Impact', style: 'Regular' }] },
  ];

  it('string literals, skipping comments', () => {
    expect(stringLiterals('a = "x"; // "no"\n/* "nope" */ b = "y\\"z";')).toEqual(['x', 'y\\"z']);
  });

  it('fontFamilyKey drops the fontconfig style part', () => {
    expect(fontFamilyKey('Arial:style=Bold Italic')).toBe('arial');
    expect(fontFamilyKey('  Liberation Sans ')).toBe('liberation sans');
  });

  it('loads every style of a family named in font=', () => {
    expect(fontFilesWanted(['text("Hi", font="Arial:style=Bold");'], index)).toEqual(['/fonts/arial.ttf', '/fonts/arialbd.ttf']);
  });

  it('finds a font chosen through a variable or in a library file', () => {
    expect(fontFilesWanted(['f = "impact";\ntext("Hi", font=f);'], index)).toEqual(['/fonts/impact.ttf']);
    expect(fontFilesWanted(['use <lib.scad>\nlabel();', 'module label() text("x", font="Impact");'], index)).toEqual(['/fonts/impact.ttf']);
  });

  it('loads nothing when no installed family is named', () => {
    expect(fontFilesWanted(['text("Arial is nice");', '// font="Impact"'], index)).toEqual([]);
    expect(fontFilesWanted(['cube(1);'], index)).toEqual([]);
  });
});

describe('settings (Settings > Fonts sets the code editor font)', () => {
  it('fills in defaults and clamps the size', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ editorFontFamily: 'Fira Code', editorFontSize: 99 })).toEqual({ editorFontFamily: 'Fira Code', editorFontSize: 40 });
    expect(normalizeSettings({ editorFontSize: 2.4 }).editorFontSize).toBe(8);
  });

  it('strips characters that could break out of a CSS font-family value', () => {
    expect(normalizeSettings({ editorFontFamily: 'Evil"; } body { x' }).editorFontFamily).toBe('Evil  body  x');
  });
});
