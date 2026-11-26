import { describe, expect, it } from "vitest";
import type { PageDimensions } from "../../ipc/types";
import {
  MAX_DPR,
  PAGE_GAP_PX,
  TRACK_PADDING_X,
  TRACK_PADDING_Y,
  computeEffectiveScale,
  computeLayoutGeometry,
  computeScrollAnchor,
  computeTabScrollAnchor,
  computeTrackWidth,
  findFirstPageAtOrAfter,
  findLastPageAtOrBefore,
  getEffectiveDpr,
  resolveAnchorScrollTop,
  resolveVisibleRange,
  snapToDevicePixels,
} from "../viewport-math";

const LETTER_PAGE: PageDimensions = { width_pt: 612, height_pt: 792 };
const WIDE_PAGE: PageDimensions = { width_pt: 842, height_pt: 595 };

describe("viewport-math DPR & scaling", () => {
  it("snaps CSS values to device pixels across fractional and integer DPRs", () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      const snapped = snapToDevicePixels(100.37, dpr);
      expect(Math.round(snapped * dpr)).toBeCloseTo(snapped * dpr, 8);
    }
    expect(getEffectiveDpr(0.5)).toBe(1);
    expect(getEffectiveDpr(4.5)).toBe(MAX_DPR);
  });

  it("computes fit_width, fit_page, and clamped custom scales", () => {
    const dims = [LETTER_PAGE, WIDE_PAGE];
    const fitWidth = computeEffectiveScale({
      pageDimensions: dims,
      pageIndex: 0,
      zoomMode: "fit_width",
      zoomScale: 1.0,
      viewportWidth: 1000,
      viewportHeight: 800,
    });
    // availableW = 1000 - 48 = 952; baseW = 612 * (96/72) = 816 => ~1.1667
    expect(fitWidth).toBeCloseTo(
      (1000 - TRACK_PADDING_X) / (612 * (96 / 72)),
      6,
    );

    const fitPage = computeEffectiveScale({
      pageDimensions: dims,
      pageIndex: 0,
      zoomMode: "fit_page",
      zoomScale: 1.0,
      viewportWidth: 1000,
      viewportHeight: 800,
    });
    // availableH = 800 - 48 = 752; baseH = 792 * (96/72) = 1056 => ~0.7121
    expect(fitPage).toBeCloseTo(
      (800 - TRACK_PADDING_Y * 2) / (792 * (96 / 72)),
      6,
    );

    expect(
      computeEffectiveScale({
        pageDimensions: dims,
        pageIndex: 0,
        zoomMode: "custom",
        zoomScale: 10,
        viewportWidth: 1000,
        viewportHeight: 800,
      }),
    ).toBe(4.0);
  });
});

describe("viewport-math binary search & layout", () => {
  it("handles single-page, multi-page, variable-height, and out-of-bounds queries", () => {
    expect(findFirstPageAtOrAfter([], 100)).toBe(0);
    expect(findLastPageAtOrBefore([], 100)).toBe(-1);

    const single = computeLayoutGeometry([LETTER_PAGE], 1.0, 1);
    expect(single.offsets).toHaveLength(1);
    expect(findFirstPageAtOrAfter(single.offsets, -50)).toBe(0);
    expect(findFirstPageAtOrAfter(single.offsets, 99999)).toBe(0);
    expect(findLastPageAtOrBefore(single.offsets, 0)).toBe(0);

    const multi = computeLayoutGeometry(
      [LETTER_PAGE, WIDE_PAGE, LETTER_PAGE],
      1.0,
      1.5,
    );
    expect(multi.offsets).toHaveLength(3);
    const p0 = multi.offsets[0]!;
    const p1 = multi.offsets[1]!;
    const p2 = multi.offsets[2]!;

    expect(p1.top).toBeCloseTo(
      p0.top + p0.height + snapToDevicePixels(PAGE_GAP_PX, 1.5),
      6,
    );
    expect(findFirstPageAtOrAfter(multi.offsets, p0.top + p0.height + 1)).toBe(
      1,
    );
    expect(findFirstPageAtOrAfter(multi.offsets, p2.top + 10)).toBe(2);
    expect(findLastPageAtOrBefore(multi.offsets, p1.top + 5)).toBe(1);
    expect(findLastPageAtOrBefore(multi.offsets, p2.top + 5000)).toBe(2);

    const trackW = computeTrackWidth(multi.maxPageWidth, 900, 1.5);
    expect(trackW).toBeGreaterThanOrEqual(900);
  });

  it("resolves visible range and snaps to final page at bottom scroll edge", () => {
    const geom = computeLayoutGeometry(
      [LETTER_PAGE, LETTER_PAGE, LETTER_PAGE, LETTER_PAGE],
      1.0,
      1,
    );
    const topRange = resolveVisibleRange(
      geom.offsets,
      0,
      700,
      geom.totalHeight,
    );
    expect(topRange.firstVisible).toBe(0);
    expect(topRange.activePageIndex).toBe(0);

    const bottomScrollTop = Math.max(0, geom.totalHeight - 700);
    const bottomRange = resolveVisibleRange(
      geom.offsets,
      bottomScrollTop,
      700,
      geom.totalHeight,
    );
    expect(bottomRange.lastVisible).toBe(3);
    expect(bottomRange.activePageIndex).toBe(3);
  });

  it("preserves reading anchor position across zoom changes", () => {
    const dims = [LETTER_PAGE, WIDE_PAGE, LETTER_PAGE, LETTER_PAGE];
    const dpr = 1.5;
    const layout1 = computeLayoutGeometry(dims, 1.0, dpr);
    const viewportHeight = 720;

    // Position viewport halfway down page 2 (index 1).
    const p1 = layout1.offsets[1]!;
    const initialScrollTop = p1.top + p1.height * 0.5 - viewportHeight * 0.25;
    const anchor = computeScrollAnchor(
      layout1.offsets,
      initialScrollTop,
      viewportHeight,
    );
    expect(anchor.pageIndex).toBe(1);
    expect(anchor.ratioInPage).toBeCloseTo(0.5, 2);

    const layoutZoomed = computeLayoutGeometry(dims, 1.75, dpr);
    const zoomedScrollTop = resolveAnchorScrollTop(
      layoutZoomed.offsets,
      anchor,
      dpr,
    );
    const zoomedP1 = layoutZoomed.offsets[1]!;
    const resolvedRatio =
      (zoomedScrollTop + viewportHeight * 0.25 - zoomedP1.top) /
      zoomedP1.height;
    expect(resolvedRatio).toBeCloseTo(anchor.ratioInPage, 2);

    const tabAnchor = computeTabScrollAnchor(
      layout1.offsets,
      p1.top + p1.height * 0.3,
      1,
    );
    expect(tabAnchor?.pageIndex).toBe(1);
    expect(tabAnchor?.topOffsetRatio).toBeCloseTo(0.3, 4);
  });
});
