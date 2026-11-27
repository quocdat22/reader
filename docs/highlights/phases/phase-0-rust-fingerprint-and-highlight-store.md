# Phase 0: Document Content Fingerprinting & Rust `HighlightStore`

> **Read First**: [README.md](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md) · [PHASES.md](../PHASES.md) · `.agents/skills/rust-best-practices/SKILL.md`

---

## 1. Goal & Preconditions

**Goal**: Build and thoroughly unit-test the standalone Rust persistence foundation for `CR-010`:
1. A zero-dependency, pure-Rust **FIPS 180-4 `SHA-256`** hasher and fast deterministic document content fingerprinter (`compute_document_fingerprint`).
2. `src-tauri/src/highlights.rs` implementing `HighlightColor`, `HighlightSegment`, `HighlightRecord`, `DocumentHighlightsFile`, strict input validation/sanitization, and the thread-safe atomic per-document `HighlightStore` (`<app_data_dir>/highlights/<fingerprint>.json`).
3. `ReaderError::InvalidHighlight` wired cleanly into `src-tauri/src/error.rs`.

**Preconditions**:
- Clean repository passing `cargo fmt --check`, `cargo clippy --all-targets --all-features --locked -- -D warnings`, and `cargo test` inside `src-tauri/`.
- Read `.agents/skills/rust-best-practices/SKILL.md` (and error/borrowing/testing reference chapters) before editing any Rust file.

---

## 2. Scope Boundaries

### In Scope
- `src-tauri/src/error.rs`: add `ReaderError::InvalidHighlight(String)` mapped to code `"invalid_highlight"`.
- `src-tauri/src/highlights.rs` (**NEW**): pure-Rust `SHA-256`, `compute_document_fingerprint()`, validation helpers, DTOs, and atomic `HighlightStore`.
- `src-tauri/src/lib.rs`: export `pub mod highlights;`.
- Comprehensive Rust unit tests in `src-tauri/src/highlights.rs` and `src-tauri/src/error.rs`.

### Out of Scope (Do Not Touch in Phase 0)
- No `AppState`, `DocumentWorker`, or Tauri IPC command changes yet (Phase 1).
- No changes to `src-tauri/Cargo.toml` (zero new crates).
- No frontend edits (`src/` untouched).
- No changes to `state.json` schema (`version: 1`) or `DocumentBackend`.

---

## 3. Files to Create / Modify

| Action | Path | Responsibility |
| --- | --- | --- |
| **NEW** | `src-tauri/src/highlights.rs` | Pure-Rust `SHA-256`, `compute_document_fingerprint`, highlight DTOs, validation & defensive caps, atomic `HighlightStore` (`get`, `create`, `update_color`, `delete`). |
| **MODIFY** | `src-tauri/src/error.rs` | Add `ReaderError::InvalidHighlight(String)` (`"invalid_highlight"`) and extend unit tests. |
| **MODIFY** | `src-tauri/src/lib.rs` | Declare `pub mod highlights;`. |

---

## 4. Detailed Technical Tasks

### 4.1 Error Variant (`src-tauri/src/error.rs`)
1. Add `ReaderError::InvalidHighlight(String)` with `#[error("invalid highlight data: {0}")]`.
2. Map `Self::InvalidHighlight(_) => "invalid_highlight"` inside `ReaderError::code()`.
3. Update `code_maps_every_variant_to_expected_snake_case_identifier` unit test to cover `InvalidHighlight`.

### 4.2 Pure-Rust `SHA-256` & Content Fingerprinting (`src-tauri/src/highlights.rs`)
1. Implement an internal `Sha256` struct (`new`, `update(&mut self, bytes: &[u8])`, `finalize(self) -> [u8; 32]`) following FIPS 180-4 verbatim (~85 lines, zero `unsafe`, zero `.unwrap()`/`.expect()`/`panic!`, clean under `clippy::pedantic`).
2. Implement `pub fn compute_document_fingerprint(path: &Path) -> Result<String, ReaderError>`:
   - Open `path` with `File::open(path)?` and verify `metadata.is_file()` (returning `ReaderError::UnsupportedFormat` for non-regular files).
   - Read exact `file_len = metadata.len()`.
   - Hash domain tag `b"reader-fp-v1:"`, then `file_len.to_le_bytes()`.
   - If `file_len <= 196_608` (`3 * 65_536`), read and feed the entire file in bounded buffer chunks.
   - If `file_len > 196_608`, seek and `read_exact` three `65_536`-byte windows:
     - Head: offset `0`
     - Middle: offset `(file_len / 2) - 32_768`
     - Tail: offset `file_len - 65_536`
   - Encode the 32-byte digest into a lowercase 64-character hex `String`.
3. Implement `#[must_use] pub fn is_valid_fingerprint(fingerprint: &str) -> bool`:
   - Returns `true` iff `fingerprint.len() == 64` and every byte is `b'0'..=b'9' | b'a'..=b'f'`.

### 4.3 Highlight DTOs & Validation (`src-tauri/src/highlights.rs`)
1. Define all public documented (`///`) types matching [ARCHITECTURE.md §1.3](../ARCHITECTURE.md#13-rust-domain-types--validation-invariants):
   - `HIGHLIGHTS_SCHEMA_VERSION = 1`
   - `MAX_HIGHLIGHTS_PER_DOCUMENT = 5_000`
   - `MAX_SEGMENTS_PER_HIGHLIGHT = 64`
   - `MAX_RECTS_PER_SEGMENT = 512`
   - `MAX_QUOTE_BYTES = 32_768`
   - `MAX_HIGHLIGHT_ID_BYTES = 128`
   - `HighlightColor` (`Yellow`, `Green`, `Pink`, `#[serde(rename_all = "snake_case")]`, `Copy`)
   - `HighlightSegment { page_index: usize, rects: Vec<NormalizedRect> }`
   - `HighlightRecord { id, color, segments, quote, created_at_unix, updated_at_unix }`
   - `DocumentHighlightsFile { version, fingerprint, last_known_path, highlights }`
   - `CreateHighlightInput { fingerprint, last_known_path, id, color, segments, quote }`
2. Implement strict validation/sanitization:
   - Reject invalid fingerprints (path-traversal defense!).
   - Reject empty `id`, `id.len() > MAX_HIGHLIGHT_ID_BYTES`, or any byte outside `[A-Za-z0-9_-]`.
   - Reject empty `segments` or `segments.len() > MAX_SEGMENTS_PER_HIGHLIGHT`.
   - For each segment: reject duplicate `page_index` (or merge & sort ascending by `page_index`), validate `1..=MAX_RECTS_PER_SEGMENT` rects, reject non-finite coordinates, clamp `x`/`y`/`width`/`height` into `[0.0, 1.0]` with `width <= 1.0 - x` and `height <= 1.0 - y`, reject empty rects (`rect.is_empty()`).
   - Truncate `quote` cleanly on a valid UTF-8 char boundary if `quote.len() > MAX_QUOTE_BYTES` (using `floor_char_boundary` or safe char-boundary walk).

### 4.4 Thread-Safe Atomic `HighlightStore` (`src-tauri/src/highlights.rs`)
1. Define `pub struct HighlightStore { dir: PathBuf, lock: Mutex<()> }` (must be `Send + Sync + 'static`).
2. Implement methods:
   - `pub fn new(dir: PathBuf) -> Self`
   - `pub fn get(&self, fingerprint: &str) -> Result<Vec<HighlightRecord>, ReaderError>`:
     - Validate fingerprint.
     - Under `self.lock`, read `<dir>/<fingerprint>.json`.
     - Missing file → `Ok(Vec::new())`.
     - Malformed JSON, mismatched `fingerprint`, or unsupported `version` → log warning to `stderr` and return `Ok(Vec::new())` (never crash!).
     - Filter out any corrupt/invalid records gracefully on load.
   - `pub fn create(&self, input: CreateHighlightInput) -> Result<HighlightRecord, ReaderError>`:
     - Validate all fields before acquiring disk lock.
     - Under `self.lock`, load existing `DocumentHighlightsFile` (or initialize fresh v1 file).
     - Reject duplicate `id` or `highlights.len() >= MAX_HIGHLIGHTS_PER_DOCUMENT` with `ReaderError::InvalidHighlight`.
     - Stamp `created_at_unix` and `updated_at_unix` from current Unix seconds.
     - Update `last_known_path` when supplied, append record, write atomically (`<fp>.json.tmp` → write pretty JSON → `sync_all()` → close handle → `fs::rename`, clean `.tmp` on error), and return the persisted `HighlightRecord`.
   - `pub fn update_color(&self, fingerprint: &str, id: &str, color: HighlightColor) -> Result<HighlightRecord, ReaderError>`:
     - Validate fingerprint & `id`.
     - Under `self.lock`, load file, find record by `id` (else `ReaderError::InvalidHighlight("highlight not found")`), update `color` and `updated_at_unix`, save atomically, and return updated record.
   - `pub fn delete(&self, fingerprint: &str, id: &str) -> Result<bool, ReaderError>`:
     - Validate fingerprint & `id`.
     - Under `self.lock`, load file. If `id` not present, return `Ok(false)` (idempotent).
     - Remove record. If `highlights` is now empty, delete `<dir>/<fingerprint>.json` (ignoring `NotFound`); otherwise save atomically. Return `Ok(true)`.

---

## 5. Verification Plan

### Unit Tests (Inside `src-tauri/src/highlights.rs` & `error.rs`)
Write deterministic, fixture-independent unit tests covering:
1. **NIST FIPS 180-4 SHA-256 test vectors**: `""`, `"abc"`, `"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"`, and 1,000,000 `'a'` bytes.
2. **Content fingerprinting**:
   - Identical bytes moved/renamed to a different filename/directory produce the exact same fingerprint.
   - Small file (`<= 192 KiB`) modification at any byte changes fingerprint.
   - Large synthetic file (`> 192 KiB`, e.g., `300 KiB`) changes fingerprint when modified in head, middle, tail, or file length.
   - Non-existent file returns `ReaderError::Io`; directory returns `ReaderError::UnsupportedFormat`.
3. **Validation & security**:
   - Rejects path-traversal fingerprints (`"../evil"`, uppercase hex, wrong length, NUL bytes).
   - Rejects invalid highlight IDs, empty segments, empty rects, `NaN`/`Infinity` coordinates, duplicate IDs, and exceeding `MAX_HIGHLIGHTS_PER_DOCUMENT` / `MAX_SEGMENTS_PER_HIGHLIGHT`.
   - Truncates oversized multi-byte UTF-8 `quote` safely on a char boundary without panicking.
4. **Atomic persistence lifecycle**:
   - `create` → `get` → `update_color` → `delete` round-trip leaves zero stray `.tmp` files.
   - Deleting the last highlight deletes `<fingerprint>.json` from disk.
   - Deleting a non-existent highlight returns `Ok(false)` cleanly.
   - Corrupt JSON or unknown schema version (`version: 999`) returns `Ok(Vec::new())` without panicking.
   - `HighlightStore` satisfies `Send + Sync + 'static`.

### Automated Commands (Run inside `src-tauri/`)
```powershell
cargo fmt --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test
```

---

## 6. Exit Gate Checklist

- [ ] `src-tauri/src/highlights.rs` implements pure-Rust `SHA-256`, `compute_document_fingerprint`, DTOs, validation caps, and atomic `HighlightStore` with zero `.unwrap()`/`.expect()`/`panic!` in production code and zero `unsafe`.
- [ ] `ReaderError::InvalidHighlight` is added and tested in `src-tauri/src/error.rs`.
- [ ] Zero new dependencies added to `src-tauri/Cargo.toml`.
- [ ] All unit tests (NIST SHA-256 vectors, small/large fingerprinting, move/rename stability, security validation, atomic CRUD, empty-file deletion, corrupt recovery) pass.
- [ ] `cargo fmt --check`, `cargo clippy --all-targets --all-features --locked -- -D warnings`, and `cargo test` pass with zero warnings.
- [ ] `git status --short` confirms `tests/fixtures/` remains untracked/ignored and no frontend files were modified.
