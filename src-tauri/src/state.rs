//! Application state, CLI startup path handling, and atomic JSON persistence (`state.json`).

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::ReaderError;
use crate::worker::{DocumentWorker, canonicalize_document_path};

/// Current schema version for `<app_data_dir>/state.json`.
pub const STATE_SCHEMA_VERSION: u32 = 1;

/// Maximum number of entries retained in [`PersistedState::recent_files`].
pub const MAX_RECENT_FILES: usize = 10;

/// Viewport zoom mode persisted per document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ZoomMode {
    /// Scale page width to match the reading viewport.
    #[default]
    FitWidth,
    /// Scale the entire page to fit within the reading viewport.
    FitPage,
    /// Use an explicit user-defined zoom multiplier.
    Custom,
}

/// Last saved reading position and zoom setting for a single document.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ReadingPosition {
    /// Zero-based page index last viewed.
    pub page_index: usize,
    /// Active zoom mode.
    pub zoom_mode: ZoomMode,
    /// Zoom scale multiplier (e.g., `1.0` for 100%).
    pub zoom_scale: f32,
}

/// Summary metadata for a recently opened document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecentFile {
    /// Canonical filesystem path string of the document.
    pub path: String,
    /// Display title (embedded title or file name stem fallback).
    pub title: String,
    /// Unix timestamp (seconds) when the document was last opened.
    pub last_opened_unix: u64,
    /// Last viewed zero-based page index.
    pub last_page: usize,
    /// Page count observed when the document was last opened.
    pub page_count: usize,
}

/// On-disk persistence schema stored at `<app_data_dir>/state.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PersistedState {
    /// Persistence schema version (currently [`STATE_SCHEMA_VERSION`]).
    pub version: u32,
    /// Most recently opened files (most recent first, deduplicated, capped at [`MAX_RECENT_FILES`]).
    #[serde(default)]
    pub recent_files: Vec<RecentFile>,
    /// Per-file reading positions keyed by canonical path string.
    #[serde(default)]
    pub positions: HashMap<String, ReadingPosition>,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            version: STATE_SCHEMA_VERSION,
            recent_files: Vec::new(),
            positions: HashMap::new(),
        }
    }
}

impl PersistedState {
    /// Loads [`PersistedState`] from `path`, falling back cleanly to [`Self::default()`]
    /// if the file is missing, unreadable, malformed, or uses an unsupported schema version.
    #[must_use]
    pub fn load_or_default(path: &Path) -> Self {
        let raw = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Self::default(),
            Err(err) => {
                eprintln!(
                    "warning: failed to read persisted state at {}: {err}; starting with defaults",
                    path.display()
                );
                return Self::default();
            }
        };

        let mut loaded: Self = match serde_json::from_slice(&raw) {
            Ok(state) => state,
            Err(err) => {
                eprintln!(
                    "warning: malformed persisted state at {}: {err}; starting with defaults",
                    path.display()
                );
                return Self::default();
            }
        };

        if loaded.version != STATE_SCHEMA_VERSION {
            eprintln!(
                "warning: unsupported persisted state version {} at {} (expected {STATE_SCHEMA_VERSION}); starting with defaults",
                loaded.version,
                path.display()
            );
            return Self::default();
        }

        loaded.normalize_recents();
        loaded
    }

    /// Persists this state atomically to `path` (`<filename>.tmp` -> write -> `sync_all` -> rename).
    ///
    /// # Errors
    /// - Returns [`ReaderError::Internal`] if serialization fails.
    /// - Returns [`ReaderError::Io`] if directory creation, writing, flushing, or renaming fails.
    pub fn save_atomic(&self, path: &Path) -> Result<(), ReaderError> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent)?;
        }

        let tmp_path = temp_state_path(path);
        let payload = serde_json::to_vec_pretty(self).map_err(|err| {
            ReaderError::Internal(format!("failed to serialize persisted state: {err}"))
        })?;

        // Close the temporary file handle before renaming so Windows does not reject rename.
        let write_result = (|| -> std::io::Result<()> {
            let mut file = File::create(&tmp_path)?;
            file.write_all(&payload)?;
            file.sync_all()?;
            Ok(())
        })();

        if let Err(err) = write_result {
            let _ = fs::remove_file(&tmp_path);
            return Err(ReaderError::Io(err));
        }

        if let Err(err) = fs::rename(&tmp_path, path) {
            let _ = fs::remove_file(&tmp_path);
            return Err(ReaderError::Io(err));
        }

        Ok(())
    }

    /// Records a document open event at the front of `recent_files` (deduplicated and capped
    /// at [`MAX_RECENT_FILES`]) and returns any saved [`ReadingPosition`] clamped to `page_count`.
    pub fn record_open(
        &mut self,
        canonical_path: &str,
        title: &str,
        page_count: usize,
        opened_unix: u64,
    ) -> Option<ReadingPosition> {
        let saved_position = self.find_position(canonical_path).map(|mut position| {
            if page_count > 0 && position.page_index >= page_count {
                position.page_index = page_count - 1;
            } else if page_count == 0 {
                position.page_index = 0;
            }
            position
        });

        let last_page = saved_position.map_or(0, |position| position.page_index);

        self.recent_files
            .retain(|entry| !paths_equal(&entry.path, canonical_path));
        self.recent_files.insert(
            0,
            RecentFile {
                path: canonical_path.to_owned(),
                title: title.to_owned(),
                last_opened_unix: opened_unix,
                last_page,
                page_count,
            },
        );
        self.recent_files.truncate(MAX_RECENT_FILES);

        saved_position
    }

    /// Stores a document's reading position and synchronizes `last_page` on any matching
    /// recent-files entry.
    pub fn save_reading_position(&mut self, key: &str, position: ReadingPosition) {
        if let Some(existing_key) = self.find_position_key(key)
            && existing_key != key
        {
            self.positions.remove(&existing_key);
        }
        self.positions.insert(key.to_owned(), position);

        if let Some(recent) = self
            .recent_files
            .iter_mut()
            .find(|entry| paths_equal(&entry.path, key))
        {
            recent.last_page = position.page_index;
        }
    }

    /// Removes entries matching `path` (or `canonical_alt` if provided) from `recent_files`.
    /// Returns `true` if at least one entry was removed.
    pub fn remove_recent(&mut self, path: &str, canonical_alt: Option<&str>) -> bool {
        let before = self.recent_files.len();
        self.recent_files.retain(|entry| {
            let matches_raw = paths_equal(&entry.path, path);
            let matches_canonical = canonical_alt.is_some_and(|alt| paths_equal(&entry.path, alt));
            !(matches_raw || matches_canonical)
        });
        self.recent_files.len() != before
    }

    fn find_position(&self, key: &str) -> Option<ReadingPosition> {
        if let Some(&position) = self.positions.get(key) {
            return Some(position);
        }

        #[cfg(windows)]
        {
            self.positions
                .iter()
                .find(|(stored_key, _)| paths_equal(stored_key, key))
                .map(|(_, &position)| position)
        }

        #[cfg(not(windows))]
        {
            None
        }
    }

    fn find_position_key(&self, key: &str) -> Option<String> {
        if self.positions.contains_key(key) {
            return Some(key.to_owned());
        }

        #[cfg(windows)]
        {
            self.positions
                .keys()
                .find(|stored_key| paths_equal(stored_key, key))
                .cloned()
        }

        #[cfg(not(windows))]
        {
            None
        }
    }

    fn normalize_recents(&mut self) {
        let mut deduped: Vec<RecentFile> = Vec::with_capacity(self.recent_files.len());
        for entry in self.recent_files.drain(..) {
            if !deduped
                .iter()
                .any(|existing| paths_equal(&existing.path, &entry.path))
            {
                deduped.push(entry);
            }
            if deduped.len() == MAX_RECENT_FILES {
                break;
            }
        }
        self.recent_files = deduped;
    }
}

/// Shared Tauri application state managed across all IPC commands.
pub struct AppState {
    worker: DocumentWorker,
    state_path: PathBuf,
    persisted: Mutex<PersistedState>,
    initial_file: Mutex<Option<PathBuf>>,
}

impl AppState {
    /// Initializes [`AppState`] by spawning the dedicated [`DocumentWorker`] and loading
    /// persisted state from `state_path` (falling back to empty defaults on missing/corrupt data).
    ///
    /// # Errors
    /// Returns [`ReaderError::Internal`] if the background `doc-worker` thread cannot be spawned.
    pub fn new(
        resource_dir: Option<PathBuf>,
        state_path: PathBuf,
        initial_file: Option<PathBuf>,
    ) -> Result<Self, ReaderError> {
        let worker = DocumentWorker::spawn(resource_dir)?;
        let persisted = PersistedState::load_or_default(&state_path);

        Ok(Self {
            worker,
            state_path,
            persisted: Mutex::new(persisted),
            initial_file: Mutex::new(initial_file),
        })
    }

    /// Returns a shared reference to the dedicated [`DocumentWorker`].
    #[must_use]
    pub fn worker(&self) -> &DocumentWorker {
        &self.worker
    }

    /// Consumes and returns the startup CLI / OS "Open With" file path once.
    #[must_use]
    pub fn take_initial_file(&self) -> Option<String> {
        let path = self
            .initial_file
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()?;
        Some(path.to_string_lossy().into_owned())
    }

    /// Returns a cloned snapshot of the current [`PersistedState`].
    #[must_use]
    pub fn persisted_snapshot(&self) -> PersistedState {
        self.persisted
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Updates `recent_files`, resolves any clamped saved reading position for `canonical_path`,
    /// and attempts to persist `state.json` atomically.
    pub fn record_document_open(
        &self,
        canonical_path: &Path,
        metadata_title: Option<&str>,
        page_count: usize,
    ) -> (Option<ReadingPosition>, Result<(), ReaderError>) {
        let canonical_str = canonical_path.to_string_lossy();
        let title = display_title_for_document(canonical_path, metadata_title);
        let opened_unix = now_unix_secs();

        let mut persisted = self
            .persisted
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let saved_position = persisted.record_open(&canonical_str, &title, page_count, opened_unix);
        let save_result = persisted.save_atomic(&self.state_path);
        (saved_position, save_result)
    }

    /// Persists a document's latest reading position and zoom settings atomically.
    ///
    /// # Errors
    /// Returns [`ReaderError::Io`] or [`ReaderError::Internal`] if atomic persistence fails.
    pub fn save_reading_state(
        &self,
        path: &str,
        position: ReadingPosition,
    ) -> Result<(), ReaderError> {
        let key = canonicalize_document_path(Path::new(path))
            .map_or_else(|_| path.to_owned(), |p| p.to_string_lossy().into_owned());

        let mut persisted = self
            .persisted
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        persisted.save_reading_position(&key, position);
        persisted.save_atomic(&self.state_path)
    }

    /// Removes `path` from the recent files list, persists atomically, and returns the updated state.
    ///
    /// # Errors
    /// Returns [`ReaderError::Io`] or [`ReaderError::Internal`] if atomic persistence fails.
    pub fn remove_recent_file(&self, path: &str) -> Result<PersistedState, ReaderError> {
        let canonical_alt = canonicalize_document_path(Path::new(path))
            .ok()
            .map(|p| p.to_string_lossy().into_owned());

        let mut persisted = self
            .persisted
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        persisted.remove_recent(path, canonical_alt.as_deref());
        persisted.save_atomic(&self.state_path)?;
        Ok(persisted.clone())
    }
}

/// Parses an optional startup document path from process command-line arguments.
///
/// Skips `argv[0]` and leading `-*` flags (respecting `--` as end-of-options),
/// returning the first non-empty positional path. Existing files are canonicalized;
/// non-existent paths are preserved as-is so the frontend can display an actionable error.
#[must_use]
pub fn parse_initial_file_arg<I, S>(args: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut after_double_dash = false;

    for raw in args.into_iter().skip(1) {
        let os_arg: OsString = raw.into();
        if os_arg.is_empty() {
            continue;
        }

        if !after_double_dash {
            if os_arg == "--" {
                after_double_dash = true;
                continue;
            }
            if os_arg.to_str().is_some_and(|text| text.starts_with('-')) {
                continue;
            }
        }

        let path = PathBuf::from(os_arg);
        return Some(canonicalize_document_path(&path).unwrap_or(path));
    }

    None
}

fn temp_state_path(path: &Path) -> PathBuf {
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    PathBuf::from(tmp)
}

fn display_title_for_document(canonical_path: &Path, metadata_title: Option<&str>) -> String {
    if let Some(title) = metadata_title.map(str::trim).filter(|t| !t.is_empty()) {
        return title.to_owned();
    }

    canonical_path
        .file_stem()
        .or_else(|| canonical_path.file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Untitled".to_owned())
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

fn paths_equal(left: &str, right: &str) -> bool {
    #[cfg(windows)]
    {
        left.eq_ignore_ascii_case(right)
    }

    #[cfg(not(windows))]
    {
        left == right
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    struct TempDirGuard {
        path: PathBuf,
    }

    impl TempDirGuard {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let id = COUNTER.fetch_add(1, Ordering::Relaxed);
            let pid = std::process::id();
            let path = std::env::temp_dir().join(format!("reader-state-test-{label}-{pid}-{id}"));
            fs::create_dir_all(&path).expect("failed to create temp test dir");
            Self { path }
        }

        fn state_file(&self) -> PathBuf {
            self.path.join("nested").join("state.json")
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn save_atomic_and_load_round_trips_persisted_state() {
        let dir = TempDirGuard::new("roundtrip");
        let state_path = dir.state_file();

        let mut original = PersistedState::default();
        original.record_open("/docs/a.pdf", "Doc A", 120, 1_730_000_000);
        original.save_reading_position(
            "/docs/a.pdf",
            ReadingPosition {
                page_index: 12,
                zoom_mode: ZoomMode::FitWidth,
                zoom_scale: 1.0,
            },
        );

        original
            .save_atomic(&state_path)
            .expect("atomic save should succeed");
        assert!(
            !temp_state_path(&state_path).exists(),
            "temporary file should be renamed away"
        );

        let loaded = PersistedState::load_or_default(&state_path);
        assert_eq!(loaded, original);
    }

    #[test]
    fn save_atomic_overwrites_existing_state_file_cleanly() {
        let dir = TempDirGuard::new("overwrite");
        let state_path = dir.state_file();

        let mut first = PersistedState::default();
        first.record_open("/docs/first.pdf", "First", 10, 100);
        first.save_atomic(&state_path).expect("first save");

        let mut second = PersistedState::default();
        second.record_open("/docs/second.pdf", "Second", 20, 200);
        second.save_atomic(&state_path).expect("second save");

        let loaded = PersistedState::load_or_default(&state_path);
        assert_eq!(loaded, second);
    }

    #[test]
    fn load_or_default_returns_empty_state_when_file_missing() {
        let dir = TempDirGuard::new("missing");
        let state_path = dir.state_file();

        let loaded = PersistedState::load_or_default(&state_path);

        assert_eq!(loaded, PersistedState::default());
        assert_eq!(loaded.version, STATE_SCHEMA_VERSION);
    }

    #[test]
    fn load_or_default_recovers_cleanly_from_corrupt_json() {
        let dir = TempDirGuard::new("corrupt");
        let state_path = dir.path.join("state.json");
        fs::write(&state_path, b"{ not valid json !!!").expect("write corrupt json");

        let loaded = PersistedState::load_or_default(&state_path);

        assert_eq!(loaded, PersistedState::default());
    }

    #[test]
    fn load_or_default_recovers_cleanly_from_unknown_schema_version() {
        let dir = TempDirGuard::new("bad-version");
        let state_path = dir.path.join("state.json");
        fs::write(
            &state_path,
            br#"{"version": 999, "recent_files": [], "positions": {}}"#,
        )
        .expect("write unsupported version json");

        let loaded = PersistedState::load_or_default(&state_path);

        assert_eq!(loaded, PersistedState::default());
    }

    #[test]
    fn record_open_deduplicates_canonical_path_and_moves_to_front() {
        let mut state = PersistedState::default();
        state.record_open("/docs/a.pdf", "A", 10, 100);
        state.record_open("/docs/b.pdf", "B", 20, 200);
        state.record_open("/docs/a.pdf", "A Updated", 15, 300);

        assert_eq!(state.recent_files.len(), 2);
        assert_eq!(state.recent_files[0].path, "/docs/a.pdf");
        assert_eq!(state.recent_files[0].title, "A Updated");
        assert_eq!(state.recent_files[0].page_count, 15);
        assert_eq!(state.recent_files[0].last_opened_unix, 300);
        assert_eq!(state.recent_files[1].path, "/docs/b.pdf");
    }

    #[test]
    fn record_open_caps_recent_files_at_ten_entries() {
        let mut state = PersistedState::default();

        for i in 0..15_usize {
            let path = format!("/docs/file_{i}.pdf");
            let title = format!("File {i}");
            state.record_open(&path, &title, 50, i as u64);
        }

        assert_eq!(state.recent_files.len(), MAX_RECENT_FILES);
        assert_eq!(state.recent_files[0].path, "/docs/file_14.pdf");
        assert_eq!(
            state.recent_files[MAX_RECENT_FILES - 1].path,
            "/docs/file_5.pdf"
        );
    }

    #[test]
    fn record_open_clamps_saved_page_index_when_document_shrank() {
        let mut state = PersistedState::default();
        state.save_reading_position(
            "/docs/book.pdf",
            ReadingPosition {
                page_index: 50,
                zoom_mode: ZoomMode::Custom,
                zoom_scale: 1.25,
            },
        );

        let restored = state
            .record_open("/docs/book.pdf", "Book", 10, 500)
            .expect("saved position should exist");

        assert_eq!(restored.page_index, 9);
        assert_eq!(restored.zoom_mode, ZoomMode::Custom);
        assert_eq!(state.recent_files[0].last_page, 9);
    }

    #[test]
    fn save_reading_position_updates_positions_and_matching_recent_last_page() {
        let mut state = PersistedState::default();
        state.record_open("/docs/paper.pdf", "Paper", 30, 100);

        let position = ReadingPosition {
            page_index: 7,
            zoom_mode: ZoomMode::FitPage,
            zoom_scale: 0.9,
        };
        state.save_reading_position("/docs/paper.pdf", position);

        assert_eq!(state.positions.get("/docs/paper.pdf"), Some(&position));
        assert_eq!(state.recent_files[0].last_page, 7);
    }

    #[test]
    fn remove_recent_removes_missing_file_entry_and_preserves_other_recents() {
        let mut state = PersistedState::default();
        state.record_open("/docs/keep.pdf", "Keep", 10, 100);
        state.record_open("/docs/missing.pdf", "Missing", 20, 200);

        let removed = state.remove_recent("/docs/missing.pdf", None);

        assert!(removed);
        assert_eq!(state.recent_files.len(), 1);
        assert_eq!(state.recent_files[0].path, "/docs/keep.pdf");
    }

    #[test]
    fn zoom_mode_serializes_in_snake_case() {
        assert_eq!(
            serde_json::to_string(&ZoomMode::FitWidth).expect("serialize FitWidth"),
            "\"fit_width\""
        );
        assert_eq!(
            serde_json::to_string(&ZoomMode::FitPage).expect("serialize FitPage"),
            "\"fit_page\""
        );
        assert_eq!(
            serde_json::to_string(&ZoomMode::Custom).expect("serialize Custom"),
            "\"custom\""
        );
    }

    #[test]
    fn parse_initial_file_arg_returns_none_when_only_program_or_flags_present() {
        assert_eq!(parse_initial_file_arg(["reader"]), None);
        assert_eq!(
            parse_initial_file_arg(["reader", "--inspect", "-v", "--"]),
            None
        );
    }

    #[test]
    fn parse_initial_file_arg_skips_flags_and_returns_first_positional_path() {
        let parsed = parse_initial_file_arg(["reader", "--devtools", "sample.pdf", "second.pdf"]);

        assert_eq!(parsed, Some(PathBuf::from("sample.pdf")));
    }

    #[test]
    fn parse_initial_file_arg_respects_double_dash_separator() {
        let parsed = parse_initial_file_arg(["reader", "--", "-leading-dash.pdf"]);

        assert_eq!(parsed, Some(PathBuf::from("-leading-dash.pdf")));
    }

    #[test]
    fn app_state_take_initial_file_consumes_startup_path_once() {
        let dir = TempDirGuard::new("initial-file");
        let app_state = AppState::new(None, dir.state_file(), Some(PathBuf::from("startup.pdf")))
            .expect("create AppState");

        assert_eq!(
            app_state.take_initial_file().as_deref(),
            Some("startup.pdf")
        );
        assert_eq!(app_state.take_initial_file(), None);
    }

    #[test]
    fn app_state_is_send_and_sync_static() {
        fn assert_send_sync<T: Send + Sync + 'static>() {}
        assert_send_sync::<AppState>();
    }
}
