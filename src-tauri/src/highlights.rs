//! Document content fingerprinting (pure-Rust FIPS 180-4 `SHA-256`) and atomic
//! per-document JSON persistence for on-page text highlights.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::backend::NormalizedRect;
use crate::error::ReaderError;

/// Schema version for `<app_data_dir>/highlights/<fingerprint>.json`.
pub const HIGHLIGHTS_SCHEMA_VERSION: u32 = 1;

/// Maximum number of highlights permitted in a single document store file.
pub const MAX_HIGHLIGHTS_PER_DOCUMENT: usize = 5_000;

/// Maximum number of per-page segments permitted in a single highlight.
pub const MAX_SEGMENTS_PER_HIGHLIGHT: usize = 64;

/// Maximum number of normalized rectangles permitted in a single page segment.
pub const MAX_RECTS_PER_SEGMENT: usize = 512;

/// Maximum UTF-8 byte length stored for a highlight's quote text.
pub const MAX_QUOTE_BYTES: usize = 32_768;

/// Maximum ASCII byte length permitted for a highlight identifier.
pub const MAX_HIGHLIGHT_ID_BYTES: usize = 128;

const FINGERPRINT_DOMAIN_PREFIX: &[u8] = b"reader-fp-v1:";
const FINGERPRINT_SAMPLE_BYTES: usize = 65_536;
const FINGERPRINT_SAMPLE_LEN_U64: u64 = 65_536;
const FINGERPRINT_FULL_THRESHOLD: u64 = 3 * FINGERPRINT_SAMPLE_LEN_U64;

/// Fixed semantic highlight color options rendered over PDF pages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HighlightColor {
    /// Warm yellow highlighter fill (default).
    Yellow,
    /// Soft green highlighter fill.
    Green,
    /// Muted rose-pink highlighter fill.
    Pink,
}

/// Contiguous portion of a highlight residing on a single document page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HighlightSegment {
    /// Zero-based page index where `rects` are located.
    pub page_index: usize,
    /// Normalized `[0.0, 1.0]` rectangles covering highlighted runs on `page_index`.
    pub rects: Vec<NormalizedRect>,
}

/// Persisted user highlight record spanning one or more pages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HighlightRecord {
    /// Client-generated stable ASCII identifier (`[A-Za-z0-9_-]`).
    pub id: String,
    /// Active highlight color.
    pub color: HighlightColor,
    /// Page-ordered highlight segments (`1..=MAX_SEGMENTS_PER_HIGHLIGHT`).
    pub segments: Vec<HighlightSegment>,
    /// Pre-formatted passage text captured at creation time.
    pub quote: String,
    /// Creation timestamp in Unix seconds.
    pub created_at_unix: u64,
    /// Last modification timestamp in Unix seconds.
    pub updated_at_unix: u64,
}

/// On-disk JSON payload stored at `<app_data_dir>/highlights/<fingerprint>.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocumentHighlightsFile {
    /// Schema version (currently [`HIGHLIGHTS_SCHEMA_VERSION`]).
    pub version: u32,
    /// Content-derived 64-character lowercase hex `SHA-256` fingerprint.
    pub fingerprint: String,
    /// Most recent known canonical path for diagnostic traceability.
    pub last_known_path: Option<String>,
    /// Ordered list of persisted highlights for this document.
    #[serde(default)]
    pub highlights: Vec<HighlightRecord>,
}

/// Validated input payload used to create and persist a new [`HighlightRecord`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateHighlightInput {
    /// Target document content fingerprint (64 lowercase hex characters).
    pub fingerprint: String,
    /// Optional canonical document path recorded for traceability.
    pub last_known_path: Option<String>,
    /// Stable ASCII identifier (`[A-Za-z0-9_-]`, `1..=MAX_HIGHLIGHT_ID_BYTES`).
    pub id: String,
    /// Selected highlight color.
    pub color: HighlightColor,
    /// Non-empty per-page highlight geometry segments.
    pub segments: Vec<HighlightSegment>,
    /// Selected passage text (truncated cleanly on a UTF-8 boundary if oversized).
    pub quote: String,
}

/// Computes a deterministic 64-character lowercase hex `SHA-256` content fingerprint for `path`.
///
/// Files up to `192 KiB` (`196_608` bytes) are hashed in full; larger files hash exact `u64`
/// byte length plus `64 KiB` head, middle, and tail byte windows.
///
/// # Errors
/// - Returns [`ReaderError::Io`] if opening, statting, seeking, or reading `path` fails.
/// - Returns [`ReaderError::UnsupportedFormat`] if `path` is a directory or non-regular file.
pub fn compute_document_fingerprint(path: &Path) -> Result<String, ReaderError> {
    // Check path metadata before File::open because Windows rejects opening directories as files.
    let path_meta = fs::metadata(path)?;
    if path_meta.is_dir() {
        return Err(ReaderError::UnsupportedFormat("folder".to_owned()));
    }
    if !path_meta.is_file() {
        return Err(ReaderError::UnsupportedFormat(
            "non-regular file".to_owned(),
        ));
    }

    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(ReaderError::UnsupportedFormat(
            "non-regular file".to_owned(),
        ));
    }

    let file_len = metadata.len();
    let mut hasher = Sha256::new();
    hasher.update(FINGERPRINT_DOMAIN_PREFIX);
    hasher.update(&file_len.to_le_bytes());

    let mut buffer = vec![0_u8; FINGERPRINT_SAMPLE_BYTES];
    if file_len <= FINGERPRINT_FULL_THRESHOLD {
        loop {
            let read_bytes = file.read(&mut buffer)?;
            if read_bytes == 0 {
                break;
            }
            hasher.update(&buffer[..read_bytes]);
        }
    } else {
        let offsets = [
            0_u64,
            (file_len / 2).saturating_sub(FINGERPRINT_SAMPLE_LEN_U64 / 2),
            file_len.saturating_sub(FINGERPRINT_SAMPLE_LEN_U64),
        ];
        for offset in offsets {
            file.seek(SeekFrom::Start(offset))?;
            file.read_exact(&mut buffer)?;
            hasher.update(&buffer);
        }
    }

    let digest = hasher.finalize();
    Ok(encode_hex_lower(&digest))
}

/// Returns `true` if `fingerprint` is exactly 64 lowercase ASCII hex characters (`[0-9a-f]{64}`).
#[must_use]
pub fn is_valid_fingerprint(fingerprint: &str) -> bool {
    fingerprint.len() == 64
        && fingerprint
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Thread-safe, atomic per-document JSON persistence store for user highlights.
#[derive(Debug)]
pub struct HighlightStore {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl HighlightStore {
    /// Creates a new [`HighlightStore`] rooted at `dir` (`<app_data_dir>/highlights`).
    #[must_use]
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            lock: Mutex::new(()),
        }
    }

    /// Returns the base directory where per-document highlight JSON files are stored.
    #[must_use]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Loads all valid persisted highlights for `fingerprint`, returning an empty list if none exist
    /// or if the on-disk file is corrupt or uses an unsupported schema version.
    ///
    /// # Errors
    /// - Returns [`ReaderError::InvalidHighlight`] if `fingerprint` is malformed.
    /// - Returns [`ReaderError::Io`] if reading an existing file fails with a non-`NotFound` error.
    pub fn get(&self, fingerprint: &str) -> Result<Vec<HighlightRecord>, ReaderError> {
        validate_fingerprint(fingerprint)?;
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let file = self.load_file_or_empty(fingerprint)?;
        Ok(file.highlights)
    }

    /// Validates, timestamps, and atomically persists a new highlight record for a document.
    ///
    /// # Errors
    /// - Returns [`ReaderError::InvalidHighlight`] if the fingerprint, ID, or geometry is invalid,
    ///   if `id` already exists in the document, or if [`MAX_HIGHLIGHTS_PER_DOCUMENT`] is reached.
    /// - Returns [`ReaderError::Io`] or [`ReaderError::Internal`] if persistence fails.
    pub fn create(&self, input: CreateHighlightInput) -> Result<HighlightRecord, ReaderError> {
        validate_fingerprint(&input.fingerprint)?;
        validate_highlight_id(&input.id)?;
        let segments = sanitize_segments(input.segments)?;
        let quote = truncate_utf8_bytes(&input.quote, MAX_QUOTE_BYTES);

        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let mut file = self.load_file_or_empty(&input.fingerprint)?;

        if file
            .highlights
            .iter()
            .any(|existing| existing.id == input.id)
        {
            return Err(ReaderError::InvalidHighlight(format!(
                "highlight id '{}' already exists",
                input.id
            )));
        }

        if file.highlights.len() >= MAX_HIGHLIGHTS_PER_DOCUMENT {
            return Err(ReaderError::InvalidHighlight(format!(
                "document highlight limit ({MAX_HIGHLIGHTS_PER_DOCUMENT}) reached"
            )));
        }

        let now = now_unix_secs();
        let record = HighlightRecord {
            id: input.id,
            color: input.color,
            segments,
            quote,
            created_at_unix: now,
            updated_at_unix: now,
        };

        if let Some(path) = input.last_known_path {
            file.last_known_path = Some(path);
        }
        file.highlights.push(record.clone());

        let target_path = self.highlight_file_path(&input.fingerprint);
        save_file_atomic(&target_path, &file)?;

        Ok(record)
    }

    /// Updates the color and modification timestamp of an existing highlight identified by `id`.
    ///
    /// # Errors
    /// - Returns [`ReaderError::InvalidHighlight`] if `fingerprint` or `id` is invalid, or if no
    ///   matching highlight exists for `fingerprint`.
    /// - Returns [`ReaderError::Io`] or [`ReaderError::Internal`] if persistence fails.
    pub fn update_color(
        &self,
        fingerprint: &str,
        id: &str,
        color: HighlightColor,
    ) -> Result<HighlightRecord, ReaderError> {
        validate_fingerprint(fingerprint)?;
        validate_highlight_id(id)?;

        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let mut file = self.load_file_or_empty(fingerprint)?;

        let Some(existing) = file.highlights.iter_mut().find(|item| item.id == id) else {
            return Err(ReaderError::InvalidHighlight(format!(
                "highlight '{id}' not found"
            )));
        };

        existing.color = color;
        existing.updated_at_unix = now_unix_secs();
        let updated = existing.clone();

        let target_path = self.highlight_file_path(fingerprint);
        save_file_atomic(&target_path, &file)?;

        Ok(updated)
    }

    /// Deletes the highlight identified by `id` (idempotent) and removes the document JSON file
    /// from disk when the final highlight is deleted.
    ///
    /// Returns `true` if a highlight was removed, or `false` if `id` was not present.
    ///
    /// # Errors
    /// - Returns [`ReaderError::InvalidHighlight`] if `fingerprint` or `id` is invalid.
    /// - Returns [`ReaderError::Io`] or [`ReaderError::Internal`] if saving or deleting fails.
    pub fn delete(&self, fingerprint: &str, id: &str) -> Result<bool, ReaderError> {
        validate_fingerprint(fingerprint)?;
        validate_highlight_id(id)?;

        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let mut file = self.load_file_or_empty(fingerprint)?;

        let before = file.highlights.len();
        file.highlights.retain(|item| item.id != id);
        if file.highlights.len() == before {
            return Ok(false);
        }

        let target_path = self.highlight_file_path(fingerprint);
        if file.highlights.is_empty() {
            match fs::remove_file(&target_path) {
                Ok(()) => {}
                Err(err) if err.kind() == ErrorKind::NotFound => {}
                Err(err) => return Err(ReaderError::Io(err)),
            }
        } else {
            save_file_atomic(&target_path, &file)?;
        }

        Ok(true)
    }

    fn highlight_file_path(&self, fingerprint: &str) -> PathBuf {
        self.dir.join(format!("{fingerprint}.json"))
    }

    fn load_file_or_empty(&self, fingerprint: &str) -> Result<DocumentHighlightsFile, ReaderError> {
        let path = self.highlight_file_path(fingerprint);
        let raw = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == ErrorKind::NotFound => {
                return Ok(empty_highlights_file(fingerprint));
            }
            Err(err) => return Err(ReaderError::Io(err)),
        };

        let parsed: DocumentHighlightsFile = match serde_json::from_slice(&raw) {
            Ok(file) => file,
            Err(err) => {
                eprintln!(
                    "warning: malformed highlights file at {}: {err}; ignoring",
                    path.display()
                );
                return Ok(empty_highlights_file(fingerprint));
            }
        };

        if parsed.version != HIGHLIGHTS_SCHEMA_VERSION {
            eprintln!(
                "warning: unsupported highlights file version {} at {} (expected {HIGHLIGHTS_SCHEMA_VERSION}); ignoring",
                parsed.version,
                path.display()
            );
            return Ok(empty_highlights_file(fingerprint));
        }

        if parsed.fingerprint != fingerprint {
            eprintln!(
                "warning: highlights file fingerprint mismatch at {} (expected {fingerprint}, found {}); ignoring",
                path.display(),
                parsed.fingerprint
            );
            return Ok(empty_highlights_file(fingerprint));
        }

        let mut seen_ids = HashSet::new();
        let mut valid_highlights = Vec::with_capacity(parsed.highlights.len());
        let mut dropped_count = 0_usize;

        for record in parsed.highlights {
            if valid_highlights.len() >= MAX_HIGHLIGHTS_PER_DOCUMENT {
                dropped_count += 1;
                continue;
            }
            if let Some(sanitized) = sanitize_loaded_record(record)
                && seen_ids.insert(sanitized.id.clone())
            {
                valid_highlights.push(sanitized);
            } else {
                dropped_count += 1;
            }
        }

        if dropped_count > 0 {
            eprintln!(
                "warning: filtered {dropped_count} invalid or excess highlight record(s) from {}",
                path.display()
            );
        }

        Ok(DocumentHighlightsFile {
            version: HIGHLIGHTS_SCHEMA_VERSION,
            fingerprint: parsed.fingerprint,
            last_known_path: parsed.last_known_path,
            highlights: valid_highlights,
        })
    }
}

fn empty_highlights_file(fingerprint: &str) -> DocumentHighlightsFile {
    DocumentHighlightsFile {
        version: HIGHLIGHTS_SCHEMA_VERSION,
        fingerprint: fingerprint.to_owned(),
        last_known_path: None,
        highlights: Vec::new(),
    }
}

fn validate_fingerprint(fingerprint: &str) -> Result<(), ReaderError> {
    if !is_valid_fingerprint(fingerprint) {
        return Err(ReaderError::InvalidHighlight(
            "fingerprint must be 64 lowercase hex characters".to_owned(),
        ));
    }
    Ok(())
}

fn is_valid_highlight_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_HIGHLIGHT_ID_BYTES
        && id
            .bytes()
            .all(|byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-'))
}

fn validate_highlight_id(id: &str) -> Result<(), ReaderError> {
    if !is_valid_highlight_id(id) {
        return Err(ReaderError::InvalidHighlight(
            "highlight id must be 1..=128 ASCII [A-Za-z0-9_-] characters".to_owned(),
        ));
    }
    Ok(())
}

fn sanitize_segments(
    mut segments: Vec<HighlightSegment>,
) -> Result<Vec<HighlightSegment>, ReaderError> {
    if segments.is_empty() {
        return Err(ReaderError::InvalidHighlight(
            "highlight must contain at least one page segment".to_owned(),
        ));
    }
    if segments.len() > MAX_SEGMENTS_PER_HIGHLIGHT {
        return Err(ReaderError::InvalidHighlight(format!(
            "highlight exceeds maximum of {MAX_SEGMENTS_PER_HIGHLIGHT} segments"
        )));
    }

    segments.sort_by_key(|segment| segment.page_index);
    if segments
        .windows(2)
        .any(|pair| pair[0].page_index == pair[1].page_index)
    {
        return Err(ReaderError::InvalidHighlight(
            "highlight segments must not contain duplicate page_index entries".to_owned(),
        ));
    }

    let mut sanitized = Vec::with_capacity(segments.len());
    for segment in segments {
        if segment.rects.is_empty() {
            return Err(ReaderError::InvalidHighlight(format!(
                "segment on page {} must contain at least one rectangle",
                segment.page_index
            )));
        }
        if segment.rects.len() > MAX_RECTS_PER_SEGMENT {
            return Err(ReaderError::InvalidHighlight(format!(
                "segment on page {} exceeds maximum of {MAX_RECTS_PER_SEGMENT} rectangles",
                segment.page_index
            )));
        }

        let mut rects = Vec::with_capacity(segment.rects.len());
        for rect in segment.rects {
            rects.push(sanitize_rect(rect)?);
        }

        sanitized.push(HighlightSegment {
            page_index: segment.page_index,
            rects,
        });
    }

    Ok(sanitized)
}

fn sanitize_rect(rect: NormalizedRect) -> Result<NormalizedRect, ReaderError> {
    if !rect.x.is_finite()
        || !rect.y.is_finite()
        || !rect.width.is_finite()
        || !rect.height.is_finite()
    {
        return Err(ReaderError::InvalidHighlight(
            "highlight rectangle coordinates must be finite".to_owned(),
        ));
    }

    if rect.width <= 0.0 || rect.height <= 0.0 {
        return Err(ReaderError::InvalidHighlight(
            "highlight rectangle width and height must be positive".to_owned(),
        ));
    }

    let x0 = rect.x.clamp(0.0, 1.0);
    let x1 = (rect.x + rect.width).clamp(0.0, 1.0);
    let y0 = rect.y.clamp(0.0, 1.0);
    let y1 = (rect.y + rect.height).clamp(0.0, 1.0);

    let mut width = (x1 - x0).clamp(0.0, 1.0 - x0);
    let mut height = (y1 - y0).clamp(0.0, 1.0 - y0);

    // Ensure IEEE-754 rounding never pushes right/bottom edge past 1.0.
    while x0 + width > 1.0 && width > 0.0 {
        width = f32::from_bits(width.to_bits() - 1);
    }
    while y0 + height > 1.0 && height > 0.0 {
        height = f32::from_bits(height.to_bits() - 1);
    }

    let sanitized = NormalizedRect {
        x: x0,
        y: y0,
        width,
        height,
    };
    if sanitized.is_empty() {
        return Err(ReaderError::InvalidHighlight(
            "highlight rectangle is empty or outside page bounds".to_owned(),
        ));
    }

    Ok(sanitized)
}

fn sanitize_loaded_record(record: HighlightRecord) -> Option<HighlightRecord> {
    if !is_valid_highlight_id(&record.id) {
        return None;
    }
    let segments = sanitize_segments(record.segments).ok()?;
    let quote = truncate_utf8_bytes(&record.quote, MAX_QUOTE_BYTES);
    Some(HighlightRecord {
        id: record.id,
        color: record.color,
        segments,
        quote,
        created_at_unix: record.created_at_unix,
        updated_at_unix: record.updated_at_unix,
    })
}

fn truncate_utf8_bytes(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_owned();
    }

    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

fn save_file_atomic(target_path: &Path, file: &DocumentHighlightsFile) -> Result<(), ReaderError> {
    if let Some(parent) = target_path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }

    let tmp_path = temp_highlight_path(target_path);
    let payload = serde_json::to_vec_pretty(file).map_err(|err| {
        ReaderError::Internal(format!("failed to serialize highlights file: {err}"))
    })?;

    // Drop the temporary file handle before renaming so Windows does not reject rename.
    let write_result = (|| -> std::io::Result<()> {
        let mut tmp_file = File::create(&tmp_path)?;
        tmp_file.write_all(&payload)?;
        tmp_file.sync_all()?;
        Ok(())
    })();

    if let Err(err) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(ReaderError::Io(err));
    }

    if let Err(err) = fs::rename(&tmp_path, target_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(ReaderError::Io(err));
    }

    Ok(())
}

fn temp_highlight_path(path: &Path) -> PathBuf {
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    PathBuf::from(tmp)
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

fn encode_hex_lower(bytes: &[u8]) -> String {
    const HEX_LOWER: &[u8; 16] = b"0123456789abcdef";

    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(char::from(HEX_LOWER[usize::from(byte >> 4)]));
        out.push(char::from(HEX_LOWER[usize::from(byte & 0x0f)]));
    }
    out
}

/// Pure-Rust FIPS 180-4 `SHA-256` incremental hasher.
struct Sha256 {
    state: [u32; 8],
    total_bytes: u64,
    buffer: [u8; 64],
    buffer_len: usize,
}

impl Sha256 {
    const INITIAL_STATE: [u32; 8] = [
        0x6a09_e667,
        0xbb67_ae85,
        0x3c6e_f372,
        0xa54f_f53a,
        0x510e_527f,
        0x9b05_688c,
        0x1f83_d9ab,
        0x5be0_cd19,
    ];

    #[rustfmt::skip]
    const ROUND_CONSTANTS: [u32; 64] = [
        0x428a_2f98, 0x7137_4491, 0xb5c0_fbcf, 0xe9b5_dba5,
        0x3956_c25b, 0x59f1_11f1, 0x923f_82a4, 0xab1c_5ed5,
        0xd807_aa98, 0x1283_5b01, 0x2431_85be, 0x550c_7dc3,
        0x72be_5d74, 0x80de_b1fe, 0x9bdc_06a7, 0xc19b_f174,
        0xe49b_69c1, 0xefbe_4786, 0x0fc1_9dc6, 0x240c_a1cc,
        0x2de9_2c6f, 0x4a74_84aa, 0x5cb0_a9dc, 0x76f9_88da,
        0x983e_5152, 0xa831_c66d, 0xb003_27c8, 0xbf59_7fc7,
        0xc6e0_0bf3, 0xd5a7_9147, 0x06ca_6351, 0x1429_2967,
        0x27b7_0a85, 0x2e1b_2138, 0x4d2c_6dfc, 0x5338_0d13,
        0x650a_7354, 0x766a_0abb, 0x81c2_c92e, 0x9272_2c85,
        0xa2bf_e8a1, 0xa81a_664b, 0xc24b_8b70, 0xc76c_51a3,
        0xd192_e819, 0xd699_0624, 0xf40e_3585, 0x106a_a070,
        0x19a4_c116, 0x1e37_6c08, 0x2748_774c, 0x34b0_bcb5,
        0x391c_0cb3, 0x4ed8_aa4a, 0x5b9c_ca4f, 0x682e_6ff3,
        0x748f_82ee, 0x78a5_636f, 0x84c8_7814, 0x8cc7_0208,
        0x90be_fffa, 0xa450_6ceb, 0xbef9_a3f7, 0xc671_78f2,
    ];

    const fn new() -> Self {
        Self {
            state: Self::INITIAL_STATE,
            total_bytes: 0,
            buffer: [0_u8; 64],
            buffer_len: 0,
        }
    }

    fn update(&mut self, mut bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }

        let added = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        self.total_bytes = self.total_bytes.wrapping_add(added);

        if self.buffer_len > 0 {
            let take = (64 - self.buffer_len).min(bytes.len());
            self.buffer[self.buffer_len..self.buffer_len + take].copy_from_slice(&bytes[..take]);
            self.buffer_len += take;
            bytes = &bytes[take..];

            if self.buffer_len == 64 {
                Self::compress_block(&mut self.state, &self.buffer);
                self.buffer_len = 0;
            }
        }

        let (blocks, remainder) = bytes.as_chunks::<64>();
        for block in blocks {
            Self::compress_block(&mut self.state, block);
        }

        if !remainder.is_empty() {
            self.buffer[..remainder.len()].copy_from_slice(remainder);
            self.buffer_len = remainder.len();
        }
    }

    fn finalize(mut self) -> [u8; 32] {
        let bit_len = self.total_bytes.wrapping_mul(8);

        self.buffer[self.buffer_len] = 0x80;
        self.buffer_len += 1;

        if self.buffer_len > 56 {
            self.buffer[self.buffer_len..64].fill(0);
            Self::compress_block(&mut self.state, &self.buffer);
            self.buffer_len = 0;
        }

        self.buffer[self.buffer_len..56].fill(0);
        self.buffer[56..64].copy_from_slice(&bit_len.to_be_bytes());
        Self::compress_block(&mut self.state, &self.buffer);

        let mut digest = [0_u8; 32];
        let (out_chunks, _) = digest.as_chunks_mut::<4>();
        for (word, out_chunk) in self.state.iter().zip(out_chunks) {
            *out_chunk = word.to_be_bytes();
        }
        digest
    }

    fn compress_block(state: &mut [u32; 8], block: &[u8; 64]) {
        let mut schedule = [0_u32; 64];
        let (word_chunks, _) = block.as_chunks::<4>();
        for (slot, word_bytes) in schedule[..16].iter_mut().zip(word_chunks) {
            *slot = u32::from_be_bytes(*word_bytes);
        }

        for idx in 16..64 {
            let w15 = schedule[idx - 15];
            let w2 = schedule[idx - 2];
            let sigma0 = w15.rotate_right(7) ^ w15.rotate_right(18) ^ (w15 >> 3);
            let sigma1 = w2.rotate_right(17) ^ w2.rotate_right(19) ^ (w2 >> 10);
            schedule[idx] = schedule[idx - 16]
                .wrapping_add(sigma0)
                .wrapping_add(schedule[idx - 7])
                .wrapping_add(sigma1);
        }

        let [
            mut reg_a,
            mut reg_b,
            mut reg_c,
            mut reg_d,
            mut reg_e,
            mut reg_f,
            mut reg_g,
            mut reg_h,
        ] = *state;

        for (&round_k, &msg_w) in Self::ROUND_CONSTANTS.iter().zip(schedule.iter()) {
            let sigma1 = reg_e.rotate_right(6) ^ reg_e.rotate_right(11) ^ reg_e.rotate_right(25);
            let choice = (reg_e & reg_f) ^ ((!reg_e) & reg_g);
            let temp1 = reg_h
                .wrapping_add(sigma1)
                .wrapping_add(choice)
                .wrapping_add(round_k)
                .wrapping_add(msg_w);
            let sigma0 = reg_a.rotate_right(2) ^ reg_a.rotate_right(13) ^ reg_a.rotate_right(22);
            let majority = (reg_a & reg_b) ^ (reg_a & reg_c) ^ (reg_b & reg_c);
            let temp2 = sigma0.wrapping_add(majority);

            reg_h = reg_g;
            reg_g = reg_f;
            reg_f = reg_e;
            reg_e = reg_d.wrapping_add(temp1);
            reg_d = reg_c;
            reg_c = reg_b;
            reg_b = reg_a;
            reg_a = temp1.wrapping_add(temp2);
        }

        state[0] = state[0].wrapping_add(reg_a);
        state[1] = state[1].wrapping_add(reg_b);
        state[2] = state[2].wrapping_add(reg_c);
        state[3] = state[3].wrapping_add(reg_d);
        state[4] = state[4].wrapping_add(reg_e);
        state[5] = state[5].wrapping_add(reg_f);
        state[6] = state[6].wrapping_add(reg_g);
        state[7] = state[7].wrapping_add(reg_h);
    }
}

#[cfg(test)]
mod tests {
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
            let path =
                std::env::temp_dir().join(format!("reader-highlights-test-{label}-{pid}-{id}"));
            fs::create_dir_all(&path).expect("failed to create temp test dir");
            Self { path }
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        encode_hex_lower(&hasher.finalize())
    }

    fn sample_fingerprint() -> String {
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_owned()
    }

    fn sample_rect() -> NormalizedRect {
        NormalizedRect {
            x: 0.1,
            y: 0.2,
            width: 0.4,
            height: 0.02,
        }
    }

    fn sample_input(id: &str, color: HighlightColor) -> CreateHighlightInput {
        CreateHighlightInput {
            fingerprint: sample_fingerprint(),
            last_known_path: Some("/docs/book.pdf".to_owned()),
            id: id.to_owned(),
            color,
            segments: vec![HighlightSegment {
                page_index: 0,
                rects: vec![sample_rect()],
            }],
            quote: "Example highlighted text.".to_owned(),
        }
    }

    #[test]
    fn sha256_matches_nist_empty_vector() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn sha256_matches_nist_abc_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn sha256_matches_nist_448_bit_vector() {
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    #[test]
    fn sha256_matches_nist_one_million_a_vector() {
        let mut hasher = Sha256::new();
        let chunk = [b'a'; 1_000];
        for _ in 0..1_000 {
            hasher.update(&chunk);
        }
        let digest = encode_hex_lower(&hasher.finalize());
        assert_eq!(
            digest,
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }

    #[test]
    fn sha256_incremental_updates_match_single_shot() {
        let payload = vec![0x5a_u8; 200];
        let mut incremental = Sha256::new();
        for piece in payload.chunks(17) {
            incremental.update(piece);
        }
        assert_eq!(
            encode_hex_lower(&incremental.finalize()),
            sha256_hex(&payload)
        );
    }

    #[test]
    fn compute_document_fingerprint_survives_move_and_rename() {
        let dir = TempDirGuard::new("move-rename");
        let original = dir.path.join("original.pdf");
        let nested_dir = dir.path.join("archive");
        fs::create_dir_all(&nested_dir).expect("create nested dir");
        let renamed = nested_dir.join("renamed-copy.pdf");

        let bytes = b"%PDF-1.7\nhello world content for fingerprint stability";
        fs::write(&original, bytes).expect("write original file");
        let fp_before = compute_document_fingerprint(&original).expect("fingerprint original");

        fs::rename(&original, &renamed).expect("rename and move file");
        let fp_after = compute_document_fingerprint(&renamed).expect("fingerprint renamed");

        assert_eq!(fp_before, fp_after);
        assert!(is_valid_fingerprint(&fp_after));
    }

    #[test]
    fn compute_document_fingerprint_handles_empty_file_cleanly() {
        let dir = TempDirGuard::new("empty-file");
        let file_path = dir.path.join("empty.pdf");
        fs::write(&file_path, b"").expect("write empty file");

        let fp = compute_document_fingerprint(&file_path).expect("fingerprint empty file");
        assert!(is_valid_fingerprint(&fp));
    }

    #[test]
    fn compute_document_fingerprint_detects_any_byte_change_in_small_file() {
        let dir = TempDirGuard::new("small-diff");
        let file_path = dir.path.join("small.pdf");
        let mut bytes = vec![0x22_u8; 196_608]; // Exact 192 KiB threshold
        fs::write(&file_path, &bytes).expect("write small file");
        let fp_initial = compute_document_fingerprint(&file_path).expect("fingerprint initial");

        bytes[100_000] ^= 0x01;
        fs::write(&file_path, &bytes).expect("write mutated small file");
        let fp_mutated = compute_document_fingerprint(&file_path).expect("fingerprint mutated");

        assert_ne!(fp_initial, fp_mutated);
    }

    #[test]
    fn compute_document_fingerprint_detects_head_middle_tail_and_length_changes_in_large_file() {
        let dir = TempDirGuard::new("large-diff");
        let file_path = dir.path.join("large.pdf");
        let base = vec![0x33_u8; 300 * 1024];
        fs::write(&file_path, &base).expect("write large file");
        let fp_base = compute_document_fingerprint(&file_path).expect("fingerprint base");

        let mut head_mutated = base.clone();
        head_mutated[128] ^= 0xff;
        fs::write(&file_path, &head_mutated).expect("write head mutated");
        assert_ne!(
            fp_base,
            compute_document_fingerprint(&file_path).expect("fingerprint head")
        );

        let mut middle_mutated = base.clone();
        middle_mutated[base.len() / 2] ^= 0xff;
        fs::write(&file_path, &middle_mutated).expect("write middle mutated");
        assert_ne!(
            fp_base,
            compute_document_fingerprint(&file_path).expect("fingerprint middle")
        );

        let mut tail_mutated = base.clone();
        let tail_idx = tail_mutated.len() - 10;
        tail_mutated[tail_idx] ^= 0xff;
        fs::write(&file_path, &tail_mutated).expect("write tail mutated");
        assert_ne!(
            fp_base,
            compute_document_fingerprint(&file_path).expect("fingerprint tail")
        );

        let mut extended = base;
        extended.push(0x33);
        fs::write(&file_path, &extended).expect("write extended");
        assert_ne!(
            fp_base,
            compute_document_fingerprint(&file_path).expect("fingerprint extended")
        );
    }

    #[test]
    #[expect(
        clippy::permissions_set_readonly_false,
        reason = "clear Windows read-only attribute so TempDirGuard cleans up the temporary test file"
    )]
    fn compute_document_fingerprint_succeeds_on_readonly_file() {
        let dir = TempDirGuard::new("readonly-fp");
        let file_path = dir.path.join("readonly.pdf");
        fs::write(&file_path, b"%PDF-1.7\nread-only fixture bytes").expect("write test file");

        let mut perms = fs::metadata(&file_path)
            .expect("read initial metadata")
            .permissions();
        perms.set_readonly(true);
        fs::set_permissions(&file_path, perms).expect("mark readonly");

        let fp_result = compute_document_fingerprint(&file_path);

        // Clear read-only attribute before TempDirGuard cleanup on Windows.
        let mut reset_perms = fs::metadata(&file_path)
            .expect("read readonly metadata")
            .permissions();
        reset_perms.set_readonly(false);
        fs::set_permissions(&file_path, reset_perms).expect("restore writable");

        let fp = fp_result.expect("readonly file should fingerprint cleanly");
        assert!(is_valid_fingerprint(&fp));
    }

    #[test]
    fn compute_document_fingerprint_returns_io_for_missing_and_unsupported_for_directory() {
        let dir = TempDirGuard::new("errors");
        let missing = dir.path.join("missing.pdf");

        let missing_err = compute_document_fingerprint(&missing).unwrap_err();
        assert!(matches!(missing_err, ReaderError::Io(_)));

        let dir_err = compute_document_fingerprint(&dir.path).unwrap_err();
        assert!(matches!(dir_err, ReaderError::UnsupportedFormat(_)));
    }

    #[test]
    fn is_valid_fingerprint_rejects_traversal_uppercase_short_and_nul() {
        assert!(is_valid_fingerprint(&sample_fingerprint()));
        assert!(!is_valid_fingerprint("../evil"));
        assert!(!is_valid_fingerprint(
            "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF"
        ));
        assert!(!is_valid_fingerprint("0123456789abcdef"));
        assert!(!is_valid_fingerprint(&format!(
            "{}\0",
            &sample_fingerprint()[..63]
        )));
    }

    #[test]
    fn create_rejects_invalid_highlight_ids_and_malformed_fingerprints() {
        let dir = TempDirGuard::new("invalid-ids");
        let store = HighlightStore::new(dir.path.join("highlights"));

        let mut bad_fp = sample_input("valid-id_1", HighlightColor::Yellow);
        bad_fp.fingerprint = "../escape".to_owned();
        assert!(matches!(
            store.create(bad_fp),
            Err(ReaderError::InvalidHighlight(_))
        ));

        for invalid_id in [
            "",
            "bad id",
            "../bad",
            &"a".repeat(MAX_HIGHLIGHT_ID_BYTES + 1),
        ] {
            let input = sample_input(invalid_id, HighlightColor::Yellow);
            assert!(
                matches!(store.create(input), Err(ReaderError::InvalidHighlight(_))),
                "expected InvalidHighlight for id {invalid_id:?}"
            );
        }
    }

    #[test]
    fn create_rejects_invalid_segments_and_rects() {
        let dir = TempDirGuard::new("invalid-geometry");
        let store = HighlightStore::new(dir.path.join("highlights"));

        let mut empty_segments = sample_input("h-empty-seg", HighlightColor::Yellow);
        empty_segments.segments.clear();
        assert!(matches!(
            store.create(empty_segments),
            Err(ReaderError::InvalidHighlight(_))
        ));

        let mut too_many_segments = sample_input("h-too-many-seg", HighlightColor::Yellow);
        too_many_segments.segments = (0..=MAX_SEGMENTS_PER_HIGHLIGHT)
            .map(|page_index| HighlightSegment {
                page_index,
                rects: vec![sample_rect()],
            })
            .collect();
        assert!(matches!(
            store.create(too_many_segments),
            Err(ReaderError::InvalidHighlight(_))
        ));

        let mut dup_page = sample_input("h-dup-page", HighlightColor::Yellow);
        dup_page.segments.push(HighlightSegment {
            page_index: 0,
            rects: vec![sample_rect()],
        });
        assert!(matches!(
            store.create(dup_page),
            Err(ReaderError::InvalidHighlight(_))
        ));

        let mut empty_rects = sample_input("h-empty-rects", HighlightColor::Yellow);
        empty_rects.segments[0].rects.clear();
        assert!(matches!(
            store.create(empty_rects),
            Err(ReaderError::InvalidHighlight(_))
        ));

        let mut too_many_rects = sample_input("h-too-many-rects", HighlightColor::Yellow);
        too_many_rects.segments[0].rects = vec![sample_rect(); MAX_RECTS_PER_SEGMENT + 1];
        assert!(matches!(
            store.create(too_many_rects),
            Err(ReaderError::InvalidHighlight(_))
        ));

        for bad_rect in [
            NormalizedRect {
                x: 0.1,
                y: 0.1,
                width: 0.0,
                height: 0.02,
            },
            NormalizedRect {
                x: f32::NAN,
                y: 0.1,
                width: 0.2,
                height: 0.02,
            },
            NormalizedRect {
                x: 0.1,
                y: f32::INFINITY,
                width: 0.2,
                height: 0.02,
            },
            NormalizedRect {
                x: 1.0,
                y: 0.1,
                width: 0.2,
                height: 0.02,
            },
        ] {
            let mut input = sample_input("h-bad-rect", HighlightColor::Green);
            input.segments[0].rects = vec![bad_rect];
            assert!(
                matches!(store.create(input), Err(ReaderError::InvalidHighlight(_))),
                "expected InvalidHighlight for rect {bad_rect:?}"
            );
        }
    }

    #[test]
    fn create_sorts_segments_and_clamps_slightly_overshooting_rect() {
        let dir = TempDirGuard::new("sanitize-rect");
        let store = HighlightStore::new(dir.path.join("highlights"));

        let input = CreateHighlightInput {
            fingerprint: sample_fingerprint(),
            last_known_path: None,
            id: "h-sanitize".to_owned(),
            color: HighlightColor::Pink,
            segments: vec![
                HighlightSegment {
                    page_index: 3,
                    rects: vec![NormalizedRect {
                        x: 0.9,
                        y: 0.95,
                        width: 0.2,
                        height: 0.1,
                    }],
                },
                HighlightSegment {
                    page_index: 1,
                    rects: vec![NormalizedRect {
                        x: -0.05,
                        y: 0.2,
                        width: 0.25,
                        height: 0.05,
                    }],
                },
            ],
            quote: "Cross-page passage".to_owned(),
        };

        let created = store.create(input).expect("create clamped highlight");
        assert_eq!(created.segments[0].page_index, 1);
        assert_eq!(created.segments[1].page_index, 3);
        let first_rect = created.segments[0].rects[0];
        assert!((first_rect.x - 0.0).abs() < 1e-6);
        assert!((first_rect.width - 0.2).abs() < 1e-6);
        let second_rect = created.segments[1].rects[0];
        assert!(second_rect.x + second_rect.width <= 1.0);
        assert!(second_rect.y + second_rect.height <= 1.0);
    }

    #[test]
    fn create_rejects_duplicate_id_and_enforces_document_cap() {
        let dir = TempDirGuard::new("dup-and-cap");
        let store = HighlightStore::new(dir.path.join("highlights"));
        let fp = sample_fingerprint();

        store
            .create(sample_input("dup-id", HighlightColor::Yellow))
            .expect("first create should succeed");
        let dup_err = store
            .create(sample_input("dup-id", HighlightColor::Green))
            .unwrap_err();
        assert!(matches!(dup_err, ReaderError::InvalidHighlight(_)));

        // Pre-populate exactly MAX_HIGHLIGHTS_PER_DOCUMENT records to test cap efficiently.
        let mut records = Vec::with_capacity(MAX_HIGHLIGHTS_PER_DOCUMENT);
        for idx in 0..MAX_HIGHLIGHTS_PER_DOCUMENT {
            records.push(HighlightRecord {
                id: format!("id-{idx}"),
                color: HighlightColor::Yellow,
                segments: vec![HighlightSegment {
                    page_index: 0,
                    rects: vec![sample_rect()],
                }],
                quote: String::new(),
                created_at_unix: 1,
                updated_at_unix: 1,
            });
        }
        let full_file = DocumentHighlightsFile {
            version: HIGHLIGHTS_SCHEMA_VERSION,
            fingerprint: fp.clone(),
            last_known_path: None,
            highlights: records,
        };
        save_file_atomic(
            &dir.path.join("highlights").join(format!("{fp}.json")),
            &full_file,
        )
        .expect("write full highlights file");

        let cap_err = store
            .create(sample_input("one-too-many", HighlightColor::Pink))
            .unwrap_err();
        assert!(matches!(cap_err, ReaderError::InvalidHighlight(_)));
    }

    #[test]
    fn create_truncates_oversized_utf8_quote_on_char_boundary() {
        let dir = TempDirGuard::new("utf8-truncate");
        let store = HighlightStore::new(dir.path.join("highlights"));

        // 4-byte emoji repeated past MAX_QUOTE_BYTES, offset by 1 ASCII byte so MAX_QUOTE_BYTES
        // lands inside a multi-byte scalar value.
        let mut quote = String::from("a");
        while quote.len() <= MAX_QUOTE_BYTES + 16 {
            quote.push('🦀');
        }

        let mut input = sample_input("utf8-quote", HighlightColor::Yellow);
        input.quote = quote;

        let created = store.create(input).expect("create with truncated quote");
        assert!(created.quote.len() <= MAX_QUOTE_BYTES);
        assert!(created.quote.ends_with('🦀'));
    }

    #[test]
    fn store_create_get_update_delete_round_trip_leaves_no_tmp_and_cleans_empty_file() {
        let dir = TempDirGuard::new("crud");
        let highlights_dir = dir.path.join("highlights");
        let store = HighlightStore::new(highlights_dir.clone());
        let fp = sample_fingerprint();
        let json_path = highlights_dir.join(format!("{fp}.json"));
        let tmp_path = temp_highlight_path(&json_path);

        assert_eq!(
            store.get(&fp).expect("missing file returns empty"),
            Vec::new()
        );

        let created = store
            .create(sample_input("hl-1", HighlightColor::Yellow))
            .expect("create highlight");
        assert_eq!(created.color, HighlightColor::Yellow);
        assert!(json_path.is_file());
        assert!(!tmp_path.exists());

        let loaded = store.get(&fp).expect("get highlights");
        assert_eq!(loaded, vec![created.clone()]);

        let updated = store
            .update_color(&fp, "hl-1", HighlightColor::Pink)
            .expect("update color");
        assert_eq!(updated.color, HighlightColor::Pink);
        assert!(updated.updated_at_unix >= created.created_at_unix);
        assert!(!tmp_path.exists());

        let missing_update = store
            .update_color(&fp, "missing-id", HighlightColor::Green)
            .unwrap_err();
        assert!(matches!(missing_update, ReaderError::InvalidHighlight(_)));

        assert!(!store.delete(&fp, "missing-id").expect("idempotent delete"));
        assert!(json_path.is_file());

        assert!(store.delete(&fp, "hl-1").expect("delete last highlight"));
        assert!(!json_path.exists());
        assert!(!tmp_path.exists());
    }

    #[test]
    fn store_get_recovers_from_corrupt_json_unknown_version_and_mismatched_fingerprint() {
        let dir = TempDirGuard::new("recovery");
        let highlights_dir = dir.path.join("highlights");
        fs::create_dir_all(&highlights_dir).expect("create highlights dir");
        let store = HighlightStore::new(highlights_dir.clone());
        let fp = sample_fingerprint();
        let json_path = highlights_dir.join(format!("{fp}.json"));

        fs::write(&json_path, b"{ invalid json !").expect("write corrupt json");
        assert_eq!(store.get(&fp).expect("corrupt json recovers"), Vec::new());

        fs::write(
            &json_path,
            format!(r#"{{"version": 999, "fingerprint": "{fp}", "highlights": []}}"#),
        )
        .expect("write unknown version");
        assert_eq!(
            store.get(&fp).expect("unknown version recovers"),
            Vec::new()
        );

        let other_fp = "f".repeat(64);
        fs::write(
            &json_path,
            format!(r#"{{"version": 1, "fingerprint": "{other_fp}", "highlights": []}}"#),
        )
        .expect("write mismatched fingerprint");
        assert_eq!(
            store.get(&fp).expect("mismatched fingerprint recovers"),
            Vec::new()
        );
    }

    #[test]
    fn store_get_filters_corrupt_individual_records_without_dropping_valid_ones() {
        let dir = TempDirGuard::new("filter-records");
        let highlights_dir = dir.path.join("highlights");
        fs::create_dir_all(&highlights_dir).expect("create highlights dir");
        let store = HighlightStore::new(highlights_dir.clone());
        let fp = sample_fingerprint();

        let file = DocumentHighlightsFile {
            version: HIGHLIGHTS_SCHEMA_VERSION,
            fingerprint: fp.clone(),
            last_known_path: None,
            highlights: vec![
                HighlightRecord {
                    id: "../bad-id".to_owned(),
                    color: HighlightColor::Yellow,
                    segments: vec![HighlightSegment {
                        page_index: 0,
                        rects: vec![sample_rect()],
                    }],
                    quote: "bad".to_owned(),
                    created_at_unix: 10,
                    updated_at_unix: 10,
                },
                HighlightRecord {
                    id: "good-id".to_owned(),
                    color: HighlightColor::Green,
                    segments: vec![HighlightSegment {
                        page_index: 1,
                        rects: vec![sample_rect()],
                    }],
                    quote: "good".to_owned(),
                    created_at_unix: 20,
                    updated_at_unix: 20,
                },
            ],
        };
        save_file_atomic(&highlights_dir.join(format!("{fp}.json")), &file)
            .expect("write mixed records");

        let loaded = store.get(&fp).expect("load filtered records");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "good-id");
    }

    #[test]
    fn highlight_color_serializes_in_snake_case() {
        assert_eq!(
            serde_json::to_string(&HighlightColor::Yellow).expect("yellow"),
            "\"yellow\""
        );
        assert_eq!(
            serde_json::to_string(&HighlightColor::Green).expect("green"),
            "\"green\""
        );
        assert_eq!(
            serde_json::to_string(&HighlightColor::Pink).expect("pink"),
            "\"pink\""
        );
    }

    #[test]
    fn highlight_store_is_send_and_sync_static() {
        fn assert_send_sync<T: Send + Sync + 'static>() {}
        assert_send_sync::<HighlightStore>();
    }
}
