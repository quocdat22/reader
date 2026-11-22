//! Shared helpers for integration tests.
//!
//! Fixtures live in the gitignored `tests/fixtures/` directory at the repository
//! root and are discovered dynamically so no specific filename is ever hardcoded.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// Environment variable that overrides automatic fixture discovery.
pub const TEST_PDF_ENV_VAR: &str = "READER_TEST_PDF";

/// Discovers a local PDF fixture for integration tests.
///
/// Resolution order:
/// 1. `READER_TEST_PDF` environment variable, if set and non-empty (must point
///    to an existing file).
/// 2. The lexicographically first `*.pdf` file in the repository's
///    `tests/fixtures/` directory.
/// 3. `None` if no fixture is available.
#[must_use]
pub fn discover_pdf_fixture() -> Option<PathBuf> {
    let env_override = env::var_os(TEST_PDF_ENV_VAR)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let fixtures_dir = default_fixtures_dir();
    discover_pdf_fixture_with(env_override.as_deref(), &fixtures_dir)
}

/// Resolves a PDF fixture given an explicit optional override path and a
/// fixtures directory.
///
/// Kept separate from [`discover_pdf_fixture`] so tests can verify resolution
/// behavior deterministically without mutating process environment variables.
#[must_use]
pub fn discover_pdf_fixture_with(
    env_override: Option<&Path>,
    fixtures_dir: &Path,
) -> Option<PathBuf> {
    if let Some(override_path) = env_override {
        return override_path.is_file().then(|| override_path.to_path_buf());
    }

    let entries = fs::read_dir(fixtures_dir).ok()?;
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_pdf_path(path))
        .min_by(|left, right| left.file_name().cmp(&right.file_name()))
}

fn default_fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
}

fn is_pdf_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
}
