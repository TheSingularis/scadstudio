// M18: lowering curve detail in OpenSCAD's CSG dump for the quick preview
// (src/main/previewDetail.ts) and the Auto rule that picks which parts get
// it (src/renderer/src/renderQuality.ts).
import { describe, expect, it } from 'vitest';
import { capCsgDetail, readTopLevelProbe, topLevelOverrides } from '../../src/main/previewDetail';
import { cacheKey, chooseQuality, FULL, likelyFastAtFull, PartTimings, PREVIEW_AUTO_MS } from '../../src/renderer/src/renderQuality';

describe('capCsgDetail', () => {
  it('lowers $fn above the cap and leaves values at or below it alone', () => {
    const csg = [
      'circle($fn = 120, $fa = 12, $fs = 2, r = 3);',
      'sphere($fn = 24, $fa = 12, $fs = 2, r = 1);',
      'cylinder($fn = 6, $fa = 12, $fs = 2, h = 1, r1 = 1, r2 = 1, center = false);',
    ].join('\n');
    const { text, reduced } = capCsgDetail(csg, 24);
    expect(reduced).toBe(true);
    expect(text).toContain('circle($fn = 24, $fa = 12, $fs = 2, r = 3);');
    expect(text).toContain('sphere($fn = 24, $fa = 12, $fs = 2, r = 1);');
    // The largest division: 120 -> 24.
    expect(capCsgDetail(csg, 24).factor).toBe(5);
    // A low value stays: the preview never makes detail coarser than the
    // file asked for (the low-$fn twist crash, PLAN.md "Known engine bug").
    expect(text).toContain('cylinder($fn = 6,');
  });

  it('raises a fine $fa only where $fn is 0 (where OpenSCAD uses it), never past the default', () => {
    const csg = 'sphere($fn = 0, $fa = 1, $fs = 0.4, r = 10);\nsphere($fn = 12, $fa = 1, $fs = 0.4, r = 10);';
    const { text, reduced } = capCsgDetail(csg, 24);
    expect(reduced).toBe(true);
    // Never coarser than OpenSCAD's default $fa = 12 (30 segments at most).
    expect(text).toContain('sphere($fn = 0, $fa = 12, $fs = 0.4, r = 10);');
    expect(text).toContain('sphere($fn = 12, $fa = 1, $fs = 0.4, r = 10);');
    expect(capCsgDetail(csg, 32).text).toContain('sphere($fn = 0, $fa = 11.25,');
  });

  it('reports nothing reduced when the model is already at or below the cap', () => {
    const csg = 'group() {\n\tcube(size = [1, 1, 1], center = false);\n\tsphere($fn = 0, $fa = 12, $fs = 2, r = 1);\n}';
    expect(capCsgDetail(csg, 24)).toEqual({ text: csg, reduced: false, factor: 1 });
  });

  it('leaves strings untouched, including ones that look like detail settings', () => {
    const csg = 'text($fn = 64, $fa = 12, $fs = 2, text = "$fn = 64, $fa = 12, $fs = 2 \\" x", size = 10);';
    const { text } = capCsgDetail(csg, 24);
    expect(text).toBe('text($fn = 24, $fa = 12, $fs = 2, text = "$fn = 64, $fa = 12, $fs = 2 \\" x", size = 10);');
  });

  it('reads numbers with an exponent or a fraction', () => {
    expect(capCsgDetail('circle($fn = 1e+03, $fa = 0.5, $fs = 2, r = 1);', 32).text).toBe('circle($fn = 32, $fa = 0.5, $fs = 2, r = 1);');
    expect(capCsgDetail('circle($fn = 0, $fa = 1e-05, $fs = 2, r = 1);', 32).text).toBe('circle($fn = 0, $fa = 11.25, $fs = 2, r = 1);');
    // The default $fa = 12 is left alone at every cap.
    expect(capCsgDetail('circle($fn = 0, $fa = 12, $fs = 2, r = 1);', 16).reduced).toBe(false);
  });
});

describe('top-level probe', () => {
  it('reads the echoed top-level detail and caps only what is finer', () => {
    const probe = readTopLevelProbe(['ECHO: pv = false', 'ECHO: "__scadstudio_detail__", 120, 12, 2']);
    expect(probe).toEqual({ fn: 120, fa: 12, fs: 2 });
    expect(topLevelOverrides(probe, 24)).toEqual(['-D', '$fn=24']);
    expect(topLevelOverrides({ fn: 0, fa: 1, fs: 0.4 }, 24)).toEqual(['-D', '$fa=12']);
    expect(topLevelOverrides({ fn: 0, fa: 12, fs: 2 }, 24)).toEqual([]);
    expect(topLevelOverrides(null, 24)).toEqual([]);
  });
});

describe('Auto rule (decided with Jordan 2026-11-27)', () => {
  it('previews parts measured at 2 s or more, and parts not measured yet', () => {
    expect(chooseQuality('auto', 24, PREVIEW_AUTO_MS, false)).toEqual({ kind: 'preview', segments: 24 });
    expect(chooseQuality('auto', 24, undefined, false)).toEqual({ kind: 'preview', segments: 24 });
    expect(chooseQuality('auto', 24, PREVIEW_AUTO_MS - 1, false)).toBe(FULL);
  });

  it('Render (F6) and Off are always full; Always is always a preview', () => {
    expect(chooseQuality('auto', 24, 30_000, true)).toBe(FULL);
    expect(chooseQuality('always', 24, 30_000, true)).toBe(FULL);
    expect(chooseQuality('off', 24, undefined, false)).toBe(FULL);
    expect(chooseQuality('always', 16, 10, false)).toEqual({ kind: 'preview', segments: 16 });
  });

  it('estimates from a preview whether the full render is fast (then it is rendered in full right away)', () => {
    // Rack mount fixture: 0.6 s preview, $fn 64 -> 24.
    expect(likelyFastAtFull(600, 64 / 24)).toBe(true);
    // Gag trophy: 4.3 s preview, $fn 120 -> 24.
    expect(likelyFastAtFull(4300, 5)).toBe(false);
    expect(likelyFastAtFull(500, 5)).toBe(false);
  });

  it('keys a preview apart from the full render of the same source', () => {
    expect(cacheKey('cube(1);', FULL)).toBe('cube(1);');
    expect(cacheKey('cube(1);', { kind: 'preview', segments: 24 })).not.toBe(cacheKey('cube(1);', { kind: 'preview', segments: 16 }));
    expect(cacheKey('cube(1);', { kind: 'preview', segments: 24 })).not.toBe('cube(1);');
  });
});

describe('PartTimings', () => {
  const fp = (text: string, kind = 'cylinder') => ({ text, kind });

  it('carries a timing to the part an edit changed', () => {
    const t = new PartTimings();
    t.set('ctx\ncylinder(h=10, r=5, $fn=120);', 30_000);
    t.set('ctx\ncube(2);', 40);
    const before = {
      fingerprints: [fp('cube(2);', 'cube'), fp('cylinder(h=10, r=5, $fn=120);')],
      sources: ['ctx\ncube(2);', 'ctx\ncylinder(h=10, r=5, $fn=120);'],
    };
    const after = {
      fingerprints: [fp('cube(2);', 'cube'), fp('cylinder(h=12, r=5, $fn=120);')],
      sources: ['ctx\ncube(2);', 'ctx\ncylinder(h=12, r=5, $fn=120);'],
    };
    expect(t.forSet(after, before)).toEqual([40, 30_000]);
    // Remembered under the new source, so the next edit keeps it too.
    expect(t.get('ctx\ncylinder(h=12, r=5, $fn=120);')).toBe(30_000);
  });

  it('keeps a timing when only a variable the part reads changed', () => {
    const t = new PartTimings();
    t.set('w = 1;\ncylinder(h=w, $fn=120);', 9000);
    const before = { fingerprints: [fp('cylinder(h=w, $fn=120);')], sources: ['w = 1;\ncylinder(h=w, $fn=120);'] };
    const after = { fingerprints: [fp('cylinder(h=w, $fn=120);')], sources: ['w = 2;\ncylinder(h=w, $fn=120);'] };
    expect(t.forSet(after, before)).toEqual([9000]);
  });

  it('leaves a new part unmeasured', () => {
    const t = new PartTimings();
    const before = { fingerprints: [fp('cube(2);', 'cube')], sources: ['cube(2);'] };
    t.set('cube(2);', 40);
    const after = { fingerprints: [fp('cube(2);', 'cube'), fp('sphere(5);', 'sphere')], sources: ['cube(2);', 'sphere(5);'] };
    expect(t.forSet(after, before)).toEqual([40, undefined]);
  });
});
