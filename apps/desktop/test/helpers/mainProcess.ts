// Loads the real Electron main-process module (src/main/index.ts) under
// Vitest with `electron` replaced by a small fake, and hands back the IPC
// handlers it registers. Integration tests then call e.g. the real
// `scad:render` handler directly, so they exercise exactly the code the app
// runs (backend flags, virtual-FS setup, error handling) without Electron.
//
// The OpenSCAD engine (src/main/engine.ts) is wrapped, not replaced: every instance the main process
// creates still renders for real, but its stdout/stderr lines are also
// recorded so tests can see which geometry backend OpenSCAD reports using.
import { vi } from 'vitest';

export type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

export interface MainProcessHarness {
  handlers: Map<string, IpcHandler>;
  /** stderr+stdout lines of every OpenSCAD instance, newest render last. */
  engineLog: string[][];
  dialog: { showOpenDialog: ReturnType<typeof vi.fn>; showSaveDialog: ReturnType<typeof vi.fn> };
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  /** Channels the main process sent to the renderer (webContents.send), oldest first. */
  sent: string[];
  /** Messages sent back to the invoking renderer (event.sender.send), oldest first. */
  replies: { channel: string; args: unknown[] }[];
}

export async function loadMainProcess(): Promise<MainProcessHarness> {
  vi.resetModules();
  const handlers = new Map<string, IpcHandler>();
  const engineLog: string[][] = [];
  const dialog = { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() };
  const sent: string[] = [];
  const replies: { channel: string; args: unknown[] }[] = [];
  // The one window events reach (e.g. M8's modules:changed).
  const fakeWindow = { webContents: { send: (channel: string) => sent.push(channel) } };

  vi.doMock('electron', () => {
    class FakeWebContents {
      on() {}
      once() {}
      send() {}
    }
    class FakeBrowserWindow {
      static getAllWindows() {
        return [fakeWindow];
      }
      static fromWebContents() {
        return null;
      }
      webContents = new FakeWebContents();
      loadURL() {}
      loadFile() {}
      on() {}
    }
    const app = { whenReady: () => Promise.resolve(), on() {}, quit() {}, getPath: () => '/tmp' };
    // The render process (src/main/renderWorker.ts) runs in-process here:
    // the real request handler, minus the process boundary. RenderHost's
    // own process handling (crash, restart, recycle) has unit tests with a
    // fake child (test/unit/renderHost.test.ts), and the e2e suite runs the
    // real utility process.
    class InProcessRenderChild {
      private listeners: Record<string, ((arg: unknown) => void)[]> = {};
      on(event: string, fn: (arg: unknown) => void) {
        (this.listeners[event] ??= []).push(fn);
        return this;
      }
      postMessage(request: unknown) {
        void import('../../src/main/renderWorker')
          .then((m) =>
            m.handleRenderRequest(request as Parameters<typeof m.handleRenderRequest>[0], (stage) =>
              this.listeners['message']?.forEach((fn) => fn(stage)),
            ),
          )
          .then((reply) => this.listeners['message']?.forEach((fn) => fn(reply)));
      }
      kill() {
        return true;
      }
    }
    const utilityProcess = { fork: () => new InProcessRenderChild() };
    const ipcMain = {
      handle: (channel: string, fn: IpcHandler) => handlers.set(channel, fn),
      on: (channel: string, fn: IpcHandler) => handlers.set(channel, fn),
      removeHandler: (channel: string) => handlers.delete(channel),
    };
    const fake = { app, BrowserWindow: FakeBrowserWindow, dialog, ipcMain, utilityProcess, Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) } };
    return { ...fake, default: fake };
  });

  vi.doMock('../../src/main/engine', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../src/main/engine')>();
    const createEngine = (options: Parameters<typeof real.createEngine>[0] = {}) => {
      const lines: string[] = [];
      engineLog.push(lines);
      return real.createEngine({
        ...options,
        print: (t: string) => {
          lines.push(t);
          options?.print?.(t);
        },
        printErr: (t: string) => {
          lines.push(t);
          options?.printErr?.(t);
        },
      });
    };
    return { ...real, createEngine };
  });

  await import('../../src/main/index');
  // app.whenReady().then(...) registers the handlers on a microtask.
  for (let i = 0; i < 5 && !handlers.has('scad:render'); i++) await new Promise((r) => setTimeout(r, 0));
  if (!handlers.has('scad:render')) throw new Error('main process registered no scad:render handler');

  const invoke = async (channel: string, ...args: unknown[]) => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`no IPC handler for ${channel}`);
    return fn({ sender: { isDestroyed: () => false, send: (channel: string, ...rest: unknown[]) => replies.push({ channel, args: rest }) } }, ...args);
  };
  return { handlers, engineLog, dialog, invoke, sent, replies };
}
