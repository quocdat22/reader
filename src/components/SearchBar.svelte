<script lang="ts">
  import type { AppActions } from "../lib/state/actions";
  import type { AppStore } from "../lib/state/app-store.svelte";
  import ChevronIcon from "./icons/ChevronIcon.svelte";
  import CloseIcon from "./icons/CloseIcon.svelte";

  interface Props {
    store: AppStore;
    actions: AppActions;
    onBarElement?: (el: HTMLElement | null) => void;
  }

  let { store, actions, onBarElement }: Props = $props();
  let barEl = $state<HTMLDivElement | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);

  const search = $derived(store.activeDoc?.search ?? null);
  const hasMatches = $derived(Boolean(search && search.matches.length > 0));
  const isZeroMatches = $derived(
    Boolean(
      search &&
      search.query.trim().length > 0 &&
      search.status === "ready" &&
      search.matches.length === 0,
    ),
  );

  const countText = $derived.by(() => {
    if (!search || !search.open || search.query.trim().length === 0) {
      return "";
    }
    if (search.status === "searching") {
      return search.showSearchingLabel ? "Searching…" : "";
    }
    if (search.status === "error") {
      return "Search failed";
    }
    if (search.status === "ready") {
      if (search.matches.length > 0) {
        return `${search.currentIndex + 1} / ${search.matches.length}`;
      }
      return "0 / 0";
    }
    return "";
  });

  $effect(() => {
    onBarElement?.(barEl);
    return () => {
      onBarElement?.(null);
    };
  });

  $effect(() => {
    const req = store.focusRequest;
    if (req?.target === "search_input" && store.activeDoc?.search.open) {
      inputEl?.focus();
      inputEl?.select();
    }
  });

  function handleInputKeyDown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    if (
      event.key === "Enter" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      actions.stepSearchMatch(event.shiftKey ? -1 : 1);
    }
  }
</script>

<div
  id="search-bar"
  class="search-bar"
  role="search"
  aria-label="Find in document"
  hidden={!search?.open}
  bind:this={barEl}
>
  <input
    id="search-input"
    class="search-input"
    type="search"
    placeholder="Find in document"
    autocomplete="off"
    spellcheck={false}
    aria-label="Find in document"
    bind:this={inputEl}
    value={search?.query ?? ""}
    oninput={(event) => actions.setSearchQuery(event.currentTarget.value)}
    onkeydown={handleInputKeyDown}
  />

  <span
    id="search-count"
    class="search-count"
    class:search-count--error={search?.status === "error"}
    aria-live="polite"
    aria-label={isZeroMatches ? "No matches" : undefined}
  >
    {countText}
  </span>

  <div class="search-nav-group" role="group" aria-label="Match navigation">
    <button
      type="button"
      class="icon-btn search-nav-btn"
      aria-label="Previous match"
      title="Previous match (Shift+Enter)"
      disabled={!hasMatches}
      onclick={() => actions.stepSearchMatch(-1)}
    >
      <ChevronIcon direction="left" size={12} />
    </button>
    <button
      type="button"
      class="icon-btn search-nav-btn"
      aria-label="Next match"
      title="Next match (Enter)"
      disabled={!hasMatches}
      onclick={() => actions.stepSearchMatch(1)}
    >
      <ChevronIcon direction="right" size={12} />
    </button>
  </div>

  <button
    type="button"
    class="icon-btn search-close-btn"
    aria-label="Close search"
    title="Close search (Esc)"
    onclick={() => actions.closeSearch({ focusViewport: true })}
  >
    <CloseIcon size={11} />
  </button>
</div>

<style>
  .search-bar {
    position: absolute;
    top: 8px;
    right: 24px;
    z-index: 15;
    display: flex;
    align-items: center;
    gap: 4px;
    height: 34px;
    max-width: calc(100% - 36px);
    padding: 0 6px;
    background-color: var(--surface-paper);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    box-shadow: 0 2px 8px rgba(26, 31, 43, 0.12);
  }

  .search-input {
    flex: 1 1 176px;
    width: 176px;
    min-width: 88px;
    height: 24px;
    padding: 0 6px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--ink-primary);
    font-size: 12.5px;
    user-select: text;
  }

  .search-input::placeholder {
    color: var(--ink-muted);
  }

  .search-input:focus {
    border-color: var(--accent-cobalt);
  }

  .search-input::-webkit-search-cancel-button {
    -webkit-appearance: none;
  }

  .search-count {
    flex: 0 0 auto;
    min-width: 42px;
    padding: 0 4px;
    text-align: right;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--ink-muted);
    white-space: nowrap;
  }

  .search-count--error {
    color: var(--error-ink);
  }

  .search-nav-group {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 1px;
  }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--ink-muted);
    cursor: pointer;
    transition:
      background-color 120ms ease,
      color 120ms ease,
      border-color 120ms ease;
  }

  .icon-btn:hover:not(:disabled) {
    background-color: var(--hover-subtle);
    color: var(--ink-primary);
  }

  .icon-btn:active:not(:disabled) {
    background-color: var(--active-subtle);
  }

  .icon-btn:disabled {
    opacity: 0.36;
    cursor: default;
  }

  @media (max-width: 740px) {
    .search-bar {
      right: 18px;
      max-width: calc(100% - 28px);
    }

    .search-input {
      width: 132px;
    }
  }
</style>
