<script lang="ts">
  import { tick } from "svelte";
  import {
    tabReorder,
    type TabReorderCommitMeta,
  } from "../lib/engines/tab-drag";
  import type { WindowControlsApi } from "../lib/ipc/client";
  import type { AppActions } from "../lib/state/actions";
  import type { AppStore } from "../lib/state/app-store.svelte";
  import CloseIcon from "./icons/CloseIcon.svelte";
  import HomeIcon from "./icons/HomeIcon.svelte";
  import PlusIcon from "./icons/PlusIcon.svelte";
  import WindowControls from "./WindowControls.svelte";

  interface Props {
    store: AppStore;
    actions: AppActions;
    windowControls: WindowControlsApi;
  }

  let { store, actions, windowControls }: Props = $props();
  let tabListEl = $state<HTMLDivElement | null>(null);

  function findTabElement(tabId: string): HTMLElement | null {
    if (!tabListEl) {
      return null;
    }
    for (const child of Array.from(tabListEl.children)) {
      if (child instanceof HTMLElement && child.dataset.tabId === tabId) {
        return child;
      }
    }
    return null;
  }

  function scrollTabIntoView(tabId: string): void {
    findTabElement(tabId)?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }

  $effect(() => {
    const activeId = store.activeTabId;
    if (!activeId) {
      return;
    }
    void tick().then(() => {
      scrollTabIntoView(activeId);
    });
  });

  function handleCommitReorder(
    fromIndex: number,
    toIndex: number,
    meta: TabReorderCommitMeta,
  ): void {
    actions.reorderTab(fromIndex, toIndex);
    void tick().then(() => {
      if (tabListEl) {
        tabListEl.scrollLeft = meta.scrollLeft;
      }
      scrollTabIntoView(meta.tabId);
    });
  }

  function handleTabListWheel(event: WheelEvent): void {
    if (!tabListEl || tabListEl.scrollWidth <= tabListEl.clientWidth) {
      return;
    }
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      event.preventDefault();
      tabListEl.scrollLeft += event.deltaY;
    }
  }

  function handleTabKeyDown(event: KeyboardEvent, tabId: string): void {
    const primaryMod = event.ctrlKey || event.metaKey;
    if (primaryMod && event.shiftKey && !event.altKey) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        const savedScrollLeft = tabListEl?.scrollLeft ?? 0;
        const delta: -1 | 1 = event.key === "ArrowLeft" ? -1 : 1;
        if (actions.moveTabBy(tabId, delta)) {
          void tick().then(() => {
            if (tabListEl) {
              tabListEl.scrollLeft = savedScrollLeft;
            }
            const movedEl = findTabElement(tabId);
            movedEl?.focus({ preventScroll: true });
            movedEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
          });
        }
        return;
      }
    }

    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (tabId !== store.activeTabId) {
        void actions.selectTab(tabId);
      }
      return;
    }

    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const order = store.tabOrder;
      if (order.length < 2) {
        return;
      }
      event.preventDefault();
      const currentIndex = order.indexOf(tabId);
      if (currentIndex === -1) {
        return;
      }
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const nextIndex = (currentIndex + delta + order.length) % order.length;
      const nextTabId = order[nextIndex];
      if (nextTabId) {
        findTabElement(nextTabId)?.focus();
      }
    }
  }
</script>

<div
  id="tab-strip"
  class="tab-strip"
  class:tab-strip--empty={!store.hasAnyTabs}
>
  <div class="tab-strip-brand" data-tauri-drag-region aria-hidden="true">
    <img
      class="tab-strip-logo"
      src="/logo.png"
      width="16"
      height="16"
      alt=""
      draggable="false"
    />
  </div>

  <div
    id="tab-list"
    class="tab-list"
    role="tablist"
    aria-label="Open documents"
    hidden={!store.hasAnyTabs}
    bind:this={tabListEl}
    use:tabReorder={{
      disabled: store.tabOrder.length < 2,
      onCommitReorder: handleCommitReorder,
    }}
    onwheel={handleTabListWheel}
  >
    {#each store.orderedTabs as tab (tab.tabId)}
      {@const isActive = tab.tabId === store.activeTabId}
      {@const isHome = tab.kind === "home"}
      <div
        class="tab"
        class:tab--home={isHome}
        class:tab--active={isActive}
        role="tab"
        aria-selected={isActive}
        tabindex={isActive ? 0 : -1}
        data-tab-id={tab.tabId}
        data-document-id={tab.kind === "document"
          ? String(tab.documentId)
          : undefined}
        title={isHome ? "Home" : tab.canonicalPath}
        onclick={() => {
          if (tab.tabId !== store.activeTabId) {
            void actions.selectTab(tab.tabId);
          }
        }}
        onmousedown={(event) => {
          if (event.button === 1) {
            event.preventDefault();
          }
        }}
        onauxclick={(event) => {
          if (event.button === 1) {
            event.preventDefault();
            void actions.closeTab(tab.tabId);
          }
        }}
        onkeydown={(event) => handleTabKeyDown(event, tab.tabId)}
      >
        {#if isHome}
          <HomeIcon />
        {/if}
        <span class="tab-title">{tab.title}</span>
        <button
          type="button"
          class="tab-close-btn"
          aria-label={isHome ? "Close Home tab" : `Close ${tab.title}`}
          title="Close tab (Ctrl+W)"
          onclick={(event) => {
            event.stopPropagation();
            void actions.closeTab(tab.tabId);
          }}
        >
          <CloseIcon size={11} />
        </button>
      </div>
    {/each}
  </div>

  <button
    id="tab-add-btn"
    class="tab-add-btn"
    type="button"
    title="New Home tab"
    aria-label="Open Home tab"
    hidden={!store.hasAnyTabs}
    onclick={() => void actions.openHomeTab()}
  >
    <PlusIcon size={14} />
  </button>

  <div class="tab-strip-drag" data-tauri-drag-region></div>

  <WindowControls {store} {actions} {windowControls} />
</div>

<style>
  .tab-strip {
    display: flex;
    align-items: flex-end;
    height: var(--tab-strip-height);
    padding: 0;
    gap: 2px;
    background-color: var(--surface-chrome);
    border-bottom: 1px solid var(--border-subtle);
  }

  .tab-strip--empty {
    border-bottom-color: transparent;
  }

  .tab-strip-brand {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    align-self: stretch;
    padding: 0 6px 0 10px;
  }

  .tab-strip-logo {
    display: block;
    width: 16px;
    height: 16px;
    object-fit: contain;
    pointer-events: none;
  }

  .tab-strip-drag {
    flex: 1 0 36px;
    align-self: stretch;
    min-width: 36px;
  }

  .tab-list {
    position: relative;
    display: flex;
    align-items: flex-end;
    flex: 0 1 auto;
    min-width: 0;
    height: 100%;
    gap: 2px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  .tab-list::-webkit-scrollbar {
    display: none;
  }

  .tab {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 1 auto;
    width: max-content;
    min-width: 112px;
    max-width: 240px;
    height: 28px;
    padding: 0 6px 0 11px;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: 5px 5px 0 0;
    background: transparent;
    color: var(--ink-muted);
    cursor: pointer;
    transition:
      background-color 120ms ease,
      color 120ms ease;
  }

  .tab:hover {
    background-color: var(--hover-subtle);
    color: var(--ink-primary);
  }

  .tab--active {
    height: 29px;
    margin-bottom: -1px;
    padding-bottom: 1px;
    background-color: var(--surface-paper);
    color: var(--ink-primary);
    border-color: var(--border-subtle);
    box-shadow: inset 0 2px 0 0 var(--accent-cobalt);
  }

  .tab--active:hover {
    background-color: var(--surface-paper);
  }

  :global(.tab-list--reordering) .tab {
    transition: transform 140ms cubic-bezier(0.2, 0, 0, 1);
  }

  :global(.tab-list--reordering)
    .tab:hover:not(.tab--active):not(:global(.tab--dragging)) {
    background-color: transparent;
    color: var(--ink-muted);
  }

  :global(.tab-list--reordering) .tab-close-btn {
    pointer-events: none;
  }

  .tab:global(.tab--dragging) {
    z-index: 5;
    background-color: var(--surface-paper);
    color: var(--ink-primary);
    border-color: var(--border-strong);
    box-shadow: 0 2px 6px rgba(26, 31, 43, 0.12);
    transition: none;
    cursor: default;
  }

  .tab--active:global(.tab--dragging) {
    box-shadow:
      inset 0 2px 0 0 var(--accent-cobalt),
      0 2px 6px rgba(26, 31, 43, 0.12);
  }

  .tab--home {
    min-width: 92px;
    padding: 0 6px 0 9px;
  }

  .tab--home.tab--active {
    height: 28px;
    margin-bottom: 0;
    padding-bottom: 0;
  }

  :global(.tab-home-icon) {
    flex: 0 0 auto;
    color: var(--ink-muted);
    transition: color 120ms ease;
  }

  .tab--home:hover :global(.tab-home-icon),
  .tab--home.tab--active :global(.tab-home-icon) {
    color: var(--ink-primary);
  }

  .tab-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12.5px;
    font-weight: 450;
    text-align: left;
  }

  .tab--active .tab-title {
    font-weight: 550;
  }

  .tab-close-btn {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--ink-muted);
    cursor: pointer;
    opacity: 0.72;
    transition:
      background-color 120ms ease,
      color 120ms ease,
      opacity 120ms ease;
  }

  .tab--active .tab-close-btn,
  .tab:hover .tab-close-btn,
  .tab-close-btn:focus-visible {
    opacity: 1;
  }

  .tab-close-btn:hover {
    background-color: var(--active-subtle);
    color: var(--ink-primary);
  }

  .tab-add-btn {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    margin-bottom: 3px;
    margin-left: 2px;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--ink-muted);
    cursor: pointer;
    transition:
      background-color 120ms ease,
      color 120ms ease;
  }

  .tab-add-btn:hover {
    background-color: var(--hover-subtle);
    color: var(--ink-primary);
  }
</style>
