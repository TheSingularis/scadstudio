// M2: only the latest edit renders; renders never overlap or pile up.
import { describe, expect, it } from 'vitest';
import { createCoalescingRunner } from '../../src/renderer/src/coalescingRunner';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createCoalescingRunner (M2)', () => {
  it('runs once, then only the latest of everything queued meanwhile', async () => {
    const seen: number[] = [];
    let release: () => void = () => {};
    let active = 0;
    let maxActive = 0;
    const run = createCoalescingRunner(async (v: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      seen.push(v);
      await new Promise<void>((r) => (release = r));
      active--;
    });
    run(1);
    run(2);
    run(3);
    run(4);
    await tick();
    expect(seen).toEqual([1]);
    release();
    await tick();
    expect(seen).toEqual([1, 4]);
    release();
    await tick();
    run(5);
    await tick();
    expect(seen).toEqual([1, 4, 5]);
    release();
    await tick();
    expect(maxActive).toBe(1);
  });

  it('keeps going after a value is queued during the last run', async () => {
    const seen: string[] = [];
    const run = createCoalescingRunner(async (v: string) => {
      seen.push(v);
      if (v === 'a') run('b');
    });
    run('a');
    await tick();
    await tick();
    expect(seen).toEqual(['a', 'b']);
  });
});
