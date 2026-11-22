//! Document backend trait boundary, shared DTOs, geometry helpers, and format dispatch.

pub mod pdf;

use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::ReaderError;

/// Maximum rendered bitmap side length in pixels to prevent OOM on extreme zoom/DPR.
pub const MAX_RENDER_SIDE_PX: u32 = 4096;

/// Number of leading bytes scanned for format magic headers (PDF allows `%PDF-` within 1024 bytes).
const MAGIC_HEADER_SCAN_BYTES: usize = 1024;

/// PDF file magic signature.
const PDF_MAGIC: &[u8] = b"%PDF-";

/// High-level metadata extracted from an open document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentMetadata {
    /// Document title from embedded metadata, if present and non-empty.
    pub title: Option<String>,
    /// Document author from embedded metadata, if present and non-empty.
    pub author: Option<String>,
    /// Total number of pages in the document.
    pub page_count: usize,
}

/// Intrinsic dimensions of a single document page in PDF points (`1/72` inch).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PageDimensions {
    /// Page width in points.
    pub width_pt: f32,
    /// Page height in points.
    pub height_pt: f32,
}

/// Rasterized `RGBA8` pixel buffer for a single rendered page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedPage {
    /// Actual rendered bitmap width in pixels.
    pub width_px: u32,
    /// Actual rendered bitmap height in pixels.
    pub height_px: u32,
    /// Tightly packed `RGBA8` pixels (`width_px * height_px * 4` bytes).
    pub rgba: Vec<u8>,
}

impl RenderedPage {
    /// Encodes this rendered page into the binary IPC wire format:
    /// `[width_px: u32 LE][height_px: u32 LE][RGBA8 pixels]`.
    #[must_use]
    pub fn to_ipc_bytes(&self) -> Vec<u8> {
        let mut frame = Vec::with_capacity(8 + self.rgba.len());
        frame.extend_from_slice(&self.width_px.to_le_bytes());
        frame.extend_from_slice(&self.height_px.to_le_bytes());
        frame.extend_from_slice(&self.rgba);
        frame
    }
}

/// Axis-aligned rectangle in top-left page points (`y` increases downward).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PagePointsRect {
    /// Left X coordinate in points.
    pub left: f32,
    /// Top Y coordinate in points.
    pub top: f32,
    /// Right X coordinate in points.
    pub right: f32,
    /// Bottom Y coordinate in points.
    pub bottom: f32,
}

impl PagePointsRect {
    /// Returns the smallest rectangle enclosing both `self` and `other`.
    #[must_use]
    pub fn union(self, other: Self) -> Self {
        Self {
            left: self.left.min(other.left),
            top: self.top.min(other.top),
            right: self.right.max(other.right),
            bottom: self.bottom.max(other.bottom),
        }
    }
}

/// Page-relative rectangle in top-left normalized `[0.0, 1.0]` coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct NormalizedRect {
    /// Left offset as a fraction of page width (`0.0..=1.0`).
    pub x: f32,
    /// Top offset as a fraction of page height (`0.0..=1.0`).
    pub y: f32,
    /// Width as a fraction of page width (`0.0..=1.0`).
    pub width: f32,
    /// Height as a fraction of page height (`0.0..=1.0`).
    pub height: f32,
}

impl NormalizedRect {
    /// Returns `true` if this rectangle has zero width or zero height.
    #[must_use]
    pub fn is_empty(self) -> bool {
        self.width <= 0.0 || self.height <= 0.0
    }
}

/// Recursive table-of-contents outline entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutlineItem {
    /// Display title of the bookmark or chapter.
    pub title: String,
    /// Zero-based destination page index, if the entry points to a valid page.
    pub page_index: Option<usize>,
    /// Nested child outline entries.
    pub children: Vec<Self>,
}

/// Positioned text segment extracted for the transparent selection overlay.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextSpan {
    /// Unicode text contained in this segment.
    pub text: String,
    /// Bounding box in top-left normalized `[0.0, 1.0]` page coordinates.
    pub rect: NormalizedRect,
}

/// Single in-document search match with one or more highlight rectangles.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchMatch {
    /// Zero-based page index where the match occurs.
    pub page_index: usize,
    /// Normalized highlight rectangles (multiple entries when a match wraps lines).
    pub rects: Vec<NormalizedRect>,
}

/// Fixed-page document engine abstraction.
///
/// Implementations are not required to be `Send` or `Sync`; all runtime calls
/// execute on the dedicated worker thread in [`crate::worker`].
pub trait DocumentBackend {
    /// Returns cached metadata for this open document.
    fn metadata(&self) -> &DocumentMetadata;

    /// Returns the total number of pages in this document.
    fn page_count(&self) -> usize;

    /// Returns cached intrinsic page dimensions (in PDF points) for all pages.
    fn page_dimensions(&self) -> &[PageDimensions];

    /// Rasterizes a single page into an `RGBA8` bitmap clamped to [`MAX_RENDER_SIDE_PX`].
    ///
    /// # Errors
    /// - Returns [`ReaderError::PageOutOfRange`] if `page_index >= self.page_count()`.
    /// - Returns [`ReaderError::Internal`] if the rendering engine fails.
    fn render_page(
        &mut self,
        page_index: usize,
        width_px: u32,
        height_px: u32,
    ) -> Result<RenderedPage, ReaderError>;

    /// Extracts the document's nested table-of-contents outline tree.
    ///
    /// # Errors
    /// Returns an error if outline extraction fails in the underlying engine.
    fn outline(&self) -> Result<Vec<OutlineItem>, ReaderError>;

    /// Extracts positioned text spans for a single page in normalized coordinates.
    ///
    /// # Errors
    /// - Returns [`ReaderError::PageOutOfRange`] if `page_index >= self.page_count()`.
    /// - Returns [`ReaderError::Internal`] if text extraction fails.
    fn page_text(&self, page_index: usize) -> Result<Vec<TextSpan>, ReaderError>;

    /// Searches the document case-insensitively for `query` and returns all match regions.
    ///
    /// # Errors
    /// Returns an error if any page cannot be loaded for searching.
    fn search(&self, query: &str) -> Result<Vec<SearchMatch>, ReaderError>;
}

/// Clamps requested render dimensions into `1..=MAX_RENDER_SIDE_PX` while
/// preserving the requested aspect ratio when scaling down.
#[must_use]
pub fn clamp_render_dimensions(width_px: u32, height_px: u32) -> (u32, u32) {
    let width = width_px.max(1);
    let height = height_px.max(1);
    let max_side = width.max(height);

    if max_side <= MAX_RENDER_SIDE_PX {
        return (width, height);
    }

    let scale = f64::from(MAX_RENDER_SIDE_PX) / f64::from(max_side);

    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "scaled dimension is strictly bounded within 1..=MAX_RENDER_SIDE_PX (4096)"
    )]
    let scaled_width = ((f64::from(width) * scale).round() as u32).clamp(1, MAX_RENDER_SIDE_PX);

    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "scaled dimension is strictly bounded within 1..=MAX_RENDER_SIDE_PX (4096)"
    )]
    let scaled_height = ((f64::from(height) * scale).round() as u32).clamp(1, MAX_RENDER_SIDE_PX);

    (scaled_width, scaled_height)
}

/// Converts a top-left page-space rectangle on a `(0, 0, page_width, page_height)` page
/// into top-left normalized `[0.0, 1.0]` coordinates.
///
/// Returns `None` if `page_width`/`page_height` are non-positive or any coordinate is non-finite.
#[must_use]
pub fn normalize_top_left_rect(
    rect: PagePointsRect,
    page_width: f32,
    page_height: f32,
) -> Option<NormalizedRect> {
    if !page_width.is_finite()
        || !page_height.is_finite()
        || page_width <= 0.0
        || page_height <= 0.0
    {
        return None;
    }

    normalize_top_left_rect_in_box(
        rect,
        PagePointsRect {
            left: 0.0,
            top: 0.0,
            right: page_width,
            bottom: page_height,
        },
    )
}

/// Converts a top-left page-space rectangle relative to `page_box` (such as a `CropBox`
/// with non-zero origin) into top-left normalized `[0.0, 1.0]` coordinates.
///
/// Returns `None` if `page_box` has non-positive dimensions or any coordinate is non-finite.
#[must_use]
pub fn normalize_top_left_rect_in_box(
    rect: PagePointsRect,
    page_box: PagePointsRect,
) -> Option<NormalizedRect> {
    let all_finite = rect.left.is_finite()
        && rect.top.is_finite()
        && rect.right.is_finite()
        && rect.bottom.is_finite()
        && page_box.left.is_finite()
        && page_box.top.is_finite()
        && page_box.right.is_finite()
        && page_box.bottom.is_finite();
    if !all_finite {
        return None;
    }

    let box_width = page_box.right - page_box.left;
    let box_height = page_box.bottom - page_box.top;
    if box_width <= 0.0 || box_height <= 0.0 {
        return None;
    }

    let left = rect.left.min(rect.right) - page_box.left;
    let right = rect.left.max(rect.right) - page_box.left;
    let top = rect.top.min(rect.bottom) - page_box.top;
    let bottom = rect.top.max(rect.bottom) - page_box.top;

    let x0 = (left / box_width).clamp(0.0, 1.0);
    let x1 = (right / box_width).clamp(0.0, 1.0);
    let y0 = (top / box_height).clamp(0.0, 1.0);
    let y1 = (bottom / box_height).clamp(0.0, 1.0);

    let width = (x1 - x0).clamp(0.0, 1.0 - x0);
    let height = (y1 - y0).clamp(0.0, 1.0 - y0);

    Some(NormalizedRect {
        x: x0,
        y: y0,
        width,
        height,
    })
}

/// Opens a document from `path` using the appropriate backend for its format.
///
/// # Errors
/// - Returns [`ReaderError::Io`] if `path` cannot be opened or read.
/// - Returns [`ReaderError::UnsupportedFormat`] if the file is not a supported format.
/// - Returns [`ReaderError::PasswordProtected`] or [`ReaderError::InvalidDocument`]
///   if the backend fails to open the file.
pub fn open(path: &Path) -> Result<Box<dyn DocumentBackend>, ReaderError> {
    if std::fs::metadata(path)?.is_dir() {
        return Err(ReaderError::UnsupportedFormat("folder".to_owned()));
    }

    if !is_pdf_file(path)? {
        let label = path
            .extension()
            .and_then(|ext| ext.to_str())
            .filter(|ext| !ext.is_empty())
            .map_or_else(|| "unknown file type".to_owned(), |ext| format!(".{ext}"));
        return Err(ReaderError::UnsupportedFormat(label));
    }

    let backend = pdf::PdfBackend::open(path)?;
    Ok(Box::new(backend))
}

fn is_pdf_file(path: &Path) -> Result<bool, ReaderError> {
    let mut file = File::open(path)?;
    let mut header = [0_u8; MAGIC_HEADER_SCAN_BYTES];
    let bytes_read = file.read(&mut header)?;

    if has_pdf_extension(path) {
        return Ok(true);
    }

    Ok(header[..bytes_read]
        .windows(PDF_MAGIC.len())
        .any(|window| window == PDF_MAGIC))
}

fn has_pdf_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
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
            let path = std::env::temp_dir().join(format!("reader-backend-test-{label}-{pid}-{id}"));
            fs::create_dir_all(&path).expect("failed to create temp test dir");
            Self { path }
        }

        fn write_file(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let file_path = self.path.join(name);
            fs::write(&file_path, bytes).expect("failed to write test file");
            file_path
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn assert_approx_eq(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() < 1e-5,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn normalize_top_left_rect_maps_top_left_quadrant() {
        let rect = PagePointsRect {
            left: 0.0,
            top: 0.0,
            right: 300.0,
            bottom: 400.0,
        };

        let normalized = normalize_top_left_rect(rect, 600.0, 800.0).expect("valid rect");

        assert_approx_eq(normalized.x, 0.0);
        assert_approx_eq(normalized.y, 0.0);
        assert_approx_eq(normalized.width, 0.5);
        assert_approx_eq(normalized.height, 0.5);
    }

    #[test]
    fn normalize_top_left_rect_maps_bottom_right_quadrant() {
        let rect = PagePointsRect {
            left: 300.0,
            top: 600.0,
            right: 600.0,
            bottom: 800.0,
        };

        let normalized = normalize_top_left_rect(rect, 600.0, 800.0).expect("valid rect");

        assert_approx_eq(normalized.x, 0.5);
        assert_approx_eq(normalized.y, 0.75);
        assert_approx_eq(normalized.width, 0.5);
        assert_approx_eq(normalized.height, 0.25);
    }

    #[test]
    fn normalize_top_left_rect_handles_inverted_edges_and_clamps_out_of_bounds() {
        let rect = PagePointsRect {
            left: 700.0,
            top: 900.0,
            right: -50.0,
            bottom: -100.0,
        };

        let normalized = normalize_top_left_rect(rect, 600.0, 800.0).expect("clamped rect");

        assert_approx_eq(normalized.x, 0.0);
        assert_approx_eq(normalized.y, 0.0);
        assert_approx_eq(normalized.width, 1.0);
        assert_approx_eq(normalized.height, 1.0);
    }

    #[test]
    fn normalize_top_left_rect_in_box_shifts_nonzero_origin() {
        let crop_box = PagePointsRect {
            left: 100.0,
            top: 50.0,
            right: 500.0,
            bottom: 650.0,
        };
        let rect = PagePointsRect {
            left: 200.0,
            top: 200.0,
            right: 300.0,
            bottom: 350.0,
        };

        let normalized = normalize_top_left_rect_in_box(rect, crop_box).expect("cropped rect");

        assert_approx_eq(normalized.x, 0.25);
        assert_approx_eq(normalized.y, 0.25);
        assert_approx_eq(normalized.width, 0.25);
        assert_approx_eq(normalized.height, 0.25);
    }

    #[test]
    fn normalize_top_left_rect_returns_none_for_invalid_page_dimensions() {
        let rect = PagePointsRect {
            left: 0.0,
            top: 0.0,
            right: 10.0,
            bottom: 10.0,
        };

        assert_eq!(normalize_top_left_rect(rect, 0.0, 800.0), None);
        assert_eq!(normalize_top_left_rect(rect, 600.0, -1.0), None);
        assert_eq!(normalize_top_left_rect(rect, f32::NAN, 800.0), None);
    }

    #[test]
    fn normalize_top_left_rect_returns_none_for_non_finite_rect_coordinates() {
        let rect = PagePointsRect {
            left: f32::INFINITY,
            top: 0.0,
            right: 10.0,
            bottom: 10.0,
        };

        assert_eq!(normalize_top_left_rect(rect, 600.0, 800.0), None);
    }

    #[test]
    fn clamp_render_dimensions_preserves_valid_sizes_unchanged() {
        assert_eq!(clamp_render_dimensions(1200, 1600), (1200, 1600));
        assert_eq!(
            clamp_render_dimensions(MAX_RENDER_SIDE_PX, MAX_RENDER_SIDE_PX),
            (MAX_RENDER_SIDE_PX, MAX_RENDER_SIDE_PX)
        );
    }

    #[test]
    fn clamp_render_dimensions_scales_proportionally_when_exceeding_maximum() {
        assert_eq!(clamp_render_dimensions(4096, 8192), (2048, 4096));
        assert_eq!(clamp_render_dimensions(8192, 2048), (4096, 1024));
    }

    #[test]
    fn clamp_render_dimensions_floors_zero_values_to_one_pixel() {
        assert_eq!(clamp_render_dimensions(0, 0), (1, 1));
        assert_eq!(clamp_render_dimensions(0, 8192), (1, 4096));
    }

    #[test]
    fn rendered_page_to_ipc_bytes_prepends_little_endian_dimensions() {
        let page = RenderedPage {
            width_px: 2,
            height_px: 1,
            rgba: vec![10, 20, 30, 255, 40, 50, 60, 255],
        };

        let frame = page.to_ipc_bytes();

        assert_eq!(frame.len(), 16);
        assert_eq!(&frame[0..4], &2_u32.to_le_bytes());
        assert_eq!(&frame[4..8], &1_u32.to_le_bytes());
        assert_eq!(&frame[8..], page.rgba.as_slice());
    }

    #[test]
    fn open_returns_io_error_when_file_missing() {
        let dir = TempDirGuard::new("missing");
        let missing = dir.path.join("missing.pdf");

        let Err(err) = open(&missing) else {
            panic!("expected missing file to fail");
        };

        assert!(
            matches!(err, ReaderError::Io(_)),
            "expected ReaderError::Io, got {err:?}"
        );
    }

    #[test]
    fn open_returns_unsupported_format_for_non_pdf_file() {
        let dir = TempDirGuard::new("unsupported");
        let txt = dir.write_file("notes.txt", b"just plain text, not a document");

        let Err(err) = open(&txt) else {
            panic!("expected non-PDF file to fail");
        };

        assert!(
            matches!(err, ReaderError::UnsupportedFormat(_)),
            "expected ReaderError::UnsupportedFormat, got {err:?}"
        );
    }

    #[test]
    fn open_returns_invalid_document_for_corrupt_pdf_file() {
        let dir = TempDirGuard::new("corrupt-pdf");
        let corrupt = dir.write_file("broken.pdf", b"%PDF-1.7\nnot valid pdf objects");

        let Err(err) = open(&corrupt) else {
            panic!("expected corrupt PDF to fail");
        };

        assert!(
            matches!(err, ReaderError::InvalidDocument(_)),
            "expected ReaderError::InvalidDocument, got {err:?}"
        );
    }

    #[test]
    fn open_returns_unsupported_format_for_directory() {
        let dir = TempDirGuard::new("directory");

        let Err(err) = open(&dir.path) else {
            panic!("expected directory open to fail");
        };

        assert!(
            matches!(err, ReaderError::UnsupportedFormat(ref label) if label == "folder"),
            "expected ReaderError::UnsupportedFormat(\"folder\"), got {err:?}"
        );
    }
}
