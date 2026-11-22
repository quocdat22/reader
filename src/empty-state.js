/**
 * Empty state UI, recent files list, and plain actionable error formatting.
 */

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
  recentListEl,
  onOpenDialog,
  onOpenRecent,
  onRemoveRecent,
}) {
  /** @type {(() => void) | null} */
  let pendingErrorAction = null;

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

  /**
   * Renders the concise recent files list.
   * @param {Array<{ path: string, title: string, last_page: number, page_count: number }>} recentFiles
   */
  function renderRecents(recentFiles) {
    recentListEl.textContent = "";

    if (!Array.isArray(recentFiles) || recentFiles.length === 0) {
      recentSectionEl.hidden = true;
      return;
    }

    const fragment = document.createDocumentFragment();

    for (const item of recentFiles) {
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
      fragment.appendChild(li);
    }

    recentListEl.appendChild(fragment);
    recentSectionEl.hidden = false;
  }

  return {
    renderRecents,
    showError,
    clearError,
  };
}
