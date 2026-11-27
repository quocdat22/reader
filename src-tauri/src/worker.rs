//! Dedicated single-threaded document worker owning all open [`DocumentBackend`] instances.
//!
//! All document open, render, outline, text, and search operations execute on one
//! OS thread (`doc-worker`) owning all open document handles,
//! bridged to async callers through `tokio::sync::mpsc` and `tokio::sync::oneshot`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::{self, JoinHandle};

use serde::Serialize;
use tokio::sync::{mpsc, oneshot};

use crate::backend::{
    DocumentBackend, DocumentMetadata, OutlineItem, PageDimensions, PageLink, RenderedPage,
    SearchMatch, TextSpan, open,
};
use crate::covers::compute_cover_dimensions;
use crate::error::ReaderError;
use crate::highlights::compute_document_fingerprint;

/// Metadata returned when opening a document (or focusing an already-open tab).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpenedDocument {
    /// Monotonic identifier assigned to this open tab on the worker.
    pub document_id: u64,
    /// Canonical filesystem path of the opened document.
    pub canonical_path: PathBuf,
    /// Content-derived `SHA-256` fingerprint identifying this document across moves/renames.
    pub document_fingerprint: String,
    /// Embedded document metadata.
    pub metadata: DocumentMetadata,
    /// Intrinsic dimensions (in points) for every page in the document.
    pub page_dimensions: Vec<PageDimensions>,
    /// `true` when the canonical path was already open and the existing tab handle was reused.
    pub already_open: bool,
}

type BackendOpener = Box<dyn FnMut(&Path) -> Result<Box<dyn DocumentBackend>, ReaderError> + Send>;

struct OpenDocument {
    canonical_path: PathBuf,
    document_fingerprint: String,
    backend: Box<dyn DocumentBackend>,
}

enum WorkerRequest {
    Open {
        path: PathBuf,
        reply: oneshot::Sender<Result<OpenedDocument, ReaderError>>,
    },
    Close {
        document_id: u64,
        reply: oneshot::Sender<Result<(), ReaderError>>,
    },
    RenderPage {
        document_id: u64,
        page_index: usize,
        width_px: u32,
        height_px: u32,
        epoch: u64,
        reply: oneshot::Sender<Result<RenderedPage, ReaderError>>,
    },
    RenderCover {
        path: PathBuf,
        max_side_px: u32,
        reply: oneshot::Sender<Result<RenderedPage, ReaderError>>,
    },
    Outline {
        document_id: u64,
        reply: oneshot::Sender<Result<Vec<OutlineItem>, ReaderError>>,
    },
    PageText {
        document_id: u64,
        page_index: usize,
        reply: oneshot::Sender<Result<Vec<TextSpan>, ReaderError>>,
    },
    PageLinks {
        document_id: u64,
        page_index: usize,
        reply: oneshot::Sender<Result<Vec<PageLink>, ReaderError>>,
    },
    Search {
        document_id: u64,
        query: String,
        reply: oneshot::Sender<Result<Vec<SearchMatch>, ReaderError>>,
    },
}

/// Thread-safe handle to the dedicated `doc-worker` OS thread.
///
/// Implements `Send + Sync` so Tauri `async fn` commands can share a single
/// `DocumentWorker` instance concurrently via `tauri::State`.
pub struct DocumentWorker {
    tx: Option<mpsc::UnboundedSender<WorkerRequest>>,
    render_epoch: Arc<AtomicU64>,
    closing_documents: Arc<Mutex<HashSet<u64>>>,
    join_handle: Option<JoinHandle<()>>,
}

impl DocumentWorker {
    /// Spawns the dedicated `doc-worker` OS thread using the production document factory.
    ///
    /// # Errors
    /// Returns [`ReaderError::Internal`] if the OS fails to spawn the worker thread.
    pub fn spawn() -> Result<Self, ReaderError> {
        let opener: BackendOpener = Box::new(open);
        Self::spawn_with_opener(opener)
    }

    fn spawn_with_opener(opener: BackendOpener) -> Result<Self, ReaderError> {
        let (tx, rx) = mpsc::unbounded_channel();
        let render_epoch = Arc::new(AtomicU64::new(0));
        let closing_documents = Arc::new(Mutex::new(HashSet::new()));

        let worker_epoch = Arc::clone(&render_epoch);
        let worker_closing = Arc::clone(&closing_documents);

        let join_handle = thread::Builder::new()
            .name("doc-worker".to_owned())
            .spawn(move || {
                run_worker_loop(rx, opener, &worker_epoch, &worker_closing);
            })
            .map_err(|err| ReaderError::Internal(format!("failed to spawn doc-worker: {err}")))?;

        Ok(Self {
            tx: Some(tx),
            render_epoch,
            closing_documents,
            join_handle: Some(join_handle),
        })
    }

    /// Advances and returns the monotonic render epoch, cancelling any queued renders
    /// tagged with earlier epochs.
    #[must_use]
    pub fn bump_render_epoch(&self) -> u64 {
        self.render_epoch.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// Returns the current render epoch high-water mark.
    #[must_use]
    pub fn current_render_epoch(&self) -> u64 {
        self.render_epoch.load(Ordering::Acquire)
    }

    /// Opens the document at `path`, or returns the existing tab handle if its canonical
    /// path is already open (`already_open == true`).
    ///
    /// # Errors
    /// Propagates filesystem, format, `PDFium`, or worker channel errors as [`ReaderError`].
    pub async fn open_document(&self, path: PathBuf) -> Result<OpenedDocument, ReaderError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.send_request(WorkerRequest::Open {
            path,
            reply: reply_tx,
        })?;
        await_reply(reply_rx).await
    }

    /// Closes an open tab and drops its backend handle immediately on the worker thread.
    ///
    /// Any queued renders targeting `document_id` are marked for immediate cancellation
    /// before the close request reaches the front of the queue.
    ///
    /// # Errors
    /// Returns [`ReaderError::Internal`] if the worker thread has stopped.
    pub async fn close_document(&self, document_id: u64) -> Result<(), ReaderError> {
        mark_closing(&self.closing_documents, document_id);

        let (reply_tx, reply_rx) = oneshot::channel();
        if let Err(err) = self.send_request(WorkerRequest::Close {
            document_id,
            reply: reply_tx,
        }) {
            unmark_closing(&self.closing_documents, document_id);
            return Err(err);
        }
        await_reply(reply_rx).await
    }

    /// Renders a page for `document_id` at `(width_px, height_px)` tagged with `epoch`.
    ///
    /// Updates the high-water `render_epoch` atomically and returns
    /// [`ReaderError::Cancelled`] if `epoch` is superseded or `document_id` is closing/closed.
    ///
    /// # Errors
    /// - Returns [`ReaderError::Cancelled`] if superseded by a newer epoch or closed tab.
    /// - Returns [`ReaderError::PageOutOfRange`] or [`ReaderError::Internal`] on render failure.
    pub async fn render_page(
        &self,
        document_id: u64,
        page_index: usize,
        width_px: u32,
        height_px: u32,
        epoch: u64,
    ) -> Result<RenderedPage, ReaderError> {
        if is_closing(&self.closing_documents, document_id) {
            return Err(ReaderError::Cancelled);
        }

        let previous = self.render_epoch.fetch_max(epoch, Ordering::AcqRel);
        if epoch < previous {
            return Err(ReaderError::Cancelled);
        }

        let (reply_tx, reply_rx) = oneshot::channel();
        self.send_request(WorkerRequest::RenderPage {
            document_id,
            page_index,
            width_px,
            height_px,
            epoch,
            reply: reply_tx,
        })?;
        await_reply(reply_rx).await
    }

    /// Renders page `0` of `path` scaled proportionally within `max_side_px`.
    ///
    /// Reuses an already-open tab's backend when possible, or opens `path` transiently
    /// on the worker thread and drops it immediately after rasterization.
    ///
    /// # Errors
    /// Propagates filesystem, format, `PDFium`, or worker channel errors as [`ReaderError`].
    pub async fn render_cover(
        &self,
        path: PathBuf,
        max_side_px: u32,
    ) -> Result<RenderedPage, ReaderError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.send_request(WorkerRequest::RenderCover {
            path,
            max_side_px,
            reply: reply_tx,
        })?;
        await_reply(reply_rx).await
    }

    /// Returns the nested table-of-contents outline for `document_id`.
    ///
    /// # Errors
    /// Returns [`ReaderError::DocumentNotFound`] if `document_id` is not open, or any
    /// underlying backend error.
    pub async fn get_outline(&self, document_id: u64) -> Result<Vec<OutlineItem>, ReaderError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.send_request(WorkerRequest::Outline {
            document_id,
            reply: reply_tx,
        })?;
        await_reply(reply_rx).await
    }

    /// Extracts normalized text spans for `page_index` of `document_id`.
    ///
    /// # Errors
    /// Returns [`ReaderError::DocumentNotFound`], [`ReaderError::PageOutOfRange`], or any
    /// underlying backend error.
    pub async fn get_page_text(
        &self,
        document_id: u64,
        page_index: usize,
    ) -> Result<Vec<TextSpan>, ReaderError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.send_request(WorkerRequest::PageText {
            document_id,
            page_index,
            reply: reply_tx,
        })?;
        await_reply(reply_rx).await
    }

    /// Extracts normalized clickable links for `page_index` of `document_id`.
    ///
    /// # Errors
    /// Returns [`ReaderError::DocumentNotFound`], [`ReaderError::PageOutOfRange`], or any
    /// underlying backend error.
    pub async fn get_page_links(
        &self,
        document_id: u64,
        page_index: usize,
    ) -> Result<Vec<PageLink>, ReaderError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.send_request(WorkerRequest::PageLinks {
            document_id,
            page_index,
            reply: reply_tx,
        })?;
        await_reply(reply_rx).await
    }

    /// Searches `document_id` case-insensitively for `query`.
    ///
    /// # Errors
    /// Returns [`ReaderError::DocumentNotFound`] if `document_id` is not open, or any
    /// underlying backend error.
    pub async fn search_document(
        &self,
        document_id: u64,
        query: String,
    ) -> Result<Vec<SearchMatch>, ReaderError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.send_request(WorkerRequest::Search {
            document_id,
            query,
            reply: reply_tx,
        })?;
        await_reply(reply_rx).await
    }

    fn send_request(&self, request: WorkerRequest) -> Result<(), ReaderError> {
        let Some(tx) = self.tx.as_ref() else {
            return Err(ReaderError::Internal(
                "document worker has shut down".to_owned(),
            ));
        };

        tx.send(request)
            .map_err(|_| ReaderError::Internal("document worker channel closed".to_owned()))
    }
}

impl Drop for DocumentWorker {
    fn drop(&mut self) {
        // Close channel first so `blocking_recv()` terminates the worker loop cleanly.
        let _ = self.tx.take();
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.join();
        }
    }
}

async fn await_reply<T>(rx: oneshot::Receiver<Result<T, ReaderError>>) -> Result<T, ReaderError> {
    rx.await.map_err(|_| {
        ReaderError::Internal("document worker terminated before replying".to_owned())
    })?
}

fn run_worker_loop(
    mut rx: mpsc::UnboundedReceiver<WorkerRequest>,
    mut opener: BackendOpener,
    render_epoch: &AtomicU64,
    closing_documents: &Mutex<HashSet<u64>>,
) {
    let mut open_docs: HashMap<u64, OpenDocument> = HashMap::new();
    let mut path_to_id: HashMap<PathBuf, u64> = HashMap::new();
    let mut next_document_id: u64 = 1;

    while let Some(request) = rx.blocking_recv() {
        match request {
            WorkerRequest::Open { path, reply } => {
                let result = handle_open(
                    &path,
                    &mut opener,
                    &mut open_docs,
                    &mut path_to_id,
                    &mut next_document_id,
                );
                let _ = reply.send(result);
            }
            WorkerRequest::Close { document_id, reply } => {
                if let Some(doc) = open_docs.remove(&document_id) {
                    path_to_id.remove(&doc.canonical_path);
                    drop(doc);
                }
                unmark_closing(closing_documents, document_id);
                let _ = reply.send(Ok(()));
            }
            WorkerRequest::RenderPage {
                document_id,
                page_index,
                width_px,
                height_px,
                epoch,
                reply,
            } => {
                let result = handle_render(
                    document_id,
                    page_index,
                    width_px,
                    height_px,
                    epoch,
                    &mut open_docs,
                    render_epoch,
                    closing_documents,
                );
                let _ = reply.send(result);
            }
            WorkerRequest::RenderCover {
                path,
                max_side_px,
                reply,
            } => {
                let result = handle_render_cover(
                    &path,
                    max_side_px,
                    &mut opener,
                    &mut open_docs,
                    &path_to_id,
                );
                let _ = reply.send(result);
            }
            WorkerRequest::Outline { document_id, reply } => {
                let result = open_docs
                    .get(&document_id)
                    .ok_or(ReaderError::DocumentNotFound(document_id))
                    .and_then(|doc| doc.backend.outline());
                let _ = reply.send(result);
            }
            WorkerRequest::PageText {
                document_id,
                page_index,
                reply,
            } => {
                let result = open_docs
                    .get(&document_id)
                    .ok_or(ReaderError::DocumentNotFound(document_id))
                    .and_then(|doc| doc.backend.page_text(page_index));
                let _ = reply.send(result);
            }
            WorkerRequest::PageLinks {
                document_id,
                page_index,
                reply,
            } => {
                let result = open_docs
                    .get(&document_id)
                    .ok_or(ReaderError::DocumentNotFound(document_id))
                    .and_then(|doc| doc.backend.page_links(page_index));
                let _ = reply.send(result);
            }
            WorkerRequest::Search {
                document_id,
                query,
                reply,
            } => {
                let result = open_docs
                    .get(&document_id)
                    .ok_or(ReaderError::DocumentNotFound(document_id))
                    .and_then(|doc| doc.backend.search(&query));
                let _ = reply.send(result);
            }
        }
    }
}

fn handle_open(
    path: &Path,
    opener: &mut BackendOpener,
    open_docs: &mut HashMap<u64, OpenDocument>,
    path_to_id: &mut HashMap<PathBuf, u64>,
    next_document_id: &mut u64,
) -> Result<OpenedDocument, ReaderError> {
    let canonical_path = canonicalize_document_path(path)?;

    if let Some(&existing_id) = path_to_id.get(&canonical_path)
        && let Some(existing) = open_docs.get(&existing_id)
    {
        return Ok(OpenedDocument {
            document_id: existing_id,
            canonical_path,
            document_fingerprint: existing.document_fingerprint.clone(),
            metadata: existing.backend.metadata().clone(),
            page_dimensions: existing.backend.page_dimensions().to_vec(),
            already_open: true,
        });
    }

    let backend = opener(&canonical_path)?;
    let document_fingerprint = compute_document_fingerprint(&canonical_path)?;
    let metadata = backend.metadata().clone();
    let page_dimensions = backend.page_dimensions().to_vec();

    let document_id = *next_document_id;
    *next_document_id += 1;

    path_to_id.insert(canonical_path.clone(), document_id);
    open_docs.insert(
        document_id,
        OpenDocument {
            canonical_path: canonical_path.clone(),
            document_fingerprint: document_fingerprint.clone(),
            backend,
        },
    );

    Ok(OpenedDocument {
        document_id,
        canonical_path,
        document_fingerprint,
        metadata,
        page_dimensions,
        already_open: false,
    })
}

#[expect(
    clippy::too_many_arguments,
    reason = "internal worker render dispatch keeps borrowed worker state flat without extra wrapper allocation"
)]
fn handle_render(
    document_id: u64,
    page_index: usize,
    width_px: u32,
    height_px: u32,
    epoch: u64,
    open_docs: &mut HashMap<u64, OpenDocument>,
    render_epoch: &AtomicU64,
    closing_documents: &Mutex<HashSet<u64>>,
) -> Result<RenderedPage, ReaderError> {
    if is_render_cancelled(document_id, epoch, render_epoch, closing_documents) {
        return Err(ReaderError::Cancelled);
    }

    let Some(doc) = open_docs.get_mut(&document_id) else {
        return Err(ReaderError::Cancelled);
    };

    let rendered = doc.backend.render_page(page_index, width_px, height_px)?;

    if is_render_cancelled(document_id, epoch, render_epoch, closing_documents) {
        return Err(ReaderError::Cancelled);
    }

    Ok(rendered)
}

fn handle_render_cover(
    path: &Path,
    max_side_px: u32,
    opener: &mut BackendOpener,
    open_docs: &mut HashMap<u64, OpenDocument>,
    path_to_id: &HashMap<PathBuf, u64>,
) -> Result<RenderedPage, ReaderError> {
    let canonical_path = canonicalize_document_path(path)?;

    if let Some(&existing_id) = path_to_id.get(&canonical_path)
        && let Some(existing) = open_docs.get_mut(&existing_id)
    {
        return render_backend_cover(existing.backend.as_mut(), max_side_px);
    }

    let mut transient = opener(&canonical_path)?;
    render_backend_cover(transient.as_mut(), max_side_px)
}

fn render_backend_cover(
    backend: &mut dyn DocumentBackend,
    max_side_px: u32,
) -> Result<RenderedPage, ReaderError> {
    let Some(&first_page) = backend.page_dimensions().first() else {
        return Err(ReaderError::PageOutOfRange {
            page_index: 0,
            page_count: 0,
        });
    };

    let (width_px, height_px) = compute_cover_dimensions(first_page, max_side_px);
    backend.render_page(0, width_px, height_px)
}

fn is_render_cancelled(
    document_id: u64,
    epoch: u64,
    render_epoch: &AtomicU64,
    closing_documents: &Mutex<HashSet<u64>>,
) -> bool {
    epoch < render_epoch.load(Ordering::Acquire) || is_closing(closing_documents, document_id)
}

fn mark_closing(closing_documents: &Mutex<HashSet<u64>>, document_id: u64) {
    closing_documents
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(document_id);
}

fn unmark_closing(closing_documents: &Mutex<HashSet<u64>>, document_id: u64) {
    closing_documents
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&document_id);
}

fn is_closing(closing_documents: &Mutex<HashSet<u64>>, document_id: u64) -> bool {
    closing_documents
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .contains(&document_id)
}

/// Canonicalizes a document path and strips standard Windows `\\?\` verbatim prefixes
/// when safe so paths deduplicate cleanly and remain readable in UI and persisted state.
///
/// # Errors
/// Returns [`ReaderError::Io`] if the path does not exist or cannot be resolved.
pub fn canonicalize_document_path(path: &Path) -> Result<PathBuf, ReaderError> {
    let canonical = std::fs::canonicalize(path)?;
    Ok(strip_windows_verbatim_prefix(canonical))
}

#[cfg(windows)]
fn strip_windows_verbatim_prefix(path: PathBuf) -> PathBuf {
    let Some(raw) = path.to_str() else {
        return path;
    };

    normalize_windows_verbatim_str(raw).map_or(path, PathBuf::from)
}

#[cfg(not(windows))]
fn strip_windows_verbatim_prefix(path: PathBuf) -> PathBuf {
    path
}

#[cfg(any(windows, test))]
fn normalize_windows_verbatim_str(raw: &str) -> Option<String> {
    // Keep verbatim prefixes for paths near Windows' legacy 260-char MAX_PATH limit.
    const SAFE_NON_VERBATIM_LEN: usize = 248;

    if let Some(unc_rest) = raw.strip_prefix(r"\\?\UNC\") {
        let simplified = format!(r"\\{unc_rest}");
        return (simplified.len() < SAFE_NON_VERBATIM_LEN).then_some(simplified);
    }

    if let Some(drive_rest) = raw.strip_prefix(r"\\?\") {
        let bytes = drive_rest.as_bytes();
        let is_drive_path = bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'\\';
        if is_drive_path && drive_rest.len() < SAFE_NON_VERBATIM_LEN {
            return Some(drive_rest.to_owned());
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    use std::sync::mpsc as std_mpsc;

    use crate::backend::NormalizedRect;

    use super::*;

    struct WorkerPauseGate {
        entered: Mutex<Option<oneshot::Sender<()>>>,
        release: Mutex<Option<std_mpsc::Receiver<()>>>,
    }

    impl WorkerPauseGate {
        fn new() -> (Arc<Self>, oneshot::Receiver<()>, std_mpsc::Sender<()>) {
            let (entered_tx, entered_rx) = oneshot::channel();
            let (release_tx, release_rx) = std_mpsc::channel();
            let gate = Arc::new(Self {
                entered: Mutex::new(Some(entered_tx)),
                release: Mutex::new(Some(release_rx)),
            });
            (gate, entered_rx, release_tx)
        }

        fn pause(&self) {
            if let Some(tx) = self.entered.lock().expect("entered lock").take() {
                let _ = tx.send(());
            }
            if let Some(rx) = self.release.lock().expect("release lock").take() {
                let _ = rx.recv();
            }
        }
    }

    struct TempDirGuard {
        path: PathBuf,
    }

    impl TempDirGuard {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let id = COUNTER.fetch_add(1, Ordering::Relaxed);
            let pid = std::process::id();
            let path = std::env::temp_dir().join(format!("reader-worker-test-{label}-{pid}-{id}"));
            fs::create_dir_all(&path).expect("failed to create temp test dir");
            Self { path }
        }

        fn create_dummy_pdf(&self, name: &str) -> PathBuf {
            let file_path = self.path.join(name);
            fs::write(&file_path, b"%PDF-1.4\n").expect("failed to write dummy pdf");
            file_path
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    struct MockDocumentBackend {
        metadata: DocumentMetadata,
        dimensions: Vec<PageDimensions>,
        dropped: Arc<AtomicBool>,
        render_calls: Arc<AtomicUsize>,
        outline_gate: Option<Arc<WorkerPauseGate>>,
    }

    impl Drop for MockDocumentBackend {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    impl DocumentBackend for MockDocumentBackend {
        fn metadata(&self) -> &DocumentMetadata {
            &self.metadata
        }

        fn page_count(&self) -> usize {
            self.dimensions.len()
        }

        fn page_dimensions(&self) -> &[PageDimensions] {
            &self.dimensions
        }

        fn render_page(
            &mut self,
            page_index: usize,
            width_px: u32,
            height_px: u32,
        ) -> Result<RenderedPage, ReaderError> {
            if page_index >= self.dimensions.len() {
                return Err(ReaderError::PageOutOfRange {
                    page_index,
                    page_count: self.dimensions.len(),
                });
            }
            self.render_calls.fetch_add(1, Ordering::SeqCst);
            let len = (width_px as usize) * (height_px as usize) * 4;
            Ok(RenderedPage {
                width_px,
                height_px,
                rgba: vec![255; len],
            })
        }

        fn outline(&self) -> Result<Vec<OutlineItem>, ReaderError> {
            if let Some(gate) = self.outline_gate.as_ref() {
                gate.pause();
            }
            Ok(vec![OutlineItem {
                title: "Chapter 1".to_owned(),
                page_index: Some(0),
                children: Vec::new(),
            }])
        }

        fn page_text(&self, page_index: usize) -> Result<Vec<TextSpan>, ReaderError> {
            if page_index >= self.dimensions.len() {
                return Err(ReaderError::PageOutOfRange {
                    page_index,
                    page_count: self.dimensions.len(),
                });
            }
            Ok(vec![TextSpan {
                text: "hello".to_owned(),
                rect: NormalizedRect {
                    x: 0.1,
                    y: 0.1,
                    width: 0.2,
                    height: 0.05,
                },
            }])
        }

        fn search(&self, query: &str) -> Result<Vec<SearchMatch>, ReaderError> {
            if query.eq_ignore_ascii_case("hello") {
                Ok(vec![SearchMatch {
                    page_index: 0,
                    rects: vec![NormalizedRect {
                        x: 0.1,
                        y: 0.1,
                        width: 0.2,
                        height: 0.05,
                    }],
                }])
            } else {
                Ok(Vec::new())
            }
        }

        fn page_links(&self, page_index: usize) -> Result<Vec<PageLink>, ReaderError> {
            if page_index >= self.dimensions.len() {
                return Err(ReaderError::PageOutOfRange {
                    page_index,
                    page_count: self.dimensions.len(),
                });
            }
            Ok(vec![PageLink {
                rects: vec![NormalizedRect {
                    x: 0.2,
                    y: 0.2,
                    width: 0.3,
                    height: 0.04,
                }],
                target: crate::backend::LinkTarget::Internal {
                    page_index: usize::from(self.dimensions.len() > 1),
                    target_point: None,
                    target_rect: None,
                },
            }])
        }
    }

    fn make_mock_opener(
        open_calls: Arc<AtomicUsize>,
        drop_flags: Arc<Mutex<Vec<Arc<AtomicBool>>>>,
        render_calls: Arc<AtomicUsize>,
        outline_gate: Option<Arc<WorkerPauseGate>>,
    ) -> BackendOpener {
        Box::new(move |path| {
            open_calls.fetch_add(1, Ordering::SeqCst);
            let dropped = Arc::new(AtomicBool::new(false));
            drop_flags
                .lock()
                .expect("drop_flags lock")
                .push(Arc::clone(&dropped));

            let title = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .map(str::to_owned);

            Ok(Box::new(MockDocumentBackend {
                metadata: DocumentMetadata {
                    title,
                    author: None,
                    page_count: 2,
                },
                dimensions: vec![
                    PageDimensions {
                        width_pt: 612.0,
                        height_pt: 792.0,
                    },
                    PageDimensions {
                        width_pt: 612.0,
                        height_pt: 792.0,
                    },
                ],
                dropped,
                render_calls: Arc::clone(&render_calls),
                outline_gate: outline_gate.clone(),
            }))
        })
    }

    #[test]
    fn worker_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<DocumentWorker>();
    }

    #[test]
    fn normalize_windows_verbatim_strips_drive_and_unc_prefixes() {
        assert_eq!(
            normalize_windows_verbatim_str(r"\\?\C:\Users\reader\doc.pdf").as_deref(),
            Some(r"C:\Users\reader\doc.pdf")
        );
        assert_eq!(
            normalize_windows_verbatim_str(r"\\?\UNC\server\share\doc.pdf").as_deref(),
            Some(r"\\server\share\doc.pdf")
        );
        assert_eq!(normalize_windows_verbatim_str(r"C:\plain\doc.pdf"), None);
    }

    #[tokio::test]
    async fn open_document_deduplicates_equivalent_canonical_paths() {
        let dir = TempDirGuard::new("dedup");
        let file = dir.create_dummy_pdf("alpha.pdf");
        let non_canonical = dir.path.join(".").join("alpha.pdf");

        let open_calls = Arc::new(AtomicUsize::new(0));
        let drop_flags = Arc::new(Mutex::new(Vec::new()));
        let render_calls = Arc::new(AtomicUsize::new(0));

        let worker = DocumentWorker::spawn_with_opener(make_mock_opener(
            Arc::clone(&open_calls),
            drop_flags,
            render_calls,
            None,
        ))
        .expect("spawn worker");

        let first = worker.open_document(file).await.expect("first open");
        let second = worker
            .open_document(non_canonical)
            .await
            .expect("second open");

        assert!(!first.already_open);
        assert!(second.already_open);
        assert_eq!(first.document_id, second.document_id);
        assert_eq!(first.canonical_path, second.canonical_path);
        assert!(crate::highlights::is_valid_fingerprint(
            &first.document_fingerprint
        ));
        assert_eq!(first.document_fingerprint, second.document_fingerprint);
        assert_eq!(open_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn multi_document_lifecycle_drops_closed_backend_while_preserving_other_tabs() {
        let dir = TempDirGuard::new("multi-tab");
        let first_file = dir.create_dummy_pdf("doc_a.pdf");
        let second_file = dir.create_dummy_pdf("doc_b.pdf");

        let open_calls = Arc::new(AtomicUsize::new(0));
        let drop_flags = Arc::new(Mutex::new(Vec::new()));
        let render_calls = Arc::new(AtomicUsize::new(0));

        let worker = DocumentWorker::spawn_with_opener(make_mock_opener(
            Arc::clone(&open_calls),
            Arc::clone(&drop_flags),
            render_calls,
            None,
        ))
        .expect("spawn worker");

        let doc_a = worker
            .open_document(first_file.clone())
            .await
            .expect("open doc_a");
        let doc_b = worker.open_document(second_file).await.expect("open doc_b");
        assert_ne!(doc_a.document_id, doc_b.document_id);

        worker
            .close_document(doc_a.document_id)
            .await
            .expect("close doc_a");

        {
            let flags = drop_flags.lock().expect("drop_flags lock");
            assert!(
                flags[0].load(Ordering::SeqCst),
                "closed tab backend should drop immediately"
            );
            assert!(
                !flags[1].load(Ordering::SeqCst),
                "other open tab backend must remain alive"
            );
        }

        let outline_b = worker
            .get_outline(doc_b.document_id)
            .await
            .expect("doc_b outline should succeed");
        assert_eq!(outline_b.len(), 1);

        let closed_outline = worker.get_outline(doc_a.document_id).await;
        assert!(matches!(
            closed_outline,
            Err(ReaderError::DocumentNotFound(id)) if id == doc_a.document_id
        ));

        let reopened = worker
            .open_document(first_file)
            .await
            .expect("reopen doc_a");
        assert!(!reopened.already_open);
        assert!(reopened.document_id > doc_b.document_id);
        assert_eq!(open_calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn render_page_cancels_pre_enqueue_stale_epoch_without_invoking_backend() {
        let dir = TempDirGuard::new("stale-pre");
        let file = dir.create_dummy_pdf("doc.pdf");

        let open_calls = Arc::new(AtomicUsize::new(0));
        let drop_flags = Arc::new(Mutex::new(Vec::new()));
        let render_calls = Arc::new(AtomicUsize::new(0));

        let worker = DocumentWorker::spawn_with_opener(make_mock_opener(
            open_calls,
            drop_flags,
            Arc::clone(&render_calls),
            None,
        ))
        .expect("spawn worker");

        let doc = worker.open_document(file).await.expect("open doc");
        let newer_epoch = worker.bump_render_epoch();
        assert_eq!(newer_epoch, 1);

        let stale = worker.render_page(doc.document_id, 0, 100, 100, 0).await;

        assert!(matches!(stale, Err(ReaderError::Cancelled)));
        assert_eq!(render_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn render_page_discards_queued_stale_epoch_before_rasterizing() {
        let dir = TempDirGuard::new("stale-queued");
        let file = dir.create_dummy_pdf("doc.pdf");

        let (gate, entered_rx, release_tx) = WorkerPauseGate::new();
        let open_calls = Arc::new(AtomicUsize::new(0));
        let drop_flags = Arc::new(Mutex::new(Vec::new()));
        let render_calls = Arc::new(AtomicUsize::new(0));

        let worker = Arc::new(
            DocumentWorker::spawn_with_opener(make_mock_opener(
                open_calls,
                drop_flags,
                Arc::clone(&render_calls),
                Some(gate),
            ))
            .expect("spawn worker"),
        );

        let doc = worker.open_document(file).await.expect("open doc");

        // Pause the worker inside `outline()` so the render request sits queued behind it.
        let worker_for_outline = Arc::clone(&worker);
        let outline_task =
            tokio::spawn(async move { worker_for_outline.get_outline(doc.document_id).await });

        entered_rx.await.expect("worker should enter outline()");

        let worker_for_stale = Arc::clone(&worker);
        let stale_render_task = tokio::spawn(async move {
            worker_for_stale
                .render_page(doc.document_id, 0, 64, 64, 1)
                .await
        });

        // Wait until the stale task has enqueued with epoch 1, then advance epoch to 2.
        while worker.current_render_epoch() < 1 {
            tokio::task::yield_now().await;
        }
        let fresh_epoch = worker.bump_render_epoch();
        assert!(fresh_epoch >= 2);

        // Release `outline()` so the worker processes the queued stale render next.
        release_tx.send(()).expect("release worker");

        outline_task
            .await
            .expect("outline task join")
            .expect("outline result");
        let stale_result = stale_render_task.await.expect("stale render join");

        assert!(matches!(stale_result, Err(ReaderError::Cancelled)));
        assert_eq!(render_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn close_document_cancels_queued_render_for_that_tab() {
        let dir = TempDirGuard::new("close-cancel");
        let file = dir.create_dummy_pdf("doc.pdf");

        let (gate, entered_rx, release_tx) = WorkerPauseGate::new();
        let open_calls = Arc::new(AtomicUsize::new(0));
        let drop_flags = Arc::new(Mutex::new(Vec::new()));
        let render_calls = Arc::new(AtomicUsize::new(0));

        let worker = Arc::new(
            DocumentWorker::spawn_with_opener(make_mock_opener(
                open_calls,
                drop_flags,
                Arc::clone(&render_calls),
                Some(gate),
            ))
            .expect("spawn worker"),
        );

        let doc = worker.open_document(file).await.expect("open doc");

        let worker_for_outline = Arc::clone(&worker);
        let outline_task =
            tokio::spawn(async move { worker_for_outline.get_outline(doc.document_id).await });

        entered_rx.await.expect("worker should enter outline()");

        let worker_for_render = Arc::clone(&worker);
        let queued_render = tokio::spawn(async move {
            worker_for_render
                .render_page(doc.document_id, 0, 64, 64, 1)
                .await
        });

        while worker.current_render_epoch() < 1 {
            tokio::task::yield_now().await;
        }

        let worker_for_close = Arc::clone(&worker);
        let close_task =
            tokio::spawn(async move { worker_for_close.close_document(doc.document_id).await });

        while !is_closing(&worker.closing_documents, doc.document_id) {
            tokio::task::yield_now().await;
        }
        release_tx.send(()).expect("release worker");

        outline_task
            .await
            .expect("outline task join")
            .expect("outline ok");
        close_task
            .await
            .expect("close task join")
            .expect("close ok");
        let render_result = queued_render.await.expect("render task join");

        assert!(matches!(render_result, Err(ReaderError::Cancelled)));
        assert_eq!(render_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn closing_tab_render_does_not_advance_render_epoch_for_other_tabs() {
        let dir = TempDirGuard::new("closing-epoch-isolation");
        let file = dir.create_dummy_pdf("doc.pdf");

        let open_calls = Arc::new(AtomicUsize::new(0));
        let drop_flags = Arc::new(Mutex::new(Vec::new()));
        let render_calls = Arc::new(AtomicUsize::new(0));

        let worker = DocumentWorker::spawn_with_opener(make_mock_opener(
            open_calls,
            drop_flags,
            render_calls,
            None,
        ))
        .expect("spawn worker");

        let doc = worker.open_document(file).await.expect("open doc");
        mark_closing(&worker.closing_documents, doc.document_id);

        let before_epoch = worker.current_render_epoch();
        let res = worker
            .render_page(doc.document_id, 0, 64, 64, before_epoch + 500)
            .await;

        assert!(matches!(res, Err(ReaderError::Cancelled)));
        assert_eq!(worker.current_render_epoch(), before_epoch);
    }

    #[tokio::test]
    async fn render_cover_reuses_open_tab_and_drops_transient_backend_when_closed() {
        let dir = TempDirGuard::new("render-cover");
        let open_file = dir.create_dummy_pdf("open.pdf");
        let closed_file = dir.create_dummy_pdf("closed.pdf");

        let open_calls = Arc::new(AtomicUsize::new(0));
        let drop_flags = Arc::new(Mutex::new(Vec::new()));
        let render_calls = Arc::new(AtomicUsize::new(0));

        let worker = DocumentWorker::spawn_with_opener(make_mock_opener(
            Arc::clone(&open_calls),
            Arc::clone(&drop_flags),
            Arc::clone(&render_calls),
            None,
        ))
        .expect("spawn worker");

        let _open_doc = worker
            .open_document(open_file.clone())
            .await
            .expect("open doc");
        assert_eq!(open_calls.load(Ordering::SeqCst), 1);

        let open_cover = worker
            .render_cover(open_file, 160)
            .await
            .expect("cover for open doc");
        assert_eq!(open_calls.load(Ordering::SeqCst), 1);
        assert_eq!(open_cover.width_px, 124);
        assert_eq!(open_cover.height_px, 160);

        let closed_cover = worker
            .render_cover(closed_file, 160)
            .await
            .expect("cover for closed doc");
        assert_eq!(open_calls.load(Ordering::SeqCst), 2);
        assert_eq!(closed_cover.width_px, 124);
        assert_eq!(closed_cover.height_px, 160);

        let flags = drop_flags.lock().expect("drop_flags lock");
        assert!(!flags[0].load(Ordering::SeqCst));
        assert!(flags[1].load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn get_page_links_forwards_to_backend_and_rejects_closed_tab() {
        let dir = TempDirGuard::new("page-links");
        let file = dir.create_dummy_pdf("links.pdf");

        let open_calls = Arc::new(AtomicUsize::new(0));
        let drop_flags = Arc::new(Mutex::new(Vec::new()));
        let render_calls = Arc::new(AtomicUsize::new(0));

        let worker = DocumentWorker::spawn_with_opener(make_mock_opener(
            open_calls,
            drop_flags,
            render_calls,
            None,
        ))
        .expect("spawn worker");

        let doc = worker.open_document(file).await.expect("open doc");
        let links = worker
            .get_page_links(doc.document_id, 0)
            .await
            .expect("get_page_links should succeed");
        assert_eq!(links.len(), 1);

        let err = worker
            .get_page_links(doc.document_id, 99)
            .await
            .unwrap_err();
        assert!(matches!(err, ReaderError::PageOutOfRange { .. }));

        worker
            .close_document(doc.document_id)
            .await
            .expect("close doc");
        let closed_err = worker.get_page_links(doc.document_id, 0).await.unwrap_err();
        assert!(matches!(
            closed_err,
            ReaderError::DocumentNotFound(id) if id == doc.document_id
        ));
    }
}
