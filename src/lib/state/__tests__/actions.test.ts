import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaderApi, SaveReadingStateParams } from "../../ipc/client";
import { ReaderApiError } from "../../ipc/errors";
import type {
  OpenDocumentResponse,
  OutlineItem,
  PersistedState,
  RecentFile,
  SearchMatch,
} from "../../ipc/types";
import { createAppActions } from "../actions";
import { createAppStore } from "../app-store.svelte";
import { createDocumentScopeRegistry } from "../doc-scope";
import { createPersistenceQueue } from "../persistence";
import { HOME_TAB_ID, toDocumentTabId, type TransitionHooks } from "../types";
import { observeReactiveEffect } from "./runes-test-utils.svelte";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeOpenResponse(
  documentId: number,
  path: string,
  overrides: Partial<OpenDocumentResponse> = {},
): OpenDocumentResponse {
  return {
    document_id: documentId,
    canonical_path: path,
    metadata: {
      title: `Doc ${documentId}`,
      author: null,
      page_count: 10,
    },
    page_dimensions: Array.from({ length: 10 }, () => ({
      width_pt: 612,
      height_pt: 792,
    })),
    saved_position: null,
    already_open: false,
    ...overrides,
  };
}

function makeRecents(count: number): RecentFile[] {
  return Array.from({ length: count }, (_, idx) => ({
    path: `/virtual/recent-${idx + 1}.pdf`,
    title: `Recent ${idx + 1}`,
    last_opened_unix: 1000 - idx,
    last_page: idx,
    page_count: 20,
  }));
}

function createFakeApi(overrides: Partial<ReaderApi> = {}) {
  const savedCalls: SaveReadingStateParams[] = [];
  const closedDocIds: number[] = [];
  const persisted: PersistedState = {
    version: 1,
    recent_files: makeRecents(2),
    positions: {},
  };

  const api: ReaderApi = {
    getInitialFile: async () => null,
    getPersistedState: async () => persisted,
    openDocument: async (path) => makeOpenResponse(1, path),
    closeDocument: async (documentId) => {
      closedDocIds.push(documentId);
    },
    renderPage: async () => {
      throw new ReaderApiError("internal", "Not implemented in state tests");
    },
    getOutline: async () => [],
    getPageText: async () => [],
    getPageLinks: async () => [],
    openExternalUrl: async () => {},
    searchDocument: async () => [],
    saveReadingState: async (params) => {
      savedCalls.push(params);
    },
    removeRecentFile: async (path) => ({
      ...persisted,
      recent_files: persisted.recent_files.filter((item) => item.path !== path),
    }),
    getRecentCover: async () => {
      throw new ReaderApiError("internal", "Not implemented in state tests");
    },
    pickPdfFiles: async () => [],
    subscribeDragDrop: async () => () => {},
    getWindowControls: () => ({
      minimize: async () => {},
      toggleMaximize: async () => {},
      close: async () => {},
      isMaximized: async () => false,
      onResized: async () => () => {},
    }),
    ...overrides,
  };

  return { api, savedCalls, closedDocIds, persisted };
}

function createHarness(
  apiOverrides: Partial<ReaderApi> = {},
  hooks: TransitionHooks = {},
) {
  const store = createAppStore();
  const scopes = createDocumentScopeRegistry();
  const { api, savedCalls, closedDocIds, persisted } =
    createFakeApi(apiOverrides);
  const persistence = createPersistenceQueue(api);
  const actions = createAppActions({ store, api, scopes, persistence, hooks });
  return {
    store,
    scopes,
    persistence,
    actions,
    api,
    savedCalls,
    closedDocIds,
    persisted,
  };
}

describe("Runes AppStore + AppActions", () => {
  let cleanups: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    cleanups = [];
  });

  afterEach(() => {
    for (const fn of cleanups.splice(0)) {
      fn();
    }
    vi.useRealTimers();
  });

  it("bootstraps recents + initial file and reacts via Svelte 5 runes", async () => {
    const { store, actions } = createHarness({
      getInitialFile: async () => "/virtual/startup.pdf",
      openDocument: async (path) => makeOpenResponse(7, path),
    });
    cleanups.push(() => actions.dispose());

    const observedTitles: string[] = [];
    const disposeEffect = observeReactiveEffect(() => {
      observedTitles.push(store.windowTitle);
    });
    cleanups.push(disposeEffect);

    await actions.bootstrap();
    flushSync();

    expect(store.shellMode).toBe("document");
    expect(store.activeDoc?.documentId).toBe(7);
    expect(store.windowTitle).toBe("Doc 7 — Reader");
    expect(observedTitles).toEqual(["Reader", "Doc 7 — Reader"]);
    expect(store.recents).toHaveLength(2);
  });

  it("handles already_open deduplication and preserves batch errors on workspace transition", async () => {
    const { store, actions } = createHarness({
      openDocument: async (path) => {
        if (path.endsWith("bad.pdf")) {
          throw new ReaderApiError("invalid_document", "corrupt");
        }
        if (path.endsWith("a-dup.pdf")) {
          return makeOpenResponse(1, "/virtual/a.pdf", { already_open: true });
        }
        return makeOpenResponse(1, path);
      },
    });
    cleanups.push(() => actions.dispose());

    await actions.openPathBatch([
      "/virtual/bad.pdf",
      "/virtual/a.pdf",
      "/virtual/a-dup.pdf",
    ]);

    expect(store.orderedTabs).toHaveLength(1);
    expect(store.activeTabId).toBe("doc-1");
    expect(store.banner).toEqual({
      scope: "workspace",
      message:
        "Could not open this PDF. The file appears damaged or incomplete.",
    });

    actions.dismissBanner();
    expect(store.banner).toBeNull();
  });

  it("implements CR-001 singleton Home tab, in-place replacement, returnToTabId, and auto-pruning", async () => {
    let nextId = 1;
    const { store, actions } = createHarness({
      openDocument: async (path) => {
        if (path === "/virtual/doc-1.pdf") {
          return makeOpenResponse(1, path);
        }
        return makeOpenResponse(nextId === 1 ? (nextId = 2) : ++nextId, path);
      },
    });
    cleanups.push(() => actions.dispose());

    await actions.openPath("/virtual/doc-1.pdf");
    await actions.openHomeTab();

    expect(store.tabOrder).toEqual(["doc-1", HOME_TAB_ID]);
    expect(store.isHomeActive).toBe(true);
    expect(store.windowTitle).toBe("Home — Reader");

    // Duplicate openHomeTab does not create a second Home tab.
    await actions.openHomeTab();
    expect(store.tabOrder).toEqual(["doc-1", HOME_TAB_ID]);

    // Closing Home restores returnToTabId ("doc-1").
    await actions.closeTab(HOME_TAB_ID);
    expect(store.tabOrder).toEqual(["doc-1"]);
    expect(store.activeTabId).toBe("doc-1");

    // Opening a new document while on Home replaces the Home tab in place.
    await actions.openHomeTab();
    await actions.openPath("/virtual/doc-2.pdf");
    expect(store.tabOrder).toEqual(["doc-1", "doc-2"]);
    expect(store.activeTabId).toBe("doc-2");

    // Focusing an already-open document while on Home removes the Home tab.
    await actions.openHomeTab();
    await actions.openPath("/virtual/doc-1.pdf");
    expect(store.tabOrder).toEqual(["doc-1", "doc-2"]);
    expect(store.activeTabId).toBe("doc-1");

    // Auto-prunes singleton Home tab when closing the last open document tab.
    await actions.closeTab("doc-2");
    await actions.openHomeTab();
    expect(store.tabOrder).toEqual(["doc-1", HOME_TAB_ID]);

    await actions.closeTab("doc-1");
    expect(store.tabOrder).toEqual([]);
    expect(store.activeTabId).toBeNull();
    expect(store.shellMode).toBe("empty");
  });

  it("supports CR-003 reorderTab/moveTabBy and updates adjacent & shortcut tab selectors", async () => {
    let seq = 0;
    const { store, actions } = createHarness({
      openDocument: async (path) => makeOpenResponse(++seq, path),
    });
    cleanups.push(() => actions.dispose());

    await actions.openPath("/virtual/1.pdf");
    await actions.openPath("/virtual/2.pdf");
    await actions.openPath("/virtual/3.pdf");

    expect(store.tabOrder).toEqual(["doc-1", "doc-2", "doc-3"]);
    expect(store.getTabIdAtShortcutIndex(1)).toBe("doc-1");
    expect(store.getTabIdAtShortcutIndex(9)).toBe("doc-3");

    expect(actions.reorderTab(2, 0)).toBe(true);
    expect(store.tabOrder).toEqual(["doc-3", "doc-1", "doc-2"]);
    expect(store.activeTabId).toBe("doc-3");
    expect(store.getAdjacentTabId(1)).toBe("doc-1");
    expect(store.getAdjacentTabId(-1)).toBe("doc-2");

    expect(actions.moveTabBy("doc-3", 1)).toBe(true);
    expect(store.tabOrder).toEqual(["doc-1", "doc-3", "doc-2"]);
    expect(store.getTabIdAtShortcutIndex(2)).toBe("doc-3");
  });

  it("maintains CR-004 & CR-006 recents pagination/search derived state and removes missing recents", async () => {
    const recents25 = makeRecents(25);
    const { store, actions } = createHarness({
      getPersistedState: async () => ({
        version: 1,
        recent_files: recents25,
        positions: {},
      }),
      openDocument: async () => {
        throw new ReaderApiError("io", "Missing");
      },
      removeRecentFile: async (path) => ({
        version: 1,
        recent_files: recents25.filter((item) => item.path !== path),
        positions: {},
      }),
    });
    cleanups.push(() => actions.dispose());

    await actions.bootstrap();
    expect(store.totalRecentPages).toBe(3);
    expect(store.recentRangeLabel).toBe("1–10 of 25");

    actions.setRecentPage(2);
    expect(store.pagedRecents).toHaveLength(10);
    expect(store.recentRangeLabel).toBe("11–20 of 25");

    actions.setRecentQuery("Recent 2");
    expect(store.clampedRecentPage).toBe(1);
    expect(store.filteredRecents.length).toBe(8); // tokens ["recent", "2"] match 2, 12, 20..25
    expect(store.recentRangeLabel).toBe("8 matches");

    actions.clearRecentSearch();
    expect(store.recentQuery).toBe("");

    await actions.openPath("/virtual/recent-1.pdf", { fromRecent: true });
    expect(store.banner).toMatchObject({
      scope: "home",
      message: "File not found — it may have been moved or deleted.",
      actionLabel: "Remove from recent",
    });

    actions.triggerBannerAction();
    await vi.waitFor(() => {
      expect(store.recents).toHaveLength(24);
    });
    expect(store.banner).toBeNull();
  });

  it("Fix 2: never calls saveReadingState on mount snapshot or unchanged tab switch", async () => {
    let seq = 0;
    const { actions, savedCalls } = createHarness({
      openDocument: async (path) => makeOpenResponse(++seq, path),
    });
    cleanups.push(() => actions.dispose());

    await actions.openPath("/virtual/a.pdf");
    await actions.openPath("/virtual/b.pdf");

    // Mount sync updates view without scheduling persistence.
    actions.applyViewportSnapshot(
      2,
      {
        documentId: 2,
        pageIndex: 0,
        scrollTop: 0,
        scrollAnchor: { pageIndex: 0, topOffsetRatio: 0 },
        zoomMode: "fit_width",
        zoomScale: 1.25,
      },
      "mount",
    );

    await actions.selectTab("doc-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(savedCalls).toHaveLength(0);

    // User scroll triggers debounced save.
    actions.applyViewportSnapshot(
      1,
      {
        documentId: 1,
        pageIndex: 4,
        scrollTop: 500,
        scrollAnchor: { pageIndex: 4, topOffsetRatio: 0.25 },
        zoomMode: "custom",
        zoomScale: 1.5,
      },
      "user",
    );

    await vi.advanceTimersByTimeAsync(400);
    expect(savedCalls).toEqual([
      {
        path: "/virtual/a.pdf",
        pageIndex: 4,
        zoomMode: "custom",
        zoomScale: 1.5,
      },
    ]);
  });

  it("Fix 4 (TOC): ignores late getOutline responses after tab is closed and isolates expandedIds", async () => {
    const outlineDeferred = createDeferred<OutlineItem[]>();
    const { store, actions } = createHarness({
      openDocument: async (path) => makeOpenResponse(10, path),
      getOutline: () => outlineDeferred.promise,
    });
    cleanups.push(() => actions.dispose());

    await actions.openPath("/virtual/toc.pdf");
    actions.toggleToc();
    expect(store.activeDoc?.outline.status).toBe("loading");

    // Close tab before outline IPC resolves.
    await actions.closeTab(toDocumentTabId(10));
    expect(store.docsById.has(10)).toBe(false);

    // Late resolution must not throw or resurrect document state.
    outlineDeferred.resolve([
      { title: "Late Chapter", page_index: 0, children: [] },
    ]);
    await Promise.resolve();
    expect(store.docsById.has(10)).toBe(false);
  });

  it("Fix 4 (Search): debounces 200ms, delays Searching label 120ms, cycles matches, and aborts on close", async () => {
    const searchDeferred = createDeferred<SearchMatch[]>();
    const { store, actions } = createHarness({
      openDocument: async (path) => makeOpenResponse(20, path),
      searchDocument: () => searchDeferred.promise,
    });
    cleanups.push(() => actions.dispose());

    await actions.openPath("/virtual/search.pdf");
    actions.openSearch();
    actions.setSearchQuery("vector");

    // Before 200ms debounce, search has not fired yet.
    expect(store.activeDoc?.search.status).toBe("idle");
    await vi.advanceTimersByTimeAsync(200);
    expect(store.activeDoc?.search.status).toBe("searching");
    expect(store.activeDoc?.search.showSearchingLabel).toBe(false);

    // After 120ms in-flight delay, showSearchingLabel flips true.
    await vi.advanceTimersByTimeAsync(120);
    expect(store.activeDoc?.search.showSearchingLabel).toBe(true);

    searchDeferred.resolve([
      { page_index: 2, rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }] },
      { page_index: 5, rects: [{ x: 0.3, y: 0.4, width: 0.2, height: 0.02 }] },
    ]);
    await vi.waitFor(() => {
      expect(store.activeDoc?.search.status).toBe("ready");
    });

    expect(store.activeDoc?.search.currentIndex).toBe(0);
    expect(store.activeDoc?.search.showSearchingLabel).toBe(false);
    const prevScrollSeq = store.activeDoc?.search.scrollToMatchSeq ?? 0;

    actions.stepSearchMatch(1);
    expect(store.activeDoc?.search.currentIndex).toBe(1);
    expect(store.activeDoc?.search.scrollToMatchSeq).toBe(prevScrollSeq + 1);

    actions.stepSearchMatch(1);
    expect(store.activeDoc?.search.currentIndex).toBe(0);

    // Aborts in-flight search cleanly when closing tab.
    const lateSearch = createDeferred<SearchMatch[]>();
    const { store: s2, actions: a2 } = createHarness({
      openDocument: async (path) => makeOpenResponse(21, path),
      searchDocument: () => lateSearch.promise,
    });
    cleanups.push(() => a2.dispose());

    await a2.openPath("/virtual/search-close.pdf");
    a2.openSearch();
    a2.setSearchQuery("alpha");
    await vi.advanceTimersByTimeAsync(200);
    await a2.closeTab("doc-21");

    lateSearch.resolve([
      { page_index: 0, rects: [{ x: 0, y: 0, width: 0.1, height: 0.02 }] },
    ]);
    await Promise.resolve();
    expect(s2.docsById.has(21)).toBe(false);
  });

  it("invokes transition hooks, flushes active reading state, and tracks reactive toolbarModel + TOC expandedIds", async () => {
    const cancelledInputs: number[] = [];
    const capturedTocDocs: number[] = [];
    const closedNotifications: number[] = [];
    let currentViewPage = 0;

    const { store, actions, savedCalls, closedDocIds } = createHarness(
      {
        openDocument: async (path) => makeOpenResponse(30, path),
        getOutline: async () => [
          {
            title: "Part I",
            page_index: 0,
            children: [
              { title: "Chapter 1", page_index: 2, children: [] },
              { title: "Chapter 2", page_index: 6, children: [] },
            ],
          },
        ],
      },
      {
        cancelPageInput: () => cancelledInputs.push(1),
        captureTocScroll: (doc) => {
          doc.outline.scrollTop = 120;
          capturedTocDocs.push(doc.documentId);
        },
        captureViewportSnapshot: (doc) => ({
          documentId: doc.documentId,
          pageIndex: currentViewPage,
          scrollTop: currentViewPage * 400,
          scrollAnchor: { pageIndex: currentViewPage, topOffsetRatio: 0.1 },
          zoomMode: "fit_width",
          zoomScale: 1.0,
        }),
        onDocumentClosed: (docId) => closedNotifications.push(docId),
      },
    );
    cleanups.push(() => actions.dispose());

    const observedToolbarStates: string[] = [];
    const observedExpandedSizes: number[] = [];
    const disposeEffect = observeReactiveEffect(
      () => {
        if (store.toolbarModel) {
          observedToolbarStates.push(
            `${store.toolbarModel.pageIndex}:${String(store.toolbarModel.tocOpen)}`,
          );
        }
      },
      () => {
        if (store.activeDoc?.outline.expandedIds) {
          observedExpandedSizes.push(store.activeDoc.outline.expandedIds.size);
        }
      },
    );
    cleanups.push(disposeEffect);

    await actions.openPath("/virtual/hooks.pdf");
    flushSync();

    actions.toggleToc();
    await vi.waitFor(() => {
      expect(store.activeDoc?.outline.status).toBe("loaded");
    });
    flushSync();

    expect(store.activeDoc?.outline.expandedIds?.has("0")).toBe(true);
    actions.setTocNodeExpanded(30, "0", false);
    flushSync();
    expect(observedExpandedSizes).toEqual([1, 0]);

    actions.requestJumpToPage(5);
    flushSync();
    expect(observedToolbarStates).toEqual(["0:false", "0:true", "5:true"]);

    currentViewPage = 7;
    await actions.flushActiveReadingState();
    expect(savedCalls).toContainEqual({
      path: "/virtual/hooks.pdf",
      pageIndex: 7,
      zoomMode: "fit_width",
      zoomScale: 1.0,
    });

    await actions.closeTab("doc-30");
    expect(cancelledInputs).toEqual([1]);
    expect(capturedTocDocs).toEqual([30]);
    expect(closedNotifications).toEqual([30]);
    expect(closedDocIds).toEqual([30]);
  });

  it("Phase 4: restores viewport focus when closing focused TOC, retries failed outlines, and isolates per-tab search", async () => {
    let outlineAttempt = 0;
    let focusInToc = true;
    let capturedScroll = false;

    const { store, actions } = createHarness(
      {
        openDocument: async (path) =>
          makeOpenResponse(path.endsWith("one.pdf") ? 41 : 42, path),
        getOutline: async () => {
          outlineAttempt += 1;
          if (outlineAttempt === 1) {
            throw new ReaderApiError("internal", "Outline unavailable");
          }
          return [{ title: "Recovered Chapter", page_index: 1, children: [] }];
        },
        searchDocument: async (docId, query) => [
          {
            page_index: docId === 41 ? 0 : 3,
            rects: [
              { x: 0.1, y: query.length * 0.01, width: 0.2, height: 0.02 },
            ],
          },
        ],
      },
      {
        isFocusInToc: () => focusInToc,
        captureTocScroll: (doc) => {
          doc.outline.scrollTop = 64;
          capturedScroll = true;
        },
      },
    );
    cleanups.push(() => actions.dispose());

    await actions.openPath("/virtual/one.pdf");
    actions.toggleToc();
    await vi.waitFor(() => {
      expect(store.activeDoc?.outline.status).toBe("error");
    });

    await actions.ensureOutlineLoaded(41, { force: true });
    expect(store.activeDoc?.outline.status).toBe("loaded");
    expect(store.activeDoc?.outline.model?.roots[0]?.title).toBe(
      "Recovered Chapter",
    );

    const prevFocusSeq = store.focusRequest?.seq ?? 0;
    actions.closeToc();
    expect(capturedScroll).toBe(true);
    expect(store.activeDoc?.outline.open).toBe(false);
    expect(store.focusRequest?.target).toBe("viewport");
    expect((store.focusRequest?.seq ?? 0) > prevFocusSeq).toBe(true);

    focusInToc = false;
    actions.openSearch();
    actions.setSearchQuery("alpha");
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => {
      expect(store.activeDoc?.search.status).toBe("ready");
    });

    await actions.openPath("/virtual/two.pdf");
    expect(store.activeDoc?.documentId).toBe(42);
    expect(store.activeDoc?.search.open).toBe(false);
    expect(store.activeDoc?.search.query).toBe("");
    expect(store.activeDoc?.search.matches).toEqual([]);

    await actions.selectTab("doc-41");
    expect(store.activeDoc?.search.open).toBe(true);
    expect(store.activeDoc?.search.query).toBe("alpha");
    expect(store.activeDoc?.search.matches).toHaveLength(1);
  });

  it("notifies onRecentCoverInvalidated when opening or removing recent files", async () => {
    const invalidated: string[] = [];
    const { actions } = createHarness(
      {
        openDocument: async () => makeOpenResponse(7, "/canonical/doc.pdf"),
      },
      {
        onRecentCoverInvalidated: (path) => {
          invalidated.push(path);
        },
      },
    );
    cleanups.push(() => actions.dispose());

    await actions.openPath("/raw/doc.pdf");
    await actions.removeRecent("/canonical/doc.pdf");

    expect(invalidated).toEqual([
      "/canonical/doc.pdf",
      "/raw/doc.pdf",
      "/canonical/doc.pdf",
    ]);
  });

  it("supports CR-009 internal link jumps, TOC/page jumps, per-tab Back/Forward history, and external URI errors", async () => {
    let seq = 0;
    let viewPage = 1;
    let viewScrollTop = 420;
    const scrolledPages: number[] = [];
    const scrolledTargets: Array<{ pageIndex: number }> = [];
    const scrolledAnchors: Array<{ pageIndex: number }> = [];
    const openedUrls: string[] = [];
    let pendingExternal = createDeferred<void>();
    let failExternal = false;

    const { store, actions } = createHarness(
      {
        openDocument: async (path) => makeOpenResponse(++seq, path),
        openExternalUrl: async (url) => {
          openedUrls.push(url);
          if (failExternal) {
            return pendingExternal.promise;
          }
        },
      },
      {
        captureViewportSnapshot: (doc) => ({
          documentId: doc.documentId,
          pageIndex: viewPage,
          scrollTop: viewScrollTop,
          scrollAnchor: { pageIndex: viewPage, topOffsetRatio: 0.25 },
          zoomMode: "fit_width",
          zoomScale: 1.0,
        }),
        viewportCommands: {
          scrollToPage: (pageIndex) => {
            scrolledPages.push(pageIndex);
            viewPage = pageIndex;
            viewScrollTop = pageIndex * 400;
          },
          scrollToTarget: (target) => {
            scrolledTargets.push({ pageIndex: target.pageIndex });
            viewPage = target.pageIndex;
            viewScrollTop = target.pageIndex * 400;
          },
          scrollToAnchor: (target) => {
            scrolledAnchors.push({ pageIndex: target.pageIndex });
            viewPage = target.pageIndex;
            viewScrollTop = target.pageIndex * 400;
          },
        },
      },
    );
    cleanups.push(() => actions.dispose());

    await actions.openPath("/virtual/links-a.pdf");
    expect(store.toolbarModel?.canGoBack).toBe(false);
    expect(store.toolbarModel?.canGoForward).toBe(false);

    // Internal link jump records origin on Back stack and calls scrollToTarget.
    await actions.activatePageLink(1, {
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
      target: {
        kind: "internal",
        page_index: 5,
        target_point: { x: 0.25, y: 0.5 },
        target_rect: null,
      },
    });

    expect(scrolledTargets).toEqual([{ pageIndex: 5 }]);
    expect(store.toolbarModel?.canGoBack).toBe(true);
    expect(store.toolbarModel?.canGoForward).toBe(false);

    // Toolbar page jump records intermediate position before jumping.
    actions.requestJumpToPage(7);
    expect(scrolledPages).toEqual([7]);
    expect(store.toolbarModel?.canGoBack).toBe(true);

    // Back twice returns to page 5 then page 1, enabling Forward.
    actions.navigateHistory(-1);
    expect(scrolledAnchors.at(-1)).toEqual({ pageIndex: 5 });
    expect(store.toolbarModel?.canGoBack).toBe(true);
    expect(store.toolbarModel?.canGoForward).toBe(true);

    actions.navigateHistory(-1);
    expect(scrolledAnchors.at(-1)).toEqual({ pageIndex: 1 });
    expect(store.toolbarModel?.canGoBack).toBe(false);
    expect(store.toolbarModel?.canGoForward).toBe(true);

    // Forward steps to page 5.
    actions.navigateHistory(1);
    expect(scrolledAnchors.at(-1)).toEqual({ pageIndex: 5 });
    expect(store.toolbarModel?.canGoForward).toBe(true);

    // Switching to another tab isolates per-tab Back/Forward stacks.
    await actions.openPath("/virtual/links-b.pdf");
    expect(store.toolbarModel?.canGoBack).toBe(false);
    expect(store.toolbarModel?.canGoForward).toBe(false);

    await actions.selectTab("doc-1");
    expect(store.toolbarModel?.canGoBack).toBe(true);
    expect(store.toolbarModel?.canGoForward).toBe(true);

    // External link opens directly on success.
    await actions.activatePageLink(1, {
      rects: [{ x: 0.1, y: 0.4, width: 0.3, height: 0.04 }],
      target: {
        kind: "external",
        uri: "https://example.com/docs",
      },
    });
    expect(openedUrls).toEqual(["https://example.com/docs"]);
    expect(store.banner).toBeNull();

    // External link rejection surfaces user-facing workspace banner.
    failExternal = true;
    const rejectedLink = actions.activatePageLink(1, {
      rects: [{ x: 0.1, y: 0.6, width: 0.3, height: 0.04 }],
      target: {
        kind: "external",
        uri: "https://bad.example/file",
      },
    });
    pendingExternal.reject(new ReaderApiError("unsupported_uri", "bad"));
    await rejectedLink;

    expect(store.banner).toEqual({
      scope: "workspace",
      message:
        "Cannot open this link. Only http, https, and mailto links are supported.",
    });
    actions.dismissBanner();

    // Closing the tab while external open is in-flight ignores late rejection.
    pendingExternal = createDeferred<void>();
    const inflightExternal = actions.activatePageLink(1, {
      rects: [{ x: 0.1, y: 0.7, width: 0.3, height: 0.04 }],
      target: {
        kind: "external",
        uri: "https://example.com/slow",
      },
    });
    await actions.closeTab("doc-1");
    pendingExternal.reject(new ReaderApiError("io", "failed"));
    await inflightExternal;
    expect(store.banner).toBeNull();
  });
});
