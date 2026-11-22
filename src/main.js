/**
 * Application bootstrap, multi-tab coordination, drag-drop, and reading-state persistence.
 */

import {
  closeDocument,
  getInitialFile,
  getPersistedState,
  openDocument,
  pickPdfFiles,
  removeRecentFile,
  saveReadingState,
  subscribeDragDrop,
} from "./api.js";
import { createEmptyState, formatOpenError } from "./empty-state.js";
import { createSearchController } from "./search.js";
import { installShortcuts } from "./shortcuts.js";
import { createTabManager } from "./tabs.js";
import { createTextLayer } from "./text-layer.js";
import { createTocDrawer } from "./toc.js";
import { createToolbar, getNextZoomStep } from "./toolbar.js";
import { createViewport } from "./viewport.js";

const SAVE_DEBOUNCE_MS = 400;

document.addEventListener("DOMContentLoaded", () => {
  void bootstrap();
});

async function bootstrap() {
  const appChromeEl = document.getElementById("app-chrome");
  const emptyStateEl = document.getElementById("empty-state");
  const readerShellEl = document.getElementById("reader-shell");
  const dropOverlayEl = document.getElementById("drop-overlay");

  const noticeBannerEl = document.getElementById("notice-banner");
  const noticeMessageEl = document.getElementById("notice-message");
  const noticeActionBtnEl = document.getElementById("notice-action-btn");
  const noticeDismissBtnEl = document.getElementById("notice-dismiss-btn");

  const viewportEl = document.getElementById("viewport");
  const viewportTrackEl = document.getElementById("viewport-track");
  const tocDrawerEl = document.getElementById("toc-drawer");
  const searchBarEl = document.getElementById("search-bar");

  /** @type {ReturnType<typeof setTimeout> | null} */
  let saveTimer = null;
  /** @type {{ path: string, pageIndex: number, zoomMode: "fit_width" | "fit_page" | "custom", zoomScale: number } | null} */
  let pendingSavePayload = null;
  /** @type {(() => void) | null} */
  let pendingNoticeAction = null;
  /** @type {Set<number>} */
  const closingTabIds = new Set();
  /** @type {Set<string>} */
  const inFlightOpenPaths = new Set();

  function showNotice(message, options = {}) {
    noticeMessageEl.textContent = message;
    if (options.actionLabel && typeof options.onAction === "function") {
      pendingNoticeAction = options.onAction;
      noticeActionBtnEl.textContent = options.actionLabel;
      noticeActionBtnEl.hidden = false;
    } else {
      pendingNoticeAction = null;
      noticeActionBtnEl.hidden = true;
    }
    noticeBannerEl.hidden = false;
  }

  function hideNotice() {
    pendingNoticeAction = null;
    noticeActionBtnEl.hidden = true;
    noticeBannerEl.hidden = true;
    noticeMessageEl.textContent = "";
  }

  noticeDismissBtnEl.addEventListener("click", () => {
    const wasFocused = document.activeElement === noticeDismissBtnEl;
    hideNotice();
    if (wasFocused && tabManager.getActive()) {
      viewport.focus();
    }
  });
  noticeActionBtnEl.addEventListener("click", () => {
    const wasFocused = document.activeElement === noticeActionBtnEl;
    const action = pendingNoticeAction;
    hideNotice();
    action?.();
    if (wasFocused && tabManager.getActive()) {
      viewport.focus();
    }
  });

  function scheduleSave(tab) {
    if (!tab) {
      return;
    }
    pendingSavePayload = {
      path: tab.canonicalPath,
      pageIndex: tab.pageIndex,
      zoomMode: tab.zoomMode,
      zoomScale: tab.zoomScale,
    };

    if (saveTimer !== null) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flushPendingSave();
    }, SAVE_DEBOUNCE_MS);
  }

  async function flushPendingSave() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const payload = pendingSavePayload;
    pendingSavePayload = null;
    if (!payload) {
      return;
    }
    try {
      await saveReadingState(payload);
    } catch (err) {
      console.error("Failed to save reading state:", err);
    }
  }

  async function refreshRecents() {
    try {
      const persisted = await getPersistedState();
      emptyState.renderRecents(persisted.recent_files);
    } catch (err) {
      console.error("Failed to load persisted state:", err);
    }
  }

  function updateShellMode() {
    const hasOpenTabs = !tabManager.isEmpty();
    appChromeEl.hidden = !hasOpenTabs;
    readerShellEl.hidden = !hasOpenTabs;
    emptyStateEl.hidden = hasOpenTabs;

    if (hasOpenTabs) {
      emptyState.clearError();
      const active = tabManager.getActive();
      document.title = active ? `${active.title} — Reader` : "Reader";
    } else {
      hideNotice();
      document.title = "Reader";
    }
  }

  function syncToolbarForTab(tab) {
    if (!tab) {
      return;
    }
    toolbar.sync({
      pageIndex: tab.pageIndex,
      pageCount: tab.pageCount,
      zoomMode: tab.zoomMode,
      zoomScale: tab.zoomScale,
      tocOpen: tab.tocOpen,
      searchOpen: Boolean(tab.searchState?.open),
    });
  }

  function handleToggleToc() {
    const active = tabManager.getActive();
    if (!active) {
      return;
    }
    const wasFocusedInToc = toc.containsElement(document.activeElement);
    active.tocOpen = !active.tocOpen;
    toc.syncTab(active);
    syncToolbarForTab(active);
    if (!active.tocOpen && wasFocusedInToc) {
      viewport.focus();
    }
  }

  const toc = createTocDrawer({
    drawerEl: tocDrawerEl,
    onJumpToPage: (pageIndex, { fromKeyboard }) => {
      viewport.scrollToPage(pageIndex);
      if (!fromKeyboard) {
        viewport.focus();
      }
    },
    onClose: () => {
      const active = tabManager.getActive();
      if (!active || !active.tocOpen) {
        return;
      }
      handleToggleToc();
    },
  });

  const toolbar = createToolbar({
    pageInputEl: document.getElementById("page-input"),
    pageTotalEl: document.getElementById("page-total"),
    zoomOutBtnEl: document.getElementById("zoom-out-btn"),
    zoomValueEl: document.getElementById("zoom-value"),
    zoomInBtnEl: document.getElementById("zoom-in-btn"),
    fitWidthBtnEl: document.getElementById("fit-width-btn"),
    fitPageBtnEl: document.getElementById("fit-page-btn"),
    openBtnEl: document.getElementById("open-btn"),
    tocToggleBtnEl: document.getElementById("toc-toggle-btn"),
    searchToggleBtnEl: document.getElementById("search-toggle-btn"),
    onJumpToPage: (pageIndex) => {
      viewport.scrollToPage(pageIndex);
    },
    onStepZoom: (direction) => {
      const active = tabManager.getActive();
      if (!active) {
        return;
      }
      viewport.setCustomZoom(getNextZoomStep(active.zoomScale, direction));
    },
    onSetZoomMode: (mode) => {
      viewport.setZoomMode(mode);
    },
    onToggleToc: () => {
      handleToggleToc();
    },
    onToggleSearch: () => {
      const active = tabManager.getActive();
      if (active) {
        search.toggleForTab(active);
      }
    },
    onOpenNew: () => {
      void handleOpenViaDialog();
    },
    onReturnFocusToViewport: () => {
      viewport.focus();
    },
  });

  const textLayer = createTextLayer({ viewportEl });

  const viewport = createViewport({
    viewportEl,
    trackEl: viewportTrackEl,
    textLayer,
    onViewStateChange: (snapshot) => {
      const active = tabManager.getActive();
      if (!active || active.documentId !== snapshot.documentId) {
        return;
      }
      syncToolbarForTab(active);
      toc.syncActivePage(active.pageIndex);
      scheduleSave(active);
    },
  });

  const search = createSearchController({
    barEl: searchBarEl,
    getActiveTab: () => tabManager.getActive(),
    isTabOpen: (documentId) => Boolean(tabManager.getById(documentId)),
    onMatchesUpdated: (tab) => {
      if (tabManager.getActive()?.documentId === tab.documentId) {
        viewport.syncSearchHighlights();
      }
    },
    onActiveMatchChanged: (tab, match) => {
      if (tabManager.getActive()?.documentId === tab.documentId && match) {
        viewport.syncSearchHighlights();
        viewport.scrollToNormalizedRect(match.page_index, match.rects[0]);
      }
    },
    onVisibilityChanged: (tab) => {
      if (tabManager.getActive()?.documentId === tab.documentId) {
        syncToolbarForTab(tab);
      }
    },
    onCloseFocusViewport: () => {
      viewport.focus();
    },
  });

  const tabManager = createTabManager({
    tabListEl: document.getElementById("tab-list"),
    addBtnEl: document.getElementById("tab-add-btn"),
    onSelectTab: (documentId) => {
      switchToTab(documentId);
    },
    onCloseTab: (documentId) => {
      void handleCloseTab(documentId);
    },
    onOpenNew: () => {
      void handleOpenViaDialog();
    },
  });

  const emptyState = createEmptyState({
    openBtnEl: document.getElementById("empty-open-btn"),
    errorBoxEl: document.getElementById("empty-error"),
    errorMsgEl: document.getElementById("empty-error-message"),
    errorActionBtnEl: document.getElementById("empty-error-action"),
    errorDismissBtnEl: document.getElementById("empty-error-dismiss"),
    recentSectionEl: document.getElementById("recent-section"),
    recentListEl: document.getElementById("recent-list"),
    onOpenDialog: () => {
      void handleOpenViaDialog();
    },
    onOpenRecent: (path) => {
      void handleOpenPath(path, { fromRecent: true });
    },
    onRemoveRecent: (path) => {
      void handleRemoveRecent(path);
    },
  });

  function switchToTab(documentId) {
    const current = tabManager.getActive();
    if (current && current.documentId === documentId) {
      return;
    }

    toolbar.cancelPageInput();

    if (current) {
      toc.captureScroll(current);
      const snap = viewport.captureActiveSnapshot();
      if (snap) {
        scheduleSave(current);
      }
      void flushPendingSave();
    }

    const next = tabManager.setActive(documentId);
    if (!next) {
      return;
    }

    updateShellMode();
    toc.syncTab(next);
    search.syncTab(next);
    viewport.mountTab(next);
    viewport.focus();
  }

  async function handleOpenPath(path, options = {}) {
    if (typeof path !== "string") {
      return { ok: false, error: null };
    }
    const trimmed = path.trim();
    if (trimmed.length === 0 || inFlightOpenPaths.has(trimmed)) {
      return { ok: false, error: null };
    }

    if (options.clearExistingError !== false) {
      hideNotice();
    }

    inFlightOpenPaths.add(trimmed);
    try {
      const response = await openDocument(path);
      const existingActive = tabManager.getActive();

      if (existingActive && existingActive.documentId !== response.document_id) {
        toolbar.cancelPageInput();
        toc.captureScroll(existingActive);
        viewport.captureActiveSnapshot();
        scheduleSave(existingActive);
        void flushPendingSave();
      }

      const tab = tabManager.upsertFromOpenResponse(response);
      const wasSameActive =
        existingActive && existingActive.documentId === tab.documentId;

      tabManager.setActive(tab.documentId);
      updateShellMode();

      if (!wasSameActive) {
        toc.syncTab(tab);
        search.syncTab(tab);
        viewport.mountTab(tab);
      }

      viewport.focus();
      void refreshRecents();
      return { ok: true, error: null };
    } catch (err) {
      const formatted = formatOpenError(err, options);
      const actionOptions = formatted.canRemoveRecent
        ? {
            actionLabel: "Remove from recent",
            onAction: () => {
              void handleRemoveRecent(path);
            },
          }
        : {};

      if (tabManager.isEmpty()) {
        emptyState.showError(formatted.message, actionOptions);
      } else {
        showNotice(formatted.message, actionOptions);
      }
      return { ok: false, error: { message: formatted.message, actionOptions } };
    } finally {
      inFlightOpenPaths.delete(trimmed);
    }
  }

  async function openPathBatch(paths) {
    if (!Array.isArray(paths) || paths.length === 0) {
      return;
    }
    hideNotice();
    emptyState.clearError();

    /** @type {{ message: string, actionOptions: any } | null} */
    let lastError = null;
    for (const path of paths) {
      const result = await handleOpenPath(path, { clearExistingError: false });
      if (!result.ok && result.error) {
        lastError = result.error;
      }
    }

    // Preserve batch error feedback if a later valid file transitioned out of the empty state.
    if (lastError && !tabManager.isEmpty()) {
      showNotice(lastError.message, lastError.actionOptions);
    }
  }

  async function handleOpenViaDialog() {
    try {
      const paths = await pickPdfFiles();
      await openPathBatch(paths);
    } catch (err) {
      const formatted = formatOpenError(err);
      if (tabManager.isEmpty()) {
        emptyState.showError(formatted.message);
      } else {
        showNotice(formatted.message);
      }
    }
  }

  async function handleCloseTab(documentId) {
    if (closingTabIds.has(documentId)) {
      return;
    }
    const target = tabManager.getById(documentId);
    if (!target) {
      return;
    }
    closingTabIds.add(documentId);

    const active = tabManager.getActive();
    const closingActive = active && active.documentId === documentId;

    if (closingActive) {
      toolbar.cancelPageInput();
      toc.captureScroll(target);
      viewport.captureActiveSnapshot();
      if (pendingSavePayload?.path === target.canonicalPath) {
        if (saveTimer !== null) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        pendingSavePayload = null;
      }
      viewport.unmount();
    }

    const snapshot = {
      path: target.canonicalPath,
      pageIndex: target.pageIndex,
      zoomMode: target.zoomMode,
      zoomScale: target.zoomScale,
    };

    const { nextActive } = tabManager.remove(documentId);
    updateShellMode();

    if (closingActive && nextActive) {
      toc.syncTab(nextActive);
      search.syncTab(nextActive);
      viewport.mountTab(nextActive);
      viewport.focus();
    } else if (tabManager.isEmpty()) {
      toc.clear();
      search.clear();
    }

    try {
      try {
        await saveReadingState(snapshot);
      } catch (err) {
        console.error("Failed to save reading state on close:", err);
      }

      try {
        await closeDocument(documentId);
      } catch (err) {
        console.error(`Failed to close document ${documentId}:`, err);
      }

      if (tabManager.isEmpty()) {
        await refreshRecents();
      }
    } finally {
      closingTabIds.delete(documentId);
    }
  }

  async function handleRemoveRecent(path) {
    try {
      const updated = await removeRecentFile(path);
      emptyState.renderRecents(updated.recent_files);
    } catch (err) {
      console.error("Failed to remove recent file:", err);
    }
  }

  installShortcuts({
    viewportEl,
    isInsideToc: (el) => toc.containsElement(el),
    isInsideSearch: (el) => search.containsElement(el),
    hasActiveTab: () => Boolean(tabManager.getActive()),
    isSearchOpen: () => search.isOpenForTab(tabManager.getActive()),
    onOpenFile: () => {
      void handleOpenViaDialog();
    },
    onCloseActiveTab: () => {
      const active = tabManager.getActive();
      if (active) {
        void handleCloseTab(active.documentId);
      }
    },
    onSwitchAdjacentTab: (delta) => {
      const nextId = tabManager.getAdjacentDocumentId(delta);
      if (nextId !== null) {
        switchToTab(nextId);
      }
    },
    onJumpToTabNumber: (digit) => {
      const targetId = tabManager.getDocumentIdAtShortcutIndex(digit);
      if (targetId !== null) {
        switchToTab(targetId);
      }
    },
    onOpenSearch: () => {
      const active = tabManager.getActive();
      if (active) {
        search.openForTab(active);
      }
    },
    onCloseSearch: () => {
      const active = tabManager.getActive();
      search.closeForTab(active, { focusViewport: true });
    },
    onNextSearchMatch: () => {
      const active = tabManager.getActive();
      if (active) {
        search.stepMatch(active, 1);
      }
    },
    onPrevSearchMatch: () => {
      const active = tabManager.getActive();
      if (active) {
        search.stepMatch(active, -1);
      }
    },
    onFocusPageInput: () => {
      toolbar.focusPageInput();
    },
    onToggleToc: () => {
      handleToggleToc();
    },
    onZoomStep: (direction) => {
      const active = tabManager.getActive();
      if (!active) {
        return;
      }
      viewport.setCustomZoom(getNextZoomStep(active.zoomScale, direction));
    },
    onResetZoom: () => {
      viewport.setZoomMode("fit_width");
    },
    onNavigateViewport: (action) => {
      if (action === "page_down") {
        viewport.scrollPageStep(1);
      } else if (action === "page_up") {
        viewport.scrollPageStep(-1);
      } else if (action === "home") {
        viewport.scrollToStart();
      } else if (action === "end") {
        viewport.scrollToEnd();
      }
    },
    onEscape: () => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused !== viewportEl) {
        focused.blur();
      }
      if (tabManager.getActive()) {
        viewport.focus();
      }
    },
  });

  window.addEventListener("beforeunload", () => {
    const active = tabManager.getActive();
    if (active) {
      viewport.captureActiveSnapshot();
      pendingSavePayload = {
        path: active.canonicalPath,
        pageIndex: active.pageIndex,
        zoomMode: active.zoomMode,
        zoomScale: active.zoomScale,
      };
      void flushPendingSave();
    }
  });

  // Subscribe to native Tauri window file drag-and-drop events.
  try {
    await subscribeDragDrop({
      onEnter: () => {
        dropOverlayEl.hidden = false;
      },
      onLeave: () => {
        dropOverlayEl.hidden = true;
      },
      onDrop: (paths) => {
        dropOverlayEl.hidden = true;
        void openPathBatch(paths);
      },
    });
  } catch (err) {
    console.error("Failed to subscribe to drag-drop events:", err);
  }

  // Initial startup load: persisted recents + optional CLI / "Open With" file.
  await refreshRecents();
  updateShellMode();

  try {
    const initialFile = await getInitialFile();
    if (initialFile) {
      await handleOpenPath(initialFile);
    }
  } catch (err) {
    console.error("Failed to consume initial file:", err);
  }
}
