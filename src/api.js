/**
 * Typed wrapper around window.__TAURI__ IPC, native dialog, and drag-drop events.
 */

export class ReaderApiError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "ReaderApiError";
    this.code = code;
  }
}

function getTauri() {
  const tauri = window.__TAURI__;
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== "function") {
    throw new ReaderApiError(
      "internal",
      "Tauri runtime bridge is not available in this window.",
    );
  }
  return tauri;
}

/**
 * Normalizes a Tauri IPC rejection into a structured ReaderApiError.
 * @param {unknown} err
 * @returns {ReaderApiError}
 */
export function normalizeApiError(err) {
  if (err instanceof ReaderApiError) {
    return err;
  }
  if (err && typeof err === "object" && typeof err.code === "string") {
    return new ReaderApiError(
      err.code,
      typeof err.message === "string" ? err.message : err.code,
    );
  }
  if (typeof err === "string") {
    return new ReaderApiError("internal", err);
  }
  if (err instanceof Error) {
    return new ReaderApiError("internal", err.message);
  }
  return new ReaderApiError("internal", "Unexpected application error.");
}

/**
 * Returns true if the error represents a superseded/cancelled render request.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isCancelledError(err) {
  return Boolean(err && typeof err === "object" && err.code === "cancelled");
}

async function invokeCommand(command, args) {
  try {
    const { core } = getTauri();
    return await core.invoke(command, args);
  } catch (err) {
    throw normalizeApiError(err);
  }
}

/** @returns {Promise<string | null>} */
export function getInitialFile() {
  return invokeCommand("get_initial_file");
}

/**
 * @returns {Promise<{ version: number, recent_files: Array<{ path: string, title: string, last_opened_unix: number, last_page: number, page_count: number }>, positions: Record<string, { page_index: number, zoom_mode: "fit_width" | "fit_page" | "custom", zoom_scale: number }> }>}
 */
export function getPersistedState() {
  return invokeCommand("get_persisted_state");
}

/**
 * @param {string} path
 */
export function openDocument(path) {
  return invokeCommand("open_document", { path });
}

/**
 * @param {number} documentId
 */
export function closeDocument(documentId) {
  return invokeCommand("close_document", { document_id: documentId });
}

/**
 * Renders a single PDF page and decodes the binary IPC response
 * `[width: u32 LE][height: u32 LE][RGBA8]` directly into an ImageData.
 *
 * @param {{ documentId: number, pageIndex: number, widthPx: number, heightPx: number, epoch: number }} params
 * @returns {Promise<ImageData>}
 */
export async function renderPage({ documentId, pageIndex, widthPx, heightPx, epoch }) {
  const buffer = await invokeCommand("render_page", {
    document_id: documentId,
    page_index: pageIndex,
    width_px: widthPx,
    height_px: heightPx,
    epoch,
  });

  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8) {
    throw new ReaderApiError("internal", "Invalid binary frame returned from render_page.");
  }

  const header = new DataView(buffer);
  const width = header.getUint32(0, true);
  const height = header.getUint32(4, true);
  const expectedBytes = width * height * 4;

  if (width === 0 || height === 0 || buffer.byteLength < 8 + expectedBytes) {
    throw new ReaderApiError("internal", "Truncated RGBA bitmap payload from render_page.");
  }

  const pixels = new Uint8ClampedArray(buffer, 8, expectedBytes);
  return new ImageData(pixels, width, height);
}

/**
 * @param {number} documentId
 */
export function getOutline(documentId) {
  return invokeCommand("get_outline", { document_id: documentId });
}

/**
 * @param {number} documentId
 * @param {number} pageIndex
 */
export function getPageText(documentId, pageIndex) {
  return invokeCommand("get_page_text", {
    document_id: documentId,
    page_index: pageIndex,
  });
}

/**
 * @param {number} documentId
 * @param {string} query
 */
export function searchDocument(documentId, query) {
  return invokeCommand("search_document", {
    document_id: documentId,
    query,
  });
}

/**
 * @param {{ path: string, pageIndex: number, zoomMode: "fit_width" | "fit_page" | "custom", zoomScale: number }} params
 */
export function saveReadingState({ path, pageIndex, zoomMode, zoomScale }) {
  return invokeCommand("save_reading_state", {
    path,
    page_index: pageIndex,
    zoom_mode: zoomMode,
    zoom_scale: zoomScale,
  });
}

/**
 * @param {string} path
 */
export function removeRecentFile(path) {
  return invokeCommand("remove_recent_file", { path });
}

/**
 * Opens the native OS file picker filtered to PDF documents.
 * @returns {Promise<string[]>}
 */
export async function pickPdfFiles() {
  const { dialog } = getTauri();
  if (!dialog || typeof dialog.open !== "function") {
    throw new ReaderApiError("internal", "Native file dialog plugin is unavailable.");
  }

  const selection = await dialog.open({
    multiple: true,
    directory: false,
    filters: [{ name: "PDF Documents", extensions: ["pdf"] }],
  });

  if (!selection) {
    return [];
  }
  return Array.isArray(selection) ? selection : [selection];
}

/**
 * Subscribes to native Tauri webview drag-and-drop file events.
 * @param {{ onEnter?: (paths: string[]) => void, onDrop?: (paths: string[]) => void, onLeave?: () => void }} handlers
 * @returns {Promise<() => Promise<void>>}
 */
export async function subscribeDragDrop({ onEnter, onDrop, onLeave }) {
  const { webview } = getTauri();
  if (!webview || typeof webview.getCurrentWebview !== "function") {
    return async () => {};
  }

  const current = webview.getCurrentWebview();
  return current.onDragDropEvent((event) => {
    const payload = event?.payload;
    if (!payload) {
      return;
    }

    if (payload.type === "enter") {
      onEnter?.(Array.isArray(payload.paths) ? payload.paths : []);
    } else if (payload.type === "drop") {
      onDrop?.(Array.isArray(payload.paths) ? payload.paths : []);
    } else if (payload.type === "leave") {
      onLeave?.();
    }
  });
}
