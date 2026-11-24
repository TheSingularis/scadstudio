// M8: the shared ToolDefinition insertion path (built-in and custom).
import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOL_DEFINITIONS, addUseDirective, builtinTool, hasUseDirective, insertTool, type ToolDefinition } from '../../src/renderer/src/tools';
import { appendPrimitive } from '../../src/renderer/src/primitives';
import { expectCleanParse } from '../helpers/parse';

const custom = (useDirective: string | null): ToolDefinition => ({
  id: 'custom:peg',
  section: 'custom',
  label: 'peg',
  callName: 'peg',
  params: [],
  statement: 'peg(d = 3);',
  useDirective,
  origin: { file: '/l/peg.scad', line: 1 },
  description: null,
});

describe('M8 tools', () => {
  it('built-in tools insert exactly what M5 appended', () => {
    for (const tool of BUILTIN_TOOL_DEFINITIONS) {
      expect(insertTool('cube(1);\n', tool)).toBe(appendPrimitive('cube(1);\n', tool.callName as never));
    }
    expect(builtinTool('sphere').statement).toBe('sphere(r=5);');
  });

  it('a custom tool already in scope just appends its call', () => {
    expect(insertTool('use <parts.scad>\ncube(1);\n', custom(null))).toBe('use <parts.scad>\ncube(1);\n\npeg(d = 3);\n');
  });

  it('a custom tool behind a nested use adds the use directive once, after existing directives', async () => {
    const once = insertTool('// header\nuse <parts.scad>\ninclude <sizes.scad>\n\ncube(1);\n', custom('lib/peg.scad'));
    expect(once).toBe('// header\nuse <parts.scad>\ninclude <sizes.scad>\nuse <lib/peg.scad>\n\ncube(1);\n\npeg(d = 3);\n');
    expect(insertTool(once, custom('lib/peg.scad'))).toBe(`${once}\npeg(d = 3);\n`);
    await expectCleanParse(once);
  });

  it('a document with no directives gets the use at the top', () => {
    expect(addUseDirective('cube(1);\n', 'peg.scad')).toBe('use <peg.scad>\n\ncube(1);\n');
    expect(hasUseDirective('use < lib\\peg.scad >\n', 'lib/peg.scad')).toBe(true);
  });
});
