/**
 * Slim multi-tab strip UI and per-tab reading state store.
 */

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

/**
 * @param {{
 *   tabListEl: HTMLElement,
 *   addBtnEl: HTMLButtonElement,
 *   onSelectTab: (documentId: number) => void,
 *   onCloseTab: (documentId: number) => void,
 *   onOpenNew: () => void,
 * }} options
 */
export function createTabManager({
  tabListEl,
  addBtnEl,
  onSelectTab,
  onCloseTab,
  onOpenNew,
}) {
  /** @type {Array<any>} */
  const tabs = [];
  /** @type {number | null} */
  let activeDocumentId = null;

  addBtnEl.addEventListener("click", () => {
    onOpenNew();
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
      const isActive = tab.documentId === activeDocumentId;
      const tabEl = document.createElement("div");
      tabEl.className = isActive ? "tab tab--active" : "tab";
      tabEl.setAttribute("role", "tab");
      tabEl.setAttribute("aria-selected", String(isActive));
      tabEl.setAttribute("tabindex", isActive ? "0" : "-1");
      tabEl.dataset.documentId = String(tab.documentId);
      tabEl.title = tab.canonicalPath;

      const titleEl = document.createElement("span");
      titleEl.className = "tab-title";
      titleEl.textContent = tab.title;

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "tab-close-btn";
      closeBtn.setAttribute("aria-label", `Close ${tab.title}`);
      closeBtn.title = "Close tab (Ctrl+W)";
      closeBtn.appendChild(createCloseIcon());

      closeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        onCloseTab(tab.documentId);
      });

      tabEl.addEventListener("click", () => {
        if (tab.documentId !== activeDocumentId) {
          onSelectTab(tab.documentId);
        }
      });

      // Middle-click anywhere on a tab closes it immediately.
      tabEl.addEventListener("auxclick", (event) => {
        if (event.button === 1) {
          event.preventDefault();
          onCloseTab(tab.documentId);
        }
      });

      tabEl.addEventListener("mousedown", (event) => {
        if (event.button === 1) {
          event.preventDefault();
        }
      });

      tabEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (tab.documentId !== activeDocumentId) {
            onSelectTab(tab.documentId);
          }
        }
      });

      tabEl.appendChild(titleEl);
      tabEl.appendChild(closeBtn);
      fragment.appendChild(tabEl);
    }

    tabListEl.appendChild(fragment);

    if (activeDocumentId !== null) {
      const activeEl = tabListEl.querySelector(
        `.tab[data-document-id="${activeDocumentId}"]`,
      );
      activeEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  /**
   * Adds a newly opened document or returns the existing tab if already open.
   * @param {any} openResponse
   */
  function upsertFromOpenResponse(openResponse) {
    const existing = tabs.find((tab) => tab.documentId === openResponse.document_id);
    if (existing) {
      return existing;
    }

    const saved = openResponse.saved_position;
    const pageCount = openResponse.page_dimensions.length;
    const initialPage =
      saved && Number.isInteger(saved.page_index)
        ? Math.max(0, Math.min(saved.page_index, Math.max(0, pageCount - 1)))
        : 0;
    const zoomMode =
      saved && (saved.zoom_mode === "fit_width" || saved.zoom_mode === "fit_page" || saved.zoom_mode === "custom")
        ? saved.zoom_mode
        : "fit_width";
    const zoomScale =
      saved && Number.isFinite(saved.zoom_scale) && saved.zoom_scale > 0
        ? saved.zoom_scale
        : 1.0;

    const tab = {
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
      outlineCache: null,
      searchState: null,
    };

    tabs.push(tab);
    render();
    return tab;
  }

  function setActive(documentId) {
    if (documentId !== null && !tabs.some((tab) => tab.documentId === documentId)) {
      return null;
    }
    activeDocumentId = documentId;
    render();
    return getActive();
  }

  /**
   * Removes a tab and returns `{ removed, nextActive }`.
   * @param {number} documentId
   */
  function remove(documentId) {
    const index = tabs.findIndex((tab) => tab.documentId === documentId);
    if (index === -1) {
      return { removed: null, nextActive: getActive() };
    }

    const [removed] = tabs.splice(index, 1);

    if (activeDocumentId === documentId) {
      if (tabs.length === 0) {
        activeDocumentId = null;
      } else {
        const nextIndex = Math.min(index, tabs.length - 1);
        activeDocumentId = tabs[nextIndex].documentId;
      }
    }

    render();
    return { removed, nextActive: getActive() };
  }

  function getActive() {
    if (activeDocumentId === null) {
      return null;
    }
    return tabs.find((tab) => tab.documentId === activeDocumentId) ?? null;
  }

  function getById(documentId) {
    return tabs.find((tab) => tab.documentId === documentId) ?? null;
  }

  function getAll() {
    return [...tabs];
  }

  function isEmpty() {
    return tabs.length === 0;
  }

  return {
    upsertFromOpenResponse,
    setActive,
    remove,
    getActive,
    getById,
    getAll,
    isEmpty,
  };
}
