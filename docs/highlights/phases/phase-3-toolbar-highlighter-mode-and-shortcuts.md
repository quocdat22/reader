# Phase 3: Toolbar Highlighter Mode Controls & Keyboard Ergonomics

> **Read First**: [README.md](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md) · [PHASES.md](../PHASES.md) · `.agents/skills/frontend-design/SKILL.md`

---

## 1. Goal & Preconditions

**Goal**: Deliver live, end-to-end text highlight creation and persistence in the running desktop application:
1. Execute the mandatory `frontend-design` two-pass design plan and self-critique for the Toolbar Highlighter Mode control.
2. Add `HighlighterIcon.svelte` and integrate a single `26×26px` Highlighter Mode toggle button into `Toolbar.svelte` that reveals inline 3-color swatches (`Yellow`, `Green`, `Pink`) only while active.
3. Wire `highlight-layer.ts` into `ViewportHost.svelte` so dragging text in Highlighter Mode instantly creates and persists highlights (including cross-page passages and near-duplicate overlap handling) while Reading Mode remains 100% popover-free.
4. Wire Highlighter Mode keyboard shortcuts (`Ctrl+Shift+H`, `1`/`2`/`3` while active, and `Esc` exit) into `src/lib/engines/shortcuts.ts`.

**Preconditions**:
- Phase 2 Exit Gate is 100% satisfied (`pnpm verify` passes and highlight/selection engines are unit-tested).
- Read `.agents/skills/frontend-design/SKILL.md` before writing any Svelte template or CSS.

---

## 2. Scope Boundaries

### In Scope
- Mandatory two-pass `frontend-design` plan + self-critique for `Toolbar.svelte` highlight controls.
- `src/components/icons/HighlighterIcon.svelte` (**NEW**): crisp inline SVG icon matching existing `14–16px` toolbar icon stroke weight and geometry.
- `src/components/Toolbar.svelte`: single `#highlight-mode-btn` (`26×26px`) at rest with subtle active-color bar/dot; inline `#highlight-color-picker` (`Yellow`, `Green`, `Pink`) revealed only when `toolbarModel.highlighterMode === true`.
- `src/components/ViewportHost.svelte`: instantiate `createHighlightLayerEngine`, bridge it into `createViewportEngine`, sync `doc.highlights.version` via `$effect`, toggle `.viewport--highlighter-mode` class on `#viewport`, and wire `onCreateFromSelection` → `actions.createHighlightFromSelection`.
- `src/lib/engines/shortcuts.ts`: add `Ctrl+Shift+H`, unmodified `1`/`2`/`3` (strictly when `highlighterMode === true`), and `Esc` exit for Highlighter Mode.
- Unit tests covering new `shortcuts.ts` rules and live `cargo tauri dev` verification against `tests/fixtures/*.pdf`.

### Out of Scope (Do Not Touch in Phase 3)
- No `HighlightPopover.svelte` (clicking an existing highlight to recolor/copy/delete is Phase 4; `onSelectHighlight` can remain a clean no-op or store-only hook until Phase 4 mounts the popover).
- No `Delete`/`Backspace` popover shortcut yet (Phase 4).
- No Rust backend edits.
- No Highlights Drawer or notes UI.

---

## 3. Files to Create / Modify

| Action | Path | Responsibility |
| --- | --- | --- |
| **NEW** | `src/components/icons/HighlighterIcon.svelte` | Minimalist inline SVG highlighter pen nib icon (15×15px, `currentColor`, optional tiny color accent indicator). |
| **MODIFY** | `src/components/Toolbar.svelte` | Add `#highlight-mode-btn` + conditional inline 3-swatch `#highlight-color-picker` beside Search; verify responsive narrow-viewport (`<= 740px`) fit. |
| **MODIFY** | `src/components/ViewportHost.svelte` | Create & destroy `highlightLayer`, pass to `createViewportEngine`, wire `$effect` syncing `doc.highlights.version` and `store.highlighterMode`, clear selection on mode toggle if needed. |
| **MODIFY** | `src/lib/engines/shortcuts.ts` | Add `Ctrl+Shift+H` toggle, mode-scoped `1`/`2`/`3` color selection, and `Esc` exit step for Highlighter Mode. |
| **MODIFY** | `src/lib/state/__tests__/actions.test.ts` (or new `shortcuts.test.ts`) | Unit tests for `Ctrl+Shift+H`, `1`/`2`/`3` gating (does not fire in Reading Mode, editable inputs, TOC, or with `Ctrl+1..9`), and `Esc` precedence. |

---

## 4. Detailed Technical Tasks

### 4.1 Mandatory `frontend-design` Two-Pass Plan
Before writing `.svelte` / `<style>` changes:
1. Draft a concise design plan respecting `reader`'s locked 6-token palette (`#E4E7EC`, `#EEF0F4`, `#FFFFFF`, `#1A1F2B`, `#5A6475`, `#1E4DB7`) plus the 3 curated highlight swatch tokens from [ARCHITECTURE.md §6.1](../ARCHITECTURE.md#61-curated-3-color-tokens-srcstylestokenscss).
2. Self-critique against anti-template guardrails:
   - At rest (`highlighterMode === false`), the toolbar adds **zero** extra width beyond one `26×26px` `.icon-btn` — no permanent multi-dot clutter, no colored pill badges, no gradients or drop shadows.
   - When active (`highlighterMode === true`), the 3 inline swatches sit in a quiet hairline pill or tight flex group (`gap: 4px`, `height: 24px`) so active color state is immediately scannable without shifting center page controls unexpectedly.
   - All swatches have strong tactile click targets (`20×20px` hit box wrapping a `12×12px` filled dot with inner hairline border) and crisp `:focus-visible` cobalt rings.

### 4.2 Toolbar Controls (`Toolbar.svelte` & `HighlighterIcon.svelte`)
1. Place the highlight control inside `.toolbar-group--right` right before `#search-toggle-btn` (after the existing `.toolbar-sep` following `.fit-control`).
2. Render `#highlight-mode-btn`:
   - `class="icon-btn highlight-mode-btn"`, `type="button"`
   - `title="Highlighter mode (Ctrl+Shift+H)"`, `aria-label="Highlighter mode"`
   - `aria-pressed={Boolean(toolbarModel?.highlighterMode)}`
   - `onclick={() => actions.toggleHighlighterMode()}`
   - Displays `<HighlighterIcon color={toolbarModel?.activeHighlightColor ?? "yellow"} />` with a subtle `2px` color bar at the base of the icon showing the remembered color even while collapsed.
3. Conditionally render `#highlight-color-picker` **only** when `toolbarModel?.highlighterMode` is `true`:
   - `role="radiogroup"`, `aria-label="Highlight color"`
   - Three buttons (`yellow`, `green`, `pink`), each with `role="radio"`, `aria-checked={toolbarModel.activeHighlightColor === color}`, `title="{Label} ({index + 1})"`, `aria-label="{Label} highlight"`, `onclick={() => actions.setActiveHighlightColor(color)}`.
   - Active swatch shows a crisp `1.5px` ring (`--ink-primary` or `--accent-cobalt` with `1px` white inset gap) that remains clear without relying on color alone.
4. Confirm `@media (max-width: 740px)` keeps the toolbar horizontally clean without clipping controls down to `640px` width.

### 4.3 `ViewportHost.svelte` Wiring
1. Inside the imperative engine `$effect`:
   - Instantiate `highlightLayer = createHighlightLayerEngine({ viewportEl, getHighlighterMode: () => store.highlighterMode, isLinkAtPoint: (x, y) => linkLayer.hasLinkAtClientPoint(x, y), extractSelection: (slots) => textLayer.extractSelectionSegments(slots), clearActiveSelection: () => textLayer.clearActiveSelection(), onCreateFromSelection: (docId, segments, quote) => { void actions.createHighlightFromSelection(docId, segments, quote); }, onSelectHighlight: (docId, highlightId, anchorRect) => { actions.openHighlightPopover({ documentId: docId, highlightId, anchorRect }); }, onDismissPopover: () => { actions.closeHighlightPopover(); } })`.
   - Pass `highlightLayer` to `createViewportEngine(...)`.
   - Destroy `highlightLayer` before `linkLayer` / `textLayer` in cleanup.
2. Add a focused `$effect` mirroring `syncSearchHighlights`:
   - Track `store.activeDoc?.highlights.version` and `store.activeDoc?.documentId`.
   - Call `viewportEngine.syncUserHighlights(doc ? doc.highlights.byPage : null)`.
3. Reflect `store.highlighterMode` on `#viewport` (`class:viewport--highlighter-mode={store.highlighterMode}`).
4. Ensure `ViewportMountInput` passes initial `highlightsByPage: doc.highlights.byPage` inside `untrack(...)` so switching tabs immediately paints cached highlights on the first visible render pass with zero flash.

### 4.4 Keyboard Shortcuts (`src/lib/engines/shortcuts.ts`)
1. Add `Ctrl+Shift+H` inside the `primaryMod && !event.altKey` block:
   - `if (event.shiftKey && lower === "h")`: when `store.activeDoc`, `event.preventDefault()`, call `actions.toggleHighlighterMode()`.
2. Add unmodified `1` / `2` / `3` handling **strictly** when `!primaryMod && !event.altKey && !event.shiftKey && !inEditable && !isInsideToc(target) && store.activeDoc && store.highlighterMode`:
   - `"1"` → `actions.setActiveHighlightColor("yellow")`
   - `"2"` → `actions.setActiveHighlightColor("green")`
   - `"3"` → `actions.setActiveHighlightColor("pink")`
3. Update `Escape` precedence ladder:
   - Existing step 1: `inEditable && !isInsideSearch(target)` → blur & focus viewport.
   - (Placeholder for Phase 4 step 2: open `HighlightPopover`).
   - Existing step 3: open `SearchBar` → `actions.closeSearch({ focusViewport: true })`.
   - New step 4: `store.activeDoc && store.highlighterMode` → `event.preventDefault(); actions.setHighlighterMode(false); return;`.
   - Existing step 5: TOC / general focus → `handleEscapeFocus()`.

---

## 5. Verification Plan

### Automated Verification
```powershell
pnpm verify
```
Include unit tests validating:
- `Ctrl+Shift+H` toggles `highlighterMode` only when a document tab is active.
- `1`/`2`/`3` switches `activeHighlightColor` only when `highlighterMode === true`, not inside inputs/TOC, and never intercepts `Ctrl+1..9`.
- `Esc` closes `SearchBar` first, then exits `Highlighter Mode` on the next `Esc` press.

### Live Manual Verification (`cargo tauri dev` with local `tests/fixtures/*.pdf`)
1. **Quiet Reading Mode**: With Highlighter Mode OFF, drag-select text across lines and press `Ctrl+C` — confirm **zero** popover appears and clipboard copy matches PDF text cleanly.
2. **Toolbar Ergonomics**: Click `#highlight-mode-btn` (and test `Ctrl+Shift+H`) — confirm inline 3 swatches appear cleanly, `1`/`2`/`3` switches active swatch, `Esc` exits mode back to single icon.
3. **Single-Line, Multi-Line & Cross-Page Creation**:
   - Drag across part of a single word/line in Yellow, Green, and Pink — confirm crisp `multiply` overlay with razor-sharp black ink underneath and browser selection auto-cleared.
   - Drag across multiple lines and across a page boundary (`page N` → `page N+1`) — confirm unified rendering on both pages.
   - Re-drag over the exact same passage in the same color (no duplicate created) and in a different color (recolors in place).
4. **Zoom & Persistence Across Restart / Rename**:
   - Zoom from `Fit width` → `150%` → `Fit page` — confirm highlights stay tightly aligned to text without drift.
   - Close tab and reopen the PDF — confirm all highlights reload identically.
   - Make a temporary copy of a local `tests/fixtures/*.pdf` in a temp directory, highlight it, rename/move the temp copy, reopen it — confirm highlights survive move/rename via content fingerprint (then remove the temp copy).

---

## 6. Exit Gate Checklist

- [ ] Mandatory two-pass `frontend-design` plan & self-critique completed before writing Svelte/CSS.
- [ ] Single `26×26px` Highlighter button appears at rest; inline `[Yellow | Green | Pink]` swatches expand cleanly when active and remain usable down to `640×480`.
- [ ] Reading Mode drag-select produces zero popovers; Highlighter Mode drag-select creates and persists single-line, multi-line, and cross-page highlights cleanly.
- [ ] `Ctrl+Shift+H`, `1`/`2`/`3`, and `Esc` precedence ladder pass unit tests and live verification.
- [ ] `pnpm verify` passes with zero warnings or errors.
- [ ] Live `cargo tauri dev` verification confirms visual restraint, zoom alignment, and move/rename persistence against `tests/fixtures/*.pdf`.
