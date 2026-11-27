<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { createHighlightLayerEngine } from "../lib/engines/highlight-layer";
  import { createLinkLayerEngine } from "../lib/engines/link-layer";
  import { createTextLayerEngine } from "../lib/engines/text-layer";
  import {
    createViewportEngine,
    type ViewportEngine,
  } from "../lib/engines/viewport";
  import type { ReaderApi } from "../lib/ipc/client";
  import type { AppActions } from "../lib/state/actions";
  import type { AppStore } from "../lib/state/app-store.svelte";
  import type { DocumentScopeRegistry } from "../lib/state/doc-scope";
  import type { TransitionHooks } from "../lib/state/types";

  interface Props {
    store: AppStore;
    actions: AppActions;
    api: ReaderApi;
    scopes: DocumentScopeRegistry;
    hooks: TransitionHooks;
    onViewportElement?: (el: HTMLElement | null) => void;
    children?: Snippet;
  }

  let {
    store,
    actions,
    api,
    scopes,
    hooks,
    onViewportElement,
    children,
  }: Props = $props();
  let viewportEl = $state<HTMLDivElement | null>(null);
  let trackEl = $state<HTMLDivElement | null>(null);
  let viewportEngine = $state<ViewportEngine | null>(null);
  let lastMatchedDocId: number | null = null;
  let lastMatchScrollSeq = 0;

  $effect(() => {
    onViewportElement?.(viewportEl);
    return () => {
      onViewportElement?.(null);
    };
  });

  $effect(() => {
    if (!viewportEl || !trackEl) {
      return;
    }

    const textLayer = createTextLayerEngine({ viewportEl, api });
    const linkLayer = createLinkLayerEngine({
      viewportEl,
      api,
      onActivateLink: (documentId, link) => {
        void actions.activatePageLink(documentId, link);
      },
    });
    const highlightLayer = createHighlightLayerEngine({
      viewportEl,
      getHighlighterMode: () => store.highlighterMode,
      isLinkAtPoint: (clientX, clientY) =>
        linkLayer.hasLinkAtClientPoint(clientX, clientY),
      extractSelection: (slotElements) =>
        textLayer.extractSelectionSegments(slotElements),
      clearActiveSelection: () => textLayer.clearActiveSelection(),
      onCreateFromSelection: (documentId, segments, quote) => {
        void actions.createHighlightFromSelection(documentId, segments, quote);
      },
      onSelectHighlight: (documentId, highlightId, anchorRect) => {
        actions.openHighlightPopover({
          documentId,
          highlightId,
          anchorRect,
        });
      },
      onDismissPopover: () => {
        actions.closeHighlightPopover();
      },
    });
    const viewport = createViewportEngine({
      viewportEl,
      trackEl,
      api,
      textLayer,
      linkLayer,
      highlightLayer,
      onViewStateChange: (snapshot, reason) => {
        actions.applyViewportSnapshot(snapshot.documentId, snapshot, reason);
      },
    });

    viewportEngine = viewport;
    hooks.captureViewportSnapshot = () => viewport.captureSnapshot();
    hooks.clearTextSelection = () => textLayer.clearActiveSelection();
    hooks.onDocumentClosed = (documentId: number) => {
      textLayer.evictDocument(documentId);
      linkLayer.evictDocument(documentId);
    };
    hooks.viewportCommands = {
      setZoomMode: (mode) => viewport.setZoomMode(mode),
      setCustomZoom: (scale) => viewport.setCustomZoom(scale),
      scrollToPage: (pageIndex) => viewport.scrollToPage(pageIndex),
      scrollToTarget: (target) => viewport.scrollToTarget(target),
      scrollToAnchor: (target) => viewport.scrollToAnchor(target),
      scrollPageStep: (direction) => viewport.scrollPageStep(direction),
      scrollToStart: () => viewport.scrollToStart(),
      scrollToEnd: () => viewport.scrollToEnd(),
    };

    return () => {
      if (hooks.viewportCommands) {
        delete hooks.viewportCommands;
      }
      delete hooks.captureViewportSnapshot;
      delete hooks.clearTextSelection;
      delete hooks.onDocumentClosed;
      viewportEngine = null;
      viewport.destroy();
      highlightLayer.destroy();
      linkLayer.destroy();
      textLayer.destroy();
    };
  });

  // Track strictly activeDocId so zooming, scrolling, or search updates never remount the viewport.
  $effect(() => {
    const activeDocId = store.activeDoc?.documentId ?? null;
    const engine = viewportEngine;
    if (!engine) {
      return;
    }
    if (activeDocId === null) {
      engine.unmount();
      return;
    }

    untrack(() => {
      const doc = store.docsById.get(activeDocId);
      if (!doc) {
        return;
      }
      engine.mountDocument({
        documentId: doc.documentId,
        pageDimensions: doc.pageDimensions,
        pageIndex: doc.view.pageIndex,
        scrollTop: doc.view.scrollTop,
        scrollAnchor: doc.view.scrollAnchor,
        zoomMode: doc.view.zoomMode,
        zoomScale: doc.view.zoomScale,
        search: doc.search,
        highlightsByPage: doc.highlights.byPage,
        signal: scopes.getSignal(doc.documentId),
      });
    });

    return () => {
      engine.unmount();
    };
  });

  $effect(() => {
    const req = store.focusRequest;
    if (req?.target === "viewport" && store.activeDoc && viewportEngine) {
      viewportEngine.focus();
    }
  });

  // Repaint search hit overlays whenever active tab, search visibility, or highlightVersion changes.
  $effect(() => {
    const doc = store.activeDoc;
    const engine = viewportEngine;
    if (!engine) {
      return;
    }
    if (!doc) {
      engine.syncSearchHighlights(null);
      return;
    }
    void doc.search.highlightVersion;
    void doc.search.open;
    engine.syncSearchHighlights(doc.search);
  });

  // Repaint user highlight overlays whenever active tab or highlight data version changes.
  $effect(() => {
    const doc = store.activeDoc;
    const engine = viewportEngine;
    if (!engine) {
      return;
    }
    if (!doc) {
      engine.syncUserHighlights(null);
      return;
    }
    void doc.highlights.version;
    engine.syncUserHighlights(doc.highlights.byPage);
  });

  // Scroll to active match only when scrollToMatchSeq advances within the same mounted document.
  $effect(() => {
    const doc = store.activeDoc;
    const engine = viewportEngine;
    if (!engine || !doc) {
      lastMatchedDocId = null;
      lastMatchScrollSeq = 0;
      return;
    }

    const docId = doc.documentId;
    const seq = doc.search.scrollToMatchSeq;
    if (docId !== lastMatchedDocId) {
      lastMatchedDocId = docId;
      lastMatchScrollSeq = seq;
      return;
    }
    if (seq > lastMatchScrollSeq && seq > 0) {
      lastMatchScrollSeq = seq;
      untrack(() => {
        const match = doc.search.matches[doc.search.currentIndex];
        if (match) {
          engine.scrollToNormalizedRect(match.page_index, match.rects[0]);
        }
      });
    }
  });
</script>

<div class="viewport-host">
  {@render children?.()}
  <!-- Scrollable PDF region requires keyboard focus for navigation and selection -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    id="viewport"
    class="viewport"
    class:viewport--highlighter-mode={store.highlighterMode}
    tabindex="0"
    aria-label="Document pages"
    bind:this={viewportEl}
  >
    <div id="viewport-track" class="viewport-track" bind:this={trackEl}></div>
  </div>
</div>

<style>
  .viewport-host {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
</style>
