// M9 per-node render cache (PLAN.md "Per-node selection & manipulation
// strategy", point 2; risk 2). Keyed on the exact source sent to the engine
// (the node's primitive plus everything it can see), so an edit to one node
// re-renders only that node: its siblings' sources are unchanged and come
// from here, and so does everything when stepping in and out of a drill-in.
//
// Bounded by entry count *and* by the total size of the meshes it holds.
// A count alone was not enough: one heavy model (the gag-trophy crash
// report, 2026-11-25) renders to a mesh of tens of megabytes, and every
// edit to it adds another entry, so a count-only cache could hold gigabytes
// and take the window down with it. Least recently used entries go first.

export type CachedRender = { bytes: Uint8Array } | { firstError: unknown; secondError: unknown };

// Failed renders hold no mesh; count them as a nominal size so a flood of
// failures is still bounded by the entry limit.
const FAILED_ENTRY_BYTES = 1024;

function sizeOf(entry: CachedRender): number {
  return 'bytes' in entry ? entry.bytes.byteLength : FAILED_ENTRY_BYTES;
}

export class RenderCache {
  private readonly entries = new Map<string, CachedRender>();
  private totalBytes = 0;

  constructor(
    readonly maxEntries = 500,
    readonly maxBytes = 256 * 1024 * 1024,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /** Total mesh bytes currently held. */
  get bytes(): number {
    return this.totalBytes;
  }

  /** The cached result for `key`, marking it most recently used. */
  get(key: string): CachedRender | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  /**
   * Store a result, then evict least recently used entries until both
   * limits hold. The entry just stored is never evicted, so the render that
   * produced it can always use it, even when it alone exceeds the budget.
   */
  set(key: string, entry: CachedRender): void {
    const old = this.entries.get(key);
    if (old) {
      this.totalBytes -= sizeOf(old);
      this.entries.delete(key);
    }
    this.entries.set(key, entry);
    this.totalBytes += sizeOf(entry);
    while (this.entries.size > 1 && (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes)) {
      const oldest = this.entries.keys().next().value!;
      this.totalBytes -= sizeOf(this.entries.get(oldest)!);
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }
}
