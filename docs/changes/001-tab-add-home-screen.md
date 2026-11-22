# CR-001: Open Singleton Home Tab from `tab-add-btn` (`+`)

- **ID**: `CR-001`
- **Status**: Implemented
- **Scope**: Frontend only (`src/`). Zero changes to Rust backend, MuPDF worker, or Tauri IPC contract (`src-tauri/`).
- **Supersedes / Amends**: [docs/SPEC.md](../SPEC.md) (§1, §5) and [docs/PHASES.md](../PHASES.md) (Phase 3)

---

## 1. Context & Goal

In the v1 baseline, clicking the `+` button (`#tab-add-btn`) in the tab strip immediately invoked the native OS file picker (`handleOpenViaDialog()`), forcing the user into a modal file dialog even when they simply wanted to pick from their `Recent` files list or drag-and-drop a PDF onto the familiar start screen.

**Goal**: Change `#tab-add-btn` (`+`) so that clicking it opens a **singleton `Home` tab** inside the tab strip displaying the same Home screen (`#empty-state`) shown when zero documents are open — while keeping all open document tabs visible and reachable in the tab strip.

---

## 2. Baseline Traceability Matrix

| Baseline Document & Section | Original v1 Behavior | Updated Behavior (This Document) |
| --- | --- | --- |
| [SPEC §1 — v1 Goals (Minimal multi-tab window)](../SPEC.md#v1-goals) | Tabs represent open documents only; closing the last tab returns to empty state. | [§3. Tab Model & Lifecycle](#3-tab-model-and-lifecycle) — adds a singleton `Home` tab (`kind: "home"`) alongside open document tabs. |
| [SPEC §5 — Aesthetic Direction (Chrome geometry)](../SPEC.md#aesthetic-direction) | Subtle `+` button opens another PDF directly; slim toolbar always sits beneath tab strip when a document is open. | [§4. UI Shell & Visual Behavior](#4-ui-shell-and-visual-behavior) — `+` opens/focuses the singleton `Home` tab; `#toolbar` hides while `Home` is active. |
| [SPEC §5 — Core Layout Wireframe (Empty state)](../SPEC.md#core-layout-wireframe) | Empty state is shown only when 0 tabs are open (tab strip & toolbar both hidden). | [§4. UI Shell & Visual Behavior](#4-ui-shell-and-visual-behavior) — `#empty-state` is also shown inside the active `Home` tab beneath `#tab-strip`. |
| [SPEC §5 — Frontend Module Structure](../SPEC.md#frontend-module-structure-src) | `tabs.js` stores per-document tab state only; `empty-state.js` applies only when no tabs are open. | [§6. Frontend Module Changes](#6-frontend-module-changes) — `tabs.js` manages `document` and singleton `home` tabs; `empty-state.js` serves both 0-tab start and the `Home` tab. |
| [SPEC §5 — Keyboard Shortcuts](../SPEC.md#keyboard-shortcuts) | `Ctrl+W`, `Ctrl+Tab`/`Ctrl+Shift+Tab`, `Ctrl+1..9` operate on document tabs only. | [§5. Keyboard Shortcuts & Focus Rules](#5-keyboard-shortcuts-and-focus-rules) — tab shortcuts include `Home`; document-only shortcuts stay inactive on `Home`. |
| [PHASES — Phase 3 Task 4 & Exit Gate](../PHASES.md#phase-3-minimalist-ui-shell-multi-tab-strip--virtualized-viewport) | `+` tab button opens another PDF via native dialog. | [§7. Verification Checklist](#7-verification-checklist) — verifies singleton `Home` tab lifecycle, replacement, close, and shortcut isolation. |

---

## 3. Tab Model and Lifecycle

### Tab Kinds & Identifiers
Every entry in `tabs.js` carries an explicit `kind` and string `tabId`:
- **Document tab**: `{ kind: "document", tabId: "doc-<documentId>", documentId: number, ... }`
- **Home tab**: `{ kind: "home", tabId: "home", documentId: null, title: "Home", returnToTabId: string | null }`

### Lifecycle Rules
1. **Singleton `Home` tab**:
   - Clicking `+` (`#tab-add-btn`) when no `Home` tab exists appends a single `Home` tab at the end of `#tab-list` and activates it, recording `returnToTabId` as the previously active document tab's `tabId`.
   - Clicking `+` when the `Home` tab already exists (whether active or in the background) does **not** create a second `Home` tab; it activates the existing `Home` tab and focuses `#empty-open-btn`.
2. **Document-presence invariant**:
   - The `Home` tab only exists while at least one document tab is open (`documentCount >= 1`).
   - Whenever the last remaining document tab is closed (whether `Home` was active or in the background), any open `Home` tab is automatically pruned so the window returns cleanly to the initial 0-tab Home state (`#app-chrome` hidden, `#empty-state` visible).
3. **Opening a PDF while `Home` is active (in-place replacement)**:
   - **New document**: Replaces the `Home` tab **in place** at its current index in `#tab-list` and activates the newly opened document tab.
   - **Already-open document (`already_open: true`)**: Removes the `Home` tab and focuses the existing document tab without duplicating handles.
   - **Multi-file batch** (drag-and-drop or multi-select file dialog launched from `Home`): The first successfully opened file replaces the `Home` tab; subsequent files in the same batch append normally as new document tabs.
4. **Closing the `Home` tab** (`×` button, middle-click, or `Ctrl+W`):
   - Does **not** invoke any Rust IPC (`close_document` or `save_reading_state`).
   - Restores focus to `returnToTabId` if that document tab is still open; otherwise activates the adjacent remaining tab.
5. **Memory & state preservation on switching to `Home`**:
   - Switching away from an active document tab to `Home` executes the same snapshot/cleanup path as switching between document tabs: cancel active page input, capture TOC scroll and viewport snapshot, flush `save_reading_state`, call `viewport.unmount()` (freeing all `<canvas>` backing stores via `canvas.width = 0; canvas.height = 0` and bumping the render epoch), detach TOC (`toc.clear()`), and detach search (`search.syncTab(null)`).
   - Refresh `Recent` files (`refreshRecents()`) after flushing reading state so the Home screen reflects up-to-date page progress immediately.

---

## 4. UI Shell and Visual Behavior

### Shell Visibility Matrix

| Application State | `#app-chrome` | `#tab-strip` | `#toolbar` | `#reader-shell` | `#empty-state` | Window Title |
| --- | --- | --- | --- | --- | --- | --- |
| **0 tabs open** (initial Home) | Hidden | Hidden (parent) | Hidden (parent) | Hidden | **Visible** | `Reader` |
| **Document tab active** | **Visible** | **Visible** | **Visible** | **Visible** | Hidden | `<Title> — Reader` |
| **`Home` tab active** (`>= 1` doc open) | **Visible** | **Visible** | **Hidden** | Hidden | **Visible** | `Home — Reader` |

### Layout Wireframe (`Home` Tab Active)

```text
+-------------------------------------------------------------------+
| [ Document A   x ] [ (house) Home   x ] [ + ]                     |  <- 32px tab strip (#EEF0F4)
+-------------------------------------------------------------------+
|                                                                   |
|                  Reader                                           |  <- #empty-state (#EEF0F4)
|                  Drop a PDF anywhere, or press Ctrl+O.            |     (#toolbar hidden)
|                  [ Open PDF ]                                     |
|                  ─────────────────────────────────────            |
|                  Recent                                           |
|                  Document A.pdf                    Page 12 of 560 |
|                                                                   |
+-------------------------------------------------------------------+
```

### Visual & Copy Details
- **Surface continuity**: Standard active document tabs use `height: 29px; margin-bottom: -1px; border-bottom: none` so `#FFFFFF` (`--surface-paper`) merges seamlessly into the `#FFFFFF` `.toolbar` below. Because `.toolbar` is hidden while `Home` is active and `#empty-state` sits directly underneath on `#EEF0F4` (`--surface-chrome`), `.tab--home.tab--active` uses `height: 28px; margin-bottom: 0; padding-bottom: 0` so the tab-strip hairline border runs cleanly beneath the white active `Home` tab.
- **Tab identification**: The `Home` tab displays a subtle 12×12 monochrome outline house glyph next to `"Home"` (`min-width: 92px`) to distinguish it immediately from a PDF file named `Home.pdf`.
- **Add-button copy**: `#tab-add-btn` uses `title="New Home tab"` and `aria-label="Open Home tab"` (replacing the v1 `"Open PDF (Ctrl+O)"` tooltip, which no longer matches its behavior).
- **Error routing**: When opening a file fails while the Home screen is displayed (either 0 tabs open or the `Home` tab is active), errors render inline inside `#empty-error` (with the `Remove from recent` action when applicable) instead of `#notice-banner`. Switching back to a document tab clears `#empty-error`.

---

## 5. Keyboard Shortcuts and Focus Rules

- **Tab-strip shortcuts** (active whenever at least 1 tab exists, including `Home`):
  - `Ctrl+W`: Closes the active tab (closes `Home` and returns to the previous/adjacent document tab when `Home` is active).
  - `Ctrl+Tab` / `Ctrl+Shift+Tab`: Cycles across all tabs in `#tab-list`, including `Home`.
  - `Ctrl+1` .. `Ctrl+9`: Jumps directly to tab 1–8 (`Ctrl+9` jumps to the last tab), including `Home`.
- **Global open shortcut**:
  - `Ctrl+O` (and the toolbar `Open` button on document tabs) continues to open the native OS file picker directly. If launched while `Home` is active, the chosen file replaces the `Home` tab in place.
- **Document-only shortcuts** (active **only** when a `document` tab is active; inert on `Home`):
  - `Ctrl+F` (still calls `event.preventDefault()` to suppress WebView2's built-in find bar), `Ctrl+G`, `Ctrl+B`, `Ctrl++` / `Ctrl+-` / `Ctrl+0`, `Ctrl+Wheel` (still prevents browser zoom), `PageDown` / `PageUp` / `Home` / `End`.
- **`Esc` on `Home`**:
  - Blurs the currently focused control if applicable without attempting to focus the hidden `#viewport`.

---

## 6. Frontend Module Changes

| File | Summary of Changes |
| --- | --- |
| `src/index.html` | Update `#tab-add-btn` `title` and `aria-label` to `"New Home tab"` / `"Open Home tab"`. |
| `src/styles.css` | Add flat-specificity styles for `.tab--home`, `.tab--home.tab--active`, and `.tab-home-icon`. |
| `src/tabs.js` | Support `kind: "document" \| "home"` with `tabId` and `HOME_TAB_ID`, `openHomeTab()`, `replaceHomeIfActive` in `upsertFromOpenResponse()`, singleton pruning on last-document close, `returnToTabId` restoration, and `getActiveDocument()` / `isHomeActive()` helpers. |
| `src/shortcuts.js` | Separate `hasActiveTab` (tab navigation/close) from `hasActiveDocument` (viewport, zoom, TOC, search). |
| `src/main.js` | Wire `handleOpenHomeTab()`, hide `#toolbar` when `Home` is active, unmount/flush outgoing document tab on switching to `Home`, refresh recents, route errors to `#empty-error` on `Home`, and handle `Home` tab close/replacement cleanly. |

---

## 7. Verification Checklist

- [ ] Opening a PDF from `tests/fixtures/*.pdf` and clicking `+` (`#tab-add-btn`) opens a single `Home` tab showing `#empty-state` with `#toolbar` hidden and `#tab-strip` visible (no OS file dialog triggered).
- [ ] Clicking `+` again while `Home` already exists focuses the existing `Home` tab instead of creating a duplicate.
- [ ] Switching back and forth between document tabs and `Home` (via mouse, `Ctrl+Tab`, `Ctrl+1..9`) preserves each document's scroll position, zoom, TOC, and search state while freeing inactive canvases.
- [ ] Opening a new PDF from `Home` (via `Open PDF`, `Recent`, `Ctrl+O`, or drag-drop) replaces the `Home` tab in place; opening an already-open PDF removes `Home` and focuses the existing tab.
- [ ] Closing `Home` (`×`, middle-click, or `Ctrl+W`) returns to the previously active document tab without backend errors.
- [ ] Closing the last open document tab while `Home` is also open automatically prunes `Home` and returns to the 0-tab Home screen (`#app-chrome` hidden).
- [ ] Document-only shortcuts (`Ctrl+F`, `Ctrl+G`, `Ctrl+B`, `Ctrl++`/`-`/`0`, `Ctrl+Wheel`, `PageUp`/`PageDown`) do not error or trigger WebView2 defaults while on `Home`.
- [ ] Opening a missing/unreadable recent file from `Home` displays the inline error (with `Remove from recent`) inside `#empty-error`.
