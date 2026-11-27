import {
  hitTestPageHighlights,
  type PageHighlightEntry,
} from "../domain/highlights";
import type { HighlightSegment, NormalizedRect } from "../ipc/types";
import type { ExtractedSelection } from "./text-layer";
import { findFirstPageAtOrAfter, type PageLayoutGeom } from "./viewport-math";

export const HIGHLIGHT_CLICK_DRAG_THRESHOLD_PX = 4;

export interface HighlightAnchorRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface HighlightLayerSyncParams {
  readonly documentId: number;
  readonly renderMin: number;
  readonly renderMax: number;
  readonly slotElements: readonly HTMLDivElement[];
  readonly pageOffsets: readonly PageLayoutGeom[];
  readonly highlightsByPage?: ReadonlyMap<
    number,
    readonly PageHighlightEntry[]
  > | null;
}

export interface HighlightLayerEngineOptions {
  readonly viewportEl: HTMLElement;
  readonly getHighlighterMode: () => boolean;
  readonly isLinkAtPoint: (clientX: number, clientY: number) => boolean;
  readonly extractSelection: (
    slotElements: readonly HTMLDivElement[],
  ) => ExtractedSelection | null;
  readonly clearActiveSelection: () => void;
  readonly onCreateFromSelection: (
    documentId: number,
    segments: HighlightSegment[],
    quote: string,
  ) => void;
  readonly onSelectHighlight: (
    documentId: number,
    highlightId: string,
    anchorRect: HighlightAnchorRect,
  ) => void;
  readonly onDismissPopover: () => void;
}

export interface HighlightLayerEngine {
  syncVisibleRange(params: HighlightLayerSyncParams): void;
  syncHighlights(
    byPage: ReadonlyMap<number, readonly PageHighlightEntry[]> | null,
  ): void;
  setSelectedHighlightId(highlightId: string | null): void;
  evictOutside(keepMin: number, keepMax: number): void;
  clearMounted(): void;
  destroy(): void;
}

interface SyncWindow {
  renderMin: number;
  renderMax: number;
  slotElements: readonly HTMLDivElement[];
  pageOffsets: readonly PageLayoutGeom[];
}

interface MountedGroupEntry {
  readonly groupEl: HTMLElement;
  readonly rectElements: readonly HTMLElement[];
}

interface PointerDownState {
  readonly x: number;
  readonly y: number;
  dragged: boolean;
}

/**
 * Imperative virtualized `.highlight-layer` overlay engine.
 * Renders percentage-positioned user highlights, manages cross-page hover/selected states,
 * yields click and hover priority to PDF `/Link` annotations, and captures Highlighter Mode selections.
 */
export function createHighlightLayerEngine({
  viewportEl,
  getHighlighterMode,
  isLinkAtPoint,
  extractSelection,
  clearActiveSelection,
  onCreateFromSelection,
  onSelectHighlight,
  onDismissPopover,
}: HighlightLayerEngineOptions): HighlightLayerEngine {
  let currentDocId: number | null = null;
  let activeByPage: ReadonlyMap<number, readonly PageHighlightEntry[]> | null =
    null;
  const mountedLayers = new Map<number, HTMLElement>();
  const groupsByPage = new Map<number, Map<string, MountedGroupEntry>>();
  let hoveredHighlightId: string | null = null;
  let selectedHighlightId: string | null = null;
  let pointerDown: PointerDownState | null = null;
  let suppressNextClick = false;
  let destroyed = false;

  let currentWindow: SyncWindow = {
    renderMin: 0,
    renderMax: -1,
    slotElements: [],
    pageOffsets: [],
  };

  function hasActiveViewportSelection(): boolean {
    if (
      typeof window === "undefined" ||
      typeof window.getSelection !== "function"
    ) {
      return false;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return false;
    }
    if (typeof viewportEl.contains !== "function") {
      return selection.toString().length > 0;
    }
    for (let i = 0; i < selection.rangeCount; i += 1) {
      const range = selection.getRangeAt(i);
      if (viewportEl.contains(range.commonAncestorContainer)) {
        return true;
      }
    }
    return false;
  }

  function toggleGroupClassAcrossPages(
    highlightId: string | null,
    className: string,
    enabled: boolean,
  ): void {
    if (!highlightId) {
      return;
    }
    for (const pageGroups of groupsByPage.values()) {
      const entry = pageGroups.get(highlightId);
      if (!entry) {
        continue;
      }
      if (enabled) {
        entry.groupEl.classList?.add(className);
      } else {
        entry.groupEl.classList?.remove(className);
      }
    }
  }

  function clearHover(): void {
    if (hoveredHighlightId) {
      toggleGroupClassAcrossPages(
        hoveredHighlightId,
        "pdf-highlight-group--hover",
        false,
      );
      hoveredHighlightId = null;
    }
    viewportEl.classList?.remove("viewport--highlight-hover");
  }

  function applyHover(highlightId: string): void {
    if (hoveredHighlightId === highlightId) {
      return;
    }
    if (hoveredHighlightId) {
      toggleGroupClassAcrossPages(
        hoveredHighlightId,
        "pdf-highlight-group--hover",
        false,
      );
    }
    hoveredHighlightId = highlightId;
    toggleGroupClassAcrossPages(
      highlightId,
      "pdf-highlight-group--hover",
      true,
    );
    viewportEl.classList?.add("viewport--highlight-hover");
  }

  function removePageLayer(pageIndex: number): void {
    const layer = mountedLayers.get(pageIndex);
    if (layer) {
      layer.remove();
      mountedLayers.delete(pageIndex);
    }
    groupsByPage.delete(pageIndex);
  }

  function hasAnyMountedGroup(highlightId: string): boolean {
    for (const pageGroups of groupsByPage.values()) {
      if (pageGroups.has(highlightId)) {
        return true;
      }
    }
    return false;
  }

  function paintPageLayer(pageIndex: number): void {
    const slotEl = currentWindow.slotElements[pageIndex];
    const entries = activeByPage?.get(pageIndex);
    if (!slotEl || !entries || entries.length === 0) {
      removePageLayer(pageIndex);
      return;
    }

    let layerEl = mountedLayers.get(pageIndex);
    if (!layerEl) {
      layerEl = document.createElement("div");
      layerEl.className = "highlight-layer";
      layerEl.setAttribute("aria-hidden", "true");
      slotEl.appendChild(layerEl);
      mountedLayers.set(pageIndex, layerEl);
    } else {
      layerEl.textContent = "";
    }

    const pageGroups = new Map<string, MountedGroupEntry>();
    const fragment = document.createDocumentFragment();

    for (const entry of entries) {
      if (!entry || entry.rects.length === 0) {
        continue;
      }

      const groupEl = document.createElement("div");
      groupEl.className = "pdf-highlight-group";
      groupEl.setAttribute("data-highlight-id", entry.highlightId);
      if (hoveredHighlightId === entry.highlightId) {
        groupEl.classList?.add("pdf-highlight-group--hover");
      }
      if (selectedHighlightId === entry.highlightId) {
        groupEl.classList?.add("pdf-highlight-group--selected");
      }

      const rectElements: HTMLElement[] = [];
      for (const rect of entry.rects) {
        const rectEl = document.createElement("div");
        rectEl.className = `pdf-highlight-rect pdf-highlight-rect--${entry.color}`;
        rectEl.style.left = `${(rect.x * 100).toFixed(4)}%`;
        rectEl.style.top = `${(rect.y * 100).toFixed(4)}%`;
        rectEl.style.width = `${(rect.width * 100).toFixed(4)}%`;
        rectEl.style.height = `${(rect.height * 100).toFixed(4)}%`;
        rectElements.push(rectEl);
        groupEl.appendChild(rectEl);
      }

      pageGroups.set(entry.highlightId, { groupEl, rectElements });
      fragment.appendChild(groupEl);
    }

    if (pageGroups.size === 0) {
      removePageLayer(pageIndex);
      return;
    }

    groupsByPage.set(pageIndex, pageGroups);
    layerEl.appendChild(fragment);
  }

  function repaintCurrentWindow(): void {
    if (
      currentDocId === null ||
      currentWindow.renderMax < currentWindow.renderMin
    ) {
      for (const pageIndex of Array.from(mountedLayers.keys())) {
        removePageLayer(pageIndex);
      }
      clearHover();
      return;
    }

    for (const pageIndex of Array.from(mountedLayers.keys())) {
      if (
        pageIndex < currentWindow.renderMin ||
        pageIndex > currentWindow.renderMax
      ) {
        removePageLayer(pageIndex);
      }
    }

    for (
      let pageIndex = currentWindow.renderMin;
      pageIndex <= currentWindow.renderMax;
      pageIndex += 1
    ) {
      paintPageLayer(pageIndex);
    }

    if (hoveredHighlightId && !hasAnyMountedGroup(hoveredHighlightId)) {
      clearHover();
    }
  }

  function syncVisibleRange({
    documentId,
    renderMin,
    renderMax,
    slotElements,
    pageOffsets,
    highlightsByPage,
  }: HighlightLayerSyncParams): void {
    if (destroyed) {
      return;
    }

    currentDocId = documentId;
    currentWindow = {
      renderMin,
      renderMax,
      slotElements,
      pageOffsets,
    };
    if (highlightsByPage !== undefined) {
      activeByPage = highlightsByPage;
    }

    repaintCurrentWindow();
  }

  function syncHighlights(
    byPage: ReadonlyMap<number, readonly PageHighlightEntry[]> | null,
  ): void {
    if (destroyed) {
      return;
    }
    activeByPage = byPage;
    repaintCurrentWindow();
  }

  function setSelectedHighlightId(highlightId: string | null): void {
    if (selectedHighlightId === highlightId) {
      return;
    }
    if (selectedHighlightId) {
      toggleGroupClassAcrossPages(
        selectedHighlightId,
        "pdf-highlight-group--selected",
        false,
      );
    }
    selectedHighlightId = highlightId;
    if (selectedHighlightId) {
      toggleGroupClassAcrossPages(
        selectedHighlightId,
        "pdf-highlight-group--selected",
        true,
      );
    }
  }

  function evictOutside(keepMin: number, keepMax: number): void {
    for (const pageIndex of Array.from(mountedLayers.keys())) {
      if (pageIndex < keepMin || pageIndex > keepMax) {
        removePageLayer(pageIndex);
      }
    }
    if (hoveredHighlightId && !hasAnyMountedGroup(hoveredHighlightId)) {
      clearHover();
    }
  }

  function clearMounted(): void {
    clearHover();
    setSelectedHighlightId(null);
    pointerDown = null;
    suppressNextClick = false;
    for (const pageIndex of Array.from(mountedLayers.keys())) {
      removePageLayer(pageIndex);
    }
    mountedLayers.clear();
    groupsByPage.clear();
    currentDocId = null;
    activeByPage = null;
    currentWindow = {
      renderMin: 0,
      renderMax: -1,
      slotElements: [],
      pageOffsets: [],
    };
  }

  function computeAnchorRect(
    pageIndex: number,
    highlightId: string,
    hitRect: NormalizedRect,
    slotRect: DOMRect,
    viewportRect: DOMRect,
  ): HighlightAnchorRect {
    let clientLeft = slotRect.left + hitRect.x * slotRect.width;
    let clientTop = slotRect.top + hitRect.y * slotRect.height;
    let clientWidth = hitRect.width * slotRect.width;
    let clientHeight = hitRect.height * slotRect.height;

    const entries = activeByPage?.get(pageIndex);
    const groupEntry = groupsByPage.get(pageIndex)?.get(highlightId);
    const matchingEntry = entries?.find(
      (item) => item.highlightId === highlightId,
    );
    if (groupEntry && matchingEntry) {
      const rectIndex = matchingEntry.rects.indexOf(hitRect);
      const rectEl = rectIndex >= 0 ? groupEntry.rectElements[rectIndex] : null;
      if (rectEl && typeof rectEl.getBoundingClientRect === "function") {
        const box = rectEl.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) {
          clientLeft = box.left;
          clientTop = box.top;
          clientWidth = box.width;
          clientHeight = box.height;
        }
      }
    }

    const hostEl = viewportEl.parentElement ?? viewportEl;
    const hostRect =
      typeof hostEl.getBoundingClientRect === "function"
        ? hostEl.getBoundingClientRect()
        : viewportRect;

    return {
      left: clientLeft - hostRect.left,
      top: clientTop - hostRect.top,
      width: clientWidth,
      height: clientHeight,
    };
  }

  function resolveHighlightHitAtClientPoint(
    clientX: number,
    clientY: number,
  ): {
    readonly documentId: number;
    readonly highlightId: string;
    readonly anchorRect: HighlightAnchorRect;
  } | null {
    if (
      currentDocId === null ||
      !activeByPage ||
      currentWindow.pageOffsets.length === 0 ||
      typeof viewportEl.getBoundingClientRect !== "function"
    ) {
      return null;
    }

    const viewportRect = viewportEl.getBoundingClientRect();
    if (
      clientX < viewportRect.left ||
      clientX > viewportRect.right ||
      clientY < viewportRect.top ||
      clientY > viewportRect.bottom
    ) {
      return null;
    }

    const trackY = clientY - viewportRect.top + viewportEl.scrollTop;
    const candidatePage = findFirstPageAtOrAfter(
      currentWindow.pageOffsets,
      trackY,
    );
    const slotEl = currentWindow.slotElements[candidatePage];
    if (!slotEl || typeof slotEl.getBoundingClientRect !== "function") {
      return null;
    }

    const slotRect = slotEl.getBoundingClientRect();
    if (
      slotRect.width <= 0 ||
      slotRect.height <= 0 ||
      clientX < slotRect.left ||
      clientX > slotRect.right ||
      clientY < slotRect.top ||
      clientY > slotRect.bottom
    ) {
      return null;
    }

    const entries = activeByPage.get(candidatePage);
    if (!entries || entries.length === 0) {
      return null;
    }

    const normX = (clientX - slotRect.left) / slotRect.width;
    const normY = (clientY - slotRect.top) / slotRect.height;
    const hit = hitTestPageHighlights(entries, normX, normY);
    if (!hit) {
      return null;
    }

    return {
      documentId: currentDocId,
      highlightId: hit.highlightId,
      anchorRect: computeAnchorRect(
        candidatePage,
        hit.highlightId,
        hit.rect,
        slotRect,
        viewportRect,
      ),
    };
  }

  function handlePointerDown(event: PointerEvent): void {
    if (destroyed || event.button !== 0) {
      return;
    }
    suppressNextClick = false;
    pointerDown = {
      x: event.clientX,
      y: event.clientY,
      dragged: false,
    };
  }

  function handlePointerMove(event: PointerEvent): void {
    if (destroyed) {
      return;
    }
    if (pointerDown && (event.buttons & 1) !== 0) {
      const dist = Math.hypot(
        event.clientX - pointerDown.x,
        event.clientY - pointerDown.y,
      );
      if (dist > HIGHLIGHT_CLICK_DRAG_THRESHOLD_PX) {
        pointerDown.dragged = true;
        clearHover();
      }
      return;
    }
    if ((event.buttons & 1) !== 0) {
      clearHover();
      return;
    }
    if (isLinkAtPoint(event.clientX, event.clientY)) {
      clearHover();
      return;
    }

    const hit = resolveHighlightHitAtClientPoint(event.clientX, event.clientY);
    if (hit) {
      applyHover(hit.highlightId);
    } else {
      clearHover();
    }
  }

  function handlePointerUp(event: PointerEvent): void {
    if (destroyed || event.button !== 0) {
      return;
    }
    if (
      currentDocId === null ||
      !getHighlighterMode() ||
      !hasActiveViewportSelection()
    ) {
      return;
    }

    const extracted = extractSelection(currentWindow.slotElements);
    if (!extracted || extracted.segments.length === 0) {
      return;
    }

    suppressNextClick = true;
    clearActiveSelection();
    onCreateFromSelection(currentDocId, extracted.segments, extracted.quote);
  }

  function handlePointerLeave(): void {
    clearHover();
  }

  function handleViewportScroll(): void {
    clearHover();
    onDismissPopover();
  }

  function handleClick(event: MouseEvent): void {
    const down = pointerDown;
    pointerDown = null;
    const skipCreatedClick = suppressNextClick;
    suppressNextClick = false;

    if (
      destroyed ||
      event.defaultPrevented ||
      skipCreatedClick ||
      event.button !== 0 ||
      event.detail > 1 ||
      down?.dragged
    ) {
      return;
    }

    if (
      typeof HTMLElement !== "undefined" &&
      event.target instanceof HTMLElement &&
      event.target.classList?.contains("pdf-link-hit")
    ) {
      return;
    }

    if (hasActiveViewportSelection()) {
      return;
    }

    if (isLinkAtPoint(event.clientX, event.clientY)) {
      return;
    }

    const hit = resolveHighlightHitAtClientPoint(event.clientX, event.clientY);
    if (hit) {
      onSelectHighlight(hit.documentId, hit.highlightId, hit.anchorRect);
    } else {
      onDismissPopover();
    }
  }

  const hasDomListeners = typeof viewportEl.addEventListener === "function";
  if (hasDomListeners) {
    viewportEl.addEventListener("pointerdown", handlePointerDown);
    viewportEl.addEventListener("pointermove", handlePointerMove);
    viewportEl.addEventListener("pointerup", handlePointerUp);
    viewportEl.addEventListener("pointerleave", handlePointerLeave);
    viewportEl.addEventListener("scroll", handleViewportScroll, {
      passive: true,
    });
    viewportEl.addEventListener("click", handleClick);
  }

  function destroy(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    if (
      hasDomListeners &&
      typeof viewportEl.removeEventListener === "function"
    ) {
      viewportEl.removeEventListener("pointerdown", handlePointerDown);
      viewportEl.removeEventListener("pointermove", handlePointerMove);
      viewportEl.removeEventListener("pointerup", handlePointerUp);
      viewportEl.removeEventListener("pointerleave", handlePointerLeave);
      viewportEl.removeEventListener("scroll", handleViewportScroll);
      viewportEl.removeEventListener("click", handleClick);
    }
    clearMounted();
  }

  return {
    syncVisibleRange,
    syncHighlights,
    setSelectedHighlightId,
    evictOutside,
    clearMounted,
    destroy,
  };
}
