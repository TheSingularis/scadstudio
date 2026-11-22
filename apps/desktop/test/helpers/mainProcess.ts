// Loads the real Electron main-process module (src/main/index.ts) under
// Vitest with `electron` replaced by a small fake, and hands back the IPC
// handlers it registers. Integration tests then call e.g. the real
// `scad:render` handler directly, so they exercise exactly the code the app
// runs (backend flags, virtual-FS setup, error handling) without Electron.
//
// openscad-wasm is wrapped, not replaced: every instance the main process
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
}

export async function loadMainProcess(): Promise<MainProcessHarness> {
  vi.resetModules();
  const handlers = new Map<string, IpcHandler>();
  const engineLog: string[][] = [];
  const dialog = { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() };

  vi.doMock('electron', () => {
    class FakeWebContents {
      on() {}
      once() {}
      send() {}
    }
    class FakeBrowserWindow {
      static getAllWindows() {
        return [];
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
    const ipcMain = {
      handle: (channel: string, fn: IpcHandler) => handlers.set(channel, fn),
      on: (channel: string, fn: IpcHandler) => handlers.set(channel, fn),
      removeHandler: (channel: string) => handlers.delete(channel),
    };
    const fake = { app, BrowserWindow: FakeBrowserWindow, dialog, ipcMain, Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) } };
    return { ...fake, default: fake };
  });

  vi.doMock('openscad-wasm', async (importOriginal) => {
    const real = await importOriginal<typeof import('openscad-wasm')>();
    type Opts = Parameters<typeof real.createOpenSCAD>[0];
    const createOpenSCAD = (options: Opts = {}) => {
      const lines: string[] = [];
      engineLog.push(lines);
      return real.createOpenSCAD({
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
    return { ...real, createOpenSCAD, default: { ...real, createOpenSCAD } };
  });

  await import('../../src/main/index');
  // app.whenReady().then(...) registers the handlers on a microtask.
  for (let i = 0; i < 5 && !handlers.has('scad:render'); i++) await new Promise((r) => setTimeout(r, 0));
  if (!handlers.has('scad:render')) throw new Error('main process registered no scad:render handler');

  const invoke = async (channel: string, ...args: unknown[]) => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`no IPC handler for ${channel}`);
    return fn({ sender: {} }, ...args);
  };
  return { handlers, engineLog, dialog, invoke };
}
