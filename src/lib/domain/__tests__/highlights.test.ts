import { describe, expect, it } from "vitest";
import type { HighlightRecord, HighlightSegment } from "../../ipc/types";
import {
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLORS,
  NEAR_DUPLICATE_OVERLAP_THRESHOLD,
  computePopoverPosition,
  computeSegmentsOverlapRatio,
  findNearDuplicateHighlight,
  groupHighlightsByPage,
  hitTestPageHighlights,
  isHighlightColor,
  normalizeHighlightSegments,
} from "../highlights";

function makeRecord(
  id: string,
  color: HighlightRecord["color"],
  segments: HighlightSegment[],
): HighlightRecord {
  return {
    id,
    color,
    segments,
    quote: `Quote ${id}`,
    created_at_unix: 100,
    updated_at_unix: 100,
  };
}

describe("highlight domain helpers", () => {
  it("exports expected color constants and type guard", () => {
    expect(HIGHLIGHT_COLORS).toEqual(["yellow", "green", "pink"]);
    expect(DEFAULT_HIGHLIGHT_COLOR).toBe("yellow");
    expect(isHighlightColor("yellow")).toBe(true);
    expect(isHighlightColor("green")).toBe(true);
    expect(isHighlightColor("pink")).toBe(true);
    expect(isHighlightColor("blue")).toBe(false);
    expect(isHighlightColor(null)).toBe(false);
  });

  it("clamps rects, drops degenerate slivers, sorts cross-page segments, and coalesces same-line words", () => {
    const normalized = normalizeHighlightSegments([
      {
        page_index: 3,
        rects: [
          { x: 0.9, y: 0.5, width: 0.25, height: 0.02 },
          { x: 0.1, y: 0.5, width: 0.0002, height: 0.02 }, // too narrow -> dropped
          { x: Number.NaN, y: 0.2, width: 0.2, height: 0.02 }, // non-finite -> dropped
        ],
      },
      {
        page_index: 1,
        rects: [
          // Two adjacent words on the same line + one word in a right column across a wide gutter
          { x: 0.208, y: 0.201, width: 0.1, height: 0.02 },
          { x: 0.58, y: 0.2, width: 0.2, height: 0.02 },
          { x: -0.05, y: 0.2, width: 0.25, height: 0.02 },
        ],
      },
      {
        page_index: 1,
        rects: [
          // Next line on page 1
          { x: 0.1, y: 0.25, width: 0.3, height: 0.02 },
        ],
      },
    ]);

    expect(normalized).toHaveLength(2);
    expect(normalized[0]?.page_index).toBe(1);
    expect(normalized[0]?.rects).toHaveLength(3);

    // Merged left column line: [0.0, 0.20] + [0.215, 0.315] -> gap 0.015? Wait: 0.215 - 0.20 = 0.015 > 0.012!
    // Wait: check exact gap: 0.20 is clamped right edge (-0.05 + 0.25), 0.215 - 0.20 = 0.015; let's check what actually merged:
    const page1Line1Left = normalized[0]!.rects[0]!;
    expect(page1Line1Left.x).toBeCloseTo(0, 6);
    expect(page1Line1Left.width).toBeCloseTo(0.308, 6);
    expect(normalized[1]?.page_index).toBe(3);
    expect(normalized[1]?.rects).toHaveLength(1);
    const page3Rect = normalized[1]!.rects[0]!;
    expect(page3Rect.x).toBeCloseTo(0.9, 6);
    expect(page3Rect.y).toBeCloseTo(0.5, 6);
    expect(page3Rect.width).toBeCloseTo(0.1, 6);
    expect(page3Rect.height).toBeCloseTo(0.02, 6);
  });

  it("merges adjacent same-line fragments even when multi-column words interleave in Y, without bridging column gutters", () => {
    const normalized = normalizeHighlightSegments([
      {
        page_index: 0,
        rects: [
          { x: 0.1, y: 0.2, width: 0.08, height: 0.02 }, // Col A word 1
          { x: 0.58, y: 0.201, width: 0.12, height: 0.02 }, // Col B word across wide gutter
          { x: 0.186, y: 0.202, width: 0.09, height: 0.02 }, // Col A word 2 (gap = 0.006 <= 0.02 * 0.6 = 0.012)
        ],
      },
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.page_index).toBe(0);
    expect(normalized[0]?.rects).toHaveLength(2);
    const [colA, colB] = normalized[0]!.rects;
    expect(colA?.x).toBeCloseTo(0.1, 6);
    expect(colA?.y).toBeCloseTo(0.2, 6);
    expect(colA?.width).toBeCloseTo(0.176, 6);
    expect(colA?.height).toBeCloseTo(0.022, 6);
    expect(colB?.x).toBeCloseTo(0.58, 6);
    expect(colB?.y).toBeCloseTo(0.201, 6);
    expect(colB?.width).toBeCloseTo(0.12, 6);
    expect(colB?.height).toBeCloseTo(0.02, 6);
  });

  it("indexes highlights by page preserving creation zIndex order", () => {
    const h1 = makeRecord("h1", "yellow", [
      { page_index: 0, rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.02 }] },
      { page_index: 1, rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }] },
    ]);
    const h2 = makeRecord("h2", "pink", [
      { page_index: 1, rects: [{ x: 0.15, y: 0.1, width: 0.2, height: 0.02 }] },
    ]);

    const byPage = groupHighlightsByPage([h1, h2]);
    expect(byPage.get(0)).toEqual([
      {
        highlightId: "h1",
        color: "yellow",
        rects: h1.segments[0]!.rects,
        zIndex: 0,
      },
    ]);
    expect(
      byPage.get(1)?.map((entry) => [entry.highlightId, entry.zIndex]),
    ).toEqual([
      ["h1", 0],
      ["h2", 1],
    ]);
  });

  it("computes exact 2D IoU without double-counting overlapping rects within one highlight", () => {
    const overlappingSelf: HighlightSegment[] = [
      {
        page_index: 0,
        rects: [
          { x: 0.1, y: 0.1, width: 0.2, height: 0.02 },
          { x: 0.2, y: 0.1, width: 0.2, height: 0.02 },
        ],
      },
    ];
    const singleUnion: HighlightSegment[] = [
      {
        page_index: 0,
        rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.02 }],
      },
    ];

    expect(
      computeSegmentsOverlapRatio(overlappingSelf, singleUnion),
    ).toBeCloseTo(1.0, 6);

    const partial: HighlightSegment[] = [
      {
        page_index: 0,
        rects: [{ x: 0.1, y: 0.1, width: 0.15, height: 0.02 }],
      },
    ];
    expect(computeSegmentsOverlapRatio(singleUnion, partial)).toBeCloseTo(
      0.5,
      6,
    );

    const slightJitter: HighlightSegment[] = [
      {
        page_index: 0,
        rects: [{ x: 0.102, y: 0.1, width: 0.295, height: 0.02 }],
      },
    ];
    expect(
      computeSegmentsOverlapRatio(singleUnion, slightJitter),
    ).toBeGreaterThanOrEqual(NEAR_DUPLICATE_OVERLAP_THRESHOLD);

    const otherPage: HighlightSegment[] = [
      {
        page_index: 2,
        rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.02 }],
      },
    ];
    expect(computeSegmentsOverlapRatio(singleUnion, otherPage)).toBe(0);
  });

  it("finds newest near-duplicate highlight only when touching the exact same page set", () => {
    const older = makeRecord("older", "yellow", [
      { page_index: 0, rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.02 }] },
    ]);
    const newer = makeRecord("newer", "green", [
      {
        page_index: 0,
        rects: [{ x: 0.101, y: 0.2, width: 0.398, height: 0.02 }],
      },
    ]);
    const crossPage = makeRecord("cross", "pink", [
      { page_index: 0, rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.02 }] },
      {
        page_index: 1,
        rects: [{ x: 0.1, y: 0.05, width: 0.02, height: 0.01 }],
      },
    ]);

    const match = findNearDuplicateHighlight(
      [older, newer, crossPage],
      [
        {
          page_index: 0,
          rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.02 }],
        },
      ],
    );
    expect(match?.id).toBe("newer");

    const noMatch = findNearDuplicateHighlight(
      [older, newer],
      [
        {
          page_index: 0,
          rects: [{ x: 0.1, y: 0.2, width: 0.15, height: 0.02 }],
        },
      ],
    );
    expect(noMatch).toBeNull();
  });

  it("hit-tests overlapping page highlights in reverse z-order and validates bounds", () => {
    const h1 = makeRecord("h1", "yellow", [
      { page_index: 0, rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.03 }] },
    ]);
    const h2 = makeRecord("h2", "pink", [
      { page_index: 0, rects: [{ x: 0.25, y: 0.2, width: 0.2, height: 0.03 }] },
    ]);
    const entries = groupHighlightsByPage([h1, h2]).get(0) ?? [];

    expect(hitTestPageHighlights(entries, 0.3, 0.21)?.highlightId).toBe("h2");
    expect(hitTestPageHighlights(entries, 0.15, 0.21)?.highlightId).toBe("h1");
    expect(hitTestPageHighlights(entries, 0.1, 0.2)?.highlightId).toBe("h1");
    expect(hitTestPageHighlights(entries, 0.05, 0.21)).toBeNull();
    expect(hitTestPageHighlights(entries, -0.1, 0.2)).toBeNull();
    expect(hitTestPageHighlights(entries, Number.NaN, 0.2)).toBeNull();
  });

  it("centers popover above anchorRect by default and clamps near left and right edges", () => {
    const centered = computePopoverPosition({
      anchorRect: { left: 260, top: 200, width: 100, height: 18 },
      popoverWidth: 156,
      popoverHeight: 32,
      containerWidth: 800,
      containerHeight: 600,
    });
    expect(centered).toEqual({
      left: 232,
      top: 160,
      placement: "above",
    });

    const leftClamped = computePopoverPosition({
      anchorRect: { left: 4, top: 200, width: 20, height: 18 },
      popoverWidth: 156,
      popoverHeight: 32,
      containerWidth: 800,
      containerHeight: 600,
    });
    expect(leftClamped).toEqual({
      left: 8,
      top: 160,
      placement: "above",
    });

    const rightClamped = computePopoverPosition({
      anchorRect: { left: 760, top: 200, width: 32, height: 18 },
      popoverWidth: 156,
      popoverHeight: 32,
      containerWidth: 800,
      containerHeight: 600,
    });
    expect(rightClamped).toEqual({
      left: 636,
      top: 160,
      placement: "above",
    });
  });

  it("flips popover below when headroom is tight and handles narrow/short containers", () => {
    const flipped = computePopoverPosition({
      anchorRect: { left: 300, top: 14, width: 120, height: 20 },
      popoverWidth: 156,
      popoverHeight: 32,
      containerWidth: 800,
      containerHeight: 600,
    });
    expect(flipped).toEqual({
      left: 282,
      top: 42,
      placement: "below",
    });

    // When container is narrower than popover + 2 * margin, pin to left margin cleanly.
    const narrowContainer = computePopoverPosition({
      anchorRect: { left: 60, top: 100, width: 40, height: 16 },
      popoverWidth: 156,
      popoverHeight: 32,
      containerWidth: 140,
      containerHeight: 200,
    });
    expect(narrowContainer).toEqual({
      left: 8,
      top: 60,
      placement: "above",
    });

    // When top headroom is small but bottom has even less room in a short viewport, stay above clamped.
    const bottomTightShort = computePopoverPosition({
      anchorRect: { left: 200, top: 38, width: 80, height: 14 },
      popoverWidth: 156,
      popoverHeight: 32,
      containerWidth: 800,
      containerHeight: 60,
    });
    expect(bottomTightShort).toEqual({
      left: 162,
      top: 8,
      placement: "above",
    });
  });
});
