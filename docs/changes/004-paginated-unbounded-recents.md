# CR-004: Unbounded Recent Files Persistence & Paginated Home Recent Section

- **ID**: `CR-004`
- **Status**: Implemented
- **Scope**: Backend persistence (`src-tauri/src/state.rs`) and Home screen recent-files UI (`src/index.html`, `src/styles.css`, `src/empty-state.js`, `src/main.js`). No breaking changes to Tauri IPC commands or `state.json` schema version (`1`).
- **Supersedes / Amends**: [docs/SPEC.md](../SPEC.md) (§4, §5) and [docs/PHASES.md](../PHASES.md) (Phase 2, Phase 3)

---

## 1. Context & Goal

In the v1 baseline, `PersistedState::recent_files` was capped at `10` entries in `src-tauri/src/state.rs`, so opening an 11th document evicted the oldest file from the Home screen's `Recent` section even though users expect a complete history of opened files.

**Goal**: Retain **all** opened documents in `recent_files` (deduplicated by canonical path, ordered most recently opened first) and paginate the `#recent-section` list on Home at **10 items per page** so the Home screen stays compact while giving users access to their full reading history.

---

## 2. Baseline Traceability Matrix

| Baseline Document & Section | Original v1 Behavior | Updated Behavior (This Document) |
| --- | --- | --- |
| [SPEC §4 — Persistence Schema (`state.json`)](../SPEC.md#persistence-schema-statejson) | Caps `recent_files` at `10` entries. | [§3. Persistence Behavior](#3-persistence-behavior) — retains all opened files in `recent_files` (deduplicated, most recent first, no count cap). |
| [SPEC §5 — Core Layout Wireframe (Empty state)](../SPEC.md#core-layout-wireframe) | Displays the full `recent_files` list (up to 10 items) without pagination. | [§4. Paginated Recent Section UI](#4-paginated-recent-section-ui) — displays 10 items per page with range indicator and compact page navigation when `> 10` files exist. |
| [PHASES — Phase 2 Tasks 1 & 4](../PHASES.md#phase-2-ipc-commands-persistence--app-lifecycle) | `PersistedState` caps `recent_files` at 10; unit tests assert the 10-entry cap. | [§3. Persistence Behavior](#3-persistence-behavior) — unit tests verify unbounded retention beyond 10 entries and deduplication on load. |
| [PHASES — Phase 3 Task 6](../PHASES.md#phase-3-minimalist-ui-shell-multi-tab-strip--virtualized-viewport) | `src/empty-state.js` renders all recent entries flatly. | [§4. Paginated Recent Section UI](#4-paginated-recent-section-ui) — `src/empty-state.js` paginates `recent_files` at 10 items per page. |

---

## 3. Persistence Behavior

- `MAX_RECENT_FILES` is removed from `src-tauri/src/state.rs`.
- `PersistedState::record_open` deduplicates by canonical path (`paths_equal`) and inserts the opened document at index `0` without truncating `recent_files`.
- `PersistedState::normalize_recents` deduplicates loaded entries without truncating `recent_files`.
- Existing `remove_recent_file` IPC continues to let users explicitly remove any entry from `recent_files`.
- `MAX_SAVED_POSITIONS` (`200`) continues to bound `PersistedState::positions` while preferring to keep positions for recent files.

---

## 4. Paginated Recent Section UI

### Visual & Layout Behavior
- **Page size**: `RECENTS_PAGE_SIZE = 10` items per page.
- **Single-page state (`<= 10` files)**: `#recent-range` and `#recent-pagination` remain hidden; `#recent-section` renders identically to v1.
- **Multi-page state (`> 10` files)**:
  - `.recent-header` shows `Recent` paired with a tabular-numeral range counter (`1–10 of 24`) on the left and compact navigation (`‹`, page numbers with ellipsis collapsing when `totalPages > 7`, `›`) on the right.
  - Controls sit in `.recent-header` rather than below the list so button positions remain stationary even when the final page has fewer than 10 items.
  - Active page button uses the quiet elevated paper treatment (`--surface-paper` + `--border-subtle`) consistent with the app's 6-token palette.

### State & Focus Rules
- **Removing an entry**: Deleting an item on the current page preserves `currentPage`, clamping cleanly to `[1, totalPages]` if the last item on the final page was removed.
- **Opening a document**: Successfully opening a document resets the Home recent-files page to `1` so the newly opened document appears at the top on the next visit to Home.
- **Keyboard focus preservation**: Selecting a page button or reaching the boundary with `Previous page` / `Next page` preserves focus cleanly instead of dropping focus to `document.body`.

---

## 5. Verification Checklist

- [ ] Unit tests in `src-tauri/src/state.rs` verify >10 opened files are retained and deduplicated across `record_open` and `load_or_default`.
- [ ] `cargo fmt --check`, `cargo clippy --all-targets --all-features --locked -- -D warnings`, and `cargo test` pass.
- [ ] With `<= 10` recent files, `#recent-range` and `#recent-pagination` stay hidden.
- [ ] With `> 10` recent files, `#recent-section` paginates at 10 items per page, updates `1–10 of N`, navigates cleanly across pages, and clamps `currentPage` when removing the last item on the final page.
