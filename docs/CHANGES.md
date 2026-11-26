# Reader — Change Requests & Post-v1 Upgrades

`docs/SPEC.md` and `docs/PHASES.md` represent the **frozen v1 baseline** of `reader`. Original wording in those baseline files is never rewritten or deleted; instead, every post-v1 behavioral, architectural, or UX change is documented here as a numbered **Change Request (`CR-NNN`)** under `docs/changes/`, and a non-destructive `> [!NOTE]` pointer is inserted directly beneath each affected section in the baseline documents.

---

## Change Index

| ID | Title | Status | Affected Baseline Sections | Specification |
| --- | --- | --- | --- | --- |
| `CR-001` | Open singleton Home tab from `tab-add-btn` (`+`) | Implemented | [SPEC §1](SPEC.md#v1-goals), [SPEC §5 Chrome](SPEC.md#aesthetic-direction), [SPEC §5 Layout](SPEC.md#core-layout-wireframe), [SPEC §5 Shortcuts](SPEC.md#keyboard-shortcuts), [PHASES Phase 3](PHASES.md#phase-3-minimalist-ui-shell-multi-tab-strip--virtualized-viewport) | [001-tab-add-home-screen.md](changes/001-tab-add-home-screen.md) |
| `CR-002` | Integrated borderless titlebar & window controls | Implemented | [SPEC §5 Chrome](SPEC.md#aesthetic-direction), [SPEC §5 Layout](SPEC.md#core-layout-wireframe), [PHASES Phase 3](PHASES.md#phase-3-minimalist-ui-shell-multi-tab-strip--virtualized-viewport) | [002-integrated-titlebar-window-controls.md](changes/002-integrated-titlebar-window-controls.md) |
| `CR-003` | Tab-strip drag-and-drop & keyboard reordering | Implemented | [SPEC §5 Chrome](SPEC.md#aesthetic-direction), [SPEC §5 Shortcuts](SPEC.md#keyboard-shortcuts), [PHASES Phase 3](PHASES.md#phase-3-minimalist-ui-shell-multi-tab-strip--virtualized-viewport) | [003-tab-strip-reorder.md](changes/003-tab-strip-reorder.md) |
| `CR-004` | Unbounded recent files persistence & paginated Home recent section | Implemented | [SPEC §4 Persistence](SPEC.md#persistence-schema-statejson), [SPEC §5 Layout](SPEC.md#core-layout-wireframe), [PHASES Phase 2](PHASES.md#phase-2-ipc-commands-persistence--app-lifecycle), [PHASES Phase 3](PHASES.md#phase-3-minimalist-ui-shell-multi-tab-strip--virtualized-viewport) | [004-paginated-unbounded-recents.md](changes/004-paginated-unbounded-recents.md) |
| `CR-005` | Replace MuPDF with PDFium (`pdfium-render v0.9.6`) | Implemented | [SPEC §2 Engine](SPEC.md#target-platforms--mupdf-engine), [SPEC §3 Backend](SPEC.md#concurrency--render-cancellation-workerrs), [SPEC §3 Coords](SPEC.md#normalized-coordinate-system), [PHASES Phase 0](PHASES.md#phase-0-foundation-tooling--mupdf-build-setup), [PHASES Phase 1](PHASES.md#phase-1-rust-core--documentbackend-pdfbackend--worker-thread), [PHASES Phase 6](PHASES.md#phase-6-polish-hardening--release-verification) | [005-pdfium-render-engine.md](changes/005-pdfium-render-engine.md) |
| `CR-006` | Home Recent files search in `.recent-header` | Implemented | [SPEC §5 Layout](SPEC.md#core-layout-wireframe), [SPEC §5 Shortcuts](SPEC.md#keyboard-shortcuts), [PHASES Phase 3](PHASES.md#phase-3-minimalist-ui-shell-multi-tab-strip--virtualized-viewport) | [006-home-recent-search.md](changes/006-home-recent-search.md) |
| `CR-007` | Migrate frontend to Vite + TypeScript + Svelte 5 (Runes state architecture) | Implemented | [SPEC §1 Non-Goals](SPEC.md#v1-non-goals-out-of-scope), [SPEC §2 Architecture](SPEC.md#2-system-architecture), [SPEC §4 IPC](SPEC.md#4-ipc-contract), [SPEC §5 Modules](SPEC.md#frontend-module-structure-src), [PHASES Phase 3–6](PHASES.md#phase-3-minimalist-ui-shell-multi-tab-strip--virtualized-viewport) | [frontend-svelte5/README.md](frontend-svelte5/README.md) |
| `CR-008` | Recent files first-page cover previews & disk cache | Implemented | [SPEC §4 IPC](SPEC.md#4-ipc-contract), [SPEC §5 Layout](SPEC.md#core-layout-wireframe), [PHASES Phase 3](PHASES.md#phase-3-minimalist-ui-shell-multi-tab-strip--virtualized-viewport) | [008-recent-cover-previews.md](changes/008-recent-cover-previews.md) |
| `CR-009` | Clickable PDF links & per-tab navigation history | Implemented | [SPEC §1 Non-Goals](SPEC.md#v1-non-goals-out-of-scope), [SPEC §3 Backend](SPEC.md#lightweight-documentbackend-trait-boundary), [SPEC §4 IPC](SPEC.md#4-ipc-contract), [SPEC §5 Chrome/Shortcuts](SPEC.md#aesthetic-direction), [PHASES Phase 1, 2, 4, 5](PHASES.md) | [009-clickable-pdf-links.md](changes/009-clickable-pdf-links.md) |

---

## Authoring Rules for Future Changes

1. **Never edit or remove finalized baseline prose** in [docs/SPEC.md](SPEC.md) or [docs/PHASES.md](PHASES.md).
2. **Create a new file** `docs/changes/NNN-<short-slug>.md` using the next sequential number (`002`, `003`, ...).
3. **Include a Baseline Traceability Matrix** at the top of the CR mapping every superseded or extended baseline section/anchor to the corresponding section in the new CR.
4. **Insert one-line `> [!NOTE]` callouts** immediately below each affected paragraph or list item in `docs/SPEC.md` and `docs/PHASES.md`, linking directly to the matching section anchor in `docs/changes/NNN-<short-slug>.md`.
5. **Register the new CR** in the **Change Index** table above and update its status (`Proposed` → `Implemented` / `Superseded`).
