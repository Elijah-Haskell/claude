/** Shortest useful study session. A whole task smaller than this keeps its own size. */
export const MIN_SESSION_MINUTES = 25;

const GRID = 5;

/**
 * Split `totalMinutes` of work into deterministic sessions.
 *
 *  - Sessions are as even as possible and at most ~`targetMinutes` long.
 *  - No stub sessions: if a split would produce a session shorter than
 *    `minMinutes`, fewer sessions are used instead (the remainder is merged
 *    into the others). Only a task that is itself smaller than the minimum
 *    yields a shorter (single) session.
 *  - The chunks always add up to exactly `totalMinutes`.
 *  - Sizes land on a 5-minute grid where the total allows it.
 */
export function planSessionChunks(
  totalMinutes: number,
  targetMinutes: number,
  minMinutes: number = MIN_SESSION_MINUTES,
): number[] {
  const total = Math.max(0, Math.round(totalMinutes));
  if (total === 0) return [];
  const target = Math.max(minMinutes, Math.round(targetMinutes));
  if (total <= target) return [total];

  let count = Math.ceil(total / target);
  while (count > 1 && Math.floor(total / count) < minMinutes) count -= 1;
  if (count <= 1) return [total];

  const base = Math.floor(total / count / GRID) * GRID;
  const chunks = new Array<number>(count).fill(base);
  let remainder = total - base * count;
  for (let i = 0; remainder > 0; i = (i + 1) % count) {
    const add = Math.min(GRID, remainder);
    chunks[i] += add;
    remainder -= add;
  }
  return chunks;
}
