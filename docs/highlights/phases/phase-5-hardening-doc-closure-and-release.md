# Phase 5: Edge-Case Hardening, Governance Doc Closure & Release Verification

> **Read First**: [README.md](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md) · [PHASES.md](../PHASES.md) · [docs/CHANGES.md](../../CHANGES.md) · `.agents/skills/rust-best-practices/SKILL.md` · `.agents/skills/frontend-design/SKILL.md`

---

## 1. Goal & Preconditions

**Goal**: Stress-test every geometric, concurrency, persistence, and accessibility edge case of `CR-010`, audit both Rust and Svelte/CSS code against repository quality bars, close all governance documentation pointers (`SPEC.md`, `PHASES.md`, `AGENTS.md`, `CHANGES.md`, `docs/highlights/README.md`), and verify the standalone Windows x64 release bundle (`cargo tauri build`).

**Preconditions**:
- Phase 4 Exit Gate is 100% satisfied (`CR-010` full create/recolor/copy/delete flow is live and verified).

---

## 2. Scope Boundaries

### In Scope
- Targeted bug fixes and regression tests for any edge case uncovered during stress testing.
- Rust audit (`rust-best-practices`) across all files touched in `src-tauri/src/`.
- UI restraint & accessibility audit (`frontend-design`) across all components/CSS touched in `src/`.
- Governance documentation closure (`docs/SPEC.md`, `docs/PHASES.md`, `docs/CHANGES.md`, `docs/highlights/README.md`, `AGENTS.md`).
- Full Rust + Frontend automated gates, production CSP inspection (`dist/index.html`), standalone Windows x64 `cargo tauri build`, and fixture-privacy hygiene check.

### Out of Scope
- No new user-facing features beyond locked `CR-010` ADRs (no notes, no Highlights Drawer, no Undo/Redo, no PDF file embedding, no extra colors).

---

## 3. Files to Modify (Governance Closure)

| Action | Path | Purpose |
| --- | --- | --- |
| **MODIFY** | `docs/SPEC.md` | Insert non-destructive `> [!NOTE]` callouts referencing `CR-010` beneath §1 Non-Goals, §3 Rust Backend Design, §4 IPC Contract, and §5 Aesthetic Direction / Frontend Module Structure / Keyboard Shortcuts per [Baseline Traceability Matrix](../README.md#3-baseline-traceability-matrix). **Never edit original baseline prose.** |
| **MODIFY** | `docs/PHASES.md` | Insert non-destructive `> [!NOTE]` callouts referencing `CR-010` beneath Phases 2–6. **Never edit original baseline prose.** |
| **MODIFY** | `AGENTS.md` | Update Minimalism & scope discipline (note `CR-010` pure text highlights while keeping notes/other annotations/themes/split views out of scope) and mention `highlight-layer.ts` under imperative engines. |
| **MODIFY** | `docs/CHANGES.md` | Flip `CR-010` status from `Proposed` to `Implemented`. |
| **MODIFY** | `docs/highlights/README.md` | Flip `CR-010` header status from `Proposed` to `Implemented`. |

---

## 4. Detailed Technical Tasks

### 4.1 Edge-Case & Stress Hardening
Verify every scenario below via automated tests (where synthetic) and live `cargo tauri dev` testing against local `tests/fixtures/*.pdf`:

1. **PDF Geometry & Coordinate Edge Cases**:
   - **Rotated pages (`/Rotate` 90°/180°/270°)** and **cropped pages (`CropBox != MediaBox`)**: highlights align tightly with rendered glyphs across all zoom levels (`50%`–`400%`) and DPR scaling.
   - **Multi-column layouts & tables**: dragging within one column never merges highlight rects horizontally across column gutters.
   - **Cross-page selection & eviction**: highlight spanning `page N` → `page N+1` renders cleanly when scrolling far away (`> ±6` pages) and returning; hovering or selecting either page highlights both mounted segments cleanly.
   - **Overlapping highlights**: create two partially overlapping highlights of different colors → both render cleanly via `mix-blend-mode: multiply`, newest wins click hit-test, deleting the top one exposes the older highlight intact underneath.
   - **Near-duplicate guard**: re-dragging essentially the exact same span in the same color is a clean no-op; re-dragging in a different color recolors the existing highlight in place.
2. **Persistence, Multi-Tab & Recovery Edge Cases**:
   - **Read-only PDF**: mark a temporary PDF copy read-only (`attrib +R`), open it, create/recolor/delete highlights → works identically with zero errors (source PDF untouched!).
   - **Move / rename resilience**: create highlights on a temporary PDF copy, close tab, move/rename the copy, reopen → highlights restore automatically via content fingerprint.
   - **Duplicate-copy multi-tab sync**: open two copies of the exact same PDF from two different paths simultaneously → creating, recoloring, or deleting a highlight in Tab A updates Tab B immediately and leaves disk JSON valid.
   - **Corrupt JSON recovery**: write malformed JSON into `<app_data_dir>/highlights/<temp-fp>.json`, open the temp PDF → app warns to stderr and opens cleanly with zero crash; creating a new highlight overwrites cleanly via atomic write.
   - **Empty-file cleanup**: delete the final highlight of a document → `<fingerprint>.json` is deleted cleanly from `<app_data_dir>/highlights/`.
   - **Recent removal invariance**: click Remove on a recent file from Home → `<fingerprint>.json` remains intact when the file is reopened later.
   - **Rapid tab close / switch**: close a tab immediately after opening (while `get_highlights` is still in flight) → `DocumentScope` cancels cleanly with zero console errors or state leaks.
3. **UI Restraint, Responsive & Accessibility Hardening**:
   - **Narrow window (`640×480`)**: toggle Highlighter Mode on/off and open `HighlightPopover` near all 4 edges → zero broken layouts, zero clipped controls, `.tab-strip-drag` keeps draggable space.
   - **Visual layer harmony**: search (`Ctrl+F`) for a word inside an already-highlighted Yellow/Green/Pink passage → `.search-layer` (`z-index: 3`) + cobalt active outline remain unmistakably legible above `.highlight-layer` (`z-index: 2`).
   - **Keyboard-only audit**: `Ctrl+Shift+H` → `1`/`2`/`3` → `Esc`, popover `Tab`/`Enter`/`Delete`/`Backspace`/`Esc`, visible `:focus-visible` cobalt rings on every control, and `prefers-reduced-motion: reduce`.

### 4.2 Code Quality Audits
1. **Rust audit (`rust-best-practices`)**:
   - Zero `.unwrap()`, `.expect()`, or `panic!` in production code (`src-tauri/src/`).
   - Zero `unsafe` code; zero stray `.clone()`; clean `///` doc comments on all public items; `#[expect(clippy::...)]` with reason if any lint exception is genuinely required.
   - Confirm `src-tauri/Cargo.toml` gained zero new dependencies and `state.json` schema remained `version: 1`.
2. **Frontend audit (`frontend-design` + strict TypeScript)**:
   - Zero explicit `any`, zero Svelte imports inside `src/lib/engines/`, zero CSS frameworks, zero unused scoped selectors.
   - Perform a final "remove one accessory" pass on Toolbar highlight controls and `HighlightPopover.svelte` ensuring every border, shadow, and icon earns its pixels.

### 4.3 Governance Documentation Closure
1. Update `docs/SPEC.md` and `docs/PHASES.md` strictly with non-destructive `> [!NOTE]` callouts pointing to `docs/highlights/` sections (per `docs/CHANGES.md` Authoring Rules).
2. Update `AGENTS.md` scope/engine references accurately.
3. Flip `CR-010` status from `Proposed` to `Implemented` in `docs/CHANGES.md` and `docs/highlights/README.md`.

### 4.4 Production CSP & Standalone Windows x64 Release Build
1. Inspect `dist/index.html` after `pnpm build` to verify zero inline `<script>` or `<style>` tags (strict CSP compliance).
2. Run `cargo tauri build` on Windows x64.
3. Launch the built release executable outside the dev tree, open a local `tests/fixtures/*.pdf`, and confirm rendering, Highlighter Mode creation, on-page popover recolor/copy/delete, link clicks, search, and persistence across restart work identically in release mode.

---

## 5. Verification Plan

### Automated Commands
```powershell
# 1. Full Frontend Gate (repo root)
pnpm verify

# 2. Full Rust Gate (inside src-tauri/)
cargo fmt --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test

# 3. Standalone Windows x64 Release Bundle (repo root)
cargo tauri build

# 4. Repository Hygiene & Fixture Privacy Audit (repo root)
git status --short
```

Confirm via repo-wide search that:
- Zero files under `tests/fixtures/` are tracked or staged.
- Zero specific filenames from `tests/fixtures/` appear anywhere in tracked code, tests, docs, or commit messages.
- Zero references to `window.__TAURI__` remain in `src/`.

---

## 6. Exit Gate Checklist

- [ ] All geometry, persistence, multi-tab sync, read-only PDF, corrupt JSON, narrow-window (`640×480`), keyboard, and `prefers-reduced-motion` hardening checks pass.
- [ ] Rust audit (`rust-best-practices`) and UI restraint audit (`frontend-design`) pass cleanly.
- [ ] Zero new Rust crates or npm packages were added; source PDFs are never modified; `state.json` schema remains `version: 1`.
- [ ] `docs/SPEC.md`, `docs/PHASES.md`, `AGENTS.md`, `docs/CHANGES.md`, and `docs/highlights/README.md` are updated accurately with `CR-010` marked `Implemented`.
- [ ] `pnpm verify`, `cargo fmt --check`, `cargo clippy --all-targets --all-features --locked -- -D warnings`, and `cargo test` all pass.
- [ ] `cargo tauri build` succeeds on Windows x64, passes strict CSP, and launches cleanly outside the dev tree with full highlight functionality verified.
- [ ] `git status --short` confirms `tests/fixtures/` remains untracked/ignored and zero specific fixture filenames appear anywhere in tracked files.
