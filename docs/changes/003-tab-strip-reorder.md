# CR-003: Tab-Strip Drag-and-Drop & Keyboard Reordering

- **ID**: `CR-003`
- **Status**: Implemented
- **Scope**: Frontend only (`src/tabs.js`, `src/styles.css`). Zero changes to Rust backend, MuPDF worker, or Tauri IPC commands.
- **Supersedes / Amends**: [docs/SPEC.md](../SPEC.md) (§5) and [docs/PHASES.md](../PHASES.md) (Phase 3)

---

## 1. Context & Goal

In the v1 baseline, `#tab-list` kept tabs strictly in insertion order (or replaced the `Home` tab in place per CR-001), with no way to rearrange open document tabs or the `Home` tab relative to one another.

**Goal**: Allow users to reorder any tabs in `#tab-list` smoothly via pointer drag-and-drop (with live horizontal tab sliding and edge auto-scroll) as well as keyboard shortcuts (`Ctrl+Shift+ArrowLeft` / `Ctrl+Shift+ArrowRight` when a tab is focused), while keeping `Ctrl+Tab`, `Ctrl+Shift+Tab`, and `Ctrl+1`..`Ctrl+9` synchronized with the visual tab order.

---

## 2. Baseline Traceability Matrix

| Baseline Document & Section | Original v1 Behavior | Updated Behavior (This Document) |
| --- | --- | --- |
| [SPEC §5 — Aesthetic Direction (Chrome geometry)](../SPEC.md#aesthetic-direction) | Horizontal tabs appear in open order with click-to-select, close (`×` / middle-click), and overflow scrolling. | [§3. Reordering Behavior & Visual Feedback](#3-reordering-behavior--visual-feedback) — adds pointer-drag reordering with live sibling displacement and horizontal edge auto-scroll. |
| [SPEC §5 — Keyboard Shortcuts](../SPEC.md#keyboard-shortcuts) | Focused tabs support `ArrowLeft`/`ArrowRight` focus navigation and `Enter`/`Space` selection; `Ctrl+1..9` and `Ctrl+Tab` use fixed open order. | [§4. Keyboard Reordering & Shortcut Order](#4-keyboard-reordering--shortcut-order) — adds `Ctrl+Shift+ArrowLeft` / `Ctrl+Shift+ArrowRight` on focused tabs; tab-cycling and `Ctrl+1..9` follow the reordered tab order. |
| [PHASES — Phase 3 Task 4 & Exit Gate](../PHASES.md#phase-3-minimalist-ui-shell-multi-tab-strip--virtualized-viewport) | Tab strip renders tabs in creation order. | [§5. Verification Checklist](#5-verification-checklist) — verifies pointer reordering across variable-width tabs, overflow auto-scroll, `Esc` cancel, and keyboard reordering. |

---

## 3. Reordering Behavior & Visual Feedback

1. **Pointer drag initiation**:
   - Pressing the primary mouse button (`button === 0`) on any `.tab` (excluding `.tab-close-btn`) when `>= 2` tabs are open arms a drag session.
   - Dragging activates only after horizontal pointer movement reaches `5px` (`DRAG_THRESHOLD_PX`), preserving normal click activation, middle-click close, and double-click resistance.
   - Uses Pointer Events (`pointerdown` / `pointermove` / `pointerup` / `pointercancel` + `setPointerCapture`) rather than HTML5 `draggable`, ensuring zero conflict with Tauri WebView2 native file drag-and-drop (`onDragDropEvent`) and `data-tauri-drag-region`.
2. **Live horizontal displacement**:
   - The dragged tab follows the pointer horizontally (`translateX`) clamped within `#tab-list` content bounds, elevated at `z-index: 5` on an opaque `--surface-paper` background with `--border-strong` and subtle shadow (`0 2px 6px rgba(26, 31, 43, 0.12)`), preserving the `--accent-cobalt` top rule when dragging the active tab.
   - Non-dragged tabs smoothly slide (`transition: transform 140ms cubic-bezier(0.2, 0, 0, 1)`) into their preview slots using hysteresis thresholds (`0.45` left / `0.55` right of the neighbor's width) so variable-width tabs (e.g. `Home` at `92px` vs `240px` document tabs) reorder cleanly without oscillation.
   - `prefers-reduced-motion: reduce` collapses transform transition durations automatically.
3. **Overflow auto-scroll & cancellation**:
   - When `#tab-list` overflows horizontally, holding a dragged tab within `28px` of the left or right edge auto-scrolls `#tab-list` smoothly via `requestAnimationFrame` and keeps the dragged tab aligned with the pointer.
   - Reordering preserves `#tab-list` scroll position around the moved tab instead of jumping back to an off-screen active tab.
   - Pressing `Escape`, losing window focus (`blur`), or receiving `pointercancel` cancels the active drag and snaps tabs back to their pre-drag order.

---

## 4. Keyboard Reordering & Shortcut Order

- **Move focused tab**: When keyboard focus is on a `.tab` element in `#tab-list`, `Ctrl+Shift+ArrowLeft` (`Cmd+Shift+ArrowLeft` on macOS) and `Ctrl+Shift+ArrowRight` move that tab one slot left or right, keep focus on the moved tab, and scroll it into view if overflowing.
- **Shortcut synchronization**: Because `tabs.js` stores `tabs` in display order, `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+1`..`Ctrl+9`, tab-close adjacent fallback, and `Home` in-place replacement all automatically follow the updated tab order.

---

## 5. Verification Checklist

- [ ] Dragging an active or inactive tab horizontally smoothly slides neighboring tabs into place and commits the new order on release without firing an unintended tab switch.
- [ ] Reordering works cleanly between tabs of different widths (including the narrower `Home` tab and wide truncated document tabs).
- [ ] Normal clicking (`< 5px` move), `×` close button clicks, and middle-click close continue to work without triggering drag.
- [ ] Pressing `Escape` mid-drag cancels the reorder and restores the original tab order.
- [ ] When many tabs overflow `#tab-list`, dragging near the left/right edges auto-scrolls the tab strip smoothly.
- [ ] Focusing a tab and pressing `Ctrl+Shift+ArrowLeft` / `Ctrl+Shift+ArrowRight` moves the tab while keeping keyboard focus on it.
- [ ] `Ctrl+Tab`, `Ctrl+Shift+Tab`, and `Ctrl+1..9` reflect the new visual order after reordering.
