//! UI backend for the personal YouTube interface (build guide section 10.2).
//!
//! Binds to 127.0.0.1:8080 unless YT_BIND / YT_PORT say otherwise.
//!
//! Routes
//!   GET  /                 static UI (web/, built into the exe)
//!   GET  /config.json      addresses the UI needs (Invidious base, download folders)
//!   GET  /status           whether Invidious answers yet (the UI shows a start-up screen until it does)
//!   GET  /state            subscriptions, history, watch later, likes, settings and feed cache, shared by every window
//!   POST /state            {key, value} saves one of those keys (so the app and the browser always match)
//!   GET  /api/*            forwarded to Invidious /api/v1/*
//!   POST /download         {id | playlist, profile, title?, limit?} -> 202, runs yt-dlp
//!   POST /cancel           {job} stops a queued or running download
//!   POST /open-folder      {kind: "video"|"audio"} opens that download folder in Explorer (local PC only)
//!   GET  /jobs             status of download jobs
//!   GET  /downloads        files in the download folders
//!   GET  /files/<name>     a downloaded file (Range supported, no path traversal)
use crate::config::{CONFIG, MAX_JOBS, VERSION};
use crate::util::{percent_decode, shell_open};
use crate::{jobs, state};
use serde::Serialize;
use serde_json::{Value, json};
use std::fs::{self, File};
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::thread;
use std::time::{Duration, UNIX_EPOCH};
use tiny_http::{Header, Method, Request, Response, Server};

include!(concat!(env!("OUT_DIR"), "/web_files.rs"));

const MEDIA_EXT: [&str; 6] = ["mp4", "mkv", "webm", "mp3", "m4a", "opus"];
const AUDIO_EXT: [&str; 3] = ["mp3", "m4a", "opus"];

type Reply = Response<Box<dyn Read + Send>>;

/// Bind the HTTP server (fails if the port is taken). Used by `--server` and by the launcher.
pub fn create() -> std::io::Result<Arc<Server>> {
    fs::create_dir_all(&CONFIG.video_dir)?;
    fs::create_dir_all(&CONFIG.audio_dir)?;
    let addr = (CONFIG.bind.as_str(), CONFIG.port);
    Server::http(addr).map(Arc::new).map_err(std::io::Error::other)
}

/// Handle requests until `server.unblock()` is called, one thread per request.
pub fn serve(server: Arc<Server>) {
    for request in server.incoming_requests() {
        thread::spawn(move || handle(request));
    }
}

fn handle(mut req: Request) {
    let reply = match req.method() {
        Method::Get | Method::Head => get(&req),
        Method::Post => post(&mut req),
        _ => error(501, "unsupported method"),
    };
    // Always send Content-Length (tiny_http would switch to chunked above 32 KB); players want it for seeking.
    let _ = req.respond(reply.with_chunked_threshold(usize::MAX));
}

// ---------------------------------------------------------------- responses

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

fn bytes(status: u16, content_type: &str, body: Vec<u8>) -> Reply {
    let len = body.len();
    Response::new(status.into(), vec![header("Content-Type", content_type)], Box::new(Cursor::new(body)) as _, Some(len), None)
}

fn json_reply(status: u16, value: &impl Serialize) -> Reply {
    let body = serde_json::to_vec(value).unwrap_or_default();
    bytes(status, "application/json; charset=utf-8", body).with_header(header("Cache-Control", "no-store"))
}

fn error(status: u16, message: &str) -> Reply {
    json_reply(status, &json!({ "error": message }))
}

fn header_value<'a>(req: &'a Request, name: &'static str) -> Option<&'a str> {
    req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str())
}

/// Defence against DNS rebinding / drive-by requests to a local service.
fn host_ok(req: &Request) -> bool {
    if CONFIG.bind != "127.0.0.1" {
        return true; // LAN mode (build guide section 12) deliberately accepts other host names
    }
    let host = header_value(req, "Host").unwrap_or("").to_lowercase();
    let port = CONFIG.port;
    [format!("localhost:{port}"), format!("127.0.0.1:{port}"), "localhost".into(), "127.0.0.1".into()].contains(&host)
}

fn split_url(url: &str) -> (&str, Option<&str>) {
    let url = url.split('#').next().unwrap_or("");
    match url.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (url, None),
    }
}

// ---------------------------------------------------------------- routing

fn get(req: &Request) -> Reply {
    if !host_ok(req) {
        return error(403, "bad host");
    }
    let (path, query) = split_url(req.url());
    match path {
        "/config.json" => json_reply(200, &json!({
            "invidious": CONFIG.invidious_public, "maxJobs": MAX_JOBS, "videoDir": CONFIG.video_dir,
            "audioDir": CONFIG.audio_dir, "version": VERSION,
        })),
        "/state" => json_reply(200, &state::load()),
        "/status" => json_reply(200, &json!({
            "invidious": invidious_up(), "ytdlp": jobs::find_ytdlp(&jobs::tool_path()).is_some(),
        })),
        "/jobs" => json_reply(200, &jobs::list()),
        "/downloads" => json_reply(200, &list_downloads()),
        _ if path.starts_with("/api/") => proxy_api(&path["/api/".len()..], query),
        _ if path.starts_with("/files/") => match resolve_download(&percent_decode(&path["/files/".len()..])) {
            Some(file) => send_file(req, &file),
            None => error(404, "not found"),
        },
        _ => serve_static(req, path),
    }
}

fn post(req: &mut Request) -> Reply {
    if !host_ok(req) {
        return error(403, "bad host");
    }
    if let Some(origin) = header_value(req, "Origin") {
        let netloc = origin.split_once("://").map_or("", |(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or(""));
        if netloc.to_lowercase() != header_value(req, "Host").unwrap_or("").to_lowercase() {
            return error(403, "cross-origin request refused");
        }
    }
    let path = split_url(req.url()).0.to_string();
    if !["/download", "/open-folder", "/cancel", "/state"].contains(&path.as_str()) {
        return error(404, "not found");
    }
    if !header_value(req, "Content-Type").unwrap_or("").contains("application/json") {
        return error(415, "expected application/json");
    }
    let Some(data) = read_json(req, if path == "/state" { 1_500_000 } else { 4096 }) else {
        return error(400, "bad request body");
    };
    match path.as_str() {
        "/state" => {
            let key = data.get("key").and_then(Value::as_str).unwrap_or("");
            let value = data.get("value").cloned().unwrap_or(Value::Null);
            if !state::valid(key, &value) {
                return error(400, "unknown key or invalid value");
            }
            match state::save(key, value) {
                Ok(()) => json_reply(200, &json!({ "saved": true })),
                Err(e) => error(500, &format!("could not save: {e}")),
            }
        }
        "/cancel" => {
            let job = data.get("job").and_then(Value::as_str).unwrap_or("");
            if !((10..=16).contains(&job.len()) && job.bytes().all(|b| b.is_ascii_digit())) {
                return error(400, "invalid job");
            }
            if !jobs::cancel(job) {
                return error(404, "no such running job");
            }
            json_reply(200, &json!({ "cancelled": true }))
        }
        "/open-folder" => {
            if !req.remote_addr().is_some_and(|a| a.ip().is_loopback()) {
                return error(403, "only available on the PC itself");
            }
            let folder = match data.get("kind").and_then(Value::as_str) {
                Some("video") => &CONFIG.video_dir,
                Some("audio") => &CONFIG.audio_dir,
                _ => return error(400, "unknown folder"),
            };
            // a fixed path chosen by us, never user input
            let _ = fs::create_dir_all(folder);
            shell_open(folder);
            json_reply(200, &json!({ "opened": true }))
        }
        _ => download(&data),
    }
}

/// The body as JSON, or None if it is too long or not JSON. An empty body counts as {}.
fn read_json(req: &mut Request, max: usize) -> Option<Value> {
    if let Some(len) = header_value(req, "Content-Length") {
        if len.trim().parse::<usize>().ok()? > max {
            return None;
        }
    }
    let mut body = Vec::new();
    req.as_reader().take(max as u64 + 1).read_to_end(&mut body).ok()?;
    if body.len() > max {
        return None;
    }
    if body.is_empty() {
        return Some(json!({}));
    }
    serde_json::from_slice(&body).ok()
}

fn id_chars(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn download(data: &Value) -> Reply {
    let Some(profile) = data.get("profile").and_then(Value::as_str).and_then(jobs::profile) else {
        return error(400, "unknown profile");
    };
    // Display-only text for the jobs list. It never reaches a command line.
    let title = data.get("title").and_then(Value::as_str).unwrap_or("");
    let title: String = title.chars().filter(|c| !matches!(c, '\0'..='\x1f' | '\x7f')).collect();
    let title: String = title.trim().chars().take(120).collect();
    let video = data.get("id").and_then(Value::as_str).filter(|v| v.len() == 11 && id_chars(v));
    let playlist = data.get("playlist").and_then(Value::as_str).filter(|p| (10..=64).contains(&p.len()) && id_chars(p));
    let job = if let Some(video) = video {
        jobs::start("video", video, profile, title, None)
    } else if let Some(playlist) = playlist {
        if playlist.starts_with("RD") {
            return error(400, "YouTube Mix playlists are endless and cannot be downloaded. Open a normal playlist instead.");
        }
        let limit = match data.get("limit") {
            None | Some(Value::Null) => None,
            Some(v) => match v.as_u64().filter(|n| (1..=jobs::MAX_LIMIT).contains(n)) {
                Some(n) => Some(n),
                None => return error(400, &format!("limit must be a whole number from 1 to {}", jobs::MAX_LIMIT)),
            },
        };
        jobs::start("playlist", playlist, profile, title, limit)
    } else {
        return error(400, "invalid video or playlist id");
    };
    json_reply(202, &json!({ "accepted": true, "job": job }))
}

// ---------------------------------------------------------------- Invidious

static AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    ureq::Agent::config_builder().http_status_as_error(false).build().into()
});

/// GET a URL with a time limit. Any HTTP status counts as an answer.
pub fn fetch(url: &str, timeout: Duration) -> Result<(u16, Vec<u8>), String> {
    let mut resp = AGENT.get(url).config().timeout_global(Some(timeout)).build().call().map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body = resp.body_mut().with_config().limit(256 * 1024 * 1024).read_to_vec().map_err(|e| e.to_string())?;
    Ok((status, body))
}

fn proxy_api(rest: &str, query: Option<&str>) -> Reply {
    let mut upstream = format!("{}/api/v1/{rest}", CONFIG.invidious);
    if let Some(q) = query.filter(|q| !q.is_empty()) {
        upstream = format!("{upstream}?{q}");
    }
    match fetch(&upstream, Duration::from_secs(45)) {
        Ok((status, body)) => bytes(status, "application/json; charset=utf-8", body),
        Err(e) => error(502, &format!("Invidious unreachable: {e}")),
    }
}

/// Does Invidious answer HTTP at all? Its home page is rendered locally, so unlike a search this does not wait for
/// a round trip to YouTube. Any HTTP reply counts, even an error page.
fn invidious_up() -> bool {
    // a closed localhost port takes about 2 s to refuse on Windows; a short socket check does not
    let Some(addr) = CONFIG.invidious_addr() else { return false };
    if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_err() {
        return false;
    }
    fetch(&format!("{}/", CONFIG.invidious), Duration::from_secs(3)).is_ok()
}

/// Is anything listening on this local port? Much cheaper than an HTTP request through WSL's relay.
pub fn port_open(port: u16) -> bool {
    ("127.0.0.1", port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut a| a.next())
        .is_some_and(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok())
}

// ---------------------------------------------------------------- files

fn extension(name: &str) -> String {
    Path::new(name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

#[derive(Serialize)]
struct Download {
    name: String,
    size: u64,
    mtime: u64,
    id: Option<String>,
    kind: &'static str,
}

/// The video id in "Title [dQw4w9WgXcQ].mp4".
fn id_in_name(name: &str) -> Option<String> {
    let (stem, ext) = name.rsplit_once('.')?;
    let b = stem.as_bytes();
    if ext.is_empty() || b.len() < 13 || b[b.len() - 1] != b']' || b[b.len() - 13] != b'[' {
        return None;
    }
    let id = std::str::from_utf8(&b[b.len() - 12..b.len() - 1]).ok()?;
    id_chars(id).then(|| id.to_string())
}

fn list_downloads() -> Vec<Download> {
    let mut items = Vec::new();
    for folder in [&CONFIG.video_dir, &CONFIG.audio_dir] {
        for entry in fs::read_dir(folder).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let ext = extension(&name);
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() || !MEDIA_EXT.contains(&ext.as_str()) {
                continue;
            }
            let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
            let kind = if AUDIO_EXT.contains(&ext.as_str()) { "audio" } else { "video" };
            items.push(Download { id: id_in_name(&name), name, size: meta.len(), mtime, kind });
        }
    }
    items.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    items
}

/// The real path of a downloaded file, or None. Rejects anything that is not a bare file name.
fn resolve_download(name: &str) -> Option<PathBuf> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':', '\0']) {
        return None;
    }
    if !MEDIA_EXT.contains(&extension(name).as_str()) {
        return None;
    }
    [&CONFIG.video_dir, &CONFIG.audio_dir].into_iter().find_map(|folder| {
        let base = folder.canonicalize().ok()?;
        let file = base.join(name).canonicalize().ok()?;
        (file.parent() == Some(base.as_path()) && file.is_file()).then_some(file)
    })
}

fn serve_static(req: &Request, path: &str) -> Reply {
    let rel = if path.is_empty() || path == "/" { "index.html".to_string() } else { percent_decode(path).trim_start_matches('/').to_string() };
    let Some((name, embedded)) = WEB_FILES.iter().find(|(name, _)| *name == rel) else {
        return error(404, "not found");
    };
    // Debug builds read web/ from disk, so a change to the UI only needs a page reload.
    if cfg!(debug_assertions) {
        if let Ok(data) = fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("web").join(name)) {
            return send_range(req, name, data.len() as u64, |start, len| {
                Box::new(Cursor::new(data[start as usize..(start + len) as usize].to_vec()))
            });
        }
    }
    send_range(req, name, embedded.len() as u64, |start, len| Box::new(&embedded[start as usize..(start + len) as usize]))
}

fn send_file(req: &Request, path: &Path) -> Reply {
    let Ok(mut file) = File::open(path) else { return error(404, "not found") };
    let size = file.metadata().map_or(0, |m| m.len());
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    send_range(req, &name, size, move |start, len| {
        let _ = file.seek(SeekFrom::Start(start));
        Box::new(file.take(len))
    })
}

fn content_type(name: &str) -> &'static str {
    match extension(name).as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/vnd.microsoft.icon",
        "woff2" => "font/woff2",
        "mp4" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "opus" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

/// Which bytes to send: Ok((start, length, partial)) or Err(()) for 416.
fn parse_range(range: Option<&str>, size: u64) -> Result<(u64, u64, bool), ()> {
    let Some(range) = range else { return Ok((0, size, false)) };
    let spec = range.trim().strip_prefix("bytes=").ok_or(())?;
    let (first, last) = spec.split_once('-').ok_or(())?;
    let number = |s: &str| -> Result<Option<u64>, ()> {
        if s.is_empty() { Ok(None) } else if s.bytes().all(|b| b.is_ascii_digit()) { s.parse().map(Some).map_err(|_| ()) } else { Err(()) }
    };
    let (start, end) = match (number(first)?, number(last)?) {
        (None, None) => return Err(()),
        (Some(start), last) => (start, last.map_or(size.saturating_sub(1), |l| l.min(size.saturating_sub(1)))),
        (None, Some(suffix)) => (size.saturating_sub(suffix), size.saturating_sub(1)), // the last N bytes
    };
    if start > end || start >= size {
        return Err(());
    }
    Ok((start, end - start + 1, true))
}

fn send_range(req: &Request, name: &str, size: u64, body: impl FnOnce(u64, u64) -> Box<dyn Read + Send>) -> Reply {
    let (start, len, partial) = match parse_range(header_value(req, "Range"), size) {
        Ok(r) => r,
        Err(()) => {
            let range = header("Content-Range", &format!("bytes */{size}"));
            return Response::new(416.into(), vec![range], Box::new(std::io::empty()) as _, Some(0), None);
        }
    };
    let mut headers = vec![
        header("Content-Type", content_type(name)),
        header("Accept-Ranges", "bytes"),
        header("Cache-Control", "no-cache"),
    ];
    if partial {
        headers.push(header("Content-Range", &format!("bytes {start}-{}/{size}", start + len - 1)));
    }
    let reader: Box<dyn Read + Send> = if *req.method() == Method::Head { Box::new(std::io::empty()) } else { body(start, len) };
    Response::new(if partial { 206 } else { 200 }.into(), headers, reader, Some(len as usize), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range(None, 100), Ok((0, 100, false)));
        assert_eq!(parse_range(Some("bytes=0-"), 100), Ok((0, 100, true)));
        assert_eq!(parse_range(Some("bytes=10-19"), 100), Ok((10, 10, true)));
        assert_eq!(parse_range(Some("bytes=90-500"), 100), Ok((90, 10, true)));
        assert_eq!(parse_range(Some("bytes=-30"), 100), Ok((70, 30, true)));
        assert_eq!(parse_range(Some("bytes=-300"), 100), Ok((0, 100, true)));
        assert_eq!(parse_range(Some("bytes=100-"), 100), Err(()));
        assert_eq!(parse_range(Some("bytes=-"), 100), Err(()));
        assert_eq!(parse_range(Some("bytes=5-1"), 100), Err(()));
        assert_eq!(parse_range(Some("items=0-1"), 100), Err(()));
        assert_eq!(parse_range(Some("bytes=0-1,5-6"), 100), Err(()));
    }

    #[test]
    fn names() {
        assert_eq!(id_in_name("Song [dQw4w9WgXcQ].mp3").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(id_in_name("Ã©tÃ© [dQw4w9WgXcQ].webm").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(id_in_name("nothing.mp4"), None);
        assert_eq!(resolve_download("../secret.mp4"), None);
        assert_eq!(resolve_download("..\\secret.mp4"), None);
        assert_eq!(resolve_download("C:secret.mp4"), None);
        assert_eq!(percent_decode("a%20b%zz%E2%9C%93"), "a b%zz\u{2713}");
    }
}
