use super::*;
use std::collections::BTreeMap;
use std::io::Cursor;
use std::process::Command;

use docker_support::TestAppOptions;

const LIMIT_EXCEEDED: &str = "urn:sandbox-agent:error:limit_exceeded";
const INVALID_REQUEST: &str = "urn:sandbox-agent:error:invalid_request";

async fn put_file(app: &TestApp, path: &str, body: &[u8]) {
    let (status, _, _) = send_request_raw(
        &app.app,
        Method::PUT,
        &format!("/v1/fs/file?path={path}"),
        Some(body.to_vec()),
        &[],
        Some("application/octet-stream"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "write {path}");
}

async fn download(app: &TestApp, query: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
    send_request_raw(
        &app.app,
        Method::GET,
        &format!("/v1/fs/download-batch?{query}"),
        None,
        &[],
        None,
    )
    .await
}

/// Run a shell script inside the test container (as the server sees the filesystem).
fn container_sh(app: &TestApp, script: &str) {
    let output = Command::new(docker_support::docker_bin())
        .args(["exec", app.container_id(), "sh", "-c", script])
        .output()
        .expect("docker exec");
    assert!(
        output.status.success(),
        "container script failed: {}\n{}",
        script,
        String::from_utf8_lossy(&output.stderr)
    );
}

fn content_type(headers: &HeaderMap) -> &str {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
}

/// Parse a tar body into a sorted map of `path -> Some(content)` for files and
/// `path/ -> None` for directories.
fn read_tar(body: &[u8]) -> BTreeMap<String, Option<Vec<u8>>> {
    let mut archive = tar::Archive::new(Cursor::new(body));
    let mut out = BTreeMap::new();
    for entry in archive.entries().expect("tar entries") {
        let mut entry = entry.expect("tar entry");
        let path = entry
            .path()
            .expect("tar path")
            .to_string_lossy()
            .to_string();
        if entry.header().entry_type().is_dir() {
            let key = if path.ends_with('/') {
                path
            } else {
                format!("{path}/")
            };
            out.insert(key, None);
        } else {
            assert!(
                entry.header().entry_type().is_file(),
                "unexpected tar entry type for {path}"
            );
            let mut content = Vec::new();
            entry.read_to_end(&mut content).expect("tar content");
            out.insert(path, Some(content));
        }
    }
    out
}

fn assert_problem(
    status: StatusCode,
    headers: &HeaderMap,
    body: &[u8],
    expected_type: &str,
) -> Value {
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "body: {}",
        String::from_utf8_lossy(body)
    );
    assert_eq!(content_type(headers), "application/problem+json");
    let problem = parse_json(body);
    assert_eq!(problem["type"], expected_type, "problem: {problem}");
    assert_eq!(problem["status"], 400);
    problem
}

#[tokio::test]
async fn v1_filesystem_download_batch_returns_tar() {
    let test_app = TestApp::new(AuthConfig::disabled());
    put_file(&test_app, "docs/a.txt", b"aaa").await;
    put_file(&test_app, "docs/nested/b.txt", b"bbb").await;
    container_sh(&test_app, "mkdir -p \"$HOME/docs/empty\"");

    let (status, headers, body) = download(&test_app, "path=docs").await;
    assert_eq!(
        status,
        StatusCode::OK,
        "body: {}",
        String::from_utf8_lossy(&body)
    );
    assert_eq!(content_type(&headers), "application/x-tar");

    let entries = read_tar(&body);
    let expected: BTreeMap<String, Option<Vec<u8>>> = [
        ("a.txt".to_string(), Some(b"aaa".to_vec())),
        ("empty/".to_string(), None),
        ("nested/".to_string(), None),
        ("nested/b.txt".to_string(), Some(b"bbb".to_vec())),
    ]
    .into_iter()
    .collect();
    assert_eq!(
        entries, expected,
        "directory contents are archived without a wrapper folder"
    );
}

#[tokio::test]
async fn v1_filesystem_download_batch_single_file() {
    let test_app = TestApp::new(AuthConfig::disabled());
    put_file(&test_app, "docs/report.txt", b"report body").await;

    let (status, headers, body) = download(&test_app, "path=docs/report.txt").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type(&headers), "application/x-tar");
    let entries = read_tar(&body);
    let expected: BTreeMap<String, Option<Vec<u8>>> =
        [("report.txt".to_string(), Some(b"report body".to_vec()))]
            .into_iter()
            .collect();
    assert_eq!(entries, expected);
}

#[tokio::test]
async fn v1_filesystem_download_batch_streams_large_file() {
    let test_app = TestApp::new(AuthConfig::disabled());
    // 24 MiB of random bytes, written inside the container.
    container_sh(
        &test_app,
        "mkdir -p \"$HOME/big\" && head -c 25165824 /dev/urandom > \"$HOME/big/blob.bin\"",
    );

    let (status, headers, body) = download(&test_app, "path=big").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        headers.get(header::CONTENT_LENGTH).is_none(),
        "streamed response must not be buffered into a sized body"
    );
    let entries = read_tar(&body);
    let blob = entries
        .get("blob.bin")
        .cloned()
        .flatten()
        .expect("blob.bin in archive");
    assert_eq!(blob.len(), 25_165_824);
}

#[tokio::test]
async fn v1_filesystem_download_batch_rejects_symlink_inside_directory() {
    let test_app = TestApp::new(AuthConfig::disabled());
    put_file(&test_app, "docs/a.txt", b"aaa").await;
    container_sh(&test_app, "ln -s /etc/passwd \"$HOME/docs/leak\"");

    let (status, headers, body) = download(&test_app, "path=docs").await;
    let problem = assert_problem(status, &headers, &body, INVALID_REQUEST);
    let detail = problem["detail"].as_str().unwrap_or_default();
    assert!(detail.contains("symlink"), "detail: {detail}");
}

#[tokio::test]
async fn v1_filesystem_download_batch_rejects_symlink_target() {
    let test_app = TestApp::new(AuthConfig::disabled());
    put_file(&test_app, "docs/a.txt", b"aaa").await;
    container_sh(&test_app, "ln -s \"$HOME/docs\" \"$HOME/docs-link\"");

    let (status, headers, body) = download(&test_app, "path=docs-link").await;
    let problem = assert_problem(status, &headers, &body, INVALID_REQUEST);
    let detail = problem["detail"].as_str().unwrap_or_default();
    assert!(detail.contains("symlink"), "detail: {detail}");
}

#[tokio::test]
async fn v1_filesystem_download_batch_rejects_special_files() {
    let test_app = TestApp::new(AuthConfig::disabled());
    put_file(&test_app, "docs/a.txt", b"aaa").await;
    container_sh(&test_app, "mkfifo \"$HOME/docs/pipe\"");

    let (status, headers, body) = download(&test_app, "path=docs").await;
    let problem = assert_problem(status, &headers, &body, INVALID_REQUEST);
    let detail = problem["detail"].as_str().unwrap_or_default();
    assert!(detail.contains("unsupported"), "detail: {detail}");
}

#[tokio::test]
async fn v1_filesystem_download_batch_rejects_path_traversal() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, headers, body) = download(&test_app, "path=docs/../../etc").await;
    assert_problem(status, &headers, &body, INVALID_REQUEST);
}

#[tokio::test]
async fn v1_filesystem_download_batch_missing_path() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, headers, body) = download(&test_app, "path=does-not-exist").await;
    let problem = assert_problem(status, &headers, &body, INVALID_REQUEST);
    let detail = problem["detail"].as_str().unwrap_or_default();
    assert!(detail.contains("path not found"), "detail: {detail}");
}

#[tokio::test]
async fn v1_filesystem_download_batch_enforces_query_limits() {
    let test_app = TestApp::new(AuthConfig::disabled());
    put_file(&test_app, "docs/a.txt", b"aaa").await;
    put_file(&test_app, "docs/b.txt", b"bbb").await;
    put_file(&test_app, "docs/nested/deeper/c.txt", b"c").await;
    // Entries: a.txt, b.txt, nested/, nested/deeper/, nested/deeper/c.txt = 5; bytes = 7; depth = 3.

    let (status, headers, body) = download(&test_app, "path=docs&maxEntries=4").await;
    let problem = assert_problem(status, &headers, &body, LIMIT_EXCEEDED);
    assert_eq!(problem["limit"], "maxEntries");
    assert_eq!(problem["max"], 4);

    let (status, headers, body) = download(&test_app, "path=docs&maxBytes=6").await;
    let problem = assert_problem(status, &headers, &body, LIMIT_EXCEEDED);
    assert_eq!(problem["limit"], "maxBytes");
    assert_eq!(problem["max"], 6);

    let (status, headers, body) = download(&test_app, "path=docs&maxDepth=2").await;
    let problem = assert_problem(status, &headers, &body, LIMIT_EXCEEDED);
    assert_eq!(problem["limit"], "maxDepth");
    assert_eq!(problem["max"], 2);

    // Exactly at every limit succeeds.
    let (status, _, body) =
        download(&test_app, "path=docs&maxEntries=5&maxBytes=7&maxDepth=3").await;
    assert_eq!(
        status,
        StatusCode::OK,
        "body: {}",
        String::from_utf8_lossy(&body)
    );
    assert_eq!(read_tar(&body).len(), 5);
}

#[tokio::test]
async fn v1_filesystem_download_batch_server_limits_cap_query() {
    let mut env = BTreeMap::new();
    env.insert(
        "SANDBOX_AGENT_FS_DOWNLOAD_MAX_ENTRIES".to_string(),
        "2".to_string(),
    );
    let test_app = TestApp::with_options(
        AuthConfig::disabled(),
        TestAppOptions {
            env,
            ..Default::default()
        },
        |_| {},
    );
    put_file(&test_app, "docs/a.txt", b"a").await;
    put_file(&test_app, "docs/b.txt", b"b").await;
    put_file(&test_app, "docs/c.txt", b"c").await;

    // A client cannot raise the server-side limit.
    let (status, headers, body) = download(&test_app, "path=docs&maxEntries=100").await;
    let problem = assert_problem(status, &headers, &body, LIMIT_EXCEEDED);
    assert_eq!(problem["limit"], "maxEntries");
    assert_eq!(problem["max"], 2);
}

#[tokio::test]
async fn v1_filesystem_download_batch_round_trips_through_upload_batch() {
    let test_app = TestApp::new(AuthConfig::disabled());
    put_file(&test_app, "src/one.txt", b"one").await;
    put_file(&test_app, "src/dir/two.txt", b"two").await;

    let (status, _, tar_bytes) = download(&test_app, "path=src").await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, body) = send_request_raw(
        &test_app.app,
        Method::POST,
        "/v1/fs/upload-batch?path=dst",
        Some(tar_bytes),
        &[],
        Some("application/x-tar"),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "body: {}",
        String::from_utf8_lossy(&body)
    );

    let (status, _, body) = send_request_raw(
        &test_app.app,
        Method::GET,
        "/v1/fs/file?path=dst/dir/two.txt",
        None,
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, b"two");
}
