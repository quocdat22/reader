# CR-002: Integrated Borderless Titlebar & Window Controls

- **ID**: `CR-002`
- **Status**: Implemented
- **Scope**: Window configuration, capability permissions (`src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`), and frontend chrome (`src/index.html`, `src/styles.css`, `src/api.js`, `src/main.js`). Zero changes to Rust application logic, MuPDF worker, or custom IPC commands.
- **Supersedes / Amends**: [docs/SPEC.md](../SPEC.md) (§5) and [docs/PHASES.md](../PHASES.md) (Phase 3)

---

## 1. Context & Goal

With native OS window decorations enabled (`decorations: true`), Windows renders a separate `"Reader"` titlebar above the 32px `#tab-strip`, leaving a redundant horizontal strip of empty space above the tabs.

**Goal**: Remove the native OS titlebar (`"decorations": false` on the `main` window) and merge window dragging (`data-tauri-drag-region`) plus Windows-style caption controls (`Minimize`, `Maximize`/`Restore`, `Close`) directly into the 32px `#tab-strip` — reclaiming ~32px of vertical reading space while preserving full window management in both open-tab and 0-tab Home states.

---

## 2. Baseline Traceability Matrix

| Baseline Document & Section | Original v1 Behavior | Updated Behavior (This Document) |
| --- | --- | --- |
| [SPEC §5 — Aesthetic Direction (Chrome geometry)](../SPEC.md#aesthetic-direction) | Native OS titlebar sits above `#tab-strip`; `#tab-strip` is hidden when 0 documents are open. | [§3. Window Chrome & Layout](#3-window-chrome--layout) — `#tab-strip` acts as the integrated borderless titlebar across all states (`0` tabs or `>= 1` tabs). |
| [SPEC §5 — Core Layout Wireframe](../SPEC.md#core-layout-wireframe) | Empty state hides `#app-chrome` (`#tab-strip` + `#toolbar`) beneath the native OS titlebar. | [§3. Window Chrome & Layout](#3-window-chrome--layout) — `#app-chrome` stays visible to host the draggable top strip and window controls (`tab-strip--empty` hides `#tab-list` and `#tab-add-btn`). |
| [SPEC §5 — Frontend Module Structure](../SPEC.md#frontend-module-structure-src) | `api.js` wraps custom IPC, dialog, and webview drag-drop only. | [§4. Configuration & Module Changes](#4-configuration--module-changes) — `api.js` adds `getWindowControls()`, `main.js` wires caption buttons and `onResized` maximize-state sync. |
| [PHASES — Phase 3 Tasks & Exit Gate](../PHASES.md#phase-3-minimalist-ui-shell-multi-tab-strip--virtualized-viewport) | Standard decorated window shell. | [§5. Verification Checklist](#5-verification-checklist) — adds borderless window drag, double-click maximize, resize, and caption button checks. |

---

## 3. Window Chrome & Layout

### Shell Visibility Matrix (Updated)

| Application State | `#app-chrome` | `#tab-strip` | `#tab-list` & `#tab-add-btn` | `#window-controls` | `#toolbar` | `#reader-shell` | `#empty-state` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **0 tabs open** (initial Home) | **Visible** | **Visible** (`.tab-strip--empty`, borderless `#EEF0F4`) | Hidden | **Visible** | Hidden | Hidden | **Visible** |
| **Document tab active** | **Visible** | **Visible** | **Visible** | **Visible** | **Visible** | **Visible** | Hidden |
| **`Home` tab active** (`>= 1` doc open) | **Visible** | **Visible** | **Visible** | **Visible** | Hidden | Hidden | **Visible** |

### Layout Wireframe

```text
Document or Home tab open:
+-----------------------------------------------------------------------+
| [ Document A  x ] [ + ]   <-- drag region -->        [ — ] [ □ ] [ × ]|  <- 32px #tab-strip
+-----------------------------------------------------------------------+
| [TOC]                  [ 12 / 560 ]   [- 100% +] [Fit] [Q] [Open]     |  <- 36px #toolbar (hidden on Home tab)
+-----------------------------------------------------------------------+

0 tabs open (initial Home):
+-----------------------------------------------------------------------+
| <-- 32px seamless drag region (#EEF0F4) -->          [ — ] [ □ ] [ × ]|  <- #tab-strip.tab-strip--empty
|                                                                       |
|                  Reader                                               |  <- #empty-state (#EEF0F4)
+-----------------------------------------------------------------------+
```

### Interaction & Restraint Details
- **Guaranteed drag handle**: `.tab-strip-drag` (`flex: 1 0 36px; min-width: 36px;`, carrying `data-tauri-drag-region`) always reserves at least 36px of draggable space between `#tab-add-btn` and `#window-controls`, even when many tabs overflow `#tab-list` horizontally.
- **Native-feeling Windows caption buttons**: `#window-controls` sits flush against the top-right edge (`42px × 32px` rectangular hit targets, zero border-radius). Hovering `Close` uses `#C42B1C` with `#FFFFFF` stroke; `Minimize` and `Maximize`/`Restore` use `--hover-subtle` and `--ink-primary`.
- **Maximize/Restore state sync**: `#win-max-btn` toggles `data-maximized="true" | "false"` via `windowControls.isMaximized()` on startup, click, and `onResized`, swapping between single-square Maximize and overlapping-squares Restore vector icons.
- **Reading-state persistence on close**: Clicking `#win-close-btn` flushes active document reading state (`flushActiveReadingState()`) before calling `windowControls.close()`.

---

## 4. Configuration & Module Changes

| File | Summary of Changes |
| --- | --- |
| `src-tauri/tauri.conf.json` | Set `"decorations": false` on the `main` window. |
| `src-tauri/capabilities/default.json` | Grant `core:window:allow-minimize`, `core:window:allow-toggle-maximize`, `core:window:allow-close`, and `core:window:allow-start-dragging`. |
| `src/index.html` | Keep `#app-chrome` visible, hide `#tab-list`/`#tab-add-btn` initially, and add `.tab-strip-drag[data-tauri-drag-region]` plus `#window-controls` (`#win-min-btn`, `#win-max-btn`, `#win-close-btn`). |
| `src/styles.css` | Style `.tab-strip--empty`, `.tab-strip-drag`, `.window-controls`, `.win-btn`, and `.win-btn--close`; adjust `.empty-state` top padding to `13vh` (`8vh` on short windows). |
| `src/api.js` | Add `getWindowControls()` wrapping `window.__TAURI__.window.getCurrentWindow()`. |
| `src/main.js` | Update `updateShellMode()` to toggle `.tab-strip--empty`, `#tab-list`, and `#tab-add-btn` instead of `#app-chrome`; wire `#window-controls`, `onResized` maximize sync, and shared `flushActiveReadingState()`. |

---

## 5. Verification Checklist

- [ ] App launches borderless (`decorations: false`) with zero native `"Reader"` titlebar above `#tab-strip`.
- [ ] In 0-tab Home state, top 32px strip blends cleanly into `#empty-state` (`#EEF0F4`), drags window, double-clicks to maximize/restore, and exposes `—`, `□`, `×`.
- [ ] Opening a PDF reveals `#tab-list` and `#tab-add-btn` without shifting `#window-controls` position.
- [ ] With many overflowing tabs open, at least 36px of `.tab-strip-drag` remains accessible to drag the window.
- [ ] Maximize/Restore icon updates accurately when maximizing via button, double-click, or `Win+Up`.
- [ ] Closing via `#win-close-btn` flushes the active document's reading position before exit.
