import { describe, expect, it } from 'vitest';
import { insertIntoNearestEdge, type SketchPoint, type SketchState } from '../../src/renderer/src/sketchEditing';

const square: SketchPoint[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

const one = (points: SketchPoint[]): SketchState => ({ profiles: [points], open: [] });

describe('insertIntoNearestEdge (M7.5 on-plane editing)', () => {
  it('inserts into the edge nearest the click', () => {
    expect(insertIntoNearestEdge(one(square), [5, -1])?.profiles).toEqual([[[0, 0], [5, -1], [10, 0], [10, 10], [0, 10]]]);
    expect(insertIntoNearestEdge(one(square), [11, 5])?.profiles).toEqual([[[0, 0], [10, 0], [11, 5], [10, 10], [0, 10]]]);
  });

  it('can insert into the closing edge (last → first)', () => {
    expect(insertIntoNearestEdge(one(square), [-1, 5])?.profiles).toEqual([[[0, 0], [10, 0], [10, 10], [0, 10], [-1, 5]]]);
  });

  it('picks the nearest edge across several loops and leaves the others alone', () => {
    const hole: SketchPoint[] = [
      [3, 3],
      [7, 3],
      [7, 7],
      [3, 7],
    ];
    const out = insertIntoNearestEdge({ profiles: [square, hole], open: [] }, [5, 3.5]);
    expect(out?.profiles).toEqual([square, [[3, 3], [5, 3.5], [7, 3], [7, 7], [3, 7]]]);
  });

  it('returns null when there is no closed loop to insert into', () => {
    expect(insertIntoNearestEdge({ profiles: [], open: [[1, 1]] }, [2, 2])).toBeNull();
  });

  it('does not mutate its input', () => {
    const copy = square.map((p) => [...p]);
    insertIntoNearestEdge(one(square), [5, 5]);
    expect(square).toEqual(copy);
  });
});
