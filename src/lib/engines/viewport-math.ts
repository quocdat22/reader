import type { PageDimensions, ZoomMode } from "../ipc/types";
import { clampZoom } from "../domain/zoom";
import type { ScrollAnchor } from "../state/types";

export const PT_TO_CSS_PX = 96 / 72;
export const PAGE_GAP_PX = 16;
export const TRACK_PADDING_Y = 24;
export const TRACK_PADDING_X = 48;
export const OVERSCAN_RADIUS = 2;
export const EVICT_RADIUS = 6;
export const MAX_CONCURRENT_RENDERS = 2;
export const MAX_DPR = 3;

export interface PageLayoutGeom {
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface LayoutGeometry {
  readonly offsets: PageLayoutGeom[];
  readonly totalHeight: number;
  readonly maxPageWidth: number;
}

export interface VisibleRange {
  readonly firstVisible: number;
  readonly lastVisible: number;
  readonly activePageIndex: number;
}

export interface ZoomRelayoutAnchor {
  readonly pageIndex: number;
  readonly ratioInPage: number;
  readonly anchorOffset: number;
}

export interface EffectiveScaleInput {
  readonly pageDimensions: readonly PageDimensions[];
  readonly pageIndex: number;
  readonly zoomMode: ZoomMode;
  readonly zoomScale: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

/**
 * Rounds a CSS pixel coordinate/dimension to the nearest physical device pixel.
 */
export function snapToDevicePixels(cssPx: number, dpr: number): number {
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.round(cssPx * safeDpr) / safeDpr;
}

/**
 * Clamps devicePixelRatio into `[1, MAX_DPR]`.
 */
export function getEffectiveDpr(
  rawDpr = typeof window !== "undefined" ? window.devicePixelRatio : 1,
): number {
  const valid = Number.isFinite(rawDpr) && rawDpr > 0 ? rawDpr : 1;
  return Math.max(1, Math.min(valid, MAX_DPR));
}

/**
 * Computes the effective zoom multiplier for `"fit_width"`, `"fit_page"`, or `"custom"`.
 */
export function computeEffectiveScale({
  pageDimensions,
  pageIndex,
  zoomMode,
  zoomScale,
  viewportWidth,
  viewportHeight,
}: EffectiveScaleInput): number {
  if (pageDimensions.length === 0) {
    return 1.0;
  }

  if (zoomMode === "custom") {
    return clampZoom(zoomScale);
  }

  const refIndex = Math.max(0, Math.min(pageIndex, pageDimensions.length - 1));
  const refDims = pageDimensions[refIndex] ?? pageDimensions[0];
  if (!refDims) {
    return 1.0;
  }

  const baseW = Math.max(1, refDims.width_pt * PT_TO_CSS_PX);
  const baseH = Math.max(1, refDims.height_pt * PT_TO_CSS_PX);

  const availableW = Math.max(120, viewportWidth - TRACK_PADDING_X);
  const availableH = Math.max(120, viewportHeight - TRACK_PADDING_Y * 2);

  if (zoomMode === "fit_width") {
    return clampZoom(availableW / baseW);
  }

  return clampZoom(Math.min(availableW / baseW, availableH / baseH));
}

/**
 * Computes snapped vertical offsets and backing bitmap pixel sizes for every page.
 */
export function computeLayoutGeometry(
  pageDimensions: readonly PageDimensions[],
  scale: number,
  dpr: number,
): LayoutGeometry {
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const offsets: PageLayoutGeom[] = [];
  const padY = snapToDevicePixels(TRACK_PADDING_Y, safeDpr);
  const gapY = snapToDevicePixels(PAGE_GAP_PX, safeDpr);
  let y = padY;
  let maxPageWidth = 0;

  for (const dims of pageDimensions) {
    const rawW = Math.max(1, dims.width_pt * PT_TO_CSS_PX * scale);
    const rawH = Math.max(1, dims.height_pt * PT_TO_CSS_PX * scale);
    const widthPx = Math.max(1, Math.round(rawW * safeDpr));
    const heightPx = Math.max(1, Math.round(rawH * safeDpr));
    const width = widthPx / safeDpr;
    const height = heightPx / safeDpr;
    const top = snapToDevicePixels(y, safeDpr);
    offsets.push({ top, width, height, widthPx, heightPx });
    if (width > maxPageWidth) {
      maxPageWidth = width;
    }
    y = top + height + gapY;
  }

  const totalHeight = pageDimensions.length > 0 ? y - gapY + padY : padY * 2;
  return { offsets, totalHeight, maxPageWidth };
}

/**
 * Computes device-pixel-snapped horizontal track width.
 */
export function computeTrackWidth(
  maxPageWidth: number,
  viewportWidth: number,
  dpr: number,
): number {
  const minTrackWidth = maxPageWidth + TRACK_PADDING_X;
  return snapToDevicePixels(Math.max(viewportWidth, minTrackWidth), dpr);
}

/**
 * Binary searches `offsets` for the first page whose bottom edge is `>= y`.
 */
export function findFirstPageAtOrAfter(
  offsets: readonly Pick<PageLayoutGeom, "top" | "height">[],
  y: number,
): number {
  if (offsets.length === 0) {
    return 0;
  }
  let low = 0;
  let high = offsets.length - 1;
  let result = offsets.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const geom = offsets[mid];
    if (!geom) {
      break;
    }
    const bottom = geom.top + geom.height;
    if (bottom >= y) {
      result = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return result;
}

/**
 * Binary searches `offsets` for the last page whose top edge is `<= y`.
 */
export function findLastPageAtOrBefore(
  offsets: readonly Pick<PageLayoutGeom, "top">[],
  y: number,
): number {
  if (offsets.length === 0) {
    return -1;
  }
  let low = 0;
  let high = offsets.length - 1;
  let result = 0;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const geom = offsets[mid];
    if (!geom) {
      break;
    }
    if (geom.top <= y) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

/**
 * Resolves visible page bounds and active page index from current scroll position.
 */
export function resolveVisibleRange(
  offsets: readonly PageLayoutGeom[],
  scrollTop: number,
  viewportHeight: number,
  scrollHeight: number,
): VisibleRange {
  if (offsets.length === 0) {
    return { firstVisible: 0, lastVisible: -1, activePageIndex: 0 };
  }

  const viewBottom = scrollTop + viewportHeight;
  const firstVisible = findFirstPageAtOrAfter(offsets, scrollTop);
  const lastVisible = Math.max(
    firstVisible,
    findLastPageAtOrBefore(offsets, viewBottom),
  );

  const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
  const lastIndex = offsets.length - 1;
  const lastGeom = offsets[lastIndex];
  let activePageIndex: number;

  if (
    maxScrollTop > 0 &&
    scrollTop >= maxScrollTop - 2 &&
    lastGeom &&
    lastGeom.top < scrollTop + viewportHeight * 0.6
  ) {
    activePageIndex = lastIndex;
  } else {
    const firstHeight = offsets[firstVisible]?.height ?? viewportHeight;
    const anchorOffset = Math.min(viewportHeight * 0.35, firstHeight * 0.5);
    const anchorY = scrollTop + anchorOffset;
    activePageIndex = findFirstPageAtOrAfter(offsets, anchorY);
  }

  activePageIndex = Math.max(0, Math.min(activePageIndex, lastIndex));
  return { firstVisible, lastVisible, activePageIndex };
}

/**
 * Captures a zoom-relayout scroll anchor at 25% of the viewport height.
 */
export function computeScrollAnchor(
  offsets: readonly PageLayoutGeom[],
  scrollTop: number,
  viewportHeight: number,
): ZoomRelayoutAnchor {
  if (offsets.length === 0) {
    return { pageIndex: 0, ratioInPage: 0, anchorOffset: 0 };
  }
  const anchorOffset = viewportHeight * 0.25;
  const anchorY = scrollTop + anchorOffset;
  const pageIndex = Math.max(
    0,
    Math.min(findFirstPageAtOrAfter(offsets, anchorY), offsets.length - 1),
  );
  const geom = offsets[pageIndex];
  const ratioInPage =
    geom && geom.height > 0
      ? Math.max(0, Math.min(1, (anchorY - geom.top) / geom.height))
      : 0;

  return { pageIndex, ratioInPage, anchorOffset };
}

/**
 * Resolves the new snapped `scrollTop` preserving `anchor` after a layout/zoom change.
 */
export function resolveAnchorScrollTop(
  offsets: readonly PageLayoutGeom[],
  anchor: ZoomRelayoutAnchor,
  dpr: number,
): number {
  if (offsets.length === 0) {
    return 0;
  }
  const geom =
    offsets[Math.min(Math.max(0, anchor.pageIndex), offsets.length - 1)];
  if (!geom) {
    return 0;
  }
  const targetScrollTop =
    geom.top + anchor.ratioInPage * geom.height - anchor.anchorOffset;
  return snapToDevicePixels(Math.max(0, targetScrollTop), dpr);
}

/**
 * Captures a tab-switch scroll anchor relative to the active page's top edge.
 */
export function computeTabScrollAnchor(
  offsets: readonly PageLayoutGeom[],
  scrollTop: number,
  activePageIndex: number,
): ScrollAnchor | null {
  if (offsets.length === 0) {
    return null;
  }
  const geom = offsets[activePageIndex];
  if (!geom || geom.height <= 0) {
    return null;
  }
  return {
    pageIndex: activePageIndex,
    topOffsetRatio: (scrollTop - geom.top) / geom.height,
  };
}
