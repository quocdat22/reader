/**
 * Centralized desktop keyboard and Ctrl+Wheel shortcut router.
 *
 * Implements all shortcuts defined in docs/SPEC.md Section 5 while preserving
 * native text editing inside inputs and tree navigation inside the TOC drawer.
 */

const WHEEL_ZOOM_THRESHOLD = 24;
const WHEEL_ZOOM_RESET_MS = 180;

function isEditableElement(target) {
  if (!(target instanceof Element)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  return Boolean(target.closest("[contenteditable=''], [contenteditable='true']"));
}

function isPrimaryButtonOrLink(target) {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(target.closest("button, a[href], [role='tab']"));
}

function getShortcutDigit(event) {
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

function isZoomInKey(event) {
  return (
    event.key === "+" ||
    event.key === "=" ||
    event.code === "Equal" ||
    event.code === "NumpadAdd"
  );
}

function isZoomOutKey(event) {
  return (
    event.key === "-" ||
    event.key === "_" ||
    event.code === "Minus" ||
    event.code === "NumpadSubtract"
  );
}

function isZoomResetKey(event) {
  return (
    !event.shiftKey &&
    (event.key === "0" || event.code === "Digit0" || event.code === "Numpad0")
  );
}

/**
 * Installs window-level keyboard and Ctrl+Wheel listeners.
 *
 * @param {{
 *   viewportEl: HTMLElement,
 *   isInsideToc: (el: EventTarget | null) => boolean,
 *   isInsideSearch?: (el: EventTarget | null) => boolean,
 *   hasActiveTab: () => boolean,
 *   isSearchOpen?: () => boolean,
 *   onOpenFile: () => void,
 *   onCloseActiveTab: () => void,
 *   onSwitchAdjacentTab: (delta: 1 | -1) => void,
 *   onJumpToTabNumber: (digit: number) => void,
 *   onOpenSearch?: () => void,
 *   onCloseSearch?: () => void,
 *   onNextSearchMatch?: () => void,
 *   onPrevSearchMatch?: () => void,
 *   onFocusPageInput: () => void,
 *   onToggleToc: () => void,
 *   onZoomStep: (direction: 1 | -1) => void,
 *   onResetZoom: () => void,
 *   onNavigateViewport: (action: "page_down" | "page_up" | "home" | "end") => void,
 *   onEscape: () => void,
 * }} handlers
 * @returns {() => void} Cleanup function removing installed listeners.
 */
export function installShortcuts({
  viewportEl,
  isInsideToc,
  isInsideSearch = () => false,
  hasActiveTab,
  isSearchOpen = () => false,
  onOpenFile,
  onCloseActiveTab,
  onSwitchAdjacentTab,
  onJumpToTabNumber,
  onOpenSearch,
  onCloseSearch,
  onNextSearchMatch,
  onPrevSearchMatch,
  onFocusPageInput,
  onToggleToc,
  onZoomStep,
  onResetZoom,
  onNavigateViewport,
  onEscape,
}) {
  let wheelAccumulator = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let wheelResetTimer = null;

  function resetWheelAccumulator() {
    wheelAccumulator = 0;
    if (wheelResetTimer !== null) {
      clearTimeout(wheelResetTimer);
      wheelResetTimer = null;
    }
  }

  function handleKeyDown(event) {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) {
      return;
    }

    const primaryMod = event.ctrlKey || event.metaKey;
    const target = event.target;
    const inEditable = isEditableElement(target);

    // Global Escape handling (works inside inputs, search bar, TOC drawer, or toolbar).
    if (event.key === "Escape" && !primaryMod && !event.altKey && !event.shiftKey) {
      if (inEditable && !isInsideSearch(target)) {
        onEscape();
        return;
      }
      if (isSearchOpen()) {
        event.preventDefault();
        onCloseSearch?.();
        return;
      }
      if (inEditable || isInsideToc(target) || hasActiveTab()) {
        onEscape();
      }
      return;
    }

    // Ctrl+Tab / Ctrl+Shift+Tab switch tabs across platforms (uses physical Ctrl key).
    if (event.ctrlKey && !event.altKey && !event.metaKey && event.key === "Tab") {
      if (hasActiveTab()) {
        event.preventDefault();
        onSwitchAdjacentTab(event.shiftKey ? -1 : 1);
      }
      return;
    }

    // Primary modifier chords (Ctrl on Windows/Linux, Cmd on macOS).
    // Guard against AltGr on Windows (which sets both ctrlKey and altKey).
    if (primaryMod && !event.altKey) {
      const lower = event.key.toLowerCase();

      if (!event.shiftKey && lower === "o") {
        event.preventDefault();
        onOpenFile();
        return;
      }

      if (!event.shiftKey && lower === "w") {
        if (hasActiveTab()) {
          event.preventDefault();
          onCloseActiveTab();
        }
        return;
      }

      if (isZoomInKey(event)) {
        event.preventDefault();
        if (hasActiveTab()) {
          onZoomStep(1);
        }
        return;
      }

      if (isZoomOutKey(event)) {
        event.preventDefault();
        if (hasActiveTab()) {
          onZoomStep(-1);
        }
        return;
      }

      if (isZoomResetKey(event)) {
        event.preventDefault();
        if (hasActiveTab()) {
          onResetZoom();
        }
        return;
      }

      if (!event.shiftKey && lower === "f") {
        // Always prevent WebView2's built-in find bar, even on the empty state.
        event.preventDefault();
        if (hasActiveTab()) {
          onOpenSearch?.();
        }
        return;
      }

      if (!event.shiftKey && lower === "g") {
        if (hasActiveTab()) {
          event.preventDefault();
          onFocusPageInput();
        }
        return;
      }

      if (!event.shiftKey && lower === "b") {
        if (hasActiveTab()) {
          event.preventDefault();
          onToggleToc();
        }
        return;
      }

      if (!event.shiftKey) {
        const digit = getShortcutDigit(event);
        if (digit !== null && hasActiveTab()) {
          event.preventDefault();
          onJumpToTabNumber(digit);
          return;
        }
      }

      return;
    }

    // Non-modifier shortcuts must never hijack typing inside inputs or Alt combos.
    if (inEditable || event.altKey) {
      return;
    }

    // Enter / Shift+Enter cycle search matches when search is active and focus is not on a button/tree.
    if (
      event.key === "Enter" &&
      isSearchOpen() &&
      !isInsideToc(target) &&
      !isPrimaryButtonOrLink(target)
    ) {
      event.preventDefault();
      if (event.shiftKey) {
        onPrevSearchMatch?.();
      } else {
        onNextSearchMatch?.();
      }
      return;
    }

    if (event.shiftKey || !hasActiveTab() || isInsideToc(target)) {
      return;
    }

    if (event.key === "PageDown") {
      event.preventDefault();
      onNavigateViewport("page_down");
    } else if (event.key === "PageUp") {
      event.preventDefault();
      onNavigateViewport("page_up");
    } else if (event.key === "Home") {
      event.preventDefault();
      onNavigateViewport("home");
    } else if (event.key === "End") {
      event.preventDefault();
      onNavigateViewport("end");
    }
  }

  function handleWheel(event) {
    if (!(event.ctrlKey || event.metaKey)) {
      return;
    }

    // Always block browser-level CSS page zoom in WebView2 so toolbar chrome stays crisp.
    event.preventDefault();

    if (!hasActiveTab()) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Node) || !viewportEl.contains(target)) {
      return;
    }

    if (event.deltaY === 0) {
      return;
    }

    // Mouse wheel clicks exceed threshold immediately; trackpad pinch accumulates smoothly.
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
      const direction = wheelAccumulator < 0 ? 1 : -1;
      wheelAccumulator = 0;
      onZoomStep(direction);
    }
  }

  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("wheel", handleWheel, { passive: false });

  return () => {
    resetWheelAccumulator();
    window.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("wheel", handleWheel);
  };
}
