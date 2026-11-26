export const DRAG_THRESHOLD_PX = 5;
export const AUTO_SCROLL_EDGE_PX = 28;
export const AUTO_SCROLL_MAX_STEP_PX = 10;

export interface TabWidthItem {
  readonly width: number;
}

export interface TabReorderCommitMeta {
  readonly tabId: string;
  readonly scrollLeft: number;
}

export interface TabDragOptions {
  readonly disabled?: boolean;
  readonly onCommitReorder: (
    fromIndex: number,
    toIndex: number,
    meta: TabReorderCommitMeta,
  ) => void;
}

export interface TabDragController {
  update(options: TabDragOptions): void;
  shouldSuppressClick(tabId: string): boolean;
  cancel(): void;
  destroy(): void;
}

interface TabGeometryItem {
  readonly tabId: string;
  readonly el: HTMLElement;
  readonly left: number;
  readonly width: number;
}

interface DragSession {
  readonly tabId: string;
  readonly pointerId: number;
  readonly el: HTMLElement;
  readonly startClientX: number;
  lastClientX: number;
  readonly startScrollLeft: number;
  readonly startIndex: number;
  targetIndex: number;
  active: boolean;
  items: TabGeometryItem[];
  others: TabGeometryItem[];
  dragged: TabGeometryItem | null;
  minContentX: number;
  maxContentX: number;
  gapPx: number;
  rafId: number | null;
}

/**
 * Computes hypothetical `[left]` offsets for `others` (all non-dragged tabs)
 * when `draggedWidth` is placed at `targetIndex`.
 */
export function computeOtherVisualLefts(
  others: readonly TabWidthItem[],
  targetIndex: number,
  draggedWidth: number,
  minContentX: number,
  gapPx: number,
): number[] {
  const lefts: number[] = new Array<number>(others.length);
  let cursorX = minContentX;
  for (let i = 0; i < others.length; i += 1) {
    if (i === targetIndex) {
      cursorX += draggedWidth + gapPx;
    }
    const item = others[i];
    if (!item) {
      break;
    }
    lefts[i] = cursorX;
    cursorX += item.width + gapPx;
  }
  return lefts;
}

/**
 * Attaches horizontal Pointer Events tab drag-and-drop reordering (`CR-003`)
 * to `tabListEl`. Compatible with Svelte's `use:tabReorder` action contract.
 */
export function createTabDragController(
  tabListEl: HTMLElement,
  initialOptions: TabDragOptions,
): TabDragController {
  let options = initialOptions;
  let dragSession: DragSession | null = null;
  let suppressClickTabId: string | null = null;
  let suppressTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSuppressTimer(): void {
    if (suppressTimer !== null) {
      clearTimeout(suppressTimer);
      suppressTimer = null;
    }
  }

  function handleTabListScroll(): void {
    updateDragPositions();
  }

  function cleanupDragSession(): void {
    if (!dragSession) {
      return;
    }
    const session = dragSession;
    dragSession = null;

    if (session.rafId !== null) {
      cancelAnimationFrame(session.rafId);
    }

    window.removeEventListener("pointermove", handleWindowPointerMove);
    window.removeEventListener("pointerup", handleWindowPointerUp);
    window.removeEventListener("pointercancel", handleWindowPointerCancel);
    window.removeEventListener("keydown", handleWindowKeyDown, true);
    window.removeEventListener("blur", handleWindowBlur);
    tabListEl.removeEventListener("scroll", handleTabListScroll);

    if (session.active) {
      try {
        if (session.el.hasPointerCapture(session.pointerId)) {
          session.el.releasePointerCapture(session.pointerId);
        }
      } catch {
        // Ignore if pointer capture was already released.
      }
      tabListEl.classList.remove("tab-list--reordering");
      session.el.classList.remove("tab--dragging");
      for (const item of session.items) {
        item.el.style.transform = "";
      }
    }
  }

  function updateDragPositions(): void {
    if (!dragSession || !dragSession.active || !dragSession.dragged) {
      return;
    }

    const { items, others, dragged, minContentX, maxContentX, gapPx } =
      dragSession;
    const rawDelta =
      dragSession.lastClientX -
      dragSession.startClientX +
      (tabListEl.scrollLeft - dragSession.startScrollLeft);
    const minDelta = minContentX - dragged.left;
    const maxDelta = maxContentX - dragged.width - dragged.left;
    const clampedDelta = Math.max(minDelta, Math.min(maxDelta, rawDelta));

    dragged.el.style.transform = `translateX(${clampedDelta}px)`;

    const dragLeft = dragged.left + clampedDelta;
    const dragRight = dragLeft + dragged.width;

    let targetIndex = dragSession.targetIndex;
    let visualLefts = computeOtherVisualLefts(
      others,
      targetIndex,
      dragged.width,
      minContentX,
      gapPx,
    );

    // Step targetIndex iteratively so fast pointer sweeps cross multiple tabs in a single frame.
    for (let step = 0; step < items.length; step += 1) {
      let moved = false;
      if (targetIndex > 0) {
        const prevOther = others[targetIndex - 1];
        const prevLeft = visualLefts[targetIndex - 1];
        if (
          prevOther &&
          prevLeft !== undefined &&
          dragLeft < prevLeft + prevOther.width * 0.45
        ) {
          targetIndex -= 1;
          moved = true;
        }
      }
      if (!moved && targetIndex < items.length - 1) {
        const nextOther = others[targetIndex];
        const nextLeft = visualLefts[targetIndex];
        if (
          nextOther &&
          nextLeft !== undefined &&
          dragRight > nextLeft + nextOther.width * 0.55
        ) {
          targetIndex += 1;
          moved = true;
        }
      }
      if (!moved) {
        break;
      }
      visualLefts = computeOtherVisualLefts(
        others,
        targetIndex,
        dragged.width,
        minContentX,
        gapPx,
      );
    }

    dragSession.targetIndex = targetIndex;
    for (let i = 0; i < others.length; i += 1) {
      const other = others[i];
      const targetLeft = visualLefts[i];
      if (!other || targetLeft === undefined) {
        continue;
      }
      const shiftX = targetLeft - other.left;
      other.el.style.transform = shiftX === 0 ? "" : `translateX(${shiftX}px)`;
    }
  }

  function stepAutoScroll(): void {
    if (!dragSession || !dragSession.active) {
      return;
    }

    const maxScrollLeft = tabListEl.scrollWidth - tabListEl.clientWidth;
    if (maxScrollLeft > 0) {
      const rect = tabListEl.getBoundingClientRect();
      let scrollDelta = 0;

      if (
        dragSession.lastClientX < rect.left + AUTO_SCROLL_EDGE_PX &&
        tabListEl.scrollLeft > 0
      ) {
        const ratio = Math.min(
          1,
          (rect.left + AUTO_SCROLL_EDGE_PX - dragSession.lastClientX) /
            AUTO_SCROLL_EDGE_PX,
        );
        scrollDelta = -Math.max(1, Math.ceil(ratio * AUTO_SCROLL_MAX_STEP_PX));
      } else if (
        dragSession.lastClientX > rect.right - AUTO_SCROLL_EDGE_PX &&
        tabListEl.scrollLeft < maxScrollLeft
      ) {
        const ratio = Math.min(
          1,
          (dragSession.lastClientX - (rect.right - AUTO_SCROLL_EDGE_PX)) /
            AUTO_SCROLL_EDGE_PX,
        );
        scrollDelta = Math.max(1, Math.ceil(ratio * AUTO_SCROLL_MAX_STEP_PX));
      }

      if (scrollDelta !== 0) {
        tabListEl.scrollLeft += scrollDelta;
        updateDragPositions();
        dragSession.rafId = requestAnimationFrame(stepAutoScroll);
        return;
      }
    }

    dragSession.rafId = null;
  }

  function ensureAutoScrollRunning(): void {
    if (!dragSession || !dragSession.active || dragSession.rafId !== null) {
      return;
    }
    if (tabListEl.scrollWidth <= tabListEl.clientWidth) {
      return;
    }
    const rect = tabListEl.getBoundingClientRect();
    const nearLeft = dragSession.lastClientX < rect.left + AUTO_SCROLL_EDGE_PX;
    const nearRight =
      dragSession.lastClientX > rect.right - AUTO_SCROLL_EDGE_PX;
    if (nearLeft || nearRight) {
      dragSession.rafId = requestAnimationFrame(stepAutoScroll);
    }
  }

  function beginActiveDrag(session: DragSession): boolean {
    const tabEls = Array.from(tabListEl.querySelectorAll<HTMLElement>(".tab"));
    if (tabEls.length < 2) {
      cleanupDragSession();
      return false;
    }

    const items: TabGeometryItem[] = tabEls.map((el) => ({
      tabId: el.dataset.tabId ?? "",
      el,
      left: el.offsetLeft,
      width: el.offsetWidth,
    }));
    const dragged = items[session.startIndex];
    const firstItem = items[0];
    const lastItem = items[items.length - 1];
    if (
      !dragged ||
      !firstItem ||
      !lastItem ||
      dragged.tabId !== session.tabId
    ) {
      cleanupDragSession();
      return false;
    }

    const secondItem = items[1];
    const gapPx = secondItem
      ? Math.max(0, secondItem.left - (firstItem.left + firstItem.width))
      : 2;

    session.active = true;
    session.items = items;
    session.dragged = dragged;
    session.others = items.filter((_, idx) => idx !== session.startIndex);
    session.minContentX = firstItem.left;
    session.maxContentX = lastItem.left + lastItem.width;
    session.gapPx = gapPx;

    tabListEl.classList.add("tab-list--reordering");
    dragged.el.classList.add("tab--dragging");
    tabListEl.addEventListener("scroll", handleTabListScroll);

    try {
      dragged.el.setPointerCapture(session.pointerId);
    } catch {
      // Window listeners keep drag functional even if capture is rejected.
    }
    return true;
  }

  function handleWindowPointerMove(event: PointerEvent): void {
    if (!dragSession || event.pointerId !== dragSession.pointerId) {
      return;
    }
    dragSession.lastClientX = event.clientX;

    if (!dragSession.active) {
      if (
        Math.abs(event.clientX - dragSession.startClientX) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      if (!beginActiveDrag(dragSession)) {
        return;
      }
    }

    updateDragPositions();
    ensureAutoScrollRunning();
  }

  function handleWindowPointerUp(event: PointerEvent): void {
    if (!dragSession || event.pointerId !== dragSession.pointerId) {
      return;
    }

    const wasActive = dragSession.active;
    const { tabId, startIndex, targetIndex } = dragSession;
    const savedScrollLeft = tabListEl.scrollLeft;

    cleanupDragSession();

    if (!wasActive) {
      return;
    }

    suppressClickTabId = tabId;
    clearSuppressTimer();
    suppressTimer = setTimeout(() => {
      suppressTimer = null;
      if (suppressClickTabId === tabId) {
        suppressClickTabId = null;
      }
    }, 0);

    if (targetIndex !== startIndex) {
      options.onCommitReorder(startIndex, targetIndex, {
        tabId,
        scrollLeft: savedScrollLeft,
      });
    }
  }

  function handleWindowPointerCancel(event: PointerEvent): void {
    if (!dragSession || event.pointerId !== dragSession.pointerId) {
      return;
    }
    cleanupDragSession();
  }

  function handleWindowKeyDown(event: KeyboardEvent): void {
    if (!dragSession || !dragSession.active) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      cleanupDragSession();
    }
  }

  function handleWindowBlur(): void {
    if (dragSession) {
      cleanupDragSession();
    }
  }

  function handlePointerDown(event: PointerEvent): void {
    if (options.disabled || event.button !== 0) {
      return;
    }
    if (!(event.target instanceof Element)) {
      return;
    }
    if (event.target.closest(".tab-close-btn")) {
      return;
    }
    const tabEl = event.target.closest<HTMLElement>(".tab");
    if (!tabEl || !tabListEl.contains(tabEl)) {
      return;
    }

    const tabEls = Array.from(tabListEl.querySelectorAll<HTMLElement>(".tab"));
    if (tabEls.length < 2) {
      return;
    }

    const tabId = tabEl.dataset.tabId ?? "";
    const startIndex = tabEls.indexOf(tabEl);
    if (!tabId || startIndex === -1) {
      return;
    }

    cleanupDragSession();
    dragSession = {
      tabId,
      pointerId: event.pointerId,
      el: tabEl,
      startClientX: event.clientX,
      lastClientX: event.clientX,
      startScrollLeft: tabListEl.scrollLeft,
      startIndex,
      targetIndex: startIndex,
      active: false,
      items: [],
      others: [],
      dragged: null,
      minContentX: 0,
      maxContentX: 0,
      gapPx: 2,
      rafId: null,
    };

    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("pointercancel", handleWindowPointerCancel);
    window.addEventListener("keydown", handleWindowKeyDown, true);
    window.addEventListener("blur", handleWindowBlur);
  }

  function handleCaptureClick(event: MouseEvent): void {
    if (!suppressClickTabId || !(event.target instanceof Element)) {
      return;
    }
    const tabEl = event.target.closest<HTMLElement>(".tab");
    if (tabEl && tabEl.dataset.tabId === suppressClickTabId) {
      suppressClickTabId = null;
      clearSuppressTimer();
      event.preventDefault();
      event.stopPropagation();
    }
  }

  tabListEl.addEventListener("pointerdown", handlePointerDown);
  tabListEl.addEventListener("click", handleCaptureClick, true);

  function update(nextOptions: TabDragOptions): void {
    options = nextOptions;
    if (nextOptions.disabled && dragSession) {
      cleanupDragSession();
    }
  }

  function shouldSuppressClick(tabId: string): boolean {
    if (suppressClickTabId === tabId) {
      suppressClickTabId = null;
      clearSuppressTimer();
      return true;
    }
    return false;
  }

  function cancel(): void {
    cleanupDragSession();
  }

  function destroy(): void {
    clearSuppressTimer();
    suppressClickTabId = null;
    cleanupDragSession();
    tabListEl.removeEventListener("pointerdown", handlePointerDown);
    tabListEl.removeEventListener("click", handleCaptureClick, true);
  }

  return {
    update,
    shouldSuppressClick,
    cancel,
    destroy,
  };
}

/**
 * Svelte Action (`use:tabReorder={options}`) wrapping {@link createTabDragController}.
 */
export function tabReorder(
  node: HTMLElement,
  options: TabDragOptions,
): { update(nextOptions: TabDragOptions): void; destroy(): void } {
  const controller = createTabDragController(node, options);
  return {
    update: controller.update,
    destroy: controller.destroy,
  };
}
