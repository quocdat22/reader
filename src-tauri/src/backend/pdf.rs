//! `PDFium`-backed implementation of [`DocumentBackend`] using `pdfium-render`.

use std::collections::{HashMap, HashSet, hash_map::Entry};
use std::env;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use pdfium_render::prelude::{
    PdfBitmapFormat, PdfBookmark, PdfColor, PdfDestination, PdfDestinationViewSettings,
    PdfDocument, PdfDocumentMetadataTagType, PdfLink, PdfPage, PdfPageAnnotationCommon,
    PdfPageIndex, PdfPageRenderRotation, PdfRect, PdfRenderConfig, PdfSearchDirection,
    PdfSearchOptions, Pdfium, PdfiumError, PdfiumInternalError, Pixels,
};

use super::{
    DocumentBackend, DocumentMetadata, LinkTarget, NormalizedPoint, NormalizedRect, OutlineItem,
    PageDimensions, PageLink, PagePointsRect, RenderedPage, SearchMatch, TextSpan,
    clamp_render_dimensions, normalize_top_left_rect,
};
use crate::error::ReaderError;
use crate::external::validate_external_url;

/// Upper bound on recursive bookmark nesting depth to protect against pathological PDFs.
const MAX_OUTLINE_DEPTH: usize = 64;

/// Upper bound on total outline nodes extracted from a single document.
const MAX_OUTLINE_ITEMS: usize = 50_000;

/// Minimum supported page width/height in PDF points to prevent degenerate scale factors.
const MIN_PAGE_POINTS: f32 = 1e-3;

/// Horizontal gap multiplier (in em units) above which a text line splits into separate
/// contiguous runs (e.g., separating multi-column gutters or adjacent table cells).
const RUN_SPLIT_GAP_EM: f32 = 1.5;

/// Minimum reference font size in points used when evaluating horizontal run splits.
const MIN_GAP_FONT_SIZE_PT: f32 = 4.0;

/// Vertical center offset threshold (as a fraction of line height) above which consecutive
/// characters without an explicit line break start a new visual line.
const LINE_BREAK_Y_THRESHOLD: f32 = 0.65;

/// Optional Tauri resource directory registered once at application startup.
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Process-wide `PDFium` singleton initialized lazily on first document open.
///
/// Storing `Pdfium` in a static `OnceLock` gives every open `PdfDocument<'static>` a valid
/// `'static` lifetime without self-referential structs and avoids cross-thread teardown races
/// during parallel test execution.
static PDFIUM: OnceLock<Result<Pdfium, String>> = OnceLock::new();

/// Registers Tauri's resolved resource directory so `PDFium` can locate the bundled
/// shared library (`pdfium.dll`) in packaged builds.
///
/// Subsequent calls after the first are ignored.
pub fn configure_resource_dir(dir: PathBuf) {
    let _ = RESOURCE_DIR.set(dir);
}

/// Single visible or whitespace character positioned in visual top-left page points.
#[derive(Debug, Clone, Copy)]
struct LineChar {
    ch: char,
    rect: PagePointsRect,
    size: f32,
}

/// Cached visual coordinate frame for projecting raw `PDFium` bottom-left page coordinates
/// into visual top-left page points and `[0.0, 1.0]` normalized rectangles.
#[derive(Debug, Clone, Copy)]
struct PageCoordinateFrame {
    visible_box: PdfRect,
    rotation: PdfPageRenderRotation,
    visual_width_pt: f32,
    visual_height_pt: f32,
}

impl PageCoordinateFrame {
    fn from_page(page: &PdfPage<'_>) -> Result<Self, ReaderError> {
        let (visual_width_pt, visual_height_pt) =
            validate_page_dimensions(page.width().value, page.height().value).ok_or_else(|| {
                ReaderError::Internal("page has invalid visual dimensions".to_owned())
            })?;

        let rotation = page.rotation().unwrap_or(PdfPageRenderRotation::None);
        let visible_box = resolve_visible_box(page, rotation, visual_width_pt, visual_height_pt)?;

        Ok(Self {
            visible_box,
            rotation,
            visual_width_pt,
            visual_height_pt,
        })
    }

    fn normalize_pdf_rect(self, rect: PdfRect) -> Option<NormalizedRect> {
        normalize_pdfium_rect(rect, self.visible_box, self.rotation)
    }

    fn normalize_pdf_dest_point(self, x: Option<f32>, y: Option<f32>) -> Option<NormalizedPoint> {
        normalize_pdfium_dest_point(x, y, self.visible_box, self.rotation)
    }

    fn to_visual_points(self, rect: PdfRect) -> Option<PagePointsRect> {
        let normalized = self.normalize_pdf_rect(rect)?;
        let left = normalized.x * self.visual_width_pt;
        let top = normalized.y * self.visual_height_pt;
        let right = (normalized.x + normalized.width) * self.visual_width_pt;
        let bottom = (normalized.y + normalized.height) * self.visual_height_pt;
        Some(PagePointsRect {
            left,
            top,
            right,
            bottom,
        })
    }
}

/// PDF document engine backed by dynamically bound `PDFium` via `pdfium-render`.
pub struct PdfBackend {
    document: PdfDocument<'static>,
    metadata: DocumentMetadata,
    page_dimensions: Vec<PageDimensions>,
}

impl PdfBackend {
    /// Opens a PDF document from `path` using `PDFium`.
    ///
    /// # Errors
    /// - Returns [`ReaderError::Io`] if the file cannot be opened or read.
    /// - Returns [`ReaderError::PasswordProtected`] if the PDF requires a user password.
    /// - Returns [`ReaderError::InvalidDocument`] if the file is corrupt or not a valid PDF.
    /// - Returns [`ReaderError::Internal`] if the `PDFium` dynamic library cannot be loaded.
    pub fn open(path: &Path) -> Result<Self, ReaderError> {
        let pdfium = get_pdfium()?;
        let file = File::open(path)?;
        if !file.metadata()?.is_file() {
            return Err(ReaderError::UnsupportedFormat(
                "non-regular file".to_owned(),
            ));
        }

        // Stream via `std::fs::File` (`FPDF_LoadCustomDocument`) so Windows Unicode paths,
        // `\\?\` verbatim paths, extensionless files, and large PDFs work without buffering
        // the entire file into memory.
        let document = pdfium
            .load_pdf_from_reader(file, None)
            .map_err(map_open_error)?;

        let pages = document.pages();
        let raw_count = pages.len();
        let page_count = usize::try_from(raw_count).map_err(|_| {
            ReaderError::InvalidDocument(format!("invalid PDF page count: {raw_count}"))
        })?;

        let mut page_dimensions = Vec::with_capacity(page_count);
        for index in 0..raw_count {
            let page = pages.get(index).map_err(map_open_error)?;
            let (width_pt, height_pt) =
                validate_page_dimensions(page.width().value, page.height().value).ok_or_else(
                    || ReaderError::InvalidDocument(format!("page {index} has invalid bounds")),
                )?;
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

        self.document.pages().get(pdf_index).map_err(|err| {
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
        let is_native_scale = clamped_w == width_px && clamped_h == height_px;

        let target_w = Pixels::try_from(clamped_w)
            .map_err(|err| ReaderError::Internal(format!("invalid render width: {err}")))?;
        let target_h = Pixels::try_from(clamped_h)
            .map_err(|err| ReaderError::Internal(format!("invalid render height: {err}")))?;

        // PDFium's AGG backend ignores `FPDF_LCD_TEXT` on alpha-enabled `BGRA` bitmaps, so we
        // render onto opaque `BGRx` cleared to `PdfColor::WHITE` (matching our `{ alpha: false }`
        // canvas) and enable LCD subpixel text AA whenever dimensions are 1:1 physical pixels.
        // Clamped bitmaps fall back to grayscale AA so CSS upscaling does not magnify RGB fringes.
        // `FPDF_REVERSE_BYTE_ORDER` still writes tightly packed `RGBA8` (`alpha == 255`) directly.
        let config = PdfRenderConfig::new()
            .set_fixed_size(target_w, target_h)
            .set_format(PdfBitmapFormat::BGRx)
            .set_clear_color(PdfColor::WHITE)
            .clear_before_rendering(true)
            .render_annotations(true)
            .render_form_data(true)
            .use_lcd_text_rendering(is_native_scale);

        let bitmap = page
            .render_with_config(&config)
            .map_err(|err| ReaderError::Internal(format!("failed to render page: {err}")))?;

        let actual_w = u32::try_from(bitmap.width())
            .map_err(|_| ReaderError::Internal("rendered bitmap width negative".to_owned()))?;
        let actual_h = u32::try_from(bitmap.height())
            .map_err(|_| ReaderError::Internal("rendered bitmap height negative".to_owned()))?;
        if actual_w != clamped_w || actual_h != clamped_h {
            return Err(ReaderError::Internal(format!(
                "rendered bitmap dimensions mismatch: expected {clamped_w}x{clamped_h}, got {actual_w}x{actual_h}"
            )));
        }

        let expected_len = usize::try_from(clamped_w)
            .ok()
            .and_then(|w| {
                usize::try_from(clamped_h)
                    .ok()
                    .and_then(|h| w.checked_mul(h))
            })
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| ReaderError::Internal("rendered bitmap size overflow".to_owned()))?;

        let rgba = bitmap.as_rgba_bytes();
        if rgba.len() != expected_len {
            return Err(ReaderError::Internal(format!(
                "rendered RGBA buffer length mismatch: expected {expected_len}, got {}",
                rgba.len()
            )));
        }

        Ok(RenderedPage {
            width_px: clamped_w,
            height_px: clamped_h,
            rgba,
        })
    }

    fn outline(&self) -> Result<Vec<OutlineItem>, ReaderError> {
        let mut visited = HashSet::new();
        let mut remaining = MAX_OUTLINE_ITEMS;
        Ok(collect_bookmark_siblings(
            self.document.bookmarks().root(),
            self.page_dimensions.len(),
            0,
            &mut visited,
            &mut remaining,
        ))
    }

    fn page_text(&self, page_index: usize) -> Result<Vec<TextSpan>, ReaderError> {
        let page = self.load_page(page_index)?;
        let frame = PageCoordinateFrame::from_page(&page)?;
        let text_page = page
            .text()
            .map_err(|err| ReaderError::Internal(format!("failed to extract page text: {err}")))?;

        let mut spans = Vec::new();
        let mut line_chars = Vec::new();
        let mut line_band: Option<(f32, f32)> = None;

        for ch in text_page.chars().iter() {
            let Some(value) = ch.unicode_char() else {
                continue;
            };

            if value == '\r' || value == '\n' {
                flush_visual_line(&mut line_chars, &mut line_band, frame, &mut spans);
                continue;
            }

            if value == '\u{FEFF}' || (value.is_control() && value != '\t') {
                continue;
            }

            if value.is_whitespace() {
                if !line_chars.is_empty() {
                    line_chars.push(LineChar {
                        ch: value,
                        rect: PagePointsRect {
                            left: 0.0,
                            top: 0.0,
                            right: 0.0,
                            bottom: 0.0,
                        },
                        size: 0.0,
                    });
                }
                continue;
            }

            let Ok(raw_rect) = ch.loose_bounds().or_else(|_| ch.tight_bounds()) else {
                continue;
            };
            let Some(rect) = frame.to_visual_points(raw_rect) else {
                continue;
            };

            let char_height = (rect.bottom - rect.top).abs();
            let char_mid_y = f32::midpoint(rect.top, rect.bottom);

            if let Some((band_top, band_bottom)) = line_band {
                let band_height = (band_bottom - band_top).abs().max(MIN_GAP_FONT_SIZE_PT);
                let band_mid_y = f32::midpoint(band_top, band_bottom);
                let ref_height = band_height.max(char_height);
                if (char_mid_y - band_mid_y).abs() > ref_height * LINE_BREAK_Y_THRESHOLD {
                    flush_visual_line(&mut line_chars, &mut line_band, frame, &mut spans);
                }
            }

            line_band = Some(match line_band {
                Some((band_top, band_bottom)) => {
                    (band_top.min(rect.top), band_bottom.max(rect.bottom))
                }
                None => (rect.top, rect.bottom),
            });

            let font_size = resolved_char_font_size(&ch, char_height);
            line_chars.push(LineChar {
                ch: value,
                rect,
                size: font_size,
            });
        }

        flush_visual_line(&mut line_chars, &mut line_band, frame, &mut spans);
        Ok(spans)
    }

    fn search(&self, query: &str) -> Result<Vec<SearchMatch>, ReaderError> {
        if query.trim().is_empty() || query.contains('\0') {
            return Ok(Vec::new());
        }

        let options = PdfSearchOptions::new()
            .match_case(false)
            .match_whole_word(false);
        let mut matches = Vec::new();

        for page_index in 0..self.page_dimensions.len() {
            let page = self.load_page(page_index)?;
            let frame = PageCoordinateFrame::from_page(&page)?;
            let text_page = page.text().map_err(|err| {
                ReaderError::Internal(format!("failed to load page {page_index} text: {err}"))
            })?;

            let search = text_page.search(query, &options).map_err(|err| {
                ReaderError::Internal(format!("failed to search page {page_index}: {err}"))
            })?;

            for segments in search.iter(PdfSearchDirection::SearchForward) {
                let rects: Vec<NormalizedRect> = segments
                    .iter()
                    .filter_map(|segment| {
                        let rect = frame.normalize_pdf_rect(segment.bounds())?;
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

    fn page_links(&self, page_index: usize) -> Result<Vec<PageLink>, ReaderError> {
        let page = self.load_page(page_index)?;
        let frame = PageCoordinateFrame::from_page(&page)?;
        let mut dest_frames: HashMap<usize, PageCoordinateFrame> = HashMap::new();
        let mut links = Vec::new();

        for annot in page.annotations().iter() {
            let Some(link_annot) = annot.as_link_annotation() else {
                continue;
            };
            if link_annot.is_hidden() {
                continue;
            }
            let Ok(link) = link_annot.link() else {
                continue;
            };

            let rects = extract_link_rects(link_annot, &link, frame);
            if rects.is_empty() {
                continue;
            }

            let Some(target) = self.resolve_link_target(&link, &mut dest_frames) else {
                continue;
            };

            links.push(PageLink { rects, target });
        }

        Ok(links)
    }
}

impl PdfBackend {
    fn resolve_link_target(
        &self,
        link: &PdfLink<'_>,
        dest_frames: &mut HashMap<usize, PageCoordinateFrame>,
    ) -> Option<LinkTarget> {
        if let Some(destination) = link.destination() {
            return self.build_internal_link_target(&destination, dest_frames);
        }

        let action = link.action()?;
        if let Some(local) = action.as_local_destination_action() {
            let destination = local.destination().ok()?;
            return self.build_internal_link_target(&destination, dest_frames);
        }

        if let Some(uri_action) = action.as_uri_action() {
            let raw_uri = uri_action.uri().ok()?;
            let validated = validate_external_url(&raw_uri).ok()?;
            return Some(LinkTarget::External {
                uri: validated.into(),
            });
        }

        None
    }

    fn build_internal_link_target(
        &self,
        destination: &PdfDestination<'_>,
        dest_frames: &mut HashMap<usize, PageCoordinateFrame>,
    ) -> Option<LinkTarget> {
        let raw_index = destination.page_index().ok()?;
        let page_index = usize::try_from(raw_index).ok()?;
        if page_index >= self.page_dimensions.len() {
            return None;
        }

        let frame = match dest_frames.entry(page_index) {
            Entry::Occupied(entry) => *entry.get(),
            Entry::Vacant(entry) => {
                let target_page = self.load_page(page_index).ok()?;
                let loaded_frame = PageCoordinateFrame::from_page(&target_page).ok()?;
                *entry.insert(loaded_frame)
            }
        };

        let (target_point, target_rect) = match destination.view_settings() {
            Ok(PdfDestinationViewSettings::SpecificCoordinatesAndZoom(x, y, _)) => (
                frame.normalize_pdf_dest_point(x.map(|p| p.value), y.map(|p| p.value)),
                None,
            ),
            Ok(
                PdfDestinationViewSettings::FitPageHorizontallyToWindow(top)
                | PdfDestinationViewSettings::FitBoundsHorizontallyToWindow(top),
            ) => (
                frame.normalize_pdf_dest_point(None, top.map(|p| p.value)),
                None,
            ),
            Ok(
                PdfDestinationViewSettings::FitPageVerticallyToWindow(left)
                | PdfDestinationViewSettings::FitBoundsVerticallyToWindow(left),
            ) => (
                frame.normalize_pdf_dest_point(left.map(|p| p.value), None),
                None,
            ),
            Ok(PdfDestinationViewSettings::FitPageToRectangle(rect)) => (
                None,
                frame.normalize_pdf_rect(rect).filter(|r| !r.is_empty()),
            ),
            Ok(
                PdfDestinationViewSettings::FitPageToWindow
                | PdfDestinationViewSettings::FitBoundsToWindow
                | PdfDestinationViewSettings::Unknown,
            )
            | Err(_) => (None, None),
        };

        Some(LinkTarget::Internal {
            page_index,
            target_point,
            target_rect,
        })
    }
}

fn extract_link_rects(
    link_annot: &pdfium_render::prelude::PdfPageLinkAnnotation<'_>,
    link: &PdfLink<'_>,
    frame: PageCoordinateFrame,
) -> Vec<NormalizedRect> {
    let mut rects: Vec<NormalizedRect> = link_annot
        .attachment_points()
        .iter()
        .filter_map(|quad| {
            let rect = frame.normalize_pdf_rect(quad.to_rect())?;
            (!rect.is_empty()).then_some(rect)
        })
        .collect();

    if rects.is_empty()
        && let Some(raw_rect) = link.rect().ok().or_else(|| link_annot.bounds().ok())
        && let Some(rect) = frame.normalize_pdf_rect(raw_rect)
        && !rect.is_empty()
    {
        rects.push(rect);
    }

    rects
}

fn normalize_pdfium_dest_point(
    x: Option<f32>,
    y: Option<f32>,
    visible_box: PdfRect,
    rotation: PdfPageRenderRotation,
) -> Option<NormalizedPoint> {
    if !is_valid_pdf_rect(visible_box) {
        return None;
    }

    let box_left = visible_box.left().value;
    let box_bottom = visible_box.bottom().value;
    let box_width = visible_box.right().value - box_left;
    let box_height = visible_box.top().value - box_bottom;

    let u_opt = x
        .filter(|v| v.is_finite())
        .map(|px| (px - box_left) / box_width);
    let v_opt = y
        .filter(|v| v.is_finite())
        .map(|py| (py - box_bottom) / box_height);

    if u_opt.is_none() && v_opt.is_none() {
        return None;
    }

    let (vis_x, vis_y) = match rotation {
        PdfPageRenderRotation::None => (u_opt.unwrap_or(0.0), v_opt.map_or(0.0, |v| 1.0 - v)),
        PdfPageRenderRotation::Degrees90 => (v_opt.unwrap_or(0.0), u_opt.unwrap_or(0.0)),
        PdfPageRenderRotation::Degrees180 => (u_opt.map_or(0.0, |u| 1.0 - u), v_opt.unwrap_or(0.0)),
        PdfPageRenderRotation::Degrees270 => (
            v_opt.map_or(0.0, |v| 1.0 - v),
            u_opt.map_or(0.0, |u| 1.0 - u),
        ),
    };

    Some(NormalizedPoint {
        x: vis_x.clamp(0.0, 1.0),
        y: vis_y.clamp(0.0, 1.0),
    })
}

fn get_pdfium() -> Result<&'static Pdfium, ReaderError> {
    let init = PDFIUM.get_or_init(init_pdfium);
    match init {
        Ok(pdfium) => Ok(pdfium),
        Err(message) => Err(ReaderError::Internal(message.clone())),
    }
}

fn init_pdfium() -> Result<Pdfium, String> {
    let candidates = collect_pdfium_library_candidates();
    let mut errors = Vec::new();

    for candidate in &candidates {
        if !candidate.is_file() {
            continue;
        }
        match Pdfium::bind_to_library(candidate) {
            Ok(bindings) => return Ok(Pdfium::new(bindings)),
            Err(err) => errors.push(format!("{}: {err}", candidate.display())),
        }
    }

    match Pdfium::bind_to_system_library() {
        Ok(bindings) => Ok(Pdfium::new(bindings)),
        Err(system_err) => {
            let attempted = if candidates.is_empty() {
                "none".to_owned()
            } else {
                candidates
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            let load_failures = if errors.is_empty() {
                String::new()
            } else {
                format!("; load errors: [{}]", errors.join("; "))
            };
            Err(format!(
                "failed to load PDFium library (checked [{attempted}]; system library error: {system_err}{load_failures}). Run `scripts/fetch-pdfium.ps1` or set `PDFIUM_LIB_PATH`."
            ))
        }
    }
}

fn collect_pdfium_library_candidates() -> Vec<PathBuf> {
    let lib_name = Pdfium::pdfium_platform_library_name();
    let mut candidates = Vec::new();

    for env_key in ["PDFIUM_LIB_PATH", "PDFIUM_DYNAMIC_LIB_PATH"] {
        if let Some(raw) = env::var_os(env_key).filter(|val| !val.is_empty()) {
            let env_path = PathBuf::from(raw);
            if env_path.is_dir() {
                push_unique_path(&mut candidates, env_path.join(&lib_name));
            } else {
                push_unique_path(&mut candidates, env_path);
            }
        }
    }

    if let Some(resource_dir) = RESOURCE_DIR.get() {
        push_unique_path(&mut candidates, resource_dir.join(&lib_name));
        push_unique_path(
            &mut candidates,
            resource_dir.join("resources").join(&lib_name),
        );
    }

    if let Ok(exe_path) = env::current_exe()
        && let Some(exe_dir) = exe_path.parent()
    {
        push_unique_path(&mut candidates, exe_dir.join(&lib_name));
    }

    // Only look inside the source-tree `resources/` directory in dev/test builds so
    // release binaries cannot silently fall back to the developer workspace.
    #[cfg(any(debug_assertions, test))]
    {
        push_unique_path(
            &mut candidates,
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join(&lib_name),
        );
    }

    candidates
}

fn push_unique_path(list: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !list.iter().any(|existing| existing == &candidate) {
        list.push(candidate);
    }
}

fn validate_page_dimensions(width_pt: f32, height_pt: f32) -> Option<(f32, f32)> {
    if !width_pt.is_finite()
        || !height_pt.is_finite()
        || width_pt < MIN_PAGE_POINTS
        || height_pt < MIN_PAGE_POINTS
    {
        return None;
    }

    Some((width_pt, height_pt))
}

fn resolve_visible_box(
    page: &PdfPage<'_>,
    rotation: PdfPageRenderRotation,
    visual_width_pt: f32,
    visual_height_pt: f32,
) -> Result<PdfRect, ReaderError> {
    let media = page.boundaries().media().ok().map(|b| b.bounds);
    let crop = page.boundaries().crop().ok().map(|b| b.bounds);

    let candidate = match (media, crop) {
        (Some(media_rect), Some(crop_rect)) => {
            intersect_pdf_rects(media_rect, crop_rect).unwrap_or(media_rect)
        }
        (None, Some(crop_rect)) => crop_rect,
        (Some(media_rect), None) => media_rect,
        (None, None) => {
            let (raw_w, raw_h) = match rotation {
                PdfPageRenderRotation::Degrees90 | PdfPageRenderRotation::Degrees270 => {
                    (visual_height_pt, visual_width_pt)
                }
                PdfPageRenderRotation::None | PdfPageRenderRotation::Degrees180 => {
                    (visual_width_pt, visual_height_pt)
                }
            };
            PdfRect::new_from_values(0.0, 0.0, raw_h, raw_w)
        }
    };

    if is_valid_pdf_rect(candidate) {
        Ok(candidate)
    } else {
        Err(ReaderError::Internal(
            "page visible boundary box is degenerate".to_owned(),
        ))
    }
}

fn intersect_pdf_rects(a: PdfRect, b: PdfRect) -> Option<PdfRect> {
    let left = a.left().value.max(b.left().value);
    let bottom = a.bottom().value.max(b.bottom().value);
    let right = a.right().value.min(b.right().value);
    let top = a.top().value.min(b.top().value);

    if right - left < MIN_PAGE_POINTS || top - bottom < MIN_PAGE_POINTS {
        return None;
    }

    Some(PdfRect::new_from_values(bottom, left, top, right))
}

fn is_valid_pdf_rect(rect: PdfRect) -> bool {
    let left = rect.left().value;
    let bottom = rect.bottom().value;
    let right = rect.right().value;
    let top = rect.top().value;

    left.is_finite()
        && bottom.is_finite()
        && right.is_finite()
        && top.is_finite()
        && (right - left) >= MIN_PAGE_POINTS
        && (top - bottom) >= MIN_PAGE_POINTS
}

/// Maps a bottom-left `PDFium` rectangle in raw PDF user-space points into a top-left
/// visual normalized `[0.0, 1.0]` rectangle accounting for `visible_box` (`CropBox` ∩ `MediaBox`)
/// and clockwise page `/Rotate`.
fn normalize_pdfium_rect(
    rect: PdfRect,
    visible_box: PdfRect,
    rotation: PdfPageRenderRotation,
) -> Option<NormalizedRect> {
    if !is_valid_pdf_rect(visible_box) {
        return None;
    }

    let r_left = rect.left().value;
    let r_bottom = rect.bottom().value;
    let r_right = rect.right().value;
    let r_top = rect.top().value;
    if !r_left.is_finite() || !r_bottom.is_finite() || !r_right.is_finite() || !r_top.is_finite() {
        return None;
    }

    let box_left = visible_box.left().value;
    let box_bottom = visible_box.bottom().value;
    let box_width = visible_box.right().value - box_left;
    let box_height = visible_box.top().value - box_bottom;

    let u0 = (r_left.min(r_right) - box_left) / box_width;
    let u1 = (r_left.max(r_right) - box_left) / box_width;
    let v0 = (r_bottom.min(r_top) - box_bottom) / box_height;
    let v1 = (r_bottom.max(r_top) - box_bottom) / box_height;

    let (vis_left, vis_right, vis_top, vis_bottom) = match rotation {
        PdfPageRenderRotation::None => (u0, u1, 1.0 - v1, 1.0 - v0),
        PdfPageRenderRotation::Degrees90 => (v0, v1, u0, u1),
        PdfPageRenderRotation::Degrees180 => (1.0 - u1, 1.0 - u0, v0, v1),
        PdfPageRenderRotation::Degrees270 => (1.0 - v1, 1.0 - v0, 1.0 - u1, 1.0 - u0),
    };

    let x0 = vis_left.min(vis_right).clamp(0.0, 1.0);
    let x1 = vis_left.max(vis_right).clamp(0.0, 1.0);
    let y0 = vis_top.min(vis_bottom).clamp(0.0, 1.0);
    let y1 = vis_top.max(vis_bottom).clamp(0.0, 1.0);

    let width = (x1 - x0).clamp(0.0, 1.0 - x0);
    let height = (y1 - y0).clamp(0.0, 1.0 - y0);

    Some(NormalizedRect {
        x: x0,
        y: y0,
        width,
        height,
    })
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

fn collect_bookmark_siblings<'a>(
    mut current: Option<PdfBookmark<'a>>,
    page_count: usize,
    depth: usize,
    visited: &mut HashSet<PdfBookmark<'a>>,
    remaining: &mut usize,
) -> Vec<OutlineItem> {
    if depth >= MAX_OUTLINE_DEPTH || *remaining == 0 {
        return Vec::new();
    }

    let mut items = Vec::new();
    while let Some(bookmark) = current {
        if *remaining == 0 || !visited.insert(bookmark.clone()) {
            break;
        }
        *remaining -= 1;

        let page_index = resolve_bookmark_page_index(&bookmark, page_count);
        let children = collect_bookmark_siblings(
            bookmark.first_child(),
            page_count,
            depth + 1,
            visited,
            remaining,
        );

        items.push(OutlineItem {
            title: bookmark.title().map_or_default(|raw| raw.trim().to_owned()),
            page_index,
            children,
        });

        current = bookmark.next_sibling();
    }

    items
}

fn resolve_bookmark_page_index(bookmark: &PdfBookmark<'_>, page_count: usize) -> Option<usize> {
    let raw_index = if let Some(destination) = bookmark.destination() {
        destination.page_index().ok()?
    } else {
        let action = bookmark.action()?;
        let destination = action.as_local_destination_action()?.destination().ok()?;
        destination.page_index().ok()?
    };

    let index = usize::try_from(raw_index).ok()?;
    (index < page_count).then_some(index)
}

fn resolved_char_font_size(
    ch: &pdfium_render::prelude::PdfPageTextChar<'_>,
    fallback_height: f32,
) -> f32 {
    let scaled = ch.scaled_font_size().value.abs();
    if scaled.is_finite() && scaled > 0.0 {
        return scaled;
    }

    let unscaled = ch.unscaled_font_size().value.abs();
    if unscaled.is_finite() && unscaled > 0.0 {
        return unscaled;
    }

    fallback_height.max(MIN_GAP_FONT_SIZE_PT)
}

fn flush_visual_line(
    line_chars: &mut Vec<LineChar>,
    line_band: &mut Option<(f32, f32)>,
    frame: PageCoordinateFrame,
    out: &mut Vec<TextSpan>,
) {
    if !line_chars.is_empty() {
        append_line_runs(
            line_chars,
            frame.visual_width_pt,
            frame.visual_height_pt,
            out,
        );
        line_chars.clear();
    }
    *line_band = None;
}

/// Groups positioned characters from a single visual text line into contiguous runs,
/// splitting only when a wide horizontal gap indicates a separate column or table cell.
fn append_line_runs(
    chars: &[LineChar],
    page_width_pt: f32,
    page_height_pt: f32,
    out: &mut Vec<TextSpan>,
) {
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
                flush_run(
                    &mut run_text,
                    &mut run_rect,
                    page_width_pt,
                    page_height_pt,
                    out,
                );
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

    flush_run(
        &mut run_text,
        &mut run_rect,
        page_width_pt,
        page_height_pt,
        out,
    );
}

fn flush_run(
    run_text: &mut String,
    run_rect: &mut Option<PagePointsRect>,
    page_width_pt: f32,
    page_height_pt: f32,
    out: &mut Vec<TextSpan>,
) {
    let text = std::mem::take(run_text);
    let Some(bounds) = run_rect.take() else {
        return;
    };
    if text.is_empty() {
        return;
    }
    if let Some(rect) = normalize_top_left_rect(bounds, page_width_pt, page_height_pt)
        && !rect.is_empty()
    {
        out.push(TextSpan { text, rect });
    }
}

fn map_open_error(err: PdfiumError) -> ReaderError {
    match err {
        PdfiumError::IoError(io_err) => ReaderError::Io(io_err),
        PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError) => {
            ReaderError::PasswordProtected
        }
        other => ReaderError::InvalidDocument(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;
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
            fs::create_dir_all(&path).expect("create temp test dir");
            Self { path }
        }

        fn write_file(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let file_path = self.path.join(name);
            fs::write(&file_path, bytes).expect("write test file");
            file_path
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
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

    fn assert_approx(actual: f32, expected: f32, tol: f32) {
        assert!(
            (actual - expected).abs() <= tol,
            "expected {expected} (±{tol}), got {actual}"
        );
    }

    /// Builds a minimal valid PDF 1.4 containing one visually upright Helvetica text line
    /// with customizable `/MediaBox`, optional `/CropBox`, `/Rotate`, and text matrix `tm`.
    fn build_synthetic_text_pdf(
        media_box: &str,
        crop_box: Option<&str>,
        rotate: u16,
        tm: &str,
        text: &str,
    ) -> Vec<u8> {
        let stream = format!("BT /F1 18 Tf {tm} Tm ({text}) Tj ET\n");
        let crop_entry = crop_box.map_or_default(|value| format!(" /CropBox [{value}]"));
        let rotate_entry = if rotate == 0 {
            String::new()
        } else {
            format!(" /Rotate {rotate}")
        };

        let objects = [
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_owned(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_owned(),
            format!(
                "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [{media_box}]{crop_entry}{rotate_entry} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n"
            ),
            "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n".to_owned(),
            format!(
                "5 0 obj\n<< /Length {} >>\nstream\n{stream}endstream\nendobj\n",
                stream.len()
            ),
        ];

        let mut out = String::from("%PDF-1.4\n");
        let mut offsets = Vec::with_capacity(objects.len());
        for obj in &objects {
            offsets.push(out.len());
            out.push_str(obj);
        }

        let xref_offset = out.len();
        let _ = writeln!(out, "xref\n0 {}", objects.len() + 1);
        out.push_str("0000000000 65535 f \n");
        for offset in offsets {
            let _ = writeln!(out, "{offset:010} 00000 n ");
        }
        let _ = writeln!(
            out,
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF",
            objects.len() + 1
        );

        out.into_bytes()
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
        append_line_runs(&chars, 500.0, 1000.0, &mut spans);

        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].text, "Hi all");
        assert_approx(spans[0].rect.x, 10.0 / 500.0, 1e-5);
        assert_approx(spans[0].rect.width, 31.0 / 500.0, 1e-5);
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
        append_line_runs(&chars, 500.0, 1000.0, &mut spans);

        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].text, "A1");
        assert_eq!(spans[1].text, "B2");
        assert_approx(spans[0].rect.x, 10.0 / 500.0, 1e-5);
        assert_approx(spans[1].rect.x, 200.0 / 500.0, 1e-5);
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
        append_line_runs(&chars, 500.0, 1000.0, &mut spans);

        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].text, "אב ג");
        assert_approx(spans[0].rect.x, 100.0 / 500.0, 1e-5);
        assert_approx(spans[0].rect.width, 28.0 / 500.0, 1e-5);
    }

    #[test]
    fn append_line_runs_skips_whitespace_only_lines() {
        let chars = [
            make_char(' ', 10.0, 14.0, 10.0),
            make_char('\t', 14.0, 22.0, 10.0),
        ];

        let mut spans = Vec::new();
        append_line_runs(&chars, 500.0, 1000.0, &mut spans);

        assert_eq!(spans, Vec::<TextSpan>::new());
    }

    #[test]
    fn validate_page_dimensions_rejects_subnormal_and_non_finite_values() {
        assert_eq!(validate_page_dimensions(1e-40, 100.0), None);
        assert_eq!(validate_page_dimensions(f32::INFINITY, 100.0), None);
        assert_eq!(validate_page_dimensions(f32::NAN, 100.0), None);
        assert_eq!(validate_page_dimensions(-10.0, 100.0), None);
        assert_eq!(validate_page_dimensions(612.0, 792.0), Some((612.0, 792.0)));
    }

    #[test]
    fn normalize_pdfium_rect_handles_crop_box_and_all_rotations() {
        // Visible crop box: width = 400 (x in 100..500), height = 600 (y in 50..650).
        // Target rect occupies u in [0.1, 0.3], v in [0.6, 0.8] (near top-left in unrotated space).
        let crop_box = PdfRect::new_from_values(50.0, 100.0, 650.0, 500.0);
        let rect = PdfRect::new_from_values(410.0, 140.0, 530.0, 220.0);

        let r0 = normalize_pdfium_rect(rect, crop_box, PdfPageRenderRotation::None).expect("r0");
        assert_approx(r0.x, 0.1, 1e-5);
        assert_approx(r0.y, 0.2, 1e-5);
        assert_approx(r0.width, 0.2, 1e-5);
        assert_approx(r0.height, 0.2, 1e-5);

        let r90 =
            normalize_pdfium_rect(rect, crop_box, PdfPageRenderRotation::Degrees90).expect("r90");
        assert_approx(r90.x, 0.6, 1e-5);
        assert_approx(r90.y, 0.1, 1e-5);
        assert_approx(r90.width, 0.2, 1e-5);
        assert_approx(r90.height, 0.2, 1e-5);

        let r180 =
            normalize_pdfium_rect(rect, crop_box, PdfPageRenderRotation::Degrees180).expect("r180");
        assert_approx(r180.x, 0.7, 1e-5);
        assert_approx(r180.y, 0.6, 1e-5);
        assert_approx(r180.width, 0.2, 1e-5);
        assert_approx(r180.height, 0.2, 1e-5);

        let r270 =
            normalize_pdfium_rect(rect, crop_box, PdfPageRenderRotation::Degrees270).expect("r270");
        assert_approx(r270.x, 0.2, 1e-5);
        assert_approx(r270.y, 0.7, 1e-5);
        assert_approx(r270.width, 0.2, 1e-5);
        assert_approx(r270.height, 0.2, 1e-5);
    }

    #[test]
    fn open_returns_password_protected_for_encrypted_pdf() {
        let dir = TempDirGuard::new("encrypted");

        // Minimal PDF 1.4 with Standard R=2 encryption dictionary whose empty-password hash mismatches.
        let pdf_bytes = concat!(
            "%PDF-1.4\n",
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n",
            "4 0 obj\n<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 ",
            "/O <0000000000000000000000000000000000000000000000000000000000000000> ",
            "/U <0000000000000000000000000000000000000000000000000000000000000000> >>\nendobj\n",
            "trailer\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [<0123456789ABCDEF> <0123456789ABCDEF>] >>\n",
            "startxref\n0\n%%EOF\n"
        );
        let pdf_path = dir.write_file("locked.pdf", pdf_bytes.as_bytes());

        let result = PdfBackend::open(&pdf_path);
        assert!(
            matches!(result, Err(ReaderError::PasswordProtected)),
            "expected PasswordProtected, got {:?}",
            result.err()
        );
    }

    #[test]
    fn render_page_handles_inverted_mediabox_cleanly() {
        let dir = TempDirGuard::new("inverted-mediabox");
        let pdf_bytes = concat!(
            "%PDF-1.4\n",
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [200 200 0 0] >>\nendobj\n",
            "trailer\n<< /Size 4 /Root 1 0 R >>\n",
            "startxref\n0\n%%EOF\n"
        );
        let pdf_path = dir.write_file("inverted.pdf", pdf_bytes.as_bytes());

        let mut backend = PdfBackend::open(&pdf_path).expect("inverted MediaBox opens");
        let rendered = backend
            .render_page(0, 64, 64)
            .expect("inverted MediaBox renders cleanly");

        assert_eq!(rendered.width_px, 64);
        assert_eq!(rendered.height_px, 64);
        assert_eq!(rendered.rgba.len(), 64 * 64 * 4);
    }

    #[test]
    fn open_supports_unicode_filename_via_stream_reader() {
        let dir = TempDirGuard::new("unicode-path");
        let pdf_bytes =
            build_synthetic_text_pdf("0 0 300 400", None, 0, "1 0 0 1 40 300", "Reader");
        let pdf_path = dir.write_file("Tài liệu tiếng Việt.pdf", &pdf_bytes);

        let backend = PdfBackend::open(&pdf_path).expect("Unicode Windows path should open");
        assert_eq!(backend.page_count(), 1);
    }

    #[test]
    fn text_and_search_coords_align_with_pdfium_device_transform_across_rotations_and_cropbox() {
        let dir = TempDirGuard::new("rotate-crop");

        // Each (rotate, Tm) pair places visually upright, left-to-right text inside CropBox [100 50 500 650].
        let cases = [
            (0_u16, "1 0 0 1 160 500"),
            (90, "0 1 -1 0 250 180"),
            (180, "-1 0 0 -1 420 200"),
            (270, "0 -1 1 0 250 520"),
        ];

        for (rotate, tm) in cases {
            let pdf_bytes = build_synthetic_text_pdf(
                "0 0 600 800",
                Some("100 50 500 650"),
                rotate,
                tm,
                "Hello",
            );
            let pdf_path = dir.write_file(&format!("rot-{rotate}.pdf"), &pdf_bytes);
            let backend = PdfBackend::open(&pdf_path).expect("synthetic PDF should open");

            // Compare normalized text/search bounds directly against PDFium's own
            // `FPDF_PageToDevice` projection onto a 1000x1000 virtual device grid.
            let page = backend.load_page(0).expect("load page 0");
            let device_config = PdfRenderConfig::new().set_fixed_size(1000, 1000);
            let text_page = page.text().expect("load text page");
            let page_chars = text_page.chars();
            let first_char = page_chars
                .iter()
                .find(|ch| ch.unicode_char() == Some('H'))
                .expect("find 'H'");
            let raw_bounds = first_char
                .loose_bounds()
                .or_else(|_| first_char.tight_bounds())
                .expect("char bounds");

            let (dx0, dy0) = page
                .points_to_pixels(raw_bounds.left(), raw_bounds.bottom(), &device_config)
                .expect("points_to_pixels corner 0");
            let (dx1, dy1) = page
                .points_to_pixels(raw_bounds.right(), raw_bounds.top(), &device_config)
                .expect("points_to_pixels corner 1");
            #[expect(
                clippy::cast_precision_loss,
                reason = "virtual device coordinates are bounded in 0..=1000"
            )]
            let expected_x = (dx0.min(dx1) as f32) / 1000.0;
            #[expect(
                clippy::cast_precision_loss,
                reason = "virtual device coordinates are bounded in 0..=1000"
            )]
            let expected_y = (dy0.min(dy1) as f32) / 1000.0;

            let frame = PageCoordinateFrame::from_page(&page).expect("frame");
            let normalized_h = frame
                .normalize_pdf_rect(raw_bounds)
                .expect("normalize 'H' bounds");

            assert_approx(normalized_h.x, expected_x, 0.005);
            assert_approx(normalized_h.y, expected_y, 0.005);

            let spans = backend.page_text(0).expect("extract page text");
            assert_eq!(spans.len(), 1, "rotate {rotate}: expected 1 span");
            assert_eq!(spans[0].text, "Hello");

            let matches = backend.search("hello").expect("search 'hello'");
            assert_eq!(matches.len(), 1, "rotate {rotate}: expected 1 search match");
            assert_eq!(matches[0].page_index, 0);
            assert_ne!(matches[0].rects.len(), 0);

            // Search highlight and text span should cover the same visual region.
            let span_rect = spans[0].rect;
            let match_rect = matches[0].rects[0];
            assert_approx(span_rect.x, match_rect.x, 0.03);
            assert_approx(span_rect.y, match_rect.y, 0.03);
        }
    }

    #[test]
    fn multipage_outline_render_and_search_work_end_to_end() {
        let dir = TempDirGuard::new("multipage-outline");

        let stream_p0 = "BT /F1 24 Tf 50 300 Td (Alpha Page) Tj ET\n";
        let stream_p1 = "BT /F1 24 Tf 50 300 Td (Beta Second) Tj ET\n";

        let objects = [
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R >>\nendobj\n".to_owned(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n".to_owned(),
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>\nendobj\n".to_owned(),
            "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>\nendobj\n".to_owned(),
            "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n".to_owned(),
            format!(
                "6 0 obj\n<< /Length {} >>\nstream\n{stream_p0}endstream\nendobj\n",
                stream_p0.len()
            ),
            format!(
                "7 0 obj\n<< /Length {} >>\nstream\n{stream_p1}endstream\nendobj\n",
                stream_p1.len()
            ),
            "8 0 obj\n<< /Type /Outlines /First 9 0 R /Last 11 0 R /Count 3 >>\nendobj\n".to_owned(),
            "9 0 obj\n<< /Title (Chapter 1) /Parent 8 0 R /Next 11 0 R /First 10 0 R /Last 10 0 R /Count 1 /Dest [3 0 R /Fit] >>\nendobj\n".to_owned(),
            "10 0 obj\n<< /Title (Section 1.1) /Parent 9 0 R /Dest [3 0 R /Fit] >>\nendobj\n".to_owned(),
            "11 0 obj\n<< /Title (Chapter 2) /Parent 8 0 R /Prev 9 0 R /Dest [4 0 R /Fit] >>\nendobj\n".to_owned(),
        ];

        let mut out = String::from("%PDF-1.4\n");
        let mut offsets = Vec::with_capacity(objects.len());
        for obj in &objects {
            offsets.push(out.len());
            out.push_str(obj);
        }
        let xref_offset = out.len();
        let _ = writeln!(out, "xref\n0 {}", objects.len() + 1);
        out.push_str("0000000000 65535 f \n");
        for offset in offsets {
            let _ = writeln!(out, "{offset:010} 00000 n ");
        }
        let _ = writeln!(
            out,
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF",
            objects.len() + 1
        );

        let pdf_path = dir.write_file("book.pdf", out.as_bytes());
        let mut backend = PdfBackend::open(&pdf_path).expect("multipage PDF should open");
        assert_eq!(backend.page_count(), 2);

        let outline = backend.outline().expect("outline should extract");
        assert_eq!(outline.len(), 2);
        assert_eq!(outline[0].title, "Chapter 1");
        assert_eq!(outline[0].page_index, Some(0));
        assert_eq!(outline[0].children.len(), 1);
        assert_eq!(outline[0].children[0].title, "Section 1.1");
        assert_eq!(outline[0].children[0].page_index, Some(0));
        assert_eq!(outline[1].title, "Chapter 2");
        assert_eq!(outline[1].page_index, Some(1));
        assert_eq!(outline[1].children.len(), 0);

        let rendered = backend.render_page(0, 150, 200).expect("render page 0");
        assert_eq!(rendered.width_px, 150);
        assert_eq!(rendered.height_px, 200);
        assert_eq!(rendered.rgba.len(), 150 * 200 * 4);
        // Top-left corner pixel is opaque white paper; page also contains darker text ink pixels.
        assert_eq!(&rendered.rgba[0..4], &[255, 255, 255, 255]);
        assert!(
            rendered
                .rgba
                .as_chunks::<4>()
                .0
                .iter()
                .any(|px| px[0] < 200 && px[3] == 255),
            "expected rendered page to contain opaque dark text ink pixels"
        );

        let matches = backend.search("second").expect("search page 1");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].page_index, 1);
        assert_ne!(matches[0].rects.len(), 0);
    }

    #[test]
    fn render_page_enables_lcd_subpixel_aa_at_native_size_with_opaque_alpha() {
        let dir = TempDirGuard::new("lcd-native");
        let pdf_bytes =
            build_synthetic_text_pdf("0 0 240 120", None, 0, "1 0 0 1 20 60", "Sharpness Test");
        let pdf_path = dir.write_file("lcd-native.pdf", &pdf_bytes);

        let mut backend = PdfBackend::open(&pdf_path).expect("synthetic PDF should open");
        let rendered = backend
            .render_page(0, 320, 160)
            .expect("native render succeeds");

        let pixels = rendered.rgba.as_chunks::<4>().0;
        assert!(
            pixels.iter().all(|px| px[3] == 255),
            "expected every rendered BGRx pixel to carry opaque alpha 255"
        );
        assert!(
            pixels.iter().any(|px| px[0] != px[1] || px[1] != px[2]),
            "expected LCD subpixel AA to produce chromatic edge pixels on native-scale black text"
        );
    }

    #[test]
    fn render_page_falls_back_to_grayscale_aa_when_dimensions_are_clamped() {
        let dir = TempDirGuard::new("lcd-clamped");
        let pdf_bytes =
            build_synthetic_text_pdf("0 0 240 40", None, 0, "1 0 0 1 10 12", "Clamped Text");
        let pdf_path = dir.write_file("lcd-clamped.pdf", &pdf_bytes);

        let mut backend = PdfBackend::open(&pdf_path).expect("synthetic PDF should open");
        // Exceed MAX_RENDER_SIDE_PX (4096) on width while keeping height small for a fast test.
        let rendered = backend
            .render_page(0, 4200, 80)
            .expect("clamped render succeeds");

        assert_eq!(rendered.width_px, super::super::MAX_RENDER_SIDE_PX);

        let pixels = rendered.rgba.as_chunks::<4>().0;
        assert!(
            pixels.iter().any(|px| px[0] < 200),
            "expected dark text ink pixels in clamped render"
        );
        assert!(
            pixels
                .iter()
                .all(|px| px[0] == px[1] && px[1] == px[2] && px[3] == 255),
            "expected clamped renders to disable LCD subpixel AA and stay pure grayscale"
        );
    }

    fn build_pdf_from_objects(objects: &[String]) -> Vec<u8> {
        let mut out = String::from("%PDF-1.4\n");
        let mut offsets = Vec::with_capacity(objects.len());
        for obj in objects {
            offsets.push(out.len());
            out.push_str(obj);
        }

        let xref_offset = out.len();
        let _ = writeln!(out, "xref\n0 {}", objects.len() + 1);
        out.push_str("0000000000 65535 f \n");
        for offset in offsets {
            let _ = writeln!(out, "{offset:010} 00000 n ");
        }
        let _ = writeln!(
            out,
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF",
            objects.len() + 1
        );

        out.into_bytes()
    }

    #[test]
    fn page_links_extracts_internal_quadpoints_external_and_filters_unsafe_or_hidden() {
        let dir = TempDirGuard::new("links-extract");
        let objects = [
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_owned(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n".to_owned(),
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Annots [5 0 R 6 0 R 7 0 R 8 0 R 9 0 R] >>\nendobj\n".to_owned(),
            "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>\nendobj\n".to_owned(),
            "5 0 obj\n<< /Type /Annot /Subtype /Link /Rect [50 300 180 330] /Dest [4 0 R /XYZ 60 250 0] >>\nendobj\n".to_owned(),
            "6 0 obj\n<< /Type /Annot /Subtype /Link /Rect [40 150 260 200] /QuadPoints [160 180 260 180 260 200 160 200 40 150 140 150 140 170 40 170] /A << /S /GoTo /D [4 0 R /FitH 300] >> >>\nendobj\n".to_owned(),
            "7 0 obj\n<< /Type /Annot /Subtype /Link /Rect [20 40 200 70] /A << /S /URI /URI (https://example.com/guide?p=1#top) >> >>\nendobj\n".to_owned(),
            "8 0 obj\n<< /Type /Annot /Subtype /Link /Rect [20 80 120 100] /A << /S /URI /URI (javascript:alert\\(1\\)) >> >>\nendobj\n".to_owned(),
            "9 0 obj\n<< /Type /Annot /Subtype /Link /F 2 /Rect [20 110 120 130] /A << /S /URI /URI (https://hidden.example.com/) >> >>\nendobj\n".to_owned(),
        ];

        let pdf_path = dir.write_file("links.pdf", &build_pdf_from_objects(&objects));
        let backend = PdfBackend::open(&pdf_path).expect("links PDF should open");

        let links = backend.page_links(0).expect("extract page 0 links");
        assert_eq!(links.len(), 3, "unsafe and hidden links must be excluded");

        assert_eq!(links[0].rects.len(), 1);
        assert_approx(links[0].rects[0].x, 50.0 / 300.0, 1e-4);
        assert_approx(links[0].rects[0].y, (400.0 - 330.0) / 400.0, 1e-4);
        assert_approx(links[0].rects[0].width, 130.0 / 300.0, 1e-4);
        assert_approx(links[0].rects[0].height, 30.0 / 400.0, 1e-4);
        assert_eq!(
            links[0].target,
            LinkTarget::Internal {
                page_index: 1,
                target_point: Some(NormalizedPoint {
                    x: 60.0 / 300.0,
                    y: (400.0 - 250.0) / 400.0,
                }),
                target_rect: None,
            }
        );

        assert_eq!(links[1].rects.len(), 2, "QuadPoints should yield 2 rects");
        assert_approx(links[1].rects[0].x, 160.0 / 300.0, 1e-4);
        assert_approx(links[1].rects[1].x, 40.0 / 300.0, 1e-4);
        assert_eq!(
            links[1].target,
            LinkTarget::Internal {
                page_index: 1,
                target_point: Some(NormalizedPoint {
                    x: 0.0,
                    y: (400.0 - 300.0) / 400.0,
                }),
                target_rect: None,
            }
        );

        assert_eq!(
            links[2].target,
            LinkTarget::External {
                uri: "https://example.com/guide?p=1#top".to_owned(),
            }
        );

        assert_eq!(
            backend.page_links(1).expect("page 1 links"),
            Vec::<PageLink>::new()
        );
        assert!(matches!(
            backend.page_links(2),
            Err(ReaderError::PageOutOfRange {
                page_index: 2,
                page_count: 2
            })
        ));
    }

    #[test]
    fn normalize_pdfium_dest_point_handles_cropbox_and_all_rotations() {
        // Visible crop box: width = 400 (x in 100..500), height = 600 (y in 50..650).
        // Point (x = 180 -> u = 0.2, y = 530 -> v = 0.8).
        let crop_box = PdfRect::new_from_values(50.0, 100.0, 650.0, 500.0);

        let p0 = normalize_pdfium_dest_point(
            Some(180.0),
            Some(530.0),
            crop_box,
            PdfPageRenderRotation::None,
        )
        .expect("p0");
        assert_approx(p0.x, 0.2, 1e-5);
        assert_approx(p0.y, 0.2, 1e-5);

        let p90 = normalize_pdfium_dest_point(
            Some(180.0),
            Some(530.0),
            crop_box,
            PdfPageRenderRotation::Degrees90,
        )
        .expect("p90");
        assert_approx(p90.x, 0.8, 1e-5);
        assert_approx(p90.y, 0.2, 1e-5);

        let p180 = normalize_pdfium_dest_point(
            Some(180.0),
            Some(530.0),
            crop_box,
            PdfPageRenderRotation::Degrees180,
        )
        .expect("p180");
        assert_approx(p180.x, 0.8, 1e-5);
        assert_approx(p180.y, 0.8, 1e-5);

        let p270 = normalize_pdfium_dest_point(
            Some(180.0),
            Some(530.0),
            crop_box,
            PdfPageRenderRotation::Degrees270,
        )
        .expect("p270");
        assert_approx(p270.x, 0.2, 1e-5);
        assert_approx(p270.y, 0.8, 1e-5);

        assert_eq!(
            normalize_pdfium_dest_point(None, None, crop_box, PdfPageRenderRotation::None),
            None
        );
    }

    #[test]
    fn page_links_align_with_cropbox_and_rotations_end_to_end() {
        let dir = TempDirGuard::new("links-rotate-crop");

        for rotate in [0_u16, 90, 180, 270] {
            let rotate_entry = if rotate == 0 {
                String::new()
            } else {
                format!(" /Rotate {rotate}")
            };
            let objects = [
                "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_owned(),
                "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_owned(),
                format!(
                    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /CropBox [100 50 500 650]{rotate_entry} /Annots [4 0 R] >>\nendobj\n"
                ),
                // u in [0.1, 0.3], v in [0.6, 0.8]
                "4 0 obj\n<< /Type /Annot /Subtype /Link /Rect [140 410 220 530] /Dest [3 0 R /FitR 140 410 220 530] >>\nendobj\n".to_owned(),
            ];
            let pdf_path = dir.write_file(
                &format!("link-rot-{rotate}.pdf"),
                &build_pdf_from_objects(&objects),
            );
            let backend = PdfBackend::open(&pdf_path).expect("rotated link PDF should open");
            let links = backend.page_links(0).expect("extract links");

            assert_eq!(links.len(), 1);
            let LinkTarget::Internal {
                page_index,
                target_rect,
                ..
            } = &links[0].target
            else {
                panic!("expected internal link target");
            };
            assert_eq!(*page_index, 0);
            let dest_rect = target_rect.expect("FitR should normalize target_rect");
            assert_eq!(links[0].rects[0], dest_rect);

            let (expected_x, expected_y) = match rotate {
                0 => (0.1, 0.2),
                90 => (0.6, 0.1),
                180 => (0.7, 0.6),
                270 => (0.2, 0.7),
                _ => unreachable!(),
            };
            assert_approx(links[0].rects[0].x, expected_x, 1e-4);
            assert_approx(links[0].rects[0].y, expected_y, 1e-4);
        }
    }
}
