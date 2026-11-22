//! Verification tests for dynamic PDF fixture discovery.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

struct TestTempDir {
    path: PathBuf,
}

impl TestTempDir {
    fn new(label: &str) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let path = std::env::temp_dir().join(format!("reader-fixture-test-{label}-{pid}-{id}"));
        fs::create_dir_all(&path).expect("failed to create temporary test directory");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn create_file(&self, name: &str) -> PathBuf {
        let file_path = self.path.join(name);
        fs::write(&file_path, b"%PDF-1.4\n").expect("failed to write test file");
        file_path
    }
}

impl Drop for TestTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn discover_pdf_fixture_with_prefers_existing_override_file() {
    let dir = TestTempDir::new("override-hit");
    let _dir_pdf = dir.create_file("a.pdf");
    let override_pdf = dir.create_file("override.pdf");

    let resolved = common::discover_pdf_fixture_with(Some(&override_pdf), dir.path());

    assert_eq!(resolved.as_deref(), Some(override_pdf.as_path()));
}

#[test]
fn discover_pdf_fixture_with_returns_none_when_override_file_missing() {
    let dir = TestTempDir::new("override-miss");
    let _dir_pdf = dir.create_file("a.pdf");
    let missing = dir.path().join("does-not-exist.pdf");

    let resolved = common::discover_pdf_fixture_with(Some(&missing), dir.path());

    assert_eq!(resolved, None);
}

#[test]
fn discover_pdf_fixture_with_selects_sorted_first_pdf_ignoring_non_pdfs() {
    let dir = TestTempDir::new("sorted-first");
    let _txt = dir.create_file("00-readme.txt");
    let _later = dir.create_file("zeta.pdf");
    let first = dir.create_file("alpha.pdf");

    let resolved = common::discover_pdf_fixture_with(None, dir.path());

    assert_eq!(resolved.as_deref(), Some(first.as_path()));
}

#[test]
fn discover_pdf_fixture_with_matches_uppercase_pdf_extension() {
    let dir = TestTempDir::new("uppercase-ext");
    let upper = dir.create_file("SAMPLE.PDF");

    let resolved = common::discover_pdf_fixture_with(None, dir.path());

    assert_eq!(resolved.as_deref(), Some(upper.as_path()));
}

#[test]
fn discover_pdf_fixture_with_returns_none_when_directory_empty() {
    let dir = TestTempDir::new("empty");

    let resolved = common::discover_pdf_fixture_with(None, dir.path());

    assert_eq!(resolved, None);
}

#[test]
fn discover_pdf_fixture_with_returns_none_when_directory_missing() {
    let dir = TestTempDir::new("missing-parent");
    let nonexistent = dir.path().join("no-such-dir");

    let resolved = common::discover_pdf_fixture_with(None, &nonexistent);

    assert_eq!(resolved, None);
}

#[test]
fn discover_pdf_fixture_resolves_valid_pdf_when_local_fixture_present() {
    let Some(path) = common::discover_pdf_fixture() else {
        eprintln!(
            "Skipping local fixture check: no *.pdf found via {} or tests/fixtures/",
            common::TEST_PDF_ENV_VAR
        );
        return;
    };

    assert!(path.is_file(), "discovered fixture is not a file");
    assert!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf")),
        "discovered fixture does not have a .pdf extension"
    );
}
