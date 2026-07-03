import { describe, it, expect } from 'vitest';
import { nextIndex, columnsFromGeometry, isGridKey } from './rovingGrid';

// Layout reference used throughout: 10 items, 3 columns =>
//   row0: 0 1 2
//   row1: 3 4 5
//   row2: 6 7 8
//   row3: 9        (partial last row, single item)

describe('nextIndex — horizontal (clamp, no row-wrap)', () => {
  it('ArrowRight advances by one within a row', () => {
    expect(nextIndex(0, 'ArrowRight', 3, 10)).toBe(1);
    expect(nextIndex(1, 'ArrowRight', 3, 10)).toBe(2);
  });

  it('ArrowRight at the very last item clamps (stays put)', () => {
    expect(nextIndex(9, 'ArrowRight', 3, 10)).toBe(9);
  });

  it('ArrowRight at a row end moves into next row in flat order', () => {
    // Policy note: horizontal move is flat +/-1 and does NOT stop at row
    // boundaries — index 2 (row end) -> 3 (next row start). This is the
    // documented behavior; it only clamps at the array edges.
    expect(nextIndex(2, 'ArrowRight', 3, 10)).toBe(3);
  });

  it('ArrowLeft decrements and clamps at 0', () => {
    expect(nextIndex(5, 'ArrowLeft', 3, 10)).toBe(4);
    expect(nextIndex(0, 'ArrowLeft', 3, 10)).toBe(0);
  });
});

describe('nextIndex — vertical (move by cols, clamp at edges)', () => {
  it('ArrowDown moves down one row (same column)', () => {
    expect(nextIndex(1, 'ArrowDown', 3, 10)).toBe(4);
    expect(nextIndex(4, 'ArrowDown', 3, 10)).toBe(7);
  });

  it('ArrowUp moves up one row (same column)', () => {
    expect(nextIndex(7, 'ArrowUp', 3, 10)).toBe(4);
    expect(nextIndex(4, 'ArrowUp', 3, 10)).toBe(1);
  });

  it('ArrowUp on the top row clamps (stays put)', () => {
    expect(nextIndex(0, 'ArrowUp', 3, 10)).toBe(0);
    expect(nextIndex(2, 'ArrowUp', 3, 10)).toBe(2);
  });

  it('ArrowDown into a missing partial-row slot clamps to last item', () => {
    // col 1 (index 7) down would be index 10 which does not exist -> last (9)
    expect(nextIndex(7, 'ArrowDown', 3, 10)).toBe(9);
    // col 2 (index 8) down would be 11 -> last (9)
    expect(nextIndex(8, 'ArrowDown', 3, 10)).toBe(9);
  });

  it('ArrowDown into an existing partial-row slot lands exactly', () => {
    // col 0 (index 6) down -> index 9 which exists
    expect(nextIndex(6, 'ArrowDown', 3, 10)).toBe(9);
  });

  it('ArrowDown on the last row clamps (stays put)', () => {
    expect(nextIndex(9, 'ArrowDown', 3, 10)).toBe(9);
  });
});

describe('nextIndex — Home/End (row-relative)', () => {
  it('Home goes to start of current row', () => {
    expect(nextIndex(5, 'Home', 3, 10)).toBe(3);
    expect(nextIndex(4, 'Home', 3, 10)).toBe(3);
    expect(nextIndex(2, 'Home', 3, 10)).toBe(0);
  });

  it('End goes to end of current row', () => {
    expect(nextIndex(3, 'End', 3, 10)).toBe(5);
    expect(nextIndex(0, 'End', 3, 10)).toBe(2);
  });

  it('End on a partial last row clamps to the last item', () => {
    // row3 has only index 9; End should not overshoot to 11
    expect(nextIndex(9, 'End', 3, 10)).toBe(9);
  });

  it('Home on a partial last row goes to that row start (the item itself)', () => {
    expect(nextIndex(9, 'Home', 3, 10)).toBe(9);
  });
});

describe('nextIndex — single-column (list mode)', () => {
  it('ArrowDown/ArrowUp step by one', () => {
    expect(nextIndex(0, 'ArrowDown', 1, 5)).toBe(1);
    expect(nextIndex(4, 'ArrowDown', 1, 5)).toBe(4); // clamp at bottom
    expect(nextIndex(2, 'ArrowUp', 1, 5)).toBe(1);
    expect(nextIndex(0, 'ArrowUp', 1, 5)).toBe(0); // clamp at top
  });

  it('ArrowLeft/ArrowRight also step (flat order) and clamp', () => {
    expect(nextIndex(0, 'ArrowRight', 1, 5)).toBe(1);
    expect(nextIndex(4, 'ArrowRight', 1, 5)).toBe(4);
    expect(nextIndex(0, 'ArrowLeft', 1, 5)).toBe(0);
  });

  it('Home/End collapse to the single item in each row', () => {
    expect(nextIndex(3, 'Home', 1, 5)).toBe(3);
    expect(nextIndex(3, 'End', 1, 5)).toBe(3);
  });
});

describe('nextIndex — defensive inputs', () => {
  it('count 0 returns 0 for any key', () => {
    expect(nextIndex(0, 'ArrowDown', 3, 0)).toBe(0);
    expect(nextIndex(5, 'End', 3, 0)).toBe(0);
  });

  it('cols < 1 is coerced to 1', () => {
    expect(nextIndex(0, 'ArrowDown', 0, 5)).toBe(1);
    expect(nextIndex(0, 'ArrowDown', -3, 5)).toBe(1);
  });

  it('out-of-range current is clamped before computing', () => {
    expect(nextIndex(99, 'ArrowLeft', 3, 10)).toBe(8); // treated as 9 -> left
    expect(nextIndex(-5, 'ArrowRight', 3, 10)).toBe(1); // treated as 0 -> right
  });

  it('single item count 1 clamps everywhere', () => {
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'] as const) {
      expect(nextIndex(0, k, 3, 1)).toBe(0);
    }
  });

  it('exactly-full grid (no partial row) navigates cleanly', () => {
    // 9 items, 3 cols -> 3 full rows
    expect(nextIndex(2, 'ArrowDown', 3, 9)).toBe(5);
    expect(nextIndex(5, 'ArrowDown', 3, 9)).toBe(8);
    expect(nextIndex(8, 'ArrowDown', 3, 9)).toBe(8); // clamp
    expect(nextIndex(8, 'End', 3, 9)).toBe(8);
  });
});

describe('columnsFromGeometry', () => {
  it('counts items sharing the top row', () => {
    // 3 columns: first three share offsetTop 0, then rows at 100, 200
    const tops = [0, 0, 0, 100, 100, 100, 200];
    expect(columnsFromGeometry(tops)).toBe(3);
  });

  it('absorbs sub-pixel jitter within tolerance', () => {
    const tops = [0, 1, 2, 3, 100, 101]; // 4 in first row within tol 4
    expect(columnsFromGeometry(tops, 4)).toBe(4);
  });

  it('list mode (one per row) yields 1', () => {
    const tops = [0, 40, 80, 120];
    expect(columnsFromGeometry(tops)).toBe(1);
  });

  it('empty yields 1', () => {
    expect(columnsFromGeometry([])).toBe(1);
  });

  it('single item yields 1', () => {
    expect(columnsFromGeometry([0])).toBe(1);
  });

  it('tolerance boundary is inclusive', () => {
    // diff exactly == tolerance counts as same row
    expect(columnsFromGeometry([0, 4, 100], 4)).toBe(2);
    // diff just over tolerance breaks the row
    expect(columnsFromGeometry([0, 5, 100], 4)).toBe(1);
  });
});

describe('isGridKey', () => {
  it('recognizes navigation keys', () => {
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      expect(isGridKey(k)).toBe(true);
    }
  });

  it('rejects other keys', () => {
    for (const k of ['Enter', ' ', 'Tab', 'a', 'PageDown', 'Escape']) {
      expect(isGridKey(k)).toBe(false);
    }
  });
});
