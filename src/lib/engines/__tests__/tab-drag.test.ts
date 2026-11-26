import { describe, expect, it } from "vitest";
import { computeOtherVisualLefts } from "../tab-drag";

describe("computeOtherVisualLefts", () => {
  it("computes exact displaced X offsets across variable-width Home and document tabs", () => {
    // Layout: Home (92px), Doc A (220px), Doc B (220px) with minContentX = 4, gapPx = 2.
    // Dragging Doc B (220px): `others` = [Home (92px), Doc A (220px)].
    const others = [{ width: 92 }, { width: 220 }];

    // Placed at index 0 (before Home):
    expect(computeOtherVisualLefts(others, 0, 220, 4, 2)).toEqual([
      4 + 220 + 2, // 226 (Home)
      4 + 220 + 2 + 92 + 2, // 320 (Doc A)
    ]);

    // Placed at index 1 (between Home and Doc A):
    expect(computeOtherVisualLefts(others, 1, 220, 4, 2)).toEqual([
      4, // Home stays at start
      4 + 92 + 2 + 220 + 2, // 318 (Doc A shifts past dragged Doc B)
    ]);

    // Placed at end (index 2):
    expect(computeOtherVisualLefts(others, 2, 220, 4, 2)).toEqual([
      4, // Home
      4 + 92 + 2, // 98 (Doc A)
    ]);
  });

  it("handles dragging the narrow Home tab across wider document tabs", () => {
    const others = [{ width: 220 }, { width: 220 }];
    expect(computeOtherVisualLefts(others, 1, 92, 0, 2)).toEqual([
      0, // Doc 1
      220 + 2 + 92 + 2, // 316 (Doc 2 shifts by narrow Home width + gap)
    ]);
  });
});
