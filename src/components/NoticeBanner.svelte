<script lang="ts">
  import type { AppActions } from "../lib/state/actions";
  import type { AppStore } from "../lib/state/app-store.svelte";
  import CloseIcon from "./icons/CloseIcon.svelte";

  interface Props {
    store: AppStore;
    actions: AppActions;
  }

  let { store, actions }: Props = $props();
  let actionBtnEl = $state<HTMLButtonElement | null>(null);
  let dismissBtnEl = $state<HTMLButtonElement | null>(null);

  const workspaceBanner = $derived(
    store.banner?.scope === "workspace" ? store.banner : null,
  );

  function handleDismiss(): void {
    const wasFocused = document.activeElement === dismissBtnEl;
    actions.dismissBanner();
    if (wasFocused && store.activeDoc) {
      actions.requestFocus("viewport");
    }
  }

  function handleAction(): void {
    const wasFocused = document.activeElement === actionBtnEl;
    actions.triggerBannerAction();
    if (wasFocused && store.activeDoc) {
      actions.requestFocus("viewport");
    }
  }
</script>

{#if workspaceBanner}
  <div id="notice-banner" class="notice-banner" role="alert">
    <span id="notice-message" class="notice-message">
      {workspaceBanner.message}
    </span>
    <div class="notice-actions">
      {#if workspaceBanner.actionLabel && workspaceBanner.onAction}
        <button
          id="notice-action-btn"
          class="notice-action-btn"
          type="button"
          bind:this={actionBtnEl}
          onclick={handleAction}
        >
          {workspaceBanner.actionLabel}
        </button>
      {/if}
      <button
        id="notice-dismiss-btn"
        class="notice-dismiss-btn"
        type="button"
        aria-label="Dismiss message"
        bind:this={dismissBtnEl}
        onclick={handleDismiss}
      >
        <CloseIcon size={12} />
      </button>
    </div>
  </div>
{/if}

<style>
  .notice-banner {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 7px 14px;
    background-color: var(--error-bg);
    border-bottom: 1px solid var(--error-border);
    color: var(--error-ink);
    font-size: 12.5px;
  }

  .notice-message {
    flex: 1 1 auto;
    min-width: 0;
  }

  .notice-actions {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .notice-action-btn {
    padding: 3px 8px;
    border: 1px solid var(--error-border);
    border-radius: var(--radius-sm);
    background-color: var(--surface-paper);
    color: var(--error-ink);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .notice-action-btn:hover {
    background-color: var(--hover-subtle);
  }

  .notice-dismiss-btn {
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

  .notice-dismiss-btn:hover {
    background-color: rgba(154, 30, 21, 0.1);
  }
</style>
