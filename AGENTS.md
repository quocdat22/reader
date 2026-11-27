# AGENTS.md

Operating contract for coding agents working on `reader` — a minimalist desktop document reader (PDF first) built with **Tauri v2**, **Rust (edition 2024)**, **Vite**, **TypeScript**, and **Svelte 5 (Runes)** managed with **pnpm**.

## Read First

1. [docs/SPEC.md](docs/SPEC.md) — product scope, non-goals, Rust/IPC architecture, UI brief, and baseline contract.
2. [docs/PHASES.md](docs/PHASES.md) — phased execution plan and exit gates. Execute one phase at a time; satisfy its exit gate before starting the next.
3. [docs/CHANGES.md](docs/CHANGES.md) — post-v1 change requests amending the frozen baseline docs (`docs/changes/NNN-*.md`, `docs/frontend-svelte5/`).

## Mandatory Skill Gates

- **Rust code (`src-tauri/`)**: Read `.agents/skills/rust-best-practices/SKILL.md` and relevant `references/chapter_*.md` files before writing or refactoring Rust.
  - Prefer borrowing (`&str`, `&[T]`) over `.clone()`; pass small `Copy` types (`<= 24` bytes) by value.
  - Return `Result<T, ReaderError>` via `thiserror`. Never use `.unwrap()`, `.expect()`, or `panic!` in production code (tests only).
  - Run `cargo fmt --check`, `cargo clippy --all-targets --all-features --locked -- -D warnings`, and `cargo test` on every Rust change.
  - Prefer `#[expect(clippy::lint)]` with a reason over `#[allow(...)]`.
  - Document public APIs with `///`; use `//` only to explain *why*.
- **UI, TypeScript & Svelte 5 (`src/`, `index.html`)**: Read `.agents/skills/frontend-design/SKILL.md` before writing or revising HTML/CSS/UI behavior.
  - Execute the mandatory **two-pass process** on UI changes: write a compact design plan (4–6 palette tokens, typography, wireframe, principles), self-critique it against the skill's anti-template rules, revise any generic choices, then code.
  - Use **Svelte 5 Runes** (`$state`, `$derived`, `$effect`, `$props`) in `.svelte` components and `src/lib/state/*.svelte.ts`; use `@tauri-apps/api` and `@tauri-apps/plugin-dialog` via the typed `src/lib/ipc/` adapter (`withGlobalTauri: false` — never reference `window.__TAURI__`).
  - Keep imperative engines (`src/lib/engines/viewport.ts`, `text-layer.ts`, `highlight-layer.ts`, `link-layer.ts`, `tab-drag.ts`, `shortcuts.ts`) framework-agnostic with zero Svelte imports and deterministic cleanup.
  - Enforce strict TypeScript (`strict: true`, zero explicit `any`), plain CSS (`src/styles/` + component `<style>` blocks, zero CSS frameworks), active sentence-case copy, keyboard focus visibility, and `prefers-reduced-motion`.
  - Run `pnpm verify` (`format:check`, `lint`, `typecheck`, `check`, `test`, `build`) on every frontend change, and visually inspect the running app (`cargo tauri dev`) on every UI change.

## Non-Negotiable Constraints

- **Frontend architecture & runtime restraint**: Frontend source lives in `src/` and `index.html`, built by Vite into `dist/` (`frontendDist: "../dist"`, `beforeBuildCommand: "pnpm build"`, `withGlobalTauri: false`). Keep dependencies focused on `@tauri-apps/api`, `@tauri-apps/plugin-dialog`, and Vite-compiled `svelte`; do not add CSS frameworks, client routers, extra state libraries, or heavy JS PDF wrappers.
- **Minimalism & scope discipline**: Implement only what is in `docs/SPEC.md` v1 scope and approved `docs/CHANGES.md` amendments (including `CR-009` clickable PDF links and `CR-010` minimalist 3-color on-page text highlights stored in app data). Do not add highlight notes/comments, drawers, undo/redo, freehand/shape annotations, themes/dark-mode PDF inversion, split views, or extra chrome.
- **PDFium thread safety, binary & licensing**: The PDF engine uses [`pdfium-render`](https://crates.io/crates/pdfium-render) (`0.9.6`, `pdfium_8125`, `thread_safe`) dynamically bound to a pinned no-V8 `pdfium.dll` (`chromium/8125`, `Apache-2.0 / BSD-3-Clause`). Run `.\scripts\fetch-pdfium.ps1` to download and SHA-256-verify `src-tauri/resources/pdfium.dll` (gitignored, bundled into release builds via Tauri `bundle.resources`). All runtime PDF calls execute on the single dedicated Rust worker thread (`doc-worker`) owning open document handles while sharing a process-wide `OnceLock<Pdfium>` singleton. Never block the Tauri async runtime.
- **Test fixture privacy**:
  - Local PDF fixtures live in `tests/fixtures/` (ignored by `.gitignore`).
  - **Never** track, stage, or commit any file under `tests/fixtures/`.
  - **Never** mention or hardcode any specific fixture filename in code, tests, docs, comments, or commit messages. Always refer generically to `tests/fixtures/*.pdf` and resolve fixtures dynamically (`READER_TEST_PDF` env var, else first `*.pdf` in `tests/fixtures/`).

## Repository Map

- `scripts/` — Setup helpers (`fetch-pdfium.ps1` downloads & SHA-256-verifies pinned `pdfium.dll`).
- `index.html`, `public/` — Vite HTML entry shell and static logo asset.
- `package.json`, `pnpm-lock.yaml`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `svelte.config.js`, `eslint.config.js` — Frontend build, lint, type-check, and Vitest configuration.
- `src/` — Svelte 5 + TypeScript frontend (`main.ts`, `App.svelte`, `components/`, `lib/{domain,engines,ipc,state}/`, `styles/`).
- `dist/` — Gitignored Vite production output served by Tauri (`frontendDist: "../dist"`).
- `src-tauri/` — Rust backend (`reader_lib`), Tauri v2 config (`tauri.conf.json`), capabilities (`capabilities/default.json`).
- `tests/fixtures/` — Gitignored local PDF fixture directory for integration and manual testing.
- `docs/` — Architecture specification (`SPEC.md`), phased roadmap (`PHASES.md`), and change requests (`CHANGES.md`, `changes/`, `frontend-svelte5/`).

## Standard Verification Commands

Run from repo root (or `src-tauri/` for `cargo` commands where noted):

```powershell
# Fetch pinned PDFium runtime binary (first time or after clean clone)
.\scripts\fetch-pdfium.ps1

# Frontend formatting, linting, type checking, Svelte checks, unit tests & production build (repo root)
pnpm verify

# Rust formatting, lints, and tests (run inside src-tauri/)
cargo fmt --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test

# Run desktop app in development mode (repo root)
cargo tauri dev

# Release bundle verification (Windows x64)
cargo tauri build

# Confirm no gitignored fixtures are tracked
git status --short
```
