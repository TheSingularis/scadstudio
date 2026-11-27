// The main process's render host (src/main/renderHost.ts): renders run in a
// separate process, one at a time, and the app survives that process dying
// (crash report 2026-11-25). A fake child stands in for Electron's
// UtilityProcess so each failure can be staged exactly.
import { describe, expect, it } from 'vitest';
import { ENGINE_CRASH_PREFIX, RENDER_CANCELLED_MESSAGE, RenderHost, type RenderChild } from '../../src/main/renderHost';
import type { RenderReply, RenderRequest, RenderStageMessage } from '../../src/main/renderWorker';
import {
  ENGINE_CRASH_PREFIX as RENDERER_ENGINE_CRASH_PREFIX,
  RENDER_CANCELLED_MESSAGE as RENDERER_CANCELLED_MESSAGE,
  isEngineCrash,
  isRenderCancelled,
} from '../../src/renderer/src/renderErrors';

class FakeChild implements RenderChild {
  requests: RenderRequest[] = [];
  killed = false;
  private onMessage: ((m: RenderReply | RenderStageMessage) => void)[] = [];
  private onExit: ((code: number) => void)[] = [];
  on(event: 'message' | 'exit', listener: (arg: never) => void) {
    if (event === 'message') this.onMessage.push(listener as (m: RenderReply | RenderStageMessage) => void);
    else this.onExit.push(listener as (code: number) => void);
    return this;
  }
  postMessage(request: RenderRequest) {
    this.requests.push(request);
  }
  kill() {
    this.killed = true;
    return true;
  }
  reply(reply: Partial<RenderReply> & { ok: boolean }) {
    const id = this.requests[this.requests.length - 1].id;
    const full = reply.ok
      ? { id, bytes: new Uint8Array([1, 2, 3]), rss: 100, ...reply }
      : { id, message: 'ERROR: boom', log: ['ERROR: boom'], rss: 100, ...reply };
    this.onMessage.forEach((fn) => fn(full as RenderReply));
  }
  stage(stage: RenderStageMessage['stage']) {
    const id = this.requests[this.requests.length - 1].id;
    this.onMessage.forEach((fn) => fn({ id, stage }));
  }
  exit(code: number) {
    this.onExit.forEach((fn) => fn(code));
  }
}

function hostWithFakes(recycleAboveBytes?: number) {
  const children: FakeChild[] = [];
  const host = new RenderHost(() => {
    const c = new FakeChild();
    children.push(c);
    return c;
  }, { recycleAboveBytes });
  return { host, children };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('RenderHost (crash report 2026-11-25)', () => {
  it('starts the render process on the first render and reuses it', async () => {
    const { host, children } = hostWithFakes();
    expect(children).toHaveLength(0);
    const first = host.render('cube(1);', { documentPath: '/a/b.scad', libraryDirs: ['/lib'] });
    await tick();
    expect(children).toHaveLength(1);
    expect(children[0].requests[0]).toMatchObject({ source: 'cube(1);', options: { documentPath: '/a/b.scad', libraryDirs: ['/lib'] } });
    children[0].reply({ ok: true });
    await expect(first).resolves.toEqual(new Uint8Array([1, 2, 3]));
    const second = host.render('cube(2);');
    await tick();
    children[0].reply({ ok: true });
    await second;
    expect(children).toHaveLength(1);
  });

  it("passes OpenSCAD's own errors through as ScadRenderErrors with the log", async () => {
    const { host, children } = hostWithFakes();
    const p = host.render('cube(;');
    await tick();
    children[0].reply({ ok: false, message: 'Parser error in line 1', log: ['Parser error in line 1'] });
    await expect(p).rejects.toMatchObject({ name: 'ScadRenderError', message: 'Parser error in line 1', log: ['Parser error in line 1'] });
  });

  it('runs renders one at a time, in order', async () => {
    const { host, children } = hostWithFakes();
    const a = host.render('a');
    const b = host.render('b');
    await tick();
    expect(children[0].requests.map((r) => r.source)).toEqual(['a']);
    children[0].reply({ ok: true, bytes: new Uint8Array([1]) });
    await a;
    await tick();
    expect(children[0].requests.map((r) => r.source)).toEqual(['a', 'b']);
    children[0].reply({ ok: true, bytes: new Uint8Array([2]) });
    await expect(b).resolves.toEqual(new Uint8Array([2]));
  });

  it('a render process that dies mid-render rejects that render with a readable message, and the next render gets a fresh process', async () => {
    const { host, children } = hostWithFakes();
    const doomed = host.render('heavy');
    const queued = host.render('cube(1);');
    await tick();
    children[0].exit(134);
    const err = await doomed.catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(ENGINE_CRASH_PREFIX);
    expect((err as Error).message).toContain('exit code 134');
    expect((err as Error).message).toMatch(/ScadStudio is still running/);
    await tick();
    expect(children).toHaveLength(2);
    expect(children[1].requests[0].source).toBe('cube(1);');
    children[1].reply({ ok: true });
    await expect(queued).resolves.toBeInstanceOf(Uint8Array);
  });

  it('retires a process left above the memory limit, without failing the render', async () => {
    const { host, children } = hostWithFakes(500);
    const big = host.render('big');
    await tick();
    children[0].reply({ ok: true, rss: 1000 });
    await expect(big).resolves.toBeInstanceOf(Uint8Array);
    expect(children[0].killed).toBe(true);
    // Its exit after being retired is expected, not a crash.
    children[0].exit(0);
    const next = host.render('small');
    await tick();
    expect(children).toHaveLength(2);
    children[1].reply({ ok: true, rss: 100 });
    await next;
    expect(children[1].killed).toBe(false);
  });

  it('a render process that cannot start rejects the render instead of throwing', async () => {
    const host = new RenderHost(() => {
      throw new Error('spawn failed');
    });
    await expect(host.render('cube(1);')).rejects.toThrow(/Could not start the OpenSCAD engine: spawn failed/);
  });

  it('the renderer recognises the engine-crash message (and skips the 2D retry for it)', async () => {
    expect(RENDERER_ENGINE_CRASH_PREFIX).toBe(ENGINE_CRASH_PREFIX);
    const { host, children } = hostWithFakes();
    const p = host.render('heavy');
    await tick();
    children[0].exit(1);
    const err = await p.catch((e: Error) => e);
    // As the renderer receives it through ipcRenderer.invoke.
    const wrapped = new Error(`Error invoking remote method 'scad:render': ScadRenderError: ${(err as Error).message}`);
    expect(isEngineCrash(wrapped)).toBe(true);
    expect(isEngineCrash(new Error("Error invoking remote method 'scad:render': ScadRenderError: Current top level object is not a 3D object."))).toBe(false);
  });

  describe('M10a: progress steps and Cancel', () => {
    it('passes the render process\'s steps to the caller of that render', async () => {
      const { host, children } = hostWithFakes();
      const stages: string[] = [];
      const r = host.render('cube(1);', {}, (s) => stages.push(s));
      await tick();
      children[0].stage('preparing');
      children[0].stage('engine');
      children[0].stage('mesh');
      children[0].reply({ ok: true });
      await expect(r).resolves.toBeInstanceOf(Uint8Array);
      expect(stages).toEqual(['preparing', 'engine', 'mesh']);
    });

    it('Cancel kills the busy process, rejects that render and the queued ones, and the next render gets a fresh process', async () => {
      const { host, children } = hostWithFakes();
      const busy = host.render('heavy');
      const queued = host.render('also heavy');
      await tick();
      expect(host.cancel()).toBe(true);
      const err = await busy.catch((e: Error) => e);
      expect((err as Error).message).toBe(RENDER_CANCELLED_MESSAGE);
      expect(isRenderCancelled(err)).toBe(true);
      expect(isEngineCrash(err)).toBe(false);
      await expect(queued).rejects.toThrow(RENDER_CANCELLED_MESSAGE);
      expect(children[0].killed).toBe(true);
      // Its exit after the kill is expected, not a crash.
      children[0].exit(1);

      const next = host.render('cube(1);');
      await tick();
      expect(children).toHaveLength(2);
      expect(children[0].requests.map((r) => r.source)).toEqual(['heavy']);
      children[1].reply({ ok: true });
      await expect(next).resolves.toBeInstanceOf(Uint8Array);
    });

    it('Cancel with nothing running does nothing to the next render', async () => {
      const { host, children } = hostWithFakes();
      expect(host.cancel()).toBe(false);
      const r = host.render('cube(1);');
      await tick();
      children[0].reply({ ok: true });
      await expect(r).resolves.toBeInstanceOf(Uint8Array);
    });

    it('the renderer recognizes the main process\'s cancel message', () => {
      expect(RENDERER_CANCELLED_MESSAGE).toBe(RENDER_CANCELLED_MESSAGE);
      expect(isRenderCancelled(new Error(`Error invoking remote method 'scad:render': Error: ${RENDER_CANCELLED_MESSAGE}`))).toBe(true);
    });
  });
});
