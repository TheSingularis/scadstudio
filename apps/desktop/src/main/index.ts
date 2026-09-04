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
      setTimeout(async () => {
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
          const [x, y] = process.env['SCADSTUDIO_CLICK_AT']!.split(',').map(Number);
          win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
          win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
          await new Promise((r) => setTimeout(r, 500));
        }
        const image = await win.webContents.capturePage();
        await writeFile(process.env['SCADSTUDIO_SCREENSHOT']!, image.toPNG());
        app.quit();
      }, 3000);
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
