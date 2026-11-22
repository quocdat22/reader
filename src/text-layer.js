/**
 * Lazy transparent HTML text selection layer mapped from normalized MuPDF geometry.
 *
 * Fetches `get_page_text` lazily for visible/overscan pages of the active tab,
 * caches per open tab with a bounded LRU cap, rescales purely via CSS transforms
 * on zoom, and formats multi-span/multi-line `Ctrl+C` clipboard output cleanly.
 */

import { getPageText } from "./api.js";

const PT_TO_CSS_PX = 96 / 72;
const TEXT_LAYER_FONT = '"Segoe UI", Arial, sans-serif';
const MAX_CONCURRENT_FETCHES = 2;
const MAX_CACHED_PAGES_PER_TAB = 120;
const SAME_LINE_Y_THRESHOLD = 0.55;

/** @type {CanvasRenderingContext2D | null} */
let cachedMeasureCtx = null;

function getMeasureContext() {
  if (cachedMeasureCtx) {
    return cachedMeasureCtx;
  }
  const canvas = document.createElement("canvas");
  cachedMeasureCtx = canvas.getContext("2d");
  return cachedMeasureCtx;
}

/**
 * Joins extracted selected text fragments into clean plain text using
 * normalized page geometry to insert spaces between same-line segments
 * and newlines across line or page breaks.
 *
 * @param {Array<{ pageIndex: number, text: string, rect: { x: number, y: number, width: number, height: number } }>} fragments
 * @returns {string}
 */
export function formatCopiedFragments(fragments) {
  if (!Array.isArray(fragments) || fragments.length === 0) {
    return "";
  }

  let output = "";
  /** @type {{ pageIndex: number, text: string, rect: { x: number, y: number, width: number, height: number } } | null} */
  let prev = null;

  for (const frag of fragments) {
    if (!frag || typeof frag.text !== "string" || frag.text.length === 0) {
      continue;
    }

    if (prev) {
      const samePage = frag.pageIndex === prev.pageIndex;
      const prevMidY = prev.rect.y + prev.rect.height / 2;
      const currMidY = frag.rect.y + frag.rect.height / 2;
      const maxHeight = Math.max(prev.rect.height, frag.rect.height);
      const sameLine =
        samePage &&
        maxHeight > 0 &&
        Math.abs(currMidY - prevMidY) <= maxHeight * SAME_LINE_Y_THRESHOLD;

      if (sameLine) {
        if (!/\s$/.test(prev.text) && !/^\s/.test(frag.text)) {
          output += " ";
        }
      } else if (!output.endsWith("\n")) {
        output += "\n";
      }
    }

    output += frag.text;
    prev = frag;
  }

  return output;
}

function getCachedPageText(tab, pageIndex) {
  if (!tab?.textCache || !tab.textCache.has(pageIndex)) {
    return null;
  }
  const spans = tab.textCache.get(pageIndex);
  // Refresh LRU recency on hit.
  tab.textCache.delete(pageIndex);
  tab.textCache.set(pageIndex, spans);
  return spans;
}

function setCachedPageText(tab, pageIndex, spans) {
  if (!tab) {
    return;
  }
  if (!tab.textCache) {
    tab.textCache = new Map();
  }
  if (tab.textCache.has(pageIndex)) {
    tab.textCache.delete(pageIndex);
  }
  tab.textCache.set(pageIndex, spans);

  while (tab.textCache.size > MAX_CACHED_PAGES_PER_TAB) {
    const oldestKey = tab.textCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    tab.textCache.delete(oldestKey);
  }
}

function selectionIntersectsSlot(selection, slotEl) {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !slotEl) {
    return false;
  }
  for (let i = 0; i < selection.rangeCount; i += 1) {
    const range = selection.getRangeAt(i);
    if (range.intersectsNode(slotEl)) {
      return true;
    }
  }
  return false;
}

function selectionInsideViewport(selection, viewportEl) {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }
  for (let i = 0; i < selection.rangeCount; i += 1) {
    const range = selection.getRangeAt(i);
    if (viewportEl.contains(range.commonAncestorContainer)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {{
 *   viewportEl: HTMLElement,
 * }} options
 */
export function createTextLayer({ viewportEl }) {
  /** @type {any | null} */
  let currentTab = null;
  let layerEpoch = 0;
  let activeFetches = 0;
  /** @type {Array<number>} */
  let pendingQueue = [];
  /** @type {Set<number>} */
  const inFlightPages = new Set();
  /** @type {Map<number, HTMLElement>} */
  const mountedLayers = new Map();
  /** @type {WeakMap<HTMLElement, { pageIndex: number, rect: { x: number, y: number, width: number, height: number } }>} */
  const spanMetaByEl = new WeakMap();

  let currentWindow = {
    renderMin: 0,
    renderMax: -1,
    slotElements: /** @type {Array<HTMLDivElement>} */ ([]),
    pageOffsets: /** @type {Array<{ width: number, height: number }>} */ ([]),
  };

  function buildLayerTransform(dims, geom) {
    const baseW = Math.max(1, dims.width_pt * PT_TO_CSS_PX);
    const baseH = Math.max(1, dims.height_pt * PT_TO_CSS_PX);
    const sx = geom.width / baseW;
    const sy = geom.height / baseH;
    return {
      baseW,
      baseH,
      transform: `scale(${sx}, ${sy})`,
    };
  }

  function mountPageLayer(tab, pageIndex, spans, slotEl, geom) {
    if (!tab || !slotEl || !geom || mountedLayers.has(pageIndex)) {
      return;
    }
    const dims = tab.pageDimensions?.[pageIndex];
    if (!dims) {
      return;
    }

    const { baseW, baseH, transform } = buildLayerTransform(dims, geom);
    const layerEl = document.createElement("div");
    layerEl.className = "text-layer";
    layerEl.style.width = `${baseW}px`;
    layerEl.style.height = `${baseH}px`;
    layerEl.style.transform = transform;

    const measureCtx = getMeasureContext();
    const fragment = document.createDocumentFragment();

    for (const span of spans) {
      if (!span || typeof span.text !== "string" || span.text.length === 0) {
        continue;
      }
      const rect = span.rect;
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        continue;
      }

      const left = rect.x * baseW;
      const top = rect.y * baseH;
      const targetWidth = rect.width * baseW;
      const boxHeight = rect.height * baseH;
      const fontSize = Math.max(1, boxHeight * 0.87);

      let scaleX = 1;
      if (measureCtx && targetWidth > 0.25) {
        measureCtx.font = `400 ${fontSize.toFixed(2)}px ${TEXT_LAYER_FONT}`;
        const measured = measureCtx.measureText(span.text).width;
        if (measured > 0.25) {
          scaleX = targetWidth / measured;
        }
      }

      const spanEl = document.createElement("span");
      spanEl.className = "text-span";
      spanEl.textContent = span.text;
      spanEl.style.left = `${left.toFixed(2)}px`;
      spanEl.style.top = `${top.toFixed(2)}px`;
      spanEl.style.fontSize = `${fontSize.toFixed(2)}px`;
      if (Number.isFinite(scaleX) && scaleX > 0.05 && scaleX < 20) {
        spanEl.style.transform = `scaleX(${scaleX.toFixed(5)})`;
      }

      spanMetaByEl.set(spanEl, { pageIndex, rect });
      fragment.appendChild(spanEl);
    }

    layerEl.appendChild(fragment);
    slotEl.appendChild(layerEl);
    mountedLayers.set(pageIndex, layerEl);
  }

  function drainFetchQueue() {
    if (!currentTab) {
      return;
    }

    while (activeFetches < MAX_CONCURRENT_FETCHES && pendingQueue.length > 0) {
      const pageIndex = pendingQueue.shift();
      if (pageIndex === undefined) {
        break;
      }
      if (
        pageIndex < currentWindow.renderMin ||
        pageIndex > currentWindow.renderMax ||
        mountedLayers.has(pageIndex) ||
        inFlightPages.has(pageIndex)
      ) {
        continue;
      }

      const cached = getCachedPageText(currentTab, pageIndex);
      if (cached) {
        mountPageLayer(
          currentTab,
          pageIndex,
          cached,
          currentWindow.slotElements[pageIndex],
          currentWindow.pageOffsets[pageIndex],
        );
        continue;
      }

      const requestTab = currentTab;
      const requestEpoch = layerEpoch;

      inFlightPages.add(pageIndex);
      activeFetches += 1;

      getPageText(requestTab.documentId, pageIndex)
        .then((spans) => {
          const normalizedSpans = Array.isArray(spans) ? spans : [];
          // Cache only if the tab has not been closed/invalidated via tab removal.
          if (requestTab.textCache) {
            setCachedPageText(requestTab, pageIndex, normalizedSpans);
          }

          if (
            requestEpoch !== layerEpoch ||
            currentTab !== requestTab ||
            pageIndex < currentWindow.renderMin ||
            pageIndex > currentWindow.renderMax
          ) {
            return;
          }

          mountPageLayer(
            requestTab,
            pageIndex,
            normalizedSpans,
            currentWindow.slotElements[pageIndex],
            currentWindow.pageOffsets[pageIndex],
          );
        })
        .catch((err) => {
          if (requestEpoch === layerEpoch && currentTab === requestTab) {
            console.error(`Failed to extract text for page ${pageIndex}:`, err);
          }
        })
        .finally(() => {
          activeFetches = Math.max(0, activeFetches - 1);
          if (requestEpoch === layerEpoch) {
            inFlightPages.delete(pageIndex);
            drainFetchQueue();
          }
        });
    }
  }

  function syncVisibleRange({
    tab,
    firstVisible,
    lastVisible,
    renderMin,
    renderMax,
    slotElements,
    pageOffsets,
  }) {
    if (!tab) {
      return;
    }

    currentTab = tab;
    currentWindow = {
      renderMin,
      renderMax,
      slotElements,
      pageOffsets,
    };

    const center = Math.floor((firstVisible + lastVisible) / 2);
    /** @type {Array<{ pageIndex: number, priority: number }>} */
    const needed = [];

    for (let i = renderMin; i <= renderMax; i += 1) {
      if (mountedLayers.has(i)) {
        continue;
      }
      const cached = getCachedPageText(tab, i);
      if (cached) {
        mountPageLayer(tab, i, cached, slotElements[i], pageOffsets[i]);
        continue;
      }
      if (inFlightPages.has(i)) {
        continue;
      }
      const isVisible = i >= firstVisible && i <= lastVisible;
      const distance = Math.abs(i - center);
      needed.push({ pageIndex: i, priority: (isVisible ? 0 : 1000) + distance });
    }

    needed.sort((a, b) => a.priority - b.priority);
    pendingQueue = needed.map((item) => item.pageIndex);
    drainFetchQueue();
  }

  function evictOutside(keepMin, keepMax, slotElements) {
    const selection = window.getSelection();
    for (const [pageIndex, layerEl] of mountedLayers.entries()) {
      if (pageIndex >= keepMin && pageIndex <= keepMax) {
        continue;
      }
      const slotEl = slotElements[pageIndex];
      // Preserve a page's text DOM while the user still holds an active selection in it.
      if (selectionIntersectsSlot(selection, slotEl)) {
        continue;
      }
      layerEl.remove();
      mountedLayers.delete(pageIndex);
    }
  }

  function rescaleMounted(slotElements, pageOffsets, pageDimensions) {
    for (const [pageIndex, layerEl] of mountedLayers.entries()) {
      const dims = pageDimensions?.[pageIndex];
      const geom = pageOffsets[pageIndex];
      if (!dims || !geom || !slotElements[pageIndex]) {
        continue;
      }
      const { transform } = buildLayerTransform(dims, geom);
      layerEl.style.transform = transform;
    }
  }

  function clearActiveSelection() {
    const selection = window.getSelection();
    if (selectionInsideViewport(selection, viewportEl)) {
      selection?.removeAllRanges();
    }
  }

  function clearMounted() {
    layerEpoch += 1;
    pendingQueue = [];
    inFlightPages.clear();
    for (const layerEl of mountedLayers.values()) {
      layerEl.remove();
    }
    mountedLayers.clear();
    currentTab = null;
    currentWindow = {
      renderMin: 0,
      renderMax: -1,
      slotElements: [],
      pageOffsets: [],
    };
  }

  function handleCopy(event) {
    const activeEl = document.activeElement;
    if (
      activeEl instanceof HTMLInputElement ||
      activeEl instanceof HTMLTextAreaElement
    ) {
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }
    if (!selectionInsideViewport(selection, viewportEl)) {
      return;
    }

    /** @type {Array<{ pageIndex: number, text: string, rect: { x: number, y: number, width: number, height: number } }>} */
    const fragments = [];
    const subRange = document.createRange();
    const sortedLayers = Array.from(mountedLayers.entries()).sort((a, b) => a[0] - b[0]);

    for (let r = 0; r < selection.rangeCount; r += 1) {
      const range = selection.getRangeAt(r);

      for (const [, layerEl] of sortedLayers) {
        if (!range.intersectsNode(layerEl)) {
          continue;
        }
        const spans = layerEl.querySelectorAll(".text-span");
        for (const spanEl of spans) {
          if (!range.intersectsNode(spanEl)) {
            continue;
          }
          const meta = spanMetaByEl.get(spanEl);
          if (!meta) {
            continue;
          }

          subRange.selectNodeContents(spanEl);
          if (range.compareBoundaryPoints(Range.START_TO_START, subRange) > 0) {
            subRange.setStart(range.startContainer, range.startOffset);
          }
          if (range.compareBoundaryPoints(Range.END_TO_END, subRange) < 0) {
            subRange.setEnd(range.endContainer, range.endOffset);
          }

          const piece = subRange.toString();
          if (piece.length > 0) {
            fragments.push({
              pageIndex: meta.pageIndex,
              text: piece,
              rect: meta.rect,
            });
          }
        }
      }
    }

    subRange.detach?.();

    const formatted = formatCopiedFragments(fragments);
    if (formatted.length === 0) {
      return;
    }

    if (event.clipboardData) {
      event.preventDefault();
      event.clipboardData.setData("text/plain", formatted);
    }
  }

  document.addEventListener("copy", handleCopy);

  function destroy() {
    document.removeEventListener("copy", handleCopy);
    clearMounted();
  }

  return {
    syncVisibleRange,
    evictOutside,
    rescaleMounted,
    clearActiveSelection,
    clearMounted,
    destroy,
  };
}
