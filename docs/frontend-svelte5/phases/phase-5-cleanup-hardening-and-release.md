# Phase 5: Legacy Cleanup, Hardening, Doc Closure & Release Verification

> **Read First**: [README.md](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md) · [PHASES.md](../PHASES.md) · [docs/CHANGES.md](../../CHANGES.md) · `.agents/skills/frontend-design/SKILL.md`

---

## 1. Goal & Preconditions

**Goal**: Remove all obsolete legacy vanilla JS/CSS files, run full edge-case/stress/accessibility hardening, update repository governance documentation (`AGENTS.md`, `docs/CHANGES.md`, `docs/SPEC.md`, `docs/PHASES.md`, `docs/frontend-svelte5/README.md`), and verify the standalone Windows x64 release build (`cargo tauri build`).

**Preconditions**:
- Phase 4 Exit Gate is 100% satisfied (full feature parity live and verified on Svelte 5).

---

## 2. Scope Boundaries

### In Scope
- Deleting all 11 legacy vanilla frontend files (`src/*.js` and `src/styles.css`).
- Removing temporary legacy-file ignore entries from `eslint.config.js` and `.prettierignore`.
- Edge-case, multi-tab stress, narrow-window (`640x480`), accessibility, and `frontend-design` restraint audit.
- Governance documentation closure (`AGENTS.md`, `docs/CHANGES.md`, baseline `> [!NOTE]` callouts in `docs/SPEC.md` and `docs/PHASES.md`, and status flip in `docs/frontend-svelte5/README.md`).
- Full Rust + Frontend verification and standalone Windows x64 `cargo tauri build` verification.

### Out of Scope
- No new user-facing features beyond v1 + `CR-001`..`CR-006`.
- No Rust backend logic changes (`src-tauri/src/` remains untouched).

---

## 3. Files to Delete / Modify

| Action | Path | Purpose |
| --- | --- | --- |
| **DELETE** | `src/main.js`, `src/api.js`, `src/tabs.js`, `src/viewport.js`, `src/text-layer.js`, `src/toolbar.js`, `src/toc.js`, `src/search.js`, `src/empty-state.js`, `src/shortcuts.js`, `src/styles.css` | Remove obsolete vanilla frontend files completely replaced by TypeScript/Svelte 5 modules. |
| **MODIFY** | `eslint.config.js`, `.prettierignore` | Remove temporary legacy `src/*.js` / `src/styles.css` ignore patterns so linting & formatting cover 100% of `src/`. |
| **MODIFY** | `AGENTS.md` | Replace the "No Node/bundler" constraint with the Vite + TypeScript + Svelte 5 + `pnpm` operating contract, update Repository Map, and add `pnpm verify` to Standard Verification Commands. |
| **MODIFY** | `docs/SPEC.md` | Insert non-destructive `> [!NOTE]` callouts referencing `CR-007` under §1 Non-Goals, §2 Architecture, §4 IPC Contract, and §5 Frontend Module Structure (per [Baseline Traceability Matrix](../README.md#3-baseline-traceability-matrix)). Never edit original baseline prose. |
| **MODIFY** | `docs/PHASES.md` | Insert non-destructive `> [!NOTE]` callouts referencing `CR-007` under Phases 3–6. Never edit original baseline prose. |
| **MODIFY** | `docs/CHANGES.md` | Update `CR-007` status from `Proposed` to `Implemented`. |
| **MODIFY** | `docs/frontend-svelte5/README.md` | Update `CR-007` header status from `Proposed` to `Implemented`. |

---

## 4. Detailed Technical Tasks

### 4.1 Legacy Removal & Strict Lint/Format Coverage
1. Delete all 11 legacy files listed in §3.
2. Clean `eslint.config.js` and `.prettierignore` so zero files in `src/` are exempted from linting, formatting, or strict type checking.
3. Confirm no dead imports, unused CSS selectors (`svelte-check` reports unused scoped selectors automatically!), or stray references to `window.__TAURI__` remain anywhere under `src/`.

### 4.2 Edge-Case, Stress & Restraint Hardening
Execute live verification in `cargo tauri dev` against `tests/fixtures/*.pdf` (and synthetic error files) covering:
1. **Error recovery**:
   - Missing/moved recent file → clear sentence-case error + working `Remove from recent` button (in `#empty-error` on Home, or `#notice-banner` while reading).
   - Corrupt, non-PDF, or password-protected PDF → actionable error without disturbing already-open tabs or empty state.
   - Multi-file drag-drop batch combining invalid and valid PDFs → valid files open and batch error feedback remains visible in `#notice-banner`.
2. **Multi-tab & async concurrency stress**:
   - Rapid tab switching (`Ctrl+Tab` spam) during in-flight page renders, outline fetches, and search queries — verify zero stale canvases, zero leaked highlights, zero uncaught promise rejections, and bounded canvas memory.
   - Close a tab immediately after triggering `Ctrl+B` (outline) or `Ctrl+F` (search) — verify `DocumentScope` cancels cleanly.
   - Rapidly scroll Tab A, switch to Tab B, scroll Tab B, and close window — verify **both** documents persist their exact last pages via per-path `PersistenceQueue`.
   - Open duplicate file via dialog and drag-drop simultaneously — verify existing tab focuses with zero duplicate handles.
3. **Viewport, DPI & responsive restraint**:
   - Rapid `Ctrl+Wheel` zoom + continuous window resize down to `640x480` — verify toolbar labels collapse cleanly (`max-width: 740px`), `.tab-strip-drag` keeps at least 36px draggable space with overflowing tabs, and scroll anchor holds steady.
   - Move window across monitors with different DPI scaling (if multi-DPI display available) or test browser zoom/DPR snap — verify crisp 1:1 HiDPI re-render.
   - Audit keyboard focus rings (`:focus-visible`) and `prefers-reduced-motion: reduce`.
   - Perform a final `frontend-design` restraint pass verifying the locked 6-token palette (`#E4E7EC`, `#EEF0F4`, `#FFFFFF`, `#1A1F2B`, `#5A6475`, `#1E4DB7`) with zero superfluous borders, shadows, or visual regressions.

### 4.3 Governance & Documentation Closure
1. Update `AGENTS.md`:
   - Update top summary to reflect **Tauri v2**, **Rust (edition 2024)**, and **Vite + TypeScript + Svelte 5 (Runes)** via **`pnpm`**.
   - Add Frontend rules alongside Rust & UI skill gates (`pnpm verify`: `format:check`, `lint`, `typecheck`, `check`, `test`, `build`; no explicit `any`; preserve imperative engine boundary for `viewport.ts` / `text-layer.ts`; no CSS frameworks).
   - Update Repository Map (`index.html`, `package.json`, `public/`, `src/lib/`, `src/components/`, `src/styles/`, `dist/`).
2. Add non-destructive `> [!NOTE]` callouts in `docs/SPEC.md` and `docs/PHASES.md` strictly per `docs/CHANGES.md` Authoring Rules (never editing frozen v1 prose).
3. Flip `CR-007` status to `Implemented` in `docs/CHANGES.md` and `docs/frontend-svelte5/README.md`.

### 4.4 Standalone Windows x64 Release Build & CSP Audit
1. Inspect `dist/index.html` after `pnpm build` to verify zero inline `<script>` or inline `<style>` tags (strict compliance with production CSP `script-src 'self'; style-src 'self'`).
2. Run `cargo tauri build` on Windows x64.
3. Launch the built release executable outside the dev tree (confirming `pdfium.dll`, `PDFIUM-LICENSE.txt`, and compiled `dist/` assets are bundled cleanly) and open a local `tests/fixtures/*.pdf` to confirm rendering, TOC, search, text copy, and persistence work identically in release mode.

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

- [ ] All 11 legacy vanilla files (`src/*.js`, `src/styles.css`) are deleted and no unused CSS/JS remains.
- [ ] `eslint.config.js` and `.prettierignore` cover 100% of `src/` with zero legacy exemptions.
- [ ] All stress, error-recovery, narrow-window (`640x480`), keyboard-only, and `frontend-design` restraint checks pass in `cargo tauri dev`.
- [ ] `AGENTS.md`, `docs/CHANGES.md`, `docs/SPEC.md`, `docs/PHASES.md`, and `docs/frontend-svelte5/README.md` are updated accurately with `CR-007` marked `Implemented`.
- [ ] `pnpm verify` passes with zero warnings or errors.
- [ ] Rust `cargo fmt --check`, `cargo clippy --all-targets --all-features --locked -- -D warnings`, and `cargo test` pass.
- [ ] `cargo tauri build` succeeds on Windows x64, passes strict production CSP, bundles `pdfium.dll` + `PDFIUM-LICENSE.txt` + `dist/`, and launches cleanly outside the dev tree.
- [ ] `git status --short` confirms `tests/fixtures/`, `node_modules/`, and `dist/` remain untracked/ignored and zero fixture filenames appear anywhere in tracked files.
