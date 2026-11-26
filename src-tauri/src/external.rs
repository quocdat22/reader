//! Validation and OS-delegated launching for external PDF URI links.

use url::Url;

use crate::error::ReaderError;

/// Maximum accepted length (in bytes) for an external URI passed over IPC.
const MAX_EXTERNAL_URL_BYTES: usize = 4096;

/// Parses and validates an external URI against the reader's strict scheme allowlist
/// (`http`, `https`, and `mailto`).
///
/// Rejects empty strings, embedded ASCII control characters, overly long URIs,
/// embedded authority credentials, and any non-allowlisted URI scheme.
///
/// # Errors
/// Returns [`ReaderError::UnsupportedUri`] if `raw` cannot be parsed or violates policy.
pub fn validate_external_url(raw: &str) -> Result<Url, ReaderError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ReaderError::UnsupportedUri(
            "external link URL cannot be empty".to_owned(),
        ));
    }

    if trimmed.len() > MAX_EXTERNAL_URL_BYTES {
        return Err(ReaderError::UnsupportedUri(
            "external link URL exceeds maximum length".to_owned(),
        ));
    }

    if trimmed.chars().any(char::is_control) {
        return Err(ReaderError::UnsupportedUri(
            "external link URL contains control characters".to_owned(),
        ));
    }

    let parsed = Url::parse(trimmed)
        .map_err(|err| ReaderError::UnsupportedUri(format!("invalid URL: {err}")))?;

    match parsed.scheme() {
        "http" | "https" => {
            if !parsed.has_host() || parsed.host_str().is_none_or(str::is_empty) {
                return Err(ReaderError::UnsupportedUri(
                    "HTTP/HTTPS link is missing a host".to_owned(),
                ));
            }
            if !parsed.username().is_empty() || parsed.password().is_some() {
                return Err(ReaderError::UnsupportedUri(
                    "external link URLs with embedded credentials are not allowed".to_owned(),
                ));
            }
            Ok(parsed)
        }
        "mailto" => {
            if parsed.has_host() || parsed.path().trim().is_empty() {
                return Err(ReaderError::UnsupportedUri(
                    "mailto link is missing a recipient address".to_owned(),
                ));
            }
            Ok(parsed)
        }
        other => Err(ReaderError::UnsupportedUri(format!(
            "scheme '{other}' is not allowed"
        ))),
    }
}

/// Validates `raw` and opens it in the user's default OS browser or mail handler.
///
/// # Errors
/// - Returns [`ReaderError::UnsupportedUri`] if `raw` fails scheme/syntax validation.
/// - Returns [`ReaderError::Io`] if launching the OS handler fails.
pub fn open_external_url_blocking(raw: &str) -> Result<(), ReaderError> {
    let parsed = validate_external_url(raw)?;
    open::that_detached(parsed.as_str()).map_err(ReaderError::Io)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_external_url_accepts_https_http_and_mailto() {
        let https = validate_external_url("  https://example.com/docs?page=2#sec1  ")
            .expect("https URL should validate");
        assert_eq!(https.as_str(), "https://example.com/docs?page=2#sec1");

        let http = validate_external_url("HTTP://localhost:8080/guide")
            .expect("http localhost URL should validate");
        assert_eq!(http.scheme(), "http");

        let mailto = validate_external_url("mailto:reader@example.com?subject=Feedback")
            .expect("mailto URL should validate");
        assert_eq!(mailto.scheme(), "mailto");
    }

    #[test]
    fn validate_external_url_rejects_disallowed_schemes() {
        for disallowed in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "smb://server/share/doc.pdf",
            "ms-msdt:/id",
            "ftp://example.com/file.pdf",
        ] {
            let err = validate_external_url(disallowed).unwrap_err();
            assert!(
                matches!(err, ReaderError::UnsupportedUri(_)),
                "expected UnsupportedUri for {disallowed}, got {err:?}"
            );
        }
    }

    #[test]
    fn validate_external_url_rejects_control_chars_empty_and_credentials() {
        for invalid in [
            "",
            "   ",
            "https://example.com/\nfoo",
            "https://example.com/\0",
            "https://user:pass@example.com/",
            "https://trusted.com@evil.com/",
            "https://",
            "mailto:",
            "mailto://host-not-allowed",
        ] {
            let err = validate_external_url(invalid).unwrap_err();
            assert!(
                matches!(err, ReaderError::UnsupportedUri(_)),
                "expected UnsupportedUri for {invalid:?}, got {err:?}"
            );
        }
    }

    #[test]
    fn validate_external_url_rejects_oversized_url() {
        let long_url = format!("https://example.com/{}", "a".repeat(MAX_EXTERNAL_URL_BYTES));
        let err = validate_external_url(&long_url).unwrap_err();
        assert!(matches!(err, ReaderError::UnsupportedUri(_)));
    }
}
