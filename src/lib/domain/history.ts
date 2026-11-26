import type { ScrollAnchor } from "../state/types";

export const MAX_NAV_HISTORY = 50;
const SAME_SPOT_RATIO_EPSILON = 0.02;

export interface NavLocation {
  readonly pageIndex: number;
  readonly scrollAnchor: ScrollAnchor | null;
}

export interface HistoryStepResult {
  readonly nextBackStack: NavLocation[];
  readonly nextForwardStack: NavLocation[];
  readonly destination: NavLocation | null;
}

function isSameNavSpot(
  origin: NavLocation,
  targetPageIndex: number,
  targetYRatio: number | null,
): boolean {
  if (origin.pageIndex !== targetPageIndex) {
    return false;
  }
  const originRatio =
    origin.scrollAnchor && origin.scrollAnchor.pageIndex === origin.pageIndex
      ? origin.scrollAnchor.topOffsetRatio
      : 0;
  const normalizedTargetRatio = targetYRatio ?? 0;
  return (
    Math.abs(originRatio - normalizedTargetRatio) <= SAME_SPOT_RATIO_EPSILON
  );
}

/**
 * Records an origin location onto the per-tab Back history stack (capping at
 * {@link MAX_NAV_HISTORY}) and clears Forward history when jumping to a distinct spot.
 */
export function pushHistoryEntry(
  backStack: readonly NavLocation[],
  forwardStack: readonly NavLocation[],
  origin: NavLocation,
  targetPageIndex: number,
  targetYRatio: number | null = null,
): {
  readonly nextBackStack: NavLocation[];
  readonly nextForwardStack: NavLocation[];
} {
  if (isSameNavSpot(origin, targetPageIndex, targetYRatio)) {
    return {
      nextBackStack: [...backStack],
      nextForwardStack: [...forwardStack],
    };
  }

  const nextBack = [...backStack, origin];
  if (nextBack.length > MAX_NAV_HISTORY) {
    nextBack.splice(0, nextBack.length - MAX_NAV_HISTORY);
  }
  return {
    nextBackStack: nextBack,
    nextForwardStack: [],
  };
}

/**
 * Pops the previous location from `backStack` and pushes `current` onto `forwardStack`.
 */
export function stepBackHistory(
  backStack: readonly NavLocation[],
  forwardStack: readonly NavLocation[],
  current: NavLocation,
): HistoryStepResult {
  if (backStack.length === 0) {
    return {
      nextBackStack: [...backStack],
      nextForwardStack: [...forwardStack],
      destination: null,
    };
  }

  const nextBack = backStack.slice(0, -1);
  const destination = backStack[backStack.length - 1] ?? null;
  const nextForward = [...forwardStack, current];
  if (nextForward.length > MAX_NAV_HISTORY) {
    nextForward.splice(0, nextForward.length - MAX_NAV_HISTORY);
  }

  return {
    nextBackStack: nextBack,
    nextForwardStack: nextForward,
    destination,
  };
}

/**
 * Pops the next location from `forwardStack` and pushes `current` onto `backStack`.
 */
export function stepForwardHistory(
  backStack: readonly NavLocation[],
  forwardStack: readonly NavLocation[],
  current: NavLocation,
): HistoryStepResult {
  if (forwardStack.length === 0) {
    return {
      nextBackStack: [...backStack],
      nextForwardStack: [...forwardStack],
      destination: null,
    };
  }

  const nextForward = forwardStack.slice(0, -1);
  const destination = forwardStack[forwardStack.length - 1] ?? null;
  const nextBack = [...backStack, current];
  if (nextBack.length > MAX_NAV_HISTORY) {
    nextBack.splice(0, nextBack.length - MAX_NAV_HISTORY);
  }

  return {
    nextBackStack: nextBack,
    nextForwardStack: nextForward,
    destination,
  };
}
