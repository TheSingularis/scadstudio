// M15: the Text panel's font dropdown. Fonts for models are written in the
// code as text(font="Family:style=Style") (fontconfig's syntax, which
// OpenSCAD uses); this turns the main process's font list into dropdown
// groups and maps a font= value back to its entry.

export interface FontEntry {
  family: string;
  style: string;
  monospace?: boolean;
  source: 'bundled' | 'project' | 'system';
}

export interface FontOption {
  // The font= string: "Family" for the regular style, else "Family:style=Style".
  value: string;
  label: string;
}

export interface FontGroup {
  label: string;
  options: FontOption[];
}

const REGULAR = new Set(['regular', 'normal', 'book', 'roman']);

export function fontValue(family: string, style: string): string {
  return REGULAR.has(style.trim().toLowerCase()) ? family : `${family}:style=${style}`;
}

const GROUP_LABELS: Record<FontEntry['source'], string> = {
  bundled: 'Bundled with ScadStudio',
  project: 'This project (use <font file>)',
  system: 'Installed on this computer',
};

// Grouped by source, each family's regular style first, sorted by name
// within a group; a font in more than one group is listed in the first.
export function fontGroups(entries: FontEntry[]): FontGroup[] {
  const seen = new Set<string>();
  const groups: FontGroup[] = [];
  for (const source of ['bundled', 'project', 'system'] as const) {
    const options: FontOption[] = [];
    const inGroup = entries.filter((e) => e.source === source);
    inGroup.sort((a, b) => a.family.localeCompare(b.family) || Number(!REGULAR.has(a.style.toLowerCase())) - Number(!REGULAR.has(b.style.toLowerCase())) || a.style.localeCompare(b.style));
    for (const e of inGroup) {
      const value = fontValue(e.family, e.style);
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ value, label: REGULAR.has(e.style.toLowerCase()) ? e.family : `${e.family} ${e.style}` });
    }
    if (options.length > 0) groups.push({ label: GROUP_LABELS[source], options });
  }
  return groups;
}

// Normalizes a font= value for comparison: case, spacing around ':' and
// '=', and a spelled-out regular style don't matter.
export function fontKey(value: string): string {
  const [family, ...rest] = value.split(':');
  const props = rest.join(':').trim();
  const style = /^style\s*=\s*(.*)$/i.exec(props)?.[1]?.trim() ?? '';
  return fontValue(family.trim(), style || 'Regular').toLowerCase().replace(/\s+/g, ' ');
}

// Whether a font= value names a family this computer can render. Only the
// family is checked: an unknown style still renders, in the family's
// closest style.
export function isFontAvailable(value: string, entries: FontEntry[]): boolean {
  const family = value.split(':')[0].trim().toLowerCase();
  return entries.some((e) => e.family.toLowerCase() === family);
}

export function findOption(value: string, groups: FontGroup[]): FontOption | null {
  const key = fontKey(value);
  for (const g of groups) for (const o of g.options) if (fontKey(o.value) === key) return o;
  return null;
}
