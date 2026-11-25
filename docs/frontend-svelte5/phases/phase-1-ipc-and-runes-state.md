# Phase 1: Typed IPC Layer & Svelte 5 Runes State Architecture

> **Read First**: [README.md](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md) · [PHASES.md](../PHASES.md)

---

## 1. Goal & Preconditions

**Goal**: Build and thoroughly unit-test the entire DOM-free frontend foundation in strict TypeScript and Svelte 5 Runes:
1. **Typed IPC boundary (`src/lib/ipc/`)** using `@tauri-apps/api` + `@tauri-apps/plugin-dialog` behind an injectable `ReaderApi` interface.
2. **Pure domain logic (`src/lib/domain/`)** ported with strict types from legacy modules.
3. **Normalized Svelte 5 Runes store, unidirectional actions, `DocumentScopeRegistry`, and per-path `PersistenceQueue` (`src/lib/state/`)** solving all 4 diagnosed state/sync defects.

**Preconditions**:
- Phase 0 Exit Gate is 100% satisfied (`pnpm verify` and `cargo tauri dev` pass).

---

## 2. Scope Boundaries

### In Scope
- `src/lib/ipc/*` (types, errors, binary RGBA decoder, Tauri v2 client implementation).
- `src/lib/domain/*` (title, zoom, recents, outline, search, error formatting).
- `src/lib/state/*` (types, `DocumentScopeRegistry`, `PersistenceQueue`, `app-store.svelte.ts`, `actions.ts`).
- Comprehensive Vitest unit test suite covering every invariant, CR-001..CR-006 state rule, and race-condition fix.
- Removing the Phase 0 runes smoke test once real store tests exist.

### Out of Scope (Do Not Touch in Phase 1)
- No `.svelte` UI components yet (Phase 3 & Phase 4).
- No imperative DOM engines (`viewport.ts`, `text-layer.ts`, `tab-drag.ts`, `shortcuts.ts` — Phase 2).
- Legacy vanilla app (`src/*.js`, `index.html`) remains untouched and runnable via Vite.
- No Rust backend edits.

---

## 3. Files to Create

| Path | Responsibility |
| --- | --- |
| `src/lib/ipc/types.ts` | Strict TS DTOs matching `src-tauri/src/{commands,state,backend/mod,error}.rs` 1-to-1. |
| `src/lib/ipc/errors.ts` | `ReaderApiError`, `normalizeApiError()`, `isCancelledError()`. |
| `src/lib/ipc/binary.ts` | `decodeRenderFrame(buffer: ArrayBuffer): ImageData` (`[u32 LE][u32 LE][RGBA8]`, guarding truncated/zero frames). |
| `src/lib/ipc/client.ts` | `ReaderApi` interface + `createTauriReaderApi()` built on `@tauri-apps/api/{core,window,webview}` and `@tauri-apps/plugin-dialog`. |
| `src/lib/domain/title.ts` | `deriveTitle(canonicalPath, metadataTitle)` and `splitParentDirectory(fullPath)`. |
| `src/lib/domain/zoom.ts` | `ZOOM_STEPS`, `MIN_ZOOM`, `MAX_ZOOM`, `clampZoom()`, `getNextZoomStep()`. |
| `src/lib/domain/recents.ts` | `RECENTS_PAGE_SIZE = 10`, `filterRecentFiles()`, `getVisiblePageItems()` (CR-004, CR-006). |
| `src/lib/domain/outline.ts` | `OutlineNode`, `OutlineModel`, `buildOutlineModel()`, `resolveActiveOutlineNodeId()`, `resolveVisibleActiveNodeId()`, `createInitialExpandedIds()`. |
| `src/lib/domain/search.ts` | `PageSearchEntry`, `groupMatchesByPage()`, `resolveInitialMatchIndex()`, `stepMatchIndex()`. |
| `src/lib/domain/format-error.ts` | `formatOpenError(err, context)` matching SPEC §5 plain non-apologetic copy. |
| `src/lib/state/types.ts` | `HOME_TAB_ID`, `TabItem`, `DocState`, `DocViewState`, `DocOutlineState`, `DocSearchState`, `BannerState`, `ShellMode`, `TransitionHooks`, `FocusRequest`. |
| `src/lib/state/doc-scope.ts` | `DocumentScopeRegistry` managing per-document root `AbortController` and child per-search `AbortController`. |
| `src/lib/state/persistence.ts` | `PersistenceQueue` (`Map<canonicalPath, PendingSave>`, 400ms per-path debounce, `schedule`, `flush`, `flushAll`, `cancel`). |
| `src/lib/state/app-store.svelte.ts` | Factory `createAppStore()` using Svelte 5 `$state`, `$derived`, `SvelteMap`, and `SvelteSet`. |
| `src/lib/state/actions.ts` | Factory `createAppActions({ store, api, scopes, persistence, hooks })` — sole writer of store state and orchestrator of IPC + tab transitions. |
| `src/lib/**/__tests__/*.test.ts` | Unit tests covering IPC binary/errors, domain helpers, `DocumentScope`, `PersistenceQueue`, and Runes store/actions. |

---

## 4. Detailed Technical Tasks

### 4.1 Typed IPC Layer (`src/lib/ipc/`)
1. Define all DTOs in `src/lib/ipc/types.ts` matching [ARCHITECTURE.md §2](../ARCHITECTURE.md#2-typed-ipc-boundary-srclibipc) verbatim.
2. Implement `decodeRenderFrame(buffer: unknown): ImageData` in `src/lib/ipc/binary.ts`:
   - Validate `buffer instanceof ArrayBuffer && buffer.byteLength >= 8`.
   - Read `width` (`getUint32(0, true)`) and `height` (`getUint32(4, true)`).
   - Validate `width > 0 && height > 0 && buffer.byteLength >= 8 + width * height * 4`.
   - Note for Node/Vitest tests where global `ImageData` may be absent: accept an optional `ImageData` factory or provide a minimal typed pixel-frame adapter/polyfill in tests so binary decoding runs cleanly in pure Node Vitest without needing full jsdom.
3. Implement `createTauriReaderApi(): ReaderApi` in `src/lib/ipc/client.ts`:
   - Wrap every `invoke` call through `normalizeApiError()`.
   - Normalize `open()` from `@tauri-apps/plugin-dialog` (handles `null`, `string`, or `string[]` → `string[]`).
   - Wrap `getCurrentWebview().onDragDropEvent(...)` mapping `enter` / `drop` / `leave` payloads cleanly.
   - Wrap `getCurrentWindow()` (`minimize`, `toggleMaximize`, `close`, `isMaximized`, `onResized`) with safe no-op fallback if invoked outside a Tauri runtime.

### 4.2 Pure Domain Modules (`src/lib/domain/`)
- Port exact algorithms and edge-case semantics from legacy `tabs.js`, `toolbar.js`, `empty-state.js`, `toc.js`, and `search.js` with strict TypeScript types (zero DOM references):
  - Multi-token case-insensitive recent search across `title` and `path` (`CR-006`).
  - Ellipsis pagination (`<= 7` pages show all; otherwise `[1, ..., totalPages]` matching `CR-004`).
  - Outline normalization (`buildOutlineModel`), active node resolution preserving `preferredNodeId` on shared-page bookmarks, collapsed-ancestor highlight fallback (`resolveVisibleActiveNodeId`), and initial expanded-id computation (`createInitialExpandedIds` returning `SvelteSet<string>` or `string[]`).
  - Search match grouping (`groupMatchesByPage`), initial match selection at/after `currentPageIndex` with wrap-around, and `stepMatchIndex`.
  - Exact error copy in `formatOpenError` (`io`, `password_protected`, `unsupported_format`, `invalid_document`, default fallback, `canRemoveRecent` flag).

### 4.3 Lifecycle & Persistence Primitives (`doc-scope.ts` & `persistence.ts`)
1. **`DocumentScopeRegistry` (`src/lib/state/doc-scope.ts`)**:
   - `ensure(documentId)` / `getSignal(documentId)`: returns root `AbortSignal` for an open document.
   - `beginSearch(documentId)`: aborts any prior search controller for `documentId`, creates a fresh `AbortController` linked to the document's root signal (if root aborts, search aborts automatically), and returns its `AbortSignal`.
   - `cancelSearch(documentId)`: aborts active search for `documentId` without closing the document.
   - `dispose(documentId)`: aborts root controller and deletes registry entry.
   - `disposeAll()`: cleanup helper for app shutdown / test teardown.
2. **`PersistenceQueue` (`src/lib/state/persistence.ts`)**:
   - `schedule(params: SaveReadingStateParams)`: debounces `400ms` **per `params.path`**. Scheduling path B never cancels or overwrites path A.
   - `flush(path: string)`: cancels timer for `path`, removes entry, awaits `api.saveReadingState(payload)` (catching & logging errors without throwing to callers).
   - `flushAll()`: flushes every pending path concurrently via `Promise.allSettled`.
   - `cancel(path: string)`: clears pending timer and discards queued payload for `path`.
   - `hasPending(path?: string)`: helper for deterministic unit assertions.

### 4.4 Normalized Runes Store (`src/lib/state/app-store.svelte.ts`)
- Export `createAppStore()` (instance factory, no module-level singleton):
  - State fields: `tabOrder` (`string[]`), `tabsById` (`SvelteMap<string, TabItem>`), `docsById` (`SvelteMap<number, DocState>`), `activeTabId` (`string | null`), `recents` (`RecentFile[]`), `recentQuery` (`string`), `recentPage` (`number`), `banner` (`BannerState | null`), `isDraggingFiles` (`boolean`), `isWindowMaximized` (`boolean`), `focusRequest` (`{ target: "viewport" | "home_open" | "search_input" | "page_input" | "recent_search"; seq: number } | null`).
  - Derived getters using `$derived`: `orderedTabs`, `activeTab`, `activeDoc`, `isHomeActive`, `hasAnyTabs`, `shellMode`, `windowTitle`, `toolbarModel`, `filteredRecents`, `totalRecentPages`, `clampedRecentPage`, `pagedRecents`, `recentRangeLabel`.
  - Pure query helpers: `getAdjacentTabId(delta: 1 | -1)`, `getTabIdAtShortcutIndex(digit: number)`.
  - Ensure `DocOutlineState.expandedIds` uses `SvelteSet<string>` so expanding/collapsing a single TOC node updates only that branch reactively!

### 4.5 Unidirectional Actions Orchestrator (`src/lib/state/actions.ts`)
Export `createAppActions({ store, api, scopes, persistence, hooks })` implementing every app intent cleanly:
- **Single transition helper (`deactivateCurrentDocument`)**:
  - Invokes `hooks.cancelPageInput?.()`, `hooks.captureTocScroll?.(doc)`, `hooks.captureViewportSnapshot?.(doc)`.
  - Persists outgoing state cleanly (or cancels debounced save when closing to let the explicit close-snapshot save run once).
- **Tab & Document Actions**:
  - `bootstrap()`: loads recents + initial CLI file (`getInitialFile`).
  - `openPath(path, options?)` & `openPathBatch(paths)` & `openViaDialog()`: deduplicates concurrent in-flight opens (`inFlightOpenPaths`), supports CR-001 in-place Home tab replacement (first file replaces Home; already-open file removes Home and focuses existing tab), resets Home recent search/page on success, routes errors to unified `store.banner` (`scope: "home"` vs `"workspace"`), preserves batch error feedback if a valid file opens later in the batch.
  - `openHomeTab()`: deactivates outgoing doc, flushes its save, opens/focuses singleton `Home` tab recording `returnToTabId`, refreshes recents, requests focus on `#empty-open-btn`.
  - `selectTab(tabId)`: routes `HOME_TAB_ID` to `openHomeTab()`, otherwise deactivates outgoing doc, switches `activeTabId`, requests viewport focus.
  - `closeTab(tabId)`: handles Home tab close (no IPC, restores `returnToTabId` or adjacent tab) and Document tab close (`scopes.dispose(documentId)`, cancels pending debounce, prunes singleton Home tab if zero docs remain per CR-001, saves final snapshot, calls `api.closeDocument`, calls `hooks.onDocumentClosed?.(documentId)` so `text-layer` evicts LRU cache, refreshes recents if now on Home).
  - `reorderTab(fromIndex, toIndex)` & `moveTabBy(tabId, delta)`: updates `store.tabOrder` atomically (CR-003).
- **Viewport & Zoom Actions**:
  - `applyViewportSnapshot(documentId, snapshot, reason: "mount" | "user")`: updates `doc.view` (`pageIndex`, `scrollTop`, `scrollAnchor`, `zoomMode`, `zoomScale`). **Calls `persistence.schedule(...)` ONLY when `reason === "user"`** (fixes spurious save on tab switch!).
  - `requestZoomMode(mode)`, `requestZoomStep(direction)`, `requestJumpToPage(pageIndex)` (invoking registered viewport command hook or updating state cleanly).
- **TOC Actions**:
  - `toggleToc()`, `closeToc()`, `ensureOutlineLoaded(documentId)` (guarded by `scopes.getSignal(documentId)` — fixes legacy unguarded `toc.js` async close race!), `setTocNodeExpanded(documentId, nodeId, expanded)`, `selectTocNode(documentId, node)`.
- **Search Actions**:
  - `openSearch()`, `closeSearch({ focusViewport })`, `toggleSearch()`, `setSearchQuery(query)` (per-tab 200ms debounce + 120ms delayed `"Searching…"` flag + `scopes.beginSearch(docId)` cancellation + serialized execution matching legacy behavior), `stepSearchMatch(delta: 1 | -1)`.
  - Increments `search.highlightVersion` on match/active changes and `search.scrollToMatchSeq` when the viewport should scroll to the active match.
- **Home Recents & Banner Actions**:
  - `refreshRecents()`, `removeRecent(path)`, `setRecentQuery(query)`, `clearRecentSearch()`, `setRecentPage(page)`, `dismissBanner()`, `triggerBannerAction()`.
- **Window & Shutdown Actions**:
  - `flushActiveReadingState()` (captures active snapshot + flushes all pending saves for `beforeunload` and window close button).

---

## 5. Verification Plan (Vitest Unit Suite)

Write deterministic Vitest tests covering all critical invariants:
1. `src/lib/ipc/__tests__/binary.test.ts`: valid RGBA decoding, little-endian dimension header, truncated buffer rejection, zero-dimension rejection, `normalizeApiError` & `isCancelledError`.
2. `src/lib/domain/__tests__/domain.test.ts`: `deriveTitle`, `getNextZoomStep`, `filterRecentFiles` (multi-token across title & path), `getVisiblePageItems` (boundaries 1..20 pages), `buildOutlineModel` + `resolveActiveOutlineNodeId` + `resolveVisibleActiveNodeId`, `groupMatchesByPage` + `stepMatchIndex`, `formatOpenError`.
3. `src/lib/state/__tests__/persistence.test.ts`: per-path 400ms debounce isolation (Tab A & Tab B never clobber each other), `flush(path)`, `flushAll()`, `cancel(path)`.
4. `src/lib/state/__tests__/doc-scope.test.ts`: root abort cascades to search signal; `beginSearch` aborts previous search without aborting doc scope; `dispose` cleans up registry.
5. `src/lib/state/__tests__/actions.test.ts` (using fake `ReaderApi` + `$effect.root` + fake timers):
   - Open new doc, dedup `already_open`, open batch with mixed valid/invalid files.
   - CR-001: singleton `Home` tab creation, duplicate `+` focus, in-place replacement by new doc, removal when focusing already-open doc, auto-pruning when closing last document tab, `returnToTabId` restore on closing Home.
   - CR-003: `reorderTab` and `moveTabBy` updating `getAdjacentTabId` and `getTabIdAtShortcutIndex` (`Ctrl+1..9`).
   - **Fix verification**: `applyViewportSnapshot(..., "mount")` does **not** trigger `saveReadingState`; `reason: "user"` does.
   - **Fix verification**: Closing a tab while `getOutline` or `searchDocument` is still pending never mutates state or throws after resolution.
   - **Fix verification**: Unified `banner` switches cleanly between `scope: "home"` and `scope: "workspace"`.

### Automated Commands
```powershell
pnpm verify
```

---

## 6. Exit Gate Checklist

- [ ] `src/lib/ipc/`, `src/lib/domain/`, and `src/lib/state/` compile with zero `any`, zero `svelte-check` errors, and zero `tsc --noEmit` errors.
- [ ] All Vitest unit suites in `src/lib/**/__tests__/` pass with zero skipped assertions.
- [ ] Every diagnosed sync defect (spurious save on mount, single-slot save overwrite, unguarded TOC async close, duplicated banners) has a dedicated passing regression test.
- [ ] `pnpm verify` passes completely.
- [ ] Legacy vanilla app still runs cleanly in `cargo tauri dev` with zero regressions.
