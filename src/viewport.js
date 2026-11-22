/**
 * Virtualized continuous-scroll HiDPI PDF viewport.
 *
 * Mounts only the active tab in DOM, pre-computes vertical geometry from
 * `pageDimensions`, renders visible pages plus a ±2 page overscan buffer,
 * evicts canvases beyond ±6 pages, and releases all canvas backing stores
 * immediately on tab switch or unmount.
 */

import { isCancelledError, renderPage } from "./api.js";
import { MAX_ZOOM, MIN_ZOOM } from "./toolbar.js";

const PT_TO_CSS_PX = 96 / 72;
const PAGE_GAP_PX = 16;
const TRACK_PADDING_Y = 24;
const TRACK_PADDING_X = 48;
const OVERSCAN_RADIUS = 2;
const EVICT_RADIUS = 6;
const MAX_CONCURRENT_RENDERS = 2;
const MAX_DPR = 3;

function clampZoom(scale) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
}

function getEffectiveDpr() {
  return Math.max(1, Math.min(window.devicePixelRatio || 1, MAX_DPR));
}

function snapToDevicePixels(cssPx, dpr) {
  return Math.round(cssPx * dpr) / dpr;
}

function releaseCanvas(canvas) {
  if (!canvas) {
    return;
  }
  canvas.width = 0;
  canvas.height = 0;
  canvas.remove();
}

/**
 * Binary searches `pageOffsets` for the first page whose bottom edge is >= `y`.
 * @param {Array<{ top: number, height: number, width: number }>} offsets
 * @param {number} y
 */
function findFirstPageAtOrAfter(offsets, y) {
  let low = 0;
  let high = offsets.length - 1;
  let result = offsets.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const bottom = offsets[mid].top + offsets[mid].height;
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
 * Binary searches `pageOffsets` for the last page whose top edge is <= `y`.
 * @param {Array<{ top: number, height: number, width: number }>} offsets
 * @param {number} y
 */
function findLastPageAtOrBefore(offsets, y) {
  let low = 0;
  let high = offsets.length - 1;
  let result = 0;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offsets[mid].top <= y) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

/**
 * @param {{
 *   viewportEl: HTMLElement,
 *   trackEl: HTMLElement,
 *   onViewStateChange: (snapshot: { documentId: number, pageIndex: number, scrollTop: number, zoomMode: "fit_width" | "fit_page" | "custom", zoomScale: number }) => void,
 * }} options
 */
export function createViewport({ viewportEl, trackEl, onViewStateChange }) {
  /** @type {any | null} */
  let activeTab = null;
  /** @type {Array<{ top: number, height: number, width: number, widthPx: number, heightPx: number }>} */
  let pageOffsets = [];
  /** @type {Array<HTMLDivElement>} */
  let slotElements = [];
  /** @type {Map<number, { canvas: HTMLCanvasElement, epoch: number }>} */
  const renderedCanvases = new Map();
  /** @type {Set<number>} */
  const inFlightPages = new Set();
  /** @type {Array<number>} */
  let pendingQueue = [];

  let renderEpoch = 0;
  let activeRenders = 0;
  let scrollRafId = null;
  let resizeRafId = null;
  let lastViewportWidth = 0;
  let lastViewportHeight = 0;
  let currentMaxPageWidth = 0;
  let currentTrackHeight = 0;
  let currentDpr = getEffectiveDpr();
  /** @type {IntersectionObserver | null} */
  let intersectionObserver = null;
  /** @type {MediaQueryList | null} */
  let dprMediaQuery = null;

  function bumpEpoch() {
    renderEpoch += 1;
    pendingQueue = [];
    inFlightPages.clear();
    return renderEpoch;
  }

  function computeEffectiveScale(tab) {
    if (!tab || tab.pageDimensions.length === 0) {
      return 1.0;
    }

    if (tab.zoomMode === "custom") {
      return clampZoom(tab.zoomScale);
    }

    const viewportWidth = viewportEl.clientWidth || window.innerWidth || 900;
    const viewportHeight = viewportEl.clientHeight || window.innerHeight || 700;
    const refIndex = Math.min(tab.pageIndex, tab.pageDimensions.length - 1);
    const refDims = tab.pageDimensions[refIndex] || tab.pageDimensions[0];
    const baseW = Math.max(1, refDims.width_pt * PT_TO_CSS_PX);
    const baseH = Math.max(1, refDims.height_pt * PT_TO_CSS_PX);

    const availableW = Math.max(120, viewportWidth - TRACK_PADDING_X);
    const availableH = Math.max(120, viewportHeight - TRACK_PADDING_Y * 2);

    if (tab.zoomMode === "fit_width") {
      return clampZoom(availableW / baseW);
    }

    return clampZoom(Math.min(availableW / baseW, availableH / baseH));
  }

  function computeLayoutGeometry(tab, scale, dpr) {
    const offsets = new Array(tab.pageDimensions.length);
    const padY = snapToDevicePixels(TRACK_PADDING_Y, dpr);
    const gapY = snapToDevicePixels(PAGE_GAP_PX, dpr);
    let y = padY;
    let maxPageWidth = 0;

    for (let i = 0; i < tab.pageDimensions.length; i += 1) {
      const dims = tab.pageDimensions[i];
      const rawW = Math.max(1, dims.width_pt * PT_TO_CSS_PX * scale);
      const rawH = Math.max(1, dims.height_pt * PT_TO_CSS_PX * scale);
      const widthPx = Math.max(1, Math.round(rawW * dpr));
      const heightPx = Math.max(1, Math.round(rawH * dpr));
      const width = widthPx / dpr;
      const height = heightPx / dpr;
      const top = snapToDevicePixels(y, dpr);
      offsets[i] = { top, width, height, widthPx, heightPx };
      if (width > maxPageWidth) {
        maxPageWidth = width;
      }
      y = top + height + gapY;
    }

    const totalHeight =
      tab.pageDimensions.length > 0 ? y - gapY + padY : padY * 2;

    return { offsets, totalHeight, maxPageWidth };
  }

  function computeTrackWidth(maxPageWidth, dpr) {
    const viewportWidth = viewportEl.clientWidth || window.innerWidth || 900;
    const minTrackWidth = maxPageWidth + TRACK_PADDING_X;
    return snapToDevicePixels(Math.max(viewportWidth, minTrackWidth), dpr);
  }

  function applyTrackSize(totalHeight, maxPageWidth, dpr) {
    currentTrackHeight = totalHeight;
    currentMaxPageWidth = maxPageWidth;
    const trackWidth = computeTrackWidth(maxPageWidth, dpr);
    trackEl.style.height = `${snapToDevicePixels(totalHeight, dpr)}px`;
    trackEl.style.width = `${trackWidth}px`;
    return trackWidth;
  }

  function applySlotHorizontalPositions(trackWidth, dpr) {
    for (let i = 0; i < slotElements.length; i += 1) {
      const slot = slotElements[i];
      const geom = pageOffsets[i];
      const left = snapToDevicePixels(Math.max(0, (trackWidth - geom.width) / 2), dpr);
      slot.style.left = `${left}px`;
    }
  }

  function applySlotStyles(trackWidth, dpr) {
    for (let i = 0; i < slotElements.length; i += 1) {
      const slot = slotElements[i];
      const geom = pageOffsets[i];
      const left = snapToDevicePixels(Math.max(0, (trackWidth - geom.width) / 2), dpr);
      slot.style.top = `${geom.top}px`;
      slot.style.left = `${left}px`;
      slot.style.width = `${geom.width}px`;
      slot.style.height = `${geom.height}px`;
    }
  }

  function getVisibleRange() {
    if (pageOffsets.length === 0) {
      return { firstVisible: 0, lastVisible: -1, activePageIndex: 0 };
    }

    const viewTop = viewportEl.scrollTop;
    const viewHeight = viewportEl.clientHeight || window.innerHeight || 700;
    const viewBottom = viewTop + viewHeight;

    const firstVisible = findFirstPageAtOrAfter(pageOffsets, viewTop);
    const lastVisible = Math.max(
      firstVisible,
      findLastPageAtOrBefore(pageOffsets, viewBottom),
    );

    const maxScrollTop = Math.max(0, viewportEl.scrollHeight - viewHeight);
    const lastIndex = pageOffsets.length - 1;
    let activePageIndex;
    if (
      maxScrollTop > 0 &&
      viewTop >= maxScrollTop - 2 &&
      pageOffsets[lastIndex].top < viewTop + viewHeight * 0.6
    ) {
      activePageIndex = lastIndex;
    } else {
      const firstHeight = pageOffsets[firstVisible]?.height ?? viewHeight;
      const anchorOffset = Math.min(viewHeight * 0.35, firstHeight * 0.5);
      const anchorY = viewTop + anchorOffset;
      activePageIndex = findFirstPageAtOrAfter(pageOffsets, anchorY);
    }
    activePageIndex = Math.max(0, Math.min(activePageIndex, lastIndex));

    return { firstVisible, lastVisible, activePageIndex };
  }

  function evictDistantCanvases(firstVisible, lastVisible) {
    const keepMin = Math.max(0, firstVisible - EVICT_RADIUS);
    const keepMax = Math.min(pageOffsets.length - 1, lastVisible + EVICT_RADIUS);

    for (const [pageIndex, entry] of renderedCanvases.entries()) {
      if (pageIndex < keepMin || pageIndex > keepMax) {
        releaseCanvas(entry.canvas);
        renderedCanvases.delete(pageIndex);
      }
    }
  }

  function drainRenderQueue() {
    if (!activeTab) {
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
      const requestDocId = activeTab.documentId;
      const widthPx = geom.widthPx;
      const heightPx = geom.heightPx;

      inFlightPages.add(pageIndex);
      activeRenders += 1;

      renderPage({
        documentId: requestDocId,
        pageIndex,
        widthPx,
        heightPx,
        epoch: requestEpoch,
      })
        .then((imageData) => {
          if (
            !activeTab ||
            activeTab.documentId !== requestDocId ||
            requestEpoch !== renderEpoch
          ) {
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
          if (!isCancelledError(err)) {
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

  function scheduleVisibleRenders() {
    if (!activeTab || pageOffsets.length === 0) {
      return;
    }

    const { firstVisible, lastVisible, activePageIndex } = getVisibleRange();
    evictDistantCanvases(firstVisible, lastVisible);

    const renderMin = Math.max(0, firstVisible - OVERSCAN_RADIUS);
    const renderMax = Math.min(pageOffsets.length - 1, lastVisible + OVERSCAN_RADIUS);

    /** @type {Array<{ pageIndex: number, priority: number }>} */
    const needed = [];
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
      needed.push({ pageIndex: i, priority: (isVisible ? 0 : 1000) + distance });
    }

    needed.sort((a, b) => a.priority - b.priority);
    pendingQueue = needed.map((item) => item.pageIndex);
    drainRenderQueue();
  }

  function notifyViewState(force = false) {
    if (!activeTab) {
      return;
    }
    const { activePageIndex } = getVisibleRange();
    const scrollTop = viewportEl.scrollTop;
    const pageChanged = activeTab.pageIndex !== activePageIndex;

    activeTab.pageIndex = activePageIndex;
    activeTab.scrollTop = scrollTop;

    if (force || pageChanged) {
      onViewStateChange({
        documentId: activeTab.documentId,
        pageIndex: activeTab.pageIndex,
        scrollTop: activeTab.scrollTop,
        zoomMode: activeTab.zoomMode,
        zoomScale: activeTab.zoomScale,
      });
    }
  }

  function snapshotScrollAnchor() {
    if (!activeTab || pageOffsets.length === 0) {
      return { pageIndex: 0, ratioInPage: 0 };
    }
    const viewHeight = viewportEl.clientHeight || window.innerHeight || 700;
    const anchorOffset = viewHeight * 0.25;
    const anchorY = viewportEl.scrollTop + anchorOffset;
    const pageIndex = Math.max(
      0,
      Math.min(findFirstPageAtOrAfter(pageOffsets, anchorY), pageOffsets.length - 1),
    );
    const geom = pageOffsets[pageIndex];
    const ratioInPage =
      geom.height > 0 ? Math.max(0, Math.min(1, (anchorY - geom.top) / geom.height)) : 0;

    return { pageIndex, ratioInPage, anchorOffset };
  }

  function restoreScrollAnchor(anchor) {
    if (!activeTab || pageOffsets.length === 0) {
      return;
    }
    const geom = pageOffsets[Math.min(anchor.pageIndex, pageOffsets.length - 1)];
    if (!geom) {
      return;
    }
    const targetScrollTop = geom.top + anchor.ratioInPage * geom.height - (anchor.anchorOffset ?? 0);
    viewportEl.scrollTop = snapToDevicePixels(Math.max(0, targetScrollTop), currentDpr);
  }

  function relayoutPreservingAnchor() {
    if (!activeTab || pageOffsets.length === 0) {
      return;
    }

    currentDpr = getEffectiveDpr();
    const anchor = snapshotScrollAnchor();
    const scale = computeEffectiveScale(activeTab);
    activeTab.zoomScale = scale;

    const { offsets, totalHeight, maxPageWidth } = computeLayoutGeometry(
      activeTab,
      scale,
      currentDpr,
    );
    pageOffsets = offsets;
    const trackWidth = applyTrackSize(totalHeight, maxPageWidth, currentDpr);
    applySlotStyles(trackWidth, currentDpr);

    // Mark existing canvases stale so they stay visible while crisp HiDPI bitmaps render.
    bumpEpoch();
    restoreScrollAnchor(anchor);
    notifyViewState(true);
    scheduleVisibleRenders();
  }

  function releaseAllCanvases() {
    for (const entry of renderedCanvases.values()) {
      releaseCanvas(entry.canvas);
    }
    renderedCanvases.clear();
  }

  function captureTabAnchor(tab) {
    if (!tab || pageOffsets.length === 0) {
      return null;
    }
    const viewTop = viewportEl.scrollTop;
    const { activePageIndex } = getVisibleRange();
    const geom = pageOffsets[activePageIndex];
    if (!geom || geom.height <= 0) {
      return null;
    }
    return {
      pageIndex: activePageIndex,
      topOffsetRatio: (viewTop - geom.top) / geom.height,
    };
  }

  function unmount() {
    if (scrollRafId !== null) {
      cancelAnimationFrame(scrollRafId);
      scrollRafId = null;
    }
    if (intersectionObserver) {
      intersectionObserver.disconnect();
      intersectionObserver = null;
    }
    if (activeTab) {
      activeTab.scrollTop = viewportEl.scrollTop;
      activeTab.scrollAnchor = captureTabAnchor(activeTab);
    }

    bumpEpoch();
    releaseAllCanvases();
    slotElements = [];
    pageOffsets = [];
    currentMaxPageWidth = 0;
    currentTrackHeight = 0;
    trackEl.textContent = "";
    trackEl.style.height = "0px";
    trackEl.style.width = "100%";
    activeTab = null;
  }

  function mountTab(tab) {
    // Save outgoing tab state and free every canvas backing store before mounting the next tab.
    unmount();

    activeTab = tab;
    currentDpr = getEffectiveDpr();
    const scale = computeEffectiveScale(tab);
    tab.zoomScale = scale;

    const { offsets, totalHeight, maxPageWidth } = computeLayoutGeometry(tab, scale, currentDpr);
    pageOffsets = offsets;
    const trackWidth = applyTrackSize(totalHeight, maxPageWidth, currentDpr);

    const fragment = document.createDocumentFragment();
    slotElements = new Array(offsets.length);

    for (let i = 0; i < offsets.length; i += 1) {
      const slot = document.createElement("div");
      slot.className = "page-slot";
      slot.dataset.pageIndex = String(i);
      const left = snapToDevicePixels(Math.max(0, (trackWidth - offsets[i].width) / 2), currentDpr);
      slot.style.top = `${offsets[i].top}px`;
      slot.style.left = `${left}px`;
      slot.style.width = `${offsets[i].width}px`;
      slot.style.height = `${offsets[i].height}px`;
      slotElements[i] = slot;
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

    if (
      tab.scrollAnchor &&
      offsets.length > 0 &&
      Number.isInteger(tab.scrollAnchor.pageIndex) &&
      Number.isFinite(tab.scrollAnchor.topOffsetRatio)
    ) {
      const anchorIndex = Math.max(
        0,
        Math.min(tab.scrollAnchor.pageIndex, offsets.length - 1),
      );
      const geom = offsets[anchorIndex];
      viewportEl.scrollTop = snapToDevicePixels(
        Math.max(0, geom.top + tab.scrollAnchor.topOffsetRatio * geom.height),
        currentDpr,
      );
    } else if (typeof tab.scrollTop === "number" && Number.isFinite(tab.scrollTop)) {
      viewportEl.scrollTop = snapToDevicePixels(Math.max(0, tab.scrollTop), currentDpr);
    } else if (offsets.length > 0) {
      const targetIndex = Math.max(0, Math.min(tab.pageIndex, offsets.length - 1));
      viewportEl.scrollTop = snapToDevicePixels(
        Math.max(0, offsets[targetIndex].top - TRACK_PADDING_Y),
        currentDpr,
      );
    } else {
      viewportEl.scrollTop = 0;
    }

    viewportEl.scrollLeft = 0;
    lastViewportWidth = viewportEl.clientWidth;
    lastViewportHeight = viewportEl.clientHeight;

    notifyViewState(true);
    scheduleVisibleRenders();
  }

  function scrollToPage(pageIndex) {
    if (!activeTab || pageOffsets.length === 0) {
      return;
    }
    const clamped = Math.max(0, Math.min(pageIndex, pageOffsets.length - 1));
    viewportEl.scrollTop = snapToDevicePixels(
      Math.max(0, pageOffsets[clamped].top - TRACK_PADDING_Y),
      currentDpr,
    );
    activeTab.pageIndex = clamped;
    activeTab.scrollTop = viewportEl.scrollTop;
    activeTab.scrollAnchor = captureTabAnchor(activeTab);
    notifyViewState(true);
    scheduleVisibleRenders();
  }

  function scrollPageStep(direction) {
    if (!activeTab || pageOffsets.length === 0) {
      return;
    }
    if (activeTab.zoomMode === "fit_page") {
      scrollToPage(activeTab.pageIndex + direction);
      return;
    }
    const step = Math.max(80, Math.round((viewportEl.clientHeight || 600) * 0.9));
    const maxScrollTop = Math.max(0, viewportEl.scrollHeight - viewportEl.clientHeight);
    viewportEl.scrollTop = Math.max(
      0,
      Math.min(viewportEl.scrollTop + direction * step, maxScrollTop),
    );
    notifyViewState(false);
    scheduleVisibleRenders();
  }

  function scrollToStart() {
    if (!activeTab || pageOffsets.length === 0) {
      return;
    }
    viewportEl.scrollTop = 0;
    notifyViewState(false);
    scheduleVisibleRenders();
  }

  function scrollToEnd() {
    if (!activeTab || pageOffsets.length === 0) {
      return;
    }
    viewportEl.scrollTop = Math.max(0, viewportEl.scrollHeight - viewportEl.clientHeight);
    notifyViewState(false);
    scheduleVisibleRenders();
  }

  function focus() {
    viewportEl.focus({ preventScroll: true });
  }

  function setZoomMode(mode) {
    if (!activeTab) {
      return;
    }
    activeTab.zoomMode = mode;
    relayoutPreservingAnchor();
  }

  function setCustomZoom(scale) {
    if (!activeTab) {
      return;
    }
    activeTab.zoomMode = "custom";
    activeTab.zoomScale = clampZoom(scale);
    relayoutPreservingAnchor();
  }

  function captureActiveSnapshot() {
    if (!activeTab) {
      return null;
    }
    activeTab.scrollTop = viewportEl.scrollTop;
    activeTab.scrollAnchor = captureTabAnchor(activeTab);
    return {
      documentId: activeTab.documentId,
      canonicalPath: activeTab.canonicalPath,
      pageIndex: activeTab.pageIndex,
      scrollTop: activeTab.scrollTop,
      zoomMode: activeTab.zoomMode,
      zoomScale: activeTab.zoomScale,
    };
  }

  viewportEl.addEventListener(
    "scroll",
    () => {
      if (!activeTab || scrollRafId !== null) {
        return;
      }
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = null;
        notifyViewState(false);
        scheduleVisibleRenders();
      });
    },
    { passive: true },
  );

  const resizeObserver = new ResizeObserver(() => {
    if (!activeTab) {
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
      (activeTab.zoomMode === "fit_width" && widthChanged) ||
      (activeTab.zoomMode === "fit_page" && (widthChanged || heightChanged));

    if (!shouldRelayout) {
      if (widthChanged && pageOffsets.length > 0) {
        const trackWidth = applyTrackSize(currentTrackHeight, currentMaxPageWidth, currentDpr);
        applySlotHorizontalPositions(trackWidth, currentDpr);
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

  function handleDprChange() {
    observeDprChange();
    const nextDpr = getEffectiveDpr();
    if (nextDpr === currentDpr) {
      return;
    }
    currentDpr = nextDpr;
    if (activeTab) {
      relayoutPreservingAnchor();
    }
  }

  function observeDprChange() {
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

  return {
    mountTab,
    unmount,
    scrollToPage,
    scrollPageStep,
    scrollToStart,
    scrollToEnd,
    focus,
    setZoomMode,
    setCustomZoom,
    captureActiveSnapshot,
    getMountedCanvasCount: () => renderedCanvases.size,
  };
}
