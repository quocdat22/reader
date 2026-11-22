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
import { HOME_TAB_ID, createTabManager } from "./tabs.js";
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
  const toolbarEl = document.getElementById("toolbar");
  const emptyStateEl = document.getElementById("empty-state");
  const emptyOpenBtnEl = document.getElementById("empty-open-btn");
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
    if (wasFocused && tabManager.getActiveDocument()) {
      viewport.focus();
    }
  });
  noticeActionBtnEl.addEventListener("click", () => {
    const wasFocused = document.activeElement === noticeActionBtnEl;
    const action = pendingNoticeAction;
    hideNotice();
    action?.();
    if (wasFocused && tabManager.getActiveDocument()) {
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
    const hasAnyTabs = !tabManager.isEmpty();
    const activeDoc = tabManager.getActiveDocument();
    const isHomeTab = tabManager.isHomeActive();

    appChromeEl.hidden = !hasAnyTabs;
    toolbarEl.hidden = !activeDoc;
    readerShellEl.hidden = !activeDoc;
    emptyStateEl.hidden = Boolean(activeDoc);

    if (activeDoc) {
      emptyState.clearError();
      document.title = `${activeDoc.title} — Reader`;
    } else if (isHomeTab) {
      hideNotice();
      document.title = "Home — Reader";
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
    const active = tabManager.getActiveDocument();
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
      const active = tabManager.getActiveDocument();
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
      const active = tabManager.getActiveDocument();
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
      const active = tabManager.getActiveDocument();
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
      const active = tabManager.getActiveDocument();
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
    getActiveTab: () => tabManager.getActiveDocument(),
    isTabOpen: (documentId) => Boolean(tabManager.getById(documentId)),
    onMatchesUpdated: (tab) => {
      if (tabManager.getActiveDocument()?.documentId === tab.documentId) {
        viewport.syncSearchHighlights();
      }
    },
    onActiveMatchChanged: (tab, match) => {
      if (tabManager.getActiveDocument()?.documentId === tab.documentId && match) {
        viewport.syncSearchHighlights();
        viewport.scrollToNormalizedRect(match.page_index, match.rects[0]);
      }
    },
    onVisibilityChanged: (tab) => {
      if (tabManager.getActiveDocument()?.documentId === tab.documentId) {
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
    onSelectTab: (tabId) => {
      switchToTab(tabId);
    },
    onCloseTab: (tabId) => {
      void handleCloseTab(tabId);
    },
    onOpenHome: () => {
      void handleOpenHomeTab();
    },
  });

  const emptyState = createEmptyState({
    openBtnEl: emptyOpenBtnEl,
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

  async function handleOpenHomeTab() {
    const currentDoc = tabManager.getActiveDocument();
    const alreadyOnHome = tabManager.isHomeActive();

    if (currentDoc) {
      toolbar.cancelPageInput();
      toc.captureScroll(currentDoc);
      const snap = viewport.captureActiveSnapshot();
      if (snap) {
        scheduleSave(currentDoc);
      }
      viewport.unmount();
      toc.clear();
      search.syncTab(null);
    }

    tabManager.openHomeTab({ returnToTabId: currentDoc?.tabId ?? null });
    updateShellMode();

    if (currentDoc) {
      await flushPendingSave();
    }
    if (!alreadyOnHome) {
      void refreshRecents();
    }
    emptyOpenBtnEl?.focus();
  }

  function switchToTab(tabId) {
    const current = tabManager.getActive();
    if (current && current.tabId === tabId) {
      return;
    }

    const target = tabManager.getByTabId(tabId);
    if (!target) {
      return;
    }

    if (target.kind === "home") {
      void handleOpenHomeTab();
      return;
    }

    const currentDoc = tabManager.getActiveDocument();
    if (currentDoc) {
      toolbar.cancelPageInput();
      toc.captureScroll(currentDoc);
      const snap = viewport.captureActiveSnapshot();
      if (snap) {
        scheduleSave(currentDoc);
      }
      void flushPendingSave();
    }

    const next = tabManager.setActive(tabId);
    if (!next || next.kind !== "document") {
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
      const existingActiveDoc = tabManager.getActiveDocument();

      if (existingActiveDoc && existingActiveDoc.documentId !== response.document_id) {
        toolbar.cancelPageInput();
        toc.captureScroll(existingActiveDoc);
        viewport.captureActiveSnapshot();
        scheduleSave(existingActiveDoc);
        void flushPendingSave();
      }

      const tab = tabManager.upsertFromOpenResponse(response, {
        replaceHomeIfActive: tabManager.isHomeActive(),
      });
      const wasSameActive =
        existingActiveDoc && existingActiveDoc.documentId === tab.documentId;

      tabManager.setActive(tab.tabId);
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

      if (!tabManager.getActiveDocument()) {
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

    // Preserve batch error feedback if a later valid file transitioned into a document tab.
    if (lastError && tabManager.getActiveDocument()) {
      showNotice(lastError.message, lastError.actionOptions);
    }
  }

  async function handleOpenViaDialog() {
    try {
      const paths = await pickPdfFiles();
      await openPathBatch(paths);
    } catch (err) {
      const formatted = formatOpenError(err);
      if (!tabManager.getActiveDocument()) {
        emptyState.showError(formatted.message);
      } else {
        showNotice(formatted.message);
      }
    }
  }

  async function handleCloseTab(tabId) {
    const target = tabManager.getByTabId(tabId);
    if (!target) {
      return;
    }

    // Closing the singleton Home tab requires no backend IPC.
    if (target.kind === "home") {
      const wasActive = tabManager.isHomeActive();
      const { nextActive } = tabManager.remove(HOME_TAB_ID);
      updateShellMode();
      if (wasActive && nextActive && nextActive.kind === "document") {
        toc.syncTab(nextActive);
        search.syncTab(nextActive);
        viewport.mountTab(nextActive);
        viewport.focus();
      }
      return;
    }

    const documentId = target.documentId;
    if (closingTabIds.has(documentId)) {
      return;
    }
    closingTabIds.add(documentId);

    const active = tabManager.getActive();
    const closingActive = active && active.tabId === tabId;

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

    const { nextActive } = tabManager.remove(tabId);
    updateShellMode();

    if (closingActive && nextActive) {
      if (nextActive.kind === "document") {
        toc.syncTab(nextActive);
        search.syncTab(nextActive);
        viewport.mountTab(nextActive);
        viewport.focus();
      } else {
        toc.clear();
        search.syncTab(null);
        void refreshRecents();
        emptyOpenBtnEl?.focus();
      }
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

      if (!tabManager.getActiveDocument()) {
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
    hasActiveDocument: () => Boolean(tabManager.getActiveDocument()),
    isSearchOpen: () => search.isOpenForTab(tabManager.getActiveDocument()),
    onOpenFile: () => {
      void handleOpenViaDialog();
    },
    onCloseActiveTab: () => {
      const active = tabManager.getActive();
      if (active) {
        void handleCloseTab(active.tabId);
      }
    },
    onSwitchAdjacentTab: (delta) => {
      const nextId = tabManager.getAdjacentTabId(delta);
      if (nextId !== null) {
        switchToTab(nextId);
      }
    },
    onJumpToTabNumber: (digit) => {
      const targetId = tabManager.getTabIdAtShortcutIndex(digit);
      if (targetId !== null) {
        switchToTab(targetId);
      }
    },
    onOpenSearch: () => {
      const active = tabManager.getActiveDocument();
      if (active) {
        search.openForTab(active);
      }
    },
    onCloseSearch: () => {
      const active = tabManager.getActiveDocument();
      search.closeForTab(active, { focusViewport: true });
    },
    onNextSearchMatch: () => {
      const active = tabManager.getActiveDocument();
      if (active) {
        search.stepMatch(active, 1);
      }
    },
    onPrevSearchMatch: () => {
      const active = tabManager.getActiveDocument();
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
      const active = tabManager.getActiveDocument();
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
      if (tabManager.getActiveDocument()) {
        viewport.focus();
      }
    },
  });

  window.addEventListener("beforeunload", () => {
    const active = tabManager.getActiveDocument();
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

  // Prevent unintended WebView navigation if non-file links or text are dropped onto the window.
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());

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
