import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { decodeRenderFrame } from "./binary";
import { normalizeApiError } from "./errors";
import type {
  HighlightColor,
  HighlightRecord,
  HighlightSegment,
  OpenDocumentResponse,
  OutlineItem,
  PageLink,
  PersistedState,
  SearchMatch,
  TextSpan,
  ZoomMode,
} from "./types";

export interface RenderPageParams {
  readonly documentId: number;
  readonly pageIndex: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly epoch: number;
}

export interface SaveReadingStateParams {
  readonly path: string;
  readonly pageIndex: number;
  readonly zoomMode: ZoomMode;
  readonly zoomScale: number;
}

export interface CreateHighlightParams {
  readonly fingerprint: string;
  readonly lastKnownPath?: string | null;
  readonly id: string;
  readonly color: HighlightColor;
  readonly segments: readonly HighlightSegment[];
  readonly quote: string;
}

export interface DragDropHandlers {
  readonly onEnter?: (paths: string[]) => void;
  readonly onDrop?: (paths: string[]) => void;
  readonly onLeave?: () => void;
}

export interface WindowControlsApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
}

/**
 * Injectable transport boundary wrapping all Rust IPC commands and Tauri window/dialog APIs.
 */
export interface ReaderApi {
  getInitialFile(): Promise<string | null>;
  getPersistedState(): Promise<PersistedState>;
  openDocument(path: string): Promise<OpenDocumentResponse>;
  closeDocument(documentId: number): Promise<void>;
  renderPage(params: RenderPageParams): Promise<ImageData>;
  getOutline(documentId: number): Promise<OutlineItem[]>;
  getPageText(documentId: number, pageIndex: number): Promise<TextSpan[]>;
  getPageLinks(documentId: number, pageIndex: number): Promise<PageLink[]>;
  searchDocument(documentId: number, query: string): Promise<SearchMatch[]>;
  saveReadingState(params: SaveReadingStateParams): Promise<void>;
  removeRecentFile(path: string): Promise<PersistedState>;
  getRecentCover(path: string, maxSidePx?: number): Promise<ImageData>;
  openExternalUrl(url: string): Promise<void>;
  getHighlights(fingerprint: string): Promise<HighlightRecord[]>;
  createHighlight(params: CreateHighlightParams): Promise<HighlightRecord>;
  updateHighlightColor(
    fingerprint: string,
    id: string,
    color: HighlightColor,
  ): Promise<HighlightRecord>;
  deleteHighlight(fingerprint: string, id: string): Promise<boolean>;
  pickPdfFiles(): Promise<string[]>;
  subscribeDragDrop(handlers: DragDropHandlers): Promise<() => void>;
  getWindowControls(): WindowControlsApi;
}

function hasTauriInternals(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invokeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw normalizeApiError(err);
  }
}

function createNoopWindowControls(): WindowControlsApi {
  return {
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    isMaximized: async () => false,
    onResized: async () => () => {},
  };
}

/**
 * Creates the production Tauri v2 {@link ReaderApi} client (`withGlobalTauri: false` compatible).
 */
export function createTauriReaderApi(): ReaderApi {
  return {
    getInitialFile: () => invokeCommand<string | null>("get_initial_file"),

    getPersistedState: () =>
      invokeCommand<PersistedState>("get_persisted_state"),

    openDocument: (path: string) =>
      invokeCommand<OpenDocumentResponse>("open_document", { path }),

    closeDocument: (documentId: number) =>
      invokeCommand<void>("close_document", { document_id: documentId }),

    renderPage: async ({
      documentId,
      pageIndex,
      widthPx,
      heightPx,
      epoch,
    }: RenderPageParams) => {
      const buffer = await invokeCommand<ArrayBuffer>("render_page", {
        document_id: documentId,
        page_index: pageIndex,
        width_px: widthPx,
        height_px: heightPx,
        epoch,
      });
      return decodeRenderFrame(buffer);
    },

    getOutline: (documentId: number) =>
      invokeCommand<OutlineItem[]>("get_outline", { document_id: documentId }),

    getPageText: (documentId: number, pageIndex: number) =>
      invokeCommand<TextSpan[]>("get_page_text", {
        document_id: documentId,
        page_index: pageIndex,
      }),

    getPageLinks: (documentId: number, pageIndex: number) =>
      invokeCommand<PageLink[]>("get_page_links", {
        document_id: documentId,
        page_index: pageIndex,
      }),

    searchDocument: (documentId: number, query: string) =>
      invokeCommand<SearchMatch[]>("search_document", {
        document_id: documentId,
        query,
      }),

    saveReadingState: ({
      path,
      pageIndex,
      zoomMode,
      zoomScale,
    }: SaveReadingStateParams) =>
      invokeCommand<void>("save_reading_state", {
        path,
        page_index: pageIndex,
        zoom_mode: zoomMode,
        zoom_scale: zoomScale,
      }),

    removeRecentFile: (path: string) =>
      invokeCommand<PersistedState>("remove_recent_file", { path }),

    getRecentCover: async (path: string, maxSidePx?: number) => {
      const buffer = await invokeCommand<ArrayBuffer>("get_recent_cover", {
        path,
        max_side_px: maxSidePx ?? null,
      });
      return decodeRenderFrame(buffer);
    },

    openExternalUrl: (url: string) =>
      invokeCommand<void>("open_external_url", { url }),

    getHighlights: (fingerprint: string) =>
      invokeCommand<HighlightRecord[]>("get_highlights", { fingerprint }),

    createHighlight: ({
      fingerprint,
      lastKnownPath,
      id,
      color,
      segments,
      quote,
    }: CreateHighlightParams) =>
      invokeCommand<HighlightRecord>("create_highlight", {
        fingerprint,
        last_known_path: lastKnownPath ?? null,
        id,
        color,
        segments,
        quote,
      }),

    updateHighlightColor: (
      fingerprint: string,
      id: string,
      color: HighlightColor,
    ) =>
      invokeCommand<HighlightRecord>("update_highlight_color", {
        fingerprint,
        id,
        color,
      }),

    deleteHighlight: (fingerprint: string, id: string) =>
      invokeCommand<boolean>("delete_highlight", { fingerprint, id }),

    pickPdfFiles: async () => {
      try {
        const selection = await open({
          multiple: true,
          directory: false,
          filters: [{ name: "PDF Documents", extensions: ["pdf"] }],
        });
        if (!selection) {
          return [];
        }
        return Array.isArray(selection) ? selection : [selection];
      } catch (err) {
        throw normalizeApiError(err);
      }
    },

    subscribeDragDrop: async ({
      onEnter,
      onDrop,
      onLeave,
    }: DragDropHandlers) => {
      if (!hasTauriInternals()) {
        return () => {};
      }
      const current = getCurrentWebview();
      return current.onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter") {
          onEnter?.(Array.isArray(payload.paths) ? payload.paths : []);
        } else if (payload.type === "drop") {
          onDrop?.(Array.isArray(payload.paths) ? payload.paths : []);
        } else if (payload.type === "leave") {
          onLeave?.();
        }
      });
    },

    getWindowControls: () => {
      if (!hasTauriInternals()) {
        return createNoopWindowControls();
      }
      try {
        const win = getCurrentWindow();
        return {
          minimize: () => win.minimize(),
          toggleMaximize: () => win.toggleMaximize(),
          close: () => win.close(),
          isMaximized: () => win.isMaximized(),
          onResized: (handler: () => void) => win.onResized(handler),
        };
      } catch {
        return createNoopWindowControls();
      }
    },
  };
}
