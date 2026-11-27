# Phase 2: Imperative Highlight Layer & Selection-to-Geometry Engines

> **Read First**: [README.md](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md) · [PHASES.md](../PHASES.md)

---

## 1. Goal & Preconditions

**Goal**: Build the framework-agnostic imperative TypeScript engines and CSS layer foundation required to render highlights over PDF pages, extract crisp normalized geometry from native browser selections, and coordinate clicks cleanly with PDF `/Link` annotations:
1. Extend `src/lib/engines/text-layer.ts` with `extractSelectionSegments(slotElements)` (hybrid horizontal `subRange` projection + exact PDFium `TextSpan.rect` vertical bounds + formatted `quote`).
2. Extend `src/lib/engines/link-layer.ts` with `hasLinkAtClientPoint(clientX, clientY)` so PDF links always retain hover & click precedence over highlights.
3. Build `src/lib/engines/highlight-layer.ts` managing virtualized per-page `.highlight-layer` DOM overlays, reverse z-order hit-testing, hover cues, click-to-inspect callbacks, and drag-to-highlight selection capture.
4. Wire `HighlightLayerViewportBridge` into `src/lib/engines/viewport.ts` and update the `.page-slot` z-index stack and curated 3-color CSS tokens (`src/styles/tokens.css`, `src/styles/viewport-layers.css`).

**Preconditions**:
- Phase 1 Exit Gate is 100% satisfied (`cargo test` and `pnpm verify` pass).

---

## 2. Scope Boundaries

### In Scope
- `src/lib/engines/text-layer.ts`: add `extractSelectionSegments()` returning `{ segments: HighlightSegment[]; quote: string } | null`.
- `src/lib/engines/link-layer.ts`: expose `hasLinkAtClientPoint(clientX, clientY)` on `LinkLayerEngine`.
- `src/lib/engines/highlight-layer.ts` (**NEW**): pure imperative TypeScript engine (zero Svelte imports).
- `src/lib/engines/viewport.ts`: accept optional `highlightLayer` bridge, call `syncVisibleRange` / `evictOutside` / `clearMounted`, expose `syncUserHighlights(byPage)`.
- `src/styles/tokens.css` & `src/styles/viewport-layers.css`: add 3 curated highlight color tokens (`yellow`, `green`, `pink`) and updated z-index stack (`canvas: 1`, `highlight: 2`, `search: 3`, `link: 4`, `text: 5`).
- Comprehensive Vitest unit tests for `text-layer` extraction, `highlight-layer`, and `link-layer` hit-test coordination.

### Out of Scope (Do Not Touch in Phase 2)
- No Toolbar Highlighter Mode UI or `shortcuts.ts` bindings yet (Phase 3).
- No `HighlightPopover.svelte` UI component yet (Phase 4).
- No Rust backend edits.

---

## 3. Files to Create / Modify

| Action | Path | Responsibility |
| --- | --- | --- |
| **NEW** | `src/lib/engines/highlight-layer.ts` | Virtualized `.highlight-layer` DOM rendering, hover state, reverse z-order hit-testing, Highlighter Mode `pointerup` selection capture, link-precedence check, deterministic `destroy()`. |
| **MODIFY** | `src/lib/engines/text-layer.ts` | Add `extractSelectionSegments(slotElements)` reusing `spanMetaByEl`, `subRange`, and `formatCopiedFragments`. |
| **MODIFY** | `src/lib/engines/link-layer.ts` | Expose `hasLinkAtClientPoint(clientX, clientY): boolean` reusing `resolveHitAtClientPoint`. |
| **MODIFY** | `src/lib/engines/viewport.ts` | Add `HighlightLayerViewportBridge`, wire `syncVisibleRange` / `evictOutside` / `clearMounted`, add `syncUserHighlights(byPage)` and `getSlotElements()`/`ViewportMountInput.highlightsByPage`. |
| **MODIFY** | `src/styles/tokens.css` | Add `--hl-{yellow,green,pink}-{bg,hover-bg,swatch,swatch-border}` CSS custom properties. |
| **MODIFY** | `src/styles/viewport-layers.css` | Add `.highlight-layer`, `.pdf-highlight-group`, `.pdf-highlight-rect--{yellow,green,pink}`, `.pdf-highlight-group--hover`, `.pdf-highlight-group--selected`, `.viewport--highlight-hover`, `.viewport--highlighter-mode`; update z-indices (`search: 3`, `link: 4`, `text: 5`). |
| **NEW** | `src/lib/engines/__tests__/highlight-layer.test.ts` | Deterministic Vitest suite covering rendering, virtualization/eviction, hit-testing, link-click precedence, Highlighter Mode drag capture, and cleanup. |
| **MODIFY** | `src/lib/engines/__tests__/link-layer.test.ts` | Add unit tests for `hasLinkAtClientPoint()`. |

---

## 4. Detailed Technical Tasks

### 4.1 Selection Geometry Extraction (`src/lib/engines/text-layer.ts`)
1. Export `ExtractedSelection { readonly segments: HighlightSegment[]; readonly quote: string }`.
2. Add `extractSelectionSegments(slotElements: readonly HTMLDivElement[]): ExtractedSelection | null` on `TextLayerEngine`:
   - Inspect `window.getSelection()`; return `null` if collapsed, empty, or outside `viewportEl`.
   - Traverse `mountedLayers` sorted ascending by `pageIndex` (identical structure to `handleCopy()`).
   - For each intersecting `.text-span` with `meta = spanMetaByEl.get(spanEl)`:
     - Clip `subRange` to `spanEl` boundaries.
     - Collect `piece = subRange.toString()`. If `piece.length === 0`, skip.
     - Always push `{ pageIndex: meta.pageIndex, text: piece, rect: meta.rect }` into `copiedFragments` (preserving exact whitespace formatting via `formatCopiedFragments`).
     - If `piece.trim().length > 0`, project `subRange.getBoundingClientRect()` horizontally against `slotEl.getBoundingClientRect()`:
       - Compute normalized `x0 = (rangeRect.left - slotRect.left) / slotRect.width` and `x1 = (rangeRect.right - slotRect.left) / slotRect.width`.
       - Clamp `[x0, x1]` inside `[meta.rect.x, meta.rect.x + meta.rect.width]`.
       - Use PDFium's exact vertical span metrics: `y = meta.rect.y`, `height = meta.rect.height`.
       - Discard degenerate rects where `x1 - x0 <= 0` or `slotRect.width <= 0`.
   - Normalize collected per-page rects with `normalizeHighlightSegments(rawSegments)` from `src/lib/domain/highlights.ts`.
   - Return `segments.length > 0 ? { segments, quote: formatCopiedFragments(copiedFragments) } : null`.

### 4.2 Link Hit-Test Query (`src/lib/engines/link-layer.ts`)
1. Expose `hasLinkAtClientPoint(clientX: number, clientY: number): boolean` on `LinkLayerEngine` delegating directly to `resolveHitAtClientPoint(clientX, clientY) !== null`.
2. Verify zero behavioral changes to existing link hover, tooltips, drag suppression, or keyboard `.pdf-link-hit` activation.

### 4.3 Imperative Highlight Layer Engine (`src/lib/engines/highlight-layer.ts`)
1. Define clean options & interface (zero Svelte imports):
   ```ts
   export interface HighlightLayerEngineOptions {
     readonly viewportEl: HTMLElement;
     readonly getHighlighterMode: () => boolean;
     readonly isLinkAtPoint: (clientX: number, clientY: number) => boolean;
     readonly extractSelection: (
       slotElements: readonly HTMLDivElement[],
     ) => ExtractedSelection | null;
     readonly clearActiveSelection: () => void;
     readonly onCreateFromSelection: (
       documentId: number,
       segments: HighlightSegment[],
       quote: string,
     ) => void;
     readonly onSelectHighlight: (
       documentId: number,
       highlightId: string,
       anchorRect: HighlightAnchorRect,
     ) => void;
     readonly onDismissPopover: () => void;
   }
   ```
2. **DOM mounting & updates**:
   - `syncVisibleRange({ documentId, renderMin, renderMax, slotElements, pageOffsets })` mounts `.highlight-layer` for visible/overscan pages that have entries in the active `byPage` map.
   - `syncHighlights(byPage: ReadonlyMap<number, readonly PageHighlightEntry[]> | null)` updates the active highlight map and repaints currently mounted pages cleanly (removing `.highlight-layer` on pages that no longer have highlights).
   - `setSelectedHighlightId(highlightId: string | null)` toggles `.pdf-highlight-group--selected` across all mounted pages for that highlight ID (supports cross-page visual emphasis while popover is open).
   - `evictOutside(keepMin, keepMax)` removes distant `.highlight-layer` DOM nodes and clears hover if the hovered page was evicted.
   - `clearMounted()` removes all mounted layers, resets hover/pointer state, and clears document context on tab switch/unmount.
   - `destroy()` detaches all DOM listeners cleanly (`pointerdown`, `pointermove`, `pointerup`, `pointerleave`, `scroll`, `click`).
3. **Pointer interaction state machine**:
   - **`pointerdown` (`button === 0`)**: record `{ x, y, hadSelection, dragged: false }`.
   - **`pointermove`**:
     - While primary button held: mark `dragged = true` when distance `> 4px` and clear hover.
     - While hovering (no primary button held): if `isLinkAtPoint(clientX, clientY)` is true, clear highlight hover so link hover wins cleanly; otherwise resolve page + `(normX, normY)` via `findFirstPageAtOrAfter` + `slot.getBoundingClientRect()` and run `hitTestPageHighlights`; apply `.pdf-highlight-group--hover` across all mounted segments of that `highlightId` plus `.viewport--highlight-hover` on `#viewport`.
   - **`pointerup` (`button === 0`)**:
     - When `getHighlighterMode()` is `true` and a non-collapsed selection exists inside `#viewport`, run `extractSelection(currentWindow.slotElements)`. If non-null, call `clearActiveSelection()` and `onCreateFromSelection(documentId, segments, quote)`.
   - **`click` (`button === 0`, `detail === 1`, `!down?.dragged`, `!event.defaultPrevented`)**:
     - Skip if a non-collapsed text selection is active or if `isLinkAtPoint(clientX, clientY)` is `true` (PDF links always win clicks!).
     - Hit-test highlights at `(clientX, clientY)`:
       - On hit: compute `anchorRect` (clicked rect converted to coordinates relative to `viewportEl.parentElement` / `.viewport-host`, falling back to `viewportEl`) and invoke `onSelectHighlight(documentId, hit.highlightId, anchorRect)`.
       - On miss: invoke `onDismissPopover()`.
   - **`scroll` (passive)**: clear hover state and invoke `onDismissPopover()`.

### 4.4 Viewport Bridge & Layer CSS (`viewport.ts`, `tokens.css`, `viewport-layers.css`)
1. Update `src/lib/engines/viewport.ts`:
   - Add `HighlightLayerViewportBridge` and optional `highlightLayer` dependency on `ViewportEngineOptions`.
   - Call `highlightLayer?.syncVisibleRange(...)` inside `scheduleVisibleRenders()`, `highlightLayer?.evictOutside(keepMin, keepMax)` inside `evictDistantCanvases()`, and `highlightLayer?.clearMounted()` inside `unmount()`.
   - Add `syncUserHighlights(byPage)` on `ViewportEngine` forwarding to `highlightLayer?.syncHighlights(byPage)`.
2. Update `src/styles/tokens.css` with the curated 3-color tokens from [ARCHITECTURE.md §6.1](../ARCHITECTURE.md#61-curated-3-color-tokens-srcstylestokenscss).
3. Update `src/styles/viewport-layers.css`:
   - Keep `.page-canvas` at `z-index: 1`.
   - Add `.highlight-layer` at `z-index: 2` (`position: absolute; inset: 0; pointer-events: none; user-select: none; mix-blend-mode: multiply;`).
   - Bump `.search-layer` to `z-index: 3`, `.link-layer` to `z-index: 4`, and `.text-layer` to `z-index: 5`.
   - Add `.pdf-highlight-rect`, color modifiers `--yellow`/`--green`/`--pink`, hover/selected modifiers, `.viewport--highlight-hover` cursor rule (ensuring `.viewport--link-hover` still takes visual precedence), and `prefers-reduced-motion`-friendly `90ms` transitions.

---

## 5. Verification Plan

### Vitest Unit Suites
1. `src/lib/engines/__tests__/highlight-layer.test.ts`:
   - Mounts `.highlight-layer` with exact `%` coordinates for single-page and multi-page highlights; removes layer when page has zero highlights.
   - `evictOutside` removes distant pages while keeping in-range pages intact.
   - Reverse z-order hit-testing selects newest highlight on overlap; hover applies `.pdf-highlight-group--hover` across all mounted pages of a cross-page highlight.
   - Link precedence: when `isLinkAtPoint` returns `true`, hover is suppressed and `click` does **not** invoke `onSelectHighlight`.
   - Drag suppression: pointer drag `> 4px` does **not** trigger `onSelectHighlight`.
   - Highlighter Mode: `pointerup` with active selection extracts segments, clears browser selection, and fires `onCreateFromSelection`; when Highlighter Mode is `false`, `pointerup` does nothing.
   - `scroll` clears hover and fires `onDismissPopover`.
   - `destroy()` detaches all DOM listeners cleanly.
2. `src/lib/engines/__tests__/link-layer.test.ts`:
   - Verify `hasLinkAtClientPoint` returns `true` over cached link rects and `false` elsewhere.
3. Text selection geometry extraction unit test (inside `highlight-layer.test.ts` or dedicated `text-layer` test):
   - Verifies horizontal clamping inside `meta.rect`, exact vertical PDFium rect snapping, multi-span merging, cross-page segment ordering, and clean `quote` output.

### Automated Commands
```powershell
pnpm verify
```

---

## 6. Exit Gate Checklist

- [ ] `highlight-layer.ts`, `text-layer.ts`, `link-layer.ts`, and `viewport.ts` maintain zero Svelte imports and deterministic `destroy()` cleanup.
- [ ] `.page-slot` z-index stacking cleanly separates `canvas (1) < highlight (2) < search (3) < link (4) < text (5)`.
- [ ] Link hover & click precedence over highlighted links is verified by unit tests.
- [ ] All Vitest engine tests and `pnpm verify` (`format:check`, `lint`, `typecheck`, `check`, `test`, `build`) pass with zero warnings or errors.
- [ ] Existing app runs cleanly in `cargo tauri dev` with zero regressions to canvas rendering, text selection/copy, search highlights, or clickable links.
