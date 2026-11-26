import type { PageSearchEntry } from "../domain/search";
import { clampZoom } from "../domain/zoom";
import type { ReaderApi } from "../ipc/client";
import { isCancelledError } from "../ipc/errors";
import type {
  NormalizedRect,
  PageDimensions,
  SearchMatch,
  ZoomMode,
} from "../ipc/types";
import type {
  ScrollAnchor,
  ViewportAnchorTarget,
  ViewportLinkTarget,
  ViewportSnapshot,
} from "../state/types";
import {
  EVICT_RADIUS,
  MAX_CONCURRENT_RENDERS,
  OVERSCAN_RADIUS,
  TRACK_PADDING_Y,
  computeEffectiveScale,
  computeLayoutGeometry,
  computeScrollAnchor,
  computeTabScrollAnchor,
  computeTrackWidth,
  getEffectiveDpr,
  resolveAnchorScrollTop,
  resolveVisibleRange,
  snapToDevicePixels,
  type PageLayoutGeom,
} from "./viewport-math";

export interface ViewportSearchInput {
  readonly open: boolean;
  readonly matches: readonly SearchMatch[];
  readonly matchesByPage: ReadonlyMap<number, readonly PageSearchEntry[]>;
  readonly currentIndex: number;
}

export interface ViewportMountInput {
  readonly documentId: number;
  readonly pageDimensions: readonly PageDimensions[];
  readonly pageIndex: number;
  readonly scrollTop: number | null;
  readonly scrollAnchor: ScrollAnchor | null;
  readonly zoomMode: ZoomMode;
  readonly zoomScale: number;
  readonly search?: ViewportSearchInput | null;
  readonly signal?: AbortSignal | null;
}

export interface TextLayerViewportBridge {
  syncVisibleRange(params: {
    documentId: number;
    pageDimensions: readonly PageDimensions[];
    signal?: AbortSignal | null;
    firstVisible: number;
    lastVisible: number;
    renderMin: number;
    renderMax: number;
    slotElements: readonly HTMLDivElement[];
    pageOffsets: readonly PageLayoutGeom[];
  }): void;
  evictOutside(
    keepMin: number,
    keepMax: number,
    slotElements: readonly HTMLDivElement[],
  ): void;
  rescaleMounted(
    slotElements: readonly HTMLDivElement[],
    pageOffsets: readonly PageLayoutGeom[],
    pageDimensions: readonly PageDimensions[],
  ): void;
  clearActiveSelection(): void;
  clearMounted(): void;
}

export interface LinkLayerViewportBridge {
  syncVisibleRange(params: {
    documentId: number;
    signal?: AbortSignal | null;
    firstVisible: number;
    lastVisible: number;
    renderMin: number;
    renderMax: number;
    slotElements: readonly HTMLDivElement[];
    pageOffsets: readonly PageLayoutGeom[];
  }): void;
  evictOutside(keepMin: number, keepMax: number): void;
  clearMounted(): void;
}

export interface ViewportEngineOptions {
  readonly viewportEl: HTMLElement;
  readonly trackEl: HTMLElement;
  readonly api: Pick<ReaderApi, "renderPage">;
  readonly textLayer?: TextLayerViewportBridge;
  readonly linkLayer?: LinkLayerViewportBridge;
  readonly onViewStateChange: (
    snapshot: ViewportSnapshot,
    reason: "mount" | "user",
  ) => void;
}

export interface ViewportEngine {
  mountDocument(input: ViewportMountInput): void;
  unmount(): void;
  scrollToPage(pageIndex: number): void;
  scrollToTarget(target: ViewportLinkTarget): void;
  scrollToAnchor(target: ViewportAnchorTarget): void;
  scrollToNormalizedRect(pageIndex: number, rect?: NormalizedRect | null): void;
  syncSearchHighlights(search: ViewportSearchInput | null): void;
  scrollPageStep(direction: 1 | -1): void;
  scrollToStart(): void;
  scrollToEnd(): void;
  focus(): void;
  setZoomMode(mode: ZoomMode): void;
  setCustomZoom(scale: number): void;
  captureSnapshot(): ViewportSnapshot | null;
  getMountedCanvasCount(): number;
  destroy(): void;
}

interface MountedDocState {
  readonly documentId: number;
  readonly pageDimensions: readonly PageDimensions[];
  readonly signal: AbortSignal | null;
  pageIndex: number;
  scrollTop: number | null;
  scrollAnchor: ScrollAnchor | null;
  zoomMode: ZoomMode;
  zoomScale: number;
}

interface RenderedCanvasEntry {
  readonly canvas: HTMLCanvasElement;
  epoch: number;
}

function releaseCanvas(canvas: HTMLCanvasElement | undefined): void {
  if (!canvas) {
    return;
  }
  canvas.width = 0;
  canvas.height = 0;
  canvas.remove();
}

/**
 * Imperative virtualized HiDPI `<canvas>` viewport engine.
 * Keeps all DOM nodes, canvas backing stores, and render epochs out of reactive Svelte state.
 */
export function createViewportEngine({
  viewportEl,
  trackEl,
  api,
  textLayer,
  linkLayer,
  onViewStateChange,
}: ViewportEngineOptions): ViewportEngine {
  let activeDoc: MountedDocState | null = null;
  let currentSearch: ViewportSearchInput | null = null;
  let pageOffsets: PageLayoutGeom[] = [];
  let slotElements: HTMLDivElement[] = [];
  const renderedCanvases = new Map<number, RenderedCanvasEntry>();
  const searchLayers = new Map<number, HTMLElement>();
  const inFlightPages = new Set<number>();
  let pendingQueue: number[] = [];

  let renderEpoch = 0;
  let activeRenders = 0;
  let scrollRafId: number | null = null;
  let resizeRafId: number | null = null;
  let lastViewportWidth = 0;
  let lastViewportHeight = 0;
  let currentMaxPageWidth = 0;
  let currentTrackHeight = 0;
  let currentDpr = getEffectiveDpr();
  let intersectionObserver: IntersectionObserver | null = null;
  let dprMediaQuery: MediaQueryList | null = null;
  let pinnedJump: { pageIndex: number; scrollTop: number } | null = null;
  let pendingInitialPositionRestore = false;
  let destroyed = false;

  function bumpEpoch(): number {
    renderEpoch += 1;
    pendingQueue = [];
    inFlightPages.clear();
    return renderEpoch;
  }

  function getViewportWidth(): number {
    return viewportEl.clientWidth || window.innerWidth || 900;
  }

  function getViewportHeight(): number {
    return viewportEl.clientHeight || window.innerHeight || 700;
  }

  function applyTrackSize(
    totalHeight: number,
    maxPageWidth: number,
    dpr: number,
  ): number {
    currentTrackHeight = totalHeight;
    currentMaxPageWidth = maxPageWidth;
    const trackWidth = computeTrackWidth(maxPageWidth, getViewportWidth(), dpr);
    trackEl.style.height = `${snapToDevicePixels(totalHeight, dpr)}px`;
    trackEl.style.width = `${trackWidth}px`;
    return trackWidth;
  }

  function applySlotHorizontalPositions(trackWidth: number, dpr: number): void {
    for (let i = 0; i < slotElements.length; i += 1) {
      const slot = slotElements[i];
      const geom = pageOffsets[i];
      if (!slot || !geom) {
        continue;
      }
      const left = snapToDevicePixels(
        Math.max(0, (trackWidth - geom.width) / 2),
        dpr,
      );
      slot.style.left = `${left}px`;
    }
  }

  function applySlotStyles(trackWidth: number, dpr: number): void {
    for (let i = 0; i < slotElements.length; i += 1) {
      const slot = slotElements[i];
      const geom = pageOffsets[i];
      if (!slot || !geom) {
        continue;
      }
      const left = snapToDevicePixels(
        Math.max(0, (trackWidth - geom.width) / 2),
        dpr,
      );
      slot.style.top = `${geom.top}px`;
      slot.style.left = `${left}px`;
      slot.style.width = `${geom.width}px`;
      slot.style.height = `${geom.height}px`;
    }
  }

  function getCurrentVisibleRange() {
    return resolveVisibleRange(
      pageOffsets,
      viewportEl.scrollTop,
      getViewportHeight(),
      viewportEl.scrollHeight,
    );
  }

  function clearSearchLayer(pageIndex: number): void {
    const layer = searchLayers.get(pageIndex);
    if (layer) {
      layer.remove();
      searchLayers.delete(pageIndex);
    }
  }

  function clearAllSearchLayers(): void {
    for (const layer of searchLayers.values()) {
      layer.remove();
    }
    searchLayers.clear();
  }

  function renderPageSearchLayer(pageIndex: number): void {
    const slot = slotElements[pageIndex];
    if (!slot || !currentSearch?.open) {
      clearSearchLayer(pageIndex);
      return;
    }

    const pageMatches = currentSearch.matchesByPage.get(pageIndex);
    if (!pageMatches || pageMatches.length === 0) {
      clearSearchLayer(pageIndex);
      return;
    }

    let layerEl = searchLayers.get(pageIndex);
    if (!layerEl) {
      layerEl = document.createElement("div");
      layerEl.className = "search-layer";
      layerEl.setAttribute("aria-hidden", "true");
      slot.appendChild(layerEl);
      searchLayers.set(pageIndex, layerEl);
    } else {
      layerEl.textContent = "";
    }

    const fragment = document.createDocumentFragment();
    for (const entry of pageMatches) {
      const isActive = entry.matchIndex === currentSearch.currentIndex;
      for (const rect of entry.rects) {
        const hitEl = document.createElement("div");
        hitEl.className = isActive
          ? "search-hit search-hit--active"
          : "search-hit";
        hitEl.style.left = `${(rect.x * 100).toFixed(4)}%`;
        hitEl.style.top = `${(rect.y * 100).toFixed(4)}%`;
        hitEl.style.width = `${(rect.width * 100).toFixed(4)}%`;
        hitEl.style.height = `${(rect.height * 100).toFixed(4)}%`;
        fragment.appendChild(hitEl);
      }
    }
    layerEl.appendChild(fragment);
  }

  function syncSearchLayersForRange(
    renderMin: number,
    renderMax: number,
  ): void {
    if (!currentSearch?.open || currentSearch.matches.length === 0) {
      clearAllSearchLayers();
      return;
    }

    for (const pageIndex of Array.from(searchLayers.keys())) {
      if (pageIndex < renderMin || pageIndex > renderMax) {
        clearSearchLayer(pageIndex);
      }
    }

    for (let i = renderMin; i <= renderMax; i += 1) {
      renderPageSearchLayer(i);
    }
  }

  function evictDistantCanvases(
    firstVisible: number,
    lastVisible: number,
  ): void {
    const keepMin = Math.max(0, firstVisible - EVICT_RADIUS);
    const keepMax = Math.min(
      pageOffsets.length - 1,
      lastVisible + EVICT_RADIUS,
    );

    for (const [pageIndex, entry] of renderedCanvases.entries()) {
      if (pageIndex < keepMin || pageIndex > keepMax) {
        releaseCanvas(entry.canvas);
        renderedCanvases.delete(pageIndex);
      }
    }

    for (const pageIndex of Array.from(searchLayers.keys())) {
      if (pageIndex < keepMin || pageIndex > keepMax) {
        clearSearchLayer(pageIndex);
      }
    }

    textLayer?.evictOutside(keepMin, keepMax, slotElements);
    linkLayer?.evictOutside(keepMin, keepMax);
  }

  function drainRenderQueue(): void {
    if (!activeDoc || destroyed) {
      return;
    }

    while (activeRenders < MAX_CONCURRENT_RENDERS && pendingQueue.length > 0) {
      const pageIndex = pendingQueue.shift();
      if (pageIndex === undefined) {
        break;
      }

      const existing = renderedCanvases.get(pageIndex);
      if (existing && existing.epoch === renderEpoch) {
        continue;
      }
      if (inFlightPages.has(pageIndex)) {
        continue;
      }

      const geom = pageOffsets[pageIndex];
      const slot = slotElements[pageIndex];
      if (!geom || !slot) {
        continue;
      }

      const requestEpoch = renderEpoch;
      const requestDoc = activeDoc;
      const requestSignal = requestDoc.signal;

      inFlightPages.add(pageIndex);
      activeRenders += 1;

      api
        .renderPage({
          documentId: requestDoc.documentId,
          pageIndex,
          widthPx: geom.widthPx,
          heightPx: geom.heightPx,
          epoch: requestEpoch,
        })
        .then((imageData) => {
          if (
            destroyed ||
            requestSignal?.aborted ||
            activeDoc !== requestDoc ||
            requestEpoch !== renderEpoch
          ) {
            return;
          }

          const { firstVisible, lastVisible } = getCurrentVisibleRange();
          const keepMin = Math.max(0, firstVisible - EVICT_RADIUS);
          const keepMax = Math.min(
            pageOffsets.length - 1,
            lastVisible + EVICT_RADIUS,
          );
          if (pageIndex < keepMin || pageIndex > keepMax) {
            return;
          }

          const targetSlot = slotElements[pageIndex];
          if (!targetSlot) {
            return;
          }

          let entry = renderedCanvases.get(pageIndex);
          if (!entry) {
            const canvas = document.createElement("canvas");
            canvas.className = "page-canvas";
            targetSlot.appendChild(canvas);
            entry = { canvas, epoch: requestEpoch };
            renderedCanvases.set(pageIndex, entry);
          } else {
            entry.epoch = requestEpoch;
          }

          const { canvas } = entry;
          canvas.width = imageData.width;
          canvas.height = imageData.height;

          const ctx = canvas.getContext("2d", { alpha: false });
          if (ctx) {
            ctx.putImageData(imageData, 0, 0);
          }
        })
        .catch((err) => {
          if (!isCancelledError(err) && !requestSignal?.aborted) {
            console.error(`Failed to render page ${pageIndex}:`, err);
          }
        })
        .finally(() => {
          activeRenders = Math.max(0, activeRenders - 1);
          if (requestEpoch === renderEpoch) {
            inFlightPages.delete(pageIndex);
            drainRenderQueue();
          }
        });
    }
  }

  function scheduleVisibleRenders(): void {
    if (!activeDoc || pageOffsets.length === 0 || destroyed) {
      return;
    }

    const { firstVisible, lastVisible, activePageIndex } =
      getCurrentVisibleRange();
    evictDistantCanvases(firstVisible, lastVisible);

    const renderMin = Math.max(0, firstVisible - OVERSCAN_RADIUS);
    const renderMax = Math.min(
      pageOffsets.length - 1,
      lastVisible + OVERSCAN_RADIUS,
    );

    syncSearchLayersForRange(renderMin, renderMax);
    textLayer?.syncVisibleRange({
      documentId: activeDoc.documentId,
      pageDimensions: activeDoc.pageDimensions,
      signal: activeDoc.signal,
      firstVisible,
      lastVisible,
      renderMin,
      renderMax,
      slotElements,
      pageOffsets,
    });
    linkLayer?.syncVisibleRange({
      documentId: activeDoc.documentId,
      signal: activeDoc.signal,
      firstVisible,
      lastVisible,
      renderMin,
      renderMax,
      slotElements,
      pageOffsets,
    });

    const needed: Array<{ pageIndex: number; priority: number }> = [];
    for (let i = renderMin; i <= renderMax; i += 1) {
      const existing = renderedCanvases.get(i);
      if (existing && existing.epoch === renderEpoch) {
        continue;
      }
      if (inFlightPages.has(i)) {
        continue;
      }
      const isVisible = i >= firstVisible && i <= lastVisible;
      const distance = Math.abs(i - activePageIndex);
      needed.push({
        pageIndex: i,
        priority: (isVisible ? 0 : 1000) + distance,
      });
    }

    needed.sort((a, b) => a.priority - b.priority);
    pendingQueue = needed.map((item) => item.pageIndex);
    drainRenderQueue();
  }

  function buildSnapshot(): ViewportSnapshot | null {
    if (!activeDoc) {
      return null;
    }
    const scrollTop = viewportEl.scrollTop;
    return {
      documentId: activeDoc.documentId,
      pageIndex: activeDoc.pageIndex,
      scrollTop,
      scrollAnchor: computeTabScrollAnchor(
        pageOffsets,
        scrollTop,
        activeDoc.pageIndex,
      ),
      zoomMode: activeDoc.zoomMode,
      zoomScale: activeDoc.zoomScale,
    };
  }

  function notifyViewState(force: boolean, reason: "mount" | "user"): void {
    if (!activeDoc) {
      return;
    }
    const scrollTop = viewportEl.scrollTop;
    let { activePageIndex } = getCurrentVisibleRange();
    if (pinnedJump) {
      if (Math.abs(scrollTop - pinnedJump.scrollTop) <= 2) {
        activePageIndex = pinnedJump.pageIndex;
      } else {
        pinnedJump = null;
      }
    }

    const pageChanged = activeDoc.pageIndex !== activePageIndex;
    activeDoc.pageIndex = activePageIndex;
    activeDoc.scrollTop = scrollTop;

    if (force || pageChanged) {
      const snapshot = buildSnapshot();
      if (snapshot) {
        activeDoc.scrollAnchor = snapshot.scrollAnchor;
        onViewStateChange(snapshot, reason);
      }
    }
  }

  function resolveInitialScrollTop(
    offsets: readonly PageLayoutGeom[],
    docState: MountedDocState,
    dpr: number,
  ): number {
    if (
      docState.scrollAnchor &&
      offsets.length > 0 &&
      Number.isInteger(docState.scrollAnchor.pageIndex) &&
      Number.isFinite(docState.scrollAnchor.topOffsetRatio)
    ) {
      const anchorIndex = Math.max(
        0,
        Math.min(docState.scrollAnchor.pageIndex, offsets.length - 1),
      );
      const geom = offsets[anchorIndex];
      if (geom) {
        return snapToDevicePixels(
          Math.max(
            0,
            geom.top + docState.scrollAnchor.topOffsetRatio * geom.height,
          ),
          dpr,
        );
      }
    }
    if (
      typeof docState.scrollTop === "number" &&
      Number.isFinite(docState.scrollTop)
    ) {
      return snapToDevicePixels(Math.max(0, docState.scrollTop), dpr);
    }
    if (offsets.length > 0) {
      const targetIndex = Math.max(
        0,
        Math.min(docState.pageIndex, offsets.length - 1),
      );
      const geom = offsets[targetIndex];
      if (geom) {
        return snapToDevicePixels(Math.max(0, geom.top - TRACK_PADDING_Y), dpr);
      }
    }
    return 0;
  }

  function relayoutPreservingAnchor(): void {
    if (!activeDoc || pageOffsets.length === 0) {
      return;
    }

    pinnedJump = null;
    const restoringInitial = pendingInitialPositionRestore;
    pendingInitialPositionRestore = false;
    currentDpr = getEffectiveDpr();
    const anchor = restoringInitial
      ? null
      : computeScrollAnchor(
          pageOffsets,
          viewportEl.scrollTop,
          getViewportHeight(),
        );
    const scale = computeEffectiveScale({
      pageDimensions: activeDoc.pageDimensions,
      pageIndex: activeDoc.pageIndex,
      zoomMode: activeDoc.zoomMode,
      zoomScale: activeDoc.zoomScale,
      viewportWidth: getViewportWidth(),
      viewportHeight: getViewportHeight(),
    });
    activeDoc.zoomScale = scale;

    const { offsets, totalHeight, maxPageWidth } = computeLayoutGeometry(
      activeDoc.pageDimensions,
      scale,
      currentDpr,
    );
    pageOffsets = offsets;
    const trackWidth = applyTrackSize(totalHeight, maxPageWidth, currentDpr);
    applySlotStyles(trackWidth, currentDpr);

    // Mark existing canvases stale so they remain visible while crisp HiDPI bitmaps render.
    bumpEpoch();
    textLayer?.rescaleMounted(
      slotElements,
      pageOffsets,
      activeDoc.pageDimensions,
    );
    viewportEl.scrollTop = anchor
      ? resolveAnchorScrollTop(pageOffsets, anchor, currentDpr)
      : resolveInitialScrollTop(pageOffsets, activeDoc, currentDpr);
    notifyViewState(true, restoringInitial ? "mount" : "user");
    scheduleVisibleRenders();
  }

  function releaseAllCanvases(): void {
    for (const entry of renderedCanvases.values()) {
      releaseCanvas(entry.canvas);
    }
    renderedCanvases.clear();
  }

  function unmount(): void {
    if (scrollRafId !== null) {
      cancelAnimationFrame(scrollRafId);
      scrollRafId = null;
    }
    if (intersectionObserver) {
      intersectionObserver.disconnect();
      intersectionObserver = null;
    }

    pinnedJump = null;
    pendingInitialPositionRestore = false;
    bumpEpoch();
    textLayer?.clearActiveSelection();
    textLayer?.clearMounted();
    linkLayer?.clearMounted();
    clearAllSearchLayers();
    releaseAllCanvases();
    slotElements = [];
    pageOffsets = [];
    currentMaxPageWidth = 0;
    currentTrackHeight = 0;
    currentSearch = null;
    trackEl.textContent = "";
    trackEl.style.height = "0px";
    trackEl.style.width = "100%";
    activeDoc = null;
  }

  function mountDocument(input: ViewportMountInput): void {
    if (destroyed) {
      return;
    }
    unmount();

    activeDoc = {
      documentId: input.documentId,
      pageDimensions: input.pageDimensions,
      signal: input.signal ?? null,
      pageIndex: input.pageIndex,
      scrollTop: input.scrollTop,
      scrollAnchor: input.scrollAnchor,
      zoomMode: input.zoomMode,
      zoomScale: input.zoomScale,
    };
    currentSearch = input.search ?? null;
    currentDpr = getEffectiveDpr();

    const scale = computeEffectiveScale({
      pageDimensions: activeDoc.pageDimensions,
      pageIndex: activeDoc.pageIndex,
      zoomMode: activeDoc.zoomMode,
      zoomScale: activeDoc.zoomScale,
      viewportWidth: getViewportWidth(),
      viewportHeight: getViewportHeight(),
    });
    activeDoc.zoomScale = scale;

    const { offsets, totalHeight, maxPageWidth } = computeLayoutGeometry(
      activeDoc.pageDimensions,
      scale,
      currentDpr,
    );
    pageOffsets = offsets;
    const trackWidth = applyTrackSize(totalHeight, maxPageWidth, currentDpr);

    const fragment = document.createDocumentFragment();
    slotElements = [];

    for (let i = 0; i < offsets.length; i += 1) {
      const geom = offsets[i];
      if (!geom) {
        continue;
      }
      const slot = document.createElement("div");
      slot.className = "page-slot";
      slot.dataset.pageIndex = String(i);
      const left = snapToDevicePixels(
        Math.max(0, (trackWidth - geom.width) / 2),
        currentDpr,
      );
      slot.style.top = `${geom.top}px`;
      slot.style.left = `${left}px`;
      slot.style.width = `${geom.width}px`;
      slot.style.height = `${geom.height}px`;
      slotElements.push(slot);
      fragment.appendChild(slot);
    }

    trackEl.appendChild(fragment);

    intersectionObserver = new IntersectionObserver(
      () => {
        scheduleVisibleRenders();
      },
      {
        root: viewportEl,
        rootMargin: "200px 0px",
      },
    );
    for (const slot of slotElements) {
      intersectionObserver.observe(slot);
    }

    lastViewportWidth = viewportEl.clientWidth;
    lastViewportHeight = viewportEl.clientHeight;
    pendingInitialPositionRestore =
      lastViewportWidth === 0 || lastViewportHeight === 0;
    viewportEl.scrollTop = resolveInitialScrollTop(
      offsets,
      activeDoc,
      currentDpr,
    );
    viewportEl.scrollLeft = 0;

    if (pendingInitialPositionRestore) {
      const snapshot = buildSnapshot();
      if (snapshot) {
        onViewStateChange(snapshot, "mount");
      }
    } else {
      notifyViewState(true, "mount");
    }
    scheduleVisibleRenders();
  }

  function commitProgrammaticJump(
    pageIndex: number,
    targetScrollTop: number,
    targetScrollLeft?: number,
  ): void {
    if (!activeDoc || pageOffsets.length === 0) {
      return;
    }
    pendingInitialPositionRestore = false;
    viewportEl.scrollTop = snapToDevicePixels(
      Math.max(0, targetScrollTop),
      currentDpr,
    );
    if (targetScrollLeft !== undefined) {
      viewportEl.scrollLeft = snapToDevicePixels(
        Math.max(0, targetScrollLeft),
        currentDpr,
      );
    }
    const landedScrollTop = viewportEl.scrollTop;
    pinnedJump = { pageIndex, scrollTop: landedScrollTop };
    activeDoc.pageIndex = pageIndex;
    activeDoc.scrollTop = landedScrollTop;
    activeDoc.scrollAnchor = computeTabScrollAnchor(
      pageOffsets,
      landedScrollTop,
      pageIndex,
    );
    const snapshot = buildSnapshot();
    if (snapshot) {
      onViewStateChange(snapshot, "user");
    }
    scheduleVisibleRenders();
  }

  function scrollToPage(pageIndex: number): void {
    if (!activeDoc || pageOffsets.length === 0) {
      return;
    }
    const clamped = Math.max(0, Math.min(pageIndex, pageOffsets.length - 1));
    const geom = pageOffsets[clamped];
    if (!geom) {
      return;
    }
    commitProgrammaticJump(clamped, Math.max(0, geom.top - TRACK_PADDING_Y));
  }

  function scrollToTarget(target: ViewportLinkTarget): void {
    if (!activeDoc || pageOffsets.length === 0) {
      return;
    }
    const clamped = Math.max(
      0,
      Math.min(target.pageIndex, pageOffsets.length - 1),
    );
    const geom = pageOffsets[clamped];
    if (!geom) {
      return;
    }
    let targetScrollTop = Math.max(0, geom.top - TRACK_PADDING_Y);
    let targetScrollLeft: number | undefined;
    if (target.point) {
      targetScrollTop = Math.max(
        0,
        geom.top + target.point.y * geom.height - 24,
      );
      if (viewportEl.scrollWidth > viewportEl.clientWidth) {
        const pageLeft = Math.max(0, (viewportEl.scrollWidth - geom.width) / 2);
        targetScrollLeft = Math.max(
          0,
          pageLeft + target.point.x * geom.width - 24,
        );
      }
    } else if (target.rect) {
      const rectTop = geom.top + target.rect.y * geom.height;
      const rectHeight = Math.max(0, target.rect.height) * geom.height;
      targetScrollTop = Math.max(
        0,
        rectTop - Math.max(24, (viewportEl.clientHeight - rectHeight) / 2),
      );
      if (viewportEl.scrollWidth > viewportEl.clientWidth) {
        const pageLeft = Math.max(0, (viewportEl.scrollWidth - geom.width) / 2);
        const rectLeft = pageLeft + target.rect.x * geom.width;
        const rectWidth = Math.max(0, target.rect.width) * geom.width;
        targetScrollLeft = Math.max(
          0,
          rectLeft - Math.max(24, (viewportEl.clientWidth - rectWidth) / 2),
        );
      }
    }
    commitProgrammaticJump(clamped, targetScrollTop, targetScrollLeft);
  }

  function scrollToAnchor(target: ViewportAnchorTarget): void {
    if (!activeDoc || pageOffsets.length === 0) {
      return;
    }
    const clamped = Math.max(
      0,
      Math.min(target.pageIndex, pageOffsets.length - 1),
    );
    const geom = pageOffsets[clamped];
    if (!geom) {
      return;
    }
    const ratio = target.scrollAnchor
      ? Math.max(0, Math.min(1, target.scrollAnchor.topOffsetRatio))
      : 0;
    const targetScrollTop =
      ratio > 0
        ? geom.top + ratio * geom.height
        : Math.max(0, geom.top - TRACK_PADDING_Y);
    commitProgrammaticJump(clamped, targetScrollTop);
  }

  function scrollPageStep(direction: 1 | -1): void {
    if (!activeDoc || pageOffsets.length === 0) {
      return;
    }
    pinnedJump = null;
    pendingInitialPositionRestore = false;
    if (activeDoc.zoomMode === "fit_page") {
      scrollToPage(activeDoc.pageIndex + direction);
      return;
    }
    const step = Math.max(
      80,
      Math.round((viewportEl.clientHeight || 600) * 0.9),
    );
    const maxScrollTop = Math.max(
      0,
      viewportEl.scrollHeight - viewportEl.clientHeight,
    );
    viewportEl.scrollTop = snapToDevicePixels(
      Math.max(
        0,
        Math.min(viewportEl.scrollTop + direction * step, maxScrollTop),
      ),
      currentDpr,
    );
    notifyViewState(false, "user");
    scheduleVisibleRenders();
  }

  function scrollToStart(): void {
    if (!activeDoc || pageOffsets.length === 0) {
      return;
    }
    pinnedJump = null;
    pendingInitialPositionRestore = false;
    viewportEl.scrollTop = 0;
    notifyViewState(false, "user");
    scheduleVisibleRenders();
  }

  function scrollToEnd(): void {
    if (!activeDoc || pageOffsets.length === 0) {
      return;
    }
    pinnedJump = null;
    pendingInitialPositionRestore = false;
    viewportEl.scrollTop = Math.max(
      0,
      viewportEl.scrollHeight - viewportEl.clientHeight,
    );
    notifyViewState(false, "user");
    scheduleVisibleRenders();
  }

  function focus(): void {
    viewportEl.focus({ preventScroll: true });
  }

  function setZoomMode(mode: ZoomMode): void {
    if (!activeDoc) {
      return;
    }
    pinnedJump = null;
    pendingInitialPositionRestore = false;
    activeDoc.zoomMode = mode;
    relayoutPreservingAnchor();
  }

  function setCustomZoom(scale: number): void {
    if (!activeDoc) {
      return;
    }
    pinnedJump = null;
    pendingInitialPositionRestore = false;
    activeDoc.zoomMode = "custom";
    activeDoc.zoomScale = clampZoom(scale);
    relayoutPreservingAnchor();
  }

  function captureSnapshot(): ViewportSnapshot | null {
    return buildSnapshot();
  }

  function syncSearchHighlights(search: ViewportSearchInput | null): void {
    currentSearch = search;
    if (!activeDoc || pageOffsets.length === 0) {
      clearAllSearchLayers();
      return;
    }
    const { firstVisible, lastVisible } = getCurrentVisibleRange();
    const renderMin = Math.max(0, firstVisible - OVERSCAN_RADIUS);
    const renderMax = Math.min(
      pageOffsets.length - 1,
      lastVisible + OVERSCAN_RADIUS,
    );
    syncSearchLayersForRange(renderMin, renderMax);
  }

  function scrollToNormalizedRect(
    pageIndex: number,
    rect?: NormalizedRect | null,
  ): void {
    if (!activeDoc || pageOffsets.length === 0) {
      return;
    }
    const clampedPage = Math.max(
      0,
      Math.min(pageIndex, pageOffsets.length - 1),
    );
    const geom = pageOffsets[clampedPage];
    if (!geom) {
      return;
    }

    const trackWidth = computeTrackWidth(
      currentMaxPageWidth,
      getViewportWidth(),
      currentDpr,
    );
    const slotLeft = snapToDevicePixels(
      Math.max(0, (trackWidth - geom.width) / 2),
      currentDpr,
    );

    const safeRect: NormalizedRect = rect ?? {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };
    const matchTop = geom.top + safeRect.y * geom.height;
    const matchHeight = Math.max(12, safeRect.height * geom.height);
    const matchBottom = matchTop + matchHeight;

    const matchLeft = slotLeft + safeRect.x * geom.width;
    const matchWidth = Math.max(12, safeRect.width * geom.width);
    const matchRight = matchLeft + matchWidth;

    const viewTop = viewportEl.scrollTop;
    const viewHeight = getViewportHeight();
    const viewLeft = viewportEl.scrollLeft;
    const viewWidth = getViewportWidth();

    // Keep clear of the floating top-right search bar (~56px) and bottom edge (~40px).
    const topMargin = Math.min(56, viewHeight * 0.2);
    const bottomMargin = Math.min(40, viewHeight * 0.15);
    const verticallyVisible =
      matchTop >= viewTop + topMargin &&
      matchBottom <= viewTop + viewHeight - bottomMargin;

    const horizMargin = Math.min(28, viewWidth * 0.1);
    const horizontallyVisible =
      matchLeft >= viewLeft + horizMargin &&
      matchRight <= viewLeft + viewWidth - horizMargin;

    if (verticallyVisible && horizontallyVisible) {
      return;
    }

    const maxScrollTop = Math.max(0, viewportEl.scrollHeight - viewHeight);
    const maxScrollLeft = Math.max(0, viewportEl.scrollWidth - viewWidth);

    let targetTop = viewTop;
    if (!verticallyVisible) {
      const rawTop = matchTop - viewHeight * 0.38;
      targetTop = snapToDevicePixels(
        Math.max(0, Math.min(rawTop, maxScrollTop)),
        currentDpr,
      );
    }

    let targetLeft = viewLeft;
    if (!horizontallyVisible && maxScrollLeft > 0) {
      const rawLeft = matchLeft + matchWidth / 2 - viewWidth / 2;
      targetLeft = snapToDevicePixels(
        Math.max(0, Math.min(rawLeft, maxScrollLeft)),
        currentDpr,
      );
    }

    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    viewportEl.scrollTo({
      top: targetTop,
      left: targetLeft,
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }

  function handleViewportScroll(): void {
    if (!activeDoc || scrollRafId !== null || destroyed) {
      return;
    }
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = null;
      notifyViewState(false, "user");
      scheduleVisibleRenders();
    });
  }

  viewportEl.addEventListener("scroll", handleViewportScroll, {
    passive: true,
  });

  const resizeObserver = new ResizeObserver(() => {
    if (!activeDoc || destroyed) {
      return;
    }
    const width = viewportEl.clientWidth;
    const height = viewportEl.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }

    const widthChanged = width !== lastViewportWidth;
    const heightChanged = height !== lastViewportHeight;
    if (!widthChanged && !heightChanged) {
      return;
    }

    lastViewportWidth = width;
    lastViewportHeight = height;

    const shouldRelayout =
      (activeDoc.zoomMode === "fit_width" && widthChanged) ||
      (activeDoc.zoomMode === "fit_page" && (widthChanged || heightChanged));

    if (!shouldRelayout) {
      if (widthChanged && pageOffsets.length > 0) {
        const trackWidth = applyTrackSize(
          currentTrackHeight,
          currentMaxPageWidth,
          currentDpr,
        );
        applySlotHorizontalPositions(trackWidth, currentDpr);
      }
      if (pendingInitialPositionRestore && pageOffsets.length > 0) {
        pendingInitialPositionRestore = false;
        viewportEl.scrollTop = resolveInitialScrollTop(
          pageOffsets,
          activeDoc,
          currentDpr,
        );
        notifyViewState(true, "mount");
      }
      scheduleVisibleRenders();
      return;
    }

    if (resizeRafId !== null) {
      cancelAnimationFrame(resizeRafId);
    }
    resizeRafId = requestAnimationFrame(() => {
      resizeRafId = null;
      relayoutPreservingAnchor();
    });
  });

  resizeObserver.observe(viewportEl);

  function handleDprChange(): void {
    if (destroyed) {
      return;
    }
    observeDprChange();
    const nextDpr = getEffectiveDpr();
    if (nextDpr === currentDpr) {
      return;
    }
    currentDpr = nextDpr;
    if (activeDoc) {
      relayoutPreservingAnchor();
    }
  }

  function observeDprChange(): void {
    if (dprMediaQuery) {
      dprMediaQuery.removeEventListener("change", handleDprChange);
      dprMediaQuery = null;
    }
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const rawDpr = window.devicePixelRatio || 1;
    dprMediaQuery = window.matchMedia(`(resolution: ${rawDpr}dppx)`);
    dprMediaQuery.addEventListener("change", handleDprChange, { once: true });
  }

  observeDprChange();

  function destroy(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    viewportEl.removeEventListener("scroll", handleViewportScroll);
    resizeObserver.disconnect();
    if (resizeRafId !== null) {
      cancelAnimationFrame(resizeRafId);
      resizeRafId = null;
    }
    if (dprMediaQuery) {
      dprMediaQuery.removeEventListener("change", handleDprChange);
      dprMediaQuery = null;
    }
    unmount();
  }

  return {
    mountDocument,
    unmount,
    scrollToPage,
    scrollToTarget,
    scrollToAnchor,
    scrollToNormalizedRect,
    syncSearchHighlights,
    scrollPageStep,
    scrollToStart,
    scrollToEnd,
    focus,
    setZoomMode,
    setCustomZoom,
    captureSnapshot,
    getMountedCanvasCount: () => renderedCanvases.size,
    destroy,
  };
}
