//! Thin Tauri IPC command handlers delegating to [`crate::worker::DocumentWorker`]
//! and [`crate::state::AppState`].

use std::path::PathBuf;

use serde::Serialize;
use tauri::State;
use tauri::ipc::Response;

use crate::backend::{
    DocumentMetadata, OutlineItem, PageDimensions, PageLink, SearchMatch, TextSpan,
};
use crate::covers::{clamp_cover_max_side, read_cached_cover, write_cached_cover};
use crate::error::ReaderError;
use crate::external::open_external_url_blocking;
use crate::highlights::{CreateHighlightInput, HighlightColor, HighlightRecord, HighlightSegment};
use crate::state::{AppState, PersistedState, ReadingPosition, ZoomMode};
use crate::worker::canonicalize_document_path;

/// Payload returned to the frontend when a document is opened (or focused if already open).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpenDocumentResponse {
    /// Monotonic identifier for the open document tab.
    pub document_id: u64,
    /// Canonical filesystem path of the opened document.
    pub canonical_path: String,
    /// Content-derived `SHA-256` fingerprint identifying this document across moves/renames.
    pub document_fingerprint: String,
    /// Embedded document metadata.
    pub metadata: DocumentMetadata,
    /// Intrinsic page dimensions in PDF points for every page.
    pub page_dimensions: Vec<PageDimensions>,
    /// Last saved reading position for this file, if any.
    pub saved_position: Option<ReadingPosition>,
    /// `true` if the file was already open and its existing tab handle was returned.
    pub already_open: bool,
}

/// Consumes and returns the optional startup CLI / "Open With" file path once.
#[tauri::command(rename_all = "snake_case")]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri command extractor requires State by value"
)]
#[must_use]
pub fn get_initial_file(state: State<'_, AppState>) -> Option<String> {
    state.take_initial_file()
}

/// Returns the current persisted recent-files list and saved reading positions.
#[tauri::command(rename_all = "snake_case")]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri command extractor requires State by value"
)]
#[must_use]
pub fn get_persisted_state(state: State<'_, AppState>) -> PersistedState {
    state.persisted_snapshot()
}

/// Opens a document from `path` (or focuses an already-open tab with the same canonical path)
/// and updates the persisted recent-files list.
///
/// # Errors
/// Returns [`ReaderError`] if `path` is empty, missing, unsupported, password-protected,
/// or corrupt.
#[tauri::command(rename_all = "snake_case")]
pub async fn open_document(
    state: State<'_, AppState>,
    path: String,
) -> Result<OpenDocumentResponse, ReaderError> {
    validate_non_empty_path(&path)?;

    let opened = state.worker().open_document(PathBuf::from(path)).await?;
    let (saved_position, persist_result) = state.record_document_open(
        &opened.canonical_path,
        opened.metadata.title.as_deref(),
        opened.metadata.page_count,
    );

    if let Err(err) = persist_result {
        eprintln!("warning: failed to persist recent files after opening document: {err}");
    }

    Ok(OpenDocumentResponse {
        document_id: opened.document_id,
        canonical_path: opened.canonical_path.to_string_lossy().into_owned(),
        document_fingerprint: opened.document_fingerprint,
        metadata: opened.metadata,
        page_dimensions: opened.page_dimensions,
        saved_position,
        already_open: opened.already_open,
    })
}

/// Closes an open document tab and immediately releases its backend handles on the worker.
///
/// # Errors
/// Returns [`ReaderError::Internal`] if the worker thread is no longer running.
#[tauri::command(rename_all = "snake_case")]
pub async fn close_document(
    state: State<'_, AppState>,
    document_id: u64,
) -> Result<(), ReaderError> {
    state.worker().close_document(document_id).await
}

/// Rasterizes a single page and returns raw binary `[width: u32 LE][height: u32 LE][RGBA8]` bytes.
///
/// # Errors
/// - Returns [`ReaderError::InvalidDocument`] if requested dimensions are zero.
/// - Returns [`ReaderError::Cancelled`] if superseded by a newer render epoch or closed tab.
/// - Returns [`ReaderError::PageOutOfRange`] or [`ReaderError::Internal`] on render failure.
#[tauri::command(rename_all = "snake_case")]
pub async fn render_page(
    state: State<'_, AppState>,
    document_id: u64,
    page_index: usize,
    width_px: u32,
    height_px: u32,
    epoch: u64,
) -> Result<Response, ReaderError> {
    validate_render_dimensions(width_px, height_px)?;

    let rendered = state
        .worker()
        .render_page(document_id, page_index, width_px, height_px, epoch)
        .await?;

    Ok(Response::new(rendered.to_ipc_bytes()))
}

/// Extracts the nested table-of-contents outline tree for `document_id`.
///
/// # Errors
/// Returns [`ReaderError::DocumentNotFound`] if the tab is not open, or any backend error.
#[tauri::command(rename_all = "snake_case")]
pub async fn get_outline(
    state: State<'_, AppState>,
    document_id: u64,
) -> Result<Vec<OutlineItem>, ReaderError> {
    state.worker().get_outline(document_id).await
}

/// Extracts positioned text spans (in normalized `[0.0, 1.0]` coordinates) for one page.
///
/// # Errors
/// Returns [`ReaderError::DocumentNotFound`], [`ReaderError::PageOutOfRange`], or backend errors.
#[tauri::command(rename_all = "snake_case")]
pub async fn get_page_text(
    state: State<'_, AppState>,
    document_id: u64,
    page_index: usize,
) -> Result<Vec<TextSpan>, ReaderError> {
    state.worker().get_page_text(document_id, page_index).await
}

/// Searches `document_id` case-insensitively for `query` and returns normalized highlight regions.
///
/// # Errors
/// Returns [`ReaderError::DocumentNotFound`] if the tab is not open, or any backend error.
#[tauri::command(rename_all = "snake_case")]
pub async fn search_document(
    state: State<'_, AppState>,
    document_id: u64,
    query: String,
) -> Result<Vec<SearchMatch>, ReaderError> {
    state.worker().search_document(document_id, query).await
}

/// Atomically persists the active reading page and zoom configuration for `path`.
///
/// # Errors
/// - Returns [`ReaderError::InvalidDocument`] if `path` is empty or `zoom_scale` is invalid.
/// - Returns [`ReaderError::Io`] or [`ReaderError::Internal`] if persistence fails.
#[tauri::command(rename_all = "snake_case")]
pub async fn save_reading_state(
    state: State<'_, AppState>,
    path: String,
    page_index: usize,
    zoom_mode: ZoomMode,
    zoom_scale: f32,
) -> Result<(), ReaderError> {
    validate_non_empty_path(&path)?;
    validate_zoom_scale(zoom_scale)?;

    state.save_reading_state(
        &path,
        ReadingPosition {
            page_index,
            zoom_mode,
            zoom_scale,
        },
    )
}

/// Removes `path` from the persisted recent-files list and returns the updated state.
///
/// # Errors
/// - Returns [`ReaderError::InvalidDocument`] if `path` is empty.
/// - Returns [`ReaderError::Io`] or [`ReaderError::Internal`] if persistence fails.
#[tauri::command(rename_all = "snake_case")]
pub async fn remove_recent_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<PersistedState, ReaderError> {
    validate_non_empty_path(&path)?;
    state.remove_recent_file(&path)
}

/// Renders or serves from disk cache the first-page cover thumbnail for `path`
/// as `[width: u32 LE][height: u32 LE][RGBA8]`.
///
/// # Errors
/// - Returns [`ReaderError::InvalidDocument`] if `path` is empty or unreadable as a PDF.
/// - Returns [`ReaderError::Io`] if `path` does not exist.
/// - Returns [`ReaderError::UnsupportedFormat`], [`ReaderError::PasswordProtected`],
///   [`ReaderError::PageOutOfRange`], or [`ReaderError::Internal`] on render failure.
#[tauri::command(rename_all = "snake_case")]
pub async fn get_recent_cover(
    state: State<'_, AppState>,
    path: String,
    max_side_px: Option<u32>,
) -> Result<Response, ReaderError> {
    validate_non_empty_path(&path)?;
    let max_side = clamp_cover_max_side(max_side_px);
    let cache_dir = state.cover_cache_dir().to_path_buf();
    let raw_path = PathBuf::from(&path);

    let canonical_path =
        tauri::async_runtime::spawn_blocking(move || canonicalize_document_path(&raw_path))
            .await
            .map_err(|err| ReaderError::Internal(format!("cover canonicalize failed: {err}")))??;

    let cache_dir_for_read = cache_dir.clone();
    let canonical_for_read = canonical_path.clone();
    let cached = tauri::async_runtime::spawn_blocking(move || {
        let key = canonical_for_read.to_string_lossy();
        read_cached_cover(&cache_dir_for_read, &key, &canonical_for_read, max_side)
    })
    .await
    .map_err(|err| ReaderError::Internal(format!("cover cache read failed: {err}")))?;

    if let Some(page) = cached {
        return Ok(Response::new(page.to_ipc_bytes()));
    }

    let rendered = state
        .worker()
        .render_cover(canonical_path.clone(), max_side)
        .await?;
    let ipc_bytes = rendered.to_ipc_bytes();

    let write_result = tauri::async_runtime::spawn_blocking(move || {
        let key = canonical_path.to_string_lossy();
        write_cached_cover(&cache_dir, &key, &canonical_path, max_side, &rendered)
    })
    .await;

    match write_result {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            eprintln!("warning: failed to persist cover cache for {path}: {err}");
        }
        Err(err) => {
            eprintln!("warning: cover cache write task failed for {path}: {err}");
        }
    }

    Ok(Response::new(ipc_bytes))
}

/// Extracts clickable link annotations (in normalized `[0.0, 1.0]` coordinates) for one page.
///
/// # Errors
/// Returns [`ReaderError::DocumentNotFound`], [`ReaderError::PageOutOfRange`], or backend errors.
#[tauri::command(rename_all = "snake_case")]
pub async fn get_page_links(
    state: State<'_, AppState>,
    document_id: u64,
    page_index: usize,
) -> Result<Vec<PageLink>, ReaderError> {
    state.worker().get_page_links(document_id, page_index).await
}

/// Validates and opens an external URI (`http`, `https`, or `mailto`) in the default OS handler.
///
/// # Errors
/// - Returns [`ReaderError::UnsupportedUri`] if the URL is invalid or uses a disallowed scheme.
/// - Returns [`ReaderError::Io`] or [`ReaderError::Internal`] if launching the OS handler fails.
#[tauri::command(rename_all = "snake_case")]
pub async fn open_external_url(url: String) -> Result<(), ReaderError> {
    tauri::async_runtime::spawn_blocking(move || open_external_url_blocking(&url))
        .await
        .map_err(|err| ReaderError::Internal(format!("external URL task failed: {err}")))?
}

/// Loads all persisted highlights for a document identified by `fingerprint`.
///
/// # Errors
/// - Returns [`ReaderError::InvalidHighlight`] if `fingerprint` is malformed.
/// - Returns [`ReaderError::Io`] or [`ReaderError::Internal`] if disk I/O fails.
#[tauri::command(rename_all = "snake_case")]
pub async fn get_highlights(
    state: State<'_, AppState>,
    fingerprint: String,
) -> Result<Vec<HighlightRecord>, ReaderError> {
    let store = state.highlight_store();
    tauri::async_runtime::spawn_blocking(move || store.get(&fingerprint))
        .await
        .map_err(|err| ReaderError::Internal(format!("get highlights task failed: {err}")))?
}

/// Validates and atomically persists a new highlight for the document identified by `fingerprint`.
///
/// # Errors
/// - Returns [`ReaderError::InvalidHighlight`] if inputs fail validation, `id` collides, or the
///   per-document highlight limit is reached.
/// - Returns [`ReaderError::Io`] or [`ReaderError::Internal`] if persistence fails.
#[tauri::command(rename_all = "snake_case")]
pub async fn create_highlight(
    state: State<'_, AppState>,
    fingerprint: String,
    last_known_path: Option<String>,
    id: String,
    color: HighlightColor,
    segments: Vec<HighlightSegment>,
    quote: String,
) -> Result<HighlightRecord, ReaderError> {
    let store = state.highlight_store();
    tauri::async_runtime::spawn_blocking(move || {
        store.create(CreateHighlightInput {
            fingerprint,
            last_known_path,
            id,
            color,
            segments,
            quote,
        })
    })
    .await
    .map_err(|err| ReaderError::Internal(format!("create highlight task failed: {err}")))?
}

/// Updates the color of an existing highlight and persists the change atomically.
///
/// # Errors
/// - Returns [`ReaderError::InvalidHighlight`] if `fingerprint` or `id` is invalid, or if the
///   highlight does not exist.
/// - Returns [`ReaderError::Io`] or [`ReaderError::Internal`] if persistence fails.
#[tauri::command(rename_all = "snake_case")]
pub async fn update_highlight_color(
    state: State<'_, AppState>,
    fingerprint: String,
    id: String,
    color: HighlightColor,
) -> Result<HighlightRecord, ReaderError> {
    let store = state.highlight_store();
    tauri::async_runtime::spawn_blocking(move || store.update_color(&fingerprint, &id, color))
        .await
        .map_err(|err| {
            ReaderError::Internal(format!("update highlight color task failed: {err}"))
        })?
}

/// Deletes an existing highlight by `id` (idempotent) and removes the document JSON file when empty.
///
/// # Errors
/// - Returns [`ReaderError::InvalidHighlight`] if `fingerprint` or `id` is invalid.
/// - Returns [`ReaderError::Io`] or [`ReaderError::Internal`] if persistence or deletion fails.
#[tauri::command(rename_all = "snake_case")]
pub async fn delete_highlight(
    state: State<'_, AppState>,
    fingerprint: String,
    id: String,
) -> Result<bool, ReaderError> {
    let store = state.highlight_store();
    tauri::async_runtime::spawn_blocking(move || store.delete(&fingerprint, &id))
        .await
        .map_err(|err| ReaderError::Internal(format!("delete highlight task failed: {err}")))?
}

fn validate_non_empty_path(path: &str) -> Result<(), ReaderError> {
    if path.trim().is_empty() {
        return Err(ReaderError::InvalidDocument(
            "document path cannot be empty".to_owned(),
        ));
    }
    Ok(())
}

fn validate_render_dimensions(width_px: u32, height_px: u32) -> Result<(), ReaderError> {
    if width_px == 0 || height_px == 0 {
        return Err(ReaderError::InvalidDocument(
            "render dimensions must be greater than zero".to_owned(),
        ));
    }
    Ok(())
}

fn validate_zoom_scale(zoom_scale: f32) -> Result<(), ReaderError> {
    if !zoom_scale.is_finite() || zoom_scale <= 0.0 {
        return Err(ReaderError::InvalidDocument(
            "zoom scale must be a finite positive number".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_non_empty_path_rejects_blank_strings() {
        assert!(matches!(
            validate_non_empty_path(""),
            Err(ReaderError::InvalidDocument(_))
        ));
        assert!(matches!(
            validate_non_empty_path("   "),
            Err(ReaderError::InvalidDocument(_))
        ));
        assert!(validate_non_empty_path("book.pdf").is_ok());
    }

    #[test]
    fn validate_render_dimensions_rejects_zero_width_or_height() {
        assert!(matches!(
            validate_render_dimensions(0, 800),
            Err(ReaderError::InvalidDocument(_))
        ));
        assert!(matches!(
            validate_render_dimensions(600, 0),
            Err(ReaderError::InvalidDocument(_))
        ));
        assert!(validate_render_dimensions(600, 800).is_ok());
    }

    #[test]
    fn validate_zoom_scale_rejects_non_positive_or_non_finite_values() {
        assert!(matches!(
            validate_zoom_scale(0.0),
            Err(ReaderError::InvalidDocument(_))
        ));
        assert!(matches!(
            validate_zoom_scale(-1.0),
            Err(ReaderError::InvalidDocument(_))
        ));
        assert!(matches!(
            validate_zoom_scale(f32::NAN),
            Err(ReaderError::InvalidDocument(_))
        ));
        assert!(matches!(
            validate_zoom_scale(f32::INFINITY),
            Err(ReaderError::InvalidDocument(_))
        ));
        assert!(validate_zoom_scale(1.25).is_ok());
    }

    #[test]
    fn open_document_response_serializes_with_expected_snake_case_keys() {
        let response = OpenDocumentResponse {
            document_id: 7,
            canonical_path: "/docs/sample.pdf".to_owned(),
            document_fingerprint: "a".repeat(64),
            metadata: DocumentMetadata {
                title: Some("Sample".to_owned()),
                author: None,
                page_count: 12,
            },
            page_dimensions: vec![PageDimensions {
                width_pt: 612.0,
                height_pt: 792.0,
            }],
            saved_position: Some(ReadingPosition {
                page_index: 3,
                zoom_mode: ZoomMode::FitWidth,
                zoom_scale: 1.0,
            }),
            already_open: true,
        };

        let json = serde_json::to_value(&response).expect("serialize OpenDocumentResponse");

        assert_eq!(json["document_id"], 7);
        assert_eq!(json["canonical_path"], "/docs/sample.pdf");
        assert_eq!(json["document_fingerprint"], "a".repeat(64));
        assert_eq!(json["already_open"], true);
        assert_eq!(json["saved_position"]["page_index"], 3);
        assert_eq!(json["saved_position"]["zoom_mode"], "fit_width");
    }
}
