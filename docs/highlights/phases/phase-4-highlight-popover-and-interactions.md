# Phase 4: On-Page Highlight Popover (Recolor, Copy, Delete) & Link Coordination

> **Read First**: [README.md](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md) · [PHASES.md](../PHASES.md) · `.agents/skills/frontend-design/SKILL.md`

---

## 1. Goal & Preconditions

**Goal**: Complete the full on-page highlight interaction loop in a quiet, keyboard-accessible floating popover without ever obstructing text drag-selection or clickable PDF links:
1. Execute the mandatory `frontend-design` two-pass design plan and self-critique for `HighlightPopover.svelte`.
2. Build `CopyIcon.svelte`, `TrashIcon.svelte`, and `HighlightPopover.svelte` (`[Yellow | Green | Pink | Copy | Delete]`) with viewport-clamped auto-flipping positioning and deterministic dismissal.
3. Mount `HighlightPopover.svelte` inside `.viewport-host` (`App.svelte` / `ViewportHost.svelte`), sync selected highlight visual emphasis (`setSelectedHighlightId`), and wire `Delete`/`Backspace` + `Esc` (Step 2) shortcuts in `shortcuts.ts`.
4. Verify complete click & hover coordination with `link-layer.ts`, `search-layer`, and `text-layer.ts` across Reading Mode and Highlighter Mode.

**Preconditions**:
- Phase 3 Exit Gate is 100% satisfied (`pnpm verify` and live `cargo tauri dev` highlight creation/persistence pass).
- Read `.agents/skills/frontend-design/SKILL.md` before authoring `HighlightPopover.svelte` and its CSS.

---

## 2. Scope Boundaries

### In Scope
- Mandatory two-pass `frontend-design` plan + self-critique for `HighlightPopover.svelte`.
- `src/components/icons/CopyIcon.svelte` (**NEW**) and `src/components/icons/TrashIcon.svelte` (**NEW**).
- `src/components/HighlightPopover.svelte` (**NEW**): compact floating action bar for inspecting, recoloring, copying quote, and deleting an existing highlight.
- `src/App.svelte` & `src/components/ViewportHost.svelte`: mount `HighlightPopover` inside `ViewportHost` (alongside `SearchBar`), sync `highlightLayer.setSelectedHighlightId(store.activeHighlightPopover?.highlightId ?? null)`, and dismiss popover on viewport resize/zoom.
- `src/lib/engines/shortcuts.ts`: add `Delete`/`Backspace` shortcut (strictly when popover open and `!inEditable`) and insert Step 2 (`activeHighlightPopover` dismissal) into the `Esc` precedence ladder.
- Unit tests for popover positioning/clamping helper and shortcut rules, plus live `cargo tauri dev` verification.

### Out of Scope (Do Not Touch in Phase 4)
- No notes/comment inputs, no Highlights Drawer, no Undo/Redo.
- No Rust backend edits.
- No governance doc updates (`SPEC.md`, `PHASES.md`, `AGENTS.md`, `CHANGES.md` — Phase 5).

---

## 3. Files to Create / Modify

| Action | Path | Responsibility |
| --- | --- | --- |
| **NEW** | `src/components/icons/CopyIcon.svelte` | Minimalist inline SVG copy icon (`14×14px`, `currentColor`). |
| **NEW** | `src/components/icons/TrashIcon.svelte` | Minimalist inline SVG delete/trash icon (`14×14px`, `currentColor`). |
| **NEW** | `src/components/HighlightPopover.svelte` | Compact floating toolbar `[Yellow \| Green \| Pink \| Copy \| Delete]` with viewport clamping, above/below flip, outside-click dismissal, and keyboard focus management. |
| **MODIFY** | `src/components/ViewportHost.svelte` | Sync `selectedHighlightId` to `highlightLayer`, pass viewport-host dimensions/resize dismissal cleanly. |
| **MODIFY** | `src/App.svelte` | Render `<HighlightPopover {store} {actions} onPopoverElement={...} />` inside `<ViewportHost>` alongside `<SearchBar>` and wire `isInsideHighlightPopover` if needed. |
| **MODIFY** | `src/lib/engines/shortcuts.ts` | Insert `Escape` Step 2 (close `activeHighlightPopover` before `SearchBar` and `Highlighter Mode`) and add unmodified `Delete` / `Backspace` deletion when popover is open. |
| **MODIFY** | `src/lib/domain/highlights.ts` (or pure helper) | Add pure `computePopoverPosition(anchorRect, popoverSize, containerSize)` helper so clamping and above/below flipping are unit-tested deterministically in Vitest. |
| **MODIFY** | `src/lib/domain/__tests__/highlights.test.ts` | Add Vitest assertions for `computePopoverPosition` (centered, left/right edge clamping, top-edge flip below, narrow container). |

---

## 4. Detailed Technical Tasks

### 4.1 Mandatory `frontend-design` Two-Pass Plan
Before writing `HighlightPopover.svelte`:
1. Design a quiet precision floating bar that blends natively with `SearchBar.svelte` and `Toolbar.svelte`:
   - Surface: `var(--surface-paper)` (`#FFFFFF`), `1px solid var(--border-strong)`, subtle shadow (`0 4px 12px rgba(26, 31, 43, 0.12), 0 1px 3px rgba(26, 31, 43, 0.08)`), `border-radius: var(--radius-md)`, `height: 32px`, `padding: 0 5px`, `gap: 3px`, `z-index: 15`.
   - Contents: `[Yellow] [Green] [Pink]` swatches (`22×22px` hit targets with `12×12px` filled dot + active ring), `1px` vertical hairline separator (`.popover-sep`), `Copy` `.icon-btn` (`24×24px`), `Delete` `.icon-btn` (`24×24px`, subtle `--error-ink` / `--error-bg` only on hover/focus — never screaming red at rest!).
2. Self-critique:
   - Zero decorative tail arrows that misalign when clamped near viewport edges.
   - Zero entrance bounce/scale animations (fast `90ms` opacity/color transition honoring `prefers-reduced-motion`).
   - Delete button stays visually calm (`var(--ink-muted)`) at rest and shifts to `var(--error-ink)` + `var(--error-bg)` only on `:hover` / `:focus-visible`.

### 4.2 Popover Positioning & Lifecycle (`HighlightPopover.svelte`)
1. Implement pure `computePopoverPosition({ anchorRect, popoverWidth, popoverHeight, containerWidth, containerHeight, margin = 8, gap = 8 })`:
   - Default vertical placement: **above** the clicked highlight rect (`top = anchorRect.top - popoverHeight - gap`).
   - Flip **below** (`top = anchorRect.top + anchorRect.height + gap`) if `top < margin` and below fits better (clamped within `[margin, max(margin, containerHeight - popoverHeight - margin)]`).
   - Horizontal placement: centered over `anchorRect.left + anchorRect.width / 2 - popoverWidth / 2`, clamped within `[margin, max(margin, containerWidth - popoverWidth - margin)]`.
2. Resolve the live `HighlightRecord` from `store.activeDoc.highlights.items` by `popover.highlightId`; if the highlight no longer exists or `store.activeDoc.documentId !== popover.documentId`, auto-dismiss cleanly.
3. **Dismissal triggers**:
   - Window `pointerdown` outside `popoverEl` (note: clicking another highlight lets `highlight-layer.ts` switch directly to that highlight cleanly without reopening flicker — handle outside dismissal cleanly on capture/bubble or let viewport clicks manage target switching!).
   - Viewport `scroll`, zoom change, window `resize`, tab switch, Home switch, or `Esc`.
4. **Actions inside popover**:
   - Clicking a color swatch calls `void actions.recolorHighlight(docId, highlight.id, color)` (keeps popover open so user sees the color change immediately and can compare, or closes cleanly — keeping it open with updated active ring lets users try all 3 colors effortlessly!).
   - Clicking `Copy` calls `void actions.copyHighlightQuote(docId, highlight.id)` and closes the popover.
   - Clicking `Delete` calls `void actions.deleteHighlight(docId, highlight.id)` (which closes the popover and returns focus cleanly to `#viewport`).

### 4.3 Selected Highlight Emphasis & Link Precedence Polish
1. In `ViewportHost.svelte`, add a reactive `$effect` calling `highlightLayer.setSelectedHighlightId(store.activeHighlightPopover?.highlightId ?? null)` so **all** segments (including cross-page segments!) of the inspected highlight show `.pdf-highlight-group--selected` while the popover is open.
2. Verify zoom/relayout inside `viewport.ts` (or `ViewportHost.svelte`) dismisses any open popover so no floating bar ever drifts away from its highlight after zoom or window resize.
3. Verify `link-layer.ts` + `highlight-layer.ts` click precedence end-to-end:
   - Hovering a PDF `/Link` that sits inside a highlighted passage shows the link tooltip & cobalt underline (`viewport--link-hover`) instead of highlight hover.
   - Clicking that link navigates to the link target (internal jump or external URI) without opening `HighlightPopover`.
   - Clicking non-link text in the same highlight opens `HighlightPopover`.
   - Drag-selecting across a highlight in Reading Mode selects text for `Ctrl+C` without opening `HighlightPopover`.

### 4.4 Shortcuts Completion (`src/lib/engines/shortcuts.ts`)
1. Update `Escape` ladder so **Step 2** checks `if (store.activeHighlightPopover)`:
   - `event.preventDefault(); actions.closeHighlightPopover(); actions.requestFocus("viewport"); return;`
   - Runs **before** closing `SearchBar` (Step 3) and **before** exiting `Highlighter Mode` (Step 4).
2. Add unmodified `Delete` / `Backspace` handling when `!primaryMod && !event.altKey && !event.shiftKey && !inEditable && store.activeHighlightPopover`:
   - `event.preventDefault();`
   - `void actions.deleteHighlight(popover.documentId, popover.highlightId);`
   - `actions.requestFocus("viewport");`

---

## 5. Verification Plan

### Automated Verification
```powershell
pnpm verify
```
Unit tests must verify:
- `computePopoverPosition` centering, left/right viewport edge clamping, top-edge flip below, and tight-viewport fallback.
- `Esc` closes `HighlightPopover` before `SearchBar` and before exiting `Highlighter Mode`.
- `Delete`/`Backspace` deletes the selected highlight only when popover is open and focus is not inside an `<input>`.

### Live Manual Verification (`cargo tauri dev` with local `tests/fixtures/*.pdf`)
1. **Any-Mode Inspect**: With Highlighter Mode OFF (Reading Mode), click an existing highlight → popover opens cleanly anchored above it; all segments of a cross-page highlight show subtle selected emphasis.
2. **Recolor**: Click Yellow / Green / Pink in the popover → color updates instantly across all segments and persists across tab close + reopen.
3. **Copy Cross-Page Quote**: Click Copy on a cross-page highlight (even after scrolling one of its pages out of the eviction window and back) → clipboard contains the complete formatted passage text cleanly.
4. **Delete & Empty-File Cleanup**: Click Delete (and test `Delete`/`Backspace` keyboard shortcut) → highlight vanishes immediately; after deleting the last highlight on a document, confirm `<app_data_dir>/highlights/<fingerprint>.json` is removed from disk.
5. **Edge Positioning & Dismissal**: Click highlights near the very top, left, right, and bottom edges of `#viewport` → popover clamps/flips cleanly without clipping; scrolling, zooming (`Ctrl+Wheel`), switching tabs, clicking empty margin, or pressing `Esc` dismisses popover immediately.
6. **PDF Link Precedence**: Highlight text overlapping a clickable PDF `/Link`, then hover and click the link → link activates cleanly without opening the highlight popover; click adjacent highlighted non-link text → popover opens cleanly.
7. **Reading Drag-Select**: Start a text drag-selection inside an existing highlight while in Reading Mode → native selection + `Ctrl+C` work cleanly without opening the popover.

---

## 6. Exit Gate Checklist

- [ ] Mandatory two-pass `frontend-design` plan & self-critique completed for `HighlightPopover.svelte`.
- [ ] `HighlightPopover.svelte` clamps and flips cleanly near all 4 viewport edges and dismisses deterministically on outside click, scroll, zoom, resize, tab switch, and `Esc`.
- [ ] Recolor, Copy (including cross-page quotes), and Delete (mouse + `Delete`/`Backspace`) persist cleanly and sync across duplicate-fingerprint tabs.
- [ ] PDF `/Link` hover/click precedence and Reading Mode drag-selection remain 100% unobstructed.
- [ ] `pnpm verify` passes with zero warnings or errors.
- [ ] Live `cargo tauri dev` verification passes all 7 manual scenarios against `tests/fixtures/*.pdf`.
