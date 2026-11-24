# AGENTS.md

Operating contract for coding agents working on `reader` — a minimalist desktop document reader (PDF first) built with **Tauri v2**, **Rust (edition 2024)**, and **Vanilla HTML/CSS/JS** (zero Node/npm bundler).

## Read First

1. [docs/SPEC.md](docs/SPEC.md) — product scope, non-goals, Rust/IPC architecture, UI brief, and test strategy.
2. [docs/PHASES.md](docs/PHASES.md) — phased execution plan and exit gates. Execute one phase at a time; satisfy its exit gate before starting the next.
3. [docs/CHANGES.md](docs/CHANGES.md) — post-v1 change requests amending the frozen baseline docs (`docs/changes/NNN-*.md`).

## Mandatory Skill Gates

- **Rust code (`src-tauri/`)**: Read `.agents/skills/rust-best-practices/SKILL.md` and relevant `references/chapter_*.md` files before writing or refactoring Rust.
  - Prefer borrowing (`&str`, `&[T]`) over `.clone()`; pass small `Copy` types (`<= 24` bytes) by value.
  - Return `Result<T, ReaderError>` via `thiserror`. Never use `.unwrap()`, `.expect()`, or `panic!` in production code (tests only).
  - Run `cargo fmt --check`, `cargo clippy --all-targets --all-features --locked -- -D warnings`, and `cargo test` on every Rust change.
  - Prefer `#[expect(clippy::lint)]` with a reason over `#[allow(...)]`.
  - Document public APIs with `///`; use `//` only to explain *why*.
- **UI & CSS (`src/`)**: Read `.agents/skills/frontend-design/SKILL.md` before writing or revising HTML/CSS/UI behavior.
  - Execute the mandatory **two-pass process**: write a compact design plan (4–6 palette tokens, typography, wireframe, principles), self-critique it against the skill's anti-template rules, revise any generic choices, then code.
  - Keep copy active, plain, sentence-case, and non-apologetic. Support keyboard focus visibility and `prefers-reduced-motion`.
  - Visually inspect the running app (`cargo tauri dev`) on every UI phase.

## Non-Negotiable Constraints

- **No Node/bundler**: Frontend lives in `src/` as plain HTML, CSS, and ES modules (`frontendDist: "../src"`, `withGlobalTauri: true`). Do not add `package.json`, TypeScript build steps, or JS frameworks.
- **Minimalism & scope discipline**: Implement only what is in `docs/SPEC.md` v1 scope. Do not add annotations, themes/dark-mode PDF inversion, PDF links, split views, or extra chrome.
- **PDFium thread safety, binary & licensing**: The PDF engine uses [`pdfium-render`](https://crates.io/crates/pdfium-render) (`0.9.6`, `pdfium_8125`, `thread_safe`) dynamically bound to a pinned no-V8 `pdfium.dll` (`chromium/8125`, `Apache-2.0 / BSD-3-Clause`). Run `.\scripts\fetch-pdfium.ps1` to download and SHA-256-verify `src-tauri/resources/pdfium.dll` (gitignored, bundled into release builds via Tauri `bundle.resources`). All runtime PDF calls execute on the single dedicated Rust worker thread (`doc-worker`) owning open document handles while sharing a process-wide `OnceLock<Pdfium>` singleton. Never block the Tauri async runtime.
- **Test fixture privacy**:
  - Local PDF fixtures live in `tests/fixtures/` (ignored by `.gitignore`).
  - **Never** track, stage, or commit any file under `tests/fixtures/`.
  - **Never** mention or hardcode any specific fixture filename in code, tests, docs, comments, or commit messages. Always refer generically to `tests/fixtures/*.pdf` and resolve fixtures dynamically (`READER_TEST_PDF` env var, else first `*.pdf` in `tests/fixtures/`).

## Repository Map

- `scripts/` — Setup helpers (`fetch-pdfium.ps1` downloads & SHA-256-verifies pinned `pdfium.dll`).
- `src/` — Vanilla HTML/CSS/JS frontend served directly by Tauri.
- `src-tauri/` — Rust backend (`reader_lib`), Tauri v2 config (`tauri.conf.json`), capabilities (`capabilities/default.json`).
- `tests/fixtures/` — Gitignored local PDF fixture directory for integration and manual testing.
- `docs/` — Architecture specification (`SPEC.md`) and phased roadmap (`PHASES.md`).

## Standard Verification Commands

Run from repo root (or `src-tauri/` for `cargo` commands where noted):

```powershell
# Fetch pinned PDFium runtime binary (first time or after clean clone)
.\scripts\fetch-pdfium.ps1

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
