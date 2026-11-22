import { describe, expect, it } from 'vitest';
import { insertIntoNearestEdge, type SketchPoint } from '../../src/renderer/src/sketchEditing';

const square: SketchPoint[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

describe('insertIntoNearestEdge (M7.5 on-plane editing)', () => {
  it('inserts into the edge nearest the click', () => {
    expect(insertIntoNearestEdge(square, [5, -1])).toEqual([[0, 0], [5, -1], [10, 0], [10, 10], [0, 10]]);
    expect(insertIntoNearestEdge(square, [11, 5])).toEqual([[0, 0], [10, 0], [11, 5], [10, 10], [0, 10]]);
  });

  it('can insert into the closing edge (last → first)', () => {
    expect(insertIntoNearestEdge(square, [-1, 5])).toEqual([[0, 0], [10, 0], [10, 10], [0, 10], [-1, 5]]);
  });

  it('appends when there is no edge yet', () => {
    expect(insertIntoNearestEdge([[1, 1]], [2, 2])).toEqual([[1, 1], [2, 2]]);
    expect(insertIntoNearestEdge([], [2, 2])).toEqual([[2, 2]]);
  });

  it('does not mutate its input', () => {
    const copy = square.map((p) => [...p]);
    insertIntoNearestEdge(square, [5, 5]);
    expect(square).toEqual(copy);
  });
});
