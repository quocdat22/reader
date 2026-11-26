# Reader

A minimalist desktop PDF reader built with **Tauri v2**, **Rust (edition 2024)**, **PDFium** (`pdfium-render v0.9.6`), and **Vite + TypeScript + Svelte 5** (managed with `pnpm`).

Reader treats the document page as the sole focus: a slim tab strip, a single-row toolbar, a quiet empty state, and a virtualized HiDPI reading viewport backed by a dedicated single-threaded Rust PDF engine.

---

## Features

- **Multiple ways to open**: Native file picker (`Ctrl+O`, supports multi-file selection), drag-and-drop onto the window, CLI / OS "Open With" file path argument, and a recent files list.
- **Minimal multi-tab workspace**: Slim horizontal tab strip (`32px`, hidden when no document is open), middle-click and `Ctrl+W` close, wheel scrolling for overflowing tabs, and automatic deduplication — opening an already-open file focuses its existing tab.
- **Virtualized HiDPI viewport**: Continuous vertical scroll pre-sized from page dimensions; renders only visible pages plus a `±2` page overscan buffer and evicts canvases beyond `±6` pages. Inactive tabs release their `<canvas>` backing stores immediately while preserving scroll position, zoom, outline, and search state.
- **Crisp rasterization & zoom**: Device-pixel-snapped layout (up to 3x DPR) and PDFium anti-aliased RGBA8 rendering (clamped to `4096px` max side) with Fit width (default), Fit page, and discrete zoom steps (`25%`–`400%`) via toolbar buttons, keyboard shortcuts, or `Ctrl+Wheel`.
- **Table of contents drawer**: Collapsible outline pane (`Ctrl+B`) lazily loaded and cached per tab, supporting nested chapters, active-section scroll tracking, and WAI-ARIA tree keyboard navigation.
- **Text selection & copy**: Lazy transparent HTML text overlay mapped from normalized `[0.0, 1.0]` page geometry (rescaled purely in CSS on zoom without re-querying Rust) with clean line/spacing formatting on `Ctrl+C`.
- **Per-tab in-document search**: `Ctrl+F` search bar with debounced case-insensitive substring matching, `current / total` match counter, `Enter` / `Shift+Enter` navigation, and page-level highlight boxes isolated per tab.
- **Session continuity**: Stores up to 10 recent files and per-file reading positions (`page_index`, `zoom_mode`, `zoom_scale`) atomically via `<app_data_dir>/state.json` (`state.json.tmp` → flush → rename).

---

## Scope & Non-Goals

Reader v1 intentionally keeps a tight scope (see [docs/SPEC.md](docs/SPEC.md) for the full specification). The following are **out of scope by design**:

- Annotations, highlights, bookmarks, notes, form filling, editing, or printing
- Dark or sepia reading modes and PDF page color inversion
- Clickable internal or external PDF hyperlinks
- Split views or multi-window session sync
- CSS frameworks, client routers, extra state libraries, or heavy PDF JS wrappers
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

1. **Rust toolchain** (with edition 2024 support, e.g. via [rustup](https://rustup.rs/), MSVC target)
2. **Node.js & `pnpm`** (to build, type-check, lint, and test the Vite + TypeScript + Svelte 5 frontend)
3. **Tauri CLI v2**:
   ```powershell
   cargo install tauri-cli --version "^2.0.0" --locked
   ```
4. **Microsoft Edge WebView2 Runtime** (pre-installed on Windows 10/11)
5. **PDFium runtime binary (`pdfium.dll`)** — downloaded and SHA-256-verified automatically via `scripts/fetch-pdfium.ps1` (pinned to `bblanchon/pdfium-binaries` `chromium/8125` no-V8 build; no `MSBuild` or `libclang` required for the PDF engine).

### Clone & Run in Development

```powershell
git clone <repo-url>
cd reader

# Install frontend dependencies
pnpm install --frozen-lockfile

# Download pinned pdfium.dll into src-tauri/resources/ (idempotent, SHA-256 verified)
.\scripts\fetch-pdfium.ps1

# Launch the desktop app (starts Vite dev server automatically via beforeDevCommand)
cargo tauri dev

# Or launch directly with a PDF file
cargo tauri dev -- path/to/document.pdf
```

### Build Release Executable

```powershell
.\scripts\fetch-pdfium.ps1
cargo tauri build
```

Tauri v2 bundles `pdfium.dll` and `PDFIUM-LICENSE.txt` via `bundle.resources` directly alongside `reader.exe` in the generated Windows packages (NSIS / MSI). For running the raw portable `reader.exe` outside the workspace, keep `pdfium.dll` in the same directory as `reader.exe` (or point `PDFIUM_LIB_PATH` to it).

---

## Architecture Overview

```text
+-------------------------------------------------------------------+
| Frontend: Vite + TypeScript + Svelte 5 (src/ -> dist/)            |
|  - Svelte 5 components (TabStrip, Toolbar, HomeScreen, TOC, Search) |
|  - Runes state (src/lib/state/) + pure domain helpers (domain/)   |
|  - Imperative engines (viewport, text-layer, tab-drag, shortcuts) |
|  - Typed IPC via @tauri-apps/api + plugin-dialog (withGlobalTauri: false) |
+----------------------------+--------------------------------------+
                             | Tauri IPC (JSON DTOs + Binary RGBA8)
+----------------------------v--------------------------------------+
| Backend: Tauri v2 / Rust 2024 (src-tauri/src/)                    |
|  - commands.rs   Thin async #[tauri::command] handlers            |
|  - state.rs      AppState + atomic state.json persistence         |
|  - worker.rs     Single doc-worker thread + epoch cancellation    |
|  - backend/      DocumentBackend trait + PdfBackend (PDFium)      |
+-------------------------------------------------------------------+
```

Key architectural decisions:

- **Single `doc-worker` thread (`worker.rs`)**: All PDFium document calls execute on one dedicated OS thread (`doc-worker`) owning a `HashMap<u64, OpenDocument>` keyed by monotonic `document_id`, backed by a process-wide `OnceLock<Pdfium>` (`thread_safe`) singleton. Async Tauri commands send typed requests over `tokio::sync::mpsc` with `oneshot` replies so the async runtime is never blocked.
- **Epoch-based render cancellation**: Rapid scrolling, zooming, or tab switching increments a shared `AtomicU64` (`render_epoch`). Stale queued render requests or renders for closing tabs are discarded early with `ReaderError::Cancelled`.
- **Binary RGBA8 frame wire format**: `render_page` bypasses JSON/base64/PNG encoding and returns raw bytes `[width: u32 LE][height: u32 LE][RGBA8 pixels]` via `tauri::ipc::Response`, decoded on the frontend with `DataView` and `ImageData`.
- **Normalized coordinates (`[0.0, 1.0]`)**: Text spans and search match rectangles are normalized on the Rust side in top-left page space so frontend zoom changes scale overlays purely in CSS.

### Repository Layout

```text
.
├── docs/
│   ├── SPEC.md                 # Product scope, IPC contract, and visual spec
│   ├── PHASES.md               # Phased implementation roadmap and exit gates
│   ├── CHANGES.md              # Post-v1 change index and authoring rules
│   └── frontend-svelte5/       # CR-007 Svelte 5 + Vite + TypeScript architecture & phases
├── public/                     # Static assets copied to dist/ (logo.png)
├── scripts/
│   └── fetch-pdfium.ps1        # Fetches & SHA-256-verifies pinned pdfium.dll (chromium/8125)
├── index.html                  # Vite HTML mount shell (<div id="app"> + /src/main.ts)
├── src/                        # Svelte 5 + TypeScript frontend
│   ├── main.ts                 # App mount, initial hydration, and native drag-drop wiring
│   ├── App.svelte              # Top-level chrome, Home/Reader switcher, and shortcuts wiring
│   ├── components/             # Svelte 5 UI components (TabStrip, Toolbar, TocDrawer, SearchBar, etc.)
│   ├── lib/
│   │   ├── domain/             # Pure TypeScript domain helpers (zoom, outline, recents, search, title)
│   │   ├── engines/            # Imperative TypeScript engines (viewport, text-layer, tab-drag, shortcuts)
│   │   ├── ipc/                # Typed IPC client, binary RGBA decoder, and error mapping
│   │   └── state/              # Svelte 5 Runes store, actions, doc-scope tokens, persistence
│   └── styles/                 # Design tokens, base accessibility rules, and viewport layer CSS
├── src-tauri/                  # Tauri v2 / Rust backend (reader_lib)
│   ├── Cargo.toml              # Crate config, pdfium-render features, strict clippy lints
│   ├── tauri.conf.json         # Window defaults, CSP, dist wiring, & pdfium.dll resources
│   ├── resources/              # Gitignored pdfium.dll & license fetched by scripts/fetch-pdfium.ps1
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
│   │       └── pdf.rs          # PdfBackend (PDFium via pdfium-render v0.9.6)
│   └── tests/
│       ├── common/mod.rs       # Dynamic PDF fixture discovery helper
│       ├── fixture_discovery.rs# Tests for fixture resolution logic
│       └── pdf_backend.rs      # Backend & worker integration tests
└── tests/
    └── fixtures/               # Gitignored local PDF fixtures (*.pdf) for manual/integration tests
```

---

## Verification & Testing

Run frontend verification from repo root:

```powershell
pnpm verify
```

Run Rust formatting, strict lints, and tests inside `src-tauri/`:

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

This project uses [`pdfium-render`](https://crates.io/crates/pdfium-render) (`0.9.6`, dual-licensed **MIT / Apache-2.0**) dynamically bound to Google's **PDFium** (`Apache-2.0 / BSD-3-Clause`, prebuilt via [`bblanchon/pdfium-binaries`](https://github.com/bblanchon/pdfium-binaries), MIT). Redistributable bundles include `PDFIUM-LICENSE.txt` alongside `pdfium.dll` (note: add a root `LICENSE` file before publishing or distributing binaries).
