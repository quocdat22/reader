/**
 * Empty state UI, paginated recent files list, and plain actionable error formatting.
 */

export const RECENTS_PAGE_SIZE = 10;

/**
 * Computes page numbers and ellipsis markers for compact pagination controls.
 * @param {number} currentPage
 * @param {number} totalPages
 * @returns {Array<number | "ellipsis">}
 */
export function getVisiblePageItems(currentPage, totalPages) {
  if (totalPages <= 0) {
    return [];
  }
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  if (currentPage <= 3) {
    return [1, 2, 3, 4, "ellipsis", totalPages];
  }
  if (currentPage >= totalPages - 2) {
    return [1, "ellipsis", totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }
  return [1, "ellipsis", currentPage - 1, currentPage, currentPage + 1, "ellipsis", totalPages];
}

function splitParentDirectory(fullPath) {
  const normalized = fullPath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) {
    return "";
  }
  return fullPath.slice(0, lastSlash);
}

function createRemoveIcon() {
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

/**
 * Formats a backend ReaderApiError into clear, non-apologetic sentence-case copy.
 * @param {any} err
 * @param {{ fromRecent?: boolean }} [context]
 * @returns {{ message: string, canRemoveRecent: boolean }}
 */
export function formatOpenError(err, context = {}) {
  const code = err?.code || "internal";
  const fromRecent = Boolean(context.fromRecent);

  switch (code) {
    case "io":
      return {
        message: fromRecent
          ? "File not found — it may have been moved or deleted."
          : "Could not read that file. Check that it exists and is accessible.",
        canRemoveRecent: fromRecent,
      };
    case "password_protected":
      return {
        message: "This PDF is password-protected. Protected documents are not supported.",
        canRemoveRecent: false,
      };
    case "unsupported_format":
      return {
        message: "Unsupported file type. Select a PDF document.",
        canRemoveRecent: fromRecent,
      };
    case "invalid_document":
      return {
        message: "Could not open this PDF. The file appears damaged or incomplete.",
        canRemoveRecent: fromRecent,
      };
    default:
      return {
        message:
          typeof err?.message === "string" && err.message.trim().length > 0
            ? err.message
            : "Could not open this document.",
        canRemoveRecent: false,
      };
  }
}

/**
 * @param {{
 *   openBtnEl: HTMLButtonElement,
 *   errorBoxEl: HTMLElement,
 *   errorMsgEl: HTMLElement,
 *   errorActionBtnEl: HTMLButtonElement,
 *   errorDismissBtnEl: HTMLButtonElement,
 *   recentSectionEl: HTMLElement,
 *   recentRangeEl: HTMLElement,
 *   recentPaginationEl: HTMLElement,
 *   recentPrevBtnEl: HTMLButtonElement,
 *   recentNextBtnEl: HTMLButtonElement,
 *   recentPageListEl: HTMLElement,
 *   recentListEl: HTMLUListElement,
 *   onOpenDialog: () => void,
 *   onOpenRecent: (path: string) => void,
 *   onRemoveRecent: (path: string) => void,
 * }} options
 */
export function createEmptyState({
  openBtnEl,
  errorBoxEl,
  errorMsgEl,
  errorActionBtnEl,
  errorDismissBtnEl,
  recentSectionEl,
  recentRangeEl,
  recentPaginationEl,
  recentPrevBtnEl,
  recentNextBtnEl,
  recentPageListEl,
  recentListEl,
  onOpenDialog,
  onOpenRecent,
  onRemoveRecent,
}) {
  /** @type {(() => void) | null} */
  let pendingErrorAction = null;
  /** @type {Array<{ path: string, title: string, last_page: number, page_count: number }>} */
  let allRecentFiles = [];
  let currentPage = 1;

  openBtnEl.addEventListener("click", () => {
    onOpenDialog();
  });

  errorDismissBtnEl.addEventListener("click", () => {
    const wasFocused = document.activeElement === errorDismissBtnEl;
    clearError();
    if (wasFocused) {
      openBtnEl.focus();
    }
  });

  errorActionBtnEl.addEventListener("click", () => {
    const wasFocused = document.activeElement === errorActionBtnEl;
    const action = pendingErrorAction;
    clearError();
    action?.();
    if (wasFocused) {
      openBtnEl.focus();
    }
  });

  recentPrevBtnEl.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage -= 1;
      renderCurrentPage();
    }
  });

  recentNextBtnEl.addEventListener("click", () => {
    const totalPages = Math.ceil(allRecentFiles.length / RECENTS_PAGE_SIZE);
    if (currentPage < totalPages) {
      currentPage += 1;
      renderCurrentPage();
    }
  });

  /**
   * @param {string} message
   * @param {{ actionLabel?: string, onAction?: () => void }} [options]
   */
  function showError(message, options = {}) {
    errorMsgEl.textContent = message;
    if (options.actionLabel && typeof options.onAction === "function") {
      pendingErrorAction = options.onAction;
      errorActionBtnEl.textContent = options.actionLabel;
      errorActionBtnEl.hidden = false;
    } else {
      pendingErrorAction = null;
      errorActionBtnEl.hidden = true;
    }
    errorBoxEl.hidden = false;
  }

  function clearError() {
    pendingErrorAction = null;
    errorActionBtnEl.hidden = true;
    errorBoxEl.hidden = true;
    errorMsgEl.textContent = "";
  }

  function buildRecentItemElement(item) {
    const li = document.createElement("li");
    li.className = "recent-item";

    const openRowBtn = document.createElement("button");
    openRowBtn.type = "button";
    openRowBtn.className = "recent-row-btn";
    openRowBtn.title = item.path;

    const mainCol = document.createElement("span");
    mainCol.className = "recent-main";

    const titleEl = document.createElement("span");
    titleEl.className = "recent-title";
    titleEl.textContent = item.title || item.path;

    const dirText = splitParentDirectory(item.path);
    const dirEl = document.createElement("span");
    dirEl.className = "recent-dir";
    dirEl.textContent = dirText;

    mainCol.appendChild(titleEl);
    if (dirText) {
      mainCol.appendChild(dirEl);
    }

    const progressEl = document.createElement("span");
    progressEl.className = "recent-progress";
    if (item.page_count > 0) {
      const displayPage = Math.min(item.last_page + 1, item.page_count);
      progressEl.textContent = `Page ${displayPage} of ${item.page_count}`;
    }

    openRowBtn.appendChild(mainCol);
    openRowBtn.appendChild(progressEl);

    openRowBtn.addEventListener("click", () => {
      clearError();
      onOpenRecent(item.path);
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "recent-remove-btn";
    removeBtn.setAttribute("aria-label", `Remove ${item.title || item.path} from recent`);
    removeBtn.title = "Remove from recent";
    removeBtn.appendChild(createRemoveIcon());

    removeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      onRemoveRecent(item.path);
    });

    li.appendChild(openRowBtn);
    li.appendChild(removeBtn);
    return li;
  }

  /**
   * Renders pagination buttons and preserves keyboard focus across page transitions.
   * @param {number} totalPages
   * @param {number | null} restorePageFocus
   */
  function renderPagination(totalPages, restorePageFocus) {
    const wasPrevFocused = document.activeElement === recentPrevBtnEl;
    const wasNextFocused = document.activeElement === recentNextBtnEl;

    recentPrevBtnEl.disabled = currentPage <= 1;
    recentNextBtnEl.disabled = currentPage >= totalPages;

    recentPageListEl.textContent = "";
    const fragment = document.createDocumentFragment();
    /** @type {HTMLButtonElement | null} */
    let focusTargetBtn = null;

    for (const entry of getVisiblePageItems(currentPage, totalPages)) {
      if (entry === "ellipsis") {
        const span = document.createElement("span");
        span.className = "recent-page-ellipsis";
        span.setAttribute("aria-hidden", "true");
        span.textContent = "…";
        fragment.appendChild(span);
        continue;
      }

      const pageNum = entry;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "recent-page-btn";
      btn.textContent = String(pageNum);
      btn.setAttribute("aria-label", `Page ${pageNum}`);
      if (pageNum === currentPage) {
        btn.classList.add("recent-page-btn--active");
        btn.setAttribute("aria-current", "page");
      }

      btn.addEventListener("click", () => {
        if (pageNum !== currentPage) {
          currentPage = pageNum;
          renderCurrentPage({ restorePageFocus: pageNum });
        }
      });

      if (restorePageFocus === pageNum) {
        focusTargetBtn = btn;
      }
      fragment.appendChild(btn);
    }

    recentPageListEl.appendChild(fragment);

    if (focusTargetBtn) {
      focusTargetBtn.focus();
    } else if (wasPrevFocused && recentPrevBtnEl.disabled) {
      recentNextBtnEl.focus();
    } else if (wasNextFocused && recentNextBtnEl.disabled) {
      recentPrevBtnEl.focus();
    }
  }

  function renderCurrentPage({ restorePageFocus = null } = {}) {
    recentListEl.textContent = "";

    if (allRecentFiles.length === 0) {
      currentPage = 1;
      recentRangeEl.textContent = "";
      recentRangeEl.hidden = true;
      recentPageListEl.textContent = "";
      recentPaginationEl.hidden = true;
      recentSectionEl.hidden = true;
      return;
    }

    const totalPages = Math.ceil(allRecentFiles.length / RECENTS_PAGE_SIZE);
    currentPage = Math.max(1, Math.min(currentPage, totalPages));

    const startIndex = (currentPage - 1) * RECENTS_PAGE_SIZE;
    const endIndex = Math.min(startIndex + RECENTS_PAGE_SIZE, allRecentFiles.length);
    const pageItems = allRecentFiles.slice(startIndex, endIndex);

    const fragment = document.createDocumentFragment();
    for (const item of pageItems) {
      fragment.appendChild(buildRecentItemElement(item));
    }
    recentListEl.appendChild(fragment);

    if (totalPages > 1) {
      recentRangeEl.textContent = `${startIndex + 1}–${endIndex} of ${allRecentFiles.length}`;
      recentRangeEl.hidden = false;
      recentPaginationEl.hidden = false;
      renderPagination(totalPages, restorePageFocus);
    } else {
      recentRangeEl.textContent = "";
      recentRangeEl.hidden = true;
      recentPageListEl.textContent = "";
      recentPaginationEl.hidden = true;
    }

    recentSectionEl.hidden = false;
  }

  /**
   * Updates the stored recent files list and renders the current (clamped) page.
   * @param {Array<{ path: string, title: string, last_page: number, page_count: number }>} recentFiles
   * @param {{ resetPage?: boolean }} [options]
   */
  function renderRecents(recentFiles, options = {}) {
    allRecentFiles = Array.isArray(recentFiles) ? recentFiles : [];
    if (options.resetPage) {
      currentPage = 1;
    }
    renderCurrentPage();
  }

  function resetRecentPage() {
    currentPage = 1;
  }

  return {
    renderRecents,
    resetRecentPage,
    showError,
    clearError,
  };
}
