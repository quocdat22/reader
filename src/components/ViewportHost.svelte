<script lang="ts">
  import { untrack, type Snippet } from "svelte";
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
    const viewport = createViewportEngine({
      viewportEl,
      trackEl,
      api,
      textLayer,
      onViewStateChange: (snapshot, reason) => {
        actions.applyViewportSnapshot(snapshot.documentId, snapshot, reason);
      },
    });

    viewportEngine = viewport;
    hooks.captureViewportSnapshot = () => viewport.captureSnapshot();
    hooks.onDocumentClosed = (documentId: number) => {
      textLayer.evictDocument(documentId);
    };
    hooks.viewportCommands = {
      setZoomMode: (mode) => viewport.setZoomMode(mode),
      setCustomZoom: (scale) => viewport.setCustomZoom(scale),
      scrollToPage: (pageIndex) => viewport.scrollToPage(pageIndex),
      scrollPageStep: (direction) => viewport.scrollPageStep(direction),
      scrollToStart: () => viewport.scrollToStart(),
      scrollToEnd: () => viewport.scrollToEnd(),
    };

    return () => {
      if (hooks.viewportCommands) {
        delete hooks.viewportCommands;
      }
      delete hooks.captureViewportSnapshot;
      delete hooks.onDocumentClosed;
      viewportEngine = null;
      viewport.destroy();
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
</script>

<div class="viewport-host">
  {@render children?.()}
  <!-- Scrollable PDF region requires keyboard focus for navigation and selection -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    id="viewport"
    class="viewport"
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
