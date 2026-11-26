# CR-009: Clickable PDF Links & Per-Tab Navigation History

- **ID**: `CR-009`
- **Status**: Implemented
- **Scope**: Rust link extraction & external URI launcher (`src-tauri/Cargo.toml`, `src-tauri/src/error.rs`, `src-tauri/src/external.rs`, `src-tauri/src/backend/mod.rs`, `src-tauri/src/backend/pdf.rs`, `src-tauri/src/worker.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`) and Svelte 5 frontend link layer & per-tab navigation history (`src/lib/ipc/{types,errors,client}.ts`, `src/lib/domain/{history,format-error}.ts`, `src/lib/state/{types,app-store.svelte,actions}.ts`, `src/lib/engines/{link-layer,viewport,shortcuts}.ts`, `src/components/{Toolbar,ViewportHost,icons/ArrowIcon}.svelte`, `src/styles/viewport-layers.css`). Zero changes to `state.json` schema (`version: 1`), `package.json`, or CSP policy.
- **Supersedes / Amends**: [docs/SPEC.md](../SPEC.md) (§1, §3, §4, §5) and [docs/PHASES.md](../PHASES.md) (Phases 1, 2, 4, 5)

---

## 1. Context & Goal

In the frozen v1 baseline ([SPEC §1](SPEC.md#v1-non-goals-out-of-scope)), clickable internal and external PDF links were intentionally deferred out of scope. Once v1 stabilized, reading cross-referenced PDFs (tables of contents, citations, footnotes, external references) required manual page jumping or copying plain URLs.

**Goal**: Support standard PDF `/Link` annotations (internal page/coordinate destinations and external `http`/`https`/`mailto` links) together with per-tab Back/Forward navigation history while keeping `reader`'s quiet reading-room minimalism, zero-`unsafe` Rust PDFium backend, and uninterrupted text selection.

---

## 2. Baseline Traceability Matrix

| Baseline Document & Section | Original / Prior Behavior | Updated Behavior (This Document) |
| --- | --- | --- |
| [SPEC §1 — v1 Non-Goals](../SPEC.md#v1-non-goals-out-of-scope) | Clickable internal/external PDF links were out of scope. | [§3. PDF Link Extraction & Security](#3-pdf-link-extraction--security) — enables standard PDF `/Link` annotations (internal destinations + allowlisted external URIs). |
| [SPEC §3 — Lightweight `DocumentBackend` Trait](../SPEC.md#lightweight-documentbackend-trait-boundary) | `DocumentBackend` covers metadata, rendering, outline, text, and search. | [§3. PDF Link Extraction & Security](#3-pdf-link-extraction--security) — adds `page_links(&self, page_index: usize) -> Result<Vec<PageLink>, ReaderError>`. |
| [SPEC §4 — IPC Contract](../SPEC.md#4-ipc-contract) | 11 IPC commands (including `CR-008` `get_recent_cover`). | [§4. IPC Commands & Wire DTOs](#4-ipc-commands--wire-dtos) — adds `get_page_links` and `open_external_url`. |
| [SPEC §5 — Aesthetic Direction & Shortcuts](../SPEC.md#aesthetic-direction) | Toolbar had `[TOC] [page] [- % +] [Fit] [Search] [Open]`; no navigation history shortcuts. | [§5. Frontend Link Layer & Navigation History](#5-frontend-link-layer--navigation-history) — adds Back/Forward toolbar buttons, `Alt+ArrowLeft`/`Alt+ArrowRight`, mouse buttons `3`/`4`, and invisible-at-rest `.link-layer` overlays. |
| [PHASES — Phase 1, 2, 4, 5](../PHASES.md) | Phases deferred PDF links and navigation history. | [§3](#3-pdf-link-extraction--security), [§4](#4-ipc-commands--wire-dtos), [§5](#5-frontend-link-layer--navigation-history) — implements backend link extraction, IPC commands, history shortcuts, and imperative link layer. |

---

## 3. PDF Link Extraction & Security

- **Safe `pdfium-render` extraction (`src-tauri/src/backend/pdf.rs`)**:
  - Iterates `page.annotations()` for `PdfPageAnnotation::Link` entries (ignoring `is_hidden()`), keeping zero `unsafe` code in `src-tauri/src/`.
  - Extracts hit rectangles from `attachment_points()` (`/QuadPoints`) first so wrapped multi-line links preserve tight per-line boxes, falling back to `link.rect()` or `link_annot.bounds()` and projecting through `CropBox ∩ MediaBox` and `/Rotate` (`0°`/`90°`/`180°`/`270°`) into top-left `[0.0, 1.0]` `NormalizedRect`s.
  - Resolves internal destinations (`link.destination()` or `PdfAction::LocalDestination`) to `{ page_index, target_point, target_rect }`, projecting `/XYZ`, `/FitH`, `/FitBH`, and `/FitR` coordinates against the **target page's** `PageCoordinateFrame` (cached per `target_page_index` within `page_links()`).
  - Resolves external URIs (`PdfAction::Uri`) filtered through `validate_external_url`.
- **External URI validation & launch (`src-tauri/src/external.rs`)**:
  - Parses URIs with `url::Url::parse` (`url = "2"`), rejects ASCII control characters, lengths `> 4096` bytes, and embedded credentials (`username`/`password`), and strictly allowlists `http`, `https` (non-empty host), and `mailto` (non-empty path, no host). Disallowed schemes return `ReaderError::UnsupportedUri` (`"unsupported_uri"`).
  - Opens validated URIs via `open::that_detached` (`open = "5"`, `shellexecute-on-windows` feature invoking `ShellExecuteExW` directly without `cmd.exe`) inside `tauri::async_runtime::spawn_blocking`.

---

## 4. IPC Commands & Wire DTOs

- **New Rust DTOs (`src-tauri/src/backend/mod.rs`) & TS mirror (`src/lib/ipc/types.ts`)**:
  - `NormalizedPoint { x: f32, y: f32 }`
  - `LinkTarget`: tagged enum (`kind: "internal" | "external"`):
    - `Internal { page_index: usize, target_point: Option<NormalizedPoint>, target_rect: Option<NormalizedRect> }`
    - `External { uri: String }`
  - `PageLink { rects: Vec<NormalizedRect>, target: LinkTarget }`
- **New Tauri IPC commands (`src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`)**:
  - `get_page_links { document_id: u64, page_index: usize } -> Vec<PageLink>` (dispatched via `WorkerRequest::PageLinks` on `doc-worker`).
  - `open_external_url { url: String } -> ()` (validates scheme allowlist and launches OS default handler).

---

## 5. Frontend Link Layer & Navigation History

- **Imperative link overlay (`src/lib/engines/link-layer.ts`)**:
  - Lazy-fetches `getPageLinks` with bounded concurrency (`<= 2`) and private per-tab LRU caching (`120` pages), cleared on document close/unmount.
  - Sits at `z-index: 3` behind `.text-layer` (`z-index: 4`) with `pointer-events: none` so mouse drag-selection works natively even starting on top of a link.
  - Tracks `pointerdown`, `pointermove`, `pointerleave`, and `click` on `#viewport`:
    - Hovering a link applies `.viewport--link-hover` (`cursor: pointer` even over `.text-span`), sets `viewportEl.title` (`Go to page N` or the URI) with zero extra floating UI, and toggles `.pdf-link-group--hover` (quiet cobalt wash + `1px` bottom rule across all wrapped rects).
    - Activates only on primary non-drag clicks (`<= 4px` movement with collapsed selection) or keyboard `Tab` + `Enter`/`Space` on the single focusable `.pdf-link-hit` button per logical link.
- **Per-tab Back / Forward history (`src/lib/domain/history.ts`, `src/lib/state/`, `src/components/Toolbar.svelte`, `src/lib/engines/shortcuts.ts`)**:
  - Stores per-tab `backStack` / `forwardStack` (`MAX_NAV_HISTORY = 50`) of `{ pageIndex, scrollAnchor }` snapshots across internal link clicks, TOC outline selections, and toolbar page jumps.
  - Exposes `[Back]` / `[Forward]` icon buttons (`ArrowIcon.svelte`) after a separator beside `[TOC]` in `Toolbar.svelte`, plus `Alt+ArrowLeft` / `Alt+ArrowRight` and mouse buttons `3` / `4` in `shortcuts.ts` (suppressing WebView2 browser history navigation).
  - `viewport.ts` adds `scrollToTarget` and `scrollToAnchor` with `pinnedJump` preservation so landing near the bottom of a target page keeps the toolbar page counter accurate.

---

## 6. Verification Checklist

- [x] `cargo fmt --check`, `cargo clippy --all-targets --all-features --locked -- -D warnings`, and `cargo test` pass (including `external`, `error`, `pdf` synthetic link/rotation/`QuadPoints`, `worker`, and `tests/pdf_backend.rs` fixture tests).
- [x] `pnpm verify` (`format:check`, `lint`, `typecheck`, `check`, `test`, `build`) passes.
- [ ] Live `cargo tauri dev` visual/interactive check against `tests/fixtures/*.pdf` (startup verified cleanly through `Running target\debug\reader.exe`; manual mouse/keyboard/external-browser walkthrough remains for desktop UI inspection).
