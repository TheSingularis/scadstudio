// The renderer's per-node render cache (src/renderer/src/renderCache.ts) is
// bounded by total mesh size as well as entry count: a heavy model made of
// tens of megabytes per render could otherwise fill the window's memory one
// edit at a time (crash report 2026-11-25).
import { describe, expect, it } from 'vitest';
import { RenderCache } from '../../src/renderer/src/renderCache';

const mesh = (bytes: number) => ({ bytes: new Uint8Array(bytes) });

describe('RenderCache (crash report 2026-11-25)', () => {
  it('evicts least recently used entries once the byte budget is exceeded', () => {
    const cache = new RenderCache(100, 1000);
    cache.set('a', mesh(400));
    cache.set('b', mesh(400));
    cache.get('a'); // a is now more recent than b
    cache.set('c', mesh(400));
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.bytes).toBe(800);
  });

  it('keeps a single entry larger than the whole budget (the render that made it still needs it)', () => {
    const cache = new RenderCache(100, 1000);
    cache.set('a', mesh(10));
    cache.set('huge', mesh(5000));
    expect(cache.size).toBe(1);
    expect(cache.get('huge')).toBeDefined();
  });

  it('still honours the entry limit, counting failed renders', () => {
    const cache = new RenderCache(2, 1_000_000);
    cache.set('a', { firstError: 'x', secondError: 'y' });
    cache.set('b', mesh(1));
    cache.set('c', mesh(1));
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
  });

  it('replacing a key and clearing keep the byte count right', () => {
    const cache = new RenderCache(100, 1000);
    cache.set('a', mesh(300));
    cache.set('a', mesh(200));
    expect(cache.bytes).toBe(200);
    cache.clear();
    expect(cache.bytes).toBe(0);
    expect(cache.size).toBe(0);
  });
});
