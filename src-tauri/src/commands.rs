//! Thin Tauri IPC command handlers delegating to [`crate::worker::DocumentWorker`]
//! and [`crate::state::AppState`].

use std::path::PathBuf;

use serde::Serialize;
use tauri::State;
use tauri::ipc::Response;

use crate::backend::{DocumentMetadata, OutlineItem, PageDimensions, SearchMatch, TextSpan};
use crate::error::ReaderError;
use crate::state::{AppState, PersistedState, ReadingPosition, ZoomMode};

/// Payload returned to the frontend when a document is opened (or focused if already open).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpenDocumentResponse {
    /// Monotonic identifier for the open document tab.
    pub document_id: u64,
    /// Canonical filesystem path of the opened document.
    pub canonical_path: String,
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
        assert_eq!(json["already_open"], true);
        assert_eq!(json["saved_position"]["page_index"], 3);
        assert_eq!(json["saved_position"]["zoom_mode"], "fit_width");
    }
}
