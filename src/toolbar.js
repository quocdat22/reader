/**
 * Slim persistent document toolbar synced to the active tab.
 */

export const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.85, 1.0, 1.15, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0,
];

export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/**
 * Returns the next discrete zoom step above or below `currentScale`.
 * @param {number} currentScale
 * @param {1 | -1} direction
 * @returns {number}
 */
export function getNextZoomStep(currentScale, direction) {
  const epsilon = 0.01;
  if (direction > 0) {
    for (const step of ZOOM_STEPS) {
      if (step > currentScale + epsilon) {
        return step;
      }
    }
    return MAX_ZOOM;
  }

  for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    if (ZOOM_STEPS[i] < currentScale - epsilon) {
      return ZOOM_STEPS[i];
    }
  }
  return MIN_ZOOM;
}

/**
 * @param {{
 *   pageInputEl: HTMLInputElement,
 *   pageTotalEl: HTMLElement,
 *   zoomOutBtnEl: HTMLButtonElement,
 *   zoomValueEl: HTMLElement,
 *   zoomInBtnEl: HTMLButtonElement,
 *   fitWidthBtnEl: HTMLButtonElement,
 *   fitPageBtnEl: HTMLButtonElement,
 *   openBtnEl: HTMLButtonElement,
 *   tocToggleBtnEl: HTMLButtonElement,
 *   searchToggleBtnEl: HTMLButtonElement,
 *   onJumpToPage: (pageIndex: number) => void,
 *   onStepZoom: (direction: 1 | -1) => void,
 *   onSetZoomMode: (mode: "fit_width" | "fit_page") => void,
 *   onToggleToc: () => void,
 *   onToggleSearch?: () => void,
 *   onOpenNew: () => void,
 *   onReturnFocusToViewport?: () => void,
 * }} options
 */
export function createToolbar({
  pageInputEl,
  pageTotalEl,
  zoomOutBtnEl,
  zoomValueEl,
  zoomInBtnEl,
  fitWidthBtnEl,
  fitPageBtnEl,
  openBtnEl,
  tocToggleBtnEl,
  searchToggleBtnEl,
  onJumpToPage,
  onStepZoom,
  onSetZoomMode,
  onToggleToc,
  onToggleSearch,
  onOpenNew,
  onReturnFocusToViewport,
}) {
  let currentPageIndex = 0;
  let currentPageCount = 0;
  let inputDirty = false;

  function syncPageInputValue() {
    pageInputEl.value = currentPageCount > 0 ? String(currentPageIndex + 1) : "";
    inputDirty = false;
  }

  function commitPageInput() {
    if (currentPageCount <= 0) {
      syncPageInputValue();
      return;
    }

    const parsed = Number.parseInt(pageInputEl.value.trim(), 10);
    if (!Number.isFinite(parsed)) {
      syncPageInputValue();
      return;
    }

    const clampedPageIndex = Math.max(0, Math.min(parsed - 1, currentPageCount - 1));
    currentPageIndex = clampedPageIndex;
    syncPageInputValue();
    onJumpToPage(clampedPageIndex);
  }

  function cancelPageInput() {
    syncPageInputValue();
    if (document.activeElement === pageInputEl) {
      pageInputEl.blur();
    }
  }

  pageInputEl.addEventListener("focus", () => {
    inputDirty = false;
    pageInputEl.select();
  });

  pageInputEl.addEventListener("input", () => {
    inputDirty = true;
  });

  pageInputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitPageInput();
      pageInputEl.blur();
      onReturnFocusToViewport?.();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelPageInput();
      onReturnFocusToViewport?.();
    }
  });

  pageInputEl.addEventListener("blur", () => {
    if (inputDirty) {
      commitPageInput();
    } else {
      syncPageInputValue();
    }
  });

  tocToggleBtnEl.addEventListener("click", () => {
    onToggleToc();
  });

  searchToggleBtnEl.addEventListener("click", () => {
    onToggleSearch?.();
  });

  zoomOutBtnEl.addEventListener("click", () => {
    onStepZoom(-1);
  });

  zoomInBtnEl.addEventListener("click", () => {
    onStepZoom(1);
  });

  fitWidthBtnEl.addEventListener("click", () => {
    onSetZoomMode("fit_width");
  });

  fitPageBtnEl.addEventListener("click", () => {
    onSetZoomMode("fit_page");
  });

  openBtnEl.addEventListener("click", () => {
    onOpenNew();
  });

  /**
   * Synchronizes all toolbar controls to the active tab's state.
   * @param {{ pageIndex: number, pageCount: number, zoomMode: "fit_width" | "fit_page" | "custom", zoomScale: number, tocOpen: boolean, searchOpen?: boolean }} state
   */
  function sync({ pageIndex, pageCount, zoomMode, zoomScale, tocOpen, searchOpen = false }) {
    currentPageIndex = pageIndex;
    currentPageCount = pageCount;

    if (document.activeElement !== pageInputEl) {
      syncPageInputValue();
    }

    pageTotalEl.textContent = String(pageCount);
    zoomValueEl.textContent = `${Math.round(zoomScale * 100)}%`;

    zoomOutBtnEl.disabled = zoomScale <= MIN_ZOOM + 0.005;
    zoomInBtnEl.disabled = zoomScale >= MAX_ZOOM - 0.005;

    fitWidthBtnEl.setAttribute("aria-pressed", String(zoomMode === "fit_width"));
    fitPageBtnEl.setAttribute("aria-pressed", String(zoomMode === "fit_page"));
    const tocExpanded = String(Boolean(tocOpen));
    tocToggleBtnEl.setAttribute("aria-pressed", tocExpanded);
    tocToggleBtnEl.setAttribute("aria-expanded", tocExpanded);
    const searchExpanded = String(Boolean(searchOpen));
    searchToggleBtnEl.setAttribute("aria-pressed", searchExpanded);
    searchToggleBtnEl.setAttribute("aria-expanded", searchExpanded);
  }

  function focusPageInput() {
    pageInputEl.focus();
    pageInputEl.select();
  }

  return {
    sync,
    focusPageInput,
    cancelPageInput,
  };
}
