// M18 (fast preview, PLAN.md "Fast preview and full render"): lowering the
// curve detail of a model for a quick, slightly coarser render.
//
// The render process first asks OpenSCAD for the model's CSG dump
// (`-o x.csg`): the fully evaluated tree, with every module call, loop and
// variable resolved, and every primitive carrying its own `$fn`, `$fa` and
// `$fs` as numbers (`circle($fn = 120, $fa = 12, $fs = 2, r = 3);`). Capping
// those numbers in the text, then rendering the capped dump, reaches every
// curve: a per-call `$fn = 64`, a `$fn` computed in code, a top-level
// `$fn = 120`. (`-D '$fn=24'` would only override the top level.) Measured
// 2026-11-27 on the gag trophy: 32.5 s full, about 4.3 s capped at 24.
//
// Only detail finer than the cap is lowered. A value at or below it is left
// alone, so the preview can't introduce the low-$fn twist crash (PLAN.md
// "Known engine bug"), and the caps offered (16, 24, 32) are clear of the
// values that crash.

export const PREVIEW_SEGMENT_CHOICES = [16, 24, 32] as const;
export type PreviewSegments = (typeof PREVIEW_SEGMENT_CHOICES)[number];

export interface CappedCsg {
  text: string;
  /** Whether any value was lowered (false: the preview is the full render). */
  reduced: boolean;
  /**
   * The most any curve's segment count was divided by (1 when nothing was
   * lowered): $fn 120 capped at 24 is 5. The renderer uses it to estimate
   * the full render's time from the preview's.
   */
  factor: number;
}

// OpenSCAD's default $fa (degrees). A preview never makes $fa coarser than
// it: with the defaults a circle already has at most 30 segments, and
// lowering every default-detail part to 24 would mark nearly every model as
// a preview for very little time saved. So for a cap of 16 or 24 a fine $fa
// is raised to 12 (30 segments at most), for 32 to 11.25.
export const OPENSCAD_DEFAULT_FA = 12;

export function previewMinFa(maxSegments: number): number {
  return Math.min(360 / maxSegments, OPENSCAD_DEFAULT_FA);
}

// OpenSCAD prints numbers in the dump as plain decimals or with an exponent.
const NUMBER = String.raw`-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
// The dump always writes the three together, in this order, on every call
// that takes them (primitives, extrudes, text()).
const SPECIALS = new RegExp(String.raw`\$fn = (${NUMBER}), \$fa = (${NUMBER}), \$fs = (${NUMBER})`, 'g');

function formatNumber(n: number): string {
  // Short and exact enough for $fa (degrees).
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

/**
 * Caps the curve detail in a CSG dump at `maxSegments` per full circle:
 * `$fn` above it comes down to it, and where `$fn` is 0 a `$fa` finer than
 * previewMinFa goes up to that, which bounds the segment count OpenSCAD
 * derives (segments = max(min(360 / $fa, 2 pi r / $fs), 5)) whatever `$fs`
 * and r are. Strings (text() contents, file names) are left exactly as they are.
 */
export function capCsgDetail(csg: string, maxSegments: number): CappedCsg {
  const minFa = previewMinFa(maxSegments);
  let reduced = false;
  let factor = 1;
  const capCode = (code: string): string =>
    code.replace(SPECIALS, (whole, fnText: string, faText: string, fsText: string) => {
      const fn = Number(fnText);
      const fa = Number(faText);
      if (!Number.isFinite(fn) || !Number.isFinite(fa)) return whole;
      if (fn > maxSegments) {
        reduced = true;
        factor = Math.max(factor, fn / maxSegments);
        return `$fn = ${maxSegments}, $fa = ${faText}, $fs = ${fsText}`;
      }
      // $fa only counts when $fn is 0 (OpenSCAD uses $fn whenever it is
      // above 0), so raising it under a set $fn would change nothing.
      if (fn <= 0 && fa < minFa) {
        reduced = true;
        factor = Math.max(factor, minFa / Math.max(fa, 0.01));
        return `$fn = ${fnText}, $fa = ${formatNumber(minFa)}, $fs = ${fsText}`;
      }
      return whole;
    });
  // Split into code and string literals; only code is rewritten.
  let out = '';
  let i = 0;
  let codeStart = 0;
  while (i < csg.length) {
    if (csg[i] === '"') {
      out += capCode(csg.slice(codeStart, i));
      let j = i + 1;
      while (j < csg.length && csg[j] !== '"') j += csg[j] === '\\' ? 2 : 1;
      out += csg.slice(i, j + 1);
      i = j + 1;
      codeStart = i;
    } else {
      i++;
    }
  }
  out += capCode(csg.slice(codeStart));
  return { text: out, reduced, factor };
}

// Echoed at the end of the source for the CSG pass, to read the top-level
// $fn/$fa/$fs the model ends up with.
export const TOP_LEVEL_PROBE = 'echo("__scadstudio_detail__", $fn, $fa, $fs);';

export interface TopLevelDetail {
  fn: number;
  fa: number;
  fs: number;
}

/** The probe's values from the engine log, or null if it didn't print. */
export function readTopLevelProbe(log: string[]): TopLevelDetail | null {
  for (const line of log) {
    const m = /^ECHO: "__scadstudio_detail__", (\S+), (\S+), (\S+)$/.exec(line.trim());
    if (!m) continue;
    const [fn, fa, fs] = [m[1], m[2], m[3]].map(Number);
    if ([fn, fa, fs].every(Number.isFinite)) return { fn, fa, fs };
  }
  return null;
}

/**
 * `-D` overrides for the top-level special variables when they are finer
 * than the cap. Needed on top of capCsgDetail for geometry that SCAD code
 * builds itself from `$fn` (BOSL2 computes point lists), which reaches the
 * dump as fixed `polyhedron()` points; the override makes that code see the
 * cap. Empty when the top level is already at or below it.
 */
/** How much topLevelOverrides lowers the top-level detail (1: not at all). */
export function topLevelFactor(detail: TopLevelDetail | null, maxSegments: number): number {
  if (!detail) return 1;
  if (detail.fn > maxSegments) return detail.fn / maxSegments;
  const minFa = previewMinFa(maxSegments);
  if (detail.fn <= 0 && detail.fa < minFa) return minFa / Math.max(detail.fa, 0.01);
  return 1;
}

export function topLevelOverrides(detail: TopLevelDetail | null, maxSegments: number): string[] {
  if (!detail) return [];
  const args: string[] = [];
  if (detail.fn > maxSegments) args.push('-D', `$fn=${maxSegments}`);
  const minFa = previewMinFa(maxSegments);
  if (detail.fn <= 0 && detail.fa < minFa) args.push('-D', `$fa=${formatNumber(minFa)}`);
  return args;
}
