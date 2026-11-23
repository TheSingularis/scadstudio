import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultLibraryDirs, renderScadToStl } from './scadRender';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The document the renderer is showing, as far as the main process knows:
// set whenever a file is opened (and, later, saved). Renders resolve
// `use <...>` / `include <...>` against its folder (see scadRender.ts).
let currentDocumentPath: string | null = null;
// Mirrored from the renderer (scad:setDirty): whether the editor holds
// changes that are not on disk. Used to ask before closing the window or
// opening another file over them.
let documentDirty = false;
// Set once the user has chosen to close despite (or after saving) unsaved
// changes, so the second close() goes through.
let closeConfirmed = false;

const SCAD_FILTERS = [{ name: 'OpenSCAD', extensions: ['scad'] }];

// Asks before unsaved changes are thrown away. Returns 'save', 'discard' or
// 'cancel'.
async function confirmDiscard(win: BrowserWindow | null, action: string): Promise<'save' | 'discard' | 'cancel'> {
  const options = {
    type: 'warning' as const,
    message: 'You have unsaved changes.',
    detail: `Save them before ${action}?`,
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
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

  win.on('close', (event) => {
    if (!documentDirty || closeConfirmed || process.env['SCADSTUDIO_SCREENSHOT']) return;
    event.preventDefault();
    void confirmDiscard(win, 'closing').then((choice) => {
      if (choice === 'cancel') return;
      if (choice === 'discard') {
        closeConfirmed = true;
        win.close();
        return;
      }
      // Saving needs the renderer's current text and, for an untitled
      // document, a Save As dialog: hand it over, and the renderer calls
      // scad:closeAfterSave once the file is written.
      win.webContents.send('app:saveAndClose');
    });
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
          // window.__testSetSource (App.tsx), not window.__testEditor.setValue
          // — the latter went through Monaco's onDidChangeModelContent, which
          // is now guarded against isFlush (2026-09-20 double-render fix) and
          // can no longer tell "test harness bypass" from "the programmatic
          // edit this guard exists to skip" apart.
          await win.webContents.executeJavaScript(
            `window.__testSetSource(${JSON.stringify(process.env['SCADSTUDIO_TEST_EDIT'])})`,
          );
          await new Promise((r) => setTimeout(r, 2500));
        }
        // Runs arbitrary JS from the environment, so never in a packaged
        // release build (QC audit L4); the CI smoke test doesn't use it.
        if (process.env['SCADSTUDIO_EXEC_JS'] && !app.isPackaged) {
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
    return renderScadToStl(source, {
      documentPath: currentDocumentPath,
      libraryDirs: defaultLibraryDirs(app.getPath('documents')),
    });
  });

  ipcMain.handle('scad:openFile', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (documentDirty) {
      const choice = await confirmDiscard(win, 'opening another file');
      if (choice === 'cancel') return null;
      // 'save' is the renderer's job (it has the text); tell it to save and
      // retry. Returning a marker keeps this handler free of renderer state.
      if (choice === 'save') return { saveFirst: true } as const;
    }
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: SCAD_FILTERS,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const contents = await readFile(filePath, 'utf8');
    currentDocumentPath = filePath;
    return { filePath, contents };
  });

  // Save / Save As (QC audit H5). Writes the renderer's current text to
  // `filePath`, or asks for a path when there is none yet or saveAs is set.
  // Resolves to the path written, or null if the user cancelled the dialog.
  ipcMain.handle(
    'scad:saveFile',
    async (event, request: { filePath: string | null; contents: string; saveAs: boolean }) => {
      let target = request.saveAs || !request.filePath ? null : request.filePath;
      if (!target) {
        const win = BrowserWindow.fromWebContents(event.sender);
        const options = {
          defaultPath: request.filePath ?? 'untitled.scad',
          filters: SCAD_FILTERS,
        };
        const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) return null;
        target = extname(result.filePath) ? result.filePath : `${result.filePath}.scad`;
      }
      await writeFile(target, request.contents, 'utf8');
      currentDocumentPath = target;
      documentDirty = false;
      return target;
    },
  );

  ipcMain.on('scad:setDirty', (_event, dirty: boolean) => {
    documentDirty = dirty;
  });

  ipcMain.on('scad:closeAfterSave', (event) => {
    closeConfirmed = true;
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
