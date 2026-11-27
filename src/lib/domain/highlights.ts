import type {
  HighlightColor,
  HighlightRecord,
  HighlightSegment,
  NormalizedRect,
} from "../ipc/types";

export const HIGHLIGHT_COLORS = ["yellow", "green", "pink"] as const;
export const DEFAULT_HIGHLIGHT_COLOR: HighlightColor = "yellow";
export const MIN_HIGHLIGHT_RECT_DIMENSION = 0.0005;
export const SAME_LINE_Y_TOLERANCE_RATIO = 0.35;
export const SAME_LINE_GAP_TOLERANCE_RATIO = 0.6;
export const NEAR_DUPLICATE_OVERLAP_THRESHOLD = 0.92;
export const DEFAULT_POPOVER_MARGIN_PX = 8;
export const DEFAULT_POPOVER_GAP_PX = 8;

export interface PageHighlightEntry {
  readonly highlightId: string;
  readonly color: HighlightColor;
  readonly rects: readonly NormalizedRect[];
  readonly zIndex: number;
}

export interface HighlightHit {
  readonly highlightId: string;
  readonly rect: NormalizedRect;
}

interface LineBand {
  readonly anchorCy: number;
  readonly minHeight: number;
  readonly rects: NormalizedRect[];
}

export function isHighlightColor(value: unknown): value is HighlightColor {
  return value === "yellow" || value === "green" || value === "pink";
}

function sanitizeRect(rect: NormalizedRect): NormalizedRect | null {
  if (
    !rect ||
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return null;
  }

  const x0 = Math.max(0, Math.min(1, rect.x));
  const x1 = Math.max(0, Math.min(1, rect.x + rect.width));
  const y0 = Math.max(0, Math.min(1, rect.y));
  const y1 = Math.max(0, Math.min(1, rect.y + rect.height));

  const width = Math.min(1 - x0, Math.max(0, x1 - x0));
  const height = Math.min(1 - y0, Math.max(0, y1 - y0));

  if (
    width < MIN_HIGHLIGHT_RECT_DIMENSION ||
    height < MIN_HIGHLIGHT_RECT_DIMENSION
  ) {
    return null;
  }

  return { x: x0, y: y0, width, height };
}

function rectCenterY(rect: NormalizedRect): number {
  return rect.y + rect.height * 0.5;
}

function canMergeSameLine(prev: NormalizedRect, curr: NormalizedRect): boolean {
  const minHeight = Math.min(prev.height, curr.height);
  const yDiff = Math.abs(rectCenterY(prev) - rectCenterY(curr));
  if (yDiff > minHeight * SAME_LINE_Y_TOLERANCE_RATIO) {
    return false;
  }
  const gap = curr.x - (prev.x + prev.width);
  return gap <= minHeight * SAME_LINE_GAP_TOLERANCE_RATIO;
}

function mergeTwoRects(a: NormalizedRect, b: NormalizedRect): NormalizedRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return {
    x,
    y,
    width: Math.min(1 - x, right - x),
    height: Math.min(1 - y, bottom - y),
  };
}

function coalescePageRects(rects: readonly NormalizedRect[]): NormalizedRect[] {
  if (rects.length === 0) {
    return [];
  }

  const byCenterY = [...rects].sort((a, b) => {
    const cyDiff = rectCenterY(a) - rectCenterY(b);
    return cyDiff !== 0 ? cyDiff : a.x - b.x;
  });

  // Group into vertical line bands first so multi-column fragments at nearby Y coordinates
  // still sort left-to-right within their shared band without bridging column gutters.
  const bands: LineBand[] = [];
  for (const rect of byCenterY) {
    const cy = rectCenterY(rect);
    let targetBand: LineBand | null = null;
    for (let i = bands.length - 1; i >= 0; i -= 1) {
      const band = bands[i];
      if (!band) {
        continue;
      }
      const minHeight = Math.min(band.minHeight, rect.height);
      if (
        Math.abs(cy - band.anchorCy) <=
        minHeight * SAME_LINE_Y_TOLERANCE_RATIO
      ) {
        targetBand = band;
        break;
      }
    }

    if (targetBand) {
      targetBand.rects.push(rect);
    } else {
      bands.push({
        anchorCy: cy,
        minHeight: rect.height,
        rects: [rect],
      });
    }
  }

  const merged: NormalizedRect[] = [];
  for (const band of bands) {
    band.rects.sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
    let current = band.rects[0];
    if (!current) {
      continue;
    }

    for (let i = 1; i < band.rects.length; i += 1) {
      const next = band.rects[i];
      if (!next) {
        continue;
      }
      if (canMergeSameLine(current, next)) {
        current = mergeTwoRects(current, next);
      } else {
        merged.push(current);
        current = next;
      }
    }
    merged.push(current);
  }

  merged.sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
  return merged;
}

/**
 * Clamps rectangles into `[0.0, 1.0]`, discards degenerate slivers, merges adjacent
 * same-line fragments, and sorts segments ascending by `page_index`.
 */
export function normalizeHighlightSegments(
  rawSegments: readonly HighlightSegment[],
): HighlightSegment[] {
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    return [];
  }

  const byPage = new Map<number, NormalizedRect[]>();
  for (const segment of rawSegments) {
    if (
      !segment ||
      !Number.isInteger(segment.page_index) ||
      segment.page_index < 0 ||
      !Array.isArray(segment.rects)
    ) {
      continue;
    }

    let bucket = byPage.get(segment.page_index);
    for (const rawRect of segment.rects) {
      const clean = sanitizeRect(rawRect);
      if (!clean) {
        continue;
      }
      if (!bucket) {
        bucket = [];
        byPage.set(segment.page_index, bucket);
      }
      bucket.push(clean);
    }
  }

  const pageIndices = Array.from(byPage.keys()).sort((a, b) => a - b);
  const normalized: HighlightSegment[] = [];
  for (const pageIndex of pageIndices) {
    const rects = byPage.get(pageIndex);
    if (!rects || rects.length === 0) {
      continue;
    }
    const coalesced = coalescePageRects(rects);
    if (coalesced.length > 0) {
      normalized.push({ page_index: pageIndex, rects: coalesced });
    }
  }

  return normalized;
}

/**
 * Indexes `HighlightRecord[]` by zero-based `page_index`, preserving creation `zIndex`.
 */
export function groupHighlightsByPage(
  highlights: readonly HighlightRecord[],
): Map<number, PageHighlightEntry[]> {
  const byPage = new Map<number, PageHighlightEntry[]>();
  if (!Array.isArray(highlights)) {
    return byPage;
  }

  for (let zIndex = 0; zIndex < highlights.length; zIndex += 1) {
    const highlight = highlights[zIndex];
    if (!highlight || !Array.isArray(highlight.segments)) {
      continue;
    }

    for (const segment of highlight.segments) {
      if (
        !segment ||
        !Number.isInteger(segment.page_index) ||
        segment.page_index < 0 ||
        !Array.isArray(segment.rects) ||
        segment.rects.length === 0
      ) {
        continue;
      }

      let entries = byPage.get(segment.page_index);
      if (!entries) {
        entries = [];
        byPage.set(segment.page_index, entries);
      }
      entries.push({
        highlightId: highlight.id,
        color: highlight.color,
        rects: segment.rects,
        zIndex,
      });
    }
  }

  return byPage;
}

function collectValidAreaRects(
  rects: readonly NormalizedRect[],
): NormalizedRect[] {
  const valid: NormalizedRect[] = [];
  for (const rect of rects) {
    if (
      !rect ||
      !Number.isFinite(rect.x) ||
      !Number.isFinite(rect.y) ||
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      continue;
    }
    valid.push(rect);
  }
  return valid;
}

/**
 * Computes exact union area of axis-aligned rectangles via 2D vertical strip sweep-line
 * so overlapping rectangles within a single highlight are never double-counted.
 */
function computeRectsUnionArea(rects: readonly NormalizedRect[]): number {
  const valid = collectValidAreaRects(rects);
  if (valid.length === 0) {
    return 0;
  }

  const yCoords: number[] = [];
  for (const rect of valid) {
    yCoords.push(rect.y, rect.y + rect.height);
  }
  yCoords.sort((a, b) => a - b);

  const uniqueYs: number[] = [yCoords[0]!];
  for (let i = 1; i < yCoords.length; i += 1) {
    const y = yCoords[i]!;
    if (y > uniqueYs[uniqueYs.length - 1]!) {
      uniqueYs.push(y);
    }
  }

  let totalArea = 0;
  for (let i = 0; i + 1 < uniqueYs.length; i += 1) {
    const y0 = uniqueYs[i]!;
    const y1 = uniqueYs[i + 1]!;
    const stripHeight = y1 - y0;
    if (stripHeight <= 0) {
      continue;
    }

    const xIntervals: Array<[number, number]> = [];
    for (const rect of valid) {
      if (rect.y <= y0 && rect.y + rect.height >= y1) {
        xIntervals.push([rect.x, rect.x + rect.width]);
      }
    }
    if (xIntervals.length === 0) {
      continue;
    }

    xIntervals.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
    let curStart = xIntervals[0]![0];
    let curEnd = xIntervals[0]![1];
    let mergedWidth = 0;

    for (let j = 1; j < xIntervals.length; j += 1) {
      const [start, end] = xIntervals[j]!;
      if (start <= curEnd) {
        if (end > curEnd) {
          curEnd = end;
        }
      } else {
        mergedWidth += curEnd - curStart;
        curStart = start;
        curEnd = end;
      }
    }
    mergedWidth += curEnd - curStart;
    totalArea += stripHeight * mergedWidth;
  }

  return totalArea;
}

function collectPairwiseIntersections(
  rectsA: readonly NormalizedRect[],
  rectsB: readonly NormalizedRect[],
): NormalizedRect[] {
  const intersections: NormalizedRect[] = [];
  for (const a of rectsA) {
    const aRight = a.x + a.width;
    const aBottom = a.y + a.height;
    for (const b of rectsB) {
      const x0 = Math.max(a.x, b.x);
      const y0 = Math.max(a.y, b.y);
      const x1 = Math.min(aRight, b.x + b.width);
      const y1 = Math.min(aBottom, b.y + b.height);
      if (x1 > x0 && y1 > y0) {
        intersections.push({
          x: x0,
          y: y0,
          width: x1 - x0,
          height: y1 - y0,
        });
      }
    }
  }
  return intersections;
}

function indexSegmentsByPage(
  segments: readonly HighlightSegment[],
): Map<number, NormalizedRect[]> {
  const byPage = new Map<number, NormalizedRect[]>();
  for (const seg of segments) {
    if (!seg || !Array.isArray(seg.rects) || seg.rects.length === 0) {
      continue;
    }
    const valid = collectValidAreaRects(seg.rects);
    if (valid.length === 0) {
      continue;
    }
    let list = byPage.get(seg.page_index);
    if (!list) {
      list = [];
      byPage.set(seg.page_index, list);
    }
    list.push(...valid);
  }
  return byPage;
}

/**
 * Computes exact symmetric 2D IoU (`intersectionArea / unionArea`) across all pages
 * spanned by `a` and `b`.
 */
export function computeSegmentsOverlapRatio(
  a: readonly HighlightSegment[],
  b: readonly HighlightSegment[],
): number {
  const mapA = indexSegmentsByPage(a);
  const mapB = indexSegmentsByPage(b);
  if (mapA.size === 0 || mapB.size === 0) {
    return 0;
  }

  const allPages = new Set<number>([...mapA.keys(), ...mapB.keys()]);
  let totalIntersection = 0;
  let totalUnion = 0;

  for (const pageIndex of allPages) {
    const rectsA = mapA.get(pageIndex) ?? [];
    const rectsB = mapB.get(pageIndex) ?? [];
    if (rectsA.length === 0) {
      totalUnion += computeRectsUnionArea(rectsB);
      continue;
    }
    if (rectsB.length === 0) {
      totalUnion += computeRectsUnionArea(rectsA);
      continue;
    }

    const intersections = collectPairwiseIntersections(rectsA, rectsB);
    totalIntersection += computeRectsUnionArea(intersections);
    totalUnion += computeRectsUnionArea([...rectsA, ...rectsB]);
  }

  if (totalUnion <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(1, totalIntersection / totalUnion));
}

function haveSamePageSet(
  a: readonly HighlightSegment[],
  b: readonly HighlightSegment[],
): boolean {
  const pagesA = indexSegmentsByPage(a);
  const pagesB = indexSegmentsByPage(b);
  if (pagesA.size === 0 || pagesA.size !== pagesB.size) {
    return false;
  }
  for (const pageIndex of pagesA.keys()) {
    if (!pagesB.has(pageIndex)) {
      return false;
    }
  }
  return true;
}

/**
 * Returns the newest existing highlight spanning the exact same page set whose 2D IoU
 * with `candidateSegments` meets `NEAR_DUPLICATE_OVERLAP_THRESHOLD` (`0.92`), or `null`.
 */
export function findNearDuplicateHighlight(
  existing: readonly HighlightRecord[],
  candidateSegments: readonly HighlightSegment[],
): HighlightRecord | null {
  if (existing.length === 0 || candidateSegments.length === 0) {
    return null;
  }

  for (let i = existing.length - 1; i >= 0; i -= 1) {
    const record = existing[i];
    if (!record || !haveSamePageSet(record.segments, candidateSegments)) {
      continue;
    }
    const overlap = computeSegmentsOverlapRatio(
      record.segments,
      candidateSegments,
    );
    if (overlap >= NEAR_DUPLICATE_OVERLAP_THRESHOLD) {
      return record;
    }
  }

  return null;
}

/**
 * Reverse-scans page highlight entries (highest `zIndex` / newest first) and returns
 * the first matching highlight rectangle containing normalized `(normX, normY)`.
 */
export function hitTestPageHighlights(
  entries: readonly PageHighlightEntry[],
  normX: number,
  normY: number,
): HighlightHit | null {
  if (
    !Array.isArray(entries) ||
    entries.length === 0 ||
    !Number.isFinite(normX) ||
    !Number.isFinite(normY) ||
    normX < 0 ||
    normX > 1 ||
    normY < 0 ||
    normY > 1
  ) {
    return null;
  }

  let bestHit: { readonly zIndex: number; readonly hit: HighlightHit } | null =
    null;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    if (bestHit !== null && entry.zIndex <= bestHit.zIndex) {
      continue;
    }
    for (const rect of entry.rects) {
      if (
        normX >= rect.x &&
        normX <= rect.x + rect.width &&
        normY >= rect.y &&
        normY <= rect.y + rect.height
      ) {
        bestHit = {
          zIndex: entry.zIndex,
          hit: { highlightId: entry.highlightId, rect },
        };
        break;
      }
    }
  }

  return bestHit?.hit ?? null;
}

export interface PopoverAnchorRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface ComputePopoverPositionParams {
  readonly anchorRect: PopoverAnchorRect;
  readonly popoverWidth: number;
  readonly popoverHeight: number;
  readonly containerWidth: number;
  readonly containerHeight: number;
  readonly margin?: number;
  readonly gap?: number;
}

export interface PopoverPosition {
  readonly left: number;
  readonly top: number;
  readonly placement: "above" | "below";
}

function sanitizeFiniteNumber(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Computes clamped `.viewport-host`-relative `(left, top)` coordinates for `HighlightPopover`,
 * centering horizontally over `anchorRect`, defaulting above the highlight, and flipping
 * below when vertical headroom is tighter than `margin + popoverHeight + gap`.
 */
export function computePopoverPosition({
  anchorRect,
  popoverWidth,
  popoverHeight,
  containerWidth,
  containerHeight,
  margin = DEFAULT_POPOVER_MARGIN_PX,
  gap = DEFAULT_POPOVER_GAP_PX,
}: ComputePopoverPositionParams): PopoverPosition {
  const safeMargin = Math.max(
    0,
    sanitizeFiniteNumber(margin, DEFAULT_POPOVER_MARGIN_PX),
  );
  const safeGap = Math.max(
    0,
    sanitizeFiniteNumber(gap, DEFAULT_POPOVER_GAP_PX),
  );
  const safePopoverW = Math.max(0, sanitizeFiniteNumber(popoverWidth));
  const safePopoverH = Math.max(0, sanitizeFiniteNumber(popoverHeight));
  const safeContainerW = Math.max(0, sanitizeFiniteNumber(containerWidth));
  const safeContainerH = Math.max(0, sanitizeFiniteNumber(containerHeight));

  const anchorLeft = sanitizeFiniteNumber(anchorRect.left);
  const anchorTop = sanitizeFiniteNumber(anchorRect.top);
  const anchorW = Math.max(0, sanitizeFiniteNumber(anchorRect.width));
  const anchorH = Math.max(0, sanitizeFiniteNumber(anchorRect.height));

  const rawLeft = anchorLeft + anchorW / 2 - safePopoverW / 2;
  const maxLeft = Math.max(
    safeMargin,
    safeContainerW - safePopoverW - safeMargin,
  );
  const left = Math.max(safeMargin, Math.min(rawLeft, maxLeft));

  const aboveTop = anchorTop - safePopoverH - safeGap;
  const belowTop = anchorTop + anchorH + safeGap;
  const maxTop = Math.max(
    safeMargin,
    safeContainerH - safePopoverH - safeMargin,
  );

  if (aboveTop >= safeMargin) {
    return {
      left,
      top: Math.max(safeMargin, Math.min(aboveTop, maxTop)),
      placement: "above",
    };
  }

  const availableAbove = anchorTop - safeMargin;
  const availableBelow = safeContainerH - safeMargin - (anchorTop + anchorH);
  const belowFitsCompletely = belowTop <= maxTop;
  const shouldFlipBelow =
    belowFitsCompletely || availableBelow >= availableAbove;

  if (shouldFlipBelow) {
    return {
      left,
      top: Math.max(safeMargin, Math.min(belowTop, maxTop)),
      placement: "below",
    };
  }

  return {
    left,
    top: Math.max(safeMargin, Math.min(aboveTop, maxTop)),
    placement: "above",
  };
}
