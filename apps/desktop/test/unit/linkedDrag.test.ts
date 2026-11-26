import { describe, expect, it } from 'vitest';
import { addedNames, drivenAxes, positionAnchors } from '../../src/renderer/src/linkedDrag';
import { readVariables } from '../../src/renderer/src/variables';
import { buildSceneGraph } from '../../src/renderer/src/sceneGraph';
import { decomposeNode } from '../../src/renderer/src/targetedPatch';
import { parse } from '../helpers/parse';

describe('M11 linked drag', () => {
  it('finds the names a sum adds', async () => {
    await parse('x = 1;'); // loads the grammar the sync parser uses
    expect(addedNames('cube_x')).toEqual(['cube_x']);
    expect(addedNames('cube_x + cube_width + gap')).toEqual(['cube_x', 'cube_width', 'gap']);
    expect(addedNames('a - b + (c + d)')).toEqual(['a', 'c', 'd']);
    expect(addedNames('2 * a')).toEqual([]);
  });

  it('drags an axis that moves with a position variable, and nothing else', async () => {
    const src =
      'cube_x = 0;\ncube_y = 0;\nw = 30;\nk = 2;\n\ntranslate([cube_x, cube_y, 0]) cube([w, 20, 10]);\n\ntranslate([cube_x + w + 5, cube_y + 5, k * 3]) sphere(8);\n\nmodule m(cube_x) { translate([cube_x, 0, 0]) cube(1); }\n';
    const tree = await parse(src);
    const nodes = buildSceneGraph(tree, src).nodes;
    const transforms = nodes.map((n) => decomposeNode(tree.rootNode, n)!.transform);
    const anchors = positionAnchors(readVariables(tree.rootNode), transforms);
    expect([...anchors[0].keys()]).toEqual(['cube_x']);
    expect([...anchors[1].keys()]).toEqual(['cube_y']);
    expect(anchors[2].size).toBe(0);
    const sphere = drivenAxes(tree, nodes[1], transforms[1], anchors);
    expect(sphere.map((d) => [d.axis, d.anchor.name])).toEqual([
      [0, 'cube_x'],
      [1, 'cube_y'],
    ]);
    // w is a size, not a position: an axis that is just `w` doesn't anchor.
    expect(drivenAxes(tree, nodes[0], transforms[0], anchors).map((d) => d.axis)).toEqual([0, 1]);
  });
});
