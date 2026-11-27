import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaderApi } from "../../ipc/client";
import { ReaderApiError } from "../../ipc/errors";
import type { OpenDocumentResponse } from "../../ipc/types";
import { createAppActions } from "../../state/actions";
import { createAppStore } from "../../state/app-store.svelte";
import { createDocumentScopeRegistry } from "../../state/doc-scope";
import { createPersistenceQueue } from "../../state/persistence";
import { installShortcutRouter } from "../shortcuts";

function makeOpenResponse(
  documentId: number,
  path: string,
): OpenDocumentResponse {
  return {
    document_id: documentId,
    canonical_path: path,
    document_fingerprint: `${String(documentId).padStart(64, "0")}`,
    metadata: {
      title: `Doc ${documentId}`,
      author: null,
      page_count: 4,
    },
    page_dimensions: Array.from({ length: 4 }, () => ({
      width_pt: 612,
      height_pt: 792,
    })),
    saved_position: null,
    already_open: false,
  };
}

function createFakeApi(): ReaderApi {
  return {
    getInitialFile: async () => null,
    getPersistedState: async () => ({
      version: 1,
      recent_files: [],
      positions: {},
    }),
    openDocument: async (path) => makeOpenResponse(1, path),
    closeDocument: async () => {},
    renderPage: async () => {
      throw new ReaderApiError("internal", "Not implemented");
    },
    getOutline: async () => [],
    getPageText: async () => [],
    getPageLinks: async () => [],
    searchDocument: async () => [],
    saveReadingState: async () => {},
    removeRecentFile: async () => ({
      version: 1,
      recent_files: [],
      positions: {},
    }),
    getRecentCover: async () => {
      throw new ReaderApiError("internal", "Not implemented");
    },
    openExternalUrl: async () => {},
    getHighlights: async () => [],
    createHighlight: async (params) => ({
      id: params.id,
      color: params.color,
      segments: [...params.segments],
      quote: params.quote,
      created_at_unix: 1,
      updated_at_unix: 1,
    }),
    updateHighlightColor: async (_fp, id, color) => ({
      id,
      color,
      segments: [],
      quote: "",
      created_at_unix: 1,
      updated_at_unix: 2,
    }),
    deleteHighlight: async () => true,
    pickPdfFiles: async () => [],
    subscribeDragDrop: async () => () => {},
    getWindowControls: () => ({
      minimize: async () => {},
      toggleMaximize: async () => {},
      close: async () => {},
      isMaximized: async () => false,
      onResized: async () => () => {},
    }),
  };
}

class MockElement {
  tagName: string;
  attributes: Record<string, string> = {};
  blur = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  dispatchEvent = vi.fn(() => true);

  constructor(tagName = "DIV") {
    this.tagName = tagName.toUpperCase();
  }

  closest(selector: string): MockElement | null {
    if (
      selector.includes("contenteditable") &&
      (this.attributes.contenteditable === "" ||
        this.attributes.contenteditable === "true")
    ) {
      return this;
    }
    return null;
  }
}

describe("installShortcutRouter highlighter mode shortcuts", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalElement = globalThis.Element;
  const originalHTMLElement = globalThis.HTMLElement;
  const originalNode = globalThis.Node;

  let listeners: Map<string, Set<(event: unknown) => void>>;
  let viewportMock: MockElement;
  let tocMock: MockElement;
  let searchMock: MockElement;
  let activeElement: MockElement;

  function dispatchKeydown(
    overrides: Partial<Omit<KeyboardEvent, "target">> & {
      key: string;
      target?: MockElement | EventTarget | null;
    },
  ): { preventDefault: ReturnType<typeof vi.fn> } {
    const preventDefault = vi.fn();
    const event = {
      key: overrides.key,
      code: overrides.code ?? "",
      ctrlKey: overrides.ctrlKey ?? false,
      metaKey: overrides.metaKey ?? false,
      shiftKey: overrides.shiftKey ?? false,
      altKey: overrides.altKey ?? false,
      defaultPrevented: overrides.defaultPrevented ?? false,
      isComposing: overrides.isComposing ?? false,
      keyCode: overrides.keyCode ?? 0,
      target: overrides.target ?? viewportMock,
      preventDefault,
    };
    for (const listener of listeners.get("keydown") ?? []) {
      listener(event);
    }
    return { preventDefault };
  }

  beforeEach(() => {
    listeners = new Map();
    viewportMock = new MockElement("DIV");
    tocMock = new MockElement("ASIDE");
    searchMock = new MockElement("INPUT");
    activeElement = viewportMock;

    (globalThis as unknown as { Element: unknown }).Element = MockElement;
    (globalThis as unknown as { HTMLElement: unknown }).HTMLElement =
      MockElement;
    (globalThis as unknown as { Node: unknown }).Node = MockElement;
    (globalThis as unknown as { document: unknown }).document = {
      get activeElement() {
        return activeElement;
      },
    };
    (globalThis as unknown as { window: unknown }).window = {
      addEventListener(type: string, listener: (event: unknown) => void) {
        let set = listeners.get(type);
        if (!set) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(listener);
      },
      removeEventListener(type: string, listener: (event: unknown) => void) {
        listeners.get(type)?.delete(listener);
      },
      getSelection: vi.fn(() => null),
    };
  });

  afterEach(() => {
    (globalThis as unknown as { window: unknown }).window = originalWindow;
    (globalThis as unknown as { document: unknown }).document =
      originalDocument;
    (globalThis as unknown as { Element: unknown }).Element = originalElement;
    (globalThis as unknown as { HTMLElement: unknown }).HTMLElement =
      originalHTMLElement;
    (globalThis as unknown as { Node: unknown }).Node = originalNode;
  });

  it("handles Ctrl+Shift+H, mode-scoped 1/2/3 swatches, Ctrl+1..9 tab isolation, and Esc ladder", async () => {
    const store = createAppStore();
    const scopes = createDocumentScopeRegistry();
    const api = createFakeApi();
    let docSeq = 0;
    api.openDocument = async (path) => makeOpenResponse(++docSeq, path);
    const persistence = createPersistenceQueue(api);
    const actions = createAppActions({ store, api, scopes, persistence });

    const uninstall = installShortcutRouter({
      store,
      actions,
      getViewportEl: () => viewportMock as unknown as HTMLElement,
      isInsideToc: (target) => target === (tocMock as unknown as EventTarget),
      isInsideSearch: (target) =>
        target === (searchMock as unknown as EventTarget),
    });

    // Empty workspace: Ctrl+Shift+H does nothing.
    const emptyChord = dispatchKeydown({
      key: "H",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(emptyChord.preventDefault).not.toHaveBeenCalled();
    expect(store.highlighterMode).toBe(false);

    // Open two documents.
    await actions.openPath("/virtual/one.pdf");
    await actions.openPath("/virtual/two.pdf");
    expect(store.activeDoc?.documentId).toBe(2);

    // AltGr chord (ctrlKey + altKey) must not toggle Highlighter Mode.
    dispatchKeydown({
      key: "H",
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
    });
    expect(store.highlighterMode).toBe(false);

    // Reading Mode: 1/2/3 do nothing.
    const readingDigit = dispatchKeydown({ key: "2" });
    expect(readingDigit.preventDefault).not.toHaveBeenCalled();
    expect(store.activeHighlightColor).toBe("yellow");

    // Ctrl+Shift+H toggles Highlighter Mode ON.
    const toggleOn = dispatchKeydown({
      key: "h",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(toggleOn.preventDefault).toHaveBeenCalledTimes(1);
    expect(store.highlighterMode).toBe(true);

    // 1/2/3 switch color while active, unless inside editable inputs or TOC.
    dispatchKeydown({ key: "2" });
    expect(store.activeHighlightColor).toBe("green");
    dispatchKeydown({ key: "3" });
    expect(store.activeHighlightColor).toBe("pink");

    const inputEl = new MockElement("INPUT");
    dispatchKeydown({ key: "1", target: inputEl });
    expect(store.activeHighlightColor).toBe("pink");

    dispatchKeydown({ key: "1", target: tocMock });
    expect(store.activeHighlightColor).toBe("pink");

    // Ctrl+1 switches tabs without altering activeHighlightColor.
    const tabSwitch = dispatchKeydown({
      key: "1",
      code: "Digit1",
      ctrlKey: true,
    });
    expect(tabSwitch.preventDefault).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(store.activeTabId).toBe("doc-1");
    });
    expect(store.activeHighlightColor).toBe("pink");

    // Esc precedence: closes SearchBar first, then exits Highlighter Mode on next Esc.
    actions.openSearch();
    expect(store.activeDoc?.search.open).toBe(true);
    expect(store.highlighterMode).toBe(true);

    dispatchKeydown({ key: "Escape" });
    expect(store.activeDoc?.search.open).toBe(false);
    expect(store.highlighterMode).toBe(true);

    const swatchBtn = new MockElement("BUTTON");
    activeElement = swatchBtn;
    dispatchKeydown({ key: "Escape", target: swatchBtn });
    expect(store.highlighterMode).toBe(false);
    expect(swatchBtn.blur).toHaveBeenCalledTimes(1);

    // Cleanup detaches keydown listener.
    uninstall();
    dispatchKeydown({ key: "H", ctrlKey: true, shiftKey: true });
    expect(store.highlighterMode).toBe(false);
    actions.dispose();
  });

  it("handles Esc precedence and Delete/Backspace for activeHighlightPopover", async () => {
    const store = createAppStore();
    const scopes = createDocumentScopeRegistry();
    const api = createFakeApi();
    const persistence = createPersistenceQueue(api);
    const actions = createAppActions({ store, api, scopes, persistence });

    const uninstall = installShortcutRouter({
      store,
      actions,
      getViewportEl: () => viewportMock as unknown as HTMLElement,
      isInsideToc: (target) => target === (tocMock as unknown as EventTarget),
      isInsideSearch: (target) =>
        target === (searchMock as unknown as EventTarget),
    });

    await actions.openPath("/virtual/doc.pdf");
    const createdA = await actions.createHighlightFromSelection(
      1,
      [
        {
          page_index: 0,
          rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.02 }],
        },
      ],
      "Highlight A",
    );
    const createdB = await actions.createHighlightFromSelection(
      1,
      [
        {
          page_index: 0,
          rects: [{ x: 0.1, y: 0.4, width: 0.4, height: 0.02 }],
        },
      ],
      "Highlight B",
    );
    expect(createdA).not.toBeNull();
    expect(createdB).not.toBeNull();
    expect(store.activeDoc?.highlights.items).toHaveLength(2);

    // Delete/Backspace do nothing when no highlight popover is open.
    const noPopoverDel = dispatchKeydown({ key: "Delete" });
    expect(noPopoverDel.preventDefault).not.toHaveBeenCalled();
    expect(store.activeDoc?.highlights.items).toHaveLength(2);

    // Activate popover + SearchBar + Highlighter Mode together to verify Esc precedence:
    // Step 2: HighlightPopover -> Step 3: SearchBar -> Step 4: Highlighter Mode.
    actions.setHighlighterMode(true);
    actions.openSearch();
    actions.openHighlightPopover({
      documentId: 1,
      highlightId: createdA!.id,
      anchorRect: { left: 100, top: 200, width: 120, height: 18 },
    });

    const escPopover = dispatchKeydown({ key: "Escape" });
    expect(escPopover.preventDefault).toHaveBeenCalledTimes(1);
    expect(store.activeHighlightPopover).toBeNull();
    expect(store.activeDoc?.search.open).toBe(true);
    expect(store.highlighterMode).toBe(true);

    dispatchKeydown({ key: "Escape" });
    expect(store.activeDoc?.search.open).toBe(false);
    expect(store.highlighterMode).toBe(true);

    dispatchKeydown({ key: "Escape" });
    expect(store.highlighterMode).toBe(false);

    // Reopen popover for A: editable inputs and modified chords must not delete highlight.
    actions.openHighlightPopover({
      documentId: 1,
      highlightId: createdA!.id,
      anchorRect: { left: 100, top: 200, width: 120, height: 18 },
    });

    const inputEl = new MockElement("INPUT");
    const editableBackspace = dispatchKeydown({
      key: "Backspace",
      target: inputEl,
    });
    expect(editableBackspace.preventDefault).not.toHaveBeenCalled();
    expect(store.activeDoc?.highlights.items).toHaveLength(2);

    dispatchKeydown({ key: "Delete", ctrlKey: true });
    dispatchKeydown({ key: "Backspace", shiftKey: true });
    dispatchKeydown({ key: "Delete", altKey: true });
    expect(store.activeDoc?.highlights.items).toHaveLength(2);

    // Unmodified Delete removes A, closes popover, blurs any popover button, and focuses viewport.
    const popoverDeleteBtn = new MockElement("BUTTON");
    activeElement = popoverDeleteBtn;
    const delEvent = dispatchKeydown({
      key: "Delete",
      target: popoverDeleteBtn,
    });
    expect(delEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(store.activeHighlightPopover).toBeNull();
    expect(popoverDeleteBtn.blur).toHaveBeenCalledTimes(1);
    expect(store.activeDoc?.highlights.items.map((h) => h.id)).toEqual([
      createdB!.id,
    ]);

    // Unmodified Backspace deletes B when B's popover is open.
    actions.openHighlightPopover({
      documentId: 1,
      highlightId: createdB!.id,
      anchorRect: { left: 100, top: 320, width: 120, height: 18 },
    });
    const backspaceEvent = dispatchKeydown({ key: "Backspace" });
    expect(backspaceEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(store.activeHighlightPopover).toBeNull();
    expect(store.activeDoc?.highlights.items).toEqual([]);

    uninstall();
    actions.dispose();
  });
});
