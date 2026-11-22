# Reader — Change Requests & Post-v1 Upgrades

`docs/SPEC.md` and `docs/PHASES.md` represent the **frozen v1 baseline** of `reader`. Original wording in those baseline files is never rewritten or deleted; instead, every post-v1 behavioral, architectural, or UX change is documented here as a numbered **Change Request (`CR-NNN`)** under `docs/changes/`, and a non-destructive `> [!NOTE]` pointer is inserted directly beneath each affected section in the baseline documents.

---

## Change Index

| ID | Title | Status | Affected Baseline Sections | Specification |
| --- | --- | --- | --- | --- |
| `CR-001` | Open singleton Home tab from `tab-add-btn` (`+`) | Implemented | [SPEC §1](SPEC.md#v1-goals), [SPEC §5 Chrome](SPEC.md#aesthetic-direction), [SPEC §5 Layout](SPEC.md#core-layout-wireframe), [SPEC §5 Shortcuts](SPEC.md#keyboard-shortcuts), [PHASES Phase 3](PHASES.md#phase-3-minimalist-ui-shell-multi-tab-strip--virtualized-viewport) | [001-tab-add-home-screen.md](changes/001-tab-add-home-screen.md) |

---

## Authoring Rules for Future Changes

1. **Never edit or remove finalized baseline prose** in [docs/SPEC.md](SPEC.md) or [docs/PHASES.md](PHASES.md).
2. **Create a new file** `docs/changes/NNN-<short-slug>.md` using the next sequential number (`002`, `003`, ...).
3. **Include a Baseline Traceability Matrix** at the top of the CR mapping every superseded or extended baseline section/anchor to the corresponding section in the new CR.
4. **Insert one-line `> [!NOTE]` callouts** immediately below each affected paragraph or list item in `docs/SPEC.md` and `docs/PHASES.md`, linking directly to the matching section anchor in `docs/changes/NNN-<short-slug>.md`.
5. **Register the new CR** in the **Change Index** table above and update its status (`Proposed` → `Implemented` / `Superseded`).
