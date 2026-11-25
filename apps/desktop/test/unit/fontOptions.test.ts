import { describe, expect, it } from 'vitest';
import { findOption, fontGroups, fontKey, fontValue, isFontAvailable, type FontEntry } from '../../src/renderer/src/fontOptions';

const entries: FontEntry[] = [
  { family: 'Liberation Sans', style: 'Bold', source: 'bundled' },
  { family: 'Liberation Sans', style: 'Regular', source: 'bundled' },
  { family: 'Stencil', style: 'Regular', source: 'project' },
  { family: 'Arial', style: 'Bold Italic', source: 'system' },
  { family: 'Arial', style: 'Regular', source: 'system' },
  { family: 'Liberation Sans', style: 'Regular', source: 'system' },
];

describe('font dropdown (M15)', () => {
  it('fontValue writes fontconfig names, plain for the regular style', () => {
    expect(fontValue('Arial', 'Regular')).toBe('Arial');
    expect(fontValue('Arial', 'Bold Italic')).toBe('Arial:style=Bold Italic');
  });

  it('groups bundled, project and installed fonts, regular first, without duplicates', () => {
    expect(fontGroups(entries)).toEqual([
      {
        label: 'Bundled with ScadStudio',
        options: [
          { value: 'Liberation Sans', label: 'Liberation Sans' },
          { value: 'Liberation Sans:style=Bold', label: 'Liberation Sans Bold' },
        ],
      },
      { label: 'This project (use <font file>)', options: [{ value: 'Stencil', label: 'Stencil' }] },
      {
        label: 'Installed on this computer',
        options: [
          { value: 'Arial', label: 'Arial' },
          { value: 'Arial:style=Bold Italic', label: 'Arial Bold Italic' },
        ],
      },
    ]);
  });

  it('matches a hand-written font= value to its option', () => {
    const groups = fontGroups(entries);
    expect(fontKey('arial : style = Bold Italic')).toBe(fontKey('Arial:style=Bold Italic'));
    expect(findOption('Arial:style=Regular', groups)?.value).toBe('Arial');
    expect(findOption('ARIAL:style=bold italic', groups)?.value).toBe('Arial:style=Bold Italic');
    expect(findOption('Comic Sans MS', groups)).toBeNull();
  });

  it('a font is available when its family is installed, whatever the style', () => {
    expect(isFontAvailable('Arial:style=Condensed', entries)).toBe(true);
    expect(isFontAvailable('Comic Sans MS', entries)).toBe(false);
  });
});
