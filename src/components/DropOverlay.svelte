<script lang="ts">
  import type { AppStore } from "../lib/state/app-store.svelte";

  interface Props {
    store: AppStore;
  }

  let { store }: Props = $props();
</script>

<div
  id="drop-overlay"
  class="drop-overlay"
  aria-hidden={!store.isDraggingFiles}
  hidden={!store.isDraggingFiles}
>
  <div class="drop-overlay-frame">
    <span class="drop-overlay-label">Drop PDF to open</span>
  </div>
</div>

<style>
  .drop-overlay {
    position: fixed;
    inset: 0;
    z-index: 50;
    padding: 12px;
    background-color: rgba(238, 240, 244, 0.68);
    pointer-events: none;
  }

  .drop-overlay-frame {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 2px solid var(--accent-cobalt);
    border-radius: var(--radius-md);
    background-color: rgba(30, 77, 183, 0.05);
  }

  .drop-overlay-label {
    padding: 8px 16px;
    border-radius: var(--radius-md);
    background-color: var(--surface-paper);
    border: 1px solid var(--border-subtle);
    color: var(--ink-primary);
    font-size: 13.5px;
    font-weight: 500;
    box-shadow: var(--sheet-shadow);
  }
</style>
