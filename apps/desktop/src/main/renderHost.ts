import { ScadRenderError, type RenderOptions } from './scadRender';
import type { RenderReply, RenderRequest } from './renderWorker';

// Runs renders in a separate render process (renderWorker.ts), one at a
// time, and keeps the app alive whatever happens to it.
//
// - The main process never runs OpenSCAD itself, so its UI thread stays
//   responsive during a long render.
// - If the render process dies mid-render (out of memory, an engine abort),
//   that render is rejected with a message saying so, and the next render
//   starts a fresh process.
// - After a render that left the process holding a lot of memory, the
//   process is retired, so one heavy model doesn't keep that memory for the
//   rest of the session. Starting a new one costs a fraction of a second.

// Keep in step with src/renderer/src/renderErrors.ts (unit-tested).
export const ENGINE_CRASH_PREFIX = 'The OpenSCAD engine stopped';

/** The parts of Electron's UtilityProcess this uses (a test can fake them). */
export interface RenderChild {
  postMessage(message: RenderRequest): void;
  on(event: 'message', listener: (message: RenderReply) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  kill(): boolean;
}

export type SpawnRenderChild = () => RenderChild;

export interface RenderHostOptions {
  /** Retire the render process after a render leaves it above this resident size. */
  recycleAboveBytes?: number;
}

interface Pending {
  id: number;
  resolve: (bytes: Uint8Array) => void;
  reject: (err: Error) => void;
}

export function engineCrashMessage(code: number | null): string {
  return (
    `${ENGINE_CRASH_PREFIX} unexpectedly while rendering${code !== null ? ` (exit code ${code})` : ''}. ` +
    'This usually means the model needed more memory than the engine has. ' +
    'ScadStudio is still running: lower $fn or other detail settings and try again.'
  );
}

export class RenderHost {
  private child: RenderChild | null = null;
  private pending: Pending | null = null;
  private nextId = 1;
  // Renders run one after another: each is CPU-bound, and a single process
  // keeps memory predictable.
  private queue: Promise<unknown> = Promise.resolve();
  /** Render processes started so far (for tests and diagnostics). */
  spawnCount = 0;

  constructor(
    private readonly spawn: SpawnRenderChild,
    private readonly options: RenderHostOptions = {},
  ) {}

  render(source: string, options: RenderOptions = {}): Promise<Uint8Array> {
    const run = this.queue.then(() => this.renderNow(source, options));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Stop the render process (rejecting a render in progress). */
  dispose(): void {
    const child = this.child;
    this.child = null;
    child?.kill();
    this.failPending(new ScadRenderError(engineCrashMessage(null), []));
  }

  private ensureChild(): RenderChild {
    if (this.child) return this.child;
    const child = this.spawn();
    this.spawnCount++;
    child.on('message', (reply) => {
      if (child !== this.child) return;
      const p = this.pending;
      if (!p || reply.id !== p.id) return;
      this.pending = null;
      const limit = this.options.recycleAboveBytes;
      if (limit !== undefined && reply.rss > limit) this.retire(child);
      if (reply.ok) p.resolve(reply.bytes);
      else p.reject(new ScadRenderError(reply.message, reply.log));
    });
    child.on('exit', (code) => {
      if (child !== this.child) return; // retired on purpose
      this.child = null;
      console.error(`[scadstudio] render process exited (code ${code})`);
      this.failPending(new ScadRenderError(engineCrashMessage(code), []));
    });
    this.child = child;
    return child;
  }

  private retire(child: RenderChild): void {
    if (this.child === child) this.child = null;
    child.kill();
  }

  private failPending(err: Error): void {
    const p = this.pending;
    this.pending = null;
    p?.reject(err);
  }

  private renderNow(source: string, options: RenderOptions): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      let child: RenderChild;
      try {
        child = this.ensureChild();
      } catch (err) {
        reject(new ScadRenderError(`Could not start the OpenSCAD engine: ${err instanceof Error ? err.message : String(err)}`, []));
        return;
      }
      const id = this.nextId++;
      this.pending = { id, resolve, reject };
      try {
        child.postMessage({ id, source, options });
      } catch {
        this.retire(child);
        this.failPending(new ScadRenderError(engineCrashMessage(null), []));
      }
    });
  }
}
