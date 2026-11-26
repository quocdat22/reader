# CR-008: Recent Files First-Page Cover Previews

- **ID**: `CR-008`
- **Status**: Implemented
- **Scope**: Rust cover cache & worker (`src-tauri/src/covers.rs`, `src-tauri/src/worker.rs`, `src-tauri/src/state.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`) and frontend Home recent list (`src/lib/ipc/client.ts`, `src/lib/engines/recent-covers.ts`, `src/components/RecentFiles.svelte`, `src/components/HomeScreen.svelte`, `src/App.svelte`, `src/lib/state/{types,actions}.ts`). No changes to `state.json` schema (`version: 1`) or `tauri.conf.json` CSP.
- **Supersedes / Amends**: [docs/SPEC.md](../SPEC.md) (§4, §5) and [docs/PHASES.md](../PHASES.md) (Phase 3)

---

## 1. Context & Goal

On the Home screen (`0`-tab state and singleton `Home` tab), `#recent-list` displayed text-only rows (`title`, directory path, and `Page X of Y`), making visually scanning familiar documents harder.

**Goal**: Display a crisp first-page (`page_index = 0`) cover preview thumbnail on the left of every row in `#recent-list` while keeping the compact vertical hairline list layout, `state.json` schema stability, strict CSP, and responsive Home performance.

---

## 2. Baseline Traceability Matrix

| Baseline Document & Section | Original / Prior Behavior | Updated Behavior (This Document) |
| --- | --- | --- |
| [SPEC §4 — IPC Contract](../SPEC.md#4-ipc-contract) | IPC covers document lifecycle, page rendering, outline, text, search, reading state, and recent removal. | [§3. Cover Render IPC & Disk Cache](#3-cover-render-ipc--disk-cache) — adds binary `get_recent_cover` command backed by `doc-worker` and `<app_data_dir>/covers/*.cover` disk caching. |
| [SPEC §5 — Core Layout Wireframe (Empty state)](../SPEC.md#core-layout-wireframe) | `#recent-list` renders text-only rows (`title`, folder path, page progress). | [§4. Recent Row Cover UI & Loader](#4-recent-row-cover-ui--loader) — adds a `40×52px` left cover slot painting proportional page-1 `<canvas>` thumbnails. |
| [PHASES — Phase 3 Task 6](../PHASES.md#phase-3-minimalist-ui-shell-multi-tab-strip--virtualized-viewport) | Home screen displays recent entries without visual thumbnails. | [§4. Recent Row Cover UI & Loader](#4-recent-row-cover-ui--loader) — lazy-loads visible page covers with bounded concurrency (`<= 2`) and LRU memory caching. |

---

## 3. Cover Render IPC & Disk Cache

- **IPC command**: `get_recent_cover { path: String, max_side_px: Option<u32> } -> tauri::ipc::Response` returns `[width: u32 LE][height: u32 LE][RGBA8]` frames identical to `render_page`.
- **Disk cache (`src-tauri/src/covers.rs`)**:
  - Stored under `<app_data_dir>/covers/<fnv1a_128_hex>.cover` (adjacent to `state.json`), written atomically via `.tmp` + `sync_all` + `rename`.
  - Validates source file size, modification timestamp (`mtime`), and `max_side_px` (`32..=256`, default `160`) before serving cached pixels via `tauri::async_runtime::spawn_blocking`.
  - Removing a recent file via `remove_recent_file` cleans up its cached `.cover` file.
- **Worker execution (`src-tauri/src/worker.rs`)**:
  - Cache misses dispatch `WorkerRequest::RenderCover` to `doc-worker`, which reuses an already-open tab's `DocumentBackend` when available or opens the PDF transiently, rasterizes page `0` proportionally via `compute_cover_dimensions`, and immediately drops transient handles.

---

## 4. Recent Row Cover UI & Loader

- **Framework-agnostic loader (`src/lib/engines/recent-covers.ts`)**:
  - Fetches covers only for currently visible `pagedRecents` items when Home is active (`shellMode !== "document"`), capped at `2` concurrent IPC calls and `40` LRU memory entries.
  - Cancels unstarted queued requests on pagination (`CR-004`), search filtering (`CR-006`), or switching to a document tab, and invalidates entries when a document is opened or removed.
- **UI treatment (`src/components/RecentFiles.svelte`)**:
  - Each `.recent-row-btn` includes a fixed `40×52px` `.recent-cover-slot` on the left so text columns stay aligned across portrait, square, and landscape PDFs.
  - Ready covers render onto `<canvas>` using `putImageData` inside an aspect-matched white paper sheet (`--surface-paper`, `--sheet-shadow`); missing or unreadable PDFs render a quiet paper placeholder without triggering Home error banners.

---

## 5. Verification Checklist

- [ ] `cargo fmt --check`, `cargo clippy --all-targets --all-features --locked -- -D warnings`, and `cargo test` pass (including `covers`, `worker`, `state`, and `pdf_backend` cover tests).
- [ ] `pnpm verify` (`format:check`, `lint`, `typecheck`, `check`, `test`, `build`) passes.
- [ ] Every valid recent PDF renders a proportional first-page cover preview on Home; missing files show a quiet placeholder; cache hits avoid re-opening PDFs; `remove_recent_file` deletes the `.cover` cache file.
