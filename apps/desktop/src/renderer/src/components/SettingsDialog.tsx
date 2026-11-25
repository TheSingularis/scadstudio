import { useEffect, useState } from 'react';
import type { FontEntry } from '../fontOptions';

// M15: Settings > Fonts sets the code editor's font and size, like a code
// editor's own settings (decided with Jordan 2026-11-25). Fonts used in
// models are not here: they are written in the code (text(font=...)) and
// picked from the Text panel.

export interface EditorFontSettings {
  editorFontFamily: string;
  editorFontSize: number;
}

interface SettingsDialogProps {
  settings: EditorFontSettings;
  onChange: (patch: Partial<EditorFontSettings>) => void;
  onClose: () => void;
}

// Installed families, code (monospaced) fonts first.
export function editorFontChoices(entries: FontEntry[]): { monospace: string[]; other: string[] } {
  const mono = new Set<string>();
  const all = new Set<string>();
  for (const e of entries) {
    if (e.source !== 'system') continue;
    all.add(e.family);
    if (e.monospace) mono.add(e.family);
  }
  const sort = (xs: Iterable<string>) => [...xs].sort((a, b) => a.localeCompare(b));
  return { monospace: sort(mono), other: sort([...all].filter((f) => !mono.has(f))) };
}

export function SettingsDialog({ settings, onChange, onClose }: SettingsDialogProps) {
  const [fonts, setFonts] = useState<FontEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.scadstudio
      .listFonts('')
      .then((list) => !cancelled && setFonts(list))
      .catch(() => !cancelled && setFonts([]));
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const choices = editorFontChoices(fonts ?? []);
  const known = settings.editorFontFamily === '' || choices.monospace.includes(settings.editorFontFamily) || choices.other.includes(settings.editorFontFamily);
  const row = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 } as const;

  return (
    <div
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 80, zIndex: 50 }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        style={{ background: '#252526', color: '#ddd', border: '1px solid #444', borderRadius: 6, padding: '14px 18px', minWidth: 360, fontSize: 13 }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <strong style={{ fontSize: 15 }}>Settings</strong>
          <button style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Close settings">
            Close
          </button>
        </div>
        <div style={{ marginTop: 12, opacity: 0.7, textTransform: 'uppercase', fontSize: 11, letterSpacing: 0.5 }}>Fonts</div>
        <label style={row}>
          <span style={{ width: 110 }}>Editor font</span>
          <select
            aria-label="Editor font"
            value={settings.editorFontFamily}
            disabled={fonts === null}
            style={{ flex: 1, maxWidth: 240 }}
            onChange={(e) => onChange({ editorFontFamily: e.target.value })}
          >
            <option value="">Default</option>
            {!known && <option value={settings.editorFontFamily}>{settings.editorFontFamily} (not installed)</option>}
            {choices.monospace.length > 0 && (
              <optgroup label="Code fonts (monospaced)">
                {choices.monospace.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </optgroup>
            )}
            {choices.other.length > 0 && (
              <optgroup label="Other installed fonts">
                {choices.other.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <label style={row}>
          <span style={{ width: 110 }}>Editor font size</span>
          <input
            aria-label="Editor font size"
            type="number"
            min={8}
            max={40}
            step={1}
            value={settings.editorFontSize}
            style={{ width: 64 }}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 8 && n <= 40) onChange({ editorFontSize: n });
            }}
          />
        </label>
        <div style={{ marginTop: 10, fontFamily: settings.editorFontFamily ? `"${settings.editorFontFamily}", monospace` : 'monospace', fontSize: settings.editorFontSize, background: '#1e1e1e', padding: '6px 8px', borderRadius: 4 }}>
          translate([0, 0, 1]) cube(10);
        </div>
        <div style={{ marginTop: 10, opacity: 0.6, fontSize: 12, maxWidth: 380 }}>
          Fonts used in models are set in the code with text(font="..."); pick them from the Text tool's panel.
        </div>
      </div>
    </div>
  );
}
