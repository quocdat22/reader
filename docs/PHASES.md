# Reader — Development Phases

Execute phases sequentially. Complete every item in a phase's **Exit Gate** before moving to the next phase. Always obey [AGENTS.md](../AGENTS.md) and [docs/SPEC.md](SPEC.md).

> [!NOTE]
> This roadmap is the frozen v1 baseline. Post-v1 upgrades and behavioral changes are tracked in [docs/CHANGES.md](CHANGES.md) without altering baseline items below.

---

## Phase 0: Foundation, Tooling & MuPDF Build Setup

- **Goal**: Establish lint hygiene, statically linked MuPDF configuration, Tauri dialog/window configuration, and generic fixture discovery.
- **Skills**: `rust-best-practices` (Chapter 2 — Clippy and Linting).
- **Tasks**:
  1. Ensure `.gitignore` keeps `tests/fixtures` ignored.
  2. Add `[lints.rust]` and `[lints.clippy]` in `src-tauri/Cargo.toml` enforcing clean warnings, `redundant_clone`, `large_enum_variant`, `needless_collect`, and missing-doc discipline on public library APIs.
  3. Add dependencies to `src-tauri/Cargo.toml`: `mupdf` (`0.8`, `AGPL-3.0`, `default-features = false`, `features = ["base14-fonts", "system-fonts", "bundled-fonts-noto"]`), `thiserror`, `tauri-plugin-dialog`, and `tokio` (only needed features, e.g., `sync`).
  4. Verify Windows x64 build prerequisites: Visual Studio C++ Build Tools (`MSBuild`) and LLVM (`libclang` for `bindgen`).
  5. Configure `src-tauri/tauri.conf.json`: reasonable default window size (`1100x800`, min `640x480`), clean title `"Reader"`, and standalone executable bundling (no external PDF DLLs).
  6. Update `src-tauri/capabilities/default.json` to grant minimal required permissions (`core:default`, `dialog:allow-open`, drag-drop support).
  7. Create `src-tauri/tests/common/mod.rs` with dynamic fixture resolver (`READER_TEST_PDF` -> first `*.pdf` in `tests/fixtures/` -> `None`). Never reference specific filenames.
- **Exit Gate**:
  - `cargo check`, `cargo fmt --check`, and `cargo clippy --all-targets --all-features --locked -- -D warnings` pass.
  - `git status --short` shows `tests/fixtures/` remains untracked/ignored.

---

## Phase 1: Rust Core — `DocumentBackend`, `PdfBackend` & Worker Thread

- **Goal**: Build the tested, thread-safe Rust PDF engine behind the `DocumentBackend` trait.
- **Skills**: `rust-best-practices` (Chapters 1, 4, 5, 6, 8, 9).
- **Tasks**:
  1. Implement `src-tauri/src/error.rs`: `ReaderError` with `thiserror` and serializable error payload (`code`, `message`). Zero `.unwrap()`/`.expect()` in production code.
  2. Implement `src-tauri/src/backend/mod.rs`: `DocumentBackend` trait, DTOs (`DocumentMetadata`, `PageDimensions`, `RenderedPage`, `OutlineItem`, `TextSpan`, `SearchMatch`, `NormalizedRect`), coordinate conversion helper (top-left page points -> top-left `[0.0, 1.0]`), and format factory `open()`.
  3. Implement `src-tauri/src/backend/pdf.rs`:
     - Statically linked `MuPDF` `PdfBackend` implementing `DocumentBackend`: page dimensions, password detection, clamped RGBA8 rasterization on opaque white (`<= 4096px` per side, 8-bit AA), recursive outline extraction, line/contiguous-run text span extraction with normalized rects, case-insensitive document search via `search_cb` returning normalized match rects.
  4. Implement `src-tauri/src/worker.rs`: dedicated `doc-worker` OS thread owning the MuPDF thread-local context and a `HashMap<u64, Box<dyn DocumentBackend>>` for open tabs (with canonical-path deduplication), async request/response channel bridge (`tokio::sync::oneshot`), monotonic `document_id`, per-document close cleanup, and `render_epoch` cancellation for stale scroll/zoom/tab-switch renders.
  5. Write tests:
     - Unit tests: coordinate normalization edge cases, dimension clamping, unsupported/missing file errors, stale-epoch render cancellation, multi-document open/dedup/close lifecycle.
     - Integration tests (`src-tauri/tests/pdf_backend.rs`) using `common::discover_pdf_fixture()`: open local `tests/fixtures/*.pdf`, verify page count > 0, valid page dimensions, page 0 renders non-empty RGBA matching `w * h * 4`, outline extraction succeeds, text extraction returns non-empty spans with normalized coords in `[0.0, 1.0]`, and search locates known text from page text.
- **Exit Gate**:
  - `cargo test` passes (all unit tests + fixture integration tests running against the local PDF in `tests/fixtures/`).
  - `cargo clippy --all-targets --all-features --locked -- -D warnings` and `cargo fmt --check` pass.

---

## Phase 2: IPC Commands, Persistence & App Lifecycle

- **Goal**: Expose the backend cleanly over Tauri IPC, add atomic reading-state persistence, and wire CLI/"Open With" startup paths.
- **Skills**: `rust-best-practices` (Chapters 1, 3, 4, 5).
- **Tasks**:
  1. Implement `src-tauri/src/state.rs`:
     - `PersistedState` (`version`, capped/deduplicated `recent_files`, per-file `positions` map).
     - Atomic JSON persistence (`state.json.tmp` -> flush -> rename) in Tauri app data dir; graceful fallback on missing/corrupt files.
     - `AppState` holding worker handle, persisted state (`Mutex`), and startup CLI file path (`Option<PathBuf>`).
  2. Implement `src-tauri/src/commands.rs` covering all commands in [docs/SPEC.md Section 4](SPEC.md#4-ipc-contract):
     - `open_document` returns `already_open` when the canonical path is already loaded in a tab.
     - `close_document` accepts `{ document_id }` and drops only that tab's backend handle.
     - `render_page` returns `tauri::ipc::Response` with raw `[width: u32 LE][height: u32 LE][RGBA8]` bytes (zero base64/JSON serialization).
     - Thin validation and clean `ReaderError` returns on all commands.
  3. Wire `src-tauri/src/lib.rs`: register `tauri-plugin-dialog`, spawn worker, parse optional PDF file path from `std::env::args_os()`, manage `AppState`, and register all commands.
  4. Write unit tests for `state.rs` (save/load round-trip, recents cap at 10, canonical-path deduplication, corrupt JSON recovery, missing file handling).
- **Exit Gate**:
  - `cargo test`, `cargo clippy --all-targets --all-features --locked -- -D warnings`, and `cargo fmt --check` pass.
  - `cargo tauri dev` launches cleanly with zero backend startup errors.

> [!NOTE]
> **Amended by [CR-004](changes/004-paginated-unbounded-recents.md#3-persistence-behavior)**: `PersistedState` no longer caps `recent_files` at 10 entries; unit tests verify unbounded retention beyond 10 entries.

---

## Phase 3: Minimalist UI Shell, Multi-Tab Strip & Virtualized Viewport

- **Goal**: Design and implement the core reading experience — slim tab strip, slim persistent toolbar, quiet empty state, and virtualized HiDPI PDF viewport.
- **Skills**: `frontend-design` (mandatory two-pass design plan + anti-template self-critique **before** writing HTML/CSS).
- **Tasks**:
  1. **Design Pass**: Produce the compact design plan (4–6 named hex tokens, typography, layout wireframe, principles) aligned with [docs/SPEC.md Section 5](SPEC.md#5-frontend-design--ux-brief), critique against `frontend-design` defaults, and finalize before coding.
  2. Build `src/index.html` and `src/styles.css` with flat, low-specificity selectors, visible focus rings, and `prefers-reduced-motion` support.
  3. Build `src/api.js` wrapping all Tauri `invoke` calls, binary `render_page` `ArrayBuffer` decoding, native file dialog (`dialog.open`), and Tauri drag-drop listener (`onDragDropEvent`).
  4. Build `src/tabs.js`: slim horizontal tab strip (hidden when 0 tabs are open), truncated document titles, active indicator, close (`×` and middle-click), overflow scroll, `+` open button, and per-tab state storage (`documentId`, `path`, `pageDimensions`, `pageIndex`, `scrollTop`, `zoomMode`, `zoomScale`, `tocOpen`). Opening an already-open file focuses its existing tab.
  5. Build `src/toolbar.js`: slim single-row persistent document toolbar (TOC toggle, editable page counter/jump, zoom `-`/`%`/`+`/fit-width/fit-page, search toggle, `Open PDF`), synced to the active tab.
  6. Build `src/empty-state.js`: quiet drag-and-drop canvas, `Open PDF` CTA, concise recent files list with remove action and clear error banner for missing/unreadable files.
  7. Build `src/viewport.js`:
     - Mount only the active tab in DOM; release outgoing tab canvases (`canvas.width = 0; canvas.height = 0`) on tab switch to keep GPU/RAM flat while restoring target tab scroll/page/zoom immediately.
     - Pre-size page placeholders from `page_dimensions`.
     - Virtualized rendering (`IntersectionObserver` + `±2` page overscan, evict canvases beyond `±6` pages).
     - 1:1 physical HiDPI (`devicePixelRatio`) rendering with device-pixel-snapped slot geometry, DPR-change listener, and `ImageData` / `putImageData` painting.
     - Render epoch bumping on tab switch/zoom/close to discard stale in-flight renders; preserve reading scroll anchor across zoom changes.
  8. Build `src/main.js`: orchestrate startup (`get_initial_file`, `get_persisted_state`), multi-tab open/switch/close transitions, drag-drop, and debounced per-file `save_reading_state`.
- **Exit Gate**:
  - Live test via `cargo tauri dev` opening local `tests/fixtures/*.pdf` (and testing multi-tab with multiple PDFs or a temporary copy):
    - Opens via dialog, drag-drop, recent list, `+` tab button, and CLI arg (`cargo tauri dev -- <path>`).
    - Re-opening an already-open file focuses its existing tab instead of duplicating.
    - Switching tabs preserves each tab's page/scroll/zoom and frees inactive canvases; closing the last tab returns cleanly to the empty state.
    - Smooth continuous scroll through a large multi-hundred-page PDF; memory stays bounded.
    - Crisp HiDPI rendering on fit-width, fit-page, and custom zoom levels; page & zoom restore on reopen.
  - Visual self-critique pass completed against `frontend-design` (zero template tells, clean spacing/hierarchy).

> [!NOTE]
> **Amended by [CR-001](changes/001-tab-add-home-screen.md#7-verification-checklist)**: In Phase 3 Task 4 and Exit Gate above, the `+` tab button (`tab-add-btn`) now opens a singleton `Home` tab showing the Home screen instead of invoking the file dialog directly; see CR-001 for the updated verification checklist.
>
> **Amended by [CR-002](changes/002-integrated-titlebar-window-controls.md#5-verification-checklist)**: The app uses a borderless window (`decorations: false`) with `#tab-strip` hosting the drag region and window caption controls across all states; see CR-002 for window chrome verification checks.
>
> **Amended by [CR-003](changes/003-tab-strip-reorder.md#5-verification-checklist)**: Tabs support horizontal pointer drag-and-drop and keyboard (`Ctrl+Shift+ArrowLeft`/`Right`) reordering; see CR-003 for verification checks.
>
> **Amended by [CR-004](changes/004-paginated-unbounded-recents.md#5-verification-checklist)**: `src/empty-state.js` paginates `recent_files` at 10 items per page when more than 10 files exist; see CR-004 for verification checks.

---

## Phase 4: TOC Outline Drawer & Keyboard Ergonomics

- **Goal**: Add effortless structural navigation via the outline drawer and desktop keyboard shortcuts (including tab switching).
- **Skills**: `frontend-design`.
- **Tasks**:
  1. Build `src/toc.js`:
     - Lazy-fetch and cache `get_outline` per tab when opened; swap cleanly when switching tabs.
     - Toggleable collapsible left drawer (~240–260px) with nested expandable items, active chapter highlight synced to the active tab's current scroll page, click-to-jump, and clean empty state when no outline exists.
  2. Build `src/shortcuts.js`:
     - Wire all shortcuts from [docs/SPEC.md Section 5](SPEC.md#keyboard-shortcuts) (`Ctrl+O`, `Ctrl+W`, `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+1..9`, `Ctrl+F`, `Ctrl+G`, `Ctrl+B`, `Ctrl++`/`-`/`0`, `Ctrl+Wheel`, `PageUp`/`PageDown`/`Home`/`End`, `Esc`).
     - Ensure shortcuts do not hijack typing when an `<input>` is focused (except `Esc` and global chords like `Ctrl+O`/`Ctrl+F`/`Ctrl+W`).
- **Exit Gate**:
  - Live verification on a local `tests/fixtures/*.pdf`: TOC renders nested chapters cleanly, updates cleanly across tab switches, jumps accurately, and all keyboard & tab shortcuts work cleanly.

---

## Phase 5: Text Selection Layer & In-Document Search

- **Goal**: Enable native text selection/copying and fast visual in-document search scoped cleanly per tab.
- **Skills**: `frontend-design`.
- **Tasks**:
  1. Build `src/text-layer.js`:
     - Lazy-fetch `get_page_text` for visible pages of the active tab (cached per open tab, cleared when tab closes or DOM evicts).
     - Render transparent positioned `<span>` text layer mapped from `NormalizedRect` onto current page CSS dimensions so mouse drag-selection and `Ctrl+C` copy align cleanly with rendered text.
     - Re-scale overlay purely in CSS/DOM coordinates on zoom without re-querying Rust.
  2. Build `src/search.js`:
     - Compact unobtrusive search bar anchored below toolbar (`Ctrl+F` opens & selects query, `Esc` closes and clears highlights).
     - Maintain search query and match state per tab so switching tabs restores or cleanly separates highlights without leaking across documents.
     - Debounced `search_document` query, match counter (`current / total`), `Enter` / `Shift+Enter` and `<` / `>` cycling, smooth scroll to active match.
     - Render normalized highlight rectangles in the page overlay layer (distinct subtle accent for the active match vs passive matches).
- **Exit Gate**:
  - Live verification on a local `tests/fixtures/*.pdf`:
    - Selecting and copying text (`Ctrl+C`) across words/lines matches rendered page content accurately.
    - Searching terms finds matches across pages, highlights exact regions even after zooming, cycles cleanly between matches, and never leaks highlights when switching tabs.

---

## Phase 6: Polish, Hardening & Release Verification

- **Goal**: Eliminate edge-case bugs, verify restraint & accessibility, and confirm standalone Windows release packaging.
- **Skills**: `rust-best-practices`, `frontend-design` (final "remove one accessory" restraint pass).
- **Tasks**:
  1. Edge-case hardening:
     - Missing/moved recent file -> actionable inline message + one-click remove from recents.
     - Corrupt, non-PDF, or password-protected PDF -> clear non-apologetic error message; existing open tabs (or empty state) remain intact.
     - Multi-tab stress tests: rapid tab switching during in-flight renders, opening the same file twice via drag-drop/dialog, closing background tabs, horizontal overflow with many tabs.
     - Stress-test rapid scroll, rapid zoom (`Ctrl+Wheel`), and window resizing on a large local `tests/fixtures/*.pdf`.
     - Verify narrow window behavior (`640x480`), keyboard-only navigation, visible focus rings, and `prefers-reduced-motion`.
  2. Audit Rust code against `rust-best-practices`: no stray `.clone()`, no `.unwrap()`/`.expect()` outside tests, clean `///` docs, strict clippy pass.
  3. Audit UI against `frontend-design`: remove any superfluous border, shadow, or chrome element that does not earn its space.
  4. Verify standalone release build: run `cargo tauri build` and launch the built executable outside the dev tree to confirm the statically linked MuPDF binary runs standalone without external PDF DLLs.
- **Exit Gate**:
  - `cargo fmt --check` passes.
  - `cargo clippy --all-targets --all-features --locked -- -D warnings` passes.
  - `cargo test` passes.
  - `cargo tauri build` succeeds on Windows x64 and opens a local `tests/fixtures/*.pdf` cleanly.
  - `git status --short` confirms zero tracked files in `tests/fixtures/`, and repo-wide search confirms no specific fixture filename appears anywhere in tracked files.
