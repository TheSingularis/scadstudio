// M18 (PLAN.md "Fast preview and full render", decided with Jordan
// 2026-11-27): which parts render as a quick preview (curve detail capped,
// see src/main/previewDetail.ts) and which at full detail.
//
// Auto, the default: a part renders as a preview when its last full render
// took PREVIEW_AUTO_MS or more, or when it hasn't been measured yet (the
// preview then tells: if the part has no curve finer than the cap, the
// preview *is* the full render). Everything else renders at full detail, so
// a small file never shows "Preview". Render (F6) renders every part at full
// detail and measures it.
//
// Why 2 s (PLAN.md has the long form): below about 1 s an edit feels
// immediate and the preview's extra pass (0.07-0.26 s) eats most of the
// gain; at 2 s the wait is felt on every edit. Jordan's machine renders two
// to three times slower than the cloud test machine, so 3 s would leave too
// many mid-sized parts at full detail there.

import type { NodeFingerprint } from './nodeIdentity';
import { remapIndex } from './nodeIdentity';

export type PreviewMode = 'auto' | 'always' | 'off';

export const PREVIEW_AUTO_MS = 2000;

/**
 * An unmeasured part rendered as a preview: is its full render likely to
 * stay under PREVIEW_AUTO_MS? Then it isn't a slow part, and is rendered in
 * full straight away rather than left showing "Preview". The estimate scales
 * the preview's time by how much its curves were divided (`detailFactor`:
 * $fn 64 capped at 24 is 2.7). Measured 2026-11-27: the rack mount fixture
 * (factor 2.7) previews in 0.6 s, estimated 1.6 s, full 0.5 s; the gag
 * trophy (factor 5) previews in 4.3 s, estimated 21 s, full 32.5 s.
 */
export function likelyFastAtFull(engineMs: number, detailFactor: number): boolean {
  return engineMs * Math.max(1, detailFactor) < PREVIEW_AUTO_MS;
}

export type Quality = { kind: 'full' } | { kind: 'preview'; segments: number };

export const FULL: Quality = { kind: 'full' };

export function chooseQuality(mode: PreviewMode, segments: number, knownFullMs: number | undefined, forceFull: boolean): Quality {
  if (forceFull || mode === 'off') return FULL;
  if (mode === 'always') return { kind: 'preview', segments };
  if (knownFullMs !== undefined && knownFullMs < PREVIEW_AUTO_MS) return FULL;
  return { kind: 'preview', segments };
}

/** The render cache key for a source at a quality (a full render is keyed on the source itself). */
export function cacheKey(source: string, quality: Quality): string {
  return quality.kind === 'full' ? source : `\u0000preview:${quality.segments}\n${source}`;
}

const MAX_TIMINGS = 2000;

/**
 * How long each part took to render at full detail, by the exact source
 * sent to the engine, carried across edits by node identity (an edited part
 * keeps its predecessor's timing until it is measured again).
 */
export class PartTimings {
  private readonly bySource = new Map<string, number>();

  get(source: string): number | undefined {
    return this.bySource.get(source);
  }

  set(source: string, ms: number): void {
    this.bySource.delete(source);
    this.bySource.set(source, ms);
    while (this.bySource.size > MAX_TIMINGS) this.bySource.delete(this.bySource.keys().next().value!);
  }

  clear(): void {
    this.bySource.clear();
  }

  /**
   * Timings for a working set's parts. A part whose source has no timing
   * inherits the one of the part it was before the edit (`before`: the
   * previous version of the same working set), which is then remembered
   * under its new source so a run of edits keeps it.
   */
  forSet(
    after: { fingerprints: NodeFingerprint[]; sources: string[] },
    before: { fingerprints: NodeFingerprint[]; sources: string[] } | null,
  ): (number | undefined)[] {
    const out = after.sources.map((s) => this.get(s));
    if (!before || out.every((t) => t !== undefined)) return out;
    const inherit = (a: number, b: number) => {
      const ms = this.get(before.sources[b]);
      if (ms === undefined || out[a] !== undefined) return;
      out[a] = ms;
      this.set(after.sources[a], ms);
    };
    // A part with the same text whose source still changed (an edited
    // variable it can see): same part, same timing.
    const unchangedAt = new Map<string, number[]>();
    before.fingerprints.forEach((f, b) => unchangedAt.set(f.text, [...(unchangedAt.get(f.text) ?? []), b]));
    after.fingerprints.forEach((f, a) => {
      const b = unchangedAt.get(f.text)?.shift();
      if (b !== undefined) inherit(a, b);
    });
    // A part whose own text changed: the part it was, by node identity.
    const afterTexts = new Set(after.fingerprints.map((f) => f.text));
    for (let b = 0; b < before.fingerprints.length; b++) {
      if (afterTexts.has(before.fingerprints[b].text)) continue;
      const a = remapIndex(before.fingerprints, after.fingerprints, b);
      if (a !== null) inherit(a, b);
    }
    return out;
  }
}
