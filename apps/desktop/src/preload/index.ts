import { contextBridge, ipcRenderer } from 'electron';

export interface OpenFileResult {
  filePath: string;
  contents: string;
}

// The main process asked first about unsaved changes and the user chose
// Save: the renderer saves, then calls openFile again.
export interface OpenFileSaveFirst {
  saveFirst: true;
}

export interface SaveFileRequest {
  filePath: string | null;
  contents: string;
  saveAs: boolean;
}

// M8: a library file that can supply Custom toolbar tools (see
// src/main/moduleSources.ts).
export interface ModuleSourceFile {
  path: string;
  contents: string;
  useDirective: string | null;
}

const api = {
  renderScad: (source: string): Promise<Uint8Array> => ipcRenderer.invoke('scad:render', source),
  openFile: (): Promise<OpenFileResult | OpenFileSaveFirst | null> => ipcRenderer.invoke('scad:openFile'),
  // M9: open a known file (a library module's source) without a dialog.
  openPath: (filePath: string): Promise<OpenFileResult | OpenFileSaveFirst | null> => ipcRenderer.invoke('scad:openPath', filePath),
  // Resolves to the path written, or null if the user cancelled.
  saveFile: (request: SaveFileRequest): Promise<string | null> => ipcRenderer.invoke('scad:saveFile', request),
  setDirty: (dirty: boolean): void => ipcRenderer.send('scad:setDirty', dirty),
  closeAfterSave: (): void => ipcRenderer.send('scad:closeAfterSave'),
  scanModules: (source: string): Promise<ModuleSourceFile[]> => ipcRenderer.invoke('scad:scanModules', source),
  // A watched library file changed on disk.
  onModulesChanged: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('modules:changed', listener);
    return () => ipcRenderer.removeListener('modules:changed', listener);
  },
  // The window is closing with unsaved changes and the user chose Save.
  onSaveAndClose: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('app:saveAndClose', listener);
    return () => ipcRenderer.removeListener('app:saveAndClose', listener);
  },
};

export type ScadStudioApi = typeof api;

contextBridge.exposeInMainWorld('scadstudio', api);
