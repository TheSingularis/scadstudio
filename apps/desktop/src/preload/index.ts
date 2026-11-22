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

const api = {
  renderScad: (source: string): Promise<Uint8Array> => ipcRenderer.invoke('scad:render', source),
  openFile: (): Promise<OpenFileResult | OpenFileSaveFirst | null> => ipcRenderer.invoke('scad:openFile'),
  // Resolves to the path written, or null if the user cancelled.
  saveFile: (request: SaveFileRequest): Promise<string | null> => ipcRenderer.invoke('scad:saveFile', request),
  setDirty: (dirty: boolean): void => ipcRenderer.send('scad:setDirty', dirty),
  closeAfterSave: (): void => ipcRenderer.send('scad:closeAfterSave'),
  // The window is closing with unsaved changes and the user chose Save.
  onSaveAndClose: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('app:saveAndClose', listener);
    return () => ipcRenderer.removeListener('app:saveAndClose', listener);
  },
};

export type ScadStudioApi = typeof api;

contextBridge.exposeInMainWorld('scadstudio', api);
