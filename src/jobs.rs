//! Download jobs: a queue of yt-dlp runs, at most MAX_JOBS at a time.
use crate::config::{CONFIG, MAX_JOBS};
use crate::util::{kill_tree, now, quiet_command, which};
use serde::Serialize;
use std::collections::BTreeMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::thread;

pub const MAX_LIMIT: u64 = 500;

/// Fixed download profiles (build guide 9.2). UI choices map to these and nothing else.
pub struct Profile {
    pub name: &'static str,
    audio: bool,
    args: &'static [&'static str],
}

const PROFILES: [Profile; 4] = [
    Profile { name: "data_saver", audio: false, args: &["-S", "res:480", "--merge-output-format", "mp4"] },
    Profile { name: "standard", audio: false, args: &["-S", "res:720", "--merge-output-format", "mp4"] },
    Profile { name: "high", audio: false, args: &["-S", "res:1080", "--merge-output-format", "mp4"] },
    Profile { name: "audio", audio: true, args: &["-x", "--audio-format", "mp3"] },
];
const COMMON: [&str; 5] = ["-o", "%(title)s [%(id)s].%(ext)s", "--no-mtime", "--newline", "--no-colors"];

pub fn profile(name: &str) -> Option<&'static Profile> {
    PROFILES.iter().find(|p| p.name == name)
}

impl Profile {
    fn dir(&self) -> &'static PathBuf {
        if self.audio { &CONFIG.audio_dir } else { &CONFIG.video_dir }
    }

    /// yt-dlp archive file per kind, so an audio run never makes a later video run skip everything.
    fn archive(&self) -> PathBuf {
        let _ = fs::create_dir_all(&CONFIG.data_dir);
        CONFIG.data_dir.join(if self.audio { "archive-audio.txt" } else { "archive-video.txt" })
    }
}

/// What the UI sees in GET /jobs.
#[derive(Serialize, Clone)]
pub struct Job {
    pub id: String,
    pub kind: &'static str,
    pub target: String,
    pub profile: &'static str,
    pub title: String,
    pub limit: Option<u64>,
    pub status: &'static str,
    pub percent: f64,
    pub overall: f64,
    pub index: u64,
    pub total: u64,
    pub skipped: u64,
    pub failed: u64,
    pub message: String,
    pub error: Option<String>,
    pub created: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished: Option<f64>,
    #[serde(skip)]
    pid: Option<u32>,
}

impl Job {
    fn active(&self) -> bool {
        matches!(self.status, "queued" | "running")
    }
}

static JOBS: Mutex<BTreeMap<String, Job>> = Mutex::new(BTreeMap::new());

fn jobs() -> MutexGuard<'static, BTreeMap<String, Job>> {
    JOBS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Job ids go in here; MAX_JOBS worker threads take them out in order.
static QUEUE: LazyLock<Sender<String>> = LazyLock::new(|| {
    let (tx, rx) = mpsc::channel::<String>();
    let rx = Arc::new(Mutex::new(rx));
    for _ in 0..MAX_JOBS {
        let rx = Arc::clone(&rx);
        thread::spawn(move || loop {
            let next = rx.lock().unwrap_or_else(|e| e.into_inner()).recv();
            match next {
                Ok(id) => run_job(&id),
                Err(_) => return,
            }
        });
    }
    tx
});

pub fn list() -> Vec<Job> {
    let mut all: Vec<Job> = jobs().values().cloned().collect();
    all.sort_by(|a, b| b.created.total_cmp(&a.created));
    all
}

pub fn active() -> Vec<Job> {
    jobs().values().filter(|j| j.active()).cloned().collect()
}

pub fn start(kind: &'static str, target: &str, profile: &'static Profile, title: String, limit: Option<u64>) -> String {
    let id = {
        let mut jobs = jobs();
        // don't queue the same thing twice
        if let Some(j) = jobs.values().find(|j| j.target == target && j.profile == profile.name && j.limit == limit && j.active()) {
            return j.id.clone();
        }
        let mut ms = (now() * 1000.0) as u64;
        while jobs.contains_key(&ms.to_string()) {
            ms += 1;
        }
        let id = ms.to_string();
        jobs.insert(id.clone(), Job {
            id: id.clone(), kind, target: target.to_string(), profile: profile.name, title, limit, status: "queued",
            percent: 0.0, overall: 0.0, index: 0, total: 0, skipped: 0, failed: 0, message: String::new(), error: None,
            created: now(), started: None, finished: None, pid: None,
        });
        // keep the list short
        let old: Vec<String> = jobs.keys().rev().skip(50).cloned().collect();
        for key in old {
            if !jobs[&key].active() {
                jobs.remove(&key);
            }
        }
        id
    };
    let _ = QUEUE.send(id.clone());
    id
}

pub fn cancel(id: &str) -> bool {
    let pid = {
        let mut jobs = jobs();
        let Some(job) = jobs.get_mut(id).filter(|j| j.active()) else { return false };
        job.status = "cancelled";
        job.finished = Some(now());
        job.pid
    };
    if let Some(pid) = pid {
        kill_tree(pid);
    }
    true
}

/// Change a job while holding the lock. Does nothing if the job is gone.
fn update(id: &str, f: impl FnOnce(&mut Job)) {
    if let Some(job) = jobs().get_mut(id) {
        f(job);
    }
}

/// Apply a final state unless the user cancelled in the meantime.
fn finish(id: &str, f: impl FnOnce(&mut Job)) {
    update(id, |job| {
        if job.status != "cancelled" {
            f(job);
        }
        job.finished = Some(now());
    });
}

fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

// ---------------------------------------------------------------- finding the tools

/// PATH with the folders where winget and Deno put their commands, so yt-dlp finds deno and ffmpeg even if
/// PATH is stale.
pub fn tool_path() -> OsString {
    let extra = [
        CONFIG.home.join("AppData").join("Local").join("Microsoft").join("WinGet").join("Links"),
        CONFIG.home.join(".deno").join("bin"),
    ];
    let current = env::var_os("PATH").unwrap_or_default();
    let dirs = extra.into_iter().filter(|p| p.exists()).chain(env::split_paths(&current));
    env::join_paths(dirs).unwrap_or(current)
}

/// PATH first, then the places yt-dlp usually lands, so a double-clicked exe works with a bare PATH.
pub fn find_ytdlp(path: &OsString) -> Option<PathBuf> {
    if let Some(configured) = CONFIG.setting("ytdlp").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(configured);
    }
    if let Some(found) = which("yt-dlp", path) {
        return Some(found);
    }
    let home = &CONFIG.home;
    let local = home.join("AppData").join("Local");
    let roaming = home.join("AppData").join("Roaming");
    let mut candidates = vec![local.join("Microsoft").join("WinGet").join("Links").join("yt-dlp.exe")];
    for base in [home.join("miniconda3"), home.join("anaconda3"), local.join("miniconda3")] {
        candidates.push(base.join("Scripts").join("yt-dlp.exe"));
    }
    for root in [roaming.join("Python"), local.join("Programs").join("Python")] {
        let mut versions: Vec<PathBuf> = fs::read_dir(&root)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("Python"))
            .map(|e| e.path().join("Scripts").join("yt-dlp.exe"))
            .collect();
        versions.sort_by(|a, b| b.cmp(a)); // newest Python first
        candidates.extend(versions);
    }
    candidates.into_iter().find(|c| c.is_file())
}

pub fn ytdlp_missing() -> String {
    format!(
        "yt-dlp was not found. Install it with \"winget install yt-dlp.yt-dlp\" (or \"python -m pip install -U \
         yt-dlp[default]\"), or set \"ytdlp\" in {}",
        CONFIG.config_file().display()
    )
}

// ---------------------------------------------------------------- running yt-dlp

/// The number before the first "%" in a progress line, e.g. "PCT  42.0%" -> 42.0.
fn parse_percent(line: &str) -> Option<f64> {
    line.match_indices('%').find_map(|(at, _)| {
        let head = &line[..at];
        let start = head.rfind(|c: char| !(c.is_ascii_digit() || c == '.')).map_or(0, |i| i + 1);
        head[start..].parse().ok()
    })
}

/// "[download] Downloading item 3 of 25" -> (3, 25).
fn parse_item(line: &str) -> Option<(u64, u64)> {
    let (_, rest) = line.split_once("Downloading item ")?;
    let digits = |s: &str| s.find(|c: char| !c.is_ascii_digit()).map_or(s.len(), |i| i);
    let n = digits(rest);
    let index = rest[..n].parse().ok()?;
    let rest = rest[n..].strip_prefix(" of ")?;
    let total = rest[..digits(rest)].parse().ok()?;
    Some((index, total))
}

fn run_job(id: &str) {
    let Some((kind, target, profile, limit)) = jobs()
        .get(id)
        .filter(|j| j.status != "cancelled") // cancelled while it was still queued
        .map(|j| (j.kind, j.target.clone(), profile(j.profile).unwrap(), j.limit))
    else {
        return;
    };
    let path = tool_path();
    let Some(exe) = find_ytdlp(&path) else {
        return finish(id, |j| (j.status, j.error) = ("error", Some(ytdlp_missing())));
    };
    let dir = profile.dir();
    let _ = fs::create_dir_all(dir);
    let playlist = kind == "playlist";
    let mut cmd = quiet_command(&exe);
    cmd.args(profile.args).args(COMMON).arg("-P").arg(dir);
    cmd.args(["--progress-template", "download:PCT %(progress._percent_str)s"]);
    let url = if playlist {
        // --ignore-errors: one private or deleted video must not stop the rest
        cmd.arg("--download-archive").arg(profile.archive()).args(["--yes-playlist", "--ignore-errors"]);
        if let Some(limit) = limit {
            cmd.arg("--playlist-end").arg(limit.to_string());
        }
        format!("https://www.youtube.com/playlist?list={target}")
    } else {
        cmd.arg("--no-playlist");
        format!("https://www.youtube.com/watch?v={target}")
    };
    cmd.arg("--").arg(url).env("PATH", &path).stdin(Stdio::null());

    let mut started = false;
    update(id, |j| {
        if j.status != "cancelled" {
            (j.status, j.started, started) = ("running", Some(now()), true);
        }
    });
    if !started {
        return;
    }
    // stdout and stderr share one pipe, so errors arrive in order with the progress lines
    let spawned = std::io::pipe().and_then(|(reader, writer)| {
        cmd.stdout(writer.try_clone()?).stderr(writer);
        let child = cmd.spawn();
        drop(cmd); // closes our copies of the pipe's write end, so the reader ends when yt-dlp does
        Ok((reader, child?))
    });
    let (reader, mut child) = match spawned {
        Ok(pair) => pair,
        Err(e) => return finish(id, |j| (j.status, j.error) = ("error", Some(clip(&e.to_string(), 400)))),
    };
    let mut cancelled = false;
    update(id, |j| {
        j.pid = Some(child.id());
        cancelled = j.status == "cancelled"; // cancel arrived while the process was starting
    });
    if cancelled {
        kill_tree(child.id());
    }

    let mut tail: Vec<String> = Vec::new();
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        if !matches!(reader.read_until(b'\n', &mut buf), Ok(n) if n > 0) {
            break;
        }
        for line in String::from_utf8_lossy(&buf).split('\r').map(str::trim) {
            update(id, |j| {
                if line.starts_with("PCT ") {
                    if let Some(p) = parse_percent(line) {
                        j.percent = p;
                    }
                } else {
                    if let Some((index, total)) = parse_item(line) {
                        (j.index, j.total, j.percent) = (index, total, 0.0);
                    } else if line.contains("already been recorded in the archive") {
                        j.skipped += 1;
                    } else if line.starts_with("ERROR:") {
                        j.failed += 1;
                        tail.push(line.to_string());
                    } else if !line.is_empty() {
                        tail.push(line.to_string());
                    }
                    if tail.len() > 6 {
                        tail.drain(..tail.len() - 6);
                    }
                }
                if playlist && j.total > 0 {
                    let done = (j.index.saturating_sub(1)) as f64 + j.percent / 100.0;
                    j.overall = (done / j.total as f64 * 1000.0).round() / 10.0;
                }
            });
        }
    }
    let status = child.wait();
    update(id, |j| {
        j.pid = None;
        let saved = j.index.saturating_sub(j.failed).saturating_sub(j.skipped);
        if playlist {
            let mut parts = vec![format!("{saved} saved")];
            if j.skipped > 0 {
                parts.push(format!("{} already downloaded", j.skipped));
            }
            if j.failed > 0 {
                parts.push(format!("{} unavailable", j.failed));
            }
            j.message = parts.join(", ");
        }
        let ok = status.as_ref().is_ok_and(|s| s.success()) || (playlist && (saved > 0 || j.skipped > 0));
        if j.status != "cancelled" {
            if ok {
                (j.status, j.percent, j.overall) = ("done", 100.0, 100.0);
            } else {
                let code = status.as_ref().ok().and_then(|s| s.code()).map_or("?".into(), |c| c.to_string());
                let last = tail[tail.len().saturating_sub(3)..].join(" | ");
                j.status = "error";
                j.error = Some(if last.is_empty() { format!("yt-dlp exit {code}") } else { clip(&last, 400) });
            }
        }
        j.finished = Some(now());
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_lines() {
        assert_eq!(parse_percent("PCT  42.5%"), Some(42.5));
        assert_eq!(parse_percent("PCT 100%"), Some(100.0));
        assert_eq!(parse_percent("PCT N/A%"), None);
        assert_eq!(parse_item("[download] Downloading item 3 of 25"), Some((3, 25)));
        assert_eq!(parse_item("[download] Downloading playlist: x"), None);
    }
}
