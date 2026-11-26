import {
  formatOpenError,
  type FormattedOpenError,
} from "../domain/format-error";
import {
  buildOutlineModel,
  createInitialExpandedIds,
  type OutlineNode,
} from "../domain/outline";
import {
  groupMatchesByPage,
  resolveInitialMatchIndex,
  stepMatchIndex,
} from "../domain/search";
import { getNextZoomStep } from "../domain/zoom";
import type { ReaderApi, SaveReadingStateParams } from "../ipc/client";
import { normalizeApiError } from "../ipc/errors";
import type { AppStore } from "./app-store.svelte";
import type { DocumentScopeRegistry } from "./doc-scope";
import type { PersistenceQueue } from "./persistence";
import {
  HOME_TAB_ID,
  toDocumentTabId,
  type BannerState,
  type DocState,
  type DocumentTabItem,
  type FocusTarget,
  type TransitionHooks,
  type ViewportSnapshot,
} from "./types";

const SEARCH_DEBOUNCE_MS = 200;
const SEARCHING_INDICATOR_DELAY_MS = 120;

export interface OpenPathOptions {
  readonly fromRecent?: boolean;
  readonly clearExistingError?: boolean;
}

export interface OpenPathResult {
  readonly ok: boolean;
  readonly error: {
    readonly formatted: FormattedOpenError;
    readonly path: string;
  } | null;
}

export interface CreateAppActionsDeps {
  readonly store: AppStore;
  readonly api: ReaderApi;
  readonly scopes: DocumentScopeRegistry;
  readonly persistence: PersistenceQueue;
  readonly hooks?: TransitionHooks;
}

interface SearchRuntime {
  debounceTimer: ReturnType<typeof setTimeout> | null;
  searchingDelayTimer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  activeSearchSignal: AbortSignal | null;
  requestSeq: number;
}

export interface AppActions {
  bootstrap(): Promise<void>;
  refreshRecents(): Promise<void>;
  openPath(path: string, options?: OpenPathOptions): Promise<OpenPathResult>;
  openPathBatch(paths: readonly string[]): Promise<void>;
  openViaDialog(): Promise<void>;
  openHomeTab(): Promise<void>;
  selectTab(tabId: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  reorderTab(fromIndex: number, toIndex: number): boolean;
  moveTabBy(tabId: string, delta: -1 | 1): boolean;
  applyViewportSnapshot(
    documentId: number,
    snapshot: ViewportSnapshot,
    reason: "mount" | "user",
  ): void;
  requestZoomMode(mode: "fit_width" | "fit_page"): void;
  requestZoomStep(direction: 1 | -1): void;
  requestJumpToPage(pageIndex: number): void;
  navigateViewport(action: "page_down" | "page_up" | "home" | "end"): void;
  focusHomeRecentSearch(): void;
  toggleToc(): void;
  closeToc(): void;
  ensureOutlineLoaded(
    documentId: number,
    options?: { force?: boolean },
  ): Promise<void>;
  setTocNodeExpanded(
    documentId: number,
    nodeId: string,
    expanded: boolean,
  ): void;
  selectTocNode(
    documentId: number,
    node: OutlineNode,
    options?: { fromKeyboard?: boolean },
  ): void;
  setTocScrollTop(documentId: number, scrollTop: number): void;
  openSearch(): void;
  closeSearch(options?: { focusViewport?: boolean }): void;
  toggleSearch(): void;
  setSearchQuery(query: string): void;
  stepSearchMatch(delta: 1 | -1): void;
  removeRecent(path: string): Promise<void>;
  setRecentQuery(query: string): void;
  clearRecentSearch(): void;
  setRecentPage(page: number): void;
  dismissBanner(): void;
  triggerBannerAction(): void;
  setDraggingFiles(isDragging: boolean): void;
  setWindowMaximized(isMaximized: boolean): void;
  requestFocus(target: FocusTarget): void;
  flushActiveReadingState(): Promise<void>;
  dispose(): void;
}

/**
 * Creates the unidirectional actions layer that owns all mutations to {@link AppStore}.
 */
export function createAppActions({
  store,
  api,
  scopes,
  persistence,
  hooks = {},
}: CreateAppActionsDeps): AppActions {
  const inFlightOpenPaths = new Set<string>();
  const closingDocIds = new Set<number>();
  const searchRuntimes = new Map<number, SearchRuntime>();
  let focusSeq = 0;

  function requestFocus(target: FocusTarget): void {
    focusSeq += 1;
    store.focusRequest = { target, seq: focusSeq };
  }

  function commitShellBannerCleanup(): void {
    if (store.shellMode === "document") {
      if (store.banner?.scope === "home") {
        store.banner = null;
      }
    } else if (store.banner?.scope === "workspace") {
      store.banner = null;
    }
  }

  function buildErrorBanner(
    scope: "home" | "workspace",
    formatted: FormattedOpenError,
    path?: string,
  ): BannerState {
    if (formatted.canRemoveRecent && path) {
      return {
        scope,
        message: formatted.message,
        actionLabel: "Remove from recent",
        onAction: () => {
          void removeRecent(path);
        },
      };
    }
    return {
      scope,
      message: formatted.message,
    };
  }

  function getSearchRuntime(documentId: number): SearchRuntime {
    let runtime = searchRuntimes.get(documentId);
    if (!runtime) {
      runtime = {
        debounceTimer: null,
        searchingDelayTimer: null,
        inFlight: false,
        activeSearchSignal: null,
        requestSeq: 0,
      };
      searchRuntimes.set(documentId, runtime);
    }
    return runtime;
  }

  function clearSearchDebounce(runtime: SearchRuntime): void {
    if (runtime.debounceTimer !== null) {
      clearTimeout(runtime.debounceTimer);
      runtime.debounceTimer = null;
    }
  }

  function clearSearchingDelay(runtime: SearchRuntime, doc?: DocState): void {
    if (runtime.searchingDelayTimer !== null) {
      clearTimeout(runtime.searchingDelayTimer);
      runtime.searchingDelayTimer = null;
    }
    if (doc) {
      doc.search.showSearchingLabel = false;
    }
  }

  function clearSearchRuntime(documentId: number): void {
    const runtime = searchRuntimes.get(documentId);
    if (!runtime) {
      return;
    }
    clearSearchDebounce(runtime);
    clearSearchingDelay(runtime);
    runtime.inFlight = false;
    runtime.activeSearchSignal = null;
    searchRuntimes.delete(documentId);
  }

  function resetSearchMatches(doc: DocState): void {
    doc.search.lastSearchedQuery = "";
    doc.search.status = "idle";
    doc.search.showSearchingLabel = false;
    doc.search.matches = [];
    doc.search.matchesByPage = groupMatchesByPage([]);
    doc.search.currentIndex = -1;
    doc.search.errorMessage = null;
    doc.search.highlightVersion += 1;
  }

  function applySnapshotToDoc(doc: DocState, snapshot: ViewportSnapshot): void {
    doc.view.pageIndex = snapshot.pageIndex;
    doc.view.scrollTop = snapshot.scrollTop;
    doc.view.scrollAnchor = snapshot.scrollAnchor;
    doc.view.zoomMode = snapshot.zoomMode;
    doc.view.zoomScale = snapshot.zoomScale;

    if (
      doc.outline.selectedNodeId &&
      doc.outline.model?.byId.get(doc.outline.selectedNodeId)?.pageIndex !==
        snapshot.pageIndex
    ) {
      doc.outline.selectedNodeId = null;
    }
  }

  /**
   * Single unified outgoing-document deactivation pipeline shared across
   * `selectTab`, `openHomeTab`, `openPath`, and `closeTab`.
   */
  function deactivateCurrentDocument(options: {
    mode: "switch" | "close";
    targetDoc?: DocState;
  }): SaveReadingStateParams | null {
    const doc = options.targetDoc ?? store.activeDoc;
    if (!doc) {
      return null;
    }

    const isActive = store.activeDoc?.documentId === doc.documentId;
    if (isActive) {
      hooks.cancelPageInput?.();
      hooks.captureTocScroll?.(doc);
      const snapshot = hooks.captureViewportSnapshot?.(doc) ?? null;
      if (snapshot) {
        const viewChanged =
          snapshot.pageIndex !== doc.view.pageIndex ||
          snapshot.zoomMode !== doc.view.zoomMode ||
          snapshot.zoomScale !== doc.view.zoomScale;
        applySnapshotToDoc(doc, snapshot);
        if (
          options.mode === "switch" &&
          (viewChanged || persistence.hasPending(doc.canonicalPath))
        ) {
          persistence.schedule({
            path: doc.canonicalPath,
            pageIndex: doc.view.pageIndex,
            zoomMode: doc.view.zoomMode,
            zoomScale: doc.view.zoomScale,
          });
        }
      }
    }

    if (options.mode === "switch") {
      const runtime = searchRuntimes.get(doc.documentId);
      if (runtime && runtime.debounceTimer !== null && doc.search.open) {
        clearSearchDebounce(runtime);
        void executeSearch(doc.documentId, doc.search.query);
      } else if (runtime) {
        clearSearchingDelay(runtime, doc);
      }
      return null;
    }

    persistence.cancel(doc.canonicalPath);
    return {
      path: doc.canonicalPath,
      pageIndex: doc.view.pageIndex,
      zoomMode: doc.view.zoomMode,
      zoomScale: doc.view.zoomScale,
    };
  }

  async function refreshRecents(): Promise<void> {
    try {
      const persisted = await api.getPersistedState();
      store.recents = Array.isArray(persisted.recent_files)
        ? persisted.recent_files
        : [];
    } catch (err) {
      console.error("Failed to load persisted state:", err);
    }
  }

  async function bootstrap(): Promise<void> {
    await refreshRecents();
    commitShellBannerCleanup();

    try {
      const initialFile = await api.getInitialFile();
      if (initialFile) {
        await openPath(initialFile);
      }
    } catch (err) {
      console.error("Failed to consume initial file:", err);
    }
  }

  async function openPath(
    path: string,
    options: OpenPathOptions = {},
  ): Promise<OpenPathResult> {
    if (typeof path !== "string") {
      return { ok: false, error: null };
    }
    const trimmed = path.trim();
    if (trimmed.length === 0 || inFlightOpenPaths.has(trimmed)) {
      return { ok: false, error: null };
    }

    if (options.clearExistingError !== false) {
      store.banner = null;
    }

    inFlightOpenPaths.add(trimmed);
    try {
      const response = await api.openDocument(path);
      const outgoingDoc = store.activeDoc;
      if (outgoingDoc && outgoingDoc.documentId !== response.document_id) {
        deactivateCurrentDocument({ mode: "switch" });
        void persistence.flush(outgoingDoc.canonicalPath);
      }

      const tabId = toDocumentTabId(response.document_id);
      const replaceHomeIfActive = store.isHomeActive;
      const existingTab = store.tabsById.get(tabId);
      const existingDoc = store.docsById.get(response.document_id);

      if (existingTab && existingDoc) {
        if (replaceHomeIfActive) {
          store.tabsById.delete(HOME_TAB_ID);
          store.tabOrder = store.tabOrder.filter((id) => id !== HOME_TAB_ID);
        }
      } else {
        const newDoc = store.createDocState(response);
        const newTab: DocumentTabItem = {
          kind: "document",
          tabId,
          documentId: response.document_id,
          title: newDoc.title,
          canonicalPath: response.canonical_path,
        };
        scopes.ensure(response.document_id);
        store.docsById.set(response.document_id, newDoc);
        store.tabsById.set(tabId, newTab);

        if (replaceHomeIfActive) {
          const homeIndex = store.tabOrder.indexOf(HOME_TAB_ID);
          store.tabsById.delete(HOME_TAB_ID);
          if (homeIndex !== -1) {
            const nextOrder = [...store.tabOrder];
            nextOrder.splice(homeIndex, 1, tabId);
            store.tabOrder = nextOrder;
          } else {
            store.tabOrder = [...store.tabOrder, tabId];
          }
        } else {
          store.tabOrder = [...store.tabOrder, tabId];
        }
      }

      store.activeTabId = tabId;
      commitShellBannerCleanup();
      store.recentQuery = "";
      store.recentPage = 1;
      requestFocus("viewport");
      void refreshRecents();
      return { ok: true, error: null };
    } catch (err) {
      const formatted = formatOpenError(err, options);
      const scope = store.activeDoc ? "workspace" : "home";
      store.banner = buildErrorBanner(scope, formatted, path);
      return { ok: false, error: { formatted, path } };
    } finally {
      inFlightOpenPaths.delete(trimmed);
    }
  }

  async function openPathBatch(paths: readonly string[]): Promise<void> {
    if (!Array.isArray(paths) || paths.length === 0) {
      return;
    }
    store.banner = null;

    let lastError: {
      readonly formatted: FormattedOpenError;
      readonly path: string;
    } | null = null;
    for (const path of paths) {
      const result = await openPath(path, { clearExistingError: false });
      if (!result.ok && result.error) {
        lastError = result.error;
      }
    }

    // Preserve batch error feedback if a later valid file transitioned into a document tab.
    if (lastError && store.activeDoc) {
      store.banner = buildErrorBanner(
        "workspace",
        lastError.formatted,
        lastError.path,
      );
    }
  }

  async function openViaDialog(): Promise<void> {
    try {
      const paths = await api.pickPdfFiles();
      await openPathBatch(paths);
    } catch (err) {
      const formatted = formatOpenError(err);
      const scope = store.activeDoc ? "workspace" : "home";
      store.banner = buildErrorBanner(scope, formatted);
    }
  }

  async function openHomeTab(): Promise<void> {
    const outgoingDoc = store.activeDoc;
    const alreadyOnHome = store.isHomeActive;

    const validReturnId =
      store.activeTabId &&
      store.activeTabId !== HOME_TAB_ID &&
      store.tabsById.has(store.activeTabId)
        ? store.activeTabId
        : null;

    if (outgoingDoc) {
      deactivateCurrentDocument({ mode: "switch" });
    }

    const existingHome = store.tabsById.get(HOME_TAB_ID);
    if (existingHome && existingHome.kind === "home") {
      if (validReturnId) {
        existingHome.returnToTabId = validReturnId;
      }
    } else {
      const homeTab = store.createHomeTab(validReturnId);
      store.tabsById.set(HOME_TAB_ID, homeTab);
      store.tabOrder = [...store.tabOrder, HOME_TAB_ID];
    }

    store.activeTabId = HOME_TAB_ID;
    commitShellBannerCleanup();
    requestFocus("home_open");

    if (outgoingDoc) {
      await persistence.flush(outgoingDoc.canonicalPath);
    }
    if (!alreadyOnHome) {
      void refreshRecents();
    }
  }

  async function selectTab(tabId: string): Promise<void> {
    if (store.activeTabId === tabId) {
      return;
    }
    const target = store.tabsById.get(tabId);
    if (!target) {
      return;
    }
    if (target.kind === "home") {
      await openHomeTab();
      return;
    }

    const outgoingDoc = store.activeDoc;
    if (outgoingDoc) {
      deactivateCurrentDocument({ mode: "switch" });
      void persistence.flush(outgoingDoc.canonicalPath);
    }

    store.activeTabId = tabId;
    commitShellBannerCleanup();
    requestFocus("viewport");
  }

  async function closeTab(tabId: string): Promise<void> {
    const target = store.tabsById.get(tabId);
    if (!target) {
      return;
    }

    if (target.kind === "home") {
      const wasActive = store.isHomeActive;
      const index = store.tabOrder.indexOf(HOME_TAB_ID);
      const returnToTabId = target.returnToTabId;

      store.tabsById.delete(HOME_TAB_ID);
      const nextOrder = store.tabOrder.filter((id) => id !== HOME_TAB_ID);

      if (store.docsById.size === 0) {
        store.tabOrder = [];
        store.activeTabId = null;
      } else {
        store.tabOrder = nextOrder;
        if (wasActive) {
          if (returnToTabId && store.tabsById.has(returnToTabId)) {
            store.activeTabId = returnToTabId;
          } else {
            const fallbackIndex = Math.min(
              Math.max(0, index),
              nextOrder.length - 1,
            );
            store.activeTabId = nextOrder[fallbackIndex] ?? null;
          }
        }
      }

      commitShellBannerCleanup();
      if (wasActive && store.activeDoc) {
        requestFocus("viewport");
      }
      return;
    }

    const documentId = target.documentId;
    if (closingDocIds.has(documentId)) {
      return;
    }
    closingDocIds.add(documentId);

    const doc = store.docsById.get(documentId);
    const wasActive = store.activeTabId === tabId;
    const removedIndex = store.tabOrder.indexOf(tabId);

    const closingSnapshot = doc
      ? deactivateCurrentDocument({ mode: "close", targetDoc: doc })
      : null;

    scopes.dispose(documentId);
    clearSearchRuntime(documentId);

    store.tabsById.delete(tabId);
    store.docsById.delete(documentId);
    hooks.onDocumentClosed?.(documentId);

    const nextOrder = store.tabOrder.filter((id) => id !== tabId);

    if (store.docsById.size === 0) {
      // Automatically prune singleton Home tab when zero document tabs remain (CR-001).
      store.tabsById.clear();
      store.tabOrder = [];
      store.activeTabId = null;
    } else {
      store.tabOrder = nextOrder;
      if (wasActive) {
        const nextIndex = Math.min(
          Math.max(0, removedIndex),
          nextOrder.length - 1,
        );
        store.activeTabId = nextOrder[nextIndex] ?? null;
      }
    }

    commitShellBannerCleanup();

    if (wasActive) {
      if (store.activeDoc) {
        requestFocus("viewport");
      } else if (store.isHomeActive) {
        void refreshRecents();
        requestFocus("home_open");
      }
    }

    try {
      if (closingSnapshot) {
        try {
          await api.saveReadingState(closingSnapshot);
        } catch (err) {
          console.error("Failed to save reading state on close:", err);
        }
      }

      try {
        await api.closeDocument(documentId);
      } catch (err) {
        console.error(`Failed to close document ${documentId}:`, err);
      }

      if (!store.activeDoc) {
        await refreshRecents();
      }
    } finally {
      closingDocIds.delete(documentId);
    }
  }

  function reorderTab(fromIndex: number, toIndex: number): boolean {
    const count = store.tabOrder.length;
    if (
      !Number.isInteger(fromIndex) ||
      !Number.isInteger(toIndex) ||
      fromIndex < 0 ||
      fromIndex >= count ||
      toIndex < 0 ||
      toIndex >= count ||
      fromIndex === toIndex
    ) {
      return false;
    }

    const nextOrder = [...store.tabOrder];
    const [moved] = nextOrder.splice(fromIndex, 1);
    if (moved === undefined) {
      return false;
    }
    nextOrder.splice(toIndex, 0, moved);
    store.tabOrder = nextOrder;
    return true;
  }

  function moveTabBy(tabId: string, delta: -1 | 1): boolean {
    const index = store.tabOrder.indexOf(tabId);
    if (index === -1) {
      return false;
    }
    return reorderTab(index, index + delta);
  }

  function applyViewportSnapshot(
    documentId: number,
    snapshot: ViewportSnapshot,
    reason: "mount" | "user",
  ): void {
    const doc = store.docsById.get(documentId);
    if (!doc) {
      return;
    }

    applySnapshotToDoc(doc, snapshot);

    if (reason === "user") {
      persistence.schedule({
        path: doc.canonicalPath,
        pageIndex: doc.view.pageIndex,
        zoomMode: doc.view.zoomMode,
        zoomScale: doc.view.zoomScale,
      });
    }
  }

  function requestZoomMode(mode: "fit_width" | "fit_page"): void {
    const doc = store.activeDoc;
    if (!doc) {
      return;
    }
    if (hooks.viewportCommands?.setZoomMode) {
      hooks.viewportCommands.setZoomMode(mode);
    } else {
      doc.view.zoomMode = mode;
    }
  }

  function requestZoomStep(direction: 1 | -1): void {
    const doc = store.activeDoc;
    if (!doc) {
      return;
    }
    const nextScale = getNextZoomStep(doc.view.zoomScale, direction);
    if (hooks.viewportCommands?.setCustomZoom) {
      hooks.viewportCommands.setCustomZoom(nextScale);
    } else {
      doc.view.zoomMode = "custom";
      doc.view.zoomScale = nextScale;
    }
  }

  function requestJumpToPage(pageIndex: number): void {
    const doc = store.activeDoc;
    if (!doc || doc.pageCount <= 0) {
      return;
    }
    const clamped = Math.max(0, Math.min(pageIndex, doc.pageCount - 1));
    if (hooks.viewportCommands?.scrollToPage) {
      hooks.viewportCommands.scrollToPage(clamped);
    } else {
      applyViewportSnapshot(
        doc.documentId,
        {
          documentId: doc.documentId,
          pageIndex: clamped,
          scrollTop: doc.view.scrollTop,
          scrollAnchor: doc.view.scrollAnchor,
          zoomMode: doc.view.zoomMode,
          zoomScale: doc.view.zoomScale,
        },
        "user",
      );
    }
  }

  async function ensureOutlineLoaded(
    documentId: number,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const doc = store.docsById.get(documentId);
    if (!doc) {
      return;
    }
    if (doc.outline.status === "loading") {
      return;
    }
    if (!options.force && doc.outline.status === "loaded") {
      return;
    }

    const signal = scopes.getSignal(documentId);
    if (!signal || signal.aborted) {
      return;
    }

    doc.outline.status = "loading";
    doc.outline.error = null;

    try {
      const rawItems = await api.getOutline(documentId);
      if (
        signal.aborted ||
        !scopes.isAlive(documentId, signal) ||
        store.docsById.get(documentId) !== doc
      ) {
        return;
      }

      const model = buildOutlineModel(rawItems);
      doc.outline.model = model;
      doc.outline.status = "loaded";
      doc.outline.error = null;
      if (!doc.outline.expandedIds) {
        doc.outline.expandedIds = createInitialExpandedIds(
          model,
          doc.view.pageIndex,
        );
      }
    } catch (err) {
      if (
        signal.aborted ||
        !scopes.isAlive(documentId, signal) ||
        store.docsById.get(documentId) !== doc
      ) {
        return;
      }

      const normalized = normalizeApiError(err);
      doc.outline.status = "error";
      doc.outline.error =
        normalized.message.trim().length > 0
          ? normalized.message
          : "Could not load outline.";
    }
  }

  function toggleToc(): void {
    const doc = store.activeDoc;
    if (!doc) {
      return;
    }
    doc.outline.open = !doc.outline.open;
    if (doc.outline.open && doc.outline.status === "idle") {
      void ensureOutlineLoaded(doc.documentId);
    }
  }

  function closeToc(): void {
    const doc = store.activeDoc;
    if (!doc || !doc.outline.open) {
      return;
    }
    doc.outline.open = false;
  }

  function setTocNodeExpanded(
    documentId: number,
    nodeId: string,
    expanded: boolean,
  ): void {
    const doc = store.docsById.get(documentId);
    if (!doc || !doc.outline.expandedIds) {
      return;
    }
    if (expanded) {
      doc.outline.expandedIds.add(nodeId);
    } else {
      doc.outline.expandedIds.delete(nodeId);
    }
  }

  function selectTocNode(
    documentId: number,
    node: OutlineNode,
    options: { fromKeyboard?: boolean } = {},
  ): void {
    const doc = store.docsById.get(documentId);
    if (!doc) {
      return;
    }
    if (node.pageIndex !== null) {
      doc.outline.selectedNodeId = node.id;
      if (store.activeDoc?.documentId === documentId) {
        requestJumpToPage(node.pageIndex);
        if (!options.fromKeyboard) {
          requestFocus("viewport");
        }
      }
      return;
    }
    if (node.hasChildren && doc.outline.expandedIds) {
      setTocNodeExpanded(
        documentId,
        node.id,
        !doc.outline.expandedIds.has(node.id),
      );
    }
  }

  function setTocScrollTop(documentId: number, scrollTop: number): void {
    const doc = store.docsById.get(documentId);
    if (!doc) {
      return;
    }
    doc.outline.scrollTop = scrollTop;
  }

  async function executeSearch(
    documentId: number,
    rawQuery: string,
  ): Promise<void> {
    const doc = store.docsById.get(documentId);
    if (!doc || !scopes.isAlive(documentId)) {
      return;
    }

    const runtime = getSearchRuntime(documentId);

    if (rawQuery.trim().length === 0) {
      runtime.requestSeq += 1;
      scopes.cancelSearch(documentId);
      clearSearchingDelay(runtime, doc);
      runtime.inFlight = false;
      runtime.activeSearchSignal = null;
      resetSearchMatches(doc);
      return;
    }

    // Serialize at most one active IPC search per document; latest query runs on completion.
    if (runtime.inFlight) {
      return;
    }

    const seq = (runtime.requestSeq += 1);
    const searchSignal = scopes.beginSearch(documentId);
    runtime.inFlight = true;
    runtime.activeSearchSignal = searchSignal;
    doc.search.status = "searching";
    doc.search.errorMessage = null;
    clearSearchingDelay(runtime, doc);

    runtime.searchingDelayTimer = setTimeout(() => {
      runtime.searchingDelayTimer = null;
      if (
        !searchSignal.aborted &&
        scopes.isAlive(documentId, searchSignal) &&
        doc.search.open &&
        doc.search.status === "searching"
      ) {
        doc.search.showSearchingLabel = true;
      }
    }, SEARCHING_INDICATOR_DELAY_MS);

    try {
      const matches = await api.searchDocument(documentId, rawQuery);
      if (runtime.activeSearchSignal === searchSignal) {
        runtime.inFlight = false;
        runtime.activeSearchSignal = null;
        clearSearchingDelay(runtime, doc);
      }

      if (
        searchSignal.aborted ||
        !scopes.isAlive(documentId, searchSignal) ||
        store.docsById.get(documentId) !== doc ||
        !doc.search.open
      ) {
        return;
      }

      if (doc.search.query !== rawQuery || seq !== runtime.requestSeq) {
        if (doc.search.query.trim().length > 0) {
          void executeSearch(documentId, doc.search.query);
        } else {
          resetSearchMatches(doc);
        }
        return;
      }

      const normalizedMatches = Array.isArray(matches) ? matches : [];
      doc.search.status = "ready";
      doc.search.lastSearchedQuery = rawQuery;
      doc.search.matches = normalizedMatches;
      doc.search.matchesByPage = groupMatchesByPage(normalizedMatches);
      doc.search.currentIndex = resolveInitialMatchIndex(
        normalizedMatches,
        doc.view.pageIndex,
      );
      doc.search.highlightVersion += 1;
      if (doc.search.currentIndex >= 0) {
        doc.search.scrollToMatchSeq += 1;
      }
    } catch (err) {
      if (runtime.activeSearchSignal === searchSignal) {
        runtime.inFlight = false;
        runtime.activeSearchSignal = null;
        clearSearchingDelay(runtime, doc);
      }

      if (
        searchSignal.aborted ||
        !scopes.isAlive(documentId, searchSignal) ||
        store.docsById.get(documentId) !== doc ||
        !doc.search.open
      ) {
        return;
      }

      if (doc.search.query !== rawQuery || seq !== runtime.requestSeq) {
        if (doc.search.query.trim().length > 0) {
          void executeSearch(documentId, doc.search.query);
        }
        return;
      }

      const normalized = normalizeApiError(err);
      doc.search.status = "error";
      doc.search.matches = [];
      doc.search.matchesByPage = groupMatchesByPage([]);
      doc.search.currentIndex = -1;
      doc.search.errorMessage =
        normalized.message.trim().length > 0
          ? normalized.message
          : "Search failed.";
      doc.search.highlightVersion += 1;
    }
  }

  function openSearch(): void {
    const doc = store.activeDoc;
    if (!doc) {
      return;
    }
    doc.search.open = true;
    requestFocus("search_input");

    const runtime = getSearchRuntime(doc.documentId);
    if (
      doc.search.query.trim().length > 0 &&
      (doc.search.status !== "ready" ||
        doc.search.lastSearchedQuery !== doc.search.query) &&
      !runtime.inFlight
    ) {
      void executeSearch(doc.documentId, doc.search.query);
    }
  }

  function closeSearch(options: { focusViewport?: boolean } = {}): void {
    const doc = store.activeDoc;
    if (!doc) {
      return;
    }
    const runtime = getSearchRuntime(doc.documentId);
    clearSearchDebounce(runtime);
    clearSearchingDelay(runtime, doc);
    runtime.inFlight = false;
    runtime.activeSearchSignal = null;
    runtime.requestSeq += 1;

    scopes.cancelSearch(doc.documentId);
    doc.search.open = false;
    resetSearchMatches(doc);

    if (options.focusViewport !== false) {
      requestFocus("viewport");
    }
  }

  function toggleSearch(): void {
    const doc = store.activeDoc;
    if (!doc) {
      return;
    }
    if (doc.search.open) {
      closeSearch({ focusViewport: true });
    } else {
      openSearch();
    }
  }

  function setSearchQuery(query: string): void {
    const doc = store.activeDoc;
    if (!doc) {
      return;
    }
    const documentId = doc.documentId;
    const runtime = getSearchRuntime(documentId);
    clearSearchDebounce(runtime);
    doc.search.query = query;

    if (query.trim().length === 0) {
      runtime.requestSeq += 1;
      scopes.cancelSearch(documentId);
      clearSearchingDelay(runtime, doc);
      runtime.inFlight = false;
      runtime.activeSearchSignal = null;
      resetSearchMatches(doc);
      return;
    }

    runtime.debounceTimer = setTimeout(() => {
      runtime.debounceTimer = null;
      const currentDoc = store.docsById.get(documentId);
      if (currentDoc && scopes.isAlive(documentId) && currentDoc.search.open) {
        void executeSearch(documentId, currentDoc.search.query);
      }
    }, SEARCH_DEBOUNCE_MS);
  }

  function stepSearchMatch(delta: 1 | -1): void {
    const doc = store.activeDoc;
    if (!doc || !doc.search.open) {
      return;
    }
    const runtime = getSearchRuntime(doc.documentId);

    if (
      doc.search.query.trim().length > 0 &&
      (doc.search.status !== "ready" ||
        doc.search.lastSearchedQuery !== doc.search.query)
    ) {
      clearSearchDebounce(runtime);
      if (!runtime.inFlight) {
        void executeSearch(doc.documentId, doc.search.query);
      }
      return;
    }

    if (doc.search.matches.length === 0) {
      return;
    }

    doc.search.currentIndex = stepMatchIndex(
      doc.search.currentIndex,
      doc.search.matches.length,
      delta,
    );
    doc.search.highlightVersion += 1;
    doc.search.scrollToMatchSeq += 1;
  }

  async function removeRecent(path: string): Promise<void> {
    try {
      const updated = await api.removeRecentFile(path);
      store.recents = Array.isArray(updated.recent_files)
        ? updated.recent_files
        : [];
    } catch (err) {
      console.error("Failed to remove recent file:", err);
    }
  }

  function setRecentQuery(query: string): void {
    store.recentQuery = query;
    store.recentPage = 1;
  }

  function clearRecentSearch(): void {
    store.recentQuery = "";
    store.recentPage = 1;
  }

  function setRecentPage(page: number): void {
    if (store.totalRecentPages <= 0) {
      store.recentPage = 1;
      return;
    }
    store.recentPage = Math.max(1, Math.min(page, store.totalRecentPages));
  }

  function dismissBanner(): void {
    store.banner = null;
  }

  function triggerBannerAction(): void {
    const action = store.banner?.onAction;
    store.banner = null;
    action?.();
  }

  function setDraggingFiles(isDragging: boolean): void {
    store.isDraggingFiles = isDragging;
  }

  function setWindowMaximized(isMaximized: boolean): void {
    store.isWindowMaximized = isMaximized;
  }

  function navigateViewport(
    action: "page_down" | "page_up" | "home" | "end",
  ): void {
    if (!store.activeDoc) {
      return;
    }
    if (action === "page_down") {
      hooks.viewportCommands?.scrollPageStep?.(1);
    } else if (action === "page_up") {
      hooks.viewportCommands?.scrollPageStep?.(-1);
    } else if (action === "home") {
      hooks.viewportCommands?.scrollToStart?.();
    } else {
      hooks.viewportCommands?.scrollToEnd?.();
    }
  }

  function focusHomeRecentSearch(): void {
    requestFocus("recent_search");
  }

  async function flushActiveReadingState(): Promise<void> {
    const doc = store.activeDoc;
    if (doc) {
      const snapshot = hooks.captureViewportSnapshot?.(doc) ?? null;
      if (snapshot) {
        applySnapshotToDoc(doc, snapshot);
      }
      persistence.schedule({
        path: doc.canonicalPath,
        pageIndex: doc.view.pageIndex,
        zoomMode: doc.view.zoomMode,
        zoomScale: doc.view.zoomScale,
      });
    }
    await persistence.flushAll();
  }

  function dispose(): void {
    for (const documentId of Array.from(searchRuntimes.keys())) {
      clearSearchRuntime(documentId);
    }
    persistence.dispose();
    scopes.disposeAll();
  }

  return {
    bootstrap,
    refreshRecents,
    openPath,
    openPathBatch,
    openViaDialog,
    openHomeTab,
    selectTab,
    closeTab,
    reorderTab,
    moveTabBy,
    applyViewportSnapshot,
    requestZoomMode,
    requestZoomStep,
    requestJumpToPage,
    navigateViewport,
    focusHomeRecentSearch,
    toggleToc,
    closeToc,
    ensureOutlineLoaded,
    setTocNodeExpanded,
    selectTocNode,
    setTocScrollTop,
    openSearch,
    closeSearch,
    toggleSearch,
    setSearchQuery,
    stepSearchMatch,
    removeRecent,
    setRecentQuery,
    clearRecentSearch,
    setRecentPage,
    dismissBanner,
    triggerBannerAction,
    setDraggingFiles,
    setWindowMaximized,
    requestFocus,
    flushActiveReadingState,
    dispose,
  };
}
