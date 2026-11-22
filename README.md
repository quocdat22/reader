# Reader

A minimalist desktop PDF reader built with **Tauri v2**, **Rust (edition 2024)**, statically linked **MuPDF**, and **Vanilla HTML/CSS/JS** — with zero Node.js, npm, or frontend bundler.

Reader treats the document page as the sole focus: a slim tab strip, a single-row toolbar, a quiet empty state, and a virtualized HiDPI reading viewport backed by a dedicated single-threaded Rust PDF engine.

---

## Features

- **Multiple ways to open**: Native file picker (`Ctrl+O`, supports multi-file selection), drag-and-drop onto the window, CLI / OS "Open With" file path argument, and a recent files list.
- **Minimal multi-tab workspace**: Slim horizontal tab strip (`32px`, hidden when no document is open), middle-click and `Ctrl+W` close, wheel scrolling for overflowing tabs, and automatic deduplication — opening an already-open file focuses its existing tab.
- **Virtualized HiDPI viewport**: Continuous vertical scroll pre-sized from page dimensions; renders only visible pages plus a `±2` page overscan buffer and evicts canvases beyond `±6` pages. Inactive tabs release their `<canvas>` backing stores immediately while preserving scroll position, zoom, outline, and search state.
- **Crisp rasterization & zoom**: Device-pixel-snapped layout (up to 3x DPR) and MuPDF 8-bit anti-aliased RGBA8 rendering (clamped to `4096px` max side) with Fit width (default), Fit page, and discrete zoom steps (`25%`–`400%`) via toolbar buttons, keyboard shortcuts, or `Ctrl+Wheel`.
- **Table of contents drawer**: Collapsible outline pane (`Ctrl+B`) lazily loaded and cached per tab, supporting nested chapters, active-section scroll tracking, and WAI-ARIA tree keyboard navigation.
- **Text selection & copy**: Lazy transparent HTML text overlay mapped from MuPDF normalized `[0.0, 1.0]` coordinates (rescaled purely in CSS on zoom without re-querying Rust) with clean line/spacing formatting on `Ctrl+C`.
- **Per-tab in-document search**: `Ctrl+F` search bar with debounced case-insensitive substring matching, `current / total` match counter, `Enter` / `Shift+Enter` navigation, and page-level highlight boxes isolated per tab.
- **Session continuity**: Stores up to 10 recent files and per-file reading positions (`page_index`, `zoom_mode`, `zoom_scale`) atomically via `<app_data_dir>/state.json` (`state.json.tmp` → flush → rename).

---

## Scope & Non-Goals

Reader v1 intentionally keeps a tight scope (see [docs/SPEC.md](docs/SPEC.md) for the full specification). The following are **out of scope by design**:

- Annotations, highlights, bookmarks, notes, form filling, editing, or printing
- Dark or sepia reading modes and PDF page color inversion
- Clickable internal or external PDF hyperlinks
- Split views or multi-window session sync
- Node.js / npm toolchains, TypeScript build steps, or frontend frameworks
- Document formats beyond PDF in v1 (the `DocumentBackend` Rust trait defines the boundary for future formats)

---

## Keyboard Shortcuts

On macOS, `Cmd` also works for primary modifier chords (`Ctrl+Tab` / `Ctrl+Shift+Tab` always use `Ctrl`).

| Shortcut | Action |
| --- | --- |
| `Ctrl+O` | Open PDF in a new tab (or focus if already open) |
| `Ctrl+W` | Close active tab (returns to empty state on last tab) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Switch to next / previous tab |
| `Ctrl+1` .. `Ctrl+9` | Jump to tab 1–8 (`Ctrl+9` jumps to the last tab) |
| `Ctrl+F` | Open / focus search bar for the active tab |
| `Enter` / `Shift+Enter` | Next / previous search match (when search is open) |
| `Ctrl+G` | Focus page number jump input |
| `Ctrl+B` | Toggle Table of Contents drawer |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | Zoom in / zoom out / reset to Fit width |
| `Ctrl+Wheel` | Step zoom inside the viewport |
| `PageDown` / `PageUp` / `Home` / `End` | Scroll or jump within the active document |
| `Esc` | Close search bar or blur active toolbar/TOC focus |

---

## Getting Started

### Prerequisites (Windows x64)

Windows x64 (`x86_64-pc-windows-msvc`) is the primary verified target for development, testing, and release bundling.

1. **Rust toolchain** (with edition 2024 support, e.g. via [rustup](https://rustup.rs/))
2. **Tauri CLI v2**:
   ```powershell
   cargo install tauri-cli --version "^2.0.0" --locked
   ```
3. **Visual Studio C++ Build Tools** (`MSBuild` and the MSVC C++ toolchain) — required to compile `mupdf-sys` from source
4. **LLVM** (`libclang` for `bindgen`, available on `PATH` or configured via `LIBCLANG_PATH`)
5. **Microsoft Edge WebView2 Runtime** (pre-installed on Windows 10/11)

> **Note**: The first build compiles MuPDF from source and takes noticeably longer than subsequent incremental builds. `[profile.dev.package.mupdf-sys]` compiles MuPDF at `opt-level = 2` so dev builds match the Windows release MSVC CRT and render pages quickly.

### Clone & Run in Development

```powershell
git clone <repo-url>
cd reader

# Launch the desktop app
cargo tauri dev

# Or launch directly with a PDF file
cargo tauri dev -- path/to/document.pdf
```

### Build Release Executable

```powershell
cargo tauri build
```

Because `mupdf` is statically linked (`default-features = false`, features `base14-fonts`, `system-fonts`, `bundled-fonts-noto`), the resulting binary runs standalone with no external PDF DLLs required at runtime.

---

## Architecture Overview

```text
+-------------------------------------------------------------------+
| Frontend: Vanilla HTML / CSS / ES Modules (src/)                  |
|  - Slim Tab Strip + Toolbar, Empty State, TOC Drawer, Search Bar  |
|  - Virtualized Canvas Viewport (active tab) + Text/Highlight Layer|
|  - Calls Rust via window.__TAURI__.core.invoke + webview events   |
+----------------------------+--------------------------------------+
                             | Tauri IPC (JSON DTOs + Binary RGBA8)
+----------------------------v--------------------------------------+
| Backend: Tauri v2 / Rust 2024 (src-tauri/src/)                    |
|  - commands.rs   Thin async #[tauri::command] handlers            |
|  - state.rs      AppState + atomic state.json persistence         |
|  - worker.rs     Single doc-worker thread + epoch cancellation    |
|  - backend/      DocumentBackend trait + PdfBackend (MuPDF)       |
+-------------------------------------------------------------------+
```

Key architectural decisions:

- **Single `doc-worker` thread (`worker.rs`)**: All MuPDF calls execute on one dedicated OS thread (`doc-worker`) that owns the thread-local MuPDF context and a `HashMap<u64, OpenDocument>` keyed by monotonic `document_id`. Async Tauri commands send typed requests over `tokio::sync::mpsc` with `oneshot` replies so the async runtime is never blocked.
- **Epoch-based render cancellation**: Rapid scrolling, zooming, or tab switching increments a shared `AtomicU64` (`render_epoch`). Stale queued render requests or renders for closing tabs are discarded early with `ReaderError::Cancelled`.
- **Binary RGBA8 frame wire format**: `render_page` bypasses JSON/base64/PNG encoding and returns raw bytes `[width: u32 LE][height: u32 LE][RGBA8 pixels]` via `tauri::ipc::Response`, decoded on the frontend with `DataView` and `ImageData`.
- **Normalized coordinates (`[0.0, 1.0]`)**: Text spans and search match rectangles are normalized on the Rust side in top-left page space so frontend zoom changes scale overlays purely in CSS.

### Repository Layout

```text
.
├── docs/
│   ├── SPEC.md                 # Product scope, IPC contract, and visual spec
│   └── PHASES.md               # Phased implementation roadmap and exit gates
├── src/                        # Vanilla HTML/CSS/ES module frontend
│   ├── index.html              # Semantic shell (chrome, empty state, reader shell)
│   ├── styles.css              # Design tokens and flat-specificity styles
│   ├── main.js                 # App bootstrap, tab coordination, drag-drop, persistence
│   ├── api.js                  # Typed wrapper over window.__TAURI__ invoke/events
│   ├── tabs.js                 # Slim tab strip and per-tab state
│   ├── toolbar.js              # Document toolbar (page jump, zoom, fit, toggles)
│   ├── viewport.js             # Virtualized HiDPI canvas viewport & eviction
│   ├── text-layer.js           # Lazy transparent text overlay & copy formatting
│   ├── toc.js                  # Collapsible TOC outline drawer
│   ├── search.js               # Per-tab Ctrl+F search bar & match navigation
│   ├── empty-state.js          # Drop zone, recent files list, inline errors
│   └── shortcuts.js            # Centralized keyboard and Ctrl+Wheel router
├── src-tauri/                  # Tauri v2 / Rust backend (reader_lib)
│   ├── Cargo.toml              # Crate config, MuPDF features, strict clippy lints
│   ├── tauri.conf.json         # Window defaults (1100x800, min 640x480) & bundle config
│   ├── capabilities/           # Minimal Tauri v2 permissions (core:default, dialog:allow-open)
│   ├── src/
│   │   ├── main.rs             # Binary entrypoint
│   │   ├── lib.rs              # Tauri builder, plugin/state wiring, command registration
│   │   ├── commands.rs         # Thin Tauri IPC command handlers & validation
│   │   ├── state.rs            # AppState, CLI arg parsing, atomic state.json persistence
│   │   ├── worker.rs           # Dedicated doc-worker thread & epoch cancellation
│   │   ├── error.rs            # ReaderError (thiserror) & JSON ErrorResponse
│   │   └── backend/
│   │       ├── mod.rs          # DocumentBackend trait, DTOs, geometry helpers, open()
│   │       └── pdf.rs          # PdfBackend (statically linked MuPDF)
│   └── tests/
│       ├── common/mod.rs       # Dynamic PDF fixture discovery helper
│       ├── fixture_discovery.rs# Tests for fixture resolution logic
│       └── pdf_backend.rs      # Backend & worker integration tests
└── tests/
    └── fixtures/               # Gitignored local PDF fixtures (*.pdf) for manual/integration tests
```

---

## Verification & Testing

Run formatting, strict lints, and tests inside `src-tauri/`:

```powershell
cd src-tauri
cargo fmt --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test
```

### Local PDF Integration Tests

Unit tests (error mapping, coordinate normalization, dimension clamping, atomic state persistence, recent files deduplication/cap, epoch cancellation) always run unconditionally.

Integration tests in `src-tauri/tests/pdf_backend.rs` dynamically discover a local PDF fixture in this order:
1. The path specified in the `READER_TEST_PDF` environment variable, if set.
2. The lexicographically first `*.pdf` file in `tests/fixtures/` (ignored by `.gitignore`).

If no fixture is found, fixture-dependent integration tests skip cleanly without failing.

---

## License

This project statically links [`mupdf`](https://crates.io/crates/mupdf) (`0.8`), which is licensed under **AGPL-3.0**. Accordingly, Reader is distributed in compliance with the **GNU Affero General Public License v3.0 (AGPL-3.0)** (note: add a root `LICENSE` file before publishing or distributing binaries).
