import { normalizeHighlightSegments } from "../domain/highlights";
import type { ReaderApi } from "../ipc/client";
import type {
  HighlightSegment,
  NormalizedRect,
  PageDimensions,
  TextSpan,
} from "../ipc/types";
import { formatCopiedFragments, type CopiedTextFragment } from "./text-copy";
import { PT_TO_CSS_PX, type PageLayoutGeom } from "./viewport-math";

export const TEXT_LAYER_FONT = '"Segoe UI", Arial, sans-serif';
export const MAX_CONCURRENT_FETCHES = 2;
export const MAX_CACHED_PAGES_PER_TAB = 120;

export interface TextLayerSyncParams {
  readonly documentId: number;
  readonly pageDimensions: readonly PageDimensions[];
  readonly signal?: AbortSignal | null;
  readonly firstVisible: number;
  readonly lastVisible: number;
  readonly renderMin: number;
  readonly renderMax: number;
  readonly slotElements: readonly HTMLDivElement[];
  readonly pageOffsets: readonly PageLayoutGeom[];
}

export interface TextLayerEngineOptions {
  readonly viewportEl: HTMLElement;
  readonly api: Pick<ReaderApi, "getPageText">;
}

export interface ExtractedSelection {
  readonly segments: HighlightSegment[];
  readonly quote: string;
}

export interface TextLayerEngine {
  syncVisibleRange(params: TextLayerSyncParams): void;
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
  extractSelectionSegments(
    slotElements: readonly HTMLDivElement[],
  ): ExtractedSelection | null;
  clearActiveSelection(): void;
  clearMounted(): void;
  evictDocument(documentId: number): void;
  destroy(): void;
}

interface ActiveTextDoc {
  readonly documentId: number;
  readonly pageDimensions: readonly PageDimensions[];
  readonly signal: AbortSignal | null;
}

interface SyncWindow {
  renderMin: number;
  renderMax: number;
  slotElements: readonly HTMLDivElement[];
  pageOffsets: readonly PageLayoutGeom[];
}

interface SpanMeta {
  readonly pageIndex: number;
  readonly rect: NormalizedRect;
}

let cachedMeasureCtx: CanvasRenderingContext2D | null = null;

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (cachedMeasureCtx) {
    return cachedMeasureCtx;
  }
  const canvas = document.createElement("canvas");
  cachedMeasureCtx = canvas.getContext("2d");
  return cachedMeasureCtx;
}

function buildLayerTransform(
  dims: PageDimensions,
  geom: Pick<PageLayoutGeom, "width" | "height">,
) {
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

function selectionIntersectsSlot(
  selection: Selection | null,
  slotEl: HTMLElement | undefined,
): boolean {
  if (
    !selection ||
    selection.isCollapsed ||
    selection.rangeCount === 0 ||
    !slotEl
  ) {
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

function selectionInsideViewport(
  selection: Selection | null,
  viewportEl: HTMLElement,
): boolean {
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
 * Imperative transparent HTML text overlay engine with private per-document LRU cache,
 * selection-preserving eviction, CSS scale zooming, and `copy` Range formatting.
 */
export function createTextLayerEngine({
  viewportEl,
  api,
}: TextLayerEngineOptions): TextLayerEngine {
  // Owned privately outside Svelte reactivity to avoid proxying large text span caches.
  const cachesByDocId = new Map<number, Map<number, TextSpan[]>>();
  let currentDoc: ActiveTextDoc | null = null;
  let layerEpoch = 0;
  let activeFetches = 0;
  let pendingQueue: number[] = [];
  const inFlightPages = new Set<number>();
  const mountedLayers = new Map<number, HTMLElement>();
  const spanMetaByEl = new WeakMap<HTMLElement, SpanMeta>();
  let destroyed = false;

  let currentWindow: SyncWindow = {
    renderMin: 0,
    renderMax: -1,
    slotElements: [],
    pageOffsets: [],
  };

  function getCachedPageText(
    documentId: number,
    pageIndex: number,
  ): TextSpan[] | null {
    const cache = cachesByDocId.get(documentId);
    if (!cache || !cache.has(pageIndex)) {
      return null;
    }
    const spans = cache.get(pageIndex) ?? null;
    if (spans) {
      // Refresh LRU recency on hit.
      cache.delete(pageIndex);
      cache.set(pageIndex, spans);
    }
    return spans;
  }

  function setCachedPageText(
    documentId: number,
    pageIndex: number,
    spans: TextSpan[],
  ): void {
    let cache = cachesByDocId.get(documentId);
    if (!cache) {
      cache = new Map<number, TextSpan[]>();
      cachesByDocId.set(documentId, cache);
    }
    if (cache.has(pageIndex)) {
      cache.delete(pageIndex);
    }
    cache.set(pageIndex, spans);

    while (cache.size > MAX_CACHED_PAGES_PER_TAB) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      cache.delete(oldestKey);
    }
  }

  function mountPageLayer(
    doc: ActiveTextDoc,
    pageIndex: number,
    spans: readonly TextSpan[],
    slotEl: HTMLDivElement | undefined,
    geom: PageLayoutGeom | undefined,
  ): void {
    if (!slotEl || !geom || mountedLayers.has(pageIndex)) {
      return;
    }
    const dims = doc.pageDimensions[pageIndex];
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

  function drainFetchQueue(): void {
    if (!currentDoc || destroyed) {
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

      const cached = getCachedPageText(currentDoc.documentId, pageIndex);
      if (cached) {
        mountPageLayer(
          currentDoc,
          pageIndex,
          cached,
          currentWindow.slotElements[pageIndex],
          currentWindow.pageOffsets[pageIndex],
        );
        continue;
      }

      const requestDoc = currentDoc;
      const requestEpoch = layerEpoch;

      inFlightPages.add(pageIndex);
      activeFetches += 1;

      api
        .getPageText(requestDoc.documentId, pageIndex)
        .then((spans) => {
          if (destroyed || requestDoc.signal?.aborted) {
            return;
          }

          const normalizedSpans = Array.isArray(spans) ? spans : [];
          setCachedPageText(requestDoc.documentId, pageIndex, normalizedSpans);

          if (
            requestEpoch !== layerEpoch ||
            currentDoc?.documentId !== requestDoc.documentId ||
            pageIndex < currentWindow.renderMin ||
            pageIndex > currentWindow.renderMax
          ) {
            return;
          }

          mountPageLayer(
            requestDoc,
            pageIndex,
            normalizedSpans,
            currentWindow.slotElements[pageIndex],
            currentWindow.pageOffsets[pageIndex],
          );
        })
        .catch((err) => {
          if (
            !destroyed &&
            !requestDoc.signal?.aborted &&
            requestEpoch === layerEpoch &&
            currentDoc?.documentId === requestDoc.documentId
          ) {
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
    documentId,
    pageDimensions,
    signal = null,
    firstVisible,
    lastVisible,
    renderMin,
    renderMax,
    slotElements,
    pageOffsets,
  }: TextLayerSyncParams): void {
    if (destroyed) {
      return;
    }

    const doc: ActiveTextDoc = { documentId, pageDimensions, signal };
    currentDoc = doc;
    currentWindow = {
      renderMin,
      renderMax,
      slotElements,
      pageOffsets,
    };

    const center = Math.floor((firstVisible + lastVisible) / 2);
    const needed: Array<{ pageIndex: number; priority: number }> = [];

    for (let i = renderMin; i <= renderMax; i += 1) {
      if (mountedLayers.has(i)) {
        continue;
      }
      const cached = getCachedPageText(documentId, i);
      if (cached) {
        mountPageLayer(doc, i, cached, slotElements[i], pageOffsets[i]);
        continue;
      }
      if (inFlightPages.has(i)) {
        continue;
      }
      const isVisible = i >= firstVisible && i <= lastVisible;
      const distance = Math.abs(i - center);
      needed.push({
        pageIndex: i,
        priority: (isVisible ? 0 : 1000) + distance,
      });
    }

    needed.sort((a, b) => a.priority - b.priority);
    pendingQueue = needed.map((item) => item.pageIndex);
    drainFetchQueue();
  }

  function evictOutside(
    keepMin: number,
    keepMax: number,
    slotElements: readonly HTMLDivElement[],
  ): void {
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

  function rescaleMounted(
    slotElements: readonly HTMLDivElement[],
    pageOffsets: readonly PageLayoutGeom[],
    pageDimensions: readonly PageDimensions[],
  ): void {
    for (const [pageIndex, layerEl] of mountedLayers.entries()) {
      const dims = pageDimensions[pageIndex];
      const geom = pageOffsets[pageIndex];
      if (!dims || !geom || !slotElements[pageIndex]) {
        continue;
      }
      const { transform } = buildLayerTransform(dims, geom);
      layerEl.style.transform = transform;
    }
  }

  function clearActiveSelection(): void {
    const selection = window.getSelection();
    if (selectionInsideViewport(selection, viewportEl)) {
      selection?.removeAllRanges();
    }
  }

  function clearMounted(): void {
    layerEpoch += 1;
    pendingQueue = [];
    inFlightPages.clear();
    for (const layerEl of mountedLayers.values()) {
      layerEl.remove();
    }
    mountedLayers.clear();
    currentDoc = null;
    currentWindow = {
      renderMin: 0,
      renderMax: -1,
      slotElements: [],
      pageOffsets: [],
    };
  }

  function evictDocument(documentId: number): void {
    cachesByDocId.delete(documentId);
    if (currentDoc?.documentId === documentId) {
      clearMounted();
    }
  }

  function collectSelectedSpanFragments(
    selection: Selection,
    onSpanPiece: (meta: SpanMeta, piece: string, subRange: Range) => void,
  ): void {
    const startToStart =
      typeof Range !== "undefined" ? Range.START_TO_START : 0;
    const endToEnd = typeof Range !== "undefined" ? Range.END_TO_END : 2;
    const subRange = document.createRange();
    const sortedLayers = Array.from(mountedLayers.entries()).sort(
      (a, b) => a[0] - b[0],
    );

    for (let r = 0; r < selection.rangeCount; r += 1) {
      const range = selection.getRangeAt(r);

      for (const [, layerEl] of sortedLayers) {
        if (!range.intersectsNode(layerEl)) {
          continue;
        }
        const spans =
          typeof layerEl.querySelectorAll === "function"
            ? layerEl.querySelectorAll<HTMLElement>(".text-span")
            : (Array.from(layerEl.children) as HTMLElement[]);
        for (const spanEl of spans) {
          if (!range.intersectsNode(spanEl)) {
            continue;
          }
          const meta = spanMetaByEl.get(spanEl);
          if (!meta) {
            continue;
          }

          subRange.selectNodeContents(spanEl);
          if (range.compareBoundaryPoints(startToStart, subRange) > 0) {
            subRange.setStart(range.startContainer, range.startOffset);
          }
          if (range.compareBoundaryPoints(endToEnd, subRange) < 0) {
            subRange.setEnd(range.endContainer, range.endOffset);
          }

          const piece = subRange.toString();
          if (piece.length > 0) {
            onSpanPiece(meta, piece, subRange);
          }
        }
      }
    }

    if (typeof subRange.detach === "function") {
      subRange.detach();
    }
  }

  function extractSelectionSegments(
    slotElements: readonly HTMLDivElement[],
  ): ExtractedSelection | null {
    if (
      typeof window === "undefined" ||
      typeof window.getSelection !== "function"
    ) {
      return null;
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }
    if (!selectionInsideViewport(selection, viewportEl)) {
      return null;
    }

    const copiedFragments: CopiedTextFragment[] = [];
    const rawRectsByPage = new Map<number, NormalizedRect[]>();

    collectSelectedSpanFragments(selection, (meta, piece, subRange) => {
      copiedFragments.push({
        pageIndex: meta.pageIndex,
        text: piece,
        rect: meta.rect,
      });

      if (piece.trim().length === 0) {
        return;
      }

      const slotEl = slotElements[meta.pageIndex];
      if (!slotEl || typeof slotEl.getBoundingClientRect !== "function") {
        return;
      }
      const slotRect = slotEl.getBoundingClientRect();
      if (slotRect.width <= 0) {
        return;
      }

      if (typeof subRange.getBoundingClientRect !== "function") {
        return;
      }
      const rangeRect = subRange.getBoundingClientRect();
      const rawX0 = (rangeRect.left - slotRect.left) / slotRect.width;
      const rawX1 = (rangeRect.right - slotRect.left) / slotRect.width;
      if (!Number.isFinite(rawX0) || !Number.isFinite(rawX1)) {
        return;
      }

      const minSpanX = meta.rect.x;
      const maxSpanX = meta.rect.x + meta.rect.width;
      const x0 = Math.max(minSpanX, Math.min(maxSpanX, rawX0));
      const x1 = Math.max(minSpanX, Math.min(maxSpanX, rawX1));
      const width = x1 - x0;
      if (width <= 0) {
        return;
      }

      let rects = rawRectsByPage.get(meta.pageIndex);
      if (!rects) {
        rects = [];
        rawRectsByPage.set(meta.pageIndex, rects);
      }
      // Keep exact PDFium vertical span bounds so fallback UI font metrics never jitter highlight height.
      rects.push({
        x: x0,
        y: meta.rect.y,
        width,
        height: meta.rect.height,
      });
    });

    const rawSegments: HighlightSegment[] = [];
    for (const [pageIndex, rects] of rawRectsByPage.entries()) {
      rawSegments.push({ page_index: pageIndex, rects });
    }

    const segments = normalizeHighlightSegments(rawSegments);
    if (segments.length === 0) {
      return null;
    }

    return {
      segments,
      quote: formatCopiedFragments(copiedFragments),
    };
  }

  function handleCopy(event: ClipboardEvent): void {
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

    const fragments: CopiedTextFragment[] = [];
    collectSelectedSpanFragments(selection, (meta, piece) => {
      fragments.push({
        pageIndex: meta.pageIndex,
        text: piece,
        rect: meta.rect,
      });
    });

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

  function destroy(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    document.removeEventListener("copy", handleCopy);
    clearMounted();
    cachesByDocId.clear();
  }

  return {
    syncVisibleRange,
    evictOutside,
    rescaleMounted,
    extractSelectionSegments,
    clearActiveSelection,
    clearMounted,
    evictDocument,
    destroy,
  };
}
