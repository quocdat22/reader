import type { NormalizedRect, SearchMatch } from "../ipc/types";

export interface PageSearchEntry {
  readonly matchIndex: number;
  readonly rects: readonly NormalizedRect[];
}

/**
 * Indexes `SearchMatch[]` by zero-based `page_index` for O(matches on page) overlay rendering.
 */
export function groupMatchesByPage(
  matches: readonly SearchMatch[],
): Map<number, PageSearchEntry[]> {
  const byPage = new Map<number, PageSearchEntry[]>();
  if (!Array.isArray(matches)) {
    return byPage;
  }

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    if (!match || !Array.isArray(match.rects) || match.rects.length === 0) {
      continue;
    }
    let list = byPage.get(match.page_index);
    if (!list) {
      list = [];
      byPage.set(match.page_index, list);
    }
    list.push({ matchIndex: i, rects: match.rects });
  }

  return byPage;
}

/**
 * Picks the first match at or after `currentPageIndex`, wrapping to index `0` if none follow.
 */
export function resolveInitialMatchIndex(
  matches: readonly SearchMatch[],
  currentPageIndex: number,
): number {
  if (!Array.isArray(matches) || matches.length === 0) {
    return -1;
  }
  const page =
    Number.isInteger(currentPageIndex) && currentPageIndex >= 0
      ? currentPageIndex
      : 0;
  const idx = matches.findIndex((match) => match.page_index >= page);
  return idx >= 0 ? idx : 0;
}

/**
 * Cycles match index by `delta` (`1` or `-1`) with wrap-around.
 */
export function stepMatchIndex(
  currentIndex: number,
  total: number,
  delta: 1 | -1,
): number {
  if (!Number.isInteger(total) || total <= 0) {
    return -1;
  }
  if (
    !Number.isInteger(currentIndex) ||
    currentIndex < 0 ||
    currentIndex >= total
  ) {
    return delta >= 0 ? 0 : total - 1;
  }
  return (currentIndex + delta + total) % total;
}
