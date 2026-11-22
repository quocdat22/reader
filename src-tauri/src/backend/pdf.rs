//! `MuPDF`-backed implementation of [`DocumentBackend`].

use std::fs;
use std::path::Path;

use mupdf::text_page::{SearchHitResponse, TextBlockType};
use mupdf::{
    Colorspace, Context, Device, Document, Error as MuPdfError, Matrix, MetadataName, Outline,
    Page, Pixmap, Quad, Rect, TextPageFlags,
};

use super::{
    DocumentBackend, DocumentMetadata, NormalizedRect, OutlineItem, PageDimensions, PagePointsRect,
    RenderedPage, SearchMatch, TextSpan, clamp_render_dimensions, normalize_top_left_rect_in_box,
};
use crate::error::ReaderError;

/// Upper bound on recursive bookmark nesting depth to protect against pathological PDFs.
const MAX_OUTLINE_DEPTH: usize = 64;

/// Maximum anti-aliasing bit depth supported by `MuPDF` (256-level grayscale AA).
const MUPDF_MAX_AA_BITS: i32 = 8;

/// Horizontal gap multiplier (in em units) above which a text line splits into separate
/// contiguous runs (e.g., separating multi-column gutters or adjacent table cells).
const RUN_SPLIT_GAP_EM: f32 = 1.5;

/// Minimum reference font size in points used when evaluating horizontal run splits.
const MIN_GAP_FONT_SIZE_PT: f32 = 4.0;

/// Single visible or whitespace character positioned in top-left page points.
#[derive(Debug, Clone, Copy)]
struct LineChar {
    ch: char,
    rect: PagePointsRect,
    size: f32,
}

/// PDF document engine backed by statically linked `MuPDF`.
pub struct PdfBackend {
    document: Document,
    metadata: DocumentMetadata,
    page_dimensions: Vec<PageDimensions>,
}

impl PdfBackend {
    /// Opens a PDF document from `path` using `MuPDF`.
    ///
    /// # Errors
    /// - Returns [`ReaderError::Io`] if the file cannot be read.
    /// - Returns [`ReaderError::PasswordProtected`] if the PDF requires a user password.
    /// - Returns [`ReaderError::InvalidDocument`] if the file is corrupt or not a valid PDF.
    pub fn open(path: &Path) -> Result<Self, ReaderError> {
        let mut ctx = Context::get();
        ctx.set_aa_level(MUPDF_MAX_AA_BITS);

        let mut document = open_mupdf_document(path)?;
        if !document.is_pdf() {
            return Err(ReaderError::InvalidDocument(
                "file is not a valid PDF document".to_owned(),
            ));
        }

        if document.needs_password().map_err(map_open_error)? {
            let authenticated = document.authenticate("").map_err(map_open_error)?;
            if !authenticated {
                return Err(ReaderError::PasswordProtected);
            }
        }

        let raw_count = document.page_count().map_err(map_open_error)?;
        let page_count = usize::try_from(raw_count).map_err(|_| {
            ReaderError::InvalidDocument(format!("invalid PDF page count: {raw_count}"))
        })?;

        let mut page_dimensions = Vec::with_capacity(page_count);
        for index in 0..raw_count {
            let page = document.load_page(index).map_err(map_open_error)?;
            let bounds = page.bounds().map_err(map_open_error)?;
            let width_pt = (bounds.x1 - bounds.x0).abs();
            let height_pt = (bounds.y1 - bounds.y0).abs();
            if !width_pt.is_finite()
                || !height_pt.is_finite()
                || width_pt <= 0.0
                || height_pt <= 0.0
            {
                return Err(ReaderError::InvalidDocument(format!(
                    "page {index} has invalid bounds ({width_pt}x{height_pt} pt)"
                )));
            }
            page_dimensions.push(PageDimensions {
                width_pt,
                height_pt,
            });
        }

        let metadata = extract_metadata(&document, page_dimensions.len());

        Ok(Self {
            document,
            metadata,
            page_dimensions,
        })
    }

    fn load_page(&self, page_index: usize) -> Result<Page, ReaderError> {
        let page_count = self.page_dimensions.len();
        if page_index >= page_count {
            return Err(ReaderError::PageOutOfRange {
                page_index,
                page_count,
            });
        }

        let pdf_index = i32::try_from(page_index).map_err(|_| ReaderError::PageOutOfRange {
            page_index,
            page_count,
        })?;

        self.document.load_page(pdf_index).map_err(|err| {
            ReaderError::Internal(format!("failed to load page {page_index}: {err}"))
        })
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

        let target_w = i32::try_from(clamped_w)
            .map_err(|err| ReaderError::Internal(format!("invalid render width: {err}")))?;
        let target_h = i32::try_from(clamped_h)
            .map_err(|err| ReaderError::Internal(format!("invalid render height: {err}")))?;

        let bounds = page
            .bounds()
            .map_err(|err| ReaderError::Internal(format!("failed to read page bounds: {err}")))?;
        let page_w = bounds.x1 - bounds.x0;
        let page_h = bounds.y1 - bounds.y0;
        if !page_w.is_finite() || !page_h.is_finite() || page_w <= 0.0 || page_h <= 0.0 {
            return Err(ReaderError::Internal(format!(
                "page {page_index} has invalid bounds"
            )));
        }

        #[expect(
            clippy::cast_precision_loss,
            reason = "clamped render dimensions are <= 4096, which fit exactly in f32 mantissa"
        )]
        let scale_x = (clamped_w as f32) / page_w;
        #[expect(
            clippy::cast_precision_loss,
            reason = "clamped render dimensions are <= 4096, which fit exactly in f32 mantissa"
        )]
        let scale_y = (clamped_h as f32) / page_h;

        let mut ctm = Matrix::new_translate(-bounds.x0, -bounds.y0);
        ctm.concat(Matrix::new_scale(scale_x, scale_y));

        let colorspace = Colorspace::device_rgb();
        let mut pixmap = Pixmap::new_with_w_h(&colorspace, target_w, target_h, true)
            .map_err(|err| ReaderError::Internal(format!("failed to allocate pixmap: {err}")))?;

        // Fill with opaque white paper (255, 255, 255, 255) so transparent PDF regions
        // composite identically onto white sheets and RGBA remains non-premultiplied-equivalent.
        pixmap
            .clear_with(255)
            .map_err(|err| ReaderError::Internal(format!("failed to clear pixmap: {err}")))?;

        {
            let device = Device::from_pixmap(&pixmap).map_err(|err| {
                ReaderError::Internal(format!("failed to create draw device: {err}"))
            })?;
            page.run(&device, &ctm)
                .map_err(|err| ReaderError::Internal(format!("failed to render page: {err}")))?;
        }

        let rgba = extract_rgba_bytes(&pixmap, clamped_w, clamped_h)?;

        Ok(RenderedPage {
            width_px: clamped_w,
            height_px: clamped_h,
            rgba,
        })
    }

    fn outline(&self) -> Result<Vec<OutlineItem>, ReaderError> {
        let outlines = self
            .document
            .outlines()
            .map_err(|err| ReaderError::Internal(format!("failed to extract outline: {err}")))?;
        Ok(convert_outlines(&outlines, self.page_dimensions.len(), 0))
    }

    fn page_text(&self, page_index: usize) -> Result<Vec<TextSpan>, ReaderError> {
        let page = self.load_page(page_index)?;
        let page_box = page_bounds_box(&page)?;
        let text_page = page
            .to_text_page(TextPageFlags::empty())
            .map_err(|err| ReaderError::Internal(format!("failed to extract page text: {err}")))?;

        let mut spans = Vec::new();
        let mut line_chars = Vec::new();

        for block in text_page.blocks() {
            if block.r#type() != TextBlockType::Text {
                continue;
            }
            for line in block.lines() {
                line_chars.clear();
                for ch in line.chars() {
                    let Some(value) = ch.char() else {
                        continue;
                    };
                    let rect = mupdf_rect_to_points(Rect::from(ch.quad()));
                    line_chars.push(LineChar {
                        ch: value,
                        rect,
                        size: ch.size(),
                    });
                }
                append_line_runs(&line_chars, page_box, &mut spans);
            }
        }

        Ok(spans)
    }

    fn search(&self, query: &str) -> Result<Vec<SearchMatch>, ReaderError> {
        if query.trim().is_empty() || query.contains('\0') {
            return Ok(Vec::new());
        }

        let mut matches = Vec::new();

        for page_index in 0..self.page_dimensions.len() {
            let page = self.load_page(page_index)?;
            let page_box = page_bounds_box(&page)?;
            let text_page = page.to_text_page(TextPageFlags::empty()).map_err(|err| {
                ReaderError::Internal(format!("failed to load page {page_index} text: {err}"))
            })?;

            text_page
                .search_cb(query, &mut matches, |acc, quads| {
                    let rects: Vec<NormalizedRect> = quads
                        .iter()
                        .filter_map(|quad| {
                            let rect = normalize_top_left_rect_in_box(
                                mupdf_quad_to_points(quad),
                                page_box,
                            )?;
                            (!rect.is_empty()).then_some(rect)
                        })
                        .collect();

                    if !rects.is_empty() {
                        acc.push(SearchMatch { page_index, rects });
                    }

                    SearchHitResponse::ContinueSearch
                })
                .map_err(|err| {
                    ReaderError::Internal(format!("failed to search page {page_index}: {err}"))
                })?;
        }

        Ok(matches)
    }
}

fn open_mupdf_document(path: &Path) -> Result<Document, ReaderError> {
    if let Some(utf8_path) = path.to_str() {
        return Document::open(utf8_path).map_err(map_open_error);
    }

    // Fall back to in-memory loading only for rare non-UTF-8 Windows paths.
    let bytes = fs::read(path)?;
    Document::from_bytes(&bytes, ".pdf").map_err(map_open_error)
}

fn extract_metadata(document: &Document, page_count: usize) -> DocumentMetadata {
    let title = document
        .metadata(MetadataName::Title)
        .ok()
        .map(|raw| raw.trim().to_owned())
        .filter(|value| !value.is_empty());
    let author = document
        .metadata(MetadataName::Author)
        .ok()
        .map(|raw| raw.trim().to_owned())
        .filter(|value| !value.is_empty());

    DocumentMetadata {
        title,
        author,
        page_count,
    }
}

fn convert_outlines(outlines: &[Outline], page_count: usize, depth: usize) -> Vec<OutlineItem> {
    if depth >= MAX_OUTLINE_DEPTH {
        return Vec::new();
    }

    outlines
        .iter()
        .map(|entry| {
            let page_index = entry
                .dest
                .and_then(|dest| usize::try_from(dest.loc.page_number).ok())
                .filter(|&index| index < page_count);
            let children = convert_outlines(&entry.down, page_count, depth + 1);

            OutlineItem {
                title: entry.title.trim().to_owned(),
                page_index,
                children,
            }
        })
        .collect()
}

fn page_bounds_box(page: &Page) -> Result<PagePointsRect, ReaderError> {
    let bounds = page
        .bounds()
        .map_err(|err| ReaderError::Internal(format!("failed to read page bounds: {err}")))?;
    Ok(mupdf_rect_to_points(bounds))
}

fn mupdf_rect_to_points(rect: Rect) -> PagePointsRect {
    PagePointsRect {
        left: rect.x0,
        top: rect.y0,
        right: rect.x1,
        bottom: rect.y1,
    }
}

fn mupdf_quad_to_points(quad: &Quad) -> PagePointsRect {
    PagePointsRect {
        left: quad.ul.x.min(quad.ur.x).min(quad.ll.x).min(quad.lr.x),
        top: quad.ul.y.min(quad.ur.y).min(quad.ll.y).min(quad.lr.y),
        right: quad.ul.x.max(quad.ur.x).max(quad.ll.x).max(quad.lr.x),
        bottom: quad.ul.y.max(quad.ur.y).max(quad.ll.y).max(quad.lr.y),
    }
}

fn extract_rgba_bytes(
    pixmap: &Pixmap,
    expected_w: u32,
    expected_h: u32,
) -> Result<Vec<u8>, ReaderError> {
    let actual_w = pixmap.width();
    let actual_h = pixmap.height();
    if actual_w != expected_w || actual_h != expected_h {
        return Err(ReaderError::Internal(format!(
            "rendered pixmap dimensions mismatch: expected {expected_w}x{expected_h}, got {actual_w}x{actual_h}"
        )));
    }

    if pixmap.n() != 4 || !pixmap.alpha() {
        return Err(ReaderError::Internal(format!(
            "unexpected pixmap pixel format: components={}, alpha={}",
            pixmap.n(),
            pixmap.alpha()
        )));
    }

    let width = usize::try_from(actual_w)
        .map_err(|_| ReaderError::Internal("rendered bitmap width overflow".to_owned()))?;
    let height = usize::try_from(actual_h)
        .map_err(|_| ReaderError::Internal("rendered bitmap height overflow".to_owned()))?;
    let row_bytes = width
        .checked_mul(4)
        .ok_or_else(|| ReaderError::Internal("rendered bitmap row size overflow".to_owned()))?;
    let expected_len = row_bytes
        .checked_mul(height)
        .ok_or_else(|| ReaderError::Internal("rendered bitmap size overflow".to_owned()))?;

    let stride = usize::try_from(pixmap.stride())
        .map_err(|_| ReaderError::Internal("invalid negative pixmap stride".to_owned()))?;
    if stride < row_bytes {
        return Err(ReaderError::Internal(format!(
            "pixmap stride ({stride}) is smaller than row width ({row_bytes})"
        )));
    }

    let samples = pixmap.samples();
    if stride == row_bytes {
        if samples.len() != expected_len {
            return Err(ReaderError::Internal(format!(
                "rendered RGBA buffer length mismatch: expected {expected_len}, got {}",
                samples.len()
            )));
        }
        return Ok(samples.to_vec());
    }

    let mut rgba = Vec::with_capacity(expected_len);
    for row in 0..height {
        let start = row
            .checked_mul(stride)
            .ok_or_else(|| ReaderError::Internal("pixmap row offset overflow".to_owned()))?;
        let end = start
            .checked_add(row_bytes)
            .ok_or_else(|| ReaderError::Internal("pixmap row end overflow".to_owned()))?;
        let Some(slice) = samples.get(start..end) else {
            return Err(ReaderError::Internal(
                "pixmap sample buffer ended prematurely".to_owned(),
            ));
        };
        rgba.extend_from_slice(slice);
    }

    Ok(rgba)
}

/// Groups positioned characters from a single `MuPDF` text line into contiguous runs,
/// splitting only when a wide horizontal gap indicates a separate column or table cell.
fn append_line_runs(chars: &[LineChar], page_box: PagePointsRect, out: &mut Vec<TextSpan>) {
    let mut run_text = String::new();
    let mut run_rect: Option<PagePointsRect> = None;
    let mut pending_space = false;
    let mut last_visible_x: Option<(f32, f32)> = None;
    let mut last_font_size: f32 = MIN_GAP_FONT_SIZE_PT;

    for &item in chars {
        if item.ch.is_whitespace() {
            if !run_text.is_empty() {
                pending_space = true;
            }
            continue;
        }

        let char_left = item.rect.left.min(item.rect.right);
        let char_right = item.rect.left.max(item.rect.right);

        if let Some((prev_left, prev_right)) = last_visible_x {
            let horizontal_gap = (char_left - prev_right).max(prev_left - char_right);
            let ref_size = last_font_size.max(item.size).max(MIN_GAP_FONT_SIZE_PT);
            if horizontal_gap > ref_size * RUN_SPLIT_GAP_EM {
                flush_run(&mut run_text, &mut run_rect, page_box, out);
                pending_space = false;
            }
        }

        if pending_space && !run_text.is_empty() {
            run_text.push(' ');
            pending_space = false;
        }

        run_text.push(item.ch);
        run_rect = Some(match run_rect {
            Some(current) => current.union(item.rect),
            None => item.rect,
        });
        last_visible_x = Some((char_left, char_right));
        if item.size.is_finite() && item.size > 0.0 {
            last_font_size = item.size;
        }
    }

    flush_run(&mut run_text, &mut run_rect, page_box, out);
}

fn flush_run(
    run_text: &mut String,
    run_rect: &mut Option<PagePointsRect>,
    page_box: PagePointsRect,
    out: &mut Vec<TextSpan>,
) {
    let text = std::mem::take(run_text);
    let Some(bounds) = run_rect.take() else {
        return;
    };
    if text.is_empty() {
        return;
    }
    if let Some(rect) = normalize_top_left_rect_in_box(bounds, page_box)
        && !rect.is_empty()
    {
        out.push(TextSpan { text, rect });
    }
}

fn map_open_error(err: MuPdfError) -> ReaderError {
    match err {
        MuPdfError::Io(io_err) => ReaderError::Io(io_err),
        other => ReaderError::InvalidDocument(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_page_box() -> PagePointsRect {
        PagePointsRect {
            left: 0.0,
            top: 0.0,
            right: 500.0,
            bottom: 1000.0,
        }
    }

    fn make_char(ch: char, left: f32, right: f32, size: f32) -> LineChar {
        LineChar {
            ch,
            rect: PagePointsRect {
                left,
                top: 100.0,
                right,
                bottom: 112.0,
            },
            size,
        }
    }

    #[test]
    fn append_line_runs_merges_normal_words_with_single_space() {
        let chars = [
            make_char(' ', 0.0, 4.0, 10.0),
            make_char('H', 10.0, 18.0, 10.0),
            make_char('i', 18.0, 22.0, 10.0),
            make_char(' ', 22.0, 26.0, 10.0),
            make_char(' ', 26.0, 29.0, 10.0),
            make_char('a', 29.0, 35.0, 10.0),
            make_char('l', 35.0, 38.0, 10.0),
            make_char('l', 38.0, 41.0, 10.0),
            make_char(' ', 41.0, 45.0, 10.0),
        ];

        let mut spans = Vec::new();
        append_line_runs(&chars, sample_page_box(), &mut spans);

        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].text, "Hi all");
        assert!((spans[0].rect.x - 10.0 / 500.0).abs() < 1e-5);
        assert!((spans[0].rect.width - 31.0 / 500.0).abs() < 1e-5);
    }

    #[test]
    fn append_line_runs_splits_on_wide_column_gutter() {
        let chars = [
            make_char('A', 10.0, 18.0, 10.0),
            make_char('1', 18.0, 25.0, 10.0),
            make_char(' ', 25.0, 30.0, 10.0),
            make_char('B', 200.0, 208.0, 10.0),
            make_char('2', 208.0, 215.0, 10.0),
        ];

        let mut spans = Vec::new();
        append_line_runs(&chars, sample_page_box(), &mut spans);

        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].text, "A1");
        assert_eq!(spans[1].text, "B2");
        assert!((spans[0].rect.x - 10.0 / 500.0).abs() < 1e-5);
        assert!((spans[1].rect.x - 200.0 / 500.0).abs() < 1e-5);
    }

    #[test]
    fn append_line_runs_handles_rtl_order_without_spurious_splits() {
        let chars = [
            make_char('א', 120.0, 128.0, 10.0),
            make_char('ב', 112.0, 120.0, 10.0),
            make_char(' ', 108.0, 112.0, 10.0),
            make_char('ג', 100.0, 108.0, 10.0),
        ];

        let mut spans = Vec::new();
        append_line_runs(&chars, sample_page_box(), &mut spans);

        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].text, "אב ג");
        assert!((spans[0].rect.x - 100.0 / 500.0).abs() < 1e-5);
        assert!((spans[0].rect.width - 28.0 / 500.0).abs() < 1e-5);
    }

    #[test]
    fn append_line_runs_skips_whitespace_only_lines() {
        let chars = [
            make_char(' ', 10.0, 14.0, 10.0),
            make_char('\t', 14.0, 22.0, 10.0),
        ];

        let mut spans = Vec::new();
        append_line_runs(&chars, sample_page_box(), &mut spans);

        assert_eq!(spans, Vec::<TextSpan>::new());
    }
}
