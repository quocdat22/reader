/**
 * Slim multi-tab strip UI and per-tab reading state store (document tabs + singleton Home tab).
 */

export const HOME_TAB_ID = "home";

function toDocumentTabId(documentId) {
  return `doc-${documentId}`;
}

function deriveTitle(canonicalPath, metadataTitle) {
  if (typeof metadataTitle === "string" && metadataTitle.trim().length > 0) {
    return metadataTitle.trim();
  }
  const normalized = canonicalPath.replace(/\\/g, "/");
  const filename = normalized.split("/").pop() || canonicalPath;
  const stem = filename.replace(/\.pdf$/i, "");
  return stem.trim() || filename || "Untitled";
}

function createCloseIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "11");
  svg.setAttribute("height", "11");
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

function createHomeIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("tab-home-icon");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    "M2.5 7.25L8 2.75l5.5 4.5M4.25 6.25v6.5c0 .41.34.75.75.75h6c.41 0 .75-.34.75-.75v-6.5",
  );
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");

  svg.appendChild(path);
  return svg;
}

/**
 * @param {{
 *   tabListEl: HTMLElement,
 *   addBtnEl: HTMLButtonElement,
 *   onSelectTab: (tabId: string) => void,
 *   onCloseTab: (tabId: string) => void,
 *   onOpenHome: () => void,
 * }} options
 */
export function createTabManager({
  tabListEl,
  addBtnEl,
  onSelectTab,
  onCloseTab,
  onOpenHome,
}) {
  /** @type {Array<any>} */
  const tabs = [];
  /** @type {string | null} */
  let activeTabId = null;

  addBtnEl.addEventListener("click", () => {
    onOpenHome();
  });

  // Allow vertical mouse wheel over the tab strip to scroll overflowing tabs horizontally.
  tabListEl.addEventListener(
    "wheel",
    (event) => {
      if (tabListEl.scrollWidth <= tabListEl.clientWidth) {
        return;
      }
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.preventDefault();
        tabListEl.scrollLeft += event.deltaY;
      }
    },
    { passive: false },
  );

  function render() {
    tabListEl.textContent = "";
    const fragment = document.createDocumentFragment();

    for (const tab of tabs) {
      const isActive = tab.tabId === activeTabId;
      const isHome = tab.kind === "home";
      const tabEl = document.createElement("div");
      tabEl.className = isHome
        ? isActive
          ? "tab tab--home tab--active"
          : "tab tab--home"
        : isActive
          ? "tab tab--active"
          : "tab";
      tabEl.setAttribute("role", "tab");
      tabEl.setAttribute("aria-selected", String(isActive));
      tabEl.setAttribute("tabindex", isActive ? "0" : "-1");
      tabEl.dataset.tabId = tab.tabId;
      if (!isHome) {
        tabEl.dataset.documentId = String(tab.documentId);
      }
      tabEl.title = isHome ? "Home" : tab.canonicalPath;

      if (isHome) {
        tabEl.appendChild(createHomeIcon());
      }

      const titleEl = document.createElement("span");
      titleEl.className = "tab-title";
      titleEl.textContent = tab.title;

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "tab-close-btn";
      closeBtn.setAttribute("aria-label", isHome ? "Close Home tab" : `Close ${tab.title}`);
      closeBtn.title = "Close tab (Ctrl+W)";
      closeBtn.appendChild(createCloseIcon());

      closeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        onCloseTab(tab.tabId);
      });

      tabEl.addEventListener("click", () => {
        if (tab.tabId !== activeTabId) {
          onSelectTab(tab.tabId);
        }
      });

      // Middle-click anywhere on a tab closes it immediately.
      tabEl.addEventListener("auxclick", (event) => {
        if (event.button === 1) {
          event.preventDefault();
          onCloseTab(tab.tabId);
        }
      });

      tabEl.addEventListener("mousedown", (event) => {
        if (event.button === 1) {
          event.preventDefault();
        }
      });

      tabEl.addEventListener("keydown", (event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (tab.tabId !== activeTabId) {
            onSelectTab(tab.tabId);
          }
        } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          if (tabs.length < 2) {
            return;
          }
          event.preventDefault();
          const currentIndex = tabs.findIndex((item) => item.tabId === tab.tabId);
          if (currentIndex === -1) {
            return;
          }
          const delta = event.key === "ArrowRight" ? 1 : -1;
          const nextIndex = (currentIndex + delta + tabs.length) % tabs.length;
          const nextTab = tabs[nextIndex];
          const nextEl = tabListEl.querySelector(`.tab[data-tab-id="${nextTab.tabId}"]`);
          if (nextEl instanceof HTMLElement) {
            nextEl.focus();
          }
        }
      });

      tabEl.appendChild(titleEl);
      tabEl.appendChild(closeBtn);
      fragment.appendChild(tabEl);
    }

    tabListEl.appendChild(fragment);

    if (activeTabId !== null) {
      const activeEl = tabListEl.querySelector(`.tab[data-tab-id="${activeTabId}"]`);
      activeEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  /**
   * Opens or focuses the singleton Home tab.
   * @param {{ returnToTabId?: string | null }} [options]
   */
  function openHomeTab({ returnToTabId = null } = {}) {
    const validReturnId =
      typeof returnToTabId === "string" &&
      returnToTabId !== HOME_TAB_ID &&
      tabs.some((tab) => tab.tabId === returnToTabId)
        ? returnToTabId
        : null;

    const existing = tabs.find((tab) => tab.kind === "home");
    if (existing) {
      if (validReturnId) {
        existing.returnToTabId = validReturnId;
      }
      activeTabId = HOME_TAB_ID;
      render();
      return { tab: existing, created: false };
    }

    const homeTab = {
      kind: "home",
      tabId: HOME_TAB_ID,
      documentId: null,
      title: "Home",
      returnToTabId: validReturnId,
    };

    tabs.push(homeTab);
    activeTabId = HOME_TAB_ID;
    render();
    return { tab: homeTab, created: true };
  }

  /**
   * Adds a newly opened document or returns the existing tab if already open.
   * When `replaceHomeIfActive` is true and the Home tab is active, the Home tab
   * is replaced in place (or removed if focusing an already-open document tab).
   * @param {any} openResponse
   * @param {{ replaceHomeIfActive?: boolean }} [options]
   */
  function upsertFromOpenResponse(openResponse, { replaceHomeIfActive = false } = {}) {
    const existing = tabs.find(
      (tab) => tab.kind === "document" && tab.documentId === openResponse.document_id,
    );
    if (existing) {
      if (replaceHomeIfActive && activeTabId === HOME_TAB_ID) {
        const homeIndex = tabs.findIndex((tab) => tab.kind === "home");
        if (homeIndex !== -1) {
          tabs.splice(homeIndex, 1);
        }
        render();
      }
      return existing;
    }

    const saved = openResponse.saved_position;
    const pageCount = openResponse.page_dimensions.length;
    const initialPage =
      saved && Number.isInteger(saved.page_index)
        ? Math.max(0, Math.min(saved.page_index, Math.max(0, pageCount - 1)))
        : 0;
    const zoomMode =
      saved &&
      (saved.zoom_mode === "fit_width" ||
        saved.zoom_mode === "fit_page" ||
        saved.zoom_mode === "custom")
        ? saved.zoom_mode
        : "fit_width";
    const zoomScale =
      saved && Number.isFinite(saved.zoom_scale) && saved.zoom_scale > 0
        ? saved.zoom_scale
        : 1.0;

    const tab = {
      kind: "document",
      tabId: toDocumentTabId(openResponse.document_id),
      documentId: openResponse.document_id,
      canonicalPath: openResponse.canonical_path,
      title: deriveTitle(openResponse.canonical_path, openResponse.metadata?.title),
      pageCount,
      pageDimensions: openResponse.page_dimensions,
      pageIndex: initialPage,
      scrollTop: null,
      scrollAnchor: null,
      zoomMode,
      zoomScale,
      tocOpen: false,
      outlineStatus: "idle",
      outlineCache: null,
      outlineError: null,
      tocExpandedIds: null,
      tocScrollTop: 0,
      tocSelectedNodeId: null,
      textCache: new Map(),
      searchState: null,
    };

    if (replaceHomeIfActive && activeTabId === HOME_TAB_ID) {
      const homeIndex = tabs.findIndex((item) => item.kind === "home");
      if (homeIndex !== -1) {
        tabs.splice(homeIndex, 1, tab);
      } else {
        tabs.push(tab);
      }
    } else {
      tabs.push(tab);
    }

    render();
    return tab;
  }

  function setActive(tabId) {
    if (tabId !== null && !tabs.some((tab) => tab.tabId === tabId)) {
      return null;
    }
    if (tabId === HOME_TAB_ID && activeTabId !== null && activeTabId !== HOME_TAB_ID) {
      const homeTab = tabs.find((tab) => tab.kind === "home");
      if (homeTab) {
        homeTab.returnToTabId = activeTabId;
      }
    }
    activeTabId = tabId;
    render();
    return getActive();
  }

  /**
   * Removes a tab by `tabId` and returns `{ removed, nextActive }`.
   * Automatically prunes the singleton Home tab if zero document tabs remain.
   * @param {string} tabId
   */
  function remove(tabId) {
    const index = tabs.findIndex((tab) => tab.tabId === tabId);
    if (index === -1) {
      return { removed: null, nextActive: getActive() };
    }

    const [removed] = tabs.splice(index, 1);
    removed.textCache?.clear();
    removed.searchState = null;

    const remainingDocs = tabs.reduce((acc, tab) => acc + (tab.kind === "document" ? 1 : 0), 0);
    if (remainingDocs === 0) {
      tabs.length = 0;
      activeTabId = null;
    } else if (activeTabId === tabId) {
      if (
        removed.kind === "home" &&
        removed.returnToTabId &&
        tabs.some((tab) => tab.tabId === removed.returnToTabId)
      ) {
        activeTabId = removed.returnToTabId;
      } else {
        const nextIndex = Math.min(index, tabs.length - 1);
        activeTabId = tabs[nextIndex].tabId;
      }
    }

    render();
    return { removed, nextActive: getActive() };
  }

  function getActive() {
    if (activeTabId === null) {
      return null;
    }
    return tabs.find((tab) => tab.tabId === activeTabId) ?? null;
  }

  function getActiveDocument() {
    const active = getActive();
    return active && active.kind === "document" ? active : null;
  }

  function isHomeActive() {
    return activeTabId === HOME_TAB_ID;
  }

  function getByTabId(tabId) {
    return tabs.find((tab) => tab.tabId === tabId) ?? null;
  }

  function getById(documentId) {
    return tabs.find((tab) => tab.kind === "document" && tab.documentId === documentId) ?? null;
  }

  function getAll() {
    return [...tabs];
  }

  function isEmpty() {
    return tabs.length === 0;
  }

  function count() {
    return tabs.length;
  }

  /**
   * Returns the next (`delta = 1`) or previous (`delta = -1`) tab's `tabId`
   * with wrap-around, or `null` when fewer than two tabs are open.
   * @param {1 | -1} delta
   * @returns {string | null}
   */
  function getAdjacentTabId(delta) {
    if (tabs.length < 2) {
      return null;
    }
    const currentIndex = tabs.findIndex((tab) => tab.tabId === activeTabId);
    const startIndex = currentIndex === -1 ? 0 : currentIndex;
    const nextIndex = (startIndex + delta + tabs.length) % tabs.length;
    return tabs[nextIndex].tabId;
  }

  /**
   * Resolves `Ctrl+1`..`Ctrl+9` to a target `tabId` (`9` selects the last tab).
   * @param {number} digit
   * @returns {string | null}
   */
  function getTabIdAtShortcutIndex(digit) {
    if (tabs.length === 0 || !Number.isInteger(digit) || digit < 1 || digit > 9) {
      return null;
    }
    if (digit === 9) {
      return tabs[tabs.length - 1].tabId;
    }
    const targetIndex = digit - 1;
    if (targetIndex >= tabs.length) {
      return null;
    }
    return tabs[targetIndex].tabId;
  }

  return {
    openHomeTab,
    upsertFromOpenResponse,
    setActive,
    remove,
    getActive,
    getActiveDocument,
    isHomeActive,
    getByTabId,
    getById,
    getAll,
    isEmpty,
    count,
    getAdjacentTabId,
    getTabIdAtShortcutIndex,
  };
}
