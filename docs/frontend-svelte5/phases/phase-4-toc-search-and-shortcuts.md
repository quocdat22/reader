# Phase 4: TOC Outline Drawer, Search Bar & Full Keyboard Parity

> **Read First**: [README.md](../README.md) · [ARCHITECTURE.md §3–§5](../ARCHITECTURE.md#3-svelte-5-runes-state--synchronization-architecture-srclibstate) · [PHASES.md](../PHASES.md) · `.agents/skills/frontend-design/SKILL.md`

---

## 1. Goal & Preconditions

**Goal**: Achieve 100% feature parity with v1 + `CR-001`..`CR-006` by implementing `TocDrawer.svelte` + `TocTree.svelte`, `SearchBar.svelte`, search highlight overlay synchronization in `ViewportHost.svelte`, and auditing the complete keyboard shortcut & focus-restoration matrix.

**Preconditions**:
- Phase 3 Exit Gate is 100% satisfied (`App.svelte`, `TabStrip`, `HomeScreen`, `Toolbar`, and `ViewportHost` live and verified in `cargo tauri dev`).

---

## 2. Scope Boundaries

### In Scope
- `src/components/TocDrawer.svelte` and `src/components/TocTree.svelte`.
- `src/components/SearchBar.svelte`.
- Wiring `ViewportHost.svelte` reactive search highlight effects (`highlightVersion`, `scrollToMatchSeq`) and passing `isInsideToc` / `isInsideSearch` DOM predicates into `shortcuts.ts` inside `App.svelte`.
- Registering `captureTocScroll` transition hook for per-tab TOC scroll restoration.
- Expanding Vitest tests for any TOC/Search state interactions uncovered during UI wiring.

### Out of Scope (Deferred to Phase 5)
- Deleting legacy vanilla `src/*.js` and `src/styles.css` (Phase 5).
- Updating `AGENTS.md`, `docs/SPEC.md`, `docs/PHASES.md`, and `CR-007` status (Phase 5).
- Release bundle build verification (Phase 5).

---

## 3. Files to Create / Modify

| Action | Path | Purpose |
| --- | --- | --- |
| **CREATE** | `src/components/TocDrawer.svelte` | Collapsible 252px outline drawer: lazy `ensureOutlineLoaded`, delayed `"Loading outline…"` state (120ms), error + Retry, empty state (`"No outline in this document"`), active chapter tracking, scroll capture/restore, and WAI-ARIA tree keyboard navigation. |
| **CREATE** | `src/components/TocTree.svelte` | Recursive outline `<ul>` (`role="tree"` / `role="group"`) rendering child subtrees lazily only when `expandedIds.has(node.id)`. |
| **CREATE** | `src/components/SearchBar.svelte` | Floating top-right `Ctrl+F` search bar: debounced query binding, delayed `"Searching…"` label (120ms), `current / total` & `0 / 0` counter, error display, `<`/`>`/`×` buttons, `Enter`/`Shift+Enter` match cycling. |
| **MODIFY** | `src/components/ViewportHost.svelte` | Add `$effect` triggers for `activeDoc.search.highlightVersion` → `viewport.syncSearchHighlights(...)` and `activeDoc.search.scrollToMatchSeq` → `viewport.scrollToNormalizedRect(...)`; host `<SearchBar />`. |
| **MODIFY** | `src/App.svelte` | Mount `<TocDrawer />` inside `#reader-shell`, register `captureTocScroll` hook, and wire accurate `isInsideToc` / `isInsideSearch` predicates into `shortcuts.ts`. |

---

## 4. Detailed Technical Tasks

### 4.1 Collapsible TOC Outline Drawer (`TocDrawer.svelte` & `TocTree.svelte`)
Reproduce every behavior and accessibility guarantee from legacy `src/toc.js` declaratively:
1. **Lazy fetch & `DocumentScope` cancellation**:
   - When `activeDoc?.outline.open` becomes `true` and `outline.status === "idle"`, trigger `actions.ensureOutlineLoaded(activeDoc.documentId)`.
   - Show `"Loading outline…"` only if `outline.status === "loading"` persists past `120ms` (`LOADING_DELAY_MS`) to prevent flicker on fast outlines.
   - On error, render `"Could not load outline."` with an active `Retry` button calling `actions.ensureOutlineLoaded(activeDoc.documentId, { retry: true })`.
   - On empty outline, render `"No outline in this document"`.
2. **Lazy recursive rendering & active chapter sync**:
   - `TocTree.svelte` renders child `<TocTree>` blocks **only when `expandedIds.has(node.id)`** (preserving lazy DOM creation for huge books with thousands of bookmarks).
   - Compute `activeNodeId` and `visibleActiveNodeId` via `$derived` using `resolveActiveOutlineNodeId` and `resolveVisibleActiveNodeId` from `src/lib/domain/outline.ts` — automatically highlighting the deepest visible collapsed ancestor without forcibly expanding sections the reader closed.
   - Scroll the active TOC row into view (`scrollIntoView({ block: "nearest" })`) only when the drawer is visible and keyboard focus is not currently inside the drawer.
3. **WAI-ARIA Tree Keyboard Navigation & Roving `tabindex`**:
   - Maintain a single `rovingNodeId` per open drawer; when a subtree collapses, if `rovingNodeId` was inside the collapsed branch, immediately move roving focus to the collapsed parent node so keyboard focus is never trapped.
   - Implement `ArrowDown`, `ArrowUp`, `ArrowRight` (expand if collapsed, else focus first child), `ArrowLeft` (collapse if expanded, else focus parent), `Home`, `End`, `Enter`/`Space` (jump to page keeping keyboard focus in tree, or toggle expand on heading-only nodes).
   - Mouse clicks jump to page and return focus to `#viewport`.
4. **Per-tab scroll preservation**:
   - Register `captureTocScroll(doc)` hook saving `bodyEl.scrollTop` into `doc.outline.scrollTop` before switching tabs or closing the drawer; restore `bodyEl.scrollTop` via `tick()` / `$effect` when returning to that tab.
   - Closing TOC while keyboard focus is inside the drawer returns focus cleanly to `#viewport`.

### 4.2 Per-Tab Search Bar (`SearchBar.svelte`) & Viewport Highlights
Reproduce every behavior and isolation guarantee from legacy `src/search.js`:
1. **Visibility & focus**:
   - Rendered inside `.viewport-host` when `store.activeDoc?.search.open` is `true`.
   - Reacts to `store.focusRequest?.target === "search_input"` by focusing and selecting `#search-input`.
2. **Input, Debounce & Delayed Status**:
   - Binds `#search-input` value to `activeDoc.search.query`; `oninput` calls `actions.setSearchQuery(value)`.
   - Handles `keydown` `Enter` / `Shift+Enter` (guarding `event.isComposing`) calling `actions.stepSearchMatch(shift ? -1 : 1)`.
   - Displays match counter: `""` when query blank, `"Searching…"` only after `120ms` delay while searching, `"Search failed"` (`.search-count--error`) on error, `"${currentIndex + 1} / ${matches.length}"` when matches exist, and `"0 / 0"` (`aria-label="No matches"`) when zero matches exist.
   - Disables Prev/Next buttons when `matches.length === 0`.
3. **Highlight & Scroll Synchronization (`ViewportHost.svelte`)**:
   - Dedicated `$effect` watching `store.activeDoc?.search.highlightVersion` (plus `activeDoc?.documentId`) invokes `viewport.syncSearchHighlights(...)` — guaranteeing zero highlight leakage when switching tabs, closing search, or clearing the query.
   - Dedicated `$effect` watching `store.activeDoc?.search.scrollToMatchSeq` invokes `viewport.scrollToNormalizedRect(activeMatch.page_index, activeMatch.rects[0])` smoothly (respecting `prefers-reduced-motion`).
   - Verify that zooming with active highlights preserves exact highlight alignment via normalized `%` CSS coordinates without re-querying Rust.

### 4.3 Full Keyboard Shortcuts & Focus Restoration Audit
Wire `isInsideToc` and `isInsideSearch` into `shortcuts.ts` inside `App.svelte` and audit every interaction edge case:
- `Ctrl+B` toggles TOC; `Ctrl+F` opens/focuses document search (or Home recent search on Home per CR-006); `Esc` inside search bar closes search and restores focus to `#viewport`; `Esc` inside `#page-input` cancels draft and restores focus to `#viewport`; `Esc` inside TOC blurs and focuses `#viewport`.
- `Enter` / `Shift+Enter` outside editable inputs and outside TOC/buttons cycles search matches when search is open.
- `PageUp` / `PageDown` / `Home` / `End` scroll `#viewport` only when focus is not inside an editable input or TOC drawer.
- All document-only shortcuts remain inert on `Home` (while `Ctrl+F` and `Ctrl+Wheel` still call `preventDefault()` to suppress WebView2 browser defaults).

---

## 5. Verification Plan

### Automated Commands
```powershell
pnpm verify
```

### Live Manual Verification (`cargo tauri dev` with `tests/fixtures/*.pdf`)
1. **TOC Drawer**:
   - Toggle via toolbar button and `Ctrl+B`; verify per-tab open/closed state, expanded nodes, and TOC scroll position survive tab switches.
   - Scroll document and verify active chapter highlight tracks current page and falls back to collapsed ancestor cleanly.
   - Navigate TOC entirely via keyboard (`ArrowUp`/`Down`/`Left`/`Right`/`Home`/`End`/`Enter`); close via button/`Ctrl+B` and confirm focus returns to viewport.
   - Open a PDF with no outline (if available) and confirm `"No outline in this document"` displays cleanly.
2. **In-Document Search**:
   - Press `Ctrl+F`, search a known term, verify `current / total`, active highlight vs passive highlights, `Enter`/`Shift+Enter` and `<`/`>` wrap-around navigation.
   - Zoom in/out (`Ctrl++`/`Ctrl+-`/`fit_page`/`fit_width`) and confirm highlights stay pixel-aligned without re-querying.
   - Switch between two open PDFs with different search queries (and to `Home`) and confirm search text, match counts, and highlights stay strictly isolated per tab.
   - Press `Esc` or `×` and confirm highlights clear immediately and focus returns to viewport.
3. **Keyboard-Only Audit**: Run through the full SPEC §5 + CR-001 + CR-003 + CR-006 shortcut table without touching the mouse.

---

## 6. Exit Gate Checklist

- [ ] `TocDrawer.svelte`, `TocTree.svelte`, and `SearchBar.svelte` are complete with scoped `<style>` matching the exact existing visual grammar.
- [ ] Closing a tab while `getOutline` or `searchDocument` is in flight cancels cleanly via `DocumentScope` with zero console errors or stale state updates.
- [ ] Search highlights and active-match scrolling stay strictly scoped to the active document tab and scale accurately across zoom changes.
- [ ] Full keyboard & focus-restoration audit passes across Home, 0-tab start, TOC drawer, Search bar, Toolbar page input, and Tab strip.
- [ ] `pnpm verify` passes with zero errors or warnings.
- [ ] Live `cargo tauri dev` verification passes against `tests/fixtures/*.pdf`.
