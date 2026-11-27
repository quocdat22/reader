# Phase 1: Rust IPC Commands, Pure Geometry Domain & Svelte 5 Runes State

> **Read First**: [README.md](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md) · [PHASES.md](../PHASES.md) · `.agents/skills/rust-best-practices/SKILL.md`

---

## 1. Goal & Preconditions

**Goal**: Wire `HighlightStore` and content fingerprinting across the Tauri IPC boundary and build the complete, DOM-free TypeScript highlight foundation:
1. Rust `AppState`, `DocumentWorker`, and 4 async Tauri IPC commands (`get_highlights`, `create_highlight`, `update_highlight_color`, `delete_highlight`), plus `document_fingerprint` on `OpenDocumentResponse`.
2. Strict TypeScript IPC DTOs & `ReaderApi` bindings (`src/lib/ipc/{types,client}.ts`).
3. Pure highlight geometry normalization, same-line merging, page indexing, hit-testing, and near-duplicate overlap detection (`src/lib/domain/highlights.ts`).
4. Svelte 5 Runes state slices (`DocHighlightState`, `highlighterMode`, `activeHighlightColor`, `activeHighlightPopover`) and unidirectional `actions.ts` handlers with `DocumentScope` guards, optimistic rollback, and multi-tab same-fingerprint synchronization.

**Preconditions**:
- Phase 0 Exit Gate is 100% satisfied (`cargo fmt --check`, `cargo clippy`, `cargo test` pass).

---

## 2. Scope Boundaries

### In Scope
- Rust backend IPC wiring (`state.rs`, `worker.rs`, `commands.rs`, `lib.rs`, plus `src-tauri/tests/pdf_backend.rs` fixture fingerprint test).
- Frontend IPC layer (`src/lib/ipc/{types,client}.ts`).
- Frontend pure domain (`src/lib/domain/highlights.ts`, `src/lib/domain/format-error.ts`).
- Frontend Runes state & actions (`src/lib/state/{types,app-store.svelte,actions}.ts`).
- Exhaustive Rust unit/integration tests and Vitest unit tests.

### Out of Scope (Do Not Touch in Phase 1)
- No imperative viewport/text/highlight DOM engines yet (Phase 2).
- No Svelte UI components or CSS edits yet (`Toolbar.svelte`, `ViewportHost.svelte`, `HighlightPopover.svelte`, `tokens.css`, `viewport-layers.css` — Phases 2–4).
- No keyboard shortcut edits (`shortcuts.ts` — Phases 3–4).

---

## 3. Files to Create / Modify

| Action | Path | Responsibility |
| --- | --- | --- |
| **MODIFY** | `src-tauri/src/state.rs` | Own `highlights: Arc<HighlightStore>` inside `AppState` (initialized at `<app_data_dir>/highlights`), expose `highlight_store(&self) -> Arc<HighlightStore>`, confirm `remove_recent_file` preserves highlight files. |
| **MODIFY** | `src-tauri/src/worker.rs` | Compute & cache `document_fingerprint` inside `OpenDocument` during `handle_open()` and include it in `OpenedDocument`. |
| **MODIFY** | `src-tauri/src/commands.rs` | Add `document_fingerprint` to `OpenDocumentResponse`; add async `get_highlights`, `create_highlight`, `update_highlight_color`, and `delete_highlight` commands using `spawn_blocking`. |
| **MODIFY** | `src-tauri/src/lib.rs` | Register the 4 new commands in `tauri::generate_handler![...]`. |
| **MODIFY** | `src-tauri/tests/pdf_backend.rs` | Add fixture test asserting `compute_document_fingerprint` returns a valid 64-hex digest for `tests/fixtures/*.pdf` (skipped cleanly if no fixture present). |
| **MODIFY** | `src/lib/ipc/types.ts` | Add `"invalid_highlight"` to `ErrorCode`; add `HighlightColor`, `HighlightSegment`, `HighlightRecord`, and `document_fingerprint` on `OpenDocumentResponse`. |
| **MODIFY** | `src/lib/ipc/client.ts` | Add `CreateHighlightParams` and the 4 highlight methods on `ReaderApi` & `createTauriReaderApi()`. |
| **NEW** | `src/lib/domain/highlights.ts` | Pure rect normalization, same-line coalescing, cross-page segment sorting, `groupHighlightsByPage`, `findNearDuplicateHighlight` (2D IoU), `hitTestPageHighlights`. |
| **MODIFY** | `src/lib/domain/format-error.ts` | Add plain sentence-case `formatHighlightError(err, action)` helper. |
| **MODIFY** | `src/lib/state/types.ts` | Add `DocHighlightState`, `ActiveHighlightPopover`, `documentFingerprint` on `DocState`, and `highlighterMode`/`activeHighlightColor` on `ToolbarModel`. |
| **MODIFY** | `src/lib/state/app-store.svelte.ts` | Add `ReactiveDocHighlights`, app-level `highlighterMode`, `activeHighlightColor`, `activeHighlightPopover`, and update `toolbarModel`. |
| **MODIFY** | `src/lib/state/actions.ts` | Add highlight load, mode/color toggles, create/recolor/delete with optimistic multi-tab sync + rollback, popover open/close, and `copyHighlightQuote`. |
| **NEW** | `src/lib/domain/__tests__/highlights.test.ts` | Comprehensive Vitest suite for geometry normalization, merging, grouping, IoU overlap, and hit-testing. |
| **MODIFY** | `src/lib/state/__tests__/actions.test.ts` | Update fake `ReaderApi` fixtures for `document_fingerprint` + highlight methods and add complete state/sync/rollback tests. |

---

## 4. Detailed Technical Tasks

### 4.1 Rust Backend Wiring (`state.rs`, `worker.rs`, `commands.rs`, `lib.rs`)
1. **`src-tauri/src/state.rs`**:
   - Derive `highlights_dir` alongside `cover_cache_dir` (`state_path.parent()/highlights`) and store `highlights: Arc<HighlightStore>` on `AppState`.
   - Expose `pub fn highlight_store(&self) -> Arc<HighlightStore>`.
   - Add a unit test verifying `remove_recent_file` does **not** remove any file inside `highlights/`.
2. **`src-tauri/src/worker.rs`**:
   - Add `pub document_fingerprint: String` to `OpenedDocument` and `document_fingerprint: String` to `OpenDocument`.
   - Inside `handle_open()`: when opening a new document, compute `compute_document_fingerprint(&canonical_path)?` and store it on `OpenDocument`; when `already_open: true`, clone the cached fingerprint without re-reading disk.
   - Update worker unit tests accordingly.
3. **`src-tauri/src/commands.rs` & `lib.rs`**:
   - Add `pub document_fingerprint: String` to `OpenDocumentResponse`.
   - Implement the 4 async commands from [ARCHITECTURE.md §2.3](../ARCHITECTURE.md#23-new-tauri-ipc-commands-commandsrs-librs), each cloning `state.highlight_store()` and running the store operation inside `tauri::async_runtime::spawn_blocking(...)` so Tauri's async executor never blocks on disk I/O.
   - Register all 4 commands in `src-tauri/src/lib.rs`.

### 4.2 Frontend Typed IPC (`src/lib/ipc/{types,client}.ts`)
1. Mirror every Rust DTO and command payload in `snake_case` verbatim per [ARCHITECTURE.md §2.4](../ARCHITECTURE.md#24-frontend-typed-ipc-mirror-srclibipctypesclientts).
2. Ensure zero explicit `any`; wrap every new `invokeCommand` through `normalizeApiError()`.

### 4.3 Pure Highlight Geometry & Overlap Domain (`src/lib/domain/highlights.ts`)
1. Implement all pure functions defined in [ARCHITECTURE.md §3](../ARCHITECTURE.md#3-pure-domain-geometry--overlap-rules-srclibdomainhighlightsts):
   - `HIGHLIGHT_COLORS`, `DEFAULT_HIGHLIGHT_COLOR`, `isHighlightColor(value)`
   - `normalizeHighlightSegments(rawSegments)` (clamp `[0, 1]`, drop slivers `< 0.0005`, group by `page_index`, sort by `y` then `x`, merge adjacent same-line rects when vertical centers align within `0.35 * minHeight` and horizontal gap `<= 0.6 * minHeight`, never merging across wide column gutters).
   - `groupHighlightsByPage(highlights)` returning `Map<number, PageHighlightEntry[]>` preserving creation z-order.
   - `computeSegmentsOverlapRatio(a, b)` computing exact 2D axis-aligned rectangle union/intersection IoU across pages (handling overlapping rects within a single highlight cleanly via vertical strip/sweep-line area calculation so double-counting never skews IoU!).
   - `findNearDuplicateHighlight(existing, candidateSegments)` returning the newest matching highlight with IoU `>= 0.92`, else `null`.
   - `hitTestPageHighlights(entries, normX, normY)` reverse-scanning by z-order.

### 4.4 Runes Store & Unidirectional Actions (`src/lib/state/`)
1. **`app-store.svelte.ts`**:
   - Add `ReactiveDocHighlights` (`status`, `items`, `byPage`, `version`, `errorMessage`) using `$state.raw` for `items` and `byPage` (avoiding deep Svelte proxy overhead over large rect arrays) and `$state(0)` for `version`.
   - Add app-level `highlighterMode = $state(false)`, `activeHighlightColor = $state<HighlightColor>("yellow")`, and `activeHighlightPopover = $state.raw<ActiveHighlightPopover | null>(null)`.
   - Expose `highlighterMode` and `activeHighlightColor` on `toolbarModel`.
2. **`actions.ts`**:
   - On document open (`openPath`), call `void ensureHighlightsLoaded(doc.documentId)` asynchronously guarded by `scopes.getSignal(doc.documentId)` so opening a PDF never stalls on JSON I/O.
   - Implement a helper `syncHighlightsForFingerprint(fingerprint, updater)` that applies an atomic `items` → `byPage` + `version += 1` update to **every** open `DocState` in `store.docsById` whose `documentFingerprint === fingerprint` (handles two open tabs pointing to identical PDF copies at different paths!).
   - Implement `createHighlightFromSelection`:
     1. Normalize segments via `normalizeHighlightSegments`. If empty, return early.
     2. Check `findNearDuplicateHighlight(doc.highlights.items, segments)`:
        - Same color → return early (no-op).
        - Different color → delegate to `recolorHighlight(documentId, existing.id, store.activeHighlightColor)`.
     3. Generate `id = crypto.randomUUID()`, apply optimistic append across matching-fingerprint tabs, await `api.createHighlight(...)`, replace with authoritative server timestamps on success, or roll back + show workspace `banner` on failure (ignoring rollback noise if all matching docs were closed via `DocumentScope`).
   - Implement `recolorHighlight` and `deleteHighlight` with the same optimistic multi-tab sync + rollback pattern.
   - Implement `openHighlightPopover`, `closeHighlightPopover`, and `copyHighlightQuote` (guarding clipboard availability cleanly).
   - Clear `store.activeHighlightPopover = null` inside `deactivateCurrentDocument()`, `closeTab()`, and `openHomeTab()`.

---

## 5. Verification Plan

### Rust Tests
- `src-tauri/src/state.rs`: verify `remove_recent_file` preserves `<app_data_dir>/highlights/<fp>.json`.
- `src-tauri/src/worker.rs`: verify `open_document` returns deterministic `document_fingerprint` and reuses cached value when `already_open: true`.
- `src-tauri/src/commands.rs`: verify `OpenDocumentResponse` serializes `document_fingerprint`.
- `src-tauri/tests/pdf_backend.rs`: verify fixture PDF produces a valid 64-hex fingerprint.

### Frontend Vitest Suites
1. `src/lib/domain/__tests__/highlights.test.ts`:
   - Clamping out-of-bounds rects, dropping slivers, same-line fragment coalescing, preserving multi-column separation (gutters NOT merged), cross-page segment ordering.
   - 2D IoU overlap calculation: identical rects (`1.0`), partial overlap (`< 0.92`), slight zoom jitter (`>= 0.92`), disjoint pages (`0.0`), multi-rect union without double-counting.
   - `hitTestPageHighlights`: reverse z-order (newest wins on overlap), boundary checks, out-of-range coordinates.
2. `src/lib/state/__tests__/actions.test.ts`:
   - Auto-load highlights on document open + `DocumentScope` cancellation when closing tab mid-load.
   - Create highlight (single-page & cross-page), near-duplicate same-color no-op, near-duplicate different-color recolor.
   - Recolor & delete optimistic updates, IPC failure rollback + workspace banner error copy.
   - Multi-tab same-fingerprint sync (two tabs with distinct paths but identical `document_fingerprint` update together).
   - Popover auto-dismissal on tab switch, Home switch, and tab close.

### Automated Commands
```powershell
# Rust Gate (inside src-tauri/)
cargo fmt --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test

# Frontend Gate (repo root)
pnpm verify
```

---

## 6. Exit Gate Checklist

- [ ] `open_document` returns `document_fingerprint`, and all 4 highlight CRUD commands are registered and run via `spawn_blocking`.
- [ ] `src/lib/ipc/`, `src/lib/domain/highlights.ts`, and `src/lib/state/` compile with strict TypeScript (`zero any`), zero `svelte-check` errors, and zero ESLint/Prettier issues.
- [ ] All Rust unit/integration tests and Vitest unit tests pass with zero skipped assertions.
- [ ] `cargo fmt --check`, `cargo clippy --all-targets --all-features --locked -- -D warnings`, `cargo test`, and `pnpm verify` all pass.
- [ ] App launches cleanly via `cargo tauri dev` with zero behavioral regressions in existing reading, TOC, search, or link flows.
