<script lang="ts">
  import type { WindowControlsApi } from "../lib/ipc/client";
  import type { AppActions } from "../lib/state/actions";
  import type { AppStore } from "../lib/state/app-store.svelte";

  interface Props {
    store: AppStore;
    actions: AppActions;
    windowControls: WindowControlsApi;
  }

  let { store, actions, windowControls }: Props = $props();

  async function syncMaximizeState(): Promise<void> {
    try {
      const maximized = await windowControls.isMaximized();
      actions.setWindowMaximized(maximized);
    } catch (err) {
      console.error("Failed to query window maximize state:", err);
    }
  }

  $effect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;

    void syncMaximizeState();
    void windowControls
      .onResized(() => {
        if (active) {
          void syncMaximizeState();
        }
      })
      .then((fn) => {
        if (active) {
          unlisten = fn;
        } else {
          fn();
        }
      })
      .catch((err) => {
        console.error("Failed to subscribe to window resize events:", err);
      });

    return () => {
      active = false;
      unlisten?.();
    };
  });

  async function handleToggleMaximize(): Promise<void> {
    try {
      await windowControls.toggleMaximize();
      await syncMaximizeState();
    } catch (err) {
      console.error("Failed to toggle maximize state:", err);
    }
  }

  async function handleCloseWindow(): Promise<void> {
    await actions.flushActiveReadingState();
    await windowControls.close();
  }

  const maxLabel = $derived(store.isWindowMaximized ? "Restore" : "Maximize");
</script>

<div
  id="window-controls"
  class="window-controls"
  role="group"
  aria-label="Window controls"
>
  <button
    id="win-min-btn"
    class="win-btn win-btn--min"
    type="button"
    title="Minimize"
    aria-label="Minimize window"
    onclick={() => void windowControls.minimize()}
  >
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      <path d="M1 5h8" stroke="currentColor" stroke-width="1.1" />
    </svg>
  </button>
  <button
    id="win-max-btn"
    class="win-btn win-btn--max"
    type="button"
    data-maximized={String(store.isWindowMaximized)}
    title={maxLabel}
    aria-label={`${maxLabel} window`}
    onclick={() => void handleToggleMaximize()}
  >
    <svg
      class="win-icon-max"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="1.5"
        y="1.5"
        width="7"
        height="7"
        stroke="currentColor"
        stroke-width="1.1"
      />
    </svg>
    <svg
      class="win-icon-restore"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      <path d="M3 3V1.5h5.5V7H7" stroke="currentColor" stroke-width="1.1" />
      <rect
        x="1.5"
        y="3"
        width="5.5"
        height="5.5"
        stroke="currentColor"
        stroke-width="1.1"
      />
    </svg>
  </button>
  <button
    id="win-close-btn"
    class="win-btn win-btn--close"
    type="button"
    title="Close"
    aria-label="Close window"
    onclick={() => void handleCloseWindow()}
  >
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M1.5 1.5l7 7M8.5 1.5l-7 7"
        stroke="currentColor"
        stroke-width="1.15"
        stroke-linecap="round"
      />
    </svg>
  </button>
</div>

<style>
  .window-controls {
    flex: 0 0 auto;
    display: flex;
    align-items: stretch;
    align-self: stretch;
  }

  .win-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 42px;
    height: 100%;
    padding: 0;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--ink-muted);
    cursor: pointer;
    transition:
      background-color 110ms ease,
      color 110ms ease;
  }

  .win-btn:hover {
    background-color: var(--hover-subtle);
    color: var(--ink-primary);
  }

  .win-btn:active {
    background-color: var(--active-subtle);
  }

  .win-btn--close:hover {
    background-color: #c42b1c;
    color: var(--surface-paper);
  }

  .win-btn--close:active {
    background-color: #b22719;
    color: var(--surface-paper);
  }

  .win-icon-restore {
    display: none;
  }

  .win-btn--max[data-maximized="true"] .win-icon-max {
    display: none;
  }

  .win-btn--max[data-maximized="true"] .win-icon-restore {
    display: block;
  }
</style>
