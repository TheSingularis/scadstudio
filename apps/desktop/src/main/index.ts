import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenSCAD } from 'openscad-wasm';

const __dirname = dirname(fileURLToPath(import.meta.url));

// M0 spike finding: a single createOpenSCAD() instance corrupts state after
// one renderToStl() call, so every render gets its own fresh instance.
async function renderScadToStl(source: string): Promise<Uint8Array> {
  const openscad = await createOpenSCAD({
    print: () => {},
    printErr: () => {},
  });
  const stl = await openscad.renderToStl(source);
  return typeof stl === 'string' ? new TextEncoder().encode(stl) : stl;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // Manual verification-only hook, not part of the app: dump a screenshot once
  // the render has had time to settle, then exit. See PLAN.md M1 verification notes.
  if (process.env['SCADSTUDIO_SCREENSHOT']) {
    win.webContents.once('did-finish-load', () => {
      (async () => {
        // Poll for the "Rendered" status text instead of a fixed delay — a
        // fixed wait that happens to be enough on one platform isn't
        // necessarily enough on another. Caught for real: this fixed-delay
        // approach shipped a Windows CI smoke-test screenshot showing an
        // empty viewport still reading "Rendering..." (the exact same wait
        // that fully completes on Linux), because WASM compile/render is
        // measurably slower on that runner. "Rendered" doesn't match
        // mid-render's "Rendering..." (they diverge at the 7th letter).
        const maxWaitMs = 60000;
        const pollIntervalMs = 250;
        const deadline = Date.now() + maxWaitMs;
        while (Date.now() < deadline) {
          const rendered = await win.webContents.executeJavaScript('document.body.innerText.includes("Rendered")');
          if (rendered) break;
          await new Promise((r) => setTimeout(r, pollIntervalMs));
        }

        if (process.env['SCADSTUDIO_TEST_EDIT']) {
          await win.webContents.executeJavaScript(
            `window.__testEditor.setValue(${JSON.stringify(process.env['SCADSTUDIO_TEST_EDIT'])})`,
          );
          await new Promise((r) => setTimeout(r, 2500));
        }
        if (process.env['SCADSTUDIO_EXEC_JS']) {
          await win.webContents.executeJavaScript(process.env['SCADSTUDIO_EXEC_JS']);
          await new Promise((r) => setTimeout(r, 500));
        }
        if (process.env['SCADSTUDIO_CLICK_AT']) {
          // ";"-separated list of "x,y" or "x,y,shift" or "x,y,ctrl" triples,
          // clicked in sequence — lets a single verification run chain UI
          // actions (e.g. pick a gizmo mode, then select a shape) before a
          // SCADSTUDIO_DRAG_AT. The optional third field is a real Electron
          // input modifier ("shift" for range-select, "ctrl" for toggle-
          // select — see Viewport.tsx's SelectMode) — sent through
          // sendInputEvent's own `modifiers` array so it exercises the same
          // shiftKey/ctrlKey the real DOM/r3f click handler reads, not a
          // JS-level shortcut around it.
          for (const triple of process.env['SCADSTUDIO_CLICK_AT']!.split(';')) {
            const [xStr, yStr, modifier] = triple.split(',');
            const x = Number(xStr);
            const y = Number(yStr);
            const modifiers = modifier === 'shift' ? ['shift' as const] : modifier === 'ctrl' ? ['control' as const] : undefined;
            win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1, modifiers });
            win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1, modifiers });
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        // M4/M5 gizmo-drag verification: ";"-separated list of "x1,y1,x2,y2"
        // drags, each a real mouseDown/move.../mouseUp sequence through the
        // same Chromium input pipeline as SCADSTUDIO_CLICK_AT (rather than
        // calling the drag handlers directly from JS) — multiple drags in one
        // run lets a test exercise "commit, then drag the same gizmo again"
        // (e.g. confirming a second rotate patches the existing wrap instead
        // of inserting a duplicate).
        if (process.env['SCADSTUDIO_DRAG_AT']) {
          for (const spec of process.env['SCADSTUDIO_DRAG_AT']!.split(';')) {
            const [x1, y1, x2, y2] = spec.split(',').map(Number);
            const steps = 10;
            win.webContents.sendInputEvent({ type: 'mouseDown', x: x1, y: y1, button: 'left', clickCount: 1 });
            for (let i = 1; i <= steps; i++) {
              const x = x1 + ((x2 - x1) * i) / steps;
              const y = y1 + ((y2 - y1) * i) / steps;
              win.webContents.sendInputEvent({ type: 'mouseMove', x, y, button: 'left' });
              await new Promise((r) => setTimeout(r, 30));
            }
            win.webContents.sendInputEvent({ type: 'mouseUp', x: x2, y: y2, button: 'left', clickCount: 1 });
            // Long enough for a multi-node file's sequential per-node WASM
            // re-renders to finish before a chained drag starts — too short
            // here isn't a product bug, but it does make the gizmo briefly
            // absent, so a follow-up drag can miss it and fall through to
            // camera-orbit instead (which is what a short wait looks like).
            await new Promise((r) => setTimeout(r, 3500));
          }
        }
        const image = await win.webContents.capturePage();
        await writeFile(process.env['SCADSTUDIO_SCREENSHOT']!, image.toPNG());
        app.quit();
      })();
    });
  }
}

app.whenReady().then(() => {
  ipcMain.handle('scad:render', async (_event, source: string) => {
    return renderScadToStl(source);
  });

  ipcMain.handle('scad:openFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'OpenSCAD', extensions: ['scad'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const contents = await readFile(filePath, 'utf8');
    return { filePath, contents };
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
