//! Disk cache and proportional sizing helpers for Recent-list cover previews.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::backend::{PageDimensions, RenderedPage};
use crate::error::ReaderError;

/// Minimum allowed cover thumbnail max-side resolution in pixels.
pub const MIN_COVER_MAX_SIDE_PX: u32 = 32;

/// Default cover thumbnail max-side resolution in pixels (crisp up to 3x `HiDPI` for ~52px slots).
pub const DEFAULT_COVER_MAX_SIDE_PX: u32 = 160;

/// Maximum allowed cover thumbnail max-side resolution in pixels.
pub const MAX_COVER_MAX_SIDE_PX: u32 = 256;

const COVER_CACHE_MAGIC: &[u8; 4] = b"RCOV";
const COVER_CACHE_VERSION: u32 = 1;
const COVER_HEADER_BYTES: usize = 40;

/// Clamps an optional requested `max_side_px` into `MIN_COVER_MAX_SIDE_PX..=MAX_COVER_MAX_SIDE_PX`.
#[must_use]
pub fn clamp_cover_max_side(max_side_px: Option<u32>) -> u32 {
    max_side_px
        .unwrap_or(DEFAULT_COVER_MAX_SIDE_PX)
        .clamp(MIN_COVER_MAX_SIDE_PX, MAX_COVER_MAX_SIDE_PX)
}

/// Computes target `(width_px, height_px)` fitting proportionally inside `max_side_px`.
#[must_use]
pub fn compute_cover_dimensions(page: PageDimensions, max_side_px: u32) -> (u32, u32) {
    let max_side = max_side_px.clamp(MIN_COVER_MAX_SIDE_PX, MAX_COVER_MAX_SIDE_PX);

    if !page.width_pt.is_finite()
        || !page.height_pt.is_finite()
        || page.width_pt <= 0.0
        || page.height_pt <= 0.0
    {
        return (max_side, max_side);
    }

    let width_pt = f64::from(page.width_pt);
    let height_pt = f64::from(page.height_pt);
    let target = f64::from(max_side);

    if width_pt >= height_pt {
        let scaled_h = ((height_pt / width_pt) * target).round();
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "scaled_h is finite and bounded in 0.0..=MAX_COVER_MAX_SIDE_PX"
        )]
        let height = (scaled_h as u32).clamp(1, max_side);
        (max_side, height)
    } else {
        let scaled_w = ((width_pt / height_pt) * target).round();
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "scaled_w is finite and bounded in 0.0..=MAX_COVER_MAX_SIDE_PX"
        )]
        let width = (scaled_w as u32).clamp(1, max_side);
        (width, max_side)
    }
}

/// Returns the deterministic `.cover` cache file path for `key_path` inside `cache_dir`.
#[must_use]
pub fn cover_cache_path(cache_dir: &Path, key_path: &str) -> PathBuf {
    let hash = fnv1a_128_path(key_path);
    cache_dir.join(format!("{hash:032x}.cover"))
}

/// Attempts to read a fresh cached cover bitmap for `source_path`.
///
/// Returns `None` if the cache file is missing, corrupt, targets a different `max_side_px`,
/// or if `source_path`'s size or modification timestamp changed.
#[must_use]
pub fn read_cached_cover(
    cache_dir: &Path,
    key_path: &str,
    source_path: &Path,
    max_side_px: u32,
) -> Option<RenderedPage> {
    let clamped_max_side = clamp_cover_max_side(Some(max_side_px));
    let (expected_len, expected_secs, expected_nanos) = source_fingerprint(source_path)?;
    let cache_path = cover_cache_path(cache_dir, key_path);
    let bytes = fs::read(&cache_path).ok()?;

    if bytes.len() < COVER_HEADER_BYTES || &bytes[0..4] != COVER_CACHE_MAGIC {
        return None;
    }

    let version = read_u32_le(&bytes, 4)?;
    if version != COVER_CACHE_VERSION {
        return None;
    }

    let file_len = read_u64_le(&bytes, 8)?;
    let mtime_secs = read_u64_le(&bytes, 16)?;
    let mtime_nanos = read_u32_le(&bytes, 24)?;
    let cached_max_side = read_u32_le(&bytes, 28)?;
    let width_px = read_u32_le(&bytes, 32)?;
    let height_px = read_u32_le(&bytes, 36)?;

    if file_len != expected_len
        || mtime_secs != expected_secs
        || mtime_nanos != expected_nanos
        || cached_max_side != clamped_max_side
    {
        return None;
    }

    if width_px == 0
        || height_px == 0
        || width_px > MAX_COVER_MAX_SIDE_PX
        || height_px > MAX_COVER_MAX_SIDE_PX
    {
        return None;
    }

    let expected_rgba_len = usize::try_from(width_px)
        .ok()
        .and_then(|w| {
            usize::try_from(height_px)
                .ok()
                .and_then(|h| w.checked_mul(h))
        })
        .and_then(|pixels| pixels.checked_mul(4))?;

    if bytes.len() != COVER_HEADER_BYTES + expected_rgba_len {
        return None;
    }

    Some(RenderedPage {
        width_px,
        height_px,
        rgba: bytes[COVER_HEADER_BYTES..].to_vec(),
    })
}

/// Atomically persists `page` into the disk cover cache for `source_path`.
///
/// # Errors
/// Returns [`ReaderError::Io`] if directory creation, file writing, flushing, or renaming fails.
pub fn write_cached_cover(
    cache_dir: &Path,
    key_path: &str,
    source_path: &Path,
    max_side_px: u32,
    page: &RenderedPage,
) -> Result<(), ReaderError> {
    let Some((file_len, mtime_secs, mtime_nanos)) = source_fingerprint(source_path) else {
        return Ok(());
    };

    let clamped_max_side = clamp_cover_max_side(Some(max_side_px));
    fs::create_dir_all(cache_dir)?;

    let cache_path = cover_cache_path(cache_dir, key_path);
    let tmp_path = temp_cover_path(&cache_path);

    let mut payload = Vec::with_capacity(COVER_HEADER_BYTES + page.rgba.len());
    payload.extend_from_slice(COVER_CACHE_MAGIC);
    payload.extend_from_slice(&COVER_CACHE_VERSION.to_le_bytes());
    payload.extend_from_slice(&file_len.to_le_bytes());
    payload.extend_from_slice(&mtime_secs.to_le_bytes());
    payload.extend_from_slice(&mtime_nanos.to_le_bytes());
    payload.extend_from_slice(&clamped_max_side.to_le_bytes());
    payload.extend_from_slice(&page.width_px.to_le_bytes());
    payload.extend_from_slice(&page.height_px.to_le_bytes());
    payload.extend_from_slice(&page.rgba);

    // Drop the temporary file handle before renaming so Windows does not reject rename.
    let write_result = (|| -> std::io::Result<()> {
        let mut file = File::create(&tmp_path)?;
        file.write_all(&payload)?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(err) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(ReaderError::Io(err));
    }

    if let Err(err) = fs::rename(&tmp_path, &cache_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(ReaderError::Io(err));
    }

    Ok(())
}

/// Best-effort removal of cached cover files associated with `path` (and `canonical_alt`).
pub fn remove_cached_cover(cache_dir: &Path, path: &str, canonical_alt: Option<&str>) {
    let raw_cache = cover_cache_path(cache_dir, path);
    let _ = fs::remove_file(&raw_cache);

    if let Some(alt) = canonical_alt {
        let alt_cache = cover_cache_path(cache_dir, alt);
        if alt_cache != raw_cache {
            let _ = fs::remove_file(&alt_cache);
        }
    }
}

fn source_fingerprint(source_path: &Path) -> Option<(u64, u64, u32)> {
    let metadata = fs::metadata(source_path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let modified = metadata.modified().ok()?;
    let duration = modified.duration_since(UNIX_EPOCH).unwrap_or_default();
    Some((metadata.len(), duration.as_secs(), duration.subsec_nanos()))
}

fn temp_cover_path(path: &Path) -> PathBuf {
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    PathBuf::from(tmp)
}

fn fnv1a_128_path(path: &str) -> u128 {
    const OFFSET_BASIS: u128 = 0x6c62_272e_07bb_0142_62b8_2175_6295_c58d;
    const PRIME: u128 = 0x0000_0000_0100_0000_0000_0000_0000_013b;

    let mut hash = OFFSET_BASIS;
    for byte in path.bytes() {
        #[cfg(windows)]
        let normalized = byte.to_ascii_lowercase();
        #[cfg(not(windows))]
        let normalized = byte;

        hash ^= u128::from(normalized);
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice: [u8; 4] = bytes.get(offset..offset + 4)?.try_into().ok()?;
    Some(u32::from_le_bytes(slice))
}

fn read_u64_le(bytes: &[u8], offset: usize) -> Option<u64> {
    let slice: [u8; 8] = bytes.get(offset..offset + 8)?.try_into().ok()?;
    Some(u64::from_le_bytes(slice))
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
            let path = std::env::temp_dir().join(format!("reader-covers-test-{label}-{pid}-{id}"));
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
    fn compute_cover_dimensions_preserves_portrait_and_landscape_ratios() {
        assert_eq!(
            compute_cover_dimensions(
                PageDimensions {
                    width_pt: 600.0,
                    height_pt: 800.0,
                },
                160
            ),
            (120, 160)
        );
        assert_eq!(
            compute_cover_dimensions(
                PageDimensions {
                    width_pt: 960.0,
                    height_pt: 540.0,
                },
                160
            ),
            (160, 90)
        );
        assert_eq!(
            compute_cover_dimensions(
                PageDimensions {
                    width_pt: 500.0,
                    height_pt: 500.0,
                },
                160
            ),
            (160, 160)
        );
    }

    #[test]
    fn compute_cover_dimensions_clamps_extreme_ratios_and_invalid_bounds() {
        assert_eq!(
            compute_cover_dimensions(
                PageDimensions {
                    width_pt: 10_000.0,
                    height_pt: 1.0,
                },
                160
            ),
            (160, 1)
        );
        assert_eq!(
            compute_cover_dimensions(
                PageDimensions {
                    width_pt: 0.0,
                    height_pt: f32::NAN,
                },
                160
            ),
            (160, 160)
        );
    }

    #[test]
    fn write_and_read_cached_cover_round_trips_and_invalidates_on_change() {
        let dir = TempDirGuard::new("roundtrip");
        let cache_dir = dir.path.join("covers");
        let source_path = dir.path.join("sample.pdf");
        fs::write(&source_path, b"%PDF-1.4 initial").expect("write source pdf");

        let key = source_path.to_string_lossy();
        let page = RenderedPage {
            width_px: 2,
            height_px: 2,
            rgba: vec![255; 16],
        };

        write_cached_cover(&cache_dir, &key, &source_path, 160, &page).expect("write cache");

        let hit = read_cached_cover(&cache_dir, &key, &source_path, 160).expect("cache hit");
        assert_eq!(hit, page);

        // Different max_side_px misses cleanly.
        assert_eq!(read_cached_cover(&cache_dir, &key, &source_path, 128), None);

        // Modifying source file length invalidates cached entry.
        fs::write(&source_path, b"%PDF-1.4 updated contents").expect("update source pdf");
        assert_eq!(read_cached_cover(&cache_dir, &key, &source_path, 160), None);
    }

    #[test]
    fn read_cached_cover_rejects_corrupt_payloads() {
        let dir = TempDirGuard::new("corrupt");
        let cache_dir = dir.path.join("covers");
        fs::create_dir_all(&cache_dir).expect("create cache dir");
        let source_path = dir.path.join("book.pdf");
        fs::write(&source_path, b"%PDF-1.4").expect("write source");

        let key = source_path.to_string_lossy();
        let cache_file = cover_cache_path(&cache_dir, &key);
        fs::write(&cache_file, b"BAD_MAGIC_DATA").expect("write corrupt cache");

        assert_eq!(read_cached_cover(&cache_dir, &key, &source_path, 160), None);
    }

    #[test]
    fn remove_cached_cover_deletes_cache_file() {
        let dir = TempDirGuard::new("remove");
        let cache_dir = dir.path.join("covers");
        let source_path = dir.path.join("book.pdf");
        fs::write(&source_path, b"%PDF-1.4").expect("write source");

        let key = source_path.to_string_lossy();
        let page = RenderedPage {
            width_px: 1,
            height_px: 1,
            rgba: vec![1, 2, 3, 255],
        };
        write_cached_cover(&cache_dir, &key, &source_path, 160, &page).expect("write cache");
        assert!(cover_cache_path(&cache_dir, &key).exists());

        remove_cached_cover(&cache_dir, &key, None);
        assert!(!cover_cache_path(&cache_dir, &key).exists());
    }

    #[cfg(windows)]
    #[test]
    fn cover_cache_path_matches_case_insensitively_on_windows() {
        let cache_dir = Path::new(r"C:\cache");
        assert_eq!(
            cover_cache_path(cache_dir, r"C:\Docs\Book.PDF"),
            cover_cache_path(cache_dir, r"c:\docs\book.pdf")
        );
    }
}
