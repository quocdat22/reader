import type { ReaderApi } from "../ipc/client";
import type { PageLink } from "../ipc/types";
import { findFirstPageAtOrAfter, type PageLayoutGeom } from "./viewport-math";

export const MAX_CONCURRENT_LINK_FETCHES = 2;
export const MAX_CACHED_LINK_PAGES_PER_TAB = 120;
export const LINK_CLICK_DRAG_THRESHOLD_PX = 4;

export interface LinkLayerSyncParams {
  readonly documentId: number;
  readonly signal?: AbortSignal | null;
  readonly firstVisible: number;
  readonly lastVisible: number;
  readonly renderMin: number;
  readonly renderMax: number;
  readonly slotElements: readonly HTMLDivElement[];
  readonly pageOffsets: readonly PageLayoutGeom[];
}

export interface LinkLayerEngineOptions {
  readonly viewportEl: HTMLElement;
  readonly api: Pick<ReaderApi, "getPageLinks">;
  readonly onActivateLink: (documentId: number, link: PageLink) => void;
}

export interface LinkLayerEngine {
  syncVisibleRange(params: LinkLayerSyncParams): void;
  evictOutside(keepMin: number, keepMax: number): void;
  clearMounted(): void;
  evictDocument(documentId: number): void;
  destroy(): void;
}

interface ActiveLinkDoc {
  readonly documentId: number;
  readonly signal: AbortSignal | null;
}

interface SyncWindow {
  renderMin: number;
  renderMax: number;
  slotElements: readonly HTMLDivElement[];
  pageOffsets: readonly PageLayoutGeom[];
}

interface ButtonMeta {
  readonly documentId: number;
  readonly link: PageLink;
}

interface HoveredLinkState {
  readonly pageIndex: number;
  readonly linkIndex: number;
  readonly groupEl: HTMLElement;
}

interface PointerDownState {
  readonly x: number;
  readonly y: number;
  readonly hadSelection: boolean;
  dragged: boolean;
}

/**
 * Formats an accessible tooltip string for a clickable PDF link.
 */
export function formatLinkTooltip(link: PageLink): string {
  if (link.target.kind === "internal") {
    return `Go to page ${link.target.page_index + 1}`;
  }
  return link.target.uri;
}

/**
 * Formats an ARIA label for keyboard/screen-reader link elements.
 */
export function formatLinkAriaLabel(link: PageLink): string {
  if (link.target.kind === "internal") {
    return `Go to page ${link.target.page_index + 1}`;
  }
  return `Open link ${link.target.uri}`;
}

/**
 * Returns the top-most link index on a page containing `(normX, normY)`, or `-1` if none match.
 */
export function hitTestPageLinks(
  links: readonly PageLink[],
  normX: number,
  normY: number,
): number {
  if (
    !Number.isFinite(normX) ||
    !Number.isFinite(normY) ||
    normX < 0 ||
    normX > 1 ||
    normY < 0 ||
    normY > 1
  ) {
    return -1;
  }

  // Reverse-scan so later PDF annotations win over earlier ones on overlap.
  for (let i = links.length - 1; i >= 0; i -= 1) {
    const link = links[i];
    if (!link) {
      continue;
    }
    for (const rect of link.rects) {
      if (
        normX >= rect.x &&
        normX <= rect.x + rect.width &&
        normY >= rect.y &&
        normY <= rect.y + rect.height
      ) {
        return i;
      }
    }
  }
  return -1;
}

function hasActiveSelection(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.getSelection !== "function"
  ) {
    return false;
  }
  const selection = window.getSelection();
  return Boolean(
    selection && !selection.isCollapsed && selection.toString().length > 0,
  );
}

/**
 * Imperative PDF link overlay engine with private per-document LRU caching,
 * pointer hit-testing that never disrupts text drag-selection, native `title`
 * tooltips, and keyboard-focusable link targets.
 */
export function createLinkLayerEngine({
  viewportEl,
  api,
  onActivateLink,
}: LinkLayerEngineOptions): LinkLayerEngine {
  const cachesByDocId = new Map<number, Map<number, PageLink[]>>();
  let currentDoc: ActiveLinkDoc | null = null;
  let layerEpoch = 0;
  let activeFetches = 0;
  let pendingQueue: number[] = [];
  const inFlightPages = new Set<number>();
  const mountedLayers = new Map<number, HTMLElement>();
  const groupRefsByPage = new Map<number, HTMLElement[]>();
  const buttonMeta = new WeakMap<HTMLElement, ButtonMeta>();
  let hovered: HoveredLinkState | null = null;
  let appliedTooltip = false;
  let pointerDown: PointerDownState | null = null;
  let destroyed = false;

  let currentWindow: SyncWindow = {
    renderMin: 0,
    renderMax: -1,
    slotElements: [],
    pageOffsets: [],
  };

  function peekCachedPageLinks(
    documentId: number,
    pageIndex: number,
  ): PageLink[] | null {
    return cachesByDocId.get(documentId)?.get(pageIndex) ?? null;
  }

  function getCachedPageLinks(
    documentId: number,
    pageIndex: number,
  ): PageLink[] | null {
    const cache = cachesByDocId.get(documentId);
    if (!cache || !cache.has(pageIndex)) {
      return null;
    }
    const links = cache.get(pageIndex) ?? null;
    if (links) {
      cache.delete(pageIndex);
      cache.set(pageIndex, links);
    }
    return links;
  }

  function setCachedPageLinks(
    documentId: number,
    pageIndex: number,
    links: PageLink[],
  ): void {
    let cache = cachesByDocId.get(documentId);
    if (!cache) {
      cache = new Map<number, PageLink[]>();
      cachesByDocId.set(documentId, cache);
    }
    if (cache.has(pageIndex)) {
      cache.delete(pageIndex);
    }
    cache.set(pageIndex, links);

    while (cache.size > MAX_CACHED_LINK_PAGES_PER_TAB) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      cache.delete(oldestKey);
    }
  }

  function clearHover(): void {
    if (hovered) {
      hovered.groupEl.classList?.remove("pdf-link-group--hover");
      hovered = null;
    }
    viewportEl.classList?.remove("viewport--link-hover");
    if (appliedTooltip) {
      viewportEl.removeAttribute?.("title");
      appliedTooltip = false;
    }
  }

  function applyHover(
    pageIndex: number,
    linkIndex: number,
    link: PageLink,
  ): void {
    if (
      hovered &&
      hovered.pageIndex === pageIndex &&
      hovered.linkIndex === linkIndex
    ) {
      return;
    }

    const groupEl = groupRefsByPage.get(pageIndex)?.[linkIndex];
    if (!groupEl) {
      clearHover();
      return;
    }

    if (hovered && hovered.groupEl !== groupEl) {
      hovered.groupEl.classList?.remove("pdf-link-group--hover");
    }

    groupEl.classList?.add("pdf-link-group--hover");
    hovered = { pageIndex, linkIndex, groupEl };
    viewportEl.classList?.add("viewport--link-hover");
    viewportEl.setAttribute?.("title", formatLinkTooltip(link));
    appliedTooltip = true;
  }

  function resolveHitAtClientPoint(
    clientX: number,
    clientY: number,
  ): { pageIndex: number; linkIndex: number; link: PageLink } | null {
    if (
      !currentDoc ||
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
    const slot = currentWindow.slotElements[candidatePage];
    if (!slot || typeof slot.getBoundingClientRect !== "function") {
      return null;
    }

    const slotRect = slot.getBoundingClientRect();
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

    const links = peekCachedPageLinks(currentDoc.documentId, candidatePage);
    if (!links || links.length === 0) {
      return null;
    }

    const normX = (clientX - slotRect.left) / slotRect.width;
    const normY = (clientY - slotRect.top) / slotRect.height;
    const linkIndex = hitTestPageLinks(links, normX, normY);
    if (linkIndex < 0) {
      return null;
    }
    const link = links[linkIndex];
    return link ? { pageIndex: candidatePage, linkIndex, link } : null;
  }

  function mountPageLayer(
    doc: ActiveLinkDoc,
    pageIndex: number,
    links: readonly PageLink[],
    slotEl: HTMLDivElement | undefined,
  ): void {
    if (!slotEl || mountedLayers.has(pageIndex) || links.length === 0) {
      return;
    }

    const layerEl = document.createElement("div");
    layerEl.className = "link-layer";
    const groups: HTMLElement[] = [];
    const fragment = document.createDocumentFragment();

    for (const link of links) {
      if (!link || link.rects.length === 0) {
        continue;
      }

      const groupEl = document.createElement("div");
      groupEl.className = "pdf-link-group";

      link.rects.forEach((rect, rectIdx) => {
        const pctStyle = {
          left: `${(rect.x * 100).toFixed(4)}%`,
          top: `${(rect.y * 100).toFixed(4)}%`,
          width: `${(rect.width * 100).toFixed(4)}%`,
          height: `${(rect.height * 100).toFixed(4)}%`,
        };

        if (rectIdx === 0) {
          const btnEl = document.createElement("button");
          btnEl.type = "button";
          btnEl.className = "pdf-link-rect pdf-link-hit";
          btnEl.setAttribute("aria-label", formatLinkAriaLabel(link));
          btnEl.setAttribute("title", formatLinkTooltip(link));
          btnEl.style.left = pctStyle.left;
          btnEl.style.top = pctStyle.top;
          btnEl.style.width = pctStyle.width;
          btnEl.style.height = pctStyle.height;
          buttonMeta.set(btnEl, { documentId: doc.documentId, link });
          groupEl.appendChild(btnEl);
        } else {
          const spanEl = document.createElement("span");
          spanEl.className = "pdf-link-rect";
          spanEl.setAttribute("aria-hidden", "true");
          spanEl.style.left = pctStyle.left;
          spanEl.style.top = pctStyle.top;
          spanEl.style.width = pctStyle.width;
          spanEl.style.height = pctStyle.height;
          groupEl.appendChild(spanEl);
        }
      });

      groups.push(groupEl);
      fragment.appendChild(groupEl);
    }

    if (groups.length === 0) {
      return;
    }

    layerEl.appendChild(fragment);
    slotEl.appendChild(layerEl);
    mountedLayers.set(pageIndex, layerEl);
    groupRefsByPage.set(pageIndex, groups);
  }

  function drainFetchQueue(): void {
    if (!currentDoc || destroyed) {
      return;
    }

    while (
      activeFetches < MAX_CONCURRENT_LINK_FETCHES &&
      pendingQueue.length > 0
    ) {
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

      const cached = getCachedPageLinks(currentDoc.documentId, pageIndex);
      if (cached) {
        mountPageLayer(
          currentDoc,
          pageIndex,
          cached,
          currentWindow.slotElements[pageIndex],
        );
        continue;
      }

      const requestDoc = currentDoc;
      const requestEpoch = layerEpoch;

      inFlightPages.add(pageIndex);
      activeFetches += 1;

      api
        .getPageLinks(requestDoc.documentId, pageIndex)
        .then((links) => {
          if (destroyed || requestDoc.signal?.aborted) {
            return;
          }

          const normalizedLinks = Array.isArray(links) ? links : [];
          setCachedPageLinks(requestDoc.documentId, pageIndex, normalizedLinks);

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
            normalizedLinks,
            currentWindow.slotElements[pageIndex],
          );
        })
        .catch((err) => {
          if (
            !destroyed &&
            !requestDoc.signal?.aborted &&
            requestEpoch === layerEpoch &&
            currentDoc?.documentId === requestDoc.documentId
          ) {
            console.error(
              `Failed to extract links for page ${pageIndex}:`,
              err,
            );
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
    signal = null,
    firstVisible,
    lastVisible,
    renderMin,
    renderMax,
    slotElements,
    pageOffsets,
  }: LinkLayerSyncParams): void {
    if (destroyed) {
      return;
    }

    const doc: ActiveLinkDoc = { documentId, signal };
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
      const cached = getCachedPageLinks(documentId, i);
      if (cached) {
        mountPageLayer(doc, i, cached, slotElements[i]);
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

  function evictOutside(keepMin: number, keepMax: number): void {
    for (const [pageIndex, layerEl] of mountedLayers.entries()) {
      if (pageIndex >= keepMin && pageIndex <= keepMax) {
        continue;
      }
      if (hovered?.pageIndex === pageIndex) {
        clearHover();
      }
      layerEl.remove();
      mountedLayers.delete(pageIndex);
      groupRefsByPage.delete(pageIndex);
    }
  }

  function clearMounted(): void {
    layerEpoch += 1;
    pendingQueue = [];
    inFlightPages.clear();
    clearHover();
    pointerDown = null;
    for (const layerEl of mountedLayers.values()) {
      layerEl.remove();
    }
    mountedLayers.clear();
    groupRefsByPage.clear();
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

  function handlePointerDown(event: PointerEvent): void {
    if (destroyed || event.button !== 0) {
      return;
    }
    pointerDown = {
      x: event.clientX,
      y: event.clientY,
      hadSelection: hasActiveSelection(),
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
      if (dist > LINK_CLICK_DRAG_THRESHOLD_PX) {
        pointerDown.dragged = true;
        clearHover();
      }
      return;
    }
    if ((event.buttons & 1) !== 0) {
      clearHover();
      return;
    }

    const hit = resolveHitAtClientPoint(event.clientX, event.clientY);
    if (hit) {
      applyHover(hit.pageIndex, hit.linkIndex, hit.link);
    } else {
      clearHover();
    }
  }

  function handlePointerLeave(): void {
    clearHover();
  }

  function handleViewportScroll(): void {
    clearHover();
  }

  function handleClick(event: MouseEvent): void {
    if (destroyed || event.defaultPrevented) {
      return;
    }

    // Keyboard activation on a focusable `.pdf-link-hit` button inside `.link-layer`.
    if (
      typeof HTMLElement !== "undefined" &&
      event.target instanceof HTMLElement &&
      event.target.classList?.contains("pdf-link-hit")
    ) {
      const meta = buttonMeta.get(event.target);
      if (meta) {
        event.stopPropagation();
        onActivateLink(meta.documentId, meta.link);
      }
      return;
    }

    const down = pointerDown;
    pointerDown = null;

    if (event.button !== 0 || event.detail > 1 || down?.dragged) {
      return;
    }
    if (!down?.hadSelection && hasActiveSelection()) {
      return;
    }

    if (!currentDoc) {
      return;
    }
    const hit = resolveHitAtClientPoint(event.clientX, event.clientY);
    if (!hit) {
      return;
    }

    onActivateLink(currentDoc.documentId, hit.link);
  }

  const hasDomListeners = typeof viewportEl.addEventListener === "function";
  if (hasDomListeners) {
    viewportEl.addEventListener("pointerdown", handlePointerDown);
    viewportEl.addEventListener("pointermove", handlePointerMove);
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
      viewportEl.removeEventListener("pointerleave", handlePointerLeave);
      viewportEl.removeEventListener("scroll", handleViewportScroll);
      viewportEl.removeEventListener("click", handleClick);
    }
    clearMounted();
    cachesByDocId.clear();
  }

  return {
    syncVisibleRange,
    evictOutside,
    clearMounted,
    evictDocument,
    destroy,
  };
}
