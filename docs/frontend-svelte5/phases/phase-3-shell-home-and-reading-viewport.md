# Phase 3: Svelte 5 Cutover — Shell, Home Screen, Toolbar & Reading Viewport

> **Read First**: [README.md](../README.md) · [ARCHITECTURE.md §4–§5](../ARCHITECTURE.md#4-imperative-engine-boundary-srclibengines) · [PHASES.md](../PHASES.md) · `.agents/skills/frontend-design/SKILL.md`

---

## 1. Goal & Preconditions

**Goal**: Cut over `index.html` from legacy `src/main.js` to **`src/main.ts`** (`mount(App, { target })`), bringing the complete core reading application live on **Svelte 5 + TypeScript** — multi-tab strip (with CR-001 Home tab, CR-002 borderless titlebar & window controls, CR-003 drag/keyboard reorder), Home screen (with CR-004 paginated recents & CR-006 live search), unified error banner, persistent document toolbar, and virtualized HiDPI PDF viewport with text selection/copy — and disable `withGlobalTauri`.

**Preconditions**:
- Phase 2 Exit Gate is 100% satisfied (`src/lib/{ipc,domain,state,engines}` implemented and all Vitest tests passing).
- Read `.agents/skills/frontend-design/SKILL.md` to ensure visual fidelity to the locked 6-token palette, keyboard focus visibility, and `prefers-reduced-motion` support.

---

## 2. Scope Boundaries

### In Scope
- Global CSS extraction: `src/styles/tokens.css`, `src/styles/base.css`, `src/styles/viewport-layers.css`.
- Svelte 5 entrypoint (`src/main.ts`) and root `index.html` cutover (`<div id="app"></div>` + `<script type="module" src="/src/main.ts"></script>`).
- Core Svelte 5 components: `App.svelte`, `TabStrip.svelte`, `WindowControls.svelte`, `Toolbar.svelte`, `NoticeBanner.svelte`, `HomeScreen.svelte`, `RecentFiles.svelte`, `ViewportHost.svelte`, `DropOverlay.svelte`, plus inline SVG icons (`src/components/icons/`).
- Flipping `"withGlobalTauri": false` in `src-tauri/tauri.conf.json`.
- Wiring basic shortcuts or deferring TOC/Search shortcuts cleanly to Phase 4 (recommended: install `shortcuts.ts` in Phase 3 with `isInsideToc`/`isInsideSearch` returning `false` until Phase 4 mounts those panels so `Ctrl+O`/`Ctrl+W`/`Ctrl+Tab`/`Ctrl+1..9`/`Ctrl+G`/`Ctrl++`/`-`/`0`/`Ctrl+Wheel` work immediately at Phase 3 cutover!).

### Out of Scope (Deferred to Phase 4 & Phase 5)
- `TocDrawer.svelte`, `TocTree.svelte`, and `SearchBar.svelte` (Phase 4).
- Deleting legacy `src/*.js` and `src/styles.css` (Phase 5 — keep them inert on disk through Phase 4 as a reference for pixel/behavior parity, then remove cleanly in Phase 5).
- Updating `AGENTS.md`, `docs/SPEC.md`, `docs/PHASES.md`, and `CR-007` status (Phase 5).

---

## 3. Files to Create / Modify

| Action | Path | Purpose |
| --- | --- | --- |
| **CREATE** | `src/styles/tokens.css` | Locked 6-token palette (`--surface-desk`, `--surface-chrome`, `--surface-paper`, `--ink-primary`, `--ink-muted`, `--accent-cobalt`) and derived tokens (`src/styles.css` L1–40). |
| **CREATE** | `src/styles/base.css` | Global reset, `[hidden]`, `html`/`body`, `:focus-visible`, `.sr-only`, `prefers-reduced-motion` (`src/styles.css` L42–97, L1480–1488). |
| **CREATE** | `src/styles/viewport-layers.css` | Global styles for imperatively created `.viewport`, `.viewport-track`, `.page-slot`, `.page-canvas`, `.search-layer`, `.search-hit`, `.text-layer`, `.text-span` (`src/styles.css` L1299–1384). |
| **CREATE** | `src/components/icons/*.svelte` | Compact inline SVG icon components (`CloseIcon`, `HomeIcon`, `PlusIcon`, `SearchIcon`, `ChevronIcon`, etc.) replacing imperative `createElementNS` builders. |
| **CREATE** | `src/main.ts` | Imports global CSS, creates `{ api, store, scopes, persistence, actions }`, mounts `App.svelte` via Svelte 5 `mount(App, { target })`. |
| **CREATE** | `src/App.svelte` | Root app shell, reactive `document.title`, Tauri `subscribeDragDrop` + `windowControls` + `beforeunload` + startup `bootstrap()` lifecycle. |
| **CREATE** | `src/components/TabStrip.svelte` | Borderless 32px titlebar (CR-002), keyed `{#each}` tabs, singleton Home tab (CR-001), `use:tabReorder` + `Ctrl+Shift+Arrow` (CR-003), horizontal wheel scroll, guaranteed 36px `.tab-strip-drag` handle. |
| **CREATE** | `src/components/WindowControls.svelte` | Flush top-right Minimize / Maximize-Restore (`data-maximized`) / Close controls; Close flushes reading state before closing. |
| **CREATE** | `src/components/NoticeBanner.svelte` | Workspace-scoped alert banner driven by `store.banner` (`scope === "workspace"`). |
| **CREATE** | `src/components/HomeScreen.svelte` | 0-tab and Home-tab start screen, `Open PDF` CTA, Home-scoped inline error banner (`store.banner?.scope === "home"`), hosts `RecentFiles.svelte`. |
| **CREATE** | `src/components/RecentFiles.svelte` | Unbounded paginated recents (10/page, ellipsis pagination preserving focus — CR-004) + live multi-token `.recent-header` search (`Esc` clear-then-blur, `ArrowDown` into list — CR-006). |
| **CREATE** | `src/components/Toolbar.svelte` | Slim 36px document toolbar reactively synced to `store.toolbarModel`, editable page jump input with dirty/blur/Enter/Esc handling + registered `cancelPageInput` hook. |
| **CREATE** | `src/components/ViewportHost.svelte` | Hosts `#viewport` + `#viewport-track`, mounts `createViewportEngine` + `createTextLayerEngine` via `$effect` with `untrack()`, exposes command hooks (`scrollToPage`, `setZoomMode`, `setCustomZoom`, `captureSnapshot`, `evictDocument`). |
| **CREATE** | `src/components/DropOverlay.svelte` | File drag-and-drop overlay bound to `store.isDraggingFiles`. |
| **MODIFY** | `index.html` | Replace static shell markup with `<div id="app"></div>` and `<script type="module" src="/src/main.ts"></script>`. |
| **MODIFY** | `src-tauri/tauri.conf.json` | Flip `"withGlobalTauri": false`. |

---

## 4. Detailed Technical Tasks

### 4.1 Global Styles & Entrypoint Cutover
1. Extract `src/styles/tokens.css`, `src/styles/base.css`, and `src/styles/viewport-layers.css` verbatim from the line map in [ARCHITECTURE.md §5](../ARCHITECTURE.md#css-split-map-100-fidelity-to-existing-1488-line-srcstylescss).
2. Write `src/main.ts` using Svelte 5's `mount()` API:
   - Import `./styles/tokens.css`, `./styles/base.css`, `./styles/viewport-layers.css`.
   - Instantiate `api = createTauriReaderApi()`, `store = createAppStore()`, `scopes = new DocumentScopeRegistry()`, `persistence = new PersistenceQueue(api)`, and `actions = createAppActions(...)`.
   - Mount `App` onto `#app` passing `{ store, actions, api }` as props (or Svelte `setContext`), keeping state cleanly dependency-injected.
3. Update `index.html` to a clean Vite root shell (`<div id="app"></div>` + `<script type="module" src="/src/main.ts"></script>`).
4. Flip `"withGlobalTauri": false` in `src-tauri/tauri.conf.json`.

### 4.2 Borderless Titlebar, Keyed Tab Strip & Window Controls
- **`TabStrip.svelte`**:
  - Renders `<div id="tab-strip" class="tab-strip" class:tab-strip--empty={!store.hasAnyTabs}>`.
  - Brand logo (`src="/logo.png"`, `data-tauri-drag-region`), `#tab-list` (`{#each store.orderedTabs as tab (tab.tabId)}`), `#tab-add-btn` (`+`), `.tab-strip-drag[data-tauri-drag-region]`, and `<WindowControls />`.
  - **Keyed rendering eliminates destructive DOM teardown**: switching `activeTabId` toggles `.tab--active`, `aria-selected`, and `tabindex` in place without destroying DOM nodes or listeners!
  - Attach `tab-drag.ts` via Svelte Action on `#tab-list`; style `:global(.tab-list--reordering)` and `:global(.tab--dragging)` inside `TabStrip.svelte`'s `<style>` so scoped selectors match the drag classes.
  - Preserve CR-001 active Home tab surface continuity (`.tab--home.tab--active` keeps `height: 28px; margin-bottom: 0` so the hairline runs cleanly above `#empty-state`).
  - Preserve mouse-wheel horizontal scrolling on overflowing `#tab-list`, middle-click close (`auxclick` + `mousedown` preventDefault), `ArrowLeft`/`ArrowRight` tab focus navigation, and `Ctrl+Shift+ArrowLeft`/`Right` keyboard reordering with focus preserved on the moved tab.
- **`WindowControls.svelte`**:
  - Syncs `store.isWindowMaximized` on startup, click, and `windowControls.onResized(...)`.
  - Close button awaits `actions.flushActiveReadingState()` before calling `windowControls.close()`.

### 4.3 Home Screen, Paginated Searchable Recents & Unified Banner
- **`HomeScreen.svelte`**:
  - Shown whenever `store.shellMode !== "document"` (both `0`-tab start and active `Home` tab).
  - Renders inline error box (`#empty-error`) directly from `store.banner` when `store.banner?.scope === "home"`.
  - Reacts to `store.focusRequest?.target === "home_open"` to focus `#empty-open-btn`.
- **`RecentFiles.svelte`**:
  - Reads derived `store.filteredRecents`, `store.pagedRecents`, `store.totalRecentPages`, `store.clampedRecentPage`, `store.recentRangeLabel`.
  - Implements CR-006 keyboard ergonomics inside `#recent-search-input`: `Esc` clears non-empty query while keeping input focused (and stops propagation); `Esc` on empty query lets global handler blur; `ArrowDown` focuses the first `.recent-row-btn`.
  - Implements CR-004 focus preservation when pagination prev/next buttons become disabled or page buttons re-render.
- **`NoticeBanner.svelte`**:
  - Renders workspace-scoped `store.banner` (`scope === "workspace"`); restores viewport focus when dismissed via keyboard.

### 4.4 Document Toolbar & Imperative Viewport Host
- **`Toolbar.svelte`**:
  - Shown when `store.shellMode === "document"`, driven reactively by `store.toolbarModel`.
  - Keeps local `inputDirty` / draft string for `#page-input` so typing never fights reactive page updates while focused; registers `cancelPageInput` hook with `actions` so tab switches reset dirty drafts cleanly.
  - Wires `zoomOut`, `zoomIn`, `fitWidth`, `fitPage`, `open`, plus `tocToggle` and `searchToggle` buttons (ready for Phase 4 drawers).
- **`ViewportHost.svelte`**:
  - Instantiates `createTextLayerEngine({ viewportEl, api })` and `createViewportEngine({ viewportEl, trackEl, api, textLayer, onViewStateChange })` inside a lifecycle `$effect` (cleaning up via `.destroy()` on unmount).
  - Registers transition hooks (`captureViewportSnapshot`, `onDocumentClosed` → `textLayer.evictDocument`, plus viewport command methods `scrollToPage`, `setZoomMode`, `setCustomZoom`, `scrollPageStep`, `scrollToStart`, `scrollToEnd`, `focusViewport`).
  - **Mount/Unmount `$effect`**: depends **strictly** on `const activeDocId = store.activeDoc?.documentId ?? null;`, reading the full `DocState` inside `untrack()` to call `viewport.mountDocument(...)` with the document's `AbortSignal` from `scopes`, and calling `viewport.unmount()` on cleanup.
  - Passes `"mount"` vs `"user"` change reasons through `actions.applyViewportSnapshot(...)` so tab switches never emit spurious `save_reading_state` calls.
- **`App.svelte`**:
  - Installs `window.addEventListener("dragover"/"drop", preventDefault)` + `api.subscribeDragDrop(...)` + `beforeunload` flush + `shortcuts.ts` (with Phase 3 core shortcuts live immediately).
  - Syncs `document.title = store.windowTitle` via `$effect`.

---

## 5. Verification Plan

### Automated Commands
```powershell
pnpm verify
```

### Live Manual Verification (`cargo tauri dev` with `tests/fixtures/*.pdf`)
1. **Startup & Open Flows**: Open via `Open PDF` dialog (`Ctrl+O`), drag-and-drop (single & multi-file batch), CLI arg (`cargo tauri dev -- <path>`), and Recent list; verify canonical dedup focuses existing tab.
2. **Borderless Chrome (CR-002)**: Verify top 32px drag handle works in both 0-tab and overflowing-tab states; test Minimize, Maximize/Restore (button, double-click, `Win+Up`), and Close (verifying reading position saves on exit).
3. **Multi-Tab & Home Lifecycle (CR-001, CR-003)**:
   - `+` opens singleton `Home` tab (`#toolbar` hides); clicking `+` again focuses existing `Home`.
   - Opening a PDF from `Home` replaces `Home` in place; opening an already-open PDF removes `Home` and focuses existing tab; closing last document prunes `Home`.
   - Pointer drag-reorder works across mixed-width tabs (`Home` + document tabs) with overflow auto-scroll and `Esc` cancel; `Ctrl+Shift+ArrowLeft`/`Right` reorders with preserved focus; `Ctrl+Tab` and `Ctrl+1..9` follow visual order.
4. **Home Recents Pagination & Search (CR-004, CR-006)**: Test filtering across title/path, `Ctrl+F` focus on Home, `Esc` clear-then-blur, `ArrowDown` to first result, and pagination at 10/page.
5. **Viewport, Zoom, Text Selection & No Spurious Saves**:
   - Smooth continuous scroll through a large PDF; canvases stay bounded and release on tab switch.
   - Crisp HiDPI rendering on `fit_width`, `fit_page`, custom zoom steps (`+`/`-`/`Ctrl+Wheel`/`Ctrl+0`); scroll anchor preserved across zoom and window resize.
   - Native drag-selection and `Ctrl+C` copy match rendered lines/paragraphs accurately even after zooming.
   - Verify switching tabs without scrolling does **not** trigger unnecessary `save_reading_state` IPC writes.
6. **Security Check**: Confirm `window.__TAURI__` is `undefined` in DevTools (`withGlobalTauri: false`) and zero CSP errors appear in the console.

---

## 6. Exit Gate Checklist

- [ ] `index.html` mounts Svelte 5 `App.svelte` via `src/main.ts`; `src-tauri/tauri.conf.json` has `"withGlobalTauri": false`.
- [ ] All core UI chrome components (`TabStrip`, `WindowControls`, `Toolbar`, `NoticeBanner`, `HomeScreen`, `RecentFiles`, `ViewportHost`, `DropOverlay`) render with 100% visual parity to the locked 6-token palette.
- [ ] Tab switching preserves DOM nodes via keyed `{#each}` (zero `textContent = ""` teardown).
- [ ] `pnpm verify` passes with zero errors or warnings.
- [ ] Live `cargo tauri dev` verification passes all 6 manual verification groups above against `tests/fixtures/*.pdf`.
