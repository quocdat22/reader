import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupHighlightsByPage } from "../../domain/highlights";
import type {
  HighlightRecord,
  PageDimensions,
  TextSpan,
} from "../../ipc/types";
import { createHighlightLayerEngine } from "../highlight-layer";
import { createTextLayerEngine } from "../text-layer";
import type { PageLayoutGeom } from "../viewport-math";

interface MockClassList {
  add(name: string): void;
  remove(name: string): void;
  contains(name: string): boolean;
}

interface MockDomNode {
  tagName: string;
  className: string;
  classList: MockClassList;
  attributes: Record<string, string>;
  style: Record<string, string>;
  children: MockDomNode[];
  parentElement: MockDomNode | null;
  scrollTop: number;
  textContent: string;
  rect: DOMRect;
  appendChild(child: MockDomNode): MockDomNode;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getBoundingClientRect(): DOMRect;
  getContext(
    kind: string,
  ): { font: string; measureText(text: string): { width: number } } | null;
  querySelectorAll(selector: string): MockDomNode[];
  contains(other: unknown): boolean;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  dispatch(type: string, event: Record<string, unknown>): void;
  remove(): void;
}

function makeRect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON() {
      return {};
    },
  };
}

function createMockNode(tagName = "div"): MockDomNode {
  const classes = new Set<string>();
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  let textValue = "";

  const node: MockDomNode = {
    tagName: tagName.toUpperCase(),
    className: "",
    classList: {
      add(name: string) {
        classes.add(name);
      },
      remove(name: string) {
        classes.delete(name);
      },
      contains(name: string) {
        return classes.has(name);
      },
    },
    attributes: {},
    style: {},
    children: [],
    parentElement: null,
    scrollTop: 0,
    get textContent() {
      return textValue;
    },
    set textContent(next: string) {
      textValue = next;
      if (next === "") {
        for (const child of node.children) {
          child.parentElement = null;
        }
        node.children = [];
      }
    },
    rect: makeRect(0, 0, 0, 0),
    appendChild(child: MockDomNode): MockDomNode {
      if (child.tagName === "__FRAGMENT__") {
        for (const item of child.children) {
          item.parentElement = node;
          node.children.push(item);
        }
        child.children = [];
      } else {
        child.parentElement = node;
        node.children.push(child);
      }
      return child;
    },
    setAttribute(name: string, value: string) {
      node.attributes[name] = value;
    },
    removeAttribute(name: string) {
      delete node.attributes[name];
    },
    getBoundingClientRect() {
      return node.rect;
    },
    getContext(kind: string) {
      if (kind !== "2d") {
        return null;
      }
      return {
        font: "",
        measureText: (text: string) => ({ width: text.length * 8 }),
      };
    },
    querySelectorAll(selector: string) {
      const targetClass = selector.startsWith(".")
        ? selector.slice(1)
        : selector;
      const matches: MockDomNode[] = [];
      const visit = (cur: MockDomNode) => {
        for (const child of cur.children) {
          if (child.classList.contains(targetClass)) {
            matches.push(child);
          }
          visit(child);
        }
      };
      visit(node);
      return matches;
    },
    contains(other: unknown): boolean {
      if (other === node) {
        return true;
      }
      for (const child of node.children) {
        if (child.contains(other)) {
          return true;
        }
      }
      return false;
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type: string, event: Record<string, unknown>) {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
    remove() {
      if (node.parentElement) {
        node.parentElement.children = node.parentElement.children.filter(
          (item) => item !== node,
        );
        node.parentElement = null;
      }
    },
  };

  Object.defineProperty(node, "className", {
    get() {
      return Array.from(classes).join(" ");
    },
    set(value: string) {
      classes.clear();
      for (const token of value.split(/\s+/)) {
        if (token) {
          classes.add(token);
        }
      }
    },
  });

  return node;
}

function makeHighlight(
  id: string,
  color: HighlightRecord["color"],
  segments: HighlightRecord["segments"],
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

describe("createHighlightLayerEngine", () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  let mockSelection: {
    isCollapsed: boolean;
    rangeCount: number;
    toString: () => string;
    getRangeAt: (idx: number) => { commonAncestorContainer: unknown };
    removeAllRanges: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockSelection = {
      isCollapsed: true,
      rangeCount: 0,
      toString: () => "",
      getRangeAt: () => ({ commonAncestorContainer: null }),
      removeAllRanges: vi.fn(),
    };
    (globalThis as unknown as { document: unknown }).document = {
      createElement: (tag: string) => createMockNode(tag),
      createDocumentFragment: () => createMockNode("__FRAGMENT__"),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (globalThis as unknown as { window: unknown }).window = {
      getSelection: () => mockSelection,
    };
  });

  afterEach(() => {
    (globalThis as unknown as { document: unknown }).document =
      originalDocument;
    (globalThis as unknown as { window: unknown }).window = originalWindow;
  });

  it("mounts percentage-positioned layers, repaints on syncHighlights, and evicts distant pages", () => {
    const hostNode = createMockNode("div");
    hostNode.rect = makeRect(0, 36, 800, 1000);
    const viewportNode = createMockNode("div");
    viewportNode.rect = makeRect(0, 36, 800, 1000);
    hostNode.appendChild(viewportNode);

    const slot0 = createMockNode("div");
    slot0.rect = makeRect(100, 56, 600, 800);
    const slot1 = createMockNode("div");
    slot1.rect = makeRect(100, 872, 600, 800);
    const slot2 = createMockNode("div");
    slot2.rect = makeRect(100, 1688, 600, 800);

    const pageOffsets: PageLayoutGeom[] = [
      { top: 20, width: 600, height: 800, widthPx: 600, heightPx: 800 },
      { top: 836, width: 600, height: 800, widthPx: 600, heightPx: 800 },
      { top: 1652, width: 600, height: 800, widthPx: 600, heightPx: 800 },
    ];

    const engine = createHighlightLayerEngine({
      viewportEl: viewportNode as unknown as HTMLElement,
      getHighlighterMode: () => false,
      isLinkAtPoint: () => false,
      extractSelection: () => null,
      clearActiveSelection: () => {},
      onCreateFromSelection: () => {},
      onSelectHighlight: () => {},
      onDismissPopover: () => {},
    });

    const initialByPage = groupHighlightsByPage([
      makeHighlight("hl-1", "yellow", [
        {
          page_index: 0,
          rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.02 }],
        },
        {
          page_index: 1,
          rects: [{ x: 0.1, y: 0.1, width: 0.25, height: 0.02 }],
        },
      ]),
    ]);

    engine.syncVisibleRange({
      documentId: 1,
      renderMin: 0,
      renderMax: 2,
      slotElements: [
        slot0 as unknown as HTMLDivElement,
        slot1 as unknown as HTMLDivElement,
        slot2 as unknown as HTMLDivElement,
      ],
      pageOffsets,
      highlightsByPage: initialByPage,
    });

    expect(slot0.children).toHaveLength(1);
    expect(slot1.children).toHaveLength(1);
    // Page 2 has no highlights so no empty .highlight-layer DOM node is mounted.
    expect(slot2.children).toHaveLength(0);

    const layer0 = slot0.children[0]!;
    expect(layer0.className).toBe("highlight-layer");
    const group0 = layer0.children[0]!;
    expect(group0.attributes["data-highlight-id"]).toBe("hl-1");
    const rect0 = group0.children[0]!;
    expect(rect0.classList.contains("pdf-highlight-rect--yellow")).toBe(true);
    expect(rect0.style.left).toBe("10.0000%");
    expect(rect0.style.top).toBe("20.0000%");
    expect(rect0.style.width).toBe("40.0000%");
    expect(rect0.style.height).toBe("2.0000%");

    // Hovering page 0 highlights all mounted segments of cross-page highlight hl-1.
    viewportNode.dispatch("pointermove", {
      clientX: 100 + 0.2 * 600,
      clientY: 56 + 0.21 * 800,
      buttons: 0,
    });
    expect(viewportNode.classList.contains("viewport--highlight-hover")).toBe(
      true,
    );
    expect(group0.classList.contains("pdf-highlight-group--hover")).toBe(true);
    expect(
      slot1.children[0]!.children[0]!.classList.contains(
        "pdf-highlight-group--hover",
      ),
    ).toBe(true);

    // Selecting highlight ID marks every mounted segment across pages.
    engine.setSelectedHighlightId("hl-1");
    expect(group0.classList.contains("pdf-highlight-group--selected")).toBe(
      true,
    );
    expect(
      slot1.children[0]!.children[0]!.classList.contains(
        "pdf-highlight-group--selected",
      ),
    ).toBe(true);

    // Evicting page 0 removes slot0's layer while keeping slot1 intact.
    engine.evictOutside(1, 2);
    expect(slot0.children).toHaveLength(0);
    expect(slot1.children).toHaveLength(1);

    // Removing page 1 highlight via syncHighlights removes empty .highlight-layer.
    engine.syncHighlights(groupHighlightsByPage([]));
    expect(slot1.children).toHaveLength(0);
    expect(viewportNode.classList.contains("viewport--highlight-hover")).toBe(
      false,
    );

    engine.destroy();
  });

  it("enforces reverse z-order hit-testing, link click precedence, drag suppression, scroll dismiss, and destroy cleanup", () => {
    const hostNode = createMockNode("div");
    hostNode.rect = makeRect(0, 36, 800, 1000);
    const viewportNode = createMockNode("div");
    viewportNode.rect = makeRect(0, 36, 800, 1000);
    hostNode.appendChild(viewportNode);

    const slot0 = createMockNode("div");
    slot0.rect = makeRect(100, 56, 600, 800);
    const pageOffsets: PageLayoutGeom[] = [
      { top: 20, width: 600, height: 800, widthPx: 600, heightPx: 800 },
    ];

    let linkAtPoint = false;
    const onSelectHighlight = vi.fn();
    const onDismissPopover = vi.fn();

    const engine = createHighlightLayerEngine({
      viewportEl: viewportNode as unknown as HTMLElement,
      getHighlighterMode: () => false,
      isLinkAtPoint: () => linkAtPoint,
      extractSelection: () => null,
      clearActiveSelection: () => {},
      onCreateFromSelection: () => {},
      onSelectHighlight,
      onDismissPopover,
    });

    const older = makeHighlight("older", "yellow", [
      { page_index: 0, rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.04 }] },
    ]);
    const newer = makeHighlight("newer", "pink", [
      { page_index: 0, rects: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.04 }] },
    ]);

    engine.syncVisibleRange({
      documentId: 7,
      renderMin: 0,
      renderMax: 0,
      slotElements: [slot0 as unknown as HTMLDivElement],
      pageOffsets,
      highlightsByPage: groupHighlightsByPage([older, newer]),
    });

    // Clean click on overlapping zone selects newest highlight ("newer") with host-relative anchorRect.
    const overlapX = 100 + 0.3 * 600;
    const overlapY = 56 + 0.22 * 800;
    viewportNode.dispatch("pointerdown", {
      button: 0,
      clientX: overlapX,
      clientY: overlapY,
    });
    viewportNode.dispatch("click", {
      button: 0,
      detail: 1,
      defaultPrevented: false,
      clientX: overlapX,
      clientY: overlapY,
      target: viewportNode,
    });
    expect(onSelectHighlight).toHaveBeenCalledTimes(1);
    expect(onSelectHighlight).toHaveBeenCalledWith(7, "newer", {
      left: 100 + 0.2 * 600,
      top: 20 + 0.2 * 800,
      width: 0.2 * 600,
      height: 0.04 * 800,
    });

    // When a PDF link sits above the highlight, hover is cleared and clicks yield to link-layer.
    linkAtPoint = true;
    viewportNode.dispatch("pointermove", {
      clientX: overlapX,
      clientY: overlapY,
      buttons: 0,
    });
    expect(viewportNode.classList.contains("viewport--highlight-hover")).toBe(
      false,
    );
    viewportNode.dispatch("pointerdown", {
      button: 0,
      clientX: overlapX,
      clientY: overlapY,
    });
    viewportNode.dispatch("click", {
      button: 0,
      detail: 1,
      defaultPrevented: false,
      clientX: overlapX,
      clientY: overlapY,
      target: viewportNode,
    });
    expect(onSelectHighlight).toHaveBeenCalledTimes(1);

    // Dragging > 4px suppresses click selection.
    linkAtPoint = false;
    viewportNode.dispatch("pointerdown", {
      button: 0,
      clientX: overlapX,
      clientY: overlapY,
    });
    viewportNode.dispatch("pointermove", {
      clientX: overlapX + 12,
      clientY: overlapY,
      buttons: 1,
    });
    viewportNode.dispatch("click", {
      button: 0,
      detail: 1,
      defaultPrevented: false,
      clientX: overlapX + 12,
      clientY: overlapY,
      target: viewportNode,
    });
    expect(onSelectHighlight).toHaveBeenCalledTimes(1);

    // Clicking empty page space dismisses popover.
    const emptyX = 100 + 0.8 * 600;
    const emptyY = 56 + 0.8 * 800;
    viewportNode.dispatch("pointerdown", {
      button: 0,
      clientX: emptyX,
      clientY: emptyY,
    });
    viewportNode.dispatch("click", {
      button: 0,
      detail: 1,
      defaultPrevented: false,
      clientX: emptyX,
      clientY: emptyY,
      target: viewportNode,
    });
    expect(onDismissPopover).toHaveBeenCalledTimes(1);

    // Scrolling clears hover and dismisses popover.
    viewportNode.dispatch("pointermove", {
      clientX: overlapX,
      clientY: overlapY,
      buttons: 0,
    });
    expect(viewportNode.classList.contains("viewport--highlight-hover")).toBe(
      true,
    );
    viewportNode.dispatch("scroll", {});
    expect(viewportNode.classList.contains("viewport--highlight-hover")).toBe(
      false,
    );
    expect(onDismissPopover).toHaveBeenCalledTimes(2);

    // Destroy detaches all listeners cleanly.
    engine.destroy();
    viewportNode.dispatch("pointerdown", {
      button: 0,
      clientX: overlapX,
      clientY: overlapY,
    });
    viewportNode.dispatch("click", {
      button: 0,
      detail: 1,
      defaultPrevented: false,
      clientX: overlapX,
      clientY: overlapY,
      target: viewportNode,
    });
    viewportNode.dispatch("scroll", {});
    expect(onSelectHighlight).toHaveBeenCalledTimes(1);
    expect(onDismissPopover).toHaveBeenCalledTimes(2);
  });

  it("captures selections on pointerup only in Highlighter Mode and suppresses trailing click", () => {
    const viewportNode = createMockNode("div");
    viewportNode.rect = makeRect(0, 0, 800, 1000);
    const slot0 = createMockNode("div");
    slot0.rect = makeRect(100, 20, 600, 800);
    viewportNode.appendChild(slot0);

    let highlighterMode = false;
    const extractedSegments = [
      { page_index: 0, rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }] },
    ];
    const clearActiveSelection = vi.fn();
    const onCreateFromSelection = vi.fn();
    const onSelectHighlight = vi.fn();

    const engine = createHighlightLayerEngine({
      viewportEl: viewportNode as unknown as HTMLElement,
      getHighlighterMode: () => highlighterMode,
      isLinkAtPoint: () => false,
      extractSelection: () => ({
        segments: extractedSegments,
        quote: "Captured quote",
      }),
      clearActiveSelection,
      onCreateFromSelection,
      onSelectHighlight,
      onDismissPopover: () => {},
    });

    engine.syncVisibleRange({
      documentId: 3,
      renderMin: 0,
      renderMax: 0,
      slotElements: [slot0 as unknown as HTMLDivElement],
      pageOffsets: [
        { top: 20, width: 600, height: 800, widthPx: 600, heightPx: 800 },
      ],
      highlightsByPage: groupHighlightsByPage([]),
    });

    // Simulate active text selection inside #viewport while Highlighter Mode is OFF.
    mockSelection = {
      isCollapsed: false,
      rangeCount: 1,
      toString: () => "Captured quote",
      getRangeAt: () => ({ commonAncestorContainer: slot0 }),
      removeAllRanges: vi.fn(),
    };
    viewportNode.dispatch("pointerup", {
      button: 0,
      clientX: 200,
      clientY: 200,
    });
    expect(onCreateFromSelection).not.toHaveBeenCalled();

    // Turn Highlighter Mode ON -> pointerup creates highlight, clears selection, suppresses trailing click.
    highlighterMode = true;
    viewportNode.dispatch("pointerdown", {
      button: 0,
      clientX: 150,
      clientY: 200,
    });
    viewportNode.dispatch("pointerup", {
      button: 0,
      clientX: 250,
      clientY: 200,
    });

    expect(clearActiveSelection).toHaveBeenCalledTimes(1);
    expect(onCreateFromSelection).toHaveBeenCalledWith(
      3,
      extractedSegments,
      "Captured quote",
    );

    mockSelection.isCollapsed = true;
    mockSelection.rangeCount = 0;
    viewportNode.dispatch("click", {
      button: 0,
      detail: 1,
      defaultPrevented: false,
      clientX: 250,
      clientY: 200,
      target: viewportNode,
    });
    expect(onSelectHighlight).not.toHaveBeenCalled();

    engine.destroy();
  });

  it("captures Highlighter Mode selection on window pointerup when releasing outside viewport", () => {
    const windowListeners = new Map<string, Set<(event: unknown) => void>>();
    (globalThis as unknown as { window: unknown }).window = {
      getSelection: () => mockSelection,
      addEventListener(type: string, listener: (event: unknown) => void) {
        let set = windowListeners.get(type);
        if (!set) {
          set = new Set();
          windowListeners.set(type, set);
        }
        set.add(listener);
      },
      removeEventListener(type: string, listener: (event: unknown) => void) {
        windowListeners.get(type)?.delete(listener);
      },
    };

    const viewportNode = createMockNode("div");
    viewportNode.rect = makeRect(0, 0, 800, 1000);
    const slot0 = createMockNode("div");
    slot0.rect = makeRect(100, 20, 600, 800);
    viewportNode.appendChild(slot0);

    const extractedSegments = [
      { page_index: 0, rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }] },
    ];
    const clearActiveSelection = vi.fn();
    const onCreateFromSelection = vi.fn();

    const engine = createHighlightLayerEngine({
      viewportEl: viewportNode as unknown as HTMLElement,
      getHighlighterMode: () => true,
      isLinkAtPoint: () => false,
      extractSelection: () => ({
        segments: extractedSegments,
        quote: "Edge drag quote",
      }),
      clearActiveSelection,
      onCreateFromSelection,
      onSelectHighlight: () => {},
      onDismissPopover: () => {},
    });

    engine.syncVisibleRange({
      documentId: 9,
      renderMin: 0,
      renderMax: 0,
      slotElements: [slot0 as unknown as HTMLDivElement],
      pageOffsets: [
        { top: 20, width: 600, height: 800, widthPx: 600, heightPx: 800 },
      ],
      highlightsByPage: groupHighlightsByPage([]),
    });

    mockSelection = {
      isCollapsed: false,
      rangeCount: 1,
      toString: () => "Edge drag quote",
      getRangeAt: () => ({ commonAncestorContainer: slot0 }),
      removeAllRanges: vi.fn(),
    };

    viewportNode.dispatch("pointerdown", {
      button: 0,
      clientX: 150,
      clientY: 200,
    });
    for (const listener of windowListeners.get("pointerup") ?? []) {
      listener({ button: 0, clientX: 850, clientY: 10 });
    }

    expect(clearActiveSelection).toHaveBeenCalledTimes(1);
    expect(onCreateFromSelection).toHaveBeenCalledWith(
      9,
      extractedSegments,
      "Edge drag quote",
    );

    engine.destroy();
    expect(windowListeners.get("pointerup")?.size ?? 0).toBe(0);
    expect(windowListeners.get("pointercancel")?.size ?? 0).toBe(0);
  });
});

describe("text-layer extractSelectionSegments", () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;

  afterEach(() => {
    (globalThis as unknown as { document: unknown }).document =
      originalDocument;
    (globalThis as unknown as { window: unknown }).window = originalWindow;
  });

  it("projects horizontal subRange bounds clamped inside PDFium spans, keeps exact PDFium Y/height, and formats cross-page quotes", async () => {
    const viewportNode = createMockNode("div");
    viewportNode.rect = makeRect(0, 0, 800, 1000);
    const slot0 = createMockNode("div");
    slot0.rect = makeRect(100, 20, 600, 800);
    const slot1 = createMockNode("div");
    slot1.rect = makeRect(100, 840, 600, 800);
    viewportNode.appendChild(slot0);
    viewportNode.appendChild(slot1);

    interface MockRange {
      startContainer: MockDomNode | null;
      startOffset: number;
      endContainer: MockDomNode | null;
      endOffset: number;
      commonAncestorContainer: MockDomNode;
      spanBounds: Map<
        MockDomNode,
        { start: number; end: number; rect: DOMRect }
      >;
      intersectsNode(node: MockDomNode): boolean;
      selectNodeContents(node: MockDomNode): void;
      compareBoundaryPoints(how: number, other: MockRange): number;
      setStart(container: MockDomNode | null, offset: number): void;
      setEnd(container: MockDomNode | null, offset: number): void;
      toString(): string;
      getBoundingClientRect(): DOMRect;
      detach(): void;
    }

    let currentSpanBounds = new Map<
      MockDomNode,
      { start: number; end: number; rect: DOMRect }
    >();
    let activeSelectionRange: MockRange | null = null;

    function createRange(): MockRange {
      let targetSpan: MockDomNode | null = null;
      let startOff = 0;
      let endOff = 0;
      return {
        startContainer: null,
        startOffset: 0,
        endContainer: null,
        endOffset: 0,
        commonAncestorContainer: viewportNode,
        spanBounds: currentSpanBounds,
        intersectsNode(node: MockDomNode) {
          if (node.classList.contains("text-layer")) {
            return node.children.some((c) => currentSpanBounds.has(c));
          }
          return currentSpanBounds.has(node);
        },
        selectNodeContents(node: MockDomNode) {
          targetSpan = node;
          startOff = 0;
          endOff = node.textContent.length;
        },
        compareBoundaryPoints(how: number, other: MockRange) {
          if (!other) {
            return 0;
          }
          // Signal both start and end clipping when a partial span entry exists.
          const span = targetSpan ?? other.startContainer;
          const entry = span ? currentSpanBounds.get(span) : undefined;
          if (how === 0) {
            return entry && entry.start > 0 ? 1 : 0;
          }
          return entry && entry.end < (span?.textContent.length ?? 0) ? -1 : 0;
        },
        setStart(container: MockDomNode | null, offset: number) {
          if (container) {
            targetSpan = container;
          }
          startOff = offset;
        },
        setEnd(container: MockDomNode | null, offset: number) {
          if (container) {
            targetSpan = container;
          }
          endOff = offset;
        },
        toString() {
          if (!targetSpan) {
            return "";
          }
          const entry = currentSpanBounds.get(targetSpan);
          if (entry) {
            return targetSpan.textContent.slice(entry.start, entry.end);
          }
          return targetSpan.textContent.slice(startOff, endOff);
        },
        getBoundingClientRect() {
          if (!targetSpan) {
            return makeRect(0, 0, 0, 0);
          }
          return (
            currentSpanBounds.get(targetSpan)?.rect ?? makeRect(0, 0, 0, 0)
          );
        },
        detach() {},
      };
    }

    (globalThis as unknown as { document: unknown }).document = {
      createElement: (tag: string) => createMockNode(tag),
      createDocumentFragment: () => createMockNode("__FRAGMENT__"),
      createRange,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (globalThis as unknown as { window: unknown }).window = {
      getSelection: () =>
        activeSelectionRange
          ? {
              isCollapsed: false,
              rangeCount: 1,
              getRangeAt: () => activeSelectionRange,
              removeAllRanges: vi.fn(),
            }
          : { isCollapsed: true, rangeCount: 0 },
    };

    const page0Spans: TextSpan[] = [
      {
        text: "Hello",
        rect: { x: 0.1, y: 0.2, width: 0.1, height: 0.02 },
      },
      {
        text: " ",
        rect: { x: 0.2, y: 0.2, width: 0.01, height: 0.02 },
      },
      {
        text: "world",
        rect: { x: 0.21, y: 0.2, width: 0.1, height: 0.02 },
      },
    ];
    const page1Spans: TextSpan[] = [
      {
        text: "Next page",
        rect: { x: 0.15, y: 0.1, width: 0.2, height: 0.025 },
      },
    ];

    const engine = createTextLayerEngine({
      viewportEl: viewportNode as unknown as HTMLElement,
      api: {
        getPageText: async (_docId, pageIndex) =>
          pageIndex === 0 ? page0Spans : page1Spans,
      },
    });

    const pageDimensions: PageDimensions[] = [
      { width_pt: 600, height_pt: 800 },
      { width_pt: 600, height_pt: 800 },
    ];
    const pageOffsets: PageLayoutGeom[] = [
      { top: 20, width: 600, height: 800, widthPx: 600, heightPx: 800 },
      { top: 840, width: 600, height: 800, widthPx: 600, heightPx: 800 },
    ];

    engine.syncVisibleRange({
      documentId: 1,
      pageDimensions,
      firstVisible: 0,
      lastVisible: 1,
      renderMin: 0,
      renderMax: 1,
      slotElements: [
        slot0 as unknown as HTMLDivElement,
        slot1 as unknown as HTMLDivElement,
      ],
      pageOffsets,
    });

    await vi.waitFor(() => {
      expect(slot0.children).toHaveLength(1);
      expect(slot1.children).toHaveLength(1);
    });

    const p0Spans = slot0.children[0]!.children;
    const p1Spans = slot1.children[0]!.children;

    // Deliberately overshoot span0 left & span2 right edges and exaggerate heights to verify clamping + Y snapping.
    currentSpanBounds = new Map([
      [
        p0Spans[0]!,
        {
          start: 2,
          end: 5, // "llo"
          rect: makeRect(100 + 0.05 * 600, 100, 0.15 * 600, 99),
        },
      ],
      [
        p0Spans[1]!,
        {
          start: 0,
          end: 1, // whitespace only -> preserved in quote, excluded from rects
          rect: makeRect(100 + 0.2 * 600, 100, 0.01 * 600, 99),
        },
      ],
      [
        p0Spans[2]!,
        {
          start: 0,
          end: 3, // "wor"
          rect: makeRect(100 + 0.21 * 600, 100, 0.14 * 600, 99),
        },
      ],
      [
        p1Spans[0]!,
        {
          start: 0,
          end: 4, // "Next"
          rect: makeRect(100 + 0.15 * 600, 900, 0.09 * 600, 99),
        },
      ],
    ]);
    activeSelectionRange = createRange();

    const extracted = engine.extractSelectionSegments([
      slot0 as unknown as HTMLDivElement,
      slot1 as unknown as HTMLDivElement,
    ]);

    expect(extracted).not.toBeNull();
    expect(extracted?.quote).toBe("llo wor\nNext");
    expect(extracted?.segments).toHaveLength(2);

    // Page 0: "llo" clamped left [0.10..0.20] + "wor" clamped right [0.21..0.31] merge into [0.10..0.31].
    const p0Rects = extracted!.segments[0]!.rects;
    expect(p0Rects).toHaveLength(1);
    expect(p0Rects[0]!.x).toBeCloseTo(0.1, 6);
    expect(p0Rects[0]!.y).toBeCloseTo(0.2, 6);
    expect(p0Rects[0]!.width).toBeCloseTo(0.21, 6);
    expect(p0Rects[0]!.height).toBeCloseTo(0.02, 6);

    const p1Rects = extracted!.segments[1]!.rects;
    expect(p1Rects).toHaveLength(1);
    expect(p1Rects[0]!.x).toBeCloseTo(0.15, 6);
    expect(p1Rects[0]!.y).toBeCloseTo(0.1, 6);
    expect(p1Rects[0]!.width).toBeCloseTo(0.09, 6);
    expect(p1Rects[0]!.height).toBeCloseTo(0.025, 6);

    engine.destroy();
  });
});
