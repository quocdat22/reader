# CR-005: Replace MuPDF with PDFium (`pdfium-render v0.9.6`)

- **ID**: `CR-005`
- **Status**: Implemented
- **Scope**: Backend PDF engine (`src-tauri/Cargo.toml`, `src-tauri/src/backend/pdf.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/worker.rs`), build/bundling configuration (`src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `scripts/fetch-pdfium.ps1`, `.gitignore`), and documentation. Zero breaking changes to the `DocumentBackend` trait, Tauri IPC contract, `state.json` schema, or frontend (`src/`).
- **Supersedes / Amends**: [docs/SPEC.md](../SPEC.md) (§2, §3) and [docs/PHASES.md](../PHASES.md) (Phase 0, Phase 1, Phase 6)

---

## 1. Context & Goal

The v1 baseline statically linked `mupdf` (`0.8`, `AGPL-3.0`) via `mupdf-sys`, requiring Visual Studio C++ Build Tools (`MSBuild`) and LLVM (`libclang`) to compile C sources on first build and carrying copyleft `AGPL-3.0` obligations.

**Goal**: Replace `mupdf` with Google's **PDFium** via [`pdfium-render` `v0.9.6`](https://crates.io/crates/pdfium-render) (`MIT / Apache-2.0`) dynamically bound at runtime to a prebuilt no-V8 `pdfium.dll` (`chromium/8125`, `Apache-2.0 / BSD-3-Clause`) while keeping the `DocumentBackend` trait, `DocumentWorker`, Tauri IPC binary frame format, and frontend 100% compatible.

---

## 2. Baseline Traceability Matrix

| Baseline Document & Section | Original v1 Behavior | Updated Behavior (This Document) |
| --- | --- | --- |
| [SPEC §2 — Target Platforms & MuPDF Engine](../SPEC.md#target-platforms--mupdf-engine) | Statically linked `mupdf` (`0.8`, `AGPL-3.0`) compiled via `mupdf-sys` (`MSBuild` + `libclang`); single standalone executable with zero external DLLs. | [§3. Engine, Binary Fetch & Bundling](#3-engine-binary-fetch--bundling) — `pdfium-render` `0.9.6` (`pdfium_8125`, `thread_safe`, `default-features = false`) dynamically bound to pinned no-V8 `pdfium.dll` (`chromium/8125`, `Apache-2.0 / BSD-3-Clause`), fetched via `scripts/fetch-pdfium.ps1` and bundled via Tauri `bundle.resources`. |
| [SPEC §3 — Concurrency & Render Cancellation](../SPEC.md#concurrency--render-cancellation-workerrs) | Dedicated `doc-worker` thread owns the thread-local MuPDF context and open document handles. | [§4. Process Singleton, Thread Safety & Streaming](#4-process-singleton-thread-safety--streaming) — `doc-worker` remains the single runtime execution thread for all open tabs; `Pdfium` is initialized once in a safe `OnceLock<Result<Pdfium, String>>` (`thread_safe`) providing `&'static Pdfium` to `PdfDocument<'static>`. |
| [SPEC §3 — Normalized Coordinate System](../SPEC.md#normalized-coordinate-system) | MuPDF top-left page points (`page.bounds()`) mapped to `[0.0, 1.0]`. | [§5. Coordinate Projection, Rendering, Outline, Text & Search](#5-coordinate-projection-rendering-outline-text--search) — PDFium bottom-left user-space coordinates are projected through visible `CropBox ∩ MediaBox` and clockwise `/Rotate` (`0°/90°/180°/270°`) into top-left `[0.0, 1.0]` `NormalizedRect` values. |
| [PHASES — Phase 0 Tasks 3–5](../PHASES.md#phase-0-foundation-tooling--mupdf-build-setup) | Adds `mupdf` `0.8`, checks `MSBuild`/`libclang`, and bundles zero external PDF DLLs. | [§3. Engine, Binary Fetch & Bundling](#3-engine-binary-fetch--bundling) — uses `pdfium-render` `0.9.6`, fetches pinned `pdfium.dll` with SHA-256 verification into gitignored `src-tauri/resources/`, and declares `bundle.resources` in `tauri.conf.json`. |
| [PHASES — Phase 1 Tasks 3–4](../PHASES.md#phase-1-rust-core--documentbackend-pdfbackend--worker-thread) | `PdfBackend` implemented on statically linked MuPDF (`aa_level = 8`, `search_cb`). | [§5. Coordinate Projection, Rendering, Outline, Text & Search](#5-coordinate-projection-rendering-outline-text--search) — `PdfBackend` implemented on `pdfium-render` with exact-size RGBA8 rendering, recursive cycle-safe outline extraction, visual-line text span extraction, and case-insensitive search. |
| [PHASES — Phase 6 Task 4 & Exit Gate](../PHASES.md#phase-6-polish-hardening--release-verification) | Verifies standalone release binary runs with zero external PDF DLLs. | [§6. Verification Checklist](#6-verification-checklist) — verifies release bundle packages `pdfium.dll` + `PDFIUM-LICENSE.txt` and runs cleanly outside the dev tree without referencing `CARGO_MANIFEST_DIR`. |

---

## 3. Engine, Binary Fetch & Bundling

- **Cargo dependency (`src-tauri/Cargo.toml`)**:
  - `pdfium-render = { version = "0.9.6", default-features = false, features = ["pdfium_8125", "thread_safe"] }`
  - Disabling default features omits the `image` crate (Rust transmits raw `RGBA8` frames directly over Tauri IPC).
  - `[profile.dev.package.mupdf-sys]` is removed; building the PDF backend no longer compiles C sources or requires `MSBuild`/`libclang`.
- **Binary acquisition (`scripts/fetch-pdfium.ps1`)**:
  - Downloads pinned release `chromium/8125` (`pdfium-win-x64.tgz`, no-V8/no-XFA) from `bblanchon/pdfium-binaries`.
  - Verifies the archive SHA-256 checksum (`9a964261760cff52570aabf038ab346d3a5034dd8b30d0d5fe8861235d356b8b`) before extracting only `bin/pdfium.dll`, `LICENSE`, and `VERSION` into `src-tauri/resources/` (`pdfium.dll`, `PDFIUM-LICENSE.txt`, `PDFIUM-VERSION.txt`).
  - Downloaded binaries and metadata files are gitignored (`.gitignore`), while `src-tauri/resources/.gitkeep` preserves the directory.
  - `src-tauri/build.rs` emits a `cargo:warning` hint if neither `resources/pdfium.dll` nor `PDFIUM_LIB_PATH` / `PDFIUM_DYNAMIC_LIB_PATH` is present.
- **Tauri v2 bundling (`src-tauri/tauri.conf.json`)**:
  - `bundle.resources` maps `"resources/pdfium.dll": "pdfium.dll"` and `"resources/PDFIUM-LICENSE.txt": "PDFIUM-LICENSE.txt"` into `$RESOURCE` (next to `reader.exe` in Windows bundles).
- **Safe runtime DLL lookup (`src-tauri/src/backend/pdf.rs`)**:
  - Never loads from `./` (current working directory) to prevent Windows DLL hijacking when opening files from untrusted folders.
  - Ordered lookup: `PDFIUM_LIB_PATH` / `PDFIUM_DYNAMIC_LIB_PATH` → Tauri `app.path().resource_dir()` (registered in `lib.rs` via `configure_resource_dir`) → `current_exe().parent()` → `CARGO_MANIFEST_DIR/resources` (compiled only under `#[cfg(any(debug_assertions, test))]`) → `Pdfium::bind_to_system_library()`.

---

## 4. Process Singleton, Thread Safety & Streaming

- `Pdfium` is initialized once in `static PDFIUM: OnceLock<Result<Pdfium, String>>`, providing `&'static Pdfium` so `PdfBackend` stores `PdfDocument<'static>` cleanly inside `Box<dyn DocumentBackend>` with zero `unsafe`.
- All production document operations remain serialized on the single `doc-worker` OS thread; enabling `thread_safe` also makes parallel `cargo test` invocations safe across threads.
- Documents open via `pdfium.load_pdf_from_reader(File::open(path)?, None)` (`FPDF_LoadCustomDocument`), enabling lazy on-demand streaming and full Windows Unicode / `\\?\` long-path / extensionless-PDF support without loading large files completely into memory.
- `PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError)` maps to `ReaderError::PasswordProtected`; `PdfiumError::IoError` maps to `ReaderError::Io`; all other load errors map to `ReaderError::InvalidDocument`.

---

## 5. Coordinate Projection, Rendering, Outline, Text & Search

- **Rasterization (`render_page`)**:
  - Uses `PdfRenderConfig::new().set_fixed_size(target_w, target_h)` (after `clamp_render_dimensions` `<= 4096px`), opaque white clear (`PdfColor::WHITE`), annotations & form data enabled, grayscale anti-aliasing (`use_lcd_text_rendering(false)`), and PDFium's `FPDF_REVERSE_BYTE_ORDER` flag so `bitmap.as_rgba_bytes()` yields tightly packed `RGBA8` directly without an extra channel-swap copy.
- **Coordinate projection (`normalize_pdfium_rect`)**:
  - Projects bottom-left PDF user-space rectangles through the page's visible box (`CropBox ∩ MediaBox`, falling back to available box/dimensions) and clockwise `/Rotate` (`0°`, `90°`, `180°`, `270°`) into top-left `[0.0, 1.0]` `NormalizedRect` coordinates.
- **Outline (`outline`)**:
  - Recursively traverses `document.bookmarks().root()` via `first_child()` / `next_sibling()`, resolving `bookmark.destination()` with fallback to `GoToDestinationInSameDocument` local actions, bounded by `MAX_OUTLINE_DEPTH = 64`, `MAX_OUTLINE_ITEMS = 50_000`, and a visited `HashSet<PdfBookmark>` cycle guard.
- **Text extraction (`page_text`)**:
  - Iterates `page.text()?.chars()`, projects each visible character's `loose_bounds()` (fallback `tight_bounds()`) into visual top-left page points, groups characters into visual lines (explicit `\r`/`\n` and vertical baseline breaks), and splits wide horizontal column/table gutters (`> 1.5 em`) via `append_line_runs`.
- **Search (`search`)**:
  - Uses `page.text()?.search(query, &PdfSearchOptions::new())` (case-insensitive substring) across pages and normalizes all segment bounding boxes per match through `normalize_pdfium_rect`.

---

## 6. Verification Checklist

- [x] `scripts/fetch-pdfium.ps1` downloads `chromium/8125`, verifies SHA-256, extracts `pdfium.dll`, skips on idempotent re-run, and stays ignored in `git status --short`.
- [x] `cargo fmt --check`, `cargo clippy --all-targets --all-features --locked -- -D warnings`, and `cargo test` pass (including rotation + `CropBox` alignment vs `FPDF_PageToDevice`, Unicode filename loading, password detection, multi-page nested outline, and fixture integration tests in `tests/pdf_backend.rs`).
- [x] `cargo tauri build` succeeds on Windows x64, bundles `pdfium.dll` + `PDFIUM-LICENSE.txt`, and launches cleanly outside the dev tree.
- [ ] Live visual/UX verification in `cargo tauri dev` against `tests/fixtures/*.pdf`.
