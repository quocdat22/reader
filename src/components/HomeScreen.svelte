<script lang="ts">
  import type { AppActions } from "../lib/state/actions";
  import type { AppStore } from "../lib/state/app-store.svelte";
  import CloseIcon from "./icons/CloseIcon.svelte";
  import RecentFiles from "./RecentFiles.svelte";

  interface Props {
    store: AppStore;
    actions: AppActions;
  }

  let { store, actions }: Props = $props();
  let openBtnEl = $state<HTMLButtonElement | null>(null);
  let errorActionBtnEl = $state<HTMLButtonElement | null>(null);
  let errorDismissBtnEl = $state<HTMLButtonElement | null>(null);

  const homeBanner = $derived(
    store.banner?.scope === "home" ? store.banner : null,
  );

  $effect(() => {
    const req = store.focusRequest;
    if (req?.target === "home_open" && store.shellMode !== "document") {
      openBtnEl?.focus();
    }
  });

  function handleDismissError(): void {
    const wasFocused = document.activeElement === errorDismissBtnEl;
    actions.dismissBanner();
    if (wasFocused) {
      openBtnEl?.focus();
    }
  }

  function handleErrorAction(): void {
    const wasFocused = document.activeElement === errorActionBtnEl;
    actions.triggerBannerAction();
    if (wasFocused) {
      openBtnEl?.focus();
    }
  }
</script>

<section
  id="empty-state"
  class="empty-state"
  aria-label="Open a document"
  hidden={store.shellMode === "document"}
>
  <div class="empty-inner">
    <header class="empty-header">
      <h1 class="empty-title">Reader</h1>
      <p class="empty-hint">Drop a PDF anywhere, or press Ctrl+O.</p>
      <div class="empty-cta-row">
        <button
          id="empty-open-btn"
          class="primary-btn"
          type="button"
          bind:this={openBtnEl}
          onclick={() => void actions.openViaDialog()}
        >
          Open PDF
        </button>
      </div>
    </header>

    {#if homeBanner}
      <div id="empty-error" class="inline-error" role="alert">
        <span id="empty-error-message" class="inline-error-message">
          {homeBanner.message}
        </span>
        <div class="inline-error-actions">
          {#if homeBanner.actionLabel && homeBanner.onAction}
            <button
              id="empty-error-action"
              class="inline-error-action"
              type="button"
              bind:this={errorActionBtnEl}
              onclick={handleErrorAction}
            >
              {homeBanner.actionLabel}
            </button>
          {/if}
          <button
            id="empty-error-dismiss"
            class="inline-error-dismiss"
            type="button"
            aria-label="Dismiss error"
            bind:this={errorDismissBtnEl}
            onclick={handleDismissError}
          >
            <CloseIcon size={12} />
          </button>
        </div>
      </div>
    {/if}

    <RecentFiles {store} {actions} />
  </div>
</section>

<style>
  .empty-state {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    justify-content: center;
    padding: 13vh 28px 40px;
    background-color: var(--surface-chrome);
  }

  .empty-inner {
    width: 100%;
    max-width: 500px;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .empty-header {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .empty-title {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.2;
    color: var(--ink-primary);
  }

  .empty-hint {
    margin: 0;
    font-size: 13.5px;
    color: var(--ink-muted);
  }

  .empty-cta-row {
    margin-top: 8px;
  }

  .primary-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 34px;
    padding: 0 16px;
    border: none;
    border-radius: var(--radius-md);
    background-color: var(--accent-cobalt);
    color: var(--surface-paper);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 120ms ease;
  }

  .primary-btn:hover {
    background-color: var(--accent-hover);
  }

  .primary-btn:focus-visible {
    outline: 2px solid var(--accent-cobalt);
    outline-offset: 2px;
  }

  .inline-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 9px 12px;
    border: 1px solid var(--error-border);
    border-radius: var(--radius-md);
    background-color: var(--error-bg);
    color: var(--error-ink);
    font-size: 12.5px;
  }

  .inline-error-message {
    flex: 1 1 auto;
    min-width: 0;
  }

  .inline-error-actions {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .inline-error-action {
    padding: 3px 8px;
    border: 1px solid var(--error-border);
    border-radius: var(--radius-sm);
    background-color: var(--surface-paper);
    color: var(--error-ink);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .inline-error-action:hover {
    background-color: var(--hover-subtle);
  }

  .inline-error-dismiss {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--error-ink);
    cursor: pointer;
  }

  .inline-error-dismiss:hover {
    background-color: rgba(154, 30, 21, 0.1);
  }

  @media (max-height: 540px) {
    .empty-state {
      padding-top: 8vh;
    }
  }
</style>
