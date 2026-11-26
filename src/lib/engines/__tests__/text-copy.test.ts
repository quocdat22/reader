import { describe, expect, it } from "vitest";
import { formatCopiedFragments } from "../text-copy";

describe("formatCopiedFragments", () => {
  it("joins same-line words with a single space without doubling existing whitespace", () => {
    const out = formatCopiedFragments([
      {
        pageIndex: 0,
        text: "Hello",
        rect: { x: 0.1, y: 0.2, width: 0.1, height: 0.02 },
      },
      {
        pageIndex: 0,
        text: "world",
        rect: { x: 0.22, y: 0.202, width: 0.1, height: 0.02 },
      },
      {
        pageIndex: 0,
        text: " from ",
        rect: { x: 0.34, y: 0.2, width: 0.1, height: 0.02 },
      },
      {
        pageIndex: 0,
        text: "PDFium",
        rect: { x: 0.45, y: 0.201, width: 0.12, height: 0.02 },
      },
    ]);

    expect(out).toBe("Hello world from PDFium");
  });

  it("inserts single newlines across vertical line breaks and page transitions", () => {
    const out = formatCopiedFragments([
      {
        pageIndex: 0,
        text: "Line one",
        rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.02 },
      },
      {
        pageIndex: 0,
        text: "Line two",
        rect: { x: 0.1, y: 0.15, width: 0.2, height: 0.02 },
      },
      {
        pageIndex: 1,
        text: "Next page",
        rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.02 },
      },
    ]);

    expect(out).toBe("Line one\nLine two\nNext page");
  });

  it("ignores empty fragments cleanly and handles empty input", () => {
    expect(formatCopiedFragments([])).toBe("");
    expect(
      formatCopiedFragments([
        {
          pageIndex: 0,
          text: "",
          rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.02 },
        },
        {
          pageIndex: 0,
          text: "Only",
          rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.02 },
        },
        {
          pageIndex: 0,
          text: "",
          rect: { x: 0.2, y: 0.1, width: 0.1, height: 0.02 },
        },
      ]),
    ).toBe("Only");
  });
});
