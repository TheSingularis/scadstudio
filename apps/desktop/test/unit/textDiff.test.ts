// The Editor applies each visual edit as one executeEdits() range (audit
// H3) computed here, so the undo step and cursor stay local to the change.
import { describe, expect, it } from 'vitest';
import { audit } from '../helpers/audit';
import { minimalReplacement } from '../../src/renderer/src/textDiff';

function apply(before: string, after: string): string {
  const { start, end, text } = minimalReplacement(before, after);
  return before.slice(0, start) + text + before.slice(end);
}

describe('minimalReplacement (audit H3)', () => {
  const cases: [string, string, string][] = [
    ['gizmo patch', 'a;\ntranslate([1,0,0]) cube(1);\nb;', 'a;\ntranslate([4, 0, 0]) cube(1);\nb;'],
    ['append', 'cube(1);\n', 'cube(1);\nsphere(2);\n'],
    ['delete', 'cube(1);\nsphere(2);\n', 'cube(1);\n'],
    ['identical', 'x', 'x'],
    ['from empty', '', 'cube(1);'],
    ['to empty', 'cube(1);', ''],
    ['repeated chars', 'aaaa', 'aaaaaa'],
  ];
  it.each(cases)(audit('H3', '%s round-trips'), (_label, before, after) => {
    expect(apply(before, after)).toBe(after);
  });

  it('touches only the changed span', () => {
    expect(minimalReplacement('translate([1,0,0]) cube(1);', 'translate([4,0,0]) cube(1);')).toEqual({ start: 11, end: 12, text: '4' });
  });
});
