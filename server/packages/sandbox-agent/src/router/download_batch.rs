//! Streaming tar export for `GET /v1/fs/download-batch`.
//!
//! The request is handled in two phases:
//!
//! 1. A blocking pre-walk (`plan_download`) uses `symlink_metadata` to list every
//!    entry, rejects symlinks and special files, and enforces the entry, byte and
//!    depth limits. Any failure here becomes a regular problem+json response,
//!    before a `200` header is sent.
//! 2. A blocking writer (`write_archive`) builds the tar from that plan and sends
//!    it in chunks over a bounded channel that backs the response body, so the
//!    archive is never held in memory as a whole.

use std::fs::File;
use std::io::{self, Read, Write};

use axum::body::Body;
use tar::{Builder, EntryType, Header, HeaderMode};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use super::*;

pub(super) const DEFAULT_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub(super) const DEFAULT_MAX_ENTRIES: u64 = 100_000;
pub(super) const DEFAULT_MAX_DEPTH: u64 = 64;

pub(super) const ENV_MAX_BYTES: &str = "SANDBOX_AGENT_FS_DOWNLOAD_MAX_BYTES";
pub(super) const ENV_MAX_ENTRIES: &str = "SANDBOX_AGENT_FS_DOWNLOAD_MAX_ENTRIES";
pub(super) const ENV_MAX_DEPTH: &str = "SANDBOX_AGENT_FS_DOWNLOAD_MAX_DEPTH";

const LIMIT_EXCEEDED_URN: &str = "urn:sandbox-agent:error:limit_exceeded";

/// Size of each body chunk sent to the client.
const CHUNK_SIZE: usize = 64 * 1024;
/// Number of chunks that may be buffered between the tar writer and the socket.
const CHANNEL_CHUNKS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct DownloadBatchLimits {
    pub max_bytes: u64,
    pub max_entries: u64,
    pub max_depth: u64,
}

impl DownloadBatchLimits {
    /// Server-side limits: defaults, overridden by the `SANDBOX_AGENT_FS_DOWNLOAD_*` env vars.
    /// Unparseable values fall back to the default.
    pub fn from_env(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let read = |key: &str, default: u64| {
            lookup(key)
                .and_then(|value| value.trim().parse::<u64>().ok())
                .unwrap_or(default)
        };
        Self {
            max_bytes: read(ENV_MAX_BYTES, DEFAULT_MAX_BYTES),
            max_entries: read(ENV_MAX_ENTRIES, DEFAULT_MAX_ENTRIES),
            max_depth: read(ENV_MAX_DEPTH, DEFAULT_MAX_DEPTH),
        }
    }

    /// Apply the per-request limits from the query. A request can only tighten
    /// the server limits, never raise them.
    pub fn narrowed_by(self, query: &FsDownloadBatchQuery) -> Self {
        let narrow = |server: u64, requested: Option<u64>| {
            requested.map_or(server, |value| value.min(server))
        };
        Self {
            max_bytes: narrow(self.max_bytes, query.max_bytes),
            max_entries: narrow(self.max_entries, query.max_entries),
            max_depth: narrow(self.max_depth, query.max_depth),
        }
    }
}

#[derive(Debug)]
pub(super) enum DownloadError {
    Sandbox(SandboxError),
    LimitExceeded {
        limit: &'static str,
        max: u64,
        detail: String,
    },
}

impl From<SandboxError> for DownloadError {
    fn from(value: SandboxError) -> Self {
        Self::Sandbox(value)
    }
}

impl From<DownloadError> for ApiError {
    fn from(value: DownloadError) -> Self {
        match value {
            DownloadError::Sandbox(error) => error.into(),
            DownloadError::LimitExceeded { limit, max, detail } => {
                let mut extensions = serde_json::Map::new();
                extensions.insert("limit".to_string(), Value::String(limit.to_string()));
                extensions.insert("max".to_string(), Value::from(max));
                ApiError::Problem(ProblemDetails {
                    type_: LIMIT_EXCEEDED_URN.to_string(),
                    title: "Limit Exceeded".to_string(),
                    status: 400,
                    detail: Some(detail),
                    instance: None,
                    extensions,
                })
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum PlannedKind {
    Directory,
    File { size: u64 },
}

#[derive(Debug, Clone)]
pub(super) struct PlannedEntry {
    /// Absolute path on disk.
    pub source: PathBuf,
    /// Relative name inside the archive.
    pub name: PathBuf,
    pub kind: PlannedKind,
}

fn invalid(message: String) -> DownloadError {
    DownloadError::Sandbox(SandboxError::InvalidRequest { message })
}

fn stream_error(err: impl std::fmt::Display) -> DownloadError {
    DownloadError::Sandbox(SandboxError::StreamError {
        message: err.to_string(),
    })
}

struct PlanState {
    limits: DownloadBatchLimits,
    entries: u64,
    bytes: u64,
    out: Vec<PlannedEntry>,
}

impl PlanState {
    /// Classify one path and record it in the plan. Returns `true` if it is a
    /// directory whose children still need to be visited.
    fn visit(&mut self, source: PathBuf, name: PathBuf) -> Result<bool, DownloadError> {
        let metadata = fs::symlink_metadata(&source)
            .map_err(|err| DownloadError::Sandbox(map_fs_error(&source, err)))?;
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            return Err(invalid(format!(
                "symlinks are not supported in download-batch: {}",
                source.display()
            )));
        }

        let depth = name.components().count() as u64;
        if depth > self.limits.max_depth {
            return Err(DownloadError::LimitExceeded {
                limit: "maxDepth",
                max: self.limits.max_depth,
                detail: format!(
                    "download-batch exceeds maxDepth {} at {}",
                    self.limits.max_depth,
                    source.display()
                ),
            });
        }

        self.entries += 1;
        if self.entries > self.limits.max_entries {
            return Err(DownloadError::LimitExceeded {
                limit: "maxEntries",
                max: self.limits.max_entries,
                detail: format!(
                    "download-batch exceeds maxEntries {}",
                    self.limits.max_entries
                ),
            });
        }

        if file_type.is_dir() {
            self.out.push(PlannedEntry {
                source,
                name,
                kind: PlannedKind::Directory,
            });
            return Ok(true);
        }

        if file_type.is_file() {
            let size = metadata.len();
            self.bytes = self.bytes.saturating_add(size);
            if self.bytes > self.limits.max_bytes {
                return Err(DownloadError::LimitExceeded {
                    limit: "maxBytes",
                    max: self.limits.max_bytes,
                    detail: format!("download-batch exceeds maxBytes {}", self.limits.max_bytes),
                });
            }
            self.out.push(PlannedEntry {
                source,
                name,
                kind: PlannedKind::File { size },
            });
            return Ok(false);
        }

        Err(invalid(format!(
            "unsupported filesystem entry type in download-batch: {}",
            source.display()
        )))
    }
}

fn sorted_children(dir: &StdPath) -> Result<Vec<std::ffi::OsString>, DownloadError> {
    let mut names = Vec::new();
    for entry in fs::read_dir(dir).map_err(|err| DownloadError::Sandbox(map_fs_error(dir, err)))? {
        names.push(entry.map_err(stream_error)?.file_name());
    }
    names.sort();
    Ok(names)
}

/// Walk `target` without following symlinks and return the archive plan.
///
/// A directory target contributes its contents (no wrapper folder); a file target
/// contributes one entry named after the file.
pub(super) fn plan_download(
    target: &StdPath,
    limits: DownloadBatchLimits,
) -> Result<Vec<PlannedEntry>, DownloadError> {
    let metadata = fs::symlink_metadata(target)
        .map_err(|err| DownloadError::Sandbox(map_fs_error(target, err)))?;
    let mut state = PlanState {
        limits,
        entries: 0,
        bytes: 0,
        out: Vec::new(),
    };

    if metadata.file_type().is_symlink() {
        return Err(invalid(format!(
            "symlinks are not supported in download-batch: {}",
            target.display()
        )));
    }

    if metadata.is_file() {
        let name = target
            .file_name()
            .map(PathBuf::from)
            .ok_or_else(|| invalid(format!("invalid file path: {}", target.display())))?;
        state.visit(target.to_path_buf(), name)?;
        return Ok(state.out);
    }

    if !metadata.is_dir() {
        return Err(invalid(format!(
            "unsupported filesystem entry type in download-batch: {}",
            target.display()
        )));
    }

    // Depth-first, in sorted order, using an explicit stack (children pushed in reverse).
    let mut stack: Vec<(PathBuf, PathBuf)> = sorted_children(target)?
        .into_iter()
        .rev()
        .map(|child| (target.join(&child), PathBuf::from(child)))
        .collect();
    while let Some((source, name)) = stack.pop() {
        if state.visit(source.clone(), name.clone())? {
            for child in sorted_children(&source)?.into_iter().rev() {
                stack.push((source.join(&child), name.join(&child)));
            }
        }
    }
    Ok(state.out)
}

/// `Write` adapter that forwards fixed-size chunks to the response body channel.
struct ChannelWriter {
    tx: mpsc::Sender<Result<Bytes, io::Error>>,
    buf: Vec<u8>,
}

impl ChannelWriter {
    fn new(tx: mpsc::Sender<Result<Bytes, io::Error>>) -> Self {
        Self {
            tx,
            buf: Vec::with_capacity(CHUNK_SIZE),
        }
    }

    fn send_buffer(&mut self) -> io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        let chunk = Bytes::from(std::mem::replace(
            &mut self.buf,
            Vec::with_capacity(CHUNK_SIZE),
        ));
        self.tx.blocking_send(Ok(chunk)).map_err(|_| {
            io::Error::new(
                io::ErrorKind::BrokenPipe,
                "download-batch client disconnected",
            )
        })
    }
}

impl Write for ChannelWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let room = CHUNK_SIZE - self.buf.len();
        let take = room.min(data.len());
        self.buf.extend_from_slice(&data[..take]);
        if self.buf.len() >= CHUNK_SIZE {
            self.send_buffer()?;
        }
        Ok(take)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.send_buffer()
    }
}

/// Reader that yields exactly `remaining` bytes or fails, so a file that shrinks
/// mid-download cannot produce a tar whose header disagrees with its data.
struct ExactReader<R> {
    inner: R,
    remaining: u64,
}

impl<R: Read> Read for ExactReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }
        let max = (buf.len() as u64).min(self.remaining) as usize;
        let read = self.inner.read(&mut buf[..max])?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "file shrank during download-batch",
            ));
        }
        self.remaining -= read as u64;
        Ok(read)
    }
}

fn open_no_follow(path: &StdPath) -> io::Result<File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}

fn changed(path: &StdPath, what: &str) -> io::Error {
    io::Error::other(format!(
        "{} changed during download-batch: {what}",
        path.display()
    ))
}

fn append_entry<W: Write>(builder: &mut Builder<W>, entry: &PlannedEntry) -> io::Result<()> {
    match entry.kind {
        PlannedKind::Directory => {
            let metadata = fs::symlink_metadata(&entry.source)?;
            if !metadata.file_type().is_dir() {
                return Err(changed(&entry.source, "no longer a directory"));
            }
            let mut header = Header::new_gnu();
            header.set_metadata_in_mode(&metadata, HeaderMode::Complete);
            header.set_entry_type(EntryType::Directory);
            header.set_size(0);
            builder.append_data(&mut header, &entry.name, io::empty())
        }
        PlannedKind::File { size } => {
            let file = open_no_follow(&entry.source)?;
            let metadata = file.metadata()?;
            if !metadata.file_type().is_file() {
                return Err(changed(&entry.source, "no longer a regular file"));
            }
            if metadata.len() != size {
                return Err(changed(&entry.source, "size differs"));
            }
            let mut header = Header::new_gnu();
            header.set_metadata_in_mode(&metadata, HeaderMode::Complete);
            header.set_entry_type(EntryType::Regular);
            header.set_size(size);
            builder.append_data(
                &mut header,
                &entry.name,
                ExactReader {
                    inner: file,
                    remaining: size,
                },
            )
        }
    }
}

/// Write the planned archive into `tx`. Blocking; run it on a blocking thread.
fn write_archive(
    plan: &[PlannedEntry],
    tx: mpsc::Sender<Result<Bytes, io::Error>>,
) -> io::Result<()> {
    let mut builder = Builder::new(ChannelWriter::new(tx));
    for entry in plan {
        append_entry(&mut builder, entry)?;
    }
    let mut writer = builder.into_inner()?;
    writer.flush()
}

/// Validate, plan and start streaming the archive for `target`.
pub(super) async fn stream_download(
    target: PathBuf,
    limits: DownloadBatchLimits,
) -> Result<Response, ApiError> {
    let plan = tokio::task::spawn_blocking(move || plan_download(&target, limits))
        .await
        .map_err(stream_error)??;

    let (tx, rx) = mpsc::channel::<Result<Bytes, io::Error>>(CHANNEL_CHUNKS);
    tokio::task::spawn_blocking(move || {
        if let Err(err) = write_archive(&plan, tx.clone()) {
            tracing::warn!(error = %err, "download-batch aborted");
            // Surface the failure as a body error so the client sees an aborted
            // transfer instead of a short archive that looks complete.
            let _ = tx.blocking_send(Err(err));
        }
    });

    Ok((
        [(header::CONTENT_TYPE, "application/x-tar")],
        Body::from_stream(ReceiverStream::new(rx)),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn limits(max_bytes: u64, max_entries: u64, max_depth: u64) -> DownloadBatchLimits {
        DownloadBatchLimits {
            max_bytes,
            max_entries,
            max_depth,
        }
    }

    #[test]
    fn limits_default_and_env_override() {
        let none = DownloadBatchLimits::from_env(|_| None);
        assert_eq!(
            none,
            limits(DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_DEPTH)
        );

        let env: HashMap<&str, &str> = [
            (ENV_MAX_BYTES, "10"),
            (ENV_MAX_ENTRIES, " 3 "),
            (ENV_MAX_DEPTH, "not-a-number"),
        ]
        .into();
        let custom = DownloadBatchLimits::from_env(|key| env.get(key).map(|v| v.to_string()));
        assert_eq!(custom, limits(10, 3, DEFAULT_MAX_DEPTH));
    }

    #[test]
    fn query_can_only_lower_limits() {
        let server = limits(100, 10, 5);
        let query = FsDownloadBatchQuery {
            path: None,
            max_bytes: Some(50),
            max_entries: Some(1_000),
            max_depth: None,
        };
        assert_eq!(server.narrowed_by(&query), limits(50, 10, 5));
    }

    #[test]
    fn plan_lists_directory_contents_in_sorted_order() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("b/c")).unwrap();
        fs::write(dir.path().join("a.txt"), b"12").unwrap();
        fs::write(dir.path().join("b/c/d.txt"), b"345").unwrap();

        let plan = plan_download(dir.path(), limits(5, 4, 3)).unwrap();
        let names: Vec<_> = plan
            .iter()
            .map(|e| e.name.to_string_lossy().to_string())
            .collect();
        assert_eq!(names, ["a.txt", "b", "b/c", "b/c/d.txt"]);
        assert_eq!(plan[3].kind, PlannedKind::File { size: 3 });
    }

    #[test]
    fn plan_reports_which_limit_was_hit() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("b/c")).unwrap();
        fs::write(dir.path().join("a.txt"), b"12").unwrap();
        fs::write(dir.path().join("b/c/d.txt"), b"345").unwrap();

        for (lim, expected) in [
            (limits(4, 4, 3), "maxBytes"),
            (limits(5, 3, 3), "maxEntries"),
            (limits(5, 4, 2), "maxDepth"),
        ] {
            match plan_download(dir.path(), lim) {
                Err(DownloadError::LimitExceeded { limit, .. }) => assert_eq!(limit, expected),
                other => panic!("expected {expected} limit error, got {other:?}"),
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn plan_rejects_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), b"a").unwrap();
        std::os::unix::fs::symlink("/etc/passwd", dir.path().join("link")).unwrap();
        match plan_download(dir.path(), limits(100, 100, 100)) {
            Err(DownloadError::Sandbox(SandboxError::InvalidRequest { message })) => {
                assert!(message.contains("symlink"))
            }
            other => panic!("expected symlink rejection, got {other:?}"),
        }
    }

    #[test]
    fn exact_reader_fails_when_file_is_short() {
        let mut reader = ExactReader {
            inner: &b"abc"[..],
            remaining: 5,
        };
        let mut out = Vec::new();
        let err = reader.read_to_end(&mut out).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn channel_writer_reports_disconnected_client() {
        let (tx, rx) = mpsc::channel(1);
        drop(rx);
        let mut writer = ChannelWriter::new(tx);
        writer.write_all(b"data").unwrap();
        assert_eq!(
            writer.flush().unwrap_err().kind(),
            io::ErrorKind::BrokenPipe
        );
    }
}
