import type { SvelteSet } from "svelte/reactivity";
import type { OutlineModel } from "../domain/outline";
import type { PageSearchEntry } from "../domain/search";
import type { PageDimensions, SearchMatch, ZoomMode } from "../ipc/types";

export const HOME_TAB_ID = "home" as const;

export function toDocumentTabId(documentId: number): string {
  return `doc-${documentId}`;
}

export interface HomeTabItem {
  readonly kind: "home";
  readonly tabId: typeof HOME_TAB_ID;
  readonly title: "Home";
  returnToTabId: string | null;
}

export interface DocumentTabItem {
  readonly kind: "document";
  readonly tabId: string;
  readonly documentId: number;
  readonly title: string;
  readonly canonicalPath: string;
}

export type TabItem = HomeTabItem | DocumentTabItem;

export interface ScrollAnchor {
  readonly pageIndex: number;
  readonly topOffsetRatio: number;
}

export interface DocViewState {
  pageIndex: number;
  scrollTop: number | null;
  scrollAnchor: ScrollAnchor | null;
  zoomMode: ZoomMode;
  zoomScale: number;
}

export interface DocOutlineState {
  open: boolean;
  status: "idle" | "loading" | "loaded" | "error";
  model: OutlineModel | null;
  error: string | null;
  expandedIds: SvelteSet<string> | null;
  scrollTop: number;
  selectedNodeId: string | null;
}

export interface DocSearchState {
  open: boolean;
  query: string;
  lastSearchedQuery: string;
  status: "idle" | "searching" | "ready" | "error";
  showSearchingLabel: boolean;
  matches: SearchMatch[];
  matchesByPage: Map<number, PageSearchEntry[]>;
  currentIndex: number;
  errorMessage: string | null;
  /** Monotonic counter incremented when highlight overlays must repaint. */
  highlightVersion: number;
  /** Monotonic counter incremented when viewport should scroll to the active match. */
  scrollToMatchSeq: number;
}

export interface DocState {
  readonly documentId: number;
  readonly canonicalPath: string;
  readonly title: string;
  readonly pageCount: number;
  readonly pageDimensions: readonly PageDimensions[];
  view: DocViewState;
  outline: DocOutlineState;
  search: DocSearchState;
}

export interface BannerState {
  readonly scope: "home" | "workspace";
  readonly message: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}

export type ShellMode = "empty" | "home_tab" | "document";

export interface ToolbarModel {
  readonly pageIndex: number;
  readonly pageCount: number;
  readonly zoomMode: ZoomMode;
  readonly zoomScale: number;
  readonly tocOpen: boolean;
  readonly searchOpen: boolean;
}

export type FocusTarget =
  "viewport" | "home_open" | "search_input" | "page_input" | "recent_search";

export interface FocusRequest {
  readonly target: FocusTarget;
  readonly seq: number;
}

export interface ViewportSnapshot {
  readonly documentId: number;
  readonly pageIndex: number;
  readonly scrollTop: number | null;
  readonly scrollAnchor: ScrollAnchor | null;
  readonly zoomMode: ZoomMode;
  readonly zoomScale: number;
}

export interface ViewportCommandBridge {
  setZoomMode?(mode: "fit_width" | "fit_page"): void;
  setCustomZoom?(scale: number): void;
  scrollToPage?(pageIndex: number): void;
  scrollPageStep?(direction: 1 | -1): void;
  scrollToStart?(): void;
  scrollToEnd?(): void;
}

export interface TransitionHooks {
  cancelPageInput?: () => void;
  captureTocScroll?: (doc: DocState) => void;
  isFocusInToc?: () => boolean;
  captureViewportSnapshot?: (doc: DocState) => ViewportSnapshot | null;
  onDocumentClosed?: (documentId: number) => void;
  viewportCommands?: ViewportCommandBridge;
}
