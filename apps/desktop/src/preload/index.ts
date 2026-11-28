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

// M11: a file the document includes (see src/main/moduleSources.ts).
export interface IncludedFile {
  path: string;
  contents: string;
  via: string;
}

// M15: a font text() can use (see the main process's fonts:list).
export interface FontListEntry {
  family: string;
  style: string;
  monospace?: boolean;
  source: 'bundled' | 'project' | 'system';
}

// M15: persisted app settings (src/main/settings.ts).
export interface AppSettings {
  editorFontFamily: string;
  editorFontSize: number;
  // M18: see src/main/settings.ts.
  previewMode: 'auto' | 'always' | 'off';
  previewSegments: number;
}

// M18: a render's mesh, whether a preview lowered its curve detail, and the
// engine time (src/main/scadRender.ts MeshResult).
export interface MeshResult {
  bytes: Uint8Array;
  reduced: boolean;
  engineMs: number;
  // A preview: the most any curve's segment count was divided by.
  detailFactor: number;
}

const api = {
  // Binary STL with a per-face color trailer (src/main/offMesh.ts).
  renderScad: (source: string): Promise<Uint8Array> => ipcRenderer.invoke('scad:render', source),
  // M18: a full render (previewSegments null) or a quick preview with curve
  // detail capped at that many segments.
  renderMesh: (source: string, previewSegments: number | null): Promise<MeshResult> => ipcRenderer.invoke('scad:renderMesh', source, previewSegments),
  // M10a: stop the render in progress (and any queued behind it).
  cancelRender: (): Promise<boolean> => ipcRenderer.invoke('scad:cancelRender'),
  // M10a: which step the current render is on.
  onRenderStage: (callback: (stage: 'preparing' | 'engine' | 'mesh') => void): (() => void) => {
    const listener = (_event: unknown, stage: 'preparing' | 'engine' | 'mesh') => callback(stage);
    ipcRenderer.on('scad:renderStage', listener);
    return () => ipcRenderer.removeListener('scad:renderStage', listener);
  },
  openFile: (): Promise<OpenFileResult | OpenFileSaveFirst | null> => ipcRenderer.invoke('scad:openFile'),
  // M9: open a known file (a library module's source) without a dialog.
  openPath: (filePath: string): Promise<OpenFileResult | OpenFileSaveFirst | null> => ipcRenderer.invoke('scad:openPath', filePath),
  // Resolves to the path written, or null if the user cancelled.
  saveFile: (request: SaveFileRequest): Promise<string | null> => ipcRenderer.invoke('scad:saveFile', request),
  setDirty: (dirty: boolean): void => ipcRenderer.send('scad:setDirty', dirty),
  closeAfterSave: (): void => ipcRenderer.send('scad:closeAfterSave'),
  scanModules: (source: string): Promise<ModuleSourceFile[]> => ipcRenderer.invoke('scad:scanModules', source),
  scanIncludes: (source: string): Promise<IncludedFile[]> => ipcRenderer.invoke('scad:scanIncludes', source),
  // M15: fonts for the Text panel; `refresh` re-reads installed fonts.
  listFonts: (source: string, refresh = false): Promise<FontListEntry[]> => ipcRenderer.invoke('fonts:list', source, refresh),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke('settings:update', patch),
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
