<script lang="ts">
  import { untrack } from "svelte";
  import {
    HIGHLIGHT_COLORS,
    computePopoverPosition,
  } from "../lib/domain/highlights";
  import { HIGHLIGHT_CLICK_DRAG_THRESHOLD_PX } from "../lib/engines/highlight-layer";
  import type { HighlightColor } from "../lib/ipc/types";
  import type { AppActions } from "../lib/state/actions";
  import type { AppStore } from "../lib/state/app-store.svelte";
  import CopyIcon from "./icons/CopyIcon.svelte";
  import TrashIcon from "./icons/TrashIcon.svelte";

  const HIGHLIGHT_COLOR_LABELS: Record<HighlightColor, string> = {
    yellow: "Yellow",
    green: "Green",
    pink: "Pink",
  };

  interface Props {
    store: AppStore;
    actions: AppActions;
    getViewportEl?: () => HTMLElement | null;
    onPopoverElement?: (el: HTMLElement | null) => void;
  }

  let { store, actions, getViewportEl, onPopoverElement }: Props = $props();
  let popoverEl = $state<HTMLDivElement | null>(null);
  let popoverSize = $state({ width: 156, height: 32 });
  let containerSize = $state({ width: 800, height: 600 });

  const popover = $derived(store.activeHighlightPopover);
  const doc = $derived(store.activeDoc);
  const highlight = $derived.by(() => {
    if (!popover || !doc || doc.documentId !== popover.documentId) {
      return null;
    }
    return (
      doc.highlights.items.find((item) => item.id === popover.highlightId) ??
      null
    );
  });

  const position = $derived.by(() => {
    if (!popover) {
      return { left: 8, top: 8, placement: "above" as const };
    }
    return computePopoverPosition({
      anchorRect: popover.anchorRect,
      popoverWidth: popoverSize.width,
      popoverHeight: popoverSize.height,
      containerWidth: containerSize.width,
      containerHeight: containerSize.height,
    });
  });

  $effect(() => {
    onPopoverElement?.(popoverEl);
    return () => {
      onPopoverElement?.(null);
    };
  });

  $effect(() => {
    if (popover && !highlight) {
      actions.closeHighlightPopover();
    }
  });

  $effect(() => {
    const el = popoverEl;
    const activePopover = popover;
    if (!el || !activePopover) {
      return;
    }

    const hostEl = el.parentElement;
    const vpEl = getViewportEl?.() ?? null;

    const measuredWidth = el.offsetWidth || 156;
    const measuredHeight = el.offsetHeight || 32;
    const initialContainerW =
      vpEl?.clientWidth || hostEl?.clientWidth || window.innerWidth;
    const initialContainerH =
      vpEl?.clientHeight || hostEl?.clientHeight || window.innerHeight;

    untrack(() => {
      popoverSize = { width: measuredWidth, height: measuredHeight };
      containerSize = { width: initialContainerW, height: initialContainerH };
    });

    const initialHostW = hostEl?.clientWidth ?? 0;
    const initialHostH = hostEl?.clientHeight ?? 0;
    let viewportDragOrigin: { readonly x: number; readonly y: number } | null =
      null;

    const handleWindowResize = () => {
      actions.closeHighlightPopover();
    };

    const handleWindowPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && el.contains(target)) {
        return;
      }
      // Let `#viewport` manage highlight switching vs margin dismissal so click swaps stay flicker-free.
      if (vpEl && target instanceof Node && vpEl.contains(target)) {
        viewportDragOrigin = { x: event.clientX, y: event.clientY };
        return;
      }
      viewportDragOrigin = null;
      actions.closeHighlightPopover();
    };

    const handleWindowPointerMove = (event: PointerEvent) => {
      if (!viewportDragOrigin || (event.buttons & 1) === 0) {
        return;
      }
      const dist = Math.hypot(
        event.clientX - viewportDragOrigin.x,
        event.clientY - viewportDragOrigin.y,
      );
      if (dist > HIGHLIGHT_CLICK_DRAG_THRESHOLD_PX) {
        viewportDragOrigin = null;
        actions.closeHighlightPopover();
      }
    };

    const clearViewportDrag = () => {
      if (!viewportDragOrigin) {
        return;
      }
      viewportDragOrigin = null;
      if (typeof window.getSelection === "function") {
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
          actions.closeHighlightPopover();
        }
      }
    };

    const resizeObserver =
      typeof ResizeObserver === "function" && hostEl
        ? new ResizeObserver(() => {
            if (
              hostEl.clientWidth !== initialHostW ||
              hostEl.clientHeight !== initialHostH
            ) {
              actions.closeHighlightPopover();
            }
          })
        : null;
    if (resizeObserver && hostEl) {
      resizeObserver.observe(hostEl);
    }

    window.addEventListener("resize", handleWindowResize);
    window.addEventListener("pointerdown", handleWindowPointerDown, true);
    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", clearViewportDrag);
    window.addEventListener("pointercancel", clearViewportDrag);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", handleWindowResize);
      window.removeEventListener("pointerdown", handleWindowPointerDown, true);
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", clearViewportDrag);
      window.removeEventListener("pointercancel", clearViewportDrag);
    };
  });

  function handleColorSelect(color: HighlightColor): void {
    if (!popover) {
      return;
    }
    void actions.recolorHighlight(
      popover.documentId,
      popover.highlightId,
      color,
    );
  }

  function handleCopy(): void {
    if (!popover) {
      return;
    }
    void actions.copyHighlightQuote(popover.documentId, popover.highlightId);
    actions.closeHighlightPopover();
    actions.requestFocus("viewport");
  }

  function handleDelete(): void {
    if (!popover) {
      return;
    }
    void actions.deleteHighlight(popover.documentId, popover.highlightId);
    actions.requestFocus("viewport");
  }
</script>

{#if popover && highlight}
  <div
    id="highlight-popover"
    class="highlight-popover"
    role="toolbar"
    aria-label="Highlight actions"
    data-placement={position.placement}
    style:left={`${position.left}px`}
    style:top={`${position.top}px`}
    bind:this={popoverEl}
  >
    <div class="popover-swatches" role="group" aria-label="Highlight color">
      {#each HIGHLIGHT_COLORS as color (color)}
        {@const label = HIGHLIGHT_COLOR_LABELS[color]}
        <button
          type="button"
          class="popover-swatch-btn"
          aria-label={label}
          title={label}
          aria-pressed={highlight.color === color}
          onclick={() => handleColorSelect(color)}
        >
          <span class={`popover-dot popover-dot--${color}`} aria-hidden="true"
          ></span>
        </button>
      {/each}
    </div>

    <span class="popover-sep" aria-hidden="true"></span>

    <button
      type="button"
      id="highlight-copy-btn"
      class="popover-icon-btn"
      aria-label="Copy quote"
      title="Copy quote"
      onclick={handleCopy}
    >
      <CopyIcon />
    </button>

    <button
      type="button"
      id="highlight-delete-btn"
      class="popover-icon-btn popover-icon-btn--delete"
      aria-label="Delete highlight"
      title="Delete highlight (Del)"
      onclick={handleDelete}
    >
      <TrashIcon />
    </button>
  </div>
{/if}

<style>
  .highlight-popover {
    position: absolute;
    z-index: 15;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 32px;
    padding: 0 5px;
    background-color: var(--surface-paper);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    box-shadow:
      0 4px 12px rgba(26, 31, 43, 0.12),
      0 1px 3px rgba(26, 31, 43, 0.08);
    user-select: none;
  }

  .popover-swatches {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  .popover-swatch-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    cursor: pointer;
    transition: background-color 90ms ease;
  }

  .popover-swatch-btn:hover {
    background-color: var(--hover-subtle);
  }

  .popover-swatch-btn:focus-visible {
    outline-offset: -1px;
  }

  .popover-dot {
    display: block;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 1px solid transparent;
    transition: box-shadow 90ms ease;
  }

  .popover-dot--yellow {
    background-color: var(--hl-yellow-swatch);
    border-color: var(--hl-yellow-swatch-border);
  }

  .popover-dot--green {
    background-color: var(--hl-green-swatch);
    border-color: var(--hl-green-swatch-border);
  }

  .popover-dot--pink {
    background-color: var(--hl-pink-swatch);
    border-color: var(--hl-pink-swatch-border);
  }

  .popover-swatch-btn[aria-pressed="true"] .popover-dot {
    box-shadow:
      0 0 0 1.5px var(--surface-paper),
      0 0 0 3px var(--ink-primary);
  }

  .popover-sep {
    flex-shrink: 0;
    width: 1px;
    height: 16px;
    margin: 0 2px;
    background-color: var(--border-subtle);
  }

  .popover-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--ink-muted);
    cursor: pointer;
    transition:
      background-color 90ms ease,
      color 90ms ease;
  }

  .popover-icon-btn:hover {
    background-color: var(--hover-subtle);
    color: var(--ink-primary);
  }

  .popover-icon-btn:active {
    background-color: var(--active-subtle);
  }

  .popover-icon-btn--delete:hover,
  .popover-icon-btn--delete:focus-visible {
    background-color: var(--error-bg);
    color: var(--error-ink);
  }
</style>
