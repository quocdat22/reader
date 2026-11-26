import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageDimensions } from "../../ipc/types";
import type { ViewportSnapshot } from "../../state/types";
import { createViewportEngine } from "../viewport";

const LETTER_PAGE: PageDimensions = { width_pt: 612, height_pt: 792 };

interface HarnessNode {
  className: string;
  dataset: Record<string, string>;
  style: Record<string, string>;
  children: HarnessNode[];
  appendChild(child: HarnessNode): HarnessNode;
  setAttribute(name: string, value: string): void;
  getContext(kind: string): { putImageData: ReturnType<typeof vi.fn> } | null;
  remove(): void;
}

function createHarnessNode(): HarnessNode {
  const ctx = { putImageData: vi.fn() };
  const node: HarnessNode = {
    className: "",
    dataset: {},
    style: {},
    children: [],
    appendChild(child: HarnessNode): HarnessNode {
      if ("children" in child && Array.isArray(child.children)) {
        if (child.className === "__fragment__") {
          node.children.push(...child.children);
          child.children = [];
        } else {
          node.children.push(child);
        }
      }
      return child;
    },
    setAttribute() {
      // No-op in headless harness.
    },
    getContext(kind: string) {
      return kind === "2d" ? ctx : null;
    },
    remove() {
      // No-op in headless harness.
    },
  };
  return node;
}

interface ViewportHarness {
  viewportEl: HTMLElement;
  trackEl: HTMLElement;
  setViewportSize(width: number, height: number): void;
  setScrollTop(value: number): void;
  triggerResize(): void;
  flushRaf(): void;
}

function createViewportHarness(
  initialWidth: number,
  initialHeight: number,
): ViewportHarness {
  let clientWidth = initialWidth;
  let clientHeight = initialHeight;
  let scrollTopValue = 0;
  let scrollLeftValue = 0;
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const resizeCallbacks: ResizeObserverCallback[] = [];
  let rafSeq = 1;
  const rafQueue = new Map<number, FrameRequestCallback>();

  const trackStyle: Record<string, string> = {
    height: "0px",
    width: "100%",
  };
  const trackNode = createHarnessNode();
  trackNode.style = trackStyle;

  function parseCssPx(raw: string | undefined): number {
    if (!raw) {
      return 0;
    }
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function getScrollHeight(): number {
    if (clientWidth === 0 || clientHeight === 0) {
      return 0;
    }
    return Math.max(clientHeight, parseCssPx(trackStyle.height));
  }

  function getScrollWidth(): number {
    if (clientWidth === 0 || clientHeight === 0) {
      return 0;
    }
    return Math.max(clientWidth, parseCssPx(trackStyle.width));
  }

  function clampScrollTop(next: number): number {
    const maxTop = Math.max(0, getScrollHeight() - clientHeight);
    return Math.max(0, Math.min(next, maxTop));
  }

  function dispatchScrollEvent(): void {
    const set = listeners.get("scroll");
    if (!set) {
      return;
    }
    const event = { type: "scroll" } as Event;
    for (const listener of set) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
  }

  const viewportMock = {
    get clientWidth() {
      return clientWidth;
    },
    get clientHeight() {
      return clientHeight;
    },
    get scrollHeight() {
      return getScrollHeight();
    },
    get scrollWidth() {
      return getScrollWidth();
    },
    get scrollTop() {
      return scrollTopValue;
    },
    set scrollTop(next: number) {
      const clamped = clampScrollTop(next);
      const changed = clamped !== scrollTopValue;
      scrollTopValue = clamped;
      if (changed) {
        dispatchScrollEvent();
      }
    },
    get scrollLeft() {
      return scrollLeftValue;
    },
    set scrollLeft(next: number) {
      const maxLeft = Math.max(0, getScrollWidth() - clientWidth);
      scrollLeftValue = Math.max(0, Math.min(next, maxLeft));
    },
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) {
      listeners.get(type)?.delete(listener);
    },
    focus: vi.fn(),
    scrollTo: vi.fn((options?: ScrollToOptions | number, y?: number) => {
      if (typeof options === "number") {
        viewportMock.scrollTop = y ?? 0;
        return;
      }
      if (options && typeof options.top === "number") {
        viewportMock.scrollTop = options.top;
      }
      if (options && typeof options.left === "number") {
        viewportMock.scrollLeft = options.left;
      }
    }),
  };

  let textContentValue = "";
  const trackMock = {
    style: trackStyle,
    get textContent() {
      return textContentValue;
    },
    set textContent(next: string) {
      textContentValue = next;
      if (next === "") {
        trackNode.children = [];
      }
    },
    appendChild(child: HarnessNode) {
      return trackNode.appendChild(child);
    },
  };

  vi.stubGlobal("window", {
    devicePixelRatio: 1,
    innerWidth: 1100,
    innerHeight: 800,
    matchMedia: () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });

  vi.stubGlobal("document", {
    createDocumentFragment() {
      const frag = createHarnessNode();
      frag.className = "__fragment__";
      return frag;
    },
    createElement() {
      return createHarnessNode();
    },
  });

  vi.stubGlobal(
    "ResizeObserver",
    class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        resizeCallbacks.push(cb);
      }
      observe() {
        // No-op in headless harness.
      }
      unobserve() {
        // No-op in headless harness.
      }
      disconnect() {
        // No-op in headless harness.
      }
    },
  );

  vi.stubGlobal(
    "IntersectionObserver",
    class MockIntersectionObserver {
      observe() {
        // No-op in headless harness.
      }
      unobserve() {
        // No-op in headless harness.
      }
      disconnect() {
        // No-op in headless harness.
      }
    },
  );

  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = rafSeq++;
    rafQueue.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafQueue.delete(id);
  });

  return {
    viewportEl: viewportMock as unknown as HTMLElement,
    trackEl: trackMock as unknown as HTMLElement,
    setViewportSize(width: number, height: number) {
      clientWidth = width;
      clientHeight = height;
      scrollTopValue = clampScrollTop(scrollTopValue);
    },
    setScrollTop(value: number) {
      viewportMock.scrollTop = value;
    },
    triggerResize() {
      for (const cb of resizeCallbacks) {
        cb([], {} as ResizeObserver);
      }
    },
    flushRaf() {
      const callbacks = Array.from(rafQueue.values());
      rafQueue.clear();
      for (const cb of callbacks) {
        cb(16);
      }
    },
  };
}

describe("createViewportEngine scroll & page jump behavior", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("scrolls to target pages via scrollToPage and updates when scrolling back manually", () => {
    const harness = createViewportHarness(1000, 720);
    const snapshots: ViewportSnapshot[] = [];
    const renderPage = vi.fn(
      async ({ widthPx, heightPx }: { widthPx: number; heightPx: number }) =>
        ({
          width: widthPx,
          height: heightPx,
          data: new Uint8ClampedArray(widthPx * heightPx * 4),
        }) as unknown as ImageData,
    );

    const engine = createViewportEngine({
      viewportEl: harness.viewportEl,
      trackEl: harness.trackEl,
      api: { renderPage },
      onViewStateChange: (snapshot) => {
        snapshots.push(snapshot);
      },
    });

    engine.mountDocument({
      documentId: 1,
      pageDimensions: Array.from({ length: 10 }, () => LETTER_PAGE),
      pageIndex: 0,
      scrollTop: null,
      scrollAnchor: null,
      zoomMode: "fit_width",
      zoomScale: 1.0,
    });

    expect(snapshots.at(-1)?.pageIndex).toBe(0);
    expect(harness.viewportEl.scrollHeight).toBeGreaterThan(
      harness.viewportEl.clientHeight,
    );

    engine.scrollToPage(4);
    harness.flushRaf();
    expect(harness.viewportEl.scrollTop).toBeGreaterThan(2000);
    expect(snapshots.at(-1)?.pageIndex).toBe(4);

    harness.setScrollTop(0);
    harness.flushRaf();
    expect(snapshots.at(-1)?.pageIndex).toBe(0);

    engine.destroy();
  });

  it("preserves zoomed-out bottom jump target page across clamped scroll events", () => {
    const harness = createViewportHarness(1000, 720);
    const snapshots: ViewportSnapshot[] = [];
    const engine = createViewportEngine({
      viewportEl: harness.viewportEl,
      trackEl: harness.trackEl,
      api: {
        renderPage: vi.fn(
          async ({
            widthPx,
            heightPx,
          }: {
            widthPx: number;
            heightPx: number;
          }) =>
            ({
              width: widthPx,
              height: heightPx,
              data: new Uint8ClampedArray(widthPx * heightPx * 4),
            }) as unknown as ImageData,
        ),
      },
      onViewStateChange: (snapshot) => {
        snapshots.push(snapshot);
      },
    });

    engine.mountDocument({
      documentId: 2,
      pageDimensions: Array.from({ length: 5 }, () => LETTER_PAGE),
      pageIndex: 0,
      scrollTop: null,
      scrollAnchor: null,
      zoomMode: "custom",
      zoomScale: 0.25,
    });

    engine.scrollToPage(3);
    harness.flushRaf();
    expect(snapshots.at(-1)?.pageIndex).toBe(3);

    harness.setScrollTop(0);
    harness.flushRaf();
    expect(snapshots.at(-1)?.pageIndex).toBe(0);

    engine.destroy();
  });

  it("restores initial saved pageIndex after pre-layout 0x0 mount receives ResizeObserver size", () => {
    const harness = createViewportHarness(0, 0);
    const snapshots: ViewportSnapshot[] = [];
    const engine = createViewportEngine({
      viewportEl: harness.viewportEl,
      trackEl: harness.trackEl,
      api: {
        renderPage: vi.fn(
          async ({
            widthPx,
            heightPx,
          }: {
            widthPx: number;
            heightPx: number;
          }) =>
            ({
              width: widthPx,
              height: heightPx,
              data: new Uint8ClampedArray(widthPx * heightPx * 4),
            }) as unknown as ImageData,
        ),
      },
      onViewStateChange: (snapshot) => {
        snapshots.push(snapshot);
      },
    });

    engine.mountDocument({
      documentId: 3,
      pageDimensions: Array.from({ length: 8 }, () => LETTER_PAGE),
      pageIndex: 4,
      scrollTop: null,
      scrollAnchor: null,
      zoomMode: "custom",
      zoomScale: 1.0,
    });

    expect(harness.viewportEl.scrollTop).toBe(0);
    harness.setViewportSize(1000, 720);
    harness.triggerResize();
    harness.flushRaf();

    expect(harness.viewportEl.scrollTop).toBeGreaterThan(2000);
    expect(snapshots.at(-1)?.pageIndex).toBe(4);

    engine.destroy();
  });

  it("supports CR-009 scrollToTarget, scrollToAnchor, and linkLayer lifecycle forwarding", async () => {
    const harness = createViewportHarness(600, 720);
    const snapshots: ViewportSnapshot[] = [];
    const syncVisibleRange = vi.fn();
    const evictOutside = vi.fn();
    const clearMounted = vi.fn();
    const renderPage = vi.fn(
      async ({ widthPx, heightPx }: { widthPx: number; heightPx: number }) =>
        ({
          width: widthPx,
          height: heightPx,
          data: new Uint8ClampedArray(widthPx * heightPx * 4),
        }) as unknown as ImageData,
    );

    const engine = createViewportEngine({
      viewportEl: harness.viewportEl,
      trackEl: harness.trackEl,
      api: { renderPage },
      linkLayer: {
        syncVisibleRange,
        evictOutside,
        clearMounted,
      },
      onViewStateChange: (snapshot) => {
        snapshots.push(snapshot);
      },
    });

    engine.mountDocument({
      documentId: 1,
      pageDimensions: Array.from({ length: 12 }, () => LETTER_PAGE),
      pageIndex: 0,
      scrollTop: null,
      scrollAnchor: null,
      zoomMode: "custom",
      zoomScale: 2.0,
    });
    harness.flushRaf();

    expect(syncVisibleRange).toHaveBeenCalled();

    engine.scrollToTarget({
      pageIndex: 8,
      point: { x: 0.75, y: 0.4 },
    });
    harness.flushRaf();

    const jumpedScrollTop = harness.viewportEl.scrollTop;
    expect(jumpedScrollTop).toBeGreaterThan(5000);
    expect(harness.viewportEl.scrollLeft).toBeGreaterThan(0);
    expect(snapshots.at(-1)?.pageIndex).toBe(8);
    expect(evictOutside).toHaveBeenCalled();

    const anchor = snapshots.at(-1)?.scrollAnchor ?? null;
    expect(anchor).not.toBeNull();

    engine.scrollToTarget({
      pageIndex: 2,
      rect: { x: 0.1, y: 0.5, width: 0.5, height: 0.1 },
    });
    harness.flushRaf();
    expect(snapshots.at(-1)?.pageIndex).toBe(2);

    engine.scrollToAnchor({ pageIndex: 8, scrollAnchor: anchor });
    harness.flushRaf();
    expect(
      Math.abs(harness.viewportEl.scrollTop - jumpedScrollTop),
    ).toBeLessThan(4);

    await Promise.resolve();
    const clearCallsBeforeUnmount = clearMounted.mock.calls.length;
    engine.unmount();
    expect(clearMounted).toHaveBeenCalledTimes(clearCallsBeforeUnmount + 1);

    engine.destroy();
  });
});
