<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    resolveActiveOutlineNodeId,
    resolveVisibleActiveNodeId,
    type OutlineNode,
  } from "../lib/domain/outline";
  import type { AppActions } from "../lib/state/actions";
  import type { AppStore } from "../lib/state/app-store.svelte";
  import type { DocState, TransitionHooks } from "../lib/state/types";
  import CloseIcon from "./icons/CloseIcon.svelte";
  import TocTree from "./TocTree.svelte";

  const LOADING_DELAY_MS = 120;
  const EMPTY_EXPANDED: ReadonlySet<string> = new Set();

  interface Props {
    store: AppStore;
    actions: AppActions;
    hooks: TransitionHooks;
    onDrawerElement?: (el: HTMLElement | null) => void;
  }

  let { store, actions, hooks, onDrawerElement }: Props = $props();
  let drawerEl = $state<HTMLElement | null>(null);
  let bodyEl = $state<HTMLDivElement | null>(null);
  let rovingNodeId = $state<string | null>(null);
  let showLoadingMessage = $state(false);
  let lastSyncedKey = "";

  const doc = $derived(store.activeDoc);
  const isOpen = $derived(Boolean(doc?.outline.open));
  const model = $derived(doc?.outline.model ?? null);
  const expandedIds = $derived<ReadonlySet<string>>(
    doc?.outline.expandedIds ?? EMPTY_EXPANDED,
  );

  const resolvedActiveId = $derived(
    doc && model
      ? resolveActiveOutlineNodeId(
          model,
          doc.view.pageIndex,
          doc.outline.selectedNodeId,
        )
      : null,
  );
  const visibleActiveNodeId = $derived(
    model && resolvedActiveId
      ? resolveVisibleActiveNodeId(model, resolvedActiveId, expandedIds)
      : null,
  );

  $effect(() => {
    onDrawerElement?.(drawerEl);
    return () => {
      onDrawerElement?.(null);
    };
  });

  $effect(() => {
    const captureScroll = (targetDoc: DocState) => {
      if (
        bodyEl &&
        doc?.documentId === targetDoc.documentId &&
        targetDoc.outline.open
      ) {
        actions.setTocScrollTop(targetDoc.documentId, bodyEl.scrollTop);
      }
    };
    const isFocusInToc = () =>
      Boolean(drawerEl && drawerEl.contains(document.activeElement));

    hooks.captureTocScroll = captureScroll;
    hooks.isFocusInToc = isFocusInToc;

    return () => {
      if (hooks.captureTocScroll === captureScroll) {
        delete hooks.captureTocScroll;
      }
      if (hooks.isFocusInToc === isFocusInToc) {
        delete hooks.isFocusInToc;
      }
    };
  });

  // Delay "Loading outline..." message by 120ms so fast outlines appear flicker-free.
  $effect(() => {
    const loading = isOpen && doc?.outline.status === "loading";
    if (!loading) {
      showLoadingMessage = false;
      return;
    }
    showLoadingMessage = false;
    const timer = setTimeout(() => {
      showLoadingMessage = true;
    }, LOADING_DELAY_MS);
    return () => clearTimeout(timer);
  });

  function findRowElement(nodeId: string): HTMLElement | null {
    if (!bodyEl) {
      return null;
    }
    const rows = bodyEl.querySelectorAll<HTMLElement>(".toc-row");
    for (const row of rows) {
      if (row.dataset.nodeId === nodeId) {
        return row;
      }
    }
    return null;
  }

  function getVisibleRowElements(): HTMLElement[] {
    if (!bodyEl) {
      return [];
    }
    return Array.from(bodyEl.querySelectorAll<HTMLElement>(".toc-row"));
  }

  function focusNodeById(nodeId: string): void {
    rovingNodeId = nodeId;
    findRowElement(nodeId)?.focus();
  }

  // Restore saved TOC scroll or scroll active chapter into view when opening / switching tabs.
  $effect(() => {
    const docId = doc?.documentId ?? null;
    const status = doc?.outline.status ?? "idle";
    const key =
      docId !== null && isOpen && status === "loaded" ? `${docId}:open` : "";
    if (!key) {
      lastSyncedKey = "";
      return;
    }
    if (key === lastSyncedKey) {
      return;
    }
    lastSyncedKey = key;

    untrack(() => {
      const savedScroll = doc?.outline.scrollTop ?? 0;
      const targetActive = visibleActiveNodeId;
      const fallbackRoot = model?.roots[0]?.id ?? null;
      rovingNodeId = targetActive ?? fallbackRoot;

      void tick().then(() => {
        if (!bodyEl || !isOpen) {
          return;
        }
        if (savedScroll > 0) {
          bodyEl.scrollTop = savedScroll;
        } else if (targetActive) {
          findRowElement(targetActive)?.scrollIntoView({ block: "nearest" });
        }
      });
    });
  });

  // Track active chapter updates while scrolling the PDF (without stealing focus inside TOC).
  $effect(() => {
    const activeId = visibleActiveNodeId;
    if (!isOpen || doc?.outline.status !== "loaded") {
      return;
    }
    if (!drawerEl || drawerEl.contains(document.activeElement)) {
      return;
    }
    rovingNodeId = activeId ?? model?.roots[0]?.id ?? null;
    if (activeId) {
      void tick().then(() => {
        if (isOpen && drawerEl && !drawerEl.contains(document.activeElement)) {
          findRowElement(activeId)?.scrollIntoView({ block: "nearest" });
        }
      });
    }
  });

  function handleToggleExpand(nodeId: string, expanded: boolean): void {
    if (!doc) {
      return;
    }
    actions.setTocNodeExpanded(doc.documentId, nodeId, expanded);
    if (
      !expanded &&
      rovingNodeId &&
      (rovingNodeId === nodeId || rovingNodeId.startsWith(`${nodeId}.`))
    ) {
      // Prevent roving tabindex from disappearing inside a newly collapsed branch.
      rovingNodeId = nodeId;
    }
  }

  function handleActivateNode(node: OutlineNode, fromKeyboard: boolean): void {
    if (!doc) {
      return;
    }
    actions.selectTocNode(doc.documentId, node, { fromKeyboard });
  }

  function handleRowKeyDown(event: KeyboardEvent, node: OutlineNode): void {
    if (!doc || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    const key = event.key;
    if (key === "ArrowDown") {
      event.preventDefault();
      const rows = getVisibleRowElements();
      const idx =
        event.currentTarget instanceof HTMLElement
          ? rows.indexOf(event.currentTarget)
          : -1;
      const next = idx >= 0 ? rows[idx + 1] : undefined;
      if (next?.dataset.nodeId) {
        focusNodeById(next.dataset.nodeId);
      }
      return;
    }

    if (key === "ArrowUp") {
      event.preventDefault();
      const rows = getVisibleRowElements();
      const idx =
        event.currentTarget instanceof HTMLElement
          ? rows.indexOf(event.currentTarget)
          : -1;
      const prev = idx > 0 ? rows[idx - 1] : undefined;
      if (prev?.dataset.nodeId) {
        focusNodeById(prev.dataset.nodeId);
      }
      return;
    }

    if (key === "ArrowRight") {
      event.preventDefault();
      if (!node.hasChildren) {
        return;
      }
      if (!expandedIds.has(node.id)) {
        handleToggleExpand(node.id, true);
      } else {
        const firstChild = node.children[0];
        if (firstChild) {
          focusNodeById(firstChild.id);
        }
      }
      return;
    }

    if (key === "ArrowLeft") {
      event.preventDefault();
      if (node.hasChildren && expandedIds.has(node.id)) {
        handleToggleExpand(node.id, false);
      } else if (node.parentId) {
        focusNodeById(node.parentId);
      }
      return;
    }

    if (key === "Home") {
      event.preventDefault();
      const first = getVisibleRowElements()[0];
      if (first?.dataset.nodeId) {
        focusNodeById(first.dataset.nodeId);
      }
      return;
    }

    if (key === "End") {
      event.preventDefault();
      const rows = getVisibleRowElements();
      const last = rows[rows.length - 1];
      if (last?.dataset.nodeId) {
        focusNodeById(last.dataset.nodeId);
      }
      return;
    }

    if (key === "Enter" || key === " ") {
      event.preventDefault();
      handleActivateNode(node, true);
    }
  }
</script>

<aside
  id="toc-drawer"
  class="toc-drawer"
  aria-label="Table of contents"
  hidden={!isOpen}
  bind:this={drawerEl}
>
  <div class="toc-header">
    <h2 class="toc-title">Outline</h2>
    <button
      type="button"
      class="toc-close-btn"
      aria-label="Close outline"
      title="Close outline (Ctrl+B)"
      onclick={() => actions.closeToc()}
    >
      <CloseIcon size={12} />
    </button>
  </div>

  <div class="toc-body" bind:this={bodyEl}>
    {#if doc && isOpen}
      {#if doc.outline.status === "loading"}
        {#if showLoadingMessage}
          <div class="toc-state">
            <span>Loading outline…</span>
          </div>
        {/if}
      {:else if doc.outline.status === "error"}
        <div class="toc-state toc-state--error">
          <span>Could not load outline.</span>
          <button
            type="button"
            class="toc-retry-btn"
            onclick={() =>
              void actions.ensureOutlineLoaded(doc.documentId, { force: true })}
          >
            Retry
          </button>
        </div>
      {:else if doc.outline.status === "loaded"}
        {#if !model || model.roots.length === 0}
          <div class="toc-state">
            <span>No outline in this document</span>
          </div>
        {:else}
          <TocTree
            nodes={model.roots}
            {expandedIds}
            activeVisibleNodeId={visibleActiveNodeId}
            {rovingNodeId}
            isRoot={true}
            onToggleExpand={handleToggleExpand}
            onActivateNode={handleActivateNode}
            onRowKeyDown={handleRowKeyDown}
            onSetRovingNode={(id) => {
              rovingNodeId = id;
            }}
          />
        {/if}
      {/if}
    {/if}
  </div>
</aside>

<style>
  .toc-drawer {
    flex: 0 0 252px;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background-color: var(--surface-paper);
    border-right: 1px solid var(--border-subtle);
  }

  .toc-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: 32px;
    padding: 0 8px 0 12px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .toc-title {
    margin: 0;
    font-size: 12px;
    font-weight: 550;
    color: var(--ink-muted);
  }

  .toc-close-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--ink-muted);
    cursor: pointer;
    transition:
      background-color 110ms ease,
      color 110ms ease;
  }

  .toc-close-btn:hover {
    background-color: var(--hover-subtle);
    color: var(--ink-primary);
  }

  .toc-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 6px 6px 14px;
  }

  .toc-state {
    padding: 18px 10px;
    color: var(--ink-muted);
    font-size: 12.5px;
    line-height: 1.45;
  }

  .toc-state--error {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    color: var(--error-ink);
  }

  .toc-retry-btn {
    padding: 4px 10px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background-color: var(--surface-paper);
    color: var(--ink-primary);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .toc-retry-btn:hover {
    background-color: var(--hover-subtle);
  }

  @media (max-width: 740px) {
    .toc-drawer {
      position: absolute;
      inset: 0 auto 0 0;
      z-index: 18;
      width: min(252px, 78vw);
      box-shadow: 2px 0 12px rgba(26, 31, 43, 0.14);
    }
  }
</style>
