import { SvelteMap, type SvelteSet } from "svelte/reactivity";
import type { OutlineModel } from "../domain/outline";
import {
  RECENTS_PAGE_SIZE,
  filterRecentFiles,
  getVisiblePageItems,
  type PageItem,
} from "../domain/recents";
import { groupMatchesByPage, type PageSearchEntry } from "../domain/search";
import { deriveTitle } from "../domain/title";
import type {
  OpenDocumentResponse,
  PageDimensions,
  RecentFile,
  SearchMatch,
  ZoomMode,
} from "../ipc/types";
import {
  HOME_TAB_ID,
  toDocumentTabId,
  type BannerState,
  type DocOutlineState,
  type DocSearchState,
  type DocState,
  type DocViewState,
  type FocusRequest,
  type HomeTabItem,
  type ScrollAnchor,
  type ShellMode,
  type TabItem,
  type ToolbarModel,
} from "./types";

class ReactiveHomeTab implements HomeTabItem {
  readonly kind = "home" as const;
  readonly tabId = HOME_TAB_ID;
  readonly title = "Home" as const;
  returnToTabId = $state<string | null>(null);

  constructor(returnToTabId: string | null) {
    this.returnToTabId = returnToTabId;
  }
}

class ReactiveDocView implements DocViewState {
  pageIndex = $state(0);
  scrollTop = $state<number | null>(null);
  scrollAnchor = $state.raw<ScrollAnchor | null>(null);
  zoomMode = $state<ZoomMode>("fit_width");
  zoomScale = $state(1.0);

  constructor(initial: DocViewState) {
    this.pageIndex = initial.pageIndex;
    this.scrollTop = initial.scrollTop;
    this.scrollAnchor = initial.scrollAnchor;
    this.zoomMode = initial.zoomMode;
    this.zoomScale = initial.zoomScale;
  }
}

class ReactiveDocOutline implements DocOutlineState {
  open = $state(false);
  status = $state<"idle" | "loading" | "loaded" | "error">("idle");
  model = $state.raw<OutlineModel | null>(null);
  error = $state<string | null>(null);
  expandedIds = $state.raw<SvelteSet<string> | null>(null);
  scrollTop = $state(0);
  selectedNodeId = $state<string | null>(null);
}

class ReactiveDocSearch implements DocSearchState {
  open = $state(false);
  query = $state("");
  lastSearchedQuery = $state("");
  status = $state<"idle" | "searching" | "ready" | "error">("idle");
  showSearchingLabel = $state(false);
  matches = $state.raw<SearchMatch[]>([]);
  matchesByPage = $state.raw<Map<number, PageSearchEntry[]>>(
    groupMatchesByPage([]),
  );
  currentIndex = $state(-1);
  errorMessage = $state<string | null>(null);
  highlightVersion = $state(0);
  scrollToMatchSeq = $state(0);
}

class ReactiveDocState implements DocState {
  readonly documentId: number;
  readonly canonicalPath: string;
  readonly title: string;
  readonly pageCount: number;
  readonly pageDimensions: readonly PageDimensions[];
  view: DocViewState;
  outline: DocOutlineState;
  search: DocSearchState;

  constructor(response: OpenDocumentResponse) {
    const saved = response.saved_position;
    const pageCount = response.page_dimensions.length;
    const initialPage =
      saved && Number.isInteger(saved.page_index)
        ? Math.max(0, Math.min(saved.page_index, Math.max(0, pageCount - 1)))
        : 0;
    const zoomMode: ZoomMode =
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

    this.documentId = response.document_id;
    this.canonicalPath = response.canonical_path;
    this.title = deriveTitle(response.canonical_path, response.metadata.title);
    this.pageCount = pageCount;
    this.pageDimensions = response.page_dimensions;
    this.view = new ReactiveDocView({
      pageIndex: initialPage,
      scrollTop: null,
      scrollAnchor: null,
      zoomMode,
      zoomScale,
    });
    this.outline = new ReactiveDocOutline();
    this.search = new ReactiveDocSearch();
  }
}

export interface AppStore {
  tabOrder: string[];
  readonly tabsById: SvelteMap<string, TabItem>;
  readonly docsById: SvelteMap<number, DocState>;
  activeTabId: string | null;
  recents: RecentFile[];
  recentQuery: string;
  recentPage: number;
  banner: BannerState | null;
  isDraggingFiles: boolean;
  isWindowMaximized: boolean;
  focusRequest: FocusRequest | null;
  readonly orderedTabs: TabItem[];
  readonly activeTab: TabItem | null;
  readonly activeDoc: DocState | null;
  readonly isHomeActive: boolean;
  readonly hasAnyTabs: boolean;
  readonly shellMode: ShellMode;
  readonly windowTitle: string;
  readonly toolbarModel: ToolbarModel | null;
  readonly filteredRecents: RecentFile[];
  readonly totalRecentPages: number;
  readonly clampedRecentPage: number;
  readonly pagedRecents: RecentFile[];
  readonly recentRangeLabel: string | null;
  readonly visibleRecentPageItems: PageItem[];
  createHomeTab(returnToTabId: string | null): HomeTabItem;
  createDocState(response: OpenDocumentResponse): DocState;
  getAdjacentTabId(delta: 1 | -1): string | null;
  getTabIdAtShortcutIndex(digit: number): string | null;
}

/**
 * Creates an isolated Svelte 5 Runes application store instance.
 * Exported as a factory so Vitest suites never leak state across tests.
 */
export function createAppStore(): AppStore {
  let tabOrder = $state<string[]>([]);
  const tabsById = new SvelteMap<string, TabItem>();
  const docsById = new SvelteMap<number, DocState>();
  let activeTabId = $state<string | null>(null);
  let recents = $state.raw<RecentFile[]>([]);
  let recentQuery = $state("");
  let recentPage = $state(1);
  let banner = $state.raw<BannerState | null>(null);
  let isDraggingFiles = $state(false);
  let isWindowMaximized = $state(false);
  let focusRequest = $state.raw<FocusRequest | null>(null);

  const orderedTabs = $derived.by(() => {
    const list: TabItem[] = [];
    for (const id of tabOrder) {
      const tab = tabsById.get(id);
      if (tab) {
        list.push(tab);
      }
    }
    return list;
  });

  const activeTab = $derived(
    activeTabId ? (tabsById.get(activeTabId) ?? null) : null,
  );

  const activeDoc = $derived(
    activeTab?.kind === "document"
      ? (docsById.get(activeTab.documentId) ?? null)
      : null,
  );

  const isHomeActive = $derived(activeTabId === HOME_TAB_ID);
  const hasAnyTabs = $derived(tabOrder.length > 0);
  const shellMode = $derived<ShellMode>(
    activeDoc ? "document" : isHomeActive ? "home_tab" : "empty",
  );
  const windowTitle = $derived(
    activeDoc
      ? `${activeDoc.title} — Reader`
      : isHomeActive
        ? "Home — Reader"
        : "Reader",
  );

  const toolbarModel = $derived<ToolbarModel | null>(
    activeDoc
      ? {
          pageIndex: activeDoc.view.pageIndex,
          pageCount: activeDoc.pageCount,
          zoomMode: activeDoc.view.zoomMode,
          zoomScale: activeDoc.view.zoomScale,
          tocOpen: activeDoc.outline.open,
          searchOpen: activeDoc.search.open,
        }
      : null,
  );

  const filteredRecents = $derived(filterRecentFiles(recents, recentQuery));
  const totalRecentPages = $derived(
    Math.ceil(filteredRecents.length / RECENTS_PAGE_SIZE),
  );
  const clampedRecentPage = $derived(
    totalRecentPages > 0
      ? Math.max(1, Math.min(recentPage, totalRecentPages))
      : 1,
  );
  const pagedRecents = $derived.by(() => {
    const startIndex = (clampedRecentPage - 1) * RECENTS_PAGE_SIZE;
    return filteredRecents.slice(startIndex, startIndex + RECENTS_PAGE_SIZE);
  });

  const recentRangeLabel = $derived.by<string | null>(() => {
    if (recents.length === 0) {
      return null;
    }
    if (filteredRecents.length === 0) {
      return "0 matches";
    }
    if (totalRecentPages > 1) {
      const start = (clampedRecentPage - 1) * RECENTS_PAGE_SIZE + 1;
      const end = Math.min(
        clampedRecentPage * RECENTS_PAGE_SIZE,
        filteredRecents.length,
      );
      return `${start}–${end} of ${filteredRecents.length}`;
    }
    if (recentQuery.trim().length > 0) {
      return filteredRecents.length === 1
        ? "1 match"
        : `${filteredRecents.length} matches`;
    }
    return null;
  });

  const visibleRecentPageItems = $derived(
    getVisiblePageItems(clampedRecentPage, totalRecentPages),
  );

  function getAdjacentTabId(delta: 1 | -1): string | null {
    if (tabOrder.length < 2) {
      return null;
    }
    const currentIndex = activeTabId ? tabOrder.indexOf(activeTabId) : -1;
    const startIndex = currentIndex === -1 ? 0 : currentIndex;
    const nextIndex = (startIndex + delta + tabOrder.length) % tabOrder.length;
    return tabOrder[nextIndex] ?? null;
  }

  function getTabIdAtShortcutIndex(digit: number): string | null {
    if (
      tabOrder.length === 0 ||
      !Number.isInteger(digit) ||
      digit < 1 ||
      digit > 9
    ) {
      return null;
    }
    if (digit === 9) {
      return tabOrder[tabOrder.length - 1] ?? null;
    }
    const targetIndex = digit - 1;
    if (targetIndex >= tabOrder.length) {
      return null;
    }
    return tabOrder[targetIndex] ?? null;
  }

  return {
    get tabOrder() {
      return tabOrder;
    },
    set tabOrder(value: string[]) {
      tabOrder = value;
    },
    tabsById,
    docsById,
    get activeTabId() {
      return activeTabId;
    },
    set activeTabId(value: string | null) {
      activeTabId = value;
    },
    get recents() {
      return recents;
    },
    set recents(value: RecentFile[]) {
      recents = value;
    },
    get recentQuery() {
      return recentQuery;
    },
    set recentQuery(value: string) {
      recentQuery = value;
    },
    get recentPage() {
      return recentPage;
    },
    set recentPage(value: number) {
      recentPage = value;
    },
    get banner() {
      return banner;
    },
    set banner(value: BannerState | null) {
      banner = value;
    },
    get isDraggingFiles() {
      return isDraggingFiles;
    },
    set isDraggingFiles(value: boolean) {
      isDraggingFiles = value;
    },
    get isWindowMaximized() {
      return isWindowMaximized;
    },
    set isWindowMaximized(value: boolean) {
      isWindowMaximized = value;
    },
    get focusRequest() {
      return focusRequest;
    },
    set focusRequest(value: FocusRequest | null) {
      focusRequest = value;
    },
    get orderedTabs() {
      return orderedTabs;
    },
    get activeTab() {
      return activeTab;
    },
    get activeDoc() {
      return activeDoc;
    },
    get isHomeActive() {
      return isHomeActive;
    },
    get hasAnyTabs() {
      return hasAnyTabs;
    },
    get shellMode() {
      return shellMode;
    },
    get windowTitle() {
      return windowTitle;
    },
    get toolbarModel() {
      return toolbarModel;
    },
    get filteredRecents() {
      return filteredRecents;
    },
    get totalRecentPages() {
      return totalRecentPages;
    },
    get clampedRecentPage() {
      return clampedRecentPage;
    },
    get pagedRecents() {
      return pagedRecents;
    },
    get recentRangeLabel() {
      return recentRangeLabel;
    },
    get visibleRecentPageItems() {
      return visibleRecentPageItems;
    },
    createHomeTab(returnToTabId: string | null): HomeTabItem {
      return new ReactiveHomeTab(returnToTabId);
    },
    createDocState(response: OpenDocumentResponse): DocState {
      return new ReactiveDocState(response);
    },
    getAdjacentTabId,
    getTabIdAtShortcutIndex,
  };
}

export { toDocumentTabId };
