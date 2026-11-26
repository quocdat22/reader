//! Error types and IPC-serializable error responses for `reader_lib`.

use serde::{Serialize, Serializer};
use thiserror::Error;

/// Unified error type returned by all backend and worker operations.
#[derive(Debug, Error)]
pub enum ReaderError {
    /// Filesystem I/O failure (missing file, permission denied, read error).
    #[error("file I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// File format is not supported by any registered document backend.
    #[error("unsupported document format: {0}")]
    UnsupportedFormat(String),

    /// Document requires a password, which is not supported in v1.
    #[error("document is password-protected")]
    PasswordProtected,

    /// Document structure is corrupt or could not be parsed.
    #[error("invalid or unreadable document: {0}")]
    InvalidDocument(String),

    /// Requested zero-based page index does not exist in the document.
    #[error("page index {page_index} is out of range for document with {page_count} page(s)")]
    PageOutOfRange {
        /// Requested zero-based page index.
        page_index: usize,
        /// Total number of pages in the document.
        page_count: usize,
    },

    /// Requested document handle does not correspond to an open tab.
    #[error("document {0} is not open")]
    DocumentNotFound(u64),

    /// Render request was superseded by a newer epoch or a closed tab.
    #[error("render request cancelled")]
    Cancelled,

    /// External URI scheme or target is disallowed or invalid.
    #[error("unsupported or invalid URI: {0}")]
    UnsupportedUri(String),

    /// Unexpected internal backend or concurrency error.
    #[error("internal error: {0}")]
    Internal(String),
}

/// Stable JSON wire format for [`ReaderError`] returned across Tauri IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ErrorResponse {
    /// Machine-readable `snake_case` error code.
    pub code: &'static str,
    /// Human-readable description of what happened.
    pub message: String,
}

impl ReaderError {
    /// Returns the stable machine-readable error code for this error.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "io",
            Self::UnsupportedFormat(_) => "unsupported_format",
            Self::PasswordProtected => "password_protected",
            Self::InvalidDocument(_) => "invalid_document",
            Self::PageOutOfRange { .. } => "page_out_of_range",
            Self::DocumentNotFound(_) => "document_not_found",
            Self::Cancelled => "cancelled",
            Self::UnsupportedUri(_) => "unsupported_uri",
            Self::Internal(_) => "internal",
        }
    }

    /// Converts this error into an IPC-ready [`ErrorResponse`].
    #[must_use]
    pub fn to_response(&self) -> ErrorResponse {
        ErrorResponse {
            code: self.code(),
            message: self.to_string(),
        }
    }
}

impl Serialize for ReaderError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.to_response().serialize(serializer)
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::*;

    #[test]
    fn code_maps_every_variant_to_expected_snake_case_identifier() {
        let io_err = ReaderError::from(io::Error::new(io::ErrorKind::NotFound, "missing"));
        assert_eq!(io_err.code(), "io");
        assert_eq!(
            ReaderError::UnsupportedFormat("txt".into()).code(),
            "unsupported_format"
        );
        assert_eq!(ReaderError::PasswordProtected.code(), "password_protected");
        assert_eq!(
            ReaderError::InvalidDocument("corrupt".into()).code(),
            "invalid_document"
        );
        assert_eq!(
            ReaderError::PageOutOfRange {
                page_index: 5,
                page_count: 3,
            }
            .code(),
            "page_out_of_range"
        );
        assert_eq!(
            ReaderError::DocumentNotFound(42).code(),
            "document_not_found"
        );
        assert_eq!(ReaderError::Cancelled.code(), "cancelled");
        assert_eq!(
            ReaderError::UnsupportedUri("bad".into()).code(),
            "unsupported_uri"
        );
        assert_eq!(ReaderError::Internal("boom".into()).code(), "internal");
    }

    #[test]
    fn serialize_emits_code_and_message_json_object() {
        let err = ReaderError::PageOutOfRange {
            page_index: 10,
            page_count: 4,
        };

        let value = serde_json::to_value(&err).expect("ReaderError should serialize to JSON");

        assert_eq!(value["code"], "page_out_of_range");
        assert_eq!(
            value["message"],
            "page index 10 is out of range for document with 4 page(s)"
        );
    }

    #[test]
    fn error_is_send_and_sync_static() {
        fn assert_send_sync<T: Send + Sync + 'static>() {}
        assert_send_sync::<ReaderError>();
    }
}
