# CR-006: Home Recent Files Search in `.recent-header`

- **ID**: `CR-006`
- **Status**: Implemented
- **Scope**: Frontend only (`src/index.html`, `src/styles.css`, `src/empty-state.js`, `src/shortcuts.js`, `src/main.js`). Zero changes to Rust backend or Tauri IPC contract.
- **Supersedes / Amends**: [docs/SPEC.md](../SPEC.md) (§5) and [docs/PHASES.md](../PHASES.md) (Phase 3)

---

## 1. Context & Goal

With unbounded recent-file history (`CR-004`), users with many opened documents had to page through `#recent-section` manually to locate a specific title or folder path.

**Goal**: Provide an immediate, client-side search/filter input directly inside `.recent-header` on the Home screen (`0`-tab start state and singleton `Home` tab) so users can filter their recent history by title or path without leaving Home.

---

## 2. Baseline Traceability Matrix

| Baseline Document & Section | Original / Prior Behavior | Updated Behavior (This Document) |
| --- | --- | --- |
| [SPEC §5 — Core Layout Wireframe (Empty state)](../SPEC.md#core-layout-wireframe) | `.recent-header` displays `Recent`, optional range count, and pagination controls (`CR-004`). | [§3. Recent Header Search UI](#3-recent-header-search-ui) — adds `#recent-search-input` and `#recent-search-clear` inside `.recent-header`, plus `#recent-empty` when a filter yields zero matches. |
| [SPEC §5 — Keyboard Shortcuts](../SPEC.md#keyboard-shortcuts) | `Ctrl+F` opens/focuses in-document search and is inert on Home (`CR-001`). | [§4. Filtering & Keyboard Rules](#4-filtering--keyboard-rules) — `Ctrl+F` focuses `#recent-search-input` when Home displays recent files; `Esc` clears a non-empty filter before blurring. |
| [PHASES — Phase 3 Task 6](../PHASES.md#phase-3-minimalist-ui-shell-multi-tab-strip--virtualized-viewport) | `src/empty-state.js` renders and paginates `recent_files` without text filtering. | [§4. Filtering & Keyboard Rules](#4-filtering--keyboard-rules) — `src/empty-state.js` filters `recent_files` across title and path while keeping pagination and empty-state recovery coherent. |

---

## 3. Recent Header Search UI

- **Placement & visual grammar**: `.recent-controls` sits on the right side of `.recent-header`, grouping the compact `#recent-search-input` (`24px` height, `--surface-paper` surface, `--border-subtle` hairline, magnifying-glass prefix, and conditional `#recent-search-clear` button) alongside `#recent-pagination` when multi-page results exist.
- **Range & match feedback**:
  - When unfiltered with `<= 10` files, `#recent-range` and `#recent-pagination` remain hidden (`CR-004`).
  - When filtering with `1–10` matches, `#recent-range` shows `<N> match` / `<N> matches`.
  - When filtering with `> 10` matches, `#recent-range` shows `start–end of <N>` and `#recent-pagination` paginates the filtered subset.
  - When filtering yields `0` matches, `#recent-section` and `.recent-header` stay visible, `#recent-range` shows `0 matches`, and `#recent-empty` displays `"No matching recent files."`.

---

## 4. Filtering & Keyboard Rules

- **Matching**: Case-insensitive multi-token matching (`filterRecentFiles`) across both `item.title` and `item.path`; all whitespace-separated query tokens must appear in the combined title/path text.
- **Page & state lifecycle**:
  - Typing or clearing the query resets `currentPage` to `1` while keeping input focus intact.
  - Removing a recent item preserves the active filter and clamps `currentPage` cleanly within the filtered page count.
  - Successfully opening a document resets both `currentPage` and the Home search query so the newly opened document appears at the top of `Recent` on the next visit to Home.
- **Keyboard ergonomics**:
  - `Ctrl+F` on Home focuses and selects `#recent-search-input` when `#recent-section` is visible (still suppressing WebView2's built-in find bar when no recent files exist).
  - `Esc` inside `#recent-search-input` clears a non-empty query while keeping focus in the input; pressing `Esc` on an empty input blurs focus via the global `onEscape` handler.
  - `ArrowDown` inside `#recent-search-input` moves focus to the first visible `.recent-row-btn`.

---

## 5. Verification Checklist

- [ ] With recent files present, `.recent-header` displays `#recent-search-input`; filtering matches both document title and parent directory path case-insensitively.
- [ ] Filtered results update `#recent-range` (`N matches` or `1–10 of N`) and paginate cleanly at 10 items per page when >10 matches exist.
- [ ] Zero-match queries keep `.recent-header` visible, display `#recent-empty`, and reset cleanly via `#recent-search-clear` or `Esc`.
- [ ] `Ctrl+F` on Home focuses `#recent-search-input`; `ArrowDown` moves focus to the first result; opening a document resets the Home filter and page.
