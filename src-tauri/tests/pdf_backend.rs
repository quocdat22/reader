//! Integration tests exercising `PdfBackend` and `DocumentWorker` against a dynamically
//! discovered local PDF fixture (`READER_TEST_PDF` or first `tests/fixtures/*.pdf`).

mod common;

use std::path::PathBuf;

use reader_lib::backend::{self, LinkTarget, NormalizedRect, OutlineItem};
use reader_lib::error::ReaderError;
use reader_lib::worker::DocumentWorker;

fn fixture_or_skip() -> Option<PathBuf> {
    let path = common::discover_pdf_fixture();
    if path.is_none() {
        eprintln!(
            "Skipping PDF integration test: no *.pdf found via {} or tests/fixtures/",
            common::TEST_PDF_ENV_VAR
        );
    }
    path
}

fn assert_normalized_rect_valid(rect: NormalizedRect) {
    assert!(
        (0.0..=1.0).contains(&rect.x),
        "rect.x out of [0, 1]: {rect:?}"
    );
    assert!(
        (0.0..=1.0).contains(&rect.y),
        "rect.y out of [0, 1]: {rect:?}"
    );
    assert!(
        rect.width > 0.0 && rect.width <= 1.0,
        "rect.width out of (0, 1]: {rect:?}"
    );
    assert!(
        rect.height > 0.0 && rect.height <= 1.0,
        "rect.height out of (0, 1]: {rect:?}"
    );
    assert!(
        rect.x + rect.width <= 1.0 + 1e-4,
        "rect.x + rect.width exceeds 1.0: {rect:?}"
    );
    assert!(
        rect.y + rect.height <= 1.0 + 1e-4,
        "rect.y + rect.height exceeds 1.0: {rect:?}"
    );
}

fn assert_outline_indices_in_bounds(items: &[OutlineItem], page_count: usize) {
    for item in items {
        if let Some(page_index) = item.page_index {
            assert!(
                page_index < page_count,
                "outline entry {:?} points to out-of-range page {page_index} (count {page_count})",
                item.title
            );
        }
        assert_outline_indices_in_bounds(&item.children, page_count);
    }
}

#[test]
fn pdf_backend_opens_fixture_with_positive_page_count_and_valid_dimensions() {
    let Some(fixture) = fixture_or_skip() else {
        return;
    };

    let doc = backend::open(&fixture).expect("local PDF fixture should open cleanly");

    assert!(
        doc.page_count() > 0,
        "fixture should have at least one page"
    );
    assert_eq!(doc.page_dimensions().len(), doc.page_count());
    assert_eq!(doc.metadata().page_count, doc.page_count());

    for (index, dims) in doc.page_dimensions().iter().enumerate() {
        assert!(
            dims.width_pt > 0.0 && dims.width_pt.is_finite(),
            "page {index} has invalid width_pt: {}",
            dims.width_pt
        );
        assert!(
            dims.height_pt > 0.0 && dims.height_pt.is_finite(),
            "page {index} has invalid height_pt: {}",
            dims.height_pt
        );
    }
}

#[test]
fn pdf_backend_renders_page_zero_to_exact_rgba_buffer() {
    let Some(fixture) = fixture_or_skip() else {
        return;
    };

    let mut doc = backend::open(&fixture).expect("local PDF fixture should open cleanly");
    let rendered = doc
        .render_page(0, 600, 800)
        .expect("page 0 should rasterize");

    assert_eq!(rendered.width_px, 600);
    assert_eq!(rendered.height_px, 800);
    assert_eq!(rendered.rgba.len(), 600 * 800 * 4);
    assert!(
        rendered.rgba.iter().any(|&byte| byte != 0),
        "rendered RGBA buffer should not be all zeros"
    );

    let ipc = rendered.to_ipc_bytes();
    assert_eq!(ipc.len(), 8 + rendered.rgba.len());
    assert_eq!(&ipc[0..4], &600_u32.to_le_bytes());
    assert_eq!(&ipc[4..8], &800_u32.to_le_bytes());
}

#[test]
fn pdf_backend_rejects_out_of_range_page_index() {
    let Some(fixture) = fixture_or_skip() else {
        return;
    };

    let mut doc = backend::open(&fixture).expect("local PDF fixture should open cleanly");
    let out_of_range = doc.page_count();

    let render_err = doc.render_page(out_of_range, 200, 200).unwrap_err();
    assert!(
        matches!(
            render_err,
            ReaderError::PageOutOfRange { page_index, page_count }
                if page_index == out_of_range && page_count == out_of_range
        ),
        "expected PageOutOfRange, got {render_err:?}"
    );

    let text_err = doc.page_text(out_of_range).unwrap_err();
    assert!(
        matches!(text_err, ReaderError::PageOutOfRange { .. }),
        "expected PageOutOfRange, got {text_err:?}"
    );

    let links_err = doc.page_links(out_of_range).unwrap_err();
    assert!(
        matches!(links_err, ReaderError::PageOutOfRange { .. }),
        "expected PageOutOfRange, got {links_err:?}"
    );
}

#[test]
fn pdf_backend_extracts_outline_with_valid_page_indices() {
    let Some(fixture) = fixture_or_skip() else {
        return;
    };

    let doc = backend::open(&fixture).expect("local PDF fixture should open cleanly");
    let outline = doc.outline().expect("outline extraction should succeed");

    assert_outline_indices_in_bounds(&outline, doc.page_count());
}

#[test]
fn pdf_backend_extracts_normalized_text_spans() {
    let Some(fixture) = fixture_or_skip() else {
        return;
    };

    let doc = backend::open(&fixture).expect("local PDF fixture should open cleanly");
    let scan_limit = doc.page_count().min(20);

    let mut found_spans = None;
    for page_index in 0..scan_limit {
        let spans = doc
            .page_text(page_index)
            .expect("page_text should succeed on valid page");
        if !spans.is_empty() {
            found_spans = Some(spans);
            break;
        }
    }

    let spans = found_spans.expect("expected at least one text span within first 20 pages");
    for span in &spans {
        assert!(!span.text.is_empty(), "text span should be non-empty");
        assert_normalized_rect_valid(span.rect);
    }
}

#[test]
fn pdf_backend_search_locates_known_word_from_extracted_text() {
    let Some(fixture) = fixture_or_skip() else {
        return;
    };

    let doc = backend::open(&fixture).expect("local PDF fixture should open cleanly");
    let scan_limit = doc.page_count().min(20);

    let mut target: Option<(usize, String)> = None;
    for page_index in 0..scan_limit {
        let spans = doc
            .page_text(page_index)
            .expect("page_text should succeed on valid page");
        for span in spans {
            if let Some(word) = span
                .text
                .split(|ch: char| !ch.is_ascii_alphabetic())
                .find(|candidate| candidate.len() >= 4)
            {
                target = Some((page_index, word.to_ascii_lowercase()));
                break;
            }
        }
        if target.is_some() {
            break;
        }
    }

    let (source_page, query) =
        target.expect("expected an ASCII alphabetic word (>= 4 chars) within first 20 pages");

    let matches = doc.search(&query).expect("document search should succeed");
    assert!(
        matches
            .iter()
            .any(|item| item.page_index == source_page && !item.rects.is_empty()),
        "expected search for extracted word to match on source page {source_page}"
    );

    for item in &matches {
        assert!(item.page_index < doc.page_count());
        assert!(
            !item.rects.is_empty(),
            "search match on page {} should contain at least one highlight rect",
            item.page_index
        );
        for &rect in &item.rects {
            assert_normalized_rect_valid(rect);
        }
    }
}

#[test]
fn pdf_backend_extracts_valid_normalized_page_links() {
    let Some(fixture) = fixture_or_skip() else {
        return;
    };

    let doc = backend::open(&fixture).expect("local PDF fixture should open cleanly");
    let scan_limit = doc.page_count().min(20);

    for page_index in 0..scan_limit {
        let links = doc
            .page_links(page_index)
            .expect("page_links should succeed on valid page");
        for link in &links {
            assert!(
                !link.rects.is_empty(),
                "page {page_index} link should have at least one hit rect"
            );
            for &rect in &link.rects {
                assert_normalized_rect_valid(rect);
            }
            if let LinkTarget::Internal {
                page_index: target_page,
                target_point,
                target_rect,
            } = &link.target
            {
                assert!(*target_page < doc.page_count());
                if let Some(pt) = target_point {
                    assert!((0.0..=1.0).contains(&pt.x), "pt.x out of [0, 1]: {pt:?}");
                    assert!((0.0..=1.0).contains(&pt.y), "pt.y out of [0, 1]: {pt:?}");
                }
                if let Some(rect) = target_rect {
                    assert_normalized_rect_valid(*rect);
                }
            }
        }
    }
}

#[tokio::test]
async fn worker_opens_deduplicates_renders_and_closes_fixture() {
    let Some(fixture) = fixture_or_skip() else {
        return;
    };

    let worker = DocumentWorker::spawn().expect("worker should spawn");

    let first = worker
        .open_document(fixture.clone())
        .await
        .expect("worker should open fixture");
    assert!(!first.already_open);
    assert!(first.metadata.page_count > 0);
    assert_eq!(first.page_dimensions.len(), first.metadata.page_count);

    let second = worker
        .open_document(fixture)
        .await
        .expect("re-opening same fixture should reuse tab");
    assert!(second.already_open);
    assert_eq!(second.document_id, first.document_id);

    let epoch = worker.bump_render_epoch();
    let page = worker
        .render_page(first.document_id, 0, 300, 400, epoch)
        .await
        .expect("page 0 should render via worker");
    assert_eq!(page.width_px, 300);
    assert_eq!(page.height_px, 400);
    assert_eq!(page.rgba.len(), 300 * 400 * 4);

    let stale = worker
        .render_page(first.document_id, 0, 300, 400, epoch - 1)
        .await;
    assert!(matches!(stale, Err(ReaderError::Cancelled)));

    worker
        .close_document(first.document_id)
        .await
        .expect("closing open document should succeed");

    let after_close = worker
        .render_page(first.document_id, 0, 300, 400, epoch)
        .await;
    assert!(matches!(after_close, Err(ReaderError::Cancelled)));
}

#[tokio::test]
async fn worker_renders_proportional_cover_for_fixture() {
    let Some(fixture) = fixture_or_skip() else {
        return;
    };

    let worker = DocumentWorker::spawn().expect("worker should spawn");
    let cover = worker
        .render_cover(fixture, 160)
        .await
        .expect("worker should render first-page cover");

    assert!(cover.width_px > 0 && cover.width_px <= 160);
    assert!(cover.height_px > 0 && cover.height_px <= 160);
    assert_eq!(cover.width_px.max(cover.height_px), 160);
    assert_eq!(
        cover.rgba.len(),
        (cover.width_px as usize) * (cover.height_px as usize) * 4
    );
    assert!(
        cover.rgba.iter().any(|&byte| byte != 0),
        "cover RGBA buffer should not be all zeros"
    );
}
