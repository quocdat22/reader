/**
 * Collapsible Table of Contents (TOC) outline drawer synced to the active tab.
 *
 * Lazily fetches and caches `get_outline` per tab when opened, renders nested
 * expandable chapters with lazy child DOM creation, tracks the active chapter
 * from viewport scroll position, and supports WAI-ARIA tree keyboard ergonomics.
 */

import { getOutline } from "./api.js";

const MAX_INDENT_DEPTH = 6;
const LOADING_DELAY_MS = 120;

function createCloseIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2.75 2.75l6.5 6.5M9.25 2.75l-6.5 6.5");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");

  svg.appendChild(path);
  return svg;
}

function createChevronIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "10");
  svg.setAttribute("height", "10");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("toc-chevron-icon");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M4.25 2.5L7.75 6l-3.5 3.5");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");

  svg.appendChild(path);
  return svg;
}

/**
 * Normalizes raw Rust `OutlineItem[]` into an indexed tree model for fast lookups.
 * @param {Array<{ title: string, page_index: number | null, children?: Array<any> }>} rawItems
 */
export function buildOutlineModel(rawItems) {
  /** @type {Array<any>} */
  const flat = [];
  /** @type {Map<string, any>} */
  const byId = new Map();

  function walk(items, depth, parentId, prefix) {
    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }

    const result = [];
    for (let i = 0; i < items.length; i += 1) {
      const raw = items[i];
      if (!raw || typeof raw !== "object") {
        continue;
      }

      const id = prefix ? `${prefix}.${i}` : String(i);
      const rawTitle = typeof raw.title === "string" ? raw.title.trim() : "";
      const title = rawTitle.length > 0 ? rawTitle : "Untitled";
      const pageIndex =
        Number.isInteger(raw.page_index) && raw.page_index >= 0 ? raw.page_index : null;

      const node = {
        id,
        title,
        pageIndex,
        depth,
        parentId,
        children: [],
        hasChildren: false,
      };

      flat.push(node);
      byId.set(id, node);

      node.children = walk(raw.children, depth + 1, id, id);
      node.hasChildren = node.children.length > 0;
      result.push(node);
    }
    return result;
  }

  const roots = walk(rawItems, 0, null, "");
  return { roots, flat, byId };
}

/**
 * Resolves the deepest outline node corresponding to `pageIndex`.
 *
 * When multiple entries share the exact `pageIndex`, preserves `preferredNodeId`
 * if it points to `pageIndex`; otherwise selects the first entry on `pageIndex`
 * when landing directly on a bookmark page, or the last entry on the nearest
 * preceding bookmark page while reading deeper within a section.
 *
 * @param {{ flat: Array<any>, byId: Map<string, any> } | null} model
 * @param {number} pageIndex
 * @param {string | null} [preferredNodeId]
 * @returns {string | null}
 */
export function resolveActiveOutlineNodeId(model, pageIndex, preferredNodeId = null) {
  if (!model || model.flat.length === 0 || !Number.isInteger(pageIndex) || pageIndex < 0) {
    return null;
  }

  if (preferredNodeId) {
    const preferred = model.byId.get(preferredNodeId);
    if (preferred && preferred.pageIndex === pageIndex) {
      return preferred.id;
    }
  }

  let bestPage = -1;
  /** @type {string | null} */
  let firstAtBest = null;
  /** @type {string | null} */
  let lastAtBest = null;

  for (const node of model.flat) {
    if (node.pageIndex === null || node.pageIndex > pageIndex) {
      continue;
    }
    if (node.pageIndex > bestPage) {
      bestPage = node.pageIndex;
      firstAtBest = node.id;
      lastAtBest = node.id;
    } else if (node.pageIndex === bestPage) {
      lastAtBest = node.id;
    }
  }

  if (bestPage < 0) {
    return null;
  }

  return bestPage === pageIndex ? firstAtBest : lastAtBest;
}

/**
 * Maps a resolved active node ID to itself if visible, or to its deepest visible
 * collapsed ancestor so active progress remains clear without forcibly expanding
 * sections the reader closed.
 *
 * @param {{ byId: Map<string, any> }} model
 * @param {string | null} nodeId
 * @param {Set<string>} expandedIds
 * @returns {string | null}
 */
export function resolveVisibleActiveNodeId(model, nodeId, expandedIds) {
  if (!nodeId || !model) {
    return null;
  }
  const target = model.byId.get(nodeId);
  if (!target) {
    return null;
  }

  /** @type {Array<any>} */
  const chain = [];
  let cursor = target;
  while (cursor) {
    chain.push(cursor);
    cursor = cursor.parentId ? model.byId.get(cursor.parentId) : null;
  }
  chain.reverse();

  let visible = chain[0];
  for (let i = 0; i < chain.length - 1; i += 1) {
    if (!expandedIds.has(chain[i].id)) {
      return chain[i].id;
    }
    visible = chain[i + 1];
  }
  return visible.id;
}

/**
 * Computes initial expanded node IDs on first open for a tab:
 * - Auto-expands root wrappers when a document nests everything under 1-2 roots.
 * - Expands the ancestor chain of the reader's current chapter so opening TOC
 *   mid-document reveals the active section immediately.
 *
 * @param {{ roots: Array<any>, flat: Array<any>, byId: Map<string, any> }} model
 * @param {number} pageIndex
 * @returns {Set<string>}
 */
function createInitialExpandedIds(model, pageIndex) {
  /** @type {Set<string>} */
  const expanded = new Set();

  if (model.roots.length > 0 && model.roots.length <= 2) {
    for (const root of model.roots) {
      if (root.hasChildren) {
        expanded.add(root.id);
      }
    }
  }

  const activeId = resolveActiveOutlineNodeId(model, pageIndex);
  let cursor = activeId ? model.byId.get(activeId) : null;
  while (cursor && cursor.parentId) {
    expanded.add(cursor.parentId);
    cursor = model.byId.get(cursor.parentId);
  }

  return expanded;
}

/**
 * @param {{
 *   drawerEl: HTMLElement,
 *   onJumpToPage: (pageIndex: number, options: { fromKeyboard: boolean }) => void,
 *   onClose: () => void,
 * }} options
 */
export function createTocDrawer({ drawerEl, onJumpToPage, onClose }) {
  drawerEl.textContent = "";

  const headerEl = document.createElement("div");
  headerEl.className = "toc-header";

  const titleEl = document.createElement("h2");
  titleEl.className = "toc-title";
  titleEl.textContent = "Outline";

  const closeBtnEl = document.createElement("button");
  closeBtnEl.type = "button";
  closeBtnEl.className = "toc-close-btn";
  closeBtnEl.setAttribute("aria-label", "Close outline");
  closeBtnEl.title = "Close outline (Ctrl+B)";
  closeBtnEl.appendChild(createCloseIcon());
  closeBtnEl.addEventListener("click", () => {
    onClose();
  });

  headerEl.appendChild(titleEl);
  headerEl.appendChild(closeBtnEl);

  const bodyEl = document.createElement("div");
  bodyEl.className = "toc-body";

  drawerEl.appendChild(headerEl);
  drawerEl.appendChild(bodyEl);

  /** @type {any | null} */
  let currentTab = null;
  /** @type {number | null} */
  let renderedDocumentId = null;
  /** @type {string | null} */
  let activeVisibleNodeId = null;
  /** @type {string | null} */
  let rovingNodeId = null;
  /** @type {Map<string, HTMLElement>} */
  const rowElById = new Map();
  /** @type {Map<string, { itemEl: HTMLLIElement, childListEl: HTMLUListElement | null }>} */
  const itemMetaById = new Map();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let loadingTimer = null;

  function clearLoadingTimer() {
    if (loadingTimer !== null) {
      clearTimeout(loadingTimer);
      loadingTimer = null;
    }
  }

  function clearRenderedTree() {
    bodyEl.textContent = "";
    rowElById.clear();
    itemMetaById.clear();
    renderedDocumentId = null;
    activeVisibleNodeId = null;
    rovingNodeId = null;
  }

  function renderStateMessage(message, options = {}) {
    clearRenderedTree();
    const box = document.createElement("div");
    box.className = options.isError ? "toc-state toc-state--error" : "toc-state";

    const text = document.createElement("span");
    text.textContent = message;
    box.appendChild(text);

    if (options.isError && typeof options.onRetry === "function") {
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "toc-retry-btn";
      retryBtn.textContent = "Retry";
      retryBtn.addEventListener("click", options.onRetry);
      box.appendChild(retryBtn);
    }

    bodyEl.appendChild(box);
  }

  function getVisibleRowElements() {
    return Array.from(bodyEl.querySelectorAll(".toc-row")).filter(
      (el) => !el.closest("[hidden]"),
    );
  }

  function setRovingFocusTarget(nodeId) {
    if (rovingNodeId && rovingNodeId !== nodeId) {
      const prev = rowElById.get(rovingNodeId);
      if (prev) {
        prev.tabIndex = -1;
      }
    }
    const next = nodeId ? rowElById.get(nodeId) : null;
    if (next) {
      next.tabIndex = 0;
      rovingNodeId = nodeId;
      return;
    }

    const firstRow = getVisibleRowElements()[0];
    if (firstRow) {
      firstRow.tabIndex = 0;
      rovingNodeId = firstRow.dataset.nodeId ?? null;
    } else {
      rovingNodeId = null;
    }
  }

  function focusRow(rowEl) {
    if (!rowEl) {
      return;
    }
    const nodeId = rowEl.dataset.nodeId ?? null;
    if (nodeId) {
      setRovingFocusTarget(nodeId);
    }
    rowEl.focus();
  }

  function setNodeExpanded(tab, node, expanded) {
    if (!node.hasChildren || !tab.tocExpandedIds) {
      return;
    }

    const wasExpanded = tab.tocExpandedIds.has(node.id);
    if (wasExpanded === expanded) {
      return;
    }

    if (expanded) {
      tab.tocExpandedIds.add(node.id);
    } else {
      tab.tocExpandedIds.delete(node.id);
    }

    const rowEl = rowElById.get(node.id);
    const meta = itemMetaById.get(node.id);
    if (!rowEl || !meta) {
      return;
    }

    rowEl.setAttribute("aria-expanded", String(expanded));
    const chevronBtn = rowEl.querySelector(".toc-chevron-btn");
    if (chevronBtn) {
      chevronBtn.setAttribute("aria-expanded", String(expanded));
    }

    if (expanded) {
      if (!meta.childListEl) {
        const childListEl = renderNodeList(tab, node.children, false);
        meta.childListEl = childListEl;
        meta.itemEl.appendChild(childListEl);
      } else {
        meta.childListEl.hidden = false;
      }
    } else if (meta.childListEl) {
      meta.childListEl.hidden = true;
      // Ensure roving tabindex never remains trapped inside a newly collapsed subtree.
      if (rovingNodeId && rowElById.get(rovingNodeId)?.closest("[hidden]")) {
        setRovingFocusTarget(node.id);
      }
    }

    applyActiveHighlight(tab, { scrollIntoView: false });
  }

  function activateNode(tab, node, fromKeyboard) {
    if (node.pageIndex !== null) {
      tab.tocSelectedNodeId = node.id;
      onJumpToPage(node.pageIndex, { fromKeyboard });
      return;
    }
    if (node.hasChildren && tab.tocExpandedIds) {
      setNodeExpanded(tab, node, !tab.tocExpandedIds.has(node.id));
    }
  }

  function handleTreeKeyDown(event, tab, node) {
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    const key = event.key;
    if (key === "ArrowDown") {
      event.preventDefault();
      const rows = getVisibleRowElements();
      const idx = rows.indexOf(event.currentTarget);
      if (idx >= 0 && idx + 1 < rows.length) {
        focusRow(rows[idx + 1]);
      }
      return;
    }

    if (key === "ArrowUp") {
      event.preventDefault();
      const rows = getVisibleRowElements();
      const idx = rows.indexOf(event.currentTarget);
      if (idx > 0) {
        focusRow(rows[idx - 1]);
      }
      return;
    }

    if (key === "ArrowRight") {
      event.preventDefault();
      if (!node.hasChildren) {
        return;
      }
      if (!tab.tocExpandedIds.has(node.id)) {
        setNodeExpanded(tab, node, true);
      } else if (node.children.length > 0) {
        const firstChildRow = rowElById.get(node.children[0].id);
        focusRow(firstChildRow);
      }
      return;
    }

    if (key === "ArrowLeft") {
      event.preventDefault();
      if (node.hasChildren && tab.tocExpandedIds.has(node.id)) {
        setNodeExpanded(tab, node, false);
      } else if (node.parentId) {
        const parentRow = rowElById.get(node.parentId);
        focusRow(parentRow);
      }
      return;
    }

    if (key === "Home") {
      event.preventDefault();
      const rows = getVisibleRowElements();
      if (rows.length > 0) {
        focusRow(rows[0]);
      }
      return;
    }

    if (key === "End") {
      event.preventDefault();
      const rows = getVisibleRowElements();
      if (rows.length > 0) {
        focusRow(rows[rows.length - 1]);
      }
      return;
    }

    if (key === "Enter" || key === " ") {
      event.preventDefault();
      activateNode(tab, node, true);
    }
  }

  function renderNodeList(tab, nodes, isRoot) {
    const listEl = document.createElement("ul");
    listEl.className = "toc-list";
    listEl.setAttribute("role", isRoot ? "tree" : "group");
    if (isRoot) {
      listEl.setAttribute("aria-label", "Document outline");
    }

    for (const node of nodes) {
      const itemEl = document.createElement("li");
      itemEl.className = "toc-item";
      itemEl.setAttribute("role", "none");

      const isExpanded = node.hasChildren && tab.tocExpandedIds.has(node.id);
      const isInert = node.pageIndex === null && !node.hasChildren;

      const rowEl = document.createElement("div");
      rowEl.className = "toc-row";
      if (node.depth === 0) {
        rowEl.classList.add("toc-row--top");
      }
      if (isInert) {
        rowEl.classList.add("toc-row--inert");
      }

      rowEl.style.setProperty(
        "--toc-depth",
        String(Math.min(node.depth, MAX_INDENT_DEPTH)),
      );
      rowEl.setAttribute("role", "treeitem");
      rowEl.setAttribute("aria-level", String(node.depth + 1));
      if (node.hasChildren) {
        rowEl.setAttribute("aria-expanded", String(isExpanded));
      }
      if (isInert) {
        rowEl.setAttribute("aria-disabled", "true");
      }
      rowEl.tabIndex = -1;
      rowEl.dataset.nodeId = node.id;
      rowEl.title = node.title;

      if (node.hasChildren) {
        const chevronBtn = document.createElement("button");
        chevronBtn.type = "button";
        chevronBtn.className = "toc-chevron-btn";
        chevronBtn.tabIndex = -1;
        chevronBtn.setAttribute("aria-hidden", "true");
        chevronBtn.setAttribute("aria-expanded", String(isExpanded));
        chevronBtn.appendChild(createChevronIcon());

        chevronBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          setNodeExpanded(tab, node, !tab.tocExpandedIds.has(node.id));
        });
        rowEl.appendChild(chevronBtn);
      } else {
        const spacer = document.createElement("span");
        spacer.className = "toc-chevron-spacer";
        spacer.setAttribute("aria-hidden", "true");
        rowEl.appendChild(spacer);
      }

      const labelEl = document.createElement("span");
      labelEl.className = "toc-label";
      labelEl.textContent = node.title;
      rowEl.appendChild(labelEl);

      if (node.pageIndex !== null) {
        const pageEl = document.createElement("span");
        pageEl.className = "toc-page";
        pageEl.textContent = String(node.pageIndex + 1);
        rowEl.appendChild(pageEl);
      }

      rowEl.addEventListener("click", () => {
        if (isInert) {
          return;
        }
        setRovingFocusTarget(node.id);
        activateNode(tab, node, false);
      });

      rowEl.addEventListener("keydown", (event) => {
        handleTreeKeyDown(event, tab, node);
      });

      itemEl.appendChild(rowEl);
      rowElById.set(node.id, rowEl);

      let childListEl = null;
      if (node.hasChildren && isExpanded) {
        childListEl = renderNodeList(tab, node.children, false);
        itemEl.appendChild(childListEl);
      }

      itemMetaById.set(node.id, { itemEl, childListEl });
      listEl.appendChild(itemEl);
    }

    return listEl;
  }

  function applyActiveHighlight(tab, { scrollIntoView }) {
    if (!tab || !tab.outlineCache || !tab.tocExpandedIds) {
      return;
    }

    const resolvedId = resolveActiveOutlineNodeId(
      tab.outlineCache,
      tab.pageIndex,
      tab.tocSelectedNodeId,
    );
    if (
      tab.tocSelectedNodeId &&
      tab.outlineCache.byId.get(tab.tocSelectedNodeId)?.pageIndex !== tab.pageIndex
    ) {
      tab.tocSelectedNodeId = null;
    }

    const nextVisibleId = resolveVisibleActiveNodeId(
      tab.outlineCache,
      resolvedId,
      tab.tocExpandedIds,
    );

    if (activeVisibleNodeId && activeVisibleNodeId !== nextVisibleId) {
      const prevEl = rowElById.get(activeVisibleNodeId);
      if (prevEl) {
        prevEl.classList.remove("toc-row--active");
        prevEl.removeAttribute("aria-current");
      }
    }

    activeVisibleNodeId = nextVisibleId;

    if (nextVisibleId) {
      const nextEl = rowElById.get(nextVisibleId);
      if (nextEl) {
        nextEl.classList.add("toc-row--active");
        nextEl.setAttribute("aria-current", "location");

        if (!drawerEl.contains(document.activeElement)) {
          setRovingFocusTarget(nextVisibleId);
          if (scrollIntoView && !drawerEl.hidden) {
            nextEl.scrollIntoView({ block: "nearest" });
          }
        }
      }
    } else if (!rovingNodeId) {
      setRovingFocusTarget(null);
    }
  }

  function renderLoadedTab(tab, { restoreScroll }) {
    clearLoadingTimer();
    const model = tab.outlineCache;
    if (!model || model.roots.length === 0) {
      renderStateMessage("No outline in this document");
      renderedDocumentId = tab.documentId;
      return;
    }

    if (!tab.tocExpandedIds) {
      tab.tocExpandedIds = createInitialExpandedIds(model, tab.pageIndex);
    }

    clearRenderedTree();
    const treeEl = renderNodeList(tab, model.roots, true);
    bodyEl.appendChild(treeEl);
    renderedDocumentId = tab.documentId;

    const hadSavedScroll = restoreScroll && tab.tocScrollTop > 0;
    applyActiveHighlight(tab, { scrollIntoView: !hadSavedScroll });

    if (hadSavedScroll) {
      bodyEl.scrollTop = tab.tocScrollTop;
    }
    if (!rovingNodeId) {
      setRovingFocusTarget(activeVisibleNodeId);
    }
  }

  async function loadOutlineForTab(tab) {
    if (tab.outlineStatus === "loading") {
      return;
    }

    tab.outlineStatus = "loading";
    tab.outlineError = null;

    clearLoadingTimer();
    loadingTimer = setTimeout(() => {
      loadingTimer = null;
      if (currentTab === tab && tab.tocOpen && tab.outlineStatus === "loading") {
        renderStateMessage("Loading outline…");
      }
    }, LOADING_DELAY_MS);

    try {
      const rawItems = await getOutline(tab.documentId);
      tab.outlineCache = buildOutlineModel(rawItems);
      tab.outlineStatus = "loaded";
      tab.outlineError = null;

      if (currentTab === tab && tab.tocOpen) {
        renderLoadedTab(tab, { restoreScroll: false });
      }
    } catch (err) {
      tab.outlineStatus = "error";
      tab.outlineError =
        typeof err?.message === "string" && err.message.trim().length > 0
          ? err.message
          : "Could not load outline.";

      if (currentTab === tab && tab.tocOpen) {
        clearLoadingTimer();
        renderStateMessage("Could not load outline.", {
          isError: true,
          onRetry: () => {
            if (currentTab === tab && tab.tocOpen) {
              void loadOutlineForTab(tab);
            }
          },
        });
      }
    }
  }

  function captureScroll(tab = currentTab) {
    if (tab && renderedDocumentId === tab.documentId && !drawerEl.hidden) {
      tab.tocScrollTop = bodyEl.scrollTop;
    }
  }

  /**
   * Synchronizes the drawer visibility, cached outline, and active chapter to `tab`.
   * @param {any | null} tab
   */
  function syncTab(tab) {
    if (currentTab) {
      captureScroll(currentTab);
    }

    const wasHidden = drawerEl.hidden;
    currentTab = tab;

    if (!tab || !tab.tocOpen) {
      clearLoadingTimer();
      drawerEl.hidden = true;
      return;
    }

    drawerEl.hidden = false;

    if (tab.outlineStatus === "loaded") {
      if (renderedDocumentId !== tab.documentId) {
        renderLoadedTab(tab, { restoreScroll: true });
      } else {
        if (wasHidden && tab.tocScrollTop > 0) {
          bodyEl.scrollTop = tab.tocScrollTop;
        }
        applyActiveHighlight(tab, { scrollIntoView: true });
      }
      return;
    }

    if (tab.outlineStatus === "error") {
      clearLoadingTimer();
      renderStateMessage("Could not load outline.", {
        isError: true,
        onRetry: () => {
          if (currentTab === tab && tab.tocOpen) {
            void loadOutlineForTab(tab);
          }
        },
      });
      return;
    }

    if (tab.outlineStatus === "loading") {
      clearRenderedTree();
      clearLoadingTimer();
      loadingTimer = setTimeout(() => {
        loadingTimer = null;
        if (currentTab === tab && tab.tocOpen && tab.outlineStatus === "loading") {
          renderStateMessage("Loading outline…");
        }
      }, LOADING_DELAY_MS);
      return;
    }

    clearRenderedTree();
    void loadOutlineForTab(tab);
  }

  /**
   * Updates the active chapter highlight for the active tab's current page index.
   * @param {number} pageIndex
   */
  function syncActivePage(pageIndex) {
    if (!currentTab || !currentTab.tocOpen || currentTab.outlineStatus !== "loaded") {
      return;
    }
    if (renderedDocumentId !== currentTab.documentId) {
      return;
    }
    if (currentTab.pageIndex !== pageIndex) {
      currentTab.pageIndex = pageIndex;
    }
    applyActiveHighlight(currentTab, { scrollIntoView: true });
  }

  function clear() {
    clearLoadingTimer();
    currentTab = null;
    clearRenderedTree();
    drawerEl.hidden = true;
  }

  function containsElement(el) {
    return Boolean(el && drawerEl.contains(el));
  }

  return {
    syncTab,
    syncActivePage,
    captureScroll,
    clear,
    containsElement,
  };
}
