import { contextBridge, ipcRenderer } from 'electron';

export interface OpenFileResult {
  filePath: string;
  contents: string;
}

const api = {
  renderScad: (source: string): Promise<Uint8Array> => ipcRenderer.invoke('scad:render', source),
  openFile: (): Promise<OpenFileResult | null> => ipcRenderer.invoke('scad:openFile'),
};

export type ScadStudioApi = typeof api;

contextBridge.exposeInMainWorld('scadstudio', api);
