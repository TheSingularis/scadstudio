// M8: parameter panel fields (real names instead of #1/#2/#3, widgets).
import { describe, expect, it } from 'vitest';
import { nodeAt } from '../helpers/parse';
import { addNamedArgument, primitiveArgs } from '../../src/renderer/src/targetedPatch';
import { buildCustomTools } from '../../src/renderer/src/moduleIntrospection';
import { effectiveWidget, panelFields, parseVec3, quoteScadString, unquoteScadString } from '../../src/renderer/src/paramPanel';
import { BUILTIN_SIGNATURES } from '../../src/renderer/src/tools';

const BRACKET = 'module bracket(w=20, h=10, thickness=3, holes=true) { cube([w, h, thickness]); }\n';

async function fieldsFor(source: string, index = 0) {
  const { tree, node } = await nodeAt(source, index);
  const call = primitiveArgs(tree.rootNode, node)!;
  const custom = buildCustomTools([{ path: null, tree, useDirective: null }]).find((t) => t.callName === call.callName);
  return panelFields(call, custom?.params ?? BUILTIN_SIGNATURES[call.callName] ?? [], !!custom);
}

describe('M8 parameter panel', () => {
  it('names positional arguments of a custom module and lists the unset ones', async () => {
    const fields = await fieldsFor(`${BRACKET}bracket(30, 15, thickness=4);\n`);
    expect(fields.map((f) => [f.label, f.argIndex, f.valueText, f.widget])).toEqual([
      ['w', 0, '30', 'number'],
      ['h', 1, '15', 'number'],
      ['thickness', 2, '4', 'number'],
      ['holes', null, null, 'checkbox'],
    ]);
  });

  it('names positional arguments of built-ins too', async () => {
    expect((await fieldsFor('cube([1, 2, 3], true);\n')).map((f) => [f.label, f.widget])).toEqual([
      ['size', 'xyz'],
      ['center', 'checkbox'],
    ]);
    expect((await fieldsFor('translate([1, 0, 0]) cylinder(10, 2, 5);\n')).map((f) => f.label)).toEqual(['h', 'r1', 'r2']);
  });

  it('falls back to #n for positional arguments past a known signature', async () => {
    expect((await fieldsFor('mystery(1, 2);\n')).map((f) => f.label)).toEqual(['#1', '#2']);
  });

  it('an expression in a number parameter gets a plain field', () => {
    const p = { name: 'w', defaultText: '1', widget: 'number' as const, required: false, exampleText: null };
    expect(effectiveWidget(p, 'w * 2')).toBe('generic');
    expect(effectiveWidget(p, '-3')).toBe('number');
  });

  it('addNamedArgument appends a parameter the call leaves out', async () => {
    const src = `${BRACKET}bracket(30, 15);\n`;
    const { tree, node } = await nodeAt(src);
    expect(addNamedArgument(src, tree, node, 'holes', 'false')).toBe(`${BRACKET}bracket(30, 15, holes = false);\n`);
    const empty = `${BRACKET}bracket();\n`;
    const parsed = await nodeAt(empty);
    expect(addNamedArgument(empty, parsed.tree, parsed.node, 'w', '5')).toBe(`${BRACKET}bracket(w = 5);\n`);
  });

  it('string and vector helpers round-trip', () => {
    for (const s of ['plain', 'with "quotes"', 'back\\slash', 'two\nlines']) expect(unquoteScadString(quoteScadString(s))).toBe(s);
    expect(parseVec3('[1, -2.5 , 3]')).toEqual(['1', '-2.5', '3']);
    expect(parseVec3('[1, 2]')).toBeNull();
  });
});

describe('M15 text() panel', () => {
  it('names text/size/font positionally and lists font, alignment and spacing with defaults', async () => {
    const { tree, node } = await nodeAt('text("Hi", 12, "Liberation Serif");\n', 0);
    const fields = panelFields(primitiveArgs(tree.rootNode, node)!, BUILTIN_SIGNATURES.text, true);
    expect(fields.map((f) => [f.label, f.valueText, f.widget])).toEqual([
      ['text', '"Hi"', 'text'],
      ['size', '12', 'number'],
      ['font', '"Liberation Serif"', 'font'],
      ['halign', null, 'choice'],
      ['valign', null, 'choice'],
      ['spacing', null, 'number'],
    ]);
    expect(fields.find((f) => f.label === 'valign')?.param?.choices).toEqual(['top', 'center', 'baseline', 'bottom']);
  });

  it('a 4th positional argument is not named halign (OpenSCAD ignores it)', async () => {
    const { tree, node } = await nodeAt('text("Hi", 12, "Arial", "center");\n', 0);
    const fields = panelFields(primitiveArgs(tree.rootNode, node)!, BUILTIN_SIGNATURES.text, false);
    expect(fields[3].label).toBe('#4');
  });

  it('a font given as an expression falls back to a plain field', () => {
    expect(effectiveWidget(BUILTIN_SIGNATURES.text[2], 'myFont')).toBe('generic');
    expect(effectiveWidget(BUILTIN_SIGNATURES.text[2], '"Arial:style=Bold"')).toBe('font');
  });
});
