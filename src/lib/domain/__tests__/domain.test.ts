import { describe, expect, it } from "vitest";
import type { OutlineItem, RecentFile, SearchMatch } from "../../ipc/types";
import { formatOpenError } from "../format-error";
import {
  buildOutlineModel,
  createInitialExpandedIds,
  resolveActiveOutlineNodeId,
  resolveVisibleActiveNodeId,
} from "../outline";
import {
  filterRecentFiles,
  getVisiblePageItems,
  RECENTS_PAGE_SIZE,
} from "../recents";
import {
  groupMatchesByPage,
  resolveInitialMatchIndex,
  stepMatchIndex,
} from "../search";
import { deriveTitle, splitParentDirectory } from "../title";
import {
  clampZoom,
  getNextZoomStep,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEPS,
} from "../zoom";

describe("title helpers", () => {
  it("prefers trimmed metadata title over filename stem", () => {
    expect(deriveTitle("/docs/book.pdf", "  Clean Title  ")).toBe(
      "Clean Title",
    );
    expect(deriveTitle("C:\\Users\\demo\\Manual.PDF", "   ")).toBe("Manual");
    expect(deriveTitle("/docs/notes.pdf", null)).toBe("notes");
    expect(deriveTitle("", null)).toBe("Untitled");
  });

  it("splits parent directory while preserving platform separators", () => {
    expect(splitParentDirectory("C:\\Books\\Deep\\guide.pdf")).toBe(
      "C:\\Books\\Deep",
    );
    expect(splitParentDirectory("/var/docs/file.pdf")).toBe("/var/docs");
    expect(splitParentDirectory("standalone.pdf")).toBe("");
  });
});

describe("zoom helpers", () => {
  it("clamps zoom scale cleanly and handles non-finite inputs", () => {
    expect(clampZoom(0.05)).toBe(MIN_ZOOM);
    expect(clampZoom(10)).toBe(MAX_ZOOM);
    expect(clampZoom(1.25)).toBe(1.25);
    expect(clampZoom(Number.NaN)).toBe(1.0);
  });

  it("steps up and down across ZOOM_STEPS with epsilon tolerance", () => {
    expect(getNextZoomStep(1.0, 1)).toBe(1.15);
    expect(getNextZoomStep(1.0, -1)).toBe(0.85);
    expect(getNextZoomStep(1.005, 1)).toBe(1.15);
    expect(getNextZoomStep(0.995, -1)).toBe(0.85);
    expect(getNextZoomStep(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(getNextZoomStep(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(ZOOM_STEPS.length).toBe(15);
  });
});

describe("recents filtering & pagination", () => {
  const sampleRecents: RecentFile[] = [
    {
      path: "/docs/systems/rust-guide.pdf",
      title: "Rust Guide",
      last_opened_unix: 300,
      last_page: 4,
      page_count: 100,
    },
    {
      path: "/archive/manuals/svelte-notes.pdf",
      title: "Svelte Notes",
      last_opened_unix: 200,
      last_page: 1,
      page_count: 40,
    },
    {
      path: "/docs/systems/compiler-book.pdf",
      title: "Compiler Design",
      last_opened_unix: 100,
      last_page: 0,
      page_count: 250,
    },
  ];

  it("filters case-insensitively with multi-token matching across title and path", () => {
    expect(RECENTS_PAGE_SIZE).toBe(10);
    expect(filterRecentFiles(sampleRecents, "")).toHaveLength(3);
    expect(filterRecentFiles(sampleRecents, "  systems   compiler ")).toEqual([
      sampleRecents[2],
    ]);
    expect(filterRecentFiles(sampleRecents, "svelte archive")).toEqual([
      sampleRecents[1],
    ]);
    expect(filterRecentFiles(sampleRecents, "rust missing")).toEqual([]);
  });

  it("computes compact pagination items across page counts 0..20", () => {
    expect(getVisiblePageItems(1, 0)).toEqual([]);
    expect(getVisiblePageItems(1, 1)).toEqual([1]);
    expect(getVisiblePageItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(getVisiblePageItems(1, 12)).toEqual([1, 2, 3, 4, "ellipsis", 12]);
    expect(getVisiblePageItems(3, 12)).toEqual([1, 2, 3, 4, "ellipsis", 12]);
    expect(getVisiblePageItems(6, 12)).toEqual([
      1,
      "ellipsis",
      5,
      6,
      7,
      "ellipsis",
      12,
    ]);
    expect(getVisiblePageItems(10, 12)).toEqual([1, "ellipsis", 9, 10, 11, 12]);
    expect(getVisiblePageItems(12, 20)).toEqual([
      1,
      "ellipsis",
      11,
      12,
      13,
      "ellipsis",
      20,
    ]);
  });
});

describe("outline domain helpers", () => {
  const sampleOutline: OutlineItem[] = [
    {
      title: "Book Root",
      page_index: 0,
      children: [
        {
          title: "Chapter 1",
          page_index: 2,
          children: [
            { title: "Section 1.1", page_index: 2, children: [] },
            { title: "Section 1.2", page_index: 5, children: [] },
          ],
        },
        {
          title: "   ",
          page_index: 10,
          children: [],
        },
      ],
    },
  ];

  it("normalizes tree IDs, trims blank titles, and resolves shared-page preferred nodes", () => {
    const model = buildOutlineModel(sampleOutline);
    expect(model.roots).toHaveLength(1);
    expect(model.flat.map((n) => n.id)).toEqual([
      "0",
      "0.0",
      "0.0.0",
      "0.0.1",
      "0.1",
    ]);
    expect(model.byId.get("0.1")?.title).toBe("Untitled");

    // Page 2 has both Chapter 1 ("0.0") and Section 1.1 ("0.0.0").
    expect(resolveActiveOutlineNodeId(model, 2)).toBe("0.0");
    expect(resolveActiveOutlineNodeId(model, 2, "0.0.0")).toBe("0.0.0");

    // Reading deeper on page 4 resolves to the last entry on nearest preceding page (Section 1.1).
    expect(resolveActiveOutlineNodeId(model, 4)).toBe("0.0.0");
  });

  it("maps collapsed nodes to their deepest visible ancestor and auto-expands initial tree", () => {
    const model = buildOutlineModel(sampleOutline);
    const expanded = createInitialExpandedIds(model, 5);
    expect(expanded.has("0")).toBe(true);
    expect(expanded.has("0.0")).toBe(true);

    expect(resolveVisibleActiveNodeId(model, "0.0.1", expanded)).toBe("0.0.1");
    expanded.delete("0.0");
    expect(resolveVisibleActiveNodeId(model, "0.0.1", expanded)).toBe("0.0");
  });
});

describe("search domain helpers", () => {
  const matches: SearchMatch[] = [
    { page_index: 1, rects: [{ x: 0.1, y: 0.2, width: 0.2, height: 0.03 }] },
    { page_index: 4, rects: [{ x: 0.2, y: 0.3, width: 0.2, height: 0.03 }] },
    { page_index: 4, rects: [] },
    { page_index: 8, rects: [{ x: 0.4, y: 0.5, width: 0.1, height: 0.03 }] },
  ];

  it("groups matches by page while skipping empty rects", () => {
    const byPage = groupMatchesByPage(matches);
    expect(byPage.get(1)).toHaveLength(1);
    expect(byPage.get(4)).toHaveLength(1);
    expect(byPage.get(8)?.[0]?.matchIndex).toBe(3);
  });

  it("selects initial match at/after current page and wraps around cleanly", () => {
    expect(resolveInitialMatchIndex(matches, 0)).toBe(0);
    expect(resolveInitialMatchIndex(matches, 3)).toBe(1);
    expect(resolveInitialMatchIndex(matches, 9)).toBe(0);
    expect(resolveInitialMatchIndex([], 0)).toBe(-1);

    expect(stepMatchIndex(0, 3, -1)).toBe(2);
    expect(stepMatchIndex(2, 3, 1)).toBe(0);
    expect(stepMatchIndex(-1, 3, 1)).toBe(0);
    expect(stepMatchIndex(0, 0, 1)).toBe(-1);
  });
});

describe("formatOpenError", () => {
  it("formats known IPC error codes into plain sentence-case copy", () => {
    expect(formatOpenError({ code: "io" }, { fromRecent: true })).toEqual({
      message: "File not found — it may have been moved or deleted.",
      canRemoveRecent: true,
    });
    expect(formatOpenError({ code: "io" }, { fromRecent: false })).toEqual({
      message:
        "Could not read that file. Check that it exists and is accessible.",
      canRemoveRecent: false,
    });
    expect(
      formatOpenError({ code: "password_protected" }, { fromRecent: true }),
    ).toEqual({
      message:
        "This PDF is password-protected. Protected documents are not supported.",
      canRemoveRecent: false,
    });
    expect(
      formatOpenError({ code: "unsupported_format" }, { fromRecent: true }),
    ).toEqual({
      message: "Unsupported file type. Select a PDF document.",
      canRemoveRecent: true,
    });
    expect(
      formatOpenError({ code: "invalid_document" }, { fromRecent: true }),
    ).toEqual({
      message:
        "Could not open this PDF. The file appears damaged or incomplete.",
      canRemoveRecent: true,
    });
    expect(
      formatOpenError({ code: "internal", message: "Custom reason" }),
    ).toEqual({
      message: "Custom reason",
      canRemoveRecent: false,
    });
    expect(formatOpenError(null)).toEqual({
      message: "Could not open this document.",
      canRemoveRecent: false,
    });
  });
});
