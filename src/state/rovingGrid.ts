import { useCallback, useEffect, useRef } from 'react';

/**
 * Roving-tabindex grid keyboard navigation.
 *
 * The catalog renders ~320 ModuleCards spread across several CSS-grid blocks
 * (sections/groups/subgroups) plus a flat search-results grid. For keyboard
 * users we expose ONE roving scope over the whole visible catalog: exactly one
 * card is tabbable (tabIndex 0) at a time, and Arrow/Home/End move focus among
 * cards using DOM order. Enter/Space are left to native <button> behavior.
 *
 * The column count is NOT hardcoded: it is measured at keydown time from the
 * actual on-screen geometry (see `columnsFromGeometry`), so it stays correct
 * across grid vs. list viewMode, density changes, and responsive reflow.
 */

export type GridKey =
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End';

const NAV_KEYS = new Set<string>([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
]);

export function isGridKey(key: string): key is GridKey {
  return NAV_KEYS.has(key);
}

/**
 * Pure index math for roving-grid navigation.
 *
 * Layout model: `count` items flow left-to-right, top-to-bottom into rows of
 * `cols` columns (the last row may be partial). Given the currently focused
 * `current` index and a navigation `key`, returns the next index to focus.
 *
 * Policy:
 *  - Left/Right move by one within the flat order and CLAMP at index 0 /
 *    count-1 (no wrapping between rows — pressing Right at a row end does not
 *    jump to the next row; it stays put). This matches the WAI-ARIA grid
 *    pattern's "arrow stays in axis" expectation and avoids surprising jumps.
 *  - Up/Down move by `cols`. Down from the last full column into a missing
 *    slot of a partial last row CLAMPS to the last item instead of overshooting
 *    past `count`. Up/Down at the top/bottom edge clamp (stay put).
 *  - Home/End go to the start/end of the CURRENT row (row-relative), matching
 *    typical grid semantics. Ctrl is not modeled here; callers that want
 *    document-start/end can handle it separately.
 *
 * All inputs are treated defensively: `cols` < 1 is coerced to 1, and the
 * result is always clamped into [0, count-1]. If count is 0, returns 0.
 */
export function nextIndex(
  current: number,
  key: GridKey,
  cols: number,
  count: number,
): number {
  if (count <= 0) return 0;
  const c = Math.max(1, Math.floor(cols));
  const cur = clamp(current, 0, count - 1);
  const row = Math.floor(cur / c);
  const col = cur % c;

  switch (key) {
    case 'ArrowLeft':
      return cur > 0 ? cur - 1 : cur;
    case 'ArrowRight':
      return cur < count - 1 ? cur + 1 : cur;
    case 'ArrowUp': {
      if (row === 0) return cur;
      return cur - c;
    }
    case 'ArrowDown': {
      const target = cur + c;
      // Same column, next row. If that row is missing this column
      // (partial last row), clamp to the last existing item.
      if (target < count) return target;
      return count - 1;
    }
    case 'Home':
      // Start of current row.
      return row * c;
    case 'End': {
      // End of current row, clamped to the last existing item.
      const end = row * c + (c - 1);
      return Math.min(end, count - 1);
    }
    default:
      // Exhaustive; keep col referenced for clarity/no-unused rules.
      return col >= 0 ? cur : cur;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Derive the number of columns from the measured geometry of the card
 * elements. We count how many cards share the topmost row's `offsetTop`
 * (within a tolerance to absorb sub-pixel/rounding). This is robust to any
 * grid template, gap, or density and to list mode (which yields 1).
 *
 * Exported so it is unit-testable with synthetic {offsetTop} rows.
 */
export function columnsFromGeometry(
  tops: readonly number[],
  tolerance = 4,
): number {
  const first = tops[0];
  if (first === undefined) return 1;
  let cols = 0;
  for (const top of tops) {
    if (Math.abs(top - first) <= tolerance) cols += 1;
    else break;
  }
  return Math.max(1, cols);
}

const CARD_SELECTOR = '.card';

/**
 * Hook: attaches roving-tabindex + arrow-key navigation to a container whose
 * descendants include `.card` buttons (any nesting depth). One card is
 * tabbable at a time; the rest get tabIndex -1. Re-runs its bookkeeping when
 * the card set changes (search/filter/viewMode) via a MutationObserver so the
 * tabbable card is always valid.
 *
 * Returns an `onKeyDown` handler to spread onto the container. The container
 * should be a real element (e.g. a wrapper div around all the grids).
 */
export function useRovingGrid(containerRef: React.RefObject<HTMLElement>) {
  // Index of the card that currently holds tabIndex 0. Kept in a ref so
  // handlers stay stable and we don't re-render on focus moves.
  const activeRef = useRef(0);

  const cards = useCallback((): HTMLElement[] => {
    const root = containerRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR));
  }, [containerRef]);

  // Ensure exactly one card is tabbable (index `active`, clamped).
  const syncTabIndex = useCallback(
    (active: number) => {
      const list = cards();
      if (list.length === 0) return;
      const a = active < 0 ? 0 : active >= list.length ? list.length - 1 : active;
      activeRef.current = a;
      for (let i = 0; i < list.length; i += 1) {
        const el = list[i];
        if (el) el.tabIndex = i === a ? 0 : -1;
      }
    },
    [cards],
  );

  const measureCols = useCallback((): number => {
    const list = cards();
    return columnsFromGeometry(list.map((el) => el.offsetTop));
  }, [cards]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const key = e.key;
      if (!isGridKey(key)) return;
      const list = cards();
      if (list.length === 0) return;

      // Anchor navigation on the currently focused card if focus is inside
      // the grid; otherwise fall back to the active/tabbable one.
      const focused = document.activeElement as HTMLElement | null;
      let current = focused ? list.indexOf(focused) : -1;
      if (current < 0) current = activeRef.current;

      const cols = measureCols();
      const next = nextIndex(current, key, cols, list.length);
      if (next === current) {
        // Still consume the key so the scroll container doesn't scroll.
        e.preventDefault();
        return;
      }
      e.preventDefault();
      syncTabIndex(next);
      list[next]?.focus();
    },
    [cards, measureCols, syncTabIndex],
  );

  // Keep the roving set valid as cards mount/unmount (search, filter,
  // viewMode). If the previously-active card vanished, clamp; if focus was on
  // a removed card, we simply leave the new active card tabbable.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    syncTabIndex(activeRef.current);

    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => syncTabIndex(activeRef.current));
    };
    const mo = new MutationObserver(schedule);
    mo.observe(root, { childList: true, subtree: true });

    // When focus lands on a card via mouse/Tab, adopt it as the active one so
    // subsequent arrow keys start from there and tabIndex stays consistent.
    const onFocusIn = (ev: FocusEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      const list = cards();
      const idx = list.indexOf(target.closest(CARD_SELECTOR) as HTMLElement);
      if (idx >= 0 && idx !== activeRef.current) syncTabIndex(idx);
    };
    root.addEventListener('focusin', onFocusIn);

    return () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
      root.removeEventListener('focusin', onFocusIn);
    };
  }, [containerRef, cards, syncTabIndex]);

  return { onKeyDown };
}
