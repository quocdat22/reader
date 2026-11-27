import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageLink } from "../../ipc/types";
import {
  createLinkLayerEngine,
  formatLinkAriaLabel,
  formatLinkTooltip,
  hitTestPageLinks,
} from "../link-layer";
import type { PageLayoutGeom } from "../viewport-math";

interface MockClassList {
  add(name: string): void;
  remove(name: string): void;
  contains(name: string): boolean;
}

interface MockDomNode {
  tagName: string;
  type: string;
  className: string;
  classList: MockClassList;
  attributes: Record<string, string>;
  style: Record<string, string>;
  children: MockDomNode[];
  scrollTop: number;
  rect: DOMRect;
  appendChild(child: MockDomNode): MockDomNode;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getBoundingClientRect(): DOMRect;
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

  const node: MockDomNode = {
    tagName: tagName.toUpperCase(),
    type: "",
    className: "",
    classList: {
      add(name: string) {
        classes.add(name);
        node.className = Array.from(classes).join(" ");
      },
      remove(name: string) {
        classes.delete(name);
        node.className = Array.from(classes).join(" ");
      },
      contains(name: string) {
        return classes.has(name);
      },
    },
    attributes: {},
    style: {},
    children: [],
    scrollTop: 0,
    rect: makeRect(0, 0, 800, 1000),
    appendChild(child: MockDomNode): MockDomNode {
      if (child.tagName === "__FRAGMENT__") {
        node.children.push(...child.children);
        child.children = [];
      } else {
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
      // No-op in headless harness.
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

describe("link-layer pure helpers", () => {
  const internalLink: PageLink = {
    rects: [
      { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
      { x: 0.1, y: 0.25, width: 0.2, height: 0.05 },
    ],
    target: {
      kind: "internal",
      page_index: 4,
      target_point: { x: 0.1, y: 0.2 },
      target_rect: null,
    },
  };

  const overlappingExternal: PageLink = {
    rects: [{ x: 0.2, y: 0.21, width: 0.15, height: 0.04 }],
    target: {
      kind: "external",
      uri: "https://example.com/docs",
    },
  };

  it("hit-tests multi-rect links and picks top-most annotation on overlap", () => {
    const links = [internalLink, overlappingExternal];

    expect(hitTestPageLinks(links, 0.15, 0.22)).toBe(0);
    expect(hitTestPageLinks(links, 0.15, 0.27)).toBe(0);
    expect(hitTestPageLinks(links, 0.25, 0.22)).toBe(1);
    expect(hitTestPageLinks(links, 0.8, 0.8)).toBe(-1);
    expect(hitTestPageLinks(links, -0.1, 0.2)).toBe(-1);
  });

  it("formats link tooltips and ARIA labels concisely", () => {
    expect(formatLinkTooltip(internalLink)).toBe("Go to page 5");
    expect(formatLinkAriaLabel(internalLink)).toBe("Go to page 5");
    expect(formatLinkTooltip(overlappingExternal)).toBe(
      "https://example.com/docs",
    );
    expect(formatLinkAriaLabel(overlappingExternal)).toBe(
      "Open link https://example.com/docs",
    );
  });
});

describe("createLinkLayerEngine", () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;

  beforeEach(() => {
    (globalThis as unknown as { document: unknown }).document = {
      createElement: (tag: string) => createMockNode(tag),
      createDocumentFragment: () => createMockNode("__FRAGMENT__"),
    };
    (globalThis as unknown as { window: unknown }).window = {
      getSelection: () => ({ isCollapsed: true, toString: () => "" }),
    };
  });

  afterEach(() => {
    (globalThis as unknown as { document: unknown }).document =
      originalDocument;
    (globalThis as unknown as { window: unknown }).window = originalWindow;
  });

  it("fetches links lazily, renders multi-quad groups, handles hover/tooltip, and ignores drags", async () => {
    const viewportNode = createMockNode("div");
    viewportNode.rect = makeRect(0, 0, 800, 1000);
    const slot0 = createMockNode("div");
    slot0.rect = makeRect(100, 20, 600, 800);
    const slot1 = createMockNode("div");
    slot1.rect = makeRect(100, 836, 600, 800);

    const sampleLinks: PageLink[] = [
      {
        rects: [
          { x: 0.5, y: 0.1, width: 0.4, height: 0.05 },
          { x: 0.1, y: 0.16, width: 0.3, height: 0.05 },
        ],
        target: {
          kind: "external",
          uri: "https://example.com/wrapped",
        },
      },
    ];

    const getPageLinks = vi.fn(async (_docId: number, pageIndex: number) =>
      pageIndex === 0 ? sampleLinks : [],
    );
    const onActivateLink = vi.fn();

    const engine = createLinkLayerEngine({
      viewportEl: viewportNode as unknown as HTMLElement,
      api: { getPageLinks },
      onActivateLink,
    });

    const pageOffsets: PageLayoutGeom[] = [
      { top: 20, width: 600, height: 800, widthPx: 600, heightPx: 800 },
      { top: 836, width: 600, height: 800, widthPx: 600, heightPx: 800 },
    ];

    engine.syncVisibleRange({
      documentId: 1,
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
    });
    // Page 1 had 0 links, so no empty .link-layer DOM node is mounted.
    expect(slot1.children).toHaveLength(0);

    const layer = slot0.children[0]!;
    expect(layer.className).toBe("link-layer");
    const group = layer.children[0]!;
    expect(group.children).toHaveLength(2);
    expect(group.children[0]?.tagName).toBe("BUTTON");
    expect(group.children[1]?.tagName).toBe("SPAN");

    // Hovering inside second quad activates hover class, cursor class, and native title.
    viewportNode.dispatch("pointermove", {
      clientX: 100 + 0.2 * 600,
      clientY: 20 + 0.18 * 800,
      buttons: 0,
    });
    expect(viewportNode.classList.contains("viewport--link-hover")).toBe(true);
    expect(viewportNode.attributes.title).toBe("https://example.com/wrapped");
    expect(group.classList.contains("pdf-link-group--hover")).toBe(true);

    // Dragging (> 4px) suppresses link activation so text selection is unobstructed.
    viewportNode.dispatch("pointerdown", {
      button: 0,
      clientX: 100 + 0.2 * 600,
      clientY: 20 + 0.18 * 800,
    });
    viewportNode.dispatch("pointermove", {
      clientX: 100 + 0.2 * 600 + 20,
      clientY: 20 + 0.18 * 800,
      buttons: 1,
    });
    viewportNode.dispatch("click", {
      button: 0,
      detail: 1,
      defaultPrevented: false,
      clientX: 100 + 0.2 * 600 + 20,
      clientY: 20 + 0.18 * 800,
      target: viewportNode,
    });
    expect(onActivateLink).not.toHaveBeenCalled();

    // Clean non-drag click activates link.
    viewportNode.dispatch("pointerdown", {
      button: 0,
      clientX: 100 + 0.6 * 600,
      clientY: 20 + 0.12 * 800,
    });
    viewportNode.dispatch("click", {
      button: 0,
      detail: 1,
      defaultPrevented: false,
      clientX: 100 + 0.6 * 600,
      clientY: 20 + 0.12 * 800,
      target: viewportNode,
    });
    expect(onActivateLink).toHaveBeenCalledTimes(1);
    expect(onActivateLink).toHaveBeenCalledWith(1, sampleLinks[0]);

    // Exposes synchronous cached link presence check for highlight-layer coordination.
    expect(engine.hasLinkAtClientPoint(100 + 0.6 * 600, 20 + 0.12 * 800)).toBe(
      true,
    );
    expect(engine.hasLinkAtClientPoint(100 + 0.2 * 600, 20 + 0.18 * 800)).toBe(
      true,
    );
    expect(engine.hasLinkAtClientPoint(100 + 0.85 * 600, 20 + 0.85 * 800)).toBe(
      false,
    );

    engine.evictOutside(1, 1);
    expect(engine.hasLinkAtClientPoint(100 + 0.6 * 600, 20 + 0.12 * 800)).toBe(
      true,
    ); // Cached page links remain queryable via peek cache while pageOffsets exist.

    engine.clearMounted();
    expect(engine.hasLinkAtClientPoint(100 + 0.6 * 600, 20 + 0.12 * 800)).toBe(
      false,
    );

    engine.destroy();
  });
});
