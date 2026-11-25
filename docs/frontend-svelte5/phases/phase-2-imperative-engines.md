# Phase 2: Imperative TypeScript Engines (`viewport`, `text-layer`, `tab-drag`, `shortcuts`)

> **Read First**: [README.md](../README.md) · [ARCHITECTURE.md §4](../ARCHITECTURE.md#4-imperative-engine-boundary-srclibengines) · [PHASES.md](../PHASES.md)

---

## 1. Goal & Preconditions

**Goal**: Port the four browser-heavy imperative subsystems into clean, strictly typed TypeScript modules under `src/lib/engines/` with **zero Svelte imports** and **zero direct mutations of shared state objects**, extracting pure geometry/copy/drag math into unit-tested helper files.

**Preconditions**:
- Phase 1 Exit Gate is 100% satisfied (`src/lib/ipc/`, `src/lib/domain/`, `src/lib/state/` implemented and all Vitest tests passing).

---

## 2. Scope Boundaries

### In Scope
- `src/lib/engines/viewport-math.ts` + `src/lib/engines/viewport.ts`
- `src/lib/engines/text-copy.ts` + `src/lib/engines/text-layer.ts`
- `src/lib/engines/tab-drag.ts`
- `src/lib/engines/shortcuts.ts`
- Vitest unit suites for all pure engine math/copy/drag functions (`viewport-math.test.ts`, `text-copy.test.ts`, `tab-drag.test.ts`).

### Out of Scope (Do Not Touch in Phase 2)
- No `.svelte` components or CSS splitting yet (Phase 3 & Phase 4).
- Do not modify `index.html`, legacy `src/*.js`, or `src-tauri/`.

---

## 3. Files to Create

| Path | Responsibility |
| --- | --- |
| `src/lib/engines/viewport-math.ts` | Pure layout & geometry functions: `snapToDevicePixels`, `computeEffectiveScale`, `computeLayoutGeometry`, `computeTrackWidth`, `findFirstPageAtOrAfter`, `findLastPageAtOrBefore`, `resolveVisibleRange`, `computeScrollAnchor`, `resolveAnchorScrollTop`. |
| `src/lib/engines/viewport.ts` | Imperative virtualized HiDPI `<canvas>` viewport engine (`createViewportEngine`). |
| `src/lib/engines/text-copy.ts` | Pure `formatCopiedFragments()` joining multi-span/multi-line selection fragments from normalized geometry. |
| `src/lib/engines/text-layer.ts` | Imperative transparent HTML text overlay + internal per-`documentId` LRU `textCache` (`MAX_CACHED_PAGES_PER_TAB = 120`) + `copy` event `Range` interceptor (`createTextLayerEngine`). |
| `src/lib/engines/tab-drag.ts` | Pointer Events horizontal tab-strip drag-and-drop reorder engine (`computeOtherVisualLefts`, `createTabDragController` / Svelte Action compatible attachment). |
| `src/lib/engines/shortcuts.ts` | Centralized desktop keyboard & `Ctrl+Wheel` router wired directly to `{ store, actions, domQueries }`. |
| `src/lib/engines/__tests__/viewport-math.test.ts` | Unit tests for binary search, DPR snapping, fit-width/fit-page scaling, and zoom anchor preservation. |
| `src/lib/engines/__tests__/text-copy.test.ts` | Unit tests for same-line spacing, line breaks, page breaks, and empty-fragment handling. |
| `src/lib/engines/__tests__/tab-drag.test.ts` | Unit tests for `computeOtherVisualLefts` across variable-width tabs (e.g., narrow `Home` tab vs wide document tabs). |

---

## 4. Detailed Technical Tasks

### 4.1 Virtualized Viewport Engine (`viewport-math.ts` & `viewport.ts`)
Port all rendering and memory invariants from legacy `src/viewport.js` while decoupling from mutable `tab` objects:
1. **Strict memory & HiDPI invariants (preserved 1-to-1 from SPEC §5)**:
   - Constants: `PT_TO_CSS_PX = 96 / 72`, `PAGE_GAP_PX = 16`, `TRACK_PADDING_Y = 24`, `TRACK_PADDING_X = 48`, `OVERSCAN_RADIUS = 2`, `EVICT_RADIUS = 6`, `MAX_CONCURRENT_RENDERS = 2`, `MAX_DPR = 3`.
   - Device-pixel-snapped slot dimensions and `(left, top)` offsets (`Math.round(css * dpr) / dpr`), requesting exact physical `(widthPx, heightPx)` bitmaps and painting via `ctx.putImageData(imageData, 0, 0)`.
   - Re-layout and re-render automatically when `window.devicePixelRatio` changes (`matchMedia("(resolution: ...dppx)")`) or viewport resizes (`ResizeObserver`).
   - Release every `<canvas>` backing store (`canvas.width = 0; canvas.height = 0; canvas.remove()`) on eviction (`±6`), unmount, or tab switch.
2. **Decoupled input/output contract (zero mutation of store objects)**:
   - `mountDocument(input: ViewportMountInput)`: accepts a read-only snapshot `{ documentId, pageDimensions, pageIndex, scrollTop, scrollAnchor, zoomMode, zoomScale, search }` + optional `AbortSignal` from `DocumentScopeRegistry`.
   - **Explicit change reason**: `onViewStateChange(snapshot: ViewportSnapshot, reason: "mount" | "user")`:
     - Emits `"mount"` during `mountDocument()` (allows `actions` to store computed `fit_width`/`fit_page` `zoomScale` without scheduling `save_reading_state`!).
     - Emits `"user"` on user scroll, zoom change, resize-triggered relayout, or `scrollToPage` / `scrollPageStep` / `scrollToStart` / `scrollToEnd`.
   - `syncSearchHighlights(search: ViewportSearchInput | null)`: updates `.search-layer` / `.search-hit` overlays for visible + overscan range without reading a mutable `activeTab.searchState`.
   - `scrollToNormalizedRect(pageIndex, rect)`: preserves legacy search-bar top/bottom clearance (`56px`/`40px`) and `prefers-reduced-motion` awareness.
   - `captureSnapshot(): ViewportSnapshot | null`: pure read returning `{ documentId, pageIndex, scrollTop, scrollAnchor, zoomMode, zoomScale }` for `actions` pre-deactivate hook.
   - `destroy()`: disconnects `ResizeObserver`, `IntersectionObserver`, `dprMediaQuery`, scroll listener, and calls `unmount()` (clean Svelte `$effect` teardown!).

### 4.2 Text Selection Layer Engine (`text-copy.ts` & `text-layer.ts`)
Port all selection & clipboard invariants from legacy `src/text-layer.js`:
1. **Internal LRU cache ownership (removed from reactive state)**:
   - Store `cachesByDocId = new Map<number, Map<number, TextSpan[]>>()` privately inside `createTextLayerEngine({ viewportEl, api })`.
   - Enforce `MAX_CACHED_PAGES_PER_TAB = 120` with LRU recency refresh on hit.
   - Expose `evictDocument(documentId: number)` called when a document tab closes (frees memory cleanly without touching reactive store).
2. **Selection-safe eviction & copy interception**:
   - Preserve mounted `.text-layer` DOM while `window.getSelection()` intersects that slot during scrolling.
   - Re-scale mounted layers purely via CSS `transform: scale(sx, sy)` on zoom without re-fetching `get_page_text`.
   - Listen to `document.addEventListener("copy", handleCopy)` and format multi-span/multi-line/multi-page selections through `formatCopiedFragments()` (skipping when focus is inside `<input>` or `<textarea>`).
   - Expose `destroy()` removing the `copy` listener and clearing all caches/mounted layers.

### 4.3 Pointer Tab-Reorder Engine (`tab-drag.ts`)
Port all `CR-003` drag-and-drop semantics from legacy `src/tabs.js` into a standalone controller usable as a Svelte Action (`use:tabReorder`) on `#tab-list`:
- Preserves exact constants & mechanics: `DRAG_THRESHOLD_PX = 5`, `AUTO_SCROLL_EDGE_PX = 28`, `AUTO_SCROLL_MAX_STEP_PX = 10`, hysteresis thresholds (`0.45` left / `0.55` right), `setPointerCapture`, `tab-list--reordering` / `tab--dragging` classes, `Escape` / `blur` / `pointercancel` cancel, and click suppression (`shouldSuppressClick(tabId)` or capture click blocker) immediately after an active drag finishes.
- **No direct array mutation**: on drop when `targetIndex !== startIndex`, invokes `onCommitReorder(startIndex, targetIndex, { tabId, scrollLeft })` so `actions.reorderTab()` updates `store.tabOrder` and Svelte reconciles keyed DOM cleanly.
- Ignores `pointerdown` when `button !== 0`, inside `.tab-close-btn`, or when `< 2` tabs exist.
- Exposes `cancel()` and `destroy()` cleaning up all `window` listeners and `rAF` timers.

### 4.4 Centralized Keyboard & Wheel Shortcut Router (`shortcuts.ts`)
Port all keyboard and `Ctrl+Wheel` routing from legacy `src/shortcuts.js`, replacing the 21-callback bag with direct typed dependencies:
```ts
export interface ShortcutRouterDeps {
  store: AppStore;
  actions: AppActions;
  getViewportEl: () => HTMLElement | null;
  isInsideToc: (target: EventTarget | null) => boolean;
  isInsideSearch: (target: EventTarget | null) => boolean;
}
```
- Preserves 100% of SPEC §5 + `CR-001` + `CR-003` + `CR-006` rules:
  - Global chords: `Ctrl+O`, `Ctrl+W`, `Ctrl+Tab` / `Ctrl+Shift+Tab`, `Ctrl+1..9` (operating on `store.hasAnyTabs` including `Home`).
  - `Ctrl+F`: always calls `preventDefault()` (suppresses WebView2 native find bar); opens document search when `store.activeDoc` exists, or focuses Home recent search (`actions.focusHomeRecentSearch()`) when on Home (`CR-006`).
  - Document-only shortcuts (`Ctrl+G`, `Ctrl+B`, `Ctrl++`/`-`/`0`, `Ctrl+Wheel` with `WHEEL_ZOOM_THRESHOLD = 24` & `180ms` reset, `PageUp`/`PageDown`/`Home`/`End`, `Enter`/`Shift+Enter` for search matches when not inside inputs/TOC/buttons).
  - `Esc` precedence: editable non-search input → blur; active document search open → close search & focus viewport; otherwise blur focused control and refocus viewport when a document is active.
  - Guards IME composition (`event.isComposing`), AltGr (`ctrlKey && altKey`), and editable inputs cleanly.
- Returns a `() => void` cleanup function for Svelte `$effect`.

---

## 5. Verification Plan

### Automated Commands
```powershell
pnpm verify
```

### Required Vitest Unit Suites
- `src/lib/engines/__tests__/viewport-math.test.ts`:
  - `findFirstPageAtOrAfter` / `findLastPageAtOrBefore` on single-page, multi-page, variable-height, and out-of-bounds Y values.
  - `snapToDevicePixels` across DPR `1`, `1.25`, `1.5`, `2`, `3`.
  - `computeEffectiveScale` for `fit_width`, `fit_page`, and clamped `custom`.
  - `computeScrollAnchor` + `resolveAnchorScrollTop` round-trip accuracy across zoom changes.
- `src/lib/engines/__tests__/text-copy.test.ts`:
  - Same-line words separated by single space without doubling existing whitespace.
  - Vertical line breaks and cross-page transitions emit single `\n`.
  - Empty/blank fragments ignored cleanly.
- `src/lib/engines/__tests__/tab-drag.test.ts`:
  - `computeOtherVisualLefts` produces exact displaced X positions across mixed tab widths (`92px` Home tab + `220px` document tabs) for `targetIndex = 0`, middle, and end.

---

## 6. Exit Gate Checklist

- [ ] `viewport.ts`, `text-layer.ts`, `tab-drag.ts`, and `shortcuts.ts` have **zero Svelte imports** and **zero direct mutations** of store objects.
- [ ] `viewport.ts` emits explicit `"mount"` vs `"user"` snapshot reasons and releases all `<canvas>` backing stores on `unmount()` / `destroy()`.
- [ ] `text-layer.ts` owns its per-`documentId` LRU `textCache` privately with `evictDocument(docId)` cleanup.
- [ ] All pure engine math/copy/drag Vitest unit suites pass.
- [ ] `pnpm verify` (`format:check`, `lint`, `typecheck`, `check`, `test`, `build`) passes with zero errors or warnings.
- [ ] Legacy vanilla app still runs cleanly in `cargo tauri dev`.
