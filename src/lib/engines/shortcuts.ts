import type { AppActions } from "../state/actions";
import type { AppStore } from "../state/app-store.svelte";

const WHEEL_ZOOM_THRESHOLD = 24;
const WHEEL_ZOOM_RESET_MS = 180;

export interface ShortcutRouterDeps {
  readonly store: AppStore;
  readonly actions: AppActions;
  readonly getViewportEl: () => HTMLElement | null;
  readonly isInsideToc: (target: EventTarget | null) => boolean;
  readonly isInsideSearch: (target: EventTarget | null) => boolean;
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  return Boolean(
    target.closest("[contenteditable=''], [contenteditable='true']"),
  );
}

function isPrimaryButtonOrLink(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(target.closest("button, a[href], [role='tab']"));
}

function getShortcutDigit(event: KeyboardEvent): number | null {
  if (event.key >= "1" && event.key <= "9") {
    return Number.parseInt(event.key, 10);
  }
  if (typeof event.code === "string" && event.code.startsWith("Digit")) {
    const parsed = Number.parseInt(event.code.slice(5), 10);
    if (parsed >= 1 && parsed <= 9) {
      return parsed;
    }
  }
  return null;
}

function isZoomInKey(event: KeyboardEvent): boolean {
  return (
    event.key === "+" ||
    event.key === "=" ||
    event.code === "Equal" ||
    event.code === "NumpadAdd"
  );
}

function isZoomOutKey(event: KeyboardEvent): boolean {
  return (
    event.key === "-" ||
    event.key === "_" ||
    event.code === "Minus" ||
    event.code === "NumpadSubtract"
  );
}

function isZoomResetKey(event: KeyboardEvent): boolean {
  return (
    !event.shiftKey &&
    (event.key === "0" || event.code === "Digit0" || event.code === "Numpad0")
  );
}

/**
 * Installs centralized window-level keyboard and `Ctrl+Wheel` shortcuts
 * wired directly to {@link AppStore} and {@link AppActions}.
 */
export function installShortcutRouter({
  store,
  actions,
  getViewportEl,
  isInsideToc,
  isInsideSearch,
}: ShortcutRouterDeps): () => void {
  let wheelAccumulator = 0;
  let wheelResetTimer: ReturnType<typeof setTimeout> | null = null;

  function resetWheelAccumulator(): void {
    wheelAccumulator = 0;
    if (wheelResetTimer !== null) {
      clearTimeout(wheelResetTimer);
      wheelResetTimer = null;
    }
  }

  function handleEscapeFocus(): void {
    const focused = document.activeElement;
    const viewportEl = getViewportEl();
    if (focused instanceof HTMLElement && focused !== viewportEl) {
      focused.blur();
    }
    if (store.activeDoc) {
      actions.requestFocus("viewport");
    }
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) {
      return;
    }

    const primaryMod = event.ctrlKey || event.metaKey;
    const target = event.target;
    const inEditable = isEditableElement(target);

    if (
      event.key === "Escape" &&
      !primaryMod &&
      !event.altKey &&
      !event.shiftKey
    ) {
      if (inEditable && !isInsideSearch(target)) {
        handleEscapeFocus();
        return;
      }
      if (store.activeDoc && store.activeDoc.search.open) {
        event.preventDefault();
        actions.closeSearch({ focusViewport: true });
        return;
      }
      if (inEditable || isInsideToc(target) || store.hasAnyTabs) {
        handleEscapeFocus();
      }
      return;
    }

    // Alt+ArrowLeft / Alt+ArrowRight navigate per-tab link/jump history (and suppress WebView back/forward).
    if (
      event.altKey &&
      !primaryMod &&
      !event.shiftKey &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      if (!inEditable) {
        event.preventDefault();
        if (store.activeDoc) {
          actions.navigateHistory(event.key === "ArrowLeft" ? -1 : 1);
        }
      }
      return;
    }

    // Ctrl+Tab / Ctrl+Shift+Tab switch tabs across platforms (uses physical Ctrl key).
    if (
      event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      event.key === "Tab"
    ) {
      if (store.hasAnyTabs) {
        event.preventDefault();
        const nextId = store.getAdjacentTabId(event.shiftKey ? -1 : 1);
        if (nextId !== null) {
          void actions.selectTab(nextId);
        }
      }
      return;
    }

    // Primary modifier chords (Ctrl on Windows/Linux, Cmd on macOS); guard AltGr.
    if (primaryMod && !event.altKey) {
      const lower = event.key.toLowerCase();

      if (!event.shiftKey && lower === "o") {
        event.preventDefault();
        void actions.openViaDialog();
        return;
      }

      if (!event.shiftKey && lower === "w") {
        const active = store.activeTab;
        if (active) {
          event.preventDefault();
          void actions.closeTab(active.tabId);
        }
        return;
      }

      if (isZoomInKey(event)) {
        event.preventDefault();
        if (store.activeDoc) {
          actions.requestZoomStep(1);
        }
        return;
      }

      if (isZoomOutKey(event)) {
        event.preventDefault();
        if (store.activeDoc) {
          actions.requestZoomStep(-1);
        }
        return;
      }

      if (isZoomResetKey(event)) {
        event.preventDefault();
        if (store.activeDoc) {
          actions.requestZoomMode("fit_width");
        }
        return;
      }

      if (!event.shiftKey && lower === "f") {
        // Always suppress WebView2's native find bar, even on Empty or Home screen.
        event.preventDefault();
        if (store.activeDoc) {
          actions.openSearch();
        } else {
          actions.focusHomeRecentSearch();
        }
        return;
      }

      if (!event.shiftKey && lower === "g") {
        if (store.activeDoc) {
          event.preventDefault();
          actions.requestFocus("page_input");
        }
        return;
      }

      if (!event.shiftKey && lower === "b") {
        if (store.activeDoc) {
          event.preventDefault();
          actions.toggleToc();
        }
        return;
      }

      if (!event.shiftKey) {
        const digit = getShortcutDigit(event);
        if (digit !== null && store.hasAnyTabs) {
          event.preventDefault();
          const targetId = store.getTabIdAtShortcutIndex(digit);
          if (targetId !== null) {
            void actions.selectTab(targetId);
          }
          return;
        }
      }

      return;
    }

    if (inEditable || event.altKey) {
      return;
    }

    if (
      event.key === "Enter" &&
      store.activeDoc &&
      store.activeDoc.search.open &&
      !isInsideToc(target) &&
      !isPrimaryButtonOrLink(target)
    ) {
      event.preventDefault();
      actions.stepSearchMatch(event.shiftKey ? -1 : 1);
      return;
    }

    if (event.shiftKey || !store.activeDoc || isInsideToc(target)) {
      return;
    }

    if (event.key === "PageDown") {
      event.preventDefault();
      actions.navigateViewport("page_down");
    } else if (event.key === "PageUp") {
      event.preventDefault();
      actions.navigateViewport("page_up");
    } else if (event.key === "Home") {
      event.preventDefault();
      actions.navigateViewport("home");
    } else if (event.key === "End") {
      event.preventDefault();
      actions.navigateViewport("end");
    }
  }

  function handleWheel(event: WheelEvent): void {
    if (!(event.ctrlKey || event.metaKey)) {
      return;
    }

    // Always block browser-level CSS page zoom in WebView2 so toolbar chrome stays crisp.
    event.preventDefault();

    if (!store.activeDoc) {
      return;
    }

    const viewportEl = getViewportEl();
    const target = event.target;
    if (
      !viewportEl ||
      !(target instanceof Node) ||
      !viewportEl.contains(target)
    ) {
      return;
    }

    if (event.deltaY === 0) {
      return;
    }

    if (
      wheelAccumulator !== 0 &&
      Math.sign(wheelAccumulator) !== Math.sign(event.deltaY)
    ) {
      wheelAccumulator = 0;
    }
    wheelAccumulator += event.deltaY;

    if (wheelResetTimer !== null) {
      clearTimeout(wheelResetTimer);
    }
    wheelResetTimer = setTimeout(() => {
      wheelAccumulator = 0;
      wheelResetTimer = null;
    }, WHEEL_ZOOM_RESET_MS);

    if (Math.abs(wheelAccumulator) >= WHEEL_ZOOM_THRESHOLD) {
      const direction: 1 | -1 = wheelAccumulator < 0 ? 1 : -1;
      wheelAccumulator = 0;
      actions.requestZoomStep(direction);
    }
  }

  function handleMouseNavBlock(event: MouseEvent): void {
    if (event.button === 3 || event.button === 4) {
      event.preventDefault();
    }
  }

  function handleMouseNavUp(event: MouseEvent): void {
    if (event.button === 3 || event.button === 4) {
      event.preventDefault();
      if (store.activeDoc) {
        actions.navigateHistory(event.button === 3 ? -1 : 1);
      }
    }
  }

  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("wheel", handleWheel, { passive: false });
  window.addEventListener("mousedown", handleMouseNavBlock);
  window.addEventListener("mouseup", handleMouseNavUp);
  window.addEventListener("auxclick", handleMouseNavBlock);

  return () => {
    resetWheelAccumulator();
    window.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("wheel", handleWheel);
    window.removeEventListener("mousedown", handleMouseNavBlock);
    window.removeEventListener("mouseup", handleMouseNavUp);
    window.removeEventListener("auxclick", handleMouseNavBlock);
  };
}
