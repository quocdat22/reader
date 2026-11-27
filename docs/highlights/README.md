# CR-010: Minimalist On-Page Text Highlights

- **ID**: `CR-010`
- **Status**: Implemented
- **Scope**: Rust content fingerprinting, atomic per-document highlight store, and 4 highlight CRUD IPC commands (`src-tauri/src/highlights.rs`, `src-tauri/src/state.rs`, `src-tauri/src/worker.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/error.rs`); Svelte 5 frontend typed IPC, highlight geometry/overlap domain, Runes store/actions, imperative highlight rendering & selection extraction engines, Toolbar Highlighter Mode controls, on-page edit popover, and keyboard shortcuts (`src/lib/ipc/{types,client}.ts`, `src/lib/domain/{highlights,format-error}.ts`, `src/lib/state/{types,app-store.svelte,actions}.ts`, `src/lib/engines/{text-layer,highlight-layer,link-layer,viewport,shortcuts}.ts`, `src/components/{Toolbar,ViewportHost,HighlightPopover,icons/HighlighterIcon,icons/CopyIcon,icons/TrashIcon}.svelte`, `src/styles/{tokens,viewport-layers}.css`). **Zero new Cargo crates, zero new npm packages, zero modifications to source PDF files, zero changes to `state.json` schema (`version: 1`), and zero changes to CSP policy.**
- **Supersedes / Amends**: [docs/SPEC.md](../SPEC.md) (§1 Non-Goals, §3 Backend, §4 IPC Contract, §5 Aesthetic Direction / Frontend Module Structure / Keyboard Shortcuts), [docs/PHASES.md](../PHASES.md) (Phases 2–6), and [AGENTS.md](../../AGENTS.md) (scope discipline & repository map — updated at Phase 5 closure).

---

## 1. Context & Problem Statement

In the frozen v1 baseline ([SPEC §1](../SPEC.md#v1-non-goals-out-of-scope)), highlights and annotations were intentionally kept out of scope while the reading viewport, virtualized HiDPI canvas, text selection overlay, in-document search, and clickable links (`CR-009`) stabilized. In day-to-day technical and book reading, however, marking passages with persistent color highlights is the highest-value reading aid — yet most PDF readers ruin reading calm by popping toolbars on every copy selection, mutating source PDF files (breaking read-only files, synced folders, and Windows file locks), or adding bulky annotation sidebars.

Text highlighting is also architecturally subtle across both Rust and frontend layers:

1. **Identity & Persistence Without Mutating Source PDFs**: Keying highlights by canonical filesystem path breaks whenever a user renames or reorganizes PDF folders, while writing `/Highlight` annotations back into the PDF introduces save/dirty state, read-only failure modes, Windows `FPDF_LoadCustomDocument` lock conflicts, and format lock-in.
2. **Coordinate Precision & Cross-Page Continuity**: Highlights must align cleanly across arbitrary zoom levels (`50%`–`400%`), HiDPI monitor switches, `CropBox`/`/Rotate` pages, multi-column layouts, and selections spanning page boundaries (`page N` → `page N+1`) without forcing extra Rust round-trips during selection.
3. **Layering & Interaction Restraint**: Persistent highlights must coexist cleanly with PDF ink (via `mix-blend-mode: multiply`), temporary `Ctrl+F` search hit overlays, clickable `/Link` annotations (`CR-009`), native drag-selection (`Ctrl+C`), and virtualized canvas/text-layer eviction (`±6` pages) without stealing clicks from PDF links or showing distracting popovers during normal reading.

**Goal**: Deliver a quiet, ultra-minimalist **on-page color text highlighting** experience backed by fast, content-fingerprinted per-document JSON storage in app data — executed in **6 sequential, independently verifiable phases (`Phase 0` → `Phase 5`)**.

---

## 2. Locked Architectural Decisions (ADR Summary)

All foundational product and engineering decisions for `CR-010` are finalized:

| # | Area | Decision | Rationale |
| --- | --- | --- | --- |
| 1 | **Persistence Model** | Separate per-document JSON files under `<app_data_dir>/highlights/<fingerprint>.json` written atomically (`*.tmp` → `sync_all` → `rename`). Source PDFs are never modified; `state.json` (`version: 1`) is unchanged. | Zero risk of corrupting PDFs, works on read-only/cloud-synced files, instant auto-save with zero Save/Dirty prompts, and keeps `DocumentBackend` format-agnostic. |
| 2 | **Document Identity** | Deterministic pure-Rust `SHA-256` content fingerprint over exact `u64` file length + `64 KiB` head/middle/tail byte samples (or full file when `<= 192 KiB`), zero new Cargo crates. | `<1ms` I/O even on multi-hundred-MB PDFs; highlights survive moving or renaming PDF files cleanly without collision risk. |
| 3 | **Functional Scope** | Pure color text highlights only — zero notes, zero underline/strikethrough, zero freehand/area markup. | Preserves `reader`'s quiet reading-room minimalism and avoids form/modal complexity. |
| 4 | **Creation Interaction** | Explicit **Highlighter Mode** toggled from `Toolbar.svelte` (`Ctrl+Shift+H`). Normal Reading Mode stays 100% quiet: drag-selecting text only supports native `Ctrl+C` copy with zero selection popover. | Prevents accidental popovers while reading or copying text; enables effortless continuous highlighting while Highlighter Mode is active. |
| 5 | **Edit / Delete Interaction** | Primary non-drag click (`<= 4px`, collapsed selection) on an existing highlight in **any mode** opens a compact quiet popover (`[Yellow \| Green \| Pink \| Copy \| Delete]`). | Allows fast color edits, quote copy, or deletion without switching modes; PDF `/Link` annotations always retain click priority. |
| 6 | **Color Palette** | **3 fixed curated semantic colors**: `"yellow"` (default), `"green"`, `"pink"`, rendered with `mix-blend-mode: multiply` over pure-white `#FFFFFF` sheets. | Visually restrained, crisp ink contrast, distinct from cobalt `--selection-bg` and amber `--search-hit-bg`, and ultra-compact in toolbar and popover. |
| 7 | **Navigation Drawer** | **None.** No Highlights sidebar/drawer; all interaction happens directly on PDF pages. | Keeps reading viewport wide and uncluttered without duplicating or crowding `TocDrawer`. |
| 8 | **Cross-Page Highlights** | Stored as **one unified highlight entity** with sorted `segments: [{ page_index, rects }]` plus pre-formatted `quote`. | Recoloring, copying, or deleting from any segment acts atomically on the full passage, even if distant pages' text layers are evicted. |
| 9 | **Overlap Handling** | Independent stacking (reverse z-order / newest highlight wins hit-testing), plus near-identical selection deduplication (`overlapRatio >= 0.92`: same color → no-op; different color → recolor in place). | Avoids fragile 2D rectangle subtraction bugs on multi-column/table PDFs and preserves exact `quote` text while preventing accidental duplicates. |
| 10 | **Undo / Redo** | Out of scope — direct Create / Recolor / Delete mutations only. | Keeps state transitions simple and avoids shortcut conflicts with native text inputs. |
| 11 | **Toolbar Chrome** | Adds **1 single `26×26px` Highlighter icon button** beside Search at rest; when Highlighter Mode is active, reveals inline 3 color swatches (`Yellow`, `Green`, `Pink`) with `1`/`2`/`3` quick-switch keys and `Esc` to exit. | Near-zero visual footprint when reading; immediate tactile color switching when highlighting. |
| 12 | **IPC & Geometry Strategy** | Granular Rust CRUD commands (`get_highlights`, `create_highlight`, `update_highlight_color`, `delete_highlight`) over `spawn_blocking`, paired with hybrid frontend selection extraction (horizontal `subRange` projection clamped vertically to PDFium `TextSpan.rect`). | Eliminates full-file clobber races across duplicate tabs, removes empty `.json` files automatically, and delivers 0ms highlight creation with zero font-ascent jitter. |
| 13 | **Governance & Phasing** | Spec lives under `docs/highlights/` indexed as `CR-010 (Proposed)` in [docs/CHANGES.md](../CHANGES.md). Baseline docs (`SPEC.md`, `PHASES.md`) and `AGENTS.md` update only at **Phase 5** closure. | Keeps frozen baseline truthful while implementation progresses strictly one phase at a time. |

---

## 3. Baseline Traceability Matrix

When `CR-010` transitions from `Proposed` to `Implemented` in **Phase 5**, non-destructive `> [!NOTE]` callouts will be inserted beneath the baseline sections below per [docs/CHANGES.md](../CHANGES.md#authoring-rules-for-future-changes):

| Baseline Document & Section | Original v1 Baseline | Amended Behavior (`CR-010`) | Target Reference |
| --- | --- | --- | --- |
| [SPEC §1 — v1 Non-Goals](../SPEC.md#v1-non-goals-out-of-scope) | Lists highlights among out-of-scope features. | Enables minimalist on-page 3-color text highlights stored in app data (notes, bookmarks, markup shapes, forms, and PDF editing remain out of scope). | [ARCHITECTURE.md §1](ARCHITECTURE.md#1-content-fingerprinting--on-disk-persistence-src-taurisrchighlightsrs) |
| [SPEC §3 — Rust Backend Design](../SPEC.md#3-rust-backend-design) | Module layout covers `commands`, `state`, `worker`, `backend`, `covers`, `external`. | Adds `src-tauri/src/highlights.rs` (pure-Rust `SHA-256` content fingerprinting + atomic per-document `HighlightStore`) integrated into `AppState`. | [ARCHITECTURE.md §1–§2](ARCHITECTURE.md#1-content-fingerprinting--on-disk-persistence-src-taurisrchighlightsrs) |
| [SPEC §4 — IPC Contract](../SPEC.md#4-ipc-contract) | 13 IPC commands (including `CR-008` and `CR-009`). | Extends `OpenDocumentResponse` with `document_fingerprint` and adds `get_highlights`, `create_highlight`, `update_highlight_color`, and `delete_highlight`. | [ARCHITECTURE.md §2](ARCHITECTURE.md#2-rust-backend--tauri-ipc-contract) |
| [SPEC §5 — Aesthetic Direction & Shortcuts](../SPEC.md#aesthetic-direction) | Toolbar has TOC, Back/Forward, page, zoom, fit, Search, Open; no highlight controls or shortcuts. | Adds single Highlighter Mode toggle button + active-only inline 3-color swatches, `.highlight-layer` overlay, on-page `HighlightPopover`, `Ctrl+Shift+H`, `1`/`2`/`3` (mode-scoped), `Delete`/`Backspace` (popover-scoped), and `Esc` precedence. | [ARCHITECTURE.md §5–§6](ARCHITECTURE.md#5-imperative-viewport-layer-stack-selection-extraction--hit-testing) |
| [PHASES — Phases 2–6](../PHASES.md) | Deferred highlights out of v1 roadmap. | Delivered via the 6-phase `CR-010` execution roadmap (`Phase 0`–`Phase 5`) with automated Rust + Vitest + live `cargo tauri dev` exit gates. | [PHASES.md](PHASES.md) |
| [AGENTS.md — Minimalism, Constraints & Repository Map](../../AGENTS.md) | Lists highlights under prohibited scope additions and omits `highlights.rs` / `highlight-layer.ts`. | Updated in Phase 5 to recognize `CR-010` highlights while keeping notes/other annotations out of scope and listing new modules. | [Phase 5](phases/phase-5-hardening-doc-closure-and-release.md) |

---

## 4. Document Index & Reading Order

Read these documents in order before implementing any phase of `CR-010`:

1. **[ARCHITECTURE.md](ARCHITECTURE.md)** — Complete technical specification: content fingerprinting, on-disk JSON schema & validation caps, Rust `HighlightStore` & IPC contract, pure geometry/overlap algorithms, Svelte 5 Runes state & multi-tab sync, imperative `text-layer` / `highlight-layer` / `link-layer` / `viewport` integration, visual tokens, toolbar & popover UX, and keyboard shortcut precedence.
2. **[PHASES.md](PHASES.md)** — Master 6-phase execution roadmap, dependency graph, complete file touch map, requirements/edge-case traceability matrix, and cross-phase guardrails.
3. **Self-Contained Phase Execution Guides** *(execute strictly one phase at a time; satisfy every Exit Gate item before starting the next)*:
   - **[Phase 0: Document Content Fingerprinting & Rust `HighlightStore`](phases/phase-0-rust-fingerprint-and-highlight-store.md)**
   - **[Phase 1: Rust IPC Commands, Pure Geometry Domain & Svelte 5 Runes State](phases/phase-1-ipc-domain-and-runes-state.md)**
   - **[Phase 2: Imperative Highlight Layer & Selection-to-Geometry Engines](phases/phase-2-highlight-and-selection-engines.md)**
   - **[Phase 3: Toolbar Highlighter Mode Controls & Keyboard Ergonomics](phases/phase-3-toolbar-highlighter-mode-and-shortcuts.md)**
   - **[Phase 4: On-Page Highlight Popover (Recolor, Copy, Delete) & Link Coordination](phases/phase-4-highlight-popover-and-interactions.md)**
   - **[Phase 5: Edge-Case Hardening, Governance Doc Closure & Release Verification](phases/phase-5-hardening-doc-closure-and-release.md)**
