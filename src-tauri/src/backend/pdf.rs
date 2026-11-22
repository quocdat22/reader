//! `PDFium`-backed implementation of [`DocumentBackend`] and dynamic library loader.

use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError};

use pdfium_render::prelude::{
    PdfBookmark, PdfDocument, PdfDocumentMetadataTagType, PdfPage, PdfPageIndex, PdfRect,
    PdfRenderConfig, PdfSearchDirection, PdfSearchOptions, Pdfium, PdfiumError,
    PdfiumInternalError, Pixels,
};

use super::{
    DocumentBackend, DocumentMetadata, NormalizedRect, OutlineItem, PageDimensions, PdfPointsRect,
    RenderedPage, SearchMatch, TextSpan, clamp_render_dimensions, normalize_pdf_rect_in_box,
};
use crate::error::ReaderError;

/// Environment variable overriding dynamic `PDFium` library discovery.
pub const PDFIUM_LIB_PATH_ENV: &str = "PDFIUM_LIB_PATH";

/// Upper bound on recursive bookmark nesting depth to protect against pathological PDFs.
const MAX_OUTLINE_DEPTH: usize = 64;

/// Process-wide initialized `PDFium` handle (matches `pdfium-render`'s global `OnceCell` bindings).
static PDFIUM: OnceLock<Pdfium> = OnceLock::new();

/// Serializes first-time `PDFium` dynamic binding so failed attempts never poison [`PDFIUM`].
static PDFIUM_INIT_LOCK: Mutex<()> = Mutex::new(());

/// Builds the ordered list of candidate `PDFium` dynamic library paths to probe.
///
/// Resolution order:
/// 1. `env_override` (`PDFIUM_LIB_PATH`, accepting either a library file or directory).
/// 2. `resource_dir/pdfium/<lib>` (Tauri bundled resources).
/// 3. `exe_dir/<lib>` and `exe_dir/pdfium/<lib>` (directory adjacent to the executable).
/// 4. `manifest_dir/resources/pdfium/<lib>` (local development fallback).
#[must_use]
pub fn candidate_library_paths(
    env_override: Option<&Path>,
    resource_dir: Option<&Path>,
    exe_dir: Option<&Path>,
    manifest_dir: Option<&Path>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::with_capacity(8);

    if let Some(override_path) = env_override {
        if override_path.is_dir() {
            candidates.push(Pdfium::pdfium_platform_library_name_at_path(override_path));
        } else {
            candidates.push(override_path.to_path_buf());
        }
    }

    if let Some(dir) = resource_dir {
        candidates.push(Pdfium::pdfium_platform_library_name_at_path(
            &dir.join("pdfium"),
        ));
        candidates.push(Pdfium::pdfium_platform_library_name_at_path(
            &dir.join("resources").join("pdfium"),
        ));
    }

    if let Some(dir) = exe_dir {
        candidates.push(Pdfium::pdfium_platform_library_name_at_path(dir));
        candidates.push(Pdfium::pdfium_platform_library_name_at_path(
            &dir.join("pdfium"),
        ));
        candidates.push(Pdfium::pdfium_platform_library_name_at_path(
            &dir.join("resources").join("pdfium"),
        ));
    }

    if let Some(dir) = manifest_dir {
        candidates.push(Pdfium::pdfium_platform_library_name_at_path(
            &dir.join("resources").join("pdfium"),
        ));
    }

    candidates
}

/// Initializes (or returns the already-initialized) process-wide `PDFium` runtime handle.
///
/// # Errors
/// Returns [`ReaderError::PdfiumUnavailable`] if no valid `PDFium` dynamic library can be
/// located or bound from the configured discovery paths.
pub fn init_pdfium(resource_dir: Option<&Path>) -> Result<&'static Pdfium, ReaderError> {
    if let Some(pdfium) = PDFIUM.get() {
        return Ok(pdfium);
    }

    let _guard = PDFIUM_INIT_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner);

    if let Some(pdfium) = PDFIUM.get() {
        return Ok(pdfium);
    }

    let env_override = env::var_os(PDFIUM_LIB_PATH_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let exe_dir = env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));

    let candidates = candidate_library_paths(
        env_override.as_deref(),
        resource_dir,
        exe_dir.as_deref(),
        Some(manifest_dir),
    );

    let mut load_errors = Vec::new();
    for candidate in &candidates {
        if !candidate.is_file() {
            continue;
        }

        match Pdfium::bind_to_library(candidate) {
            Ok(bindings) => {
                let _ = PDFIUM.set(Pdfium::new(bindings));
                return PDFIUM.get().ok_or_else(|| {
                    ReaderError::PdfiumUnavailable(
                        "PDFium initialized but handle could not be stored".to_owned(),
                    )
                });
            }
            Err(PdfiumError::PdfiumLibraryBindingsAlreadyInitialized) => {
                let _ = PDFIUM.set(Pdfium::default());
                return PDFIUM.get().ok_or_else(|| {
                    ReaderError::PdfiumUnavailable(
                        "PDFium bindings already initialized but handle unavailable".to_owned(),
                    )
                });
            }
            Err(err) => {
                load_errors.push(format!("{} ({err})", candidate.display()));
            }
        }
    }

    let searched: Vec<String> = candidates
        .iter()
        .map(|path| path.display().to_string())
        .collect();
    let detail = if load_errors.is_empty() {
        format!(
            "no PDFium library found; searched: [{}]",
            searched.join(", ")
        )
    } else {
        format!(
            "failed to bind PDFium library ({}); searched: [{}]",
            load_errors.join("; "),
            searched.join(", ")
        )
    };

    Err(ReaderError::PdfiumUnavailable(detail))
}

/// PDF document engine backed by `PDFium`.
pub struct PdfBackend {
    document: PdfDocument<'static>,
    metadata: DocumentMetadata,
    page_dimensions: Vec<PageDimensions>,
}

impl PdfBackend {
    /// Opens a PDF document from `path` using `PDFium`.
    ///
    /// # Errors
    /// - Returns [`ReaderError::PdfiumUnavailable`] if `PDFium` cannot be loaded.
    /// - Returns [`ReaderError::Io`] if the file cannot be read.
    /// - Returns [`ReaderError::PasswordProtected`] if the PDF requires a password.
    /// - Returns [`ReaderError::InvalidDocument`] if the file is corrupt or not a valid PDF.
    pub fn open(path: &Path, resource_dir: Option<&Path>) -> Result<Self, ReaderError> {
        let pdfium = init_pdfium(resource_dir)?;
        let document = pdfium
            .load_pdf_from_file(path, None)
            .map_err(map_load_error)?;

        let page_dimensions: Vec<PageDimensions> = document
            .pages()
            .page_sizes()
            .map_err(|err| ReaderError::InvalidDocument(err.to_string()))?
            .into_iter()
            .map(|rect| PageDimensions {
                width_pt: rect.width().value,
                height_pt: rect.height().value,
            })
            .collect();

        let metadata = extract_metadata(&document, page_dimensions.len());

        Ok(Self {
            document,
            metadata,
            page_dimensions,
        })
    }

    fn load_page(&self, page_index: usize) -> Result<PdfPage<'_>, ReaderError> {
        let page_count = self.page_dimensions.len();
        if page_index >= page_count {
            return Err(ReaderError::PageOutOfRange {
                page_index,
                page_count,
            });
        }

        let pdf_index =
            PdfPageIndex::try_from(page_index).map_err(|_| ReaderError::PageOutOfRange {
                page_index,
                page_count,
            })?;

        self.document
            .pages()
            .get(pdf_index)
            .map_err(|err| map_page_error(err, page_index, page_count))
    }
}

impl DocumentBackend for PdfBackend {
    fn metadata(&self) -> &DocumentMetadata {
        &self.metadata
    }

    fn page_count(&self) -> usize {
        self.page_dimensions.len()
    }

    fn page_dimensions(&self) -> &[PageDimensions] {
        &self.page_dimensions
    }

    fn render_page(
        &mut self,
        page_index: usize,
        width_px: u32,
        height_px: u32,
    ) -> Result<RenderedPage, ReaderError> {
        let page = self.load_page(page_index)?;
        let (clamped_w, clamped_h) = clamp_render_dimensions(width_px, height_px);

        let target_w = Pixels::try_from(clamped_w)
            .map_err(|err| ReaderError::Internal(format!("invalid render width: {err}")))?;
        let target_h = Pixels::try_from(clamped_h)
            .map_err(|err| ReaderError::Internal(format!("invalid render height: {err}")))?;

        let config = PdfRenderConfig::new().set_fixed_size(target_w, target_h);
        let bitmap = page
            .render_with_config(&config)
            .map_err(|err| ReaderError::Internal(format!("failed to render page: {err}")))?;

        let actual_w = u32::try_from(bitmap.width())
            .map_err(|err| ReaderError::Internal(format!("invalid bitmap width: {err}")))?;
        let actual_h = u32::try_from(bitmap.height())
            .map_err(|err| ReaderError::Internal(format!("invalid bitmap height: {err}")))?;
        let rgba = bitmap.as_rgba_bytes();

        let expected_len = usize::try_from(actual_w)
            .ok()
            .and_then(|w| {
                usize::try_from(actual_h)
                    .ok()
                    .and_then(|h| w.checked_mul(h))
            })
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| ReaderError::Internal("rendered bitmap size overflow".to_owned()))?;

        if rgba.len() != expected_len {
            return Err(ReaderError::Internal(format!(
                "rendered RGBA buffer length mismatch: expected {expected_len}, got {}",
                rgba.len()
            )));
        }

        Ok(RenderedPage {
            width_px: actual_w,
            height_px: actual_h,
            rgba,
        })
    }

    fn outline(&self) -> Result<Vec<OutlineItem>, ReaderError> {
        let mut visited = HashSet::new();
        Ok(collect_outline_siblings(
            self.document.bookmarks().root(),
            self.page_dimensions.len(),
            0,
            &mut visited,
        ))
    }

    fn page_text(&self, page_index: usize) -> Result<Vec<TextSpan>, ReaderError> {
        let page = self.load_page(page_index)?;
        let page_box = visible_page_box(&page);
        let text_page = page
            .text()
            .map_err(|err| ReaderError::Internal(format!("failed to load page text: {err}")))?;

        let spans = text_page
            .segments()
            .iter()
            .filter_map(|segment| {
                let text = segment.text();
                if text.is_empty() {
                    return None;
                }
                let rect =
                    normalize_pdf_rect_in_box(pdf_rect_to_points(segment.bounds()), page_box)?;
                (!rect.is_empty()).then_some(TextSpan { text, rect })
            })
            .collect();

        Ok(spans)
    }

    fn search(&self, query: &str) -> Result<Vec<SearchMatch>, ReaderError> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }

        let options = PdfSearchOptions::new()
            .match_case(false)
            .match_whole_word(false);
        let mut matches = Vec::new();

        for page_index in 0..self.page_dimensions.len() {
            let page = self.load_page(page_index)?;
            let text_page = page.text().map_err(|err| {
                ReaderError::Internal(format!("failed to load page {page_index} text: {err}"))
            })?;

            if text_page.is_empty() {
                continue;
            }

            let page_box = visible_page_box(&page);
            let search = text_page.search(query, &options).map_err(|err| {
                ReaderError::Internal(format!("failed to search page {page_index}: {err}"))
            })?;

            for result_segments in search.iter(PdfSearchDirection::SearchForward) {
                let rects: Vec<NormalizedRect> = result_segments
                    .iter()
                    .filter_map(|segment| {
                        let rect = normalize_pdf_rect_in_box(
                            pdf_rect_to_points(segment.bounds()),
                            page_box,
                        )?;
                        (!rect.is_empty()).then_some(rect)
                    })
                    .collect();

                if !rects.is_empty() {
                    matches.push(SearchMatch { page_index, rects });
                }
            }
        }

        Ok(matches)
    }
}

fn extract_metadata(document: &PdfDocument<'_>, page_count: usize) -> DocumentMetadata {
    let metadata = document.metadata();
    let title = metadata
        .get(PdfDocumentMetadataTagType::Title)
        .map(|tag| tag.value().trim().to_owned())
        .filter(|value| !value.is_empty());
    let author = metadata
        .get(PdfDocumentMetadataTagType::Author)
        .map(|tag| tag.value().trim().to_owned())
        .filter(|value| !value.is_empty());

    DocumentMetadata {
        title,
        author,
        page_count,
    }
}

fn collect_outline_siblings<'a>(
    first: Option<PdfBookmark<'a>>,
    page_count: usize,
    depth: usize,
    visited: &mut HashSet<PdfBookmark<'a>>,
) -> Vec<OutlineItem> {
    if depth >= MAX_OUTLINE_DEPTH {
        return Vec::new();
    }

    let mut items = Vec::new();
    let mut current = first;

    while let Some(bookmark) = current {
        // Track visited handles so cyclic bookmark graphs in malformed PDFs terminate cleanly.
        if !visited.insert(bookmark.clone()) {
            break;
        }

        let title = bookmark.title().map_or_default(|raw| raw.trim().to_owned());
        let page_index = bookmark_page_index(&bookmark, page_count);
        let children =
            collect_outline_siblings(bookmark.first_child(), page_count, depth + 1, visited);

        items.push(OutlineItem {
            title,
            page_index,
            children,
        });

        current = bookmark.next_sibling();
    }

    items
}

fn bookmark_page_index(bookmark: &PdfBookmark<'_>, page_count: usize) -> Option<usize> {
    let raw_index = bookmark
        .destination()
        .and_then(|dest| dest.page_index().ok())
        .or_else(|| {
            bookmark.action().and_then(|action| {
                action
                    .as_local_destination_action()?
                    .destination()
                    .ok()?
                    .page_index()
                    .ok()
            })
        })?;

    usize::try_from(raw_index)
        .ok()
        .filter(|&index| index < page_count)
}

fn visible_page_box(page: &PdfPage<'_>) -> PdfPointsRect {
    let boundaries = page.boundaries();
    if let Ok(box_info) = boundaries.crop().or_else(|_| boundaries.media()) {
        let rect = pdf_rect_to_points(box_info.bounds);
        if (rect.right - rect.left).abs() > 0.0 && (rect.top - rect.bottom).abs() > 0.0 {
            return rect;
        }
    }

    PdfPointsRect {
        left: 0.0,
        bottom: 0.0,
        right: page.width().value,
        top: page.height().value,
    }
}

fn pdf_rect_to_points(rect: PdfRect) -> PdfPointsRect {
    PdfPointsRect {
        left: rect.left().value,
        bottom: rect.bottom().value,
        right: rect.right().value,
        top: rect.top().value,
    }
}

fn map_load_error(err: PdfiumError) -> ReaderError {
    match err {
        PdfiumError::IoError(io_err) => ReaderError::Io(io_err),
        PdfiumError::LoadLibraryError(lib_err) => {
            ReaderError::PdfiumUnavailable(lib_err.to_string())
        }
        PdfiumError::PdfiumLibraryInternalError(
            PdfiumInternalError::PasswordError | PdfiumInternalError::SecurityError,
        ) => ReaderError::PasswordProtected,
        PdfiumError::PdfiumLibraryInternalError(
            PdfiumInternalError::FormatError
            | PdfiumInternalError::PageError
            | PdfiumInternalError::FileError,
        ) => ReaderError::InvalidDocument(err.to_string()),
        other => ReaderError::Internal(other.to_string()),
    }
}

fn map_page_error(err: PdfiumError, page_index: usize, page_count: usize) -> ReaderError {
    match err {
        PdfiumError::PageIndexOutOfBounds => ReaderError::PageOutOfRange {
            page_index,
            page_count,
        },
        other => ReaderError::Internal(format!("failed to load page {page_index}: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
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
            let path = std::env::temp_dir().join(format!("reader-pdf-test-{label}-{pid}-{id}"));
            fs::create_dir_all(&path).expect("failed to create temp test dir");
            Self { path }
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn candidate_library_paths_follows_spec_precedence_order() {
        let lib_name = Pdfium::pdfium_platform_library_name();
        let env_file = Path::new("custom_override").join(&lib_name);
        let resource_dir = Path::new("app_resources");
        let exe_dir = Path::new("app_bin");
        let manifest_dir = Path::new("crate_root");

        let candidates = candidate_library_paths(
            Some(&env_file),
            Some(resource_dir),
            Some(exe_dir),
            Some(manifest_dir),
        );

        assert_eq!(candidates[0], env_file);
        assert_eq!(candidates[1], resource_dir.join("pdfium").join(&lib_name));
        assert_eq!(candidates[3], exe_dir.join(&lib_name));
        assert_eq!(
            candidates.last(),
            Some(
                &manifest_dir
                    .join("resources")
                    .join("pdfium")
                    .join(&lib_name)
            )
        );
    }

    #[test]
    fn candidate_library_paths_appends_platform_filename_when_env_override_is_directory() {
        let temp = TempDirGuard::new("env-dir");
        let lib_name = Pdfium::pdfium_platform_library_name();

        let candidates = candidate_library_paths(Some(&temp.path), None, None, None);

        assert_eq!(candidates, vec![temp.path.join(lib_name)]);
    }
}
