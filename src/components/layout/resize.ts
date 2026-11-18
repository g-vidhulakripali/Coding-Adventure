/**
 * Pure resize math for adjacent panels. Kept free of DOM access so it can be
 * unit-tested.
 */

export interface PairState {
  /** Rendered widths in px at drag start. */
  readonly widthA: number;
  readonly widthB: number;
  /** Flex weights at drag start. */
  readonly weightA: number;
  readonly weightB: number;
  readonly minA: number;
  readonly minB: number;
}

/**
 * Moves the boundary between panel A and panel B by `deltaPx` (positive =
 * towards B) and returns new flex weights. The pair's combined width and
 * combined weight are conserved, so other panels are unaffected.
 */
export function resizePair(state: PairState, deltaPx: number): { weightA: number; weightB: number } {
  const totalWidth = state.widthA + state.widthB;
  const totalWeight = state.weightA + state.weightB;
  if (totalWidth <= 0 || totalWeight <= 0) return { weightA: state.weightA, weightB: state.weightB };

  const maxA = totalWidth - Math.min(state.minB, totalWidth / 2);
  const minA = Math.min(state.minA, totalWidth / 2);
  const nextWidthA = Math.min(maxA, Math.max(minA, state.widthA + deltaPx));
  const weightA = (totalWeight * nextWidthA) / totalWidth;
  return { weightA, weightB: totalWeight - weightA };
}
