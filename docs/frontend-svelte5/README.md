# CR-007: Migrate Frontend to Vite + TypeScript + Svelte 5

- **ID**: `CR-007`
- **Status**: Implemented
- **Scope**: Frontend architecture, toolchain, styling organization, automated testing, and Tauri v2 build wiring (`package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `public/`, `src/`, `src-tauri/tauri.conf.json`, `.gitignore`, and governance docs upon completion). **Zero changes to Rust backend source code (`src-tauri/src/`), `DocumentBackend`, `DocumentWorker`, Tauri IPC command signatures, binary `render_page` wire format, or `state.json` schema.**
- **Supersedes / Amends**: [docs/SPEC.md](../SPEC.md) (§1 Non-Goals, §2 Architecture, §4 IPC transport, §5 Frontend Module Structure), [docs/PHASES.md](../PHASES.md) (Phases 3–6), and [AGENTS.md](../../AGENTS.md) (frontend toolchain & verification rules — updated at Phase 5 cutover).

---

## 1. Context & Problem Statement

`reader` shipped v1 as zero-bundler Vanilla HTML/CSS/ES Modules (`src/`) and then absorbed six post-v1 Change Requests (`CR-001` through `CR-006`: singleton `Home` tab, borderless titlebar & window controls, pointer/keyboard tab reordering, unbounded paginated recents, PDFium engine, and Home recent-files search). The frontend has grown to ~5,400 lines across 10 JS modules, and **state management + cross-module synchronization** have crossed the maintainability threshold:

1. **Shared Mutable God-Object (`tab`)**: `src/tabs.js` stores 19 fields spanning 5 distinct domains (immutable document metadata, viewport reading state, TOC async/tree state, search async/match state, and text-layer LRU cache) on a single mutable object mutated in place by 5 modules (`main.js`, `viewport.js`, `toc.js`, `search.js`, `text-layer.js`). No module knows when another mutates a field.
2. **5x Duplicated Transition Choreography**: Every tab lifecycle transition (`handleOpenHomeTab`, `switchToTab`, `handleOpenPath`, Home close, Document close in `src/main.js`) manually orchestrates 7–10 imperative calls (`cancelPageInput` → `toc.captureScroll` → `viewport.captureActiveSnapshot` → `scheduleSave`/`flushPendingSave` → `tabManager.*` → `updateShellMode` → `toc.syncTab` → `search.syncTab` → `viewport.mountTab` → focus & recents refresh). Any new UI feature requires auditing all 5 branches.
3. **Implicit Sync Chains & Latent Concurrency Hazards**:
   - **Spurious persistence on tab switch**: `switchToTab()` relies on `viewport.mountTab()` → `notifyViewState(true)` → `onViewStateChange` to sync the toolbar, which also triggers `scheduleSave(active)` and redundant `toc.syncActivePage()` merely from switching tabs.
   - **Single-slot persistence queue**: `pendingSavePayload` in `src/main.js` holds only one document at a time, requiring manual cancellation checks on close and risking lost saves during rapid multi-tab interactions.
   - **Inconsistent async lifecycle guards**: `search.js` injects `isTabOpen` + checks `getActiveTab()?.documentId === tab.documentId` in 3 callbacks, whereas `loadOutlineForTab` in `src/toc.js` lacks a tab-closed guard after `await getOutline()`.
   - **Fragmented wiring & duplicated banners**: `src/shortcuts.js` requires 21 injected callbacks/predicates; error feedback is duplicated across `#notice-banner` (`main.js`) and `#empty-error` (`empty-state.js`).
4. **Destructive DOM Re-Renders**: `tabs.js` (`tabListEl.textContent = ""`) and `empty-state.js` (`recentListEl.textContent = ""`) tear down and rebuild DOM subtrees and event listeners on routine state transitions (even active-tab changes), requiring ad-hoc `focusTabId` / `preserveScrollLeft` workarounds.

**Goal**: Adopt **Vite + TypeScript + Svelte 5 (Runes)** to establish a single, unidirectional, strictly typed state store and reactive UI chrome while preserving `viewport` and `text-layer` as high-performance imperative TypeScript engines. The migration preserves **100% behavioral and visual parity** with v1 + `CR-001`..`CR-006`, fixes the 4 diagnosed state/sync defects, and introduces automated frontend type, lint, format, and unit-test quality gates.

---

## 2. Locked Architectural Decisions (ADR Summary)

All foundational decisions for `CR-007` are finalized:

| # | Area | Decision | Rationale |
| --- | --- | --- | --- |
| 1 | **Governance & Location** | Specification lives in `docs/frontend-svelte5/` and is indexed as `CR-007 (Proposed)` in [docs/CHANGES.md](../CHANGES.md). Baseline docs (`SPEC.md`, `PHASES.md`) and `AGENTS.md` remain untouched until Phase 5 completion. | Keeps repo contract truthful while migration has not started; Phase 5 closes all governance pointers atomically. |
| 2 | **Package Manager** | **`pnpm`** (`pnpm-lock.yaml`, `beforeDevCommand: "pnpm dev"`, `beforeBuildCommand: "pnpm build"`). | Fast, strict dependency resolution, standard Tauri v2 convention. |
| 3 | **Repository Layout** | Standard Tauri v2 root layout: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html` at repo root; TS/Svelte sources in `src/`; static assets in `public/`; production bundle in `dist/` (`frontendDist: "../dist"`, `devUrl: "http://localhost:1420"`). | Zero nested `--dir` friction; matches official Tauri v2 + Vite templates. |
| 4 | **Tauri v2 IPC & Types** | Official `@tauri-apps/api` + `@tauri-apps/plugin-dialog` with `withGlobalTauri: false` (flipped at Phase 3 cutover) and hand-written strict TypeScript DTOs matching `src-tauri/src/` 1-to-1 behind an injectable `ReaderApi` interface. | Eliminates global `window.__TAURI__` exposure, enables trivial Vitest mocking, requires zero Rust code changes. |
| 5 | **State & Sync Model** | Centralized Svelte 5 Runes store (`app-store.svelte.ts`) using normalized slices + `$derived` selectors, unidirectional `actions.ts`, `DocumentScopeRegistry` (`AbortController` per doc), and per-path `PersistenceQueue`. | Single writer per slice, single tab-activation transition, automatic async cancellation, zero spurious saves. |
| 6 | **Imperative Engine Boundary** | Keep virtualized canvas rendering (`viewport.ts`), text selection/copy (`text-layer.ts`), pointer tab-reorder (`tab-drag.ts`), and desktop shortcuts (`shortcuts.ts`) as imperative TypeScript engines wired via Svelte `$effect` / Actions. | Preserves 60fps canvas pool, `putImageData`, DPR snapping, and DOM `Range` selection without VDOM/template overhead. |
| 7 | **CSS Organization** | Global `src/styles/tokens.css`, `src/styles/base.css`, and `src/styles/viewport-layers.css` (for imperatively created page/canvas/text/search DOM) + component-scoped `<style>` in `.svelte` files. Zero CSS frameworks. | Preserves the exact locked 6-token palette and flat minimalist visual design while eliminating the 1,488-line CSS monolith. |
| 8 | **Migration Strategy** | **6-phase Foundation-first + Vertical Cutover (`Phase 0` → `Phase 5`)**. Strict 100% behavioral parity with v1 + `CR-001`..`CR-006` plus the 4 sync/race bug fixes; zero new user-facing features. | App stays runnable through Vite in Phases 0–2 while new core & engines reach full test coverage; avoids throwaway hybrid-island adapters. |
| 9 | **Frontend Quality Gates** | `svelte-check --tsconfig ./tsconfig.json`, `tsc --noEmit` (strict), `Vitest` (unit tests for Runes store, actions, `DocumentScope`, `PersistenceQueue`, binary IPC decoder, pure helpers), `ESLint` (`eslint-plugin-svelte` + `typescript-eslint`), `Prettier` (`prettier-plugin-svelte`), plus manual `cargo tauri dev` verification. | Mirrors Rust's `fmt` / `clippy` / `test` rigor without heavy browser E2E infrastructure. |

---

## 3. Baseline Traceability Matrix

When `CR-007` transitions from `Proposed` to `Implemented` in **Phase 5**, non-destructive `> [!NOTE]` callouts will be inserted beneath the baseline sections below per [docs/CHANGES.md](../CHANGES.md#authoring-rules-for-future-changes):

| Baseline Document & Section | Original v1 Baseline | Amended Behavior (`CR-007`) | Target Reference |
| --- | --- | --- | --- |
| [SPEC §1 — v1 Non-Goals](../SPEC.md#v1-non-goals-out-of-scope) | Prohibits Node/npm toolchains, bundlers, or frontend frameworks. | Adopts `pnpm` + Vite + TypeScript + Svelte 5 while preserving minimalism, zero CSS framework, and zero Rust backend churn. | [ARCHITECTURE.md §1](ARCHITECTURE.md#1-repository--build-topology) |
| [SPEC §2 — System Architecture](../SPEC.md#2-system-architecture) | Vanilla HTML/CSS/ES modules talking to `window.__TAURI__.core.invoke`. | Svelte 5 Runes UI + imperative TS engines compiled via Vite to `dist/`, communicating through typed `@tauri-apps/api`. | [ARCHITECTURE.md §2–§4](ARCHITECTURE.md#2-typed-ipc-boundary-srclibipc) |
| [SPEC §4 — IPC Contract](../SPEC.md#4-ipc-contract) | Commands invoked via `window.__TAURI__.core.invoke` (`withGlobalTauri: true`). | Same 10 Rust commands & binary wire format, invoked via `@tauri-apps/api/core` (`invoke`) and `@tauri-apps/plugin-dialog` with `withGlobalTauri: false`. | [ARCHITECTURE.md §2](ARCHITECTURE.md#2-typed-ipc-boundary-srclibipc) |
| [SPEC §5 — Frontend Module Structure](../SPEC.md#frontend-module-structure-src) | Flat 10-file JS layout under `src/` + single `styles.css`. | Layered `src/lib/{ipc,domain,state,engines}`, `src/components/`, and `src/styles/` structure. | [ARCHITECTURE.md §5](ARCHITECTURE.md#5-component-tree--css-architecture) |
| [PHASES — Phases 3–6](../PHASES.md#phase-3-minimalist-ui-shell-multi-tab-strip--virtualized-viewport) | Vanilla JS module implementation & manual-only frontend checks. | Replaced by the 6-phase migration roadmap (`Phase 0`–`Phase 5`) with automated `svelte-check`, `tsc`, `eslint`, `prettier`, and `vitest` exit gates. | [PHASES.md](PHASES.md) |
| [AGENTS.md — Non-Negotiable Constraints & Verification](../../AGENTS.md) | Forbids `package.json`, TypeScript, and frameworks; lists Rust-only verification commands. | Updated in Phase 5 to document Vite + TS + Svelte 5 + `pnpm` contract and combined Rust + Frontend verification gates. | [Phase 5](phases/phase-5-cleanup-hardening-and-release.md) |

---

## 4. Document Index & Reading Order

Read these documents in order before executing any migration work:

1. **[ARCHITECTURE.md](ARCHITECTURE.md)** — Complete technical specification: directory topology, `tauri.conf.json` & CSP rules, typed IPC DTOs, Svelte 5 Runes state model, `DocumentScope`, `PersistenceQueue`, imperative engine contracts, component hierarchy, CSS split map, and Vitest/lint configuration.
2. **[PHASES.md](PHASES.md)** — Master 6-phase execution roadmap, dependency rules, complete vanilla-to-Svelte file migration map, and behavioral parity + bug-fix verification matrix.
3. **Self-Contained Phase Execution Guides** *(execute strictly one phase at a time; satisfy every Exit Gate before starting the next)*:
   - **[Phase 0: Toolchain, Vite Bridge & Quality Gates](phases/phase-0-toolchain-foundation.md)**
   - **[Phase 1: Typed IPC Layer & Svelte 5 Runes State Architecture](phases/phase-1-ipc-and-runes-state.md)**
   - **[Phase 2: Imperative TypeScript Engines (`viewport`, `text-layer`, `tab-drag`, `shortcuts`)](phases/phase-2-imperative-engines.md)**
   - **[Phase 3: Svelte 5 Cutover — Shell, Home Screen, Toolbar & Reading Viewport](phases/phase-3-shell-home-and-reading-viewport.md)**
   - **[Phase 4: TOC Outline Drawer, Search Bar & Full Keyboard Parity](phases/phase-4-toc-search-and-shortcuts.md)**
   - **[Phase 5: Legacy Cleanup, Hardening, Doc Closure & Release Verification](phases/phase-5-cleanup-hardening-and-release.md)**
