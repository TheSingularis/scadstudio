import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PREVIEW_SEGMENT_CHOICES } from './previewDetail';

// M15: the app's first persisted settings (Settings > Fonts sets the code
// editor's font, decided with Jordan 2026-11-25). Fonts used *in models*
// are not a setting: they are written in the code as text(font="...").
// Stored as JSON in Electron's userData folder; kept free of Electron so it
// runs under Vitest.

export interface AppSettings {
  // CSS font-family name, or '' for the built-in default.
  editorFontFamily: string;
  editorFontSize: number;
  // M18 (decided with Jordan 2026-11-27): when edits render at reduced
  // curve detail. 'auto': parts whose last full render took 2 s or more
  // (and parts not measured yet); 'always': every part; 'off': never.
  previewMode: PreviewMode;
  // Segments per full circle a preview caps curves at.
  previewSegments: number;
}

export type PreviewMode = 'auto' | 'always' | 'off';
export const PREVIEW_MODES: readonly PreviewMode[] = ['auto', 'always', 'off'];

export const DEFAULT_SETTINGS: AppSettings = {
  editorFontFamily: '',
  editorFontSize: 13,
  previewMode: 'auto',
  previewSegments: 24,
};

export const MIN_EDITOR_FONT_SIZE = 8;
export const MAX_EDITOR_FONT_SIZE = 40;

// Whatever was on disk (or sent by the renderer), made valid.
export function normalizeSettings(raw: unknown): AppSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof AppSettings, unknown>>;
  const family = typeof r.editorFontFamily === 'string' ? r.editorFontFamily.replace(/["\\;{}]/g, '').trim().slice(0, 200) : '';
  const size = typeof r.editorFontSize === 'number' && Number.isFinite(r.editorFontSize) ? Math.round(r.editorFontSize) : DEFAULT_SETTINGS.editorFontSize;
  const mode = PREVIEW_MODES.includes(r.previewMode as PreviewMode) ? (r.previewMode as PreviewMode) : DEFAULT_SETTINGS.previewMode;
  const segments = (PREVIEW_SEGMENT_CHOICES as readonly unknown[]).includes(r.previewSegments) ? (r.previewSegments as number) : DEFAULT_SETTINGS.previewSegments;
  return {
    editorFontFamily: family,
    editorFontSize: Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, size)),
    previewMode: mode,
    previewSegments: segments,
  };
}

export class SettingsStore {
  private current: AppSettings | null = null;

  constructor(private readonly file: string) {}

  async get(): Promise<AppSettings> {
    if (this.current) return this.current;
    try {
      this.current = normalizeSettings(JSON.parse(await readFile(this.file, 'utf8')));
    } catch {
      this.current = { ...DEFAULT_SETTINGS };
    }
    return this.current;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = normalizeSettings({ ...(await this.get()), ...patch });
    this.current = next;
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
  }
}
