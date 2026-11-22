import * as monaco from 'monaco-editor/editor/editor.api.js';

// Hand-written Monarch tokenizer for OpenSCAD syntax highlighting (M1 scope).
// This is intentionally not a full grammar — the tree-sitter-based CST from
// the M0 spike is what later milestones use for parsing/sync; this is purely
// cosmetic highlighting for the read-only M1 editor pane.
export function registerScadLanguage(): void {
  monaco.languages.register({ id: 'scad' });

  monaco.languages.setMonarchTokensProvider('scad', {
    keywords: [
      'module', 'function', 'if', 'else', 'for', 'let', 'each', 'use', 'include',
      'true', 'false', 'undef',
    ],
    builtins: [
      'cube', 'sphere', 'cylinder', 'polyhedron', 'square', 'circle', 'polygon', 'text',
      'translate', 'rotate', 'scale', 'mirror', 'color', 'multmatrix',
      'union', 'difference', 'intersection',
      'linear_extrude', 'rotate_extrude', 'echo', 'str', 'len',
    ],
    operators: ['=', '+', '-', '*', '/', '%', '<', '>', '<=', '>=', '==', '!=', '&&', '||', '!', '?', ':'],
    symbols: /[=><!~?:&|+\-*/^%]+/,
    tokenizer: {
      root: [
        // Comments first: `/` is also in @symbols below, and Monarch takes
        // the first rule that matches, so with comments last they were
        // tokenized as code (QC audit M5).
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        // A modifier (# % ! *) only ever prefixes a module call, so require
        // `name(` after it. Plain `a * b` or `x % 2` stays an operator.
        [/[#%!*](?=\s*[a-zA-Z_]\w*\s*\()/, 'annotation'],
        [/\$[a-zA-Z_]\w*/, 'variable.predefined'],
        [/[a-zA-Z_]\w*(?=\s*\()/, {
          cases: {
            '@keywords': 'keyword',
            '@builtins': 'type.identifier',
            '@default': 'identifier',
          },
        }],
        [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        [/\d+\.\d+([eE][+-]?\d+)?/, 'number.float'],
        [/\d+/, 'number'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/[{}()[\]]/, '@brackets'],
        [/[;,]/, 'delimiter'],
        [/@symbols/, { cases: { '@operators': 'operator', '@default': '' } }],
        [/\s+/, 'white'],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
    },
  });
}
