<script lang="ts">
  import { MAX_ZOOM, MIN_ZOOM } from "../lib/domain/zoom";
  import type { AppActions } from "../lib/state/actions";
  import type { AppStore } from "../lib/state/app-store.svelte";
  import type { TransitionHooks } from "../lib/state/types";
  import ArrowIcon from "./icons/ArrowIcon.svelte";
  import FitPageIcon from "./icons/FitPageIcon.svelte";
  import FitWidthIcon from "./icons/FitWidthIcon.svelte";
  import FolderIcon from "./icons/FolderIcon.svelte";
  import MinusIcon from "./icons/MinusIcon.svelte";
  import PlusIcon from "./icons/PlusIcon.svelte";
  import SearchIcon from "./icons/SearchIcon.svelte";
  import TocIcon from "./icons/TocIcon.svelte";

  interface Props {
    store: AppStore;
    actions: AppActions;
    hooks: TransitionHooks;
  }

  let { store, actions, hooks }: Props = $props();
  let pageInputEl = $state<HTMLInputElement | null>(null);
  let inputFocused = $state(false);
  let inputDirty = $state(false);
  let pageDraft = $state("");

  const toolbarModel = $derived(store.toolbarModel);

  const displayPageValue = $derived.by(() => {
    if (inputFocused) {
      return pageDraft;
    }
    if (!toolbarModel || toolbarModel.pageCount <= 0) {
      return "";
    }
    return String(toolbarModel.pageIndex + 1);
  });

  function syncDraftToModel(): void {
    pageDraft =
      toolbarModel && toolbarModel.pageCount > 0
        ? String(toolbarModel.pageIndex + 1)
        : "";
    inputDirty = false;
  }

  function commitPageInput(): void {
    if (!toolbarModel || toolbarModel.pageCount <= 0) {
      syncDraftToModel();
      return;
    }

    const parsed = Number.parseInt(pageDraft.trim(), 10);
    if (!Number.isFinite(parsed)) {
      syncDraftToModel();
      return;
    }

    const clampedPageIndex = Math.max(
      0,
      Math.min(parsed - 1, toolbarModel.pageCount - 1),
    );
    inputDirty = false;
    pageDraft = String(clampedPageIndex + 1);
    actions.requestJumpToPage(clampedPageIndex);
  }

  function cancelPageInput(): void {
    syncDraftToModel();
    if (document.activeElement === pageInputEl) {
      pageInputEl?.blur();
    }
  }

  $effect(() => {
    hooks.cancelPageInput = cancelPageInput;
    return () => {
      if (hooks.cancelPageInput === cancelPageInput) {
        delete hooks.cancelPageInput;
      }
    };
  });

  $effect(() => {
    const req = store.focusRequest;
    if (req?.target === "page_input" && store.activeDoc) {
      pageInputEl?.focus();
      pageInputEl?.select();
    }
  });

  function handlePageKeyDown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      commitPageInput();
      pageInputEl?.blur();
      actions.requestFocus("viewport");
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelPageInput();
      actions.requestFocus("viewport");
    }
  }
</script>

<div
  id="toolbar"
  class="toolbar"
  role="toolbar"
  aria-label="Document controls"
  hidden={!toolbarModel}
>
  <div class="toolbar-group toolbar-group--left">
    <button
      id="toc-toggle-btn"
      class="icon-btn"
      type="button"
      title="Outline (Ctrl+B)"
      aria-label="Toggle outline"
      aria-controls="toc-drawer"
      aria-expanded={Boolean(toolbarModel?.tocOpen)}
      aria-pressed={Boolean(toolbarModel?.tocOpen)}
      onclick={() => actions.toggleToc()}
    >
      <TocIcon />
    </button>

    <span class="toolbar-sep" aria-hidden="true"></span>

    <button
      id="nav-back-btn"
      class="icon-btn"
      type="button"
      title="Back (Alt+Left)"
      aria-label="Back"
      disabled={!toolbarModel?.canGoBack}
      onclick={() => actions.navigateHistory(-1)}
    >
      <ArrowIcon direction="left" />
    </button>
    <button
      id="nav-forward-btn"
      class="icon-btn"
      type="button"
      title="Forward (Alt+Right)"
      aria-label="Forward"
      disabled={!toolbarModel?.canGoForward}
      onclick={() => actions.navigateHistory(1)}
    >
      <ArrowIcon direction="right" />
    </button>
  </div>

  <div class="toolbar-group toolbar-group--center">
    <label class="sr-only" for="page-input">Page number</label>
    <div class="page-control">
      <input
        id="page-input"
        class="page-input"
        type="text"
        inputmode="numeric"
        autocomplete="off"
        spellcheck="false"
        title="Go to page (Ctrl+G)"
        aria-label="Current page"
        bind:this={pageInputEl}
        value={displayPageValue}
        onfocus={() => {
          inputFocused = true;
          syncDraftToModel();
          pageInputEl?.select();
        }}
        oninput={(event) => {
          pageDraft = event.currentTarget.value;
          inputDirty = true;
        }}
        onkeydown={handlePageKeyDown}
        onblur={() => {
          inputFocused = false;
          if (inputDirty) {
            commitPageInput();
          } else {
            syncDraftToModel();
          }
        }}
      />
      <span class="page-divider" aria-hidden="true">/</span>
      <span id="page-total" class="page-total">
        {toolbarModel?.pageCount ?? 0}
      </span>
    </div>
  </div>

  <div class="toolbar-group toolbar-group--right">
    <div class="zoom-control" role="group" aria-label="Zoom">
      <button
        id="zoom-out-btn"
        class="icon-btn"
        type="button"
        title="Zoom out (Ctrl+-)"
        aria-label="Zoom out"
        disabled={!toolbarModel || toolbarModel.zoomScale <= MIN_ZOOM + 0.005}
        onclick={() => actions.requestZoomStep(-1)}
      >
        <MinusIcon />
      </button>
      <span id="zoom-value" class="zoom-value" aria-live="off">
        {Math.round((toolbarModel?.zoomScale ?? 1) * 100)}%
      </span>
      <button
        id="zoom-in-btn"
        class="icon-btn"
        type="button"
        title="Zoom in (Ctrl++)"
        aria-label="Zoom in"
        disabled={!toolbarModel || toolbarModel.zoomScale >= MAX_ZOOM - 0.005}
        onclick={() => actions.requestZoomStep(1)}
      >
        <PlusIcon size={14} />
      </button>
    </div>

    <span class="toolbar-sep" aria-hidden="true"></span>

    <div class="fit-control" role="group" aria-label="Fit mode">
      <button
        id="fit-width-btn"
        class="toolbar-btn"
        type="button"
        title="Fit width (Ctrl+0)"
        aria-label="Fit width"
        aria-pressed={toolbarModel?.zoomMode === "fit_width"}
        onclick={() => actions.requestZoomMode("fit_width")}
      >
        <FitWidthIcon />
        <span class="toolbar-btn-label">Fit width</span>
      </button>
      <button
        id="fit-page-btn"
        class="toolbar-btn"
        type="button"
        title="Fit page"
        aria-label="Fit page"
        aria-pressed={toolbarModel?.zoomMode === "fit_page"}
        onclick={() => actions.requestZoomMode("fit_page")}
      >
        <FitPageIcon />
        <span class="toolbar-btn-label">Fit page</span>
      </button>
    </div>

    <span class="toolbar-sep" aria-hidden="true"></span>

    <button
      id="search-toggle-btn"
      class="icon-btn"
      type="button"
      title="Find in document (Ctrl+F)"
      aria-label="Find in document"
      aria-controls="search-bar"
      aria-expanded={Boolean(toolbarModel?.searchOpen)}
      aria-pressed={Boolean(toolbarModel?.searchOpen)}
      onclick={() => actions.toggleSearch()}
    >
      <SearchIcon size={15} />
    </button>

    <button
      id="open-btn"
      class="toolbar-btn toolbar-btn--open"
      type="button"
      title="Open PDF (Ctrl+O)"
      aria-label="Open PDF"
      onclick={() => void actions.openViaDialog()}
    >
      <FolderIcon />
      <span class="toolbar-btn-label">Open</span>
    </button>
  </div>
</div>

<style>
  .toolbar {
    display: grid;
    grid-template-columns: minmax(max-content, 1fr) auto minmax(
        max-content,
        1fr
      );
    align-items: center;
    gap: 12px;
    height: var(--toolbar-height);
    padding: 0 10px;
    background-color: var(--surface-paper);
    border-bottom: 1px solid var(--border-subtle);
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  .toolbar::-webkit-scrollbar {
    display: none;
  }

  .toolbar-group {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: max-content;
  }

  .toolbar-group--left {
    justify-content: flex-start;
  }

  .toolbar-group--center {
    justify-self: center;
  }

  .toolbar-group--right {
    justify-content: flex-end;
  }

  .toolbar-sep {
    flex-shrink: 0;
    width: 1px;
    height: 16px;
    margin: 0 3px;
    background-color: var(--border-subtle);
  }

  .icon-btn,
  .toolbar-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    height: 26px;
    padding: 0 6px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--ink-muted);
    font-size: 12.5px;
    font-weight: 450;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background-color 120ms ease,
      color 120ms ease,
      border-color 120ms ease;
  }

  .icon-btn {
    width: 26px;
    padding: 0;
  }

  .icon-btn:hover:not(:disabled),
  .toolbar-btn:hover:not(:disabled) {
    background-color: var(--hover-subtle);
    color: var(--ink-primary);
  }

  .icon-btn:active:not(:disabled),
  .toolbar-btn:active:not(:disabled) {
    background-color: var(--active-subtle);
  }

  .icon-btn:disabled,
  .toolbar-btn:disabled {
    opacity: 0.36;
    cursor: default;
  }

  .toolbar-btn[aria-pressed="true"],
  .icon-btn[aria-pressed="true"] {
    background-color: var(--accent-tint);
    color: var(--accent-cobalt);
  }

  .toolbar-btn--open {
    color: var(--ink-primary);
    padding: 0 8px;
  }

  .page-control {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-variant-numeric: tabular-nums;
    font-size: 12.5px;
    color: var(--ink-muted);
  }

  .page-input {
    width: 48px;
    height: 24px;
    padding: 0 6px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background-color: var(--surface-paper);
    color: var(--ink-primary);
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
    text-align: center;
    user-select: text;
    transition: border-color 120ms ease;
  }

  .page-input:hover {
    border-color: var(--border-strong);
  }

  .page-input:focus {
    border-color: var(--accent-cobalt);
  }

  .page-divider {
    opacity: 0.65;
  }

  .page-total {
    min-width: 24px;
    color: var(--ink-muted);
    white-space: nowrap;
  }

  .zoom-control,
  .fit-control {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  .zoom-value {
    min-width: 44px;
    text-align: center;
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
    color: var(--ink-primary);
    white-space: nowrap;
  }

  @media (max-width: 740px) {
    .toolbar {
      padding: 0 6px;
      gap: 6px;
    }

    .toolbar-btn-label {
      display: none;
    }

    .toolbar-btn,
    .toolbar-btn--open {
      width: 26px;
      padding: 0;
    }

    .toolbar-sep {
      margin: 0 2px;
    }

    .page-input {
      width: 42px;
    }

    .zoom-value {
      min-width: 38px;
    }
  }
</style>
