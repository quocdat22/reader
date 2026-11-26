<script lang="ts">
  import { tick } from "svelte";
  import { splitParentDirectory } from "../lib/domain/title";
  import type { AppActions } from "../lib/state/actions";
  import type { AppStore } from "../lib/state/app-store.svelte";
  import ChevronIcon from "./icons/ChevronIcon.svelte";
  import CloseIcon from "./icons/CloseIcon.svelte";
  import SearchIcon from "./icons/SearchIcon.svelte";

  interface Props {
    store: AppStore;
    actions: AppActions;
  }

  let { store, actions }: Props = $props();
  let searchInputEl = $state<HTMLInputElement | null>(null);
  let recentListEl = $state<HTMLUListElement | null>(null);
  let prevBtnEl = $state<HTMLButtonElement | null>(null);
  let nextBtnEl = $state<HTMLButtonElement | null>(null);
  let pageListEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    const req = store.focusRequest;
    if (
      req?.target === "recent_search" &&
      store.shellMode !== "document" &&
      store.recents.length > 0
    ) {
      searchInputEl?.focus();
      searchInputEl?.select();
    }
  });

  function handleSearchKeyDown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    if (
      event.key === "Escape" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      if (store.recentQuery.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        actions.clearRecentSearch();
        searchInputEl?.focus();
      }
      return;
    }
    if (
      event.key === "ArrowDown" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      const firstRowBtn = recentListEl?.querySelector(".recent-row-btn");
      if (firstRowBtn instanceof HTMLButtonElement) {
        event.preventDefault();
        firstRowBtn.focus();
      }
    }
  }

  function handleClearSearch(): void {
    actions.clearRecentSearch();
    searchInputEl?.focus();
  }

  function selectPage(pageNum: number, preserveTargetFocus = false): void {
    const wasPrevFocused = document.activeElement === prevBtnEl;
    const wasNextFocused = document.activeElement === nextBtnEl;

    actions.setRecentPage(pageNum);

    void tick().then(() => {
      if (preserveTargetFocus && pageListEl) {
        for (const child of Array.from(pageListEl.children)) {
          if (
            child instanceof HTMLButtonElement &&
            child.dataset.pageNum === String(store.clampedRecentPage)
          ) {
            child.focus();
            return;
          }
        }
      }
      if (wasPrevFocused && prevBtnEl?.disabled) {
        nextBtnEl?.focus();
      } else if (wasNextFocused && nextBtnEl?.disabled) {
        prevBtnEl?.focus();
      }
    });
  }
</script>

<section
  id="recent-section"
  class="recent-section"
  aria-labelledby="recent-heading"
  hidden={store.recents.length === 0}
>
  <div class="recent-header">
    <div class="recent-heading-group">
      <h2 id="recent-heading" class="recent-heading">Recent</h2>
      <span
        id="recent-range"
        class="recent-range"
        hidden={!store.recentRangeLabel}
      >
        {store.recentRangeLabel ?? ""}
      </span>
    </div>
    <div class="recent-controls">
      <div class="recent-search" role="search" aria-label="Search recent files">
        <SearchIcon size={12} className="recent-search-icon" />
        <input
          id="recent-search-input"
          class="recent-search-input"
          type="search"
          placeholder="Search recent"
          autocomplete="off"
          spellcheck="false"
          aria-label="Search recent files"
          bind:this={searchInputEl}
          value={store.recentQuery}
          oninput={(event) => actions.setRecentQuery(event.currentTarget.value)}
          onkeydown={handleSearchKeyDown}
        />
        <button
          id="recent-search-clear"
          class="recent-search-clear"
          type="button"
          title="Clear search"
          aria-label="Clear search"
          hidden={store.recentQuery.length === 0}
          onclick={handleClearSearch}
        >
          <CloseIcon size={10} />
        </button>
      </div>

      <nav
        id="recent-pagination"
        class="recent-pagination"
        aria-label="Recent files pages"
        hidden={store.totalRecentPages <= 1}
      >
        <button
          id="recent-prev-btn"
          class="recent-page-btn recent-page-nav"
          type="button"
          title="Previous page"
          aria-label="Previous page"
          bind:this={prevBtnEl}
          disabled={store.clampedRecentPage <= 1}
          onclick={() => {
            if (store.clampedRecentPage > 1) {
              selectPage(store.clampedRecentPage - 1);
            }
          }}
        >
          <ChevronIcon direction="left" size={12} />
        </button>
        <div
          id="recent-page-list"
          class="recent-page-list"
          bind:this={pageListEl}
        >
          {#each store.visibleRecentPageItems as entry, idx (entry === "ellipsis" ? `ellipsis-${idx}` : `page-${entry}`)}
            {#if entry === "ellipsis"}
              <span class="recent-page-ellipsis" aria-hidden="true">…</span>
            {:else}
              {@const isCurrent = entry === store.clampedRecentPage}
              <button
                type="button"
                class="recent-page-btn"
                class:recent-page-btn--active={isCurrent}
                aria-label={`Page ${entry}`}
                aria-current={isCurrent ? "page" : undefined}
                data-page-num={String(entry)}
                onclick={() => {
                  if (entry !== store.clampedRecentPage) {
                    selectPage(entry, true);
                  }
                }}
              >
                {entry}
              </button>
            {/if}
          {/each}
        </div>
        <button
          id="recent-next-btn"
          class="recent-page-btn recent-page-nav"
          type="button"
          title="Next page"
          aria-label="Next page"
          bind:this={nextBtnEl}
          disabled={store.clampedRecentPage >= store.totalRecentPages}
          onclick={() => {
            if (store.clampedRecentPage < store.totalRecentPages) {
              selectPage(store.clampedRecentPage + 1);
            }
          }}
        >
          <ChevronIcon direction="right" size={12} />
        </button>
      </nav>
    </div>
  </div>

  <ul
    id="recent-list"
    class="recent-list"
    bind:this={recentListEl}
    hidden={store.filteredRecents.length === 0}
  >
    {#each store.pagedRecents as item (item.path)}
      {@const dirText = splitParentDirectory(item.path)}
      <li class="recent-item">
        <button
          type="button"
          class="recent-row-btn"
          title={item.path}
          onclick={() => {
            if (store.banner?.scope === "home") {
              actions.dismissBanner();
            }
            void actions.openPath(item.path, { fromRecent: true });
          }}
        >
          <span class="recent-main">
            <span class="recent-title">{item.title || item.path}</span>
            {#if dirText}
              <span class="recent-dir">{dirText}</span>
            {/if}
          </span>
          <span class="recent-progress">
            {#if item.page_count > 0}
              Page {Math.min(item.last_page + 1, item.page_count)} of {item.page_count}
            {/if}
          </span>
        </button>
        <button
          type="button"
          class="recent-remove-btn"
          aria-label={`Remove ${item.title || item.path} from recent`}
          title="Remove from recent"
          onclick={(event) => {
            event.stopPropagation();
            void actions.removeRecent(item.path);
          }}
        >
          <CloseIcon size={12} />
        </button>
      </li>
    {/each}
  </ul>

  <div
    id="recent-empty"
    class="recent-empty"
    hidden={store.filteredRecents.length > 0}
  >
    <span class="recent-empty-message">No matching recent files.</span>
  </div>
</section>

<style>
  .recent-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 12px;
    border-top: 1px solid var(--border-subtle);
  }

  .recent-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px 12px;
    margin-bottom: 4px;
    min-height: 24px;
  }

  .recent-heading-group {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: baseline;
    gap: 8px;
  }

  .recent-heading {
    margin: 0;
    font-size: 12.5px;
    font-weight: 550;
    color: var(--ink-muted);
  }

  .recent-range {
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--ink-muted);
    white-space: nowrap;
  }

  .recent-controls {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 6px 8px;
  }

  .recent-search {
    position: relative;
    flex: 0 1 176px;
    min-width: 124px;
    display: inline-flex;
    align-items: center;
    height: 24px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background-color: var(--surface-paper);
    color: var(--ink-primary);
    transition: border-color 120ms ease;
  }

  .recent-search:hover {
    border-color: var(--border-strong);
  }

  .recent-search:focus-within {
    border-color: var(--accent-cobalt);
  }

  .recent-search:has(.recent-search-input:focus-visible) {
    outline: 2px solid var(--accent-cobalt);
    outline-offset: -1px;
  }

  :global(.recent-search-icon) {
    position: absolute;
    left: 7px;
    color: var(--ink-muted);
    pointer-events: none;
  }

  .recent-search-input {
    width: 100%;
    height: 100%;
    min-width: 0;
    padding: 0 24px 0 24px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--ink-primary);
    font-size: 12px;
    user-select: text;
  }

  .recent-search-input::placeholder {
    color: var(--ink-muted);
  }

  .recent-search-input:focus-visible {
    outline: none;
  }

  .recent-search-input::-webkit-search-cancel-button {
    -webkit-appearance: none;
  }

  .recent-search-clear {
    position: absolute;
    right: 3px;
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
    transition:
      background-color 110ms ease,
      color 110ms ease;
  }

  .recent-search-clear:hover {
    background-color: var(--hover-subtle);
    color: var(--ink-primary);
  }

  .recent-pagination {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  .recent-page-list {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  .recent-page-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    height: 24px;
    padding: 0 6px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--ink-muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition:
      background-color 110ms ease,
      color 110ms ease;
  }

  .recent-page-nav {
    width: 24px;
    padding: 0;
  }

  .recent-page-btn:hover:not(:disabled) {
    background-color: var(--hover-subtle);
    color: var(--ink-primary);
  }

  .recent-page-btn:disabled {
    opacity: 0.38;
    cursor: default;
  }

  .recent-page-btn--active {
    background-color: var(--surface-paper);
    color: var(--ink-primary);
    font-weight: 550;
    box-shadow: 0 0 0 1px var(--border-subtle);
  }

  .recent-page-btn--active:hover:not(:disabled) {
    background-color: var(--surface-paper);
  }

  .recent-page-ellipsis {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 24px;
    font-size: 12px;
    color: var(--ink-muted);
    user-select: none;
  }

  .recent-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .recent-empty {
    padding: 12px 0;
    font-size: 13px;
    color: var(--ink-muted);
  }

  .recent-item {
    display: flex;
    align-items: center;
    gap: 6px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .recent-item:last-child {
    border-bottom: none;
  }

  .recent-row-btn {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    padding: 9px 8px;
    margin: 0 -8px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    text-align: left;
    cursor: pointer;
    transition: background-color 120ms ease;
  }

  .recent-row-btn:hover {
    background-color: var(--hover-subtle);
  }

  .recent-main {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .recent-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13.5px;
    font-weight: 500;
    color: var(--ink-primary);
  }

  .recent-dir {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--ink-muted);
  }

  .recent-progress {
    flex: 0 0 auto;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--ink-muted);
    white-space: nowrap;
  }

  .recent-remove-btn {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    margin-left: 4px;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--ink-muted);
    cursor: pointer;
    opacity: 0;
    transition:
      background-color 120ms ease,
      color 120ms ease,
      opacity 120ms ease;
  }

  .recent-item:hover .recent-remove-btn,
  .recent-item:focus-within .recent-remove-btn,
  .recent-remove-btn:focus-visible {
    opacity: 1;
  }

  .recent-remove-btn:hover {
    background-color: var(--active-subtle);
    color: var(--ink-primary);
  }
</style>
