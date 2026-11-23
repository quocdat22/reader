# Reader — Technical & Design Specification

Concise architectural, interface, and visual specification for `reader` (`com.rookie.reader`), a minimalist Tauri v2 document reader targeting **PDF in v1** with a clean Rust boundary for future document formats.

> [!NOTE]
> This document is the frozen v1 baseline. Post-v1 amendments are tracked in [docs/CHANGES.md](CHANGES.md) without altering baseline prose below.

---

## 1. Product Scope

### v1 Goals
- **Open documents**: Native file dialog (`Ctrl+O`), window drag-and-drop, CLI / OS "Open With" argument, and recent files list.
- **Reading viewport**: Continuous vertical scroll with virtualized lazy page rendering and crisp HiDPI (`devicePixelRatio`) canvas output.
- **Zoom & navigation**: Fit-width, fit-page, discrete zoom steps (`+` / `-` / `Ctrl+Wheel` / `Ctrl+0`), and direct page jump.
- **Table of Contents**: Toggleable left outline drawer displaying collapsible document bookmarks/chapters.
- **In-document search**: `Ctrl+F` search bar with match counter (`current / total`), prev/next navigation, and page-level highlight boxes.
- **Text selection & copy**: Lightweight transparent HTML text overlay aligned from MuPDF geometry so native selection and `Ctrl+C` copy work cleanly.
- **Session continuity**: Remember last page and zoom setting per file; show a concise recent files list on the empty state.
- **Minimal multi-tab window**: Open multiple documents as tabs inside a single window; opening an already-open file focuses its existing tab; closing the last tab returns to the empty state.

> [!NOTE]
> **Amended by [CR-001](changes/001-tab-add-home-screen.md#3-tab-model-and-lifecycle)**: Clicking `+` (`tab-add-btn`) now opens a singleton `Home` tab showing the Home screen instead of launching the OS file dialog directly.

### v1 Non-Goals (Out of Scope)
- Split views or multi-window session sync.
- Dark/Sepia reading modes or PDF page color inversion.
- Clickable internal/external PDF links.
- Bookmarks, highlights, annotations, notes, form filling, editing, or printing.
- Node/npm toolchains, bundlers, or frontend frameworks.
- Multi-format implementations beyond PDF (only the Rust trait boundary is built in v1).

---

## 2. System Architecture

```text
+-------------------------------------------------------------------+
| Frontend: Vanilla HTML / CSS / ES Modules (src/)                  |
|  - Slim Tab Strip + Slim Top Bar, Empty State, TOC, Search Bar    |
|  - Virtualized Canvas Viewport (active tab) + Text/Highlight Layer|
|  - Talks to Rust via window.__TAURI__.core.invoke + events        |
+----------------------------+--------------------------------------+
                             | Tauri IPC (JSON DTOs + Binary RGBA)
+----------------------------v--------------------------------------+
| Backend: Tauri v2 / Rust 2024 (src-tauri/src/)                    |
|  - commands.rs   Thin async #[tauri::command] handlers            |
|  - state.rs      AppState + atomic JSON persistence               |
|  - worker.rs     Single dedicated thread owning open tab backends |
|  - backend/      DocumentBackend trait + PdfBackend (mupdf)       |
+-------------------------------------------------------------------+
```

### Target Platforms & MuPDF Engine
- **Primary target**: Windows x64 (`x86_64-pc-windows-msvc`) for development, testing, and bundling. Keep path handling and shortcuts cross-platform-clean (`Ctrl` / `Cmd` awareness, `std::path::PathBuf`).
- **Engine & license**: Statically linked `mupdf` (`0.8`, `AGPL-3.0`) compiled from source via `mupdf-sys` with `default-features = false` and `features = ["base14-fonts", "system-fonts", "bundled-fonts-noto"]` (strict PDF-only format scope, URW Base-14 standard fonts, native OS font fallback via DirectWrite/`font-kit`, and bundled non-CJK Noto Unicode fallback fonts).
- **Build prerequisites (Windows x64)**: Visual Studio C++ Build Tools (`MSBuild`) and LLVM (`libclang` for `bindgen`, auto-discovered on `PATH` or via `LIBCLANG_PATH`).
- **Bundling**: Single self-contained executable — zero external PDF DLLs to fetch, discover, or bundle at runtime.

---

## 3. Rust Backend Design

Apply `rust-best-practices` throughout `src-tauri/src/`.

### Module Layout
```text
src-tauri/src/
  main.rs          Thin binary entrypoint calling reader_lib::run()
  lib.rs           Tauri builder, plugin/state/worker wiring, CLI arg capture
  error.rs         ReaderError (thiserror) + serializable IPC ErrorResponse
  commands.rs      Thin Tauri commands delegating to worker & state
  state.rs         AppState, PersistedState (recents + reading positions), atomic save
  worker.rs        Dedicated MuPDF worker thread, request enum, render cancellation
  backend/
    mod.rs         DocumentBackend trait + core DTOs (NormalizedRect, OutlineItem, ...)
    pdf.rs         PdfBackend (statically linked MuPDF)
```

### Lightweight `DocumentBackend` Trait Boundary
Keep the trait focused on fixed-page reading operations needed in v1 without speculative abstractions:

```rust
pub trait DocumentBackend {
    fn metadata(&self) -> &DocumentMetadata;
    fn page_count(&self) -> usize;
    fn page_dimensions(&self) -> &[PageDimensions];
    fn render_page(&mut self, page_index: usize, width_px: u32, height_px: u32) -> Result<RenderedPage, ReaderError>;
    fn outline(&self) -> Result<Vec<OutlineItem>, ReaderError>;
    fn page_text(&self, page_index: usize) -> Result<Vec<TextSpan>, ReaderError>;
    fn search(&self, query: &str) -> Result<Vec<SearchMatch>, ReaderError>;
}
```

- `PdfBackend` is the sole v1 implementation.
- Opening a file dispatches by extension/magic header through a small factory function (`backend::open(path) -> Result<Box<dyn DocumentBackend>, ReaderError>`).

### Concurrency & Render Cancellation (`worker.rs`)
- All document operations execute on a single dedicated worker OS thread (`std::thread::Builder::new().name("doc-worker".into())`) that owns the thread-local MuPDF context and every open `Document` handle cleanly without cross-thread FFI lock contention.
- The worker owns a `HashMap<u64, OpenDocument>` mapping monotonic `document_id: u64` to its `Box<dyn DocumentBackend>` and canonical path, so multiple open tabs coexist safely on the single worker thread.
- Opening a file whose canonical path is already loaded returns the existing `document_id` (`already_open: true`) so the frontend focuses that tab without opening a duplicate handle.
- Closing a tab removes its entry from the map and immediately drops its MuPDF document handle.
- Commands send typed `WorkerRequest` messages over a channel with a `tokio::sync::oneshot::Sender` reply channel so Tauri `async fn` commands never block the runtime.
- Maintain a monotonic `render_epoch: AtomicU64`:
  - When the user switches tabs, closes a tab, or rapidly scrolls/zooms, bump the epoch and discard queued stale render requests for older epochs or closed documents.
  - Return a typed `ReaderError::Cancelled` so the frontend ignores superseded renders cleanly.

### Normalized Coordinate System
- MuPDF uses top-left origin in page points (`page.bounds()`).
- `PdfBackend` renders pages onto opaque-white `RGBA8` pixmaps at maximum 8-bit anti-aliasing (`aa_level = 8`) with exact target pixel transforms, and converts **all** text runs (line/contiguous-run level, splitting on wide column/table gutters) and search highlight quads into **top-left normalized `[0.0, 1.0]` coordinates**:
  ```rust
  #[derive(Debug, Clone, Copy, Serialize)]
  pub struct NormalizedRect {
      pub x: f32,
      pub y: f32,
      pub width: f32,
      pub height: f32,
  }
  ```
- Frontend maps `NormalizedRect` to CSS pixels by multiplying by rendered page CSS `width` and `height`. Zooming never requires re-fetching text or search geometry from Rust.

### Error Handling (`error.rs`)
- Define `ReaderError` with `thiserror`: `Io`, `UnsupportedFormat`, `PasswordProtected`, `InvalidDocument`, `PageOutOfRange`, `DocumentNotFound`, `Cancelled`, `Internal`.
- Implement `serde::Serialize` for `ReaderError` (or convert to `{ code, message }`) so frontend can show clear, actionable errors without parsing raw strings.

---

## 4. IPC Contract

All commands are invoked via `window.__TAURI__.core.invoke`.

| Command | Input | Output | Notes |
| --- | --- | --- | --- |
| `get_initial_file` | — | `Option<String>` | Consumes startup CLI / "Open With" path once. |
| `get_persisted_state` | — | `PersistedState` | Returns recent files and saved reading positions. |
| `open_document` | `{ path: String }` | `OpenDocumentResponse` | Returns `document_id`, `canonical_path`, `metadata`, `page_dimensions`, `saved_position`, `already_open`. Updates recents. |
| `close_document` | `{ document_id: u64 }` | `()` | Drops that tab's document in the worker; frees its MuPDF handles. |
| `render_page` | `{ document_id: u64, page_index: usize, width_px: u32, height_px: u32, epoch: u64 }` | `tauri::ipc::Response` (binary) | Raw payload: `[width: u32 LE][height: u32 LE][RGBA8 pixels]`. Zero JSON/base64/PNG overhead. |
| `get_outline` | `{ document_id: u64 }` | `Vec<OutlineItem>` | Nested tree `{ title, page_index: Option<usize>, children }`. |
| `get_page_text` | `{ document_id: u64, page_index: usize }` | `Vec<TextSpan>` | `{ text: String, rect: NormalizedRect }` for text selection overlay. |
| `search_document` | `{ document_id: u64, query: String }` | `Vec<SearchMatch>` | `{ page_index: usize, rects: Vec<NormalizedRect> }` (case-insensitive substring). |
| `save_reading_state` | `{ path: String, page_index: usize, zoom_mode: ZoomMode, zoom_scale: f32 }` | `()` | Debounced from frontend; atomically persisted. |
| `remove_recent_file` | `{ path: String }` | `PersistedState` | Removes entry from recent files list. |

### Binary `render_page` Wire Format
- Bytes `0..4`: `width_px` as unsigned 32-bit little-endian (`u32::to_le_bytes`).
- Bytes `4..8`: `height_px` as unsigned 32-bit little-endian.
- Bytes `8..`: tightly packed `RGBA8` (`width_px * height_px * 4` bytes).
- Frontend decodes via `DataView` + `new ImageData(new Uint8ClampedArray(buf, 8), width, height)` and paints directly with `ctx.putImageData(imageData, 0, 0)`.
- Clamp render dimensions on the Rust side (e.g., max `4096` px per side) to guard against OOM on extreme zoom/DPR combinations.

### Persistence Schema (`state.json`)
Stored at `<app_data_dir>/state.json` using atomic write (write to `state.json.tmp`, flush, rename):

```json
{
  "version": 1,
  "recent_files": [
    { "path": "...", "title": "...", "last_opened_unix": 1730000000, "last_page": 12, "page_count": 560 }
  ],
  "positions": {
    "<canonical_path>": { "page_index": 12, "zoom_mode": "fit_width", "zoom_scale": 1.0 }
  }
}
```
- Cap `recent_files` at `10` entries (most recently opened first, deduplicated by canonical path).
- If `state.json` is missing or malformed, log a warning and start with an empty default state without crashing.

---

## 5. Frontend Design & UX Brief

Apply `.agents/skills/frontend-design/SKILL.md` (two-pass design plan + self-critique) before writing CSS/HTML in Phase 3.

### Aesthetic Direction
- **Subject grounding**: A quiet, precision desktop reading room where the **document page is the sole hero** and interface chrome recedes into disciplined, tactile utility.
- **Chrome geometry**:
  - **Slim tab strip** (`~30–32px`, visible only when at least one document is open): quiet horizontal tabs with truncated title, active tab highlight, per-tab close button (`×`, plus middle-click to close), smooth horizontal overflow scrolling, and a subtle `+` button to open another PDF.
  - **Slim persistent document toolbar** (`~36–38px`, single horizontal row beneath the tab strip when a document is active): mouse-discoverable controls without repeating the document title already shown in the active tab; zero bottom status bar, zero decorative gradients or SaaS card stacks.
- **Anti-template guardrails**: Avoid cliché warm-cream + terracotta palettes, near-black + neon accents, all-caps tracked eyebrows, decorative `01/02` numbering, and scattered entrance animations.
- **Restraint**: Neutral quiet canvas framing crisp white PDF pages; spend visual accent deliberately in one place (active tab/focus/selection/current search match).
- **Copywriting**: Plain active verbs in sentence case ("Open PDF", "No outline in this document", "File not found — remove from recent?"). Errors state what happened and how to recover without apologizing.

> [!NOTE]
> **Amended by [CR-001](changes/001-tab-add-home-screen.md#4-ui-shell-and-visual-behavior)**: In **Chrome geometry** above, `+` (`tab-add-btn`) now opens or focuses the singleton `Home` tab; while `Home` is active, the tab strip remains visible and the document toolbar hides.
>
> **Amended by [CR-002](changes/002-integrated-titlebar-window-controls.md#3-window-chrome--layout)**: Native OS window decorations are disabled (`decorations: false`); `#tab-strip` serves as the integrated borderless titlebar (with draggable region and window caption controls) in both `>= 1`-tab and `0`-tab states.

### Core Layout Wireframe

```text
+-------------------------------------------------------------------+
| [ Document A   x ] [ Document B   x ] [ + ]                       |  <- 30-32px slim tab strip
+-------------------------------------------------------------------+
| [TOC]                  [ 12 / 560 ]  [- 100% +] [Fit] [Q] [Open]  |  <- 36-38px slim toolbar
+------------------+------------------------------------------------+
| Outline (drawer) |                                                |
|  > Chapter 1     |              +------------------+              |
|    1.1 Overview  |              |                  |              |
|  v Chapter 2     |              |    PDF Page N    |              |
|    2.1 Details   |              |   (Canvas +      |              |
|                  |              |    Text Layer)   |              |
|                  |              +------------------+              |
+------------------+------------------------------------------------+
```

- **TOC drawer**: Collapsible left pane (~240–260px), closed by default when opening a document (per-tab outline cache, synced to active tab).
- **Search bar**: Compact floating/inline bar tucked cleanly at top-right beneath the toolbar when `Ctrl+F` is active (`[query input]  3 / 24  [<] [>] [x]`), scoped to the active tab.
- **Empty state**: Shown when 0 tabs are open (tab strip & document toolbar hidden). Centered quiet drop target with `Open PDF` primary action, hint for drag-and-drop (`Ctrl+O`), and a crisp borderless/hairline recent files list below when history exists.

> [!NOTE]
> **Amended by [CR-001](changes/001-tab-add-home-screen.md#4-ui-shell-and-visual-behavior)**: The Home screen (`#empty-state`) is also displayed inside the singleton `Home` tab beneath the visible tab strip while other document tabs remain open.
>
> **Amended by [CR-002](changes/002-integrated-titlebar-window-controls.md#3-window-chrome--layout)**: In the `0`-tab Home state, `#app-chrome` stays visible so the borderless `#tab-strip` provides a seamless top drag region and right-aligned window controls above `#empty-state`.

### Frontend Module Structure (`src/`)
```text
src/
  index.html       Minimal semantic shell
  styles.css       Design tokens + clean flat-specificity layout/component styles
  main.js          App bootstrap, multi-tab coordination, drag-drop & CLI open flow
  api.js           Typed wrapper over window.__TAURI__ invoke/dialog/webview events
  tabs.js          Slim tab strip UI + per-tab view state (page, scroll, zoom, TOC, search)
  viewport.js      Virtualized vertical scroll for active tab, overscan queue, HiDPI canvas
  text-layer.js    Lazy transparent HTML text overlay + search highlight boxes
  toolbar.js       Slim document toolbar state (page jump input, zoom, TOC & search toggles)
  toc.js           Collapsible outline tree drawer (per-tab outline)
  search.js        Ctrl+F search bar, debounced queries, match navigation (per-tab state)
  empty-state.js   Drop zone + recent files list (when no tabs are open)
  shortcuts.js     Centralized keyboard shortcut router
```

### Virtualized Viewport & Tab Memory Rules
- Keep **only the active tab** mounted in the virtualized viewport DOM; on tab switch, snapshot the outgoing tab's scroll/page/zoom/search state, release its `<canvas>` backing stores (`canvas.width = 0; canvas.height = 0`), bump the render epoch, and mount the target tab immediately from its cached `page_dimensions`.
- Pre-compute full vertical scroll geometry from `page_dimensions` immediately on open/switch (exact per-page aspect ratio + fixed gap).
- Render only visible pages plus an overscan buffer (`±2` pages around viewport).
- Cap rendered canvases in memory (evict canvases beyond `±6` pages from viewport, freeing GPU/backing store by setting `canvas.width = 0; canvas.height = 0`).
- Snap page slot dimensions and `(left, top)` offsets to the physical device pixel grid (`Math.round(css * dpr) / dpr` without half-pixel `translateX(-50%)`), request exact physical `(widthPx, heightPx)` bitmaps matching `slot.width * dpr`, and re-render automatically when `window.devicePixelRatio` changes across displays.
- On zoom change, preserve the reader's vertical scroll anchor relative to the current page, increment the render epoch, and re-render visible pages first.

### Keyboard Shortcuts
| Shortcut | Action |
| --- | --- |
| `Ctrl+O` | Open PDF in a new tab (or focus existing tab) |
| `Ctrl+W` | Close active tab (returns to empty state on last tab) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Switch to next / previous tab |
| `Ctrl+1` .. `Ctrl+9` | Jump directly to tab 1–9 (`Ctrl+9` jumps to last tab) |
| `Ctrl+F` | Open/focus search bar for active tab |
| `Enter` / `Shift+Enter` | Next / previous search match (when search active) |
| `Ctrl+G` | Focus page number input |
| `Ctrl+B` | Toggle TOC outline drawer |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | Zoom in / zoom out / reset fit-width |
| `Ctrl+Wheel` | Smooth step zoom |
| `PageDown` / `PageUp` / `Home` / `End` | Scroll/navigate active document |
| `Esc` | Close search bar or blur active toolbar input |

> [!NOTE]
> **Amended by [CR-001](changes/001-tab-add-home-screen.md#5-keyboard-shortcuts-and-focus-rules)**: `Ctrl+W`, `Ctrl+Tab`/`Ctrl+Shift+Tab`, and `Ctrl+1..9` include the singleton `Home` tab when open; document-only shortcuts remain inactive while `Home` is active.

---

## 6. Testing & Verification Strategy

### Fixture Discovery & Privacy
- Local large PDF fixtures live in `tests/fixtures/` (already in `.gitignore`).
- **Never** hardcode or reference any specific fixture filename in code, tests, docs, or git history.
- Rust integration tests use a shared helper (`src-tauri/tests/common/mod.rs`):
  1. Read `READER_TEST_PDF` environment variable if set.
  2. Otherwise scan `../tests/fixtures/` for the first `*.pdf` file (sorted deterministically).
  3. If no fixture exists, return `None` and skip fixture-dependent assertions cleanly with an explicit note.
- Always keep non-fixture unit tests (error mapping, coordinate normalization, persistence atomic writes, recents dedup/cap, epoch cancellation) unconditional so `cargo test` always exercises core logic even without a local fixture.

### Quality Gates
- **Rust**: `cargo fmt --check`, `cargo clippy --all-targets --all-features --locked -- -D warnings`, `cargo test`.
- **UI**: Two-pass `frontend-design` plan + self-critique, live manual verification in `cargo tauri dev` against a local `tests/fixtures/*.pdf`, responsive resize check, keyboard navigation audit.
- **Hygiene**: `git status --short` must confirm `tests/fixtures/` remains untracked/ignored.
