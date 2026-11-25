// M9: node identity across edits (PLAN.md risk 5).
//
// Scene nodes are addressed by their position in a working set (the top
// level, or the children of a drilled-into block). Positions shift whenever
// a statement is added or removed earlier in that set, and a typed edit can
// also change a node's own text. remapIndex carries a remembered position
// (a selection, or a drill-in focus level) from the previous version of a
// working set to the matching node in the new one:
//
// 1. Nodes whose text is unchanged are matched by a longest common
//    subsequence over the two text lists, which pins the parts of the set
//    the edit did not touch.
// 2. A node that is not in that match (its own text changed, or it moved)
//    is paired inside its gap between two pinned nodes, with the candidate
//    whose text is most similar (character-pair overlap; a statement typed
//    in front of it, `cube difference() {...}` halfway through typing
//    `cube(1);`, still shares nearly all its text), favoring the same kind
//    (call name) and the same offset in the gap. Failing a similar one, the
//    same offset when the gap kept its size (an edit in place that changed
//    the call, e.g. cube -> sphere).
// 3. Otherwise the node is gone, and the caller drops the selection (or
//    leaves the focus level).
//
// This is a heuristic, not a proof (duplicate identical statements are
// indistinguishable by text), which is why the app also flashes the
// still-selected node after a typed edit: if the guess was wrong, it shows.

export interface NodeFingerprint {
  // The statement's source with runs of whitespace collapsed.
  text: string;
  // Its primitive's call name ("cube", "difference", "bracket"), or the
  // statement kind ("block", "for_statement") when there is no call.
  kind: string;
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// Beyond this many cells the LCS table is skipped and only the gap pairing
// runs over the whole set (still correct for an edit that kept the size).
const MAX_LCS_CELLS = 400_000;

// Below this similarity a different-kind candidate isn't taken for the same
// node (unless the gap kept its size, see above).
const MIN_SIMILARITY = 0.35;

function bigrams(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i + 1 < text.length; i++) {
    const g = text.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice coefficient over character pairs: 1 for equal texts, 0 for nothing shared. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let shared = 0;
  for (const [g, n] of ga) shared += Math.min(n, gb.get(g) ?? 0);
  return (2 * shared) / (a.length - 1 + b.length - 1);
}

function lcsPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || n * m > MAX_LCS_CELLS) return [];
  // Common prefix/suffix first: the usual edit touches one spot.
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  const pairs: [number, number][] = [];
  for (let i = 0; i < pre; i++) pairs.push([i, i]);
  const a2 = a.slice(pre, n - suf);
  const b2 = b.slice(pre, m - suf);
  const rows = a2.length;
  const cols = b2.length;
  const table = new Uint32Array((rows + 1) * (cols + 1));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i * (cols + 1) + j] =
        a2[i] === b2[j]
          ? table[(i + 1) * (cols + 1) + j + 1] + 1
          : Math.max(table[(i + 1) * (cols + 1) + j], table[i * (cols + 1) + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a2[i] === b2[j]) {
      pairs.push([pre + i, pre + j]);
      i++;
      j++;
    } else if (table[(i + 1) * (cols + 1) + j] >= table[i * (cols + 1) + j + 1]) i++;
    else j++;
  }
  for (let k = 0; k < suf; k++) pairs.push([n - suf + k, m - suf + k]);
  return pairs;
}

/**
 * Where node `index` of `before` is in `after`, or null when it no longer
 * exists. See the file comment for the rules.
 */
export function remapIndex(before: NodeFingerprint[], after: NodeFingerprint[], index: number): number | null {
  if (index < 0 || index >= before.length) return null;
  const pairs = lcsPairs(
    before.map((f) => f.text),
    after.map((f) => f.text),
  );
  const exact = pairs.find(([i]) => i === index);
  if (exact) return exact[1];
  // The gap `index` sits in: between the last pinned pair before it and the
  // first one after it.
  let lo: [number, number] = [-1, -1];
  let hi: [number, number] = [before.length, after.length];
  for (const p of pairs) {
    if (p[0] < index) lo = p;
    else {
      hi = p;
      break;
    }
  }
  const candidates: number[] = [];
  for (let j = lo[1] + 1; j < hi[1]; j++) candidates.push(j);
  if (candidates.length === 0) return null;
  const offset = index - (lo[0] + 1);
  const { kind, text } = before[index];
  const sameOffset = lo[1] + 1 + offset;
  let best: number | null = null;
  let bestScore = -Infinity;
  for (const j of candidates) {
    const sim = similarity(text, after[j].text);
    const sameKind = after[j].kind === kind;
    if (sim < MIN_SIMILARITY && !sameKind) continue;
    const score = sim + (sameKind ? 0.25 : 0) - 0.01 * Math.abs(j - sameOffset);
    if (score > bestScore) {
      bestScore = score;
      best = j;
    }
  }
  if (best !== null) return best;
  const gapBefore = hi[0] - lo[0] - 1;
  if (gapBefore === candidates.length && sameOffset < hi[1]) return sameOffset;
  return null;
}

/** remapIndex over a whole selection, dropping nodes that are gone (order kept). */
export function remapIndices(before: NodeFingerprint[], after: NodeFingerprint[], indices: number[]): number[] {
  const out: number[] = [];
  for (const i of indices) {
    const j = remapIndex(before, after, i);
    if (j !== null && !out.includes(j)) out.push(j);
  }
  return out;
}
