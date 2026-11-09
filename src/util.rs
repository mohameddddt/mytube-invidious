//! Small helpers shared by the server and the launcher.
use std::env;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64())
}

/// A command that never flashes a console window.
pub fn quiet_command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Stop a process and its children (on Windows that includes yt-dlp's ffmpeg).
pub fn kill_tree(pid: u32) {
    let mut cmd = if cfg!(windows) {
        let mut c = quiet_command("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]);
        c
    } else {
        let mut c = Command::new("kill");
        c.args(["-TERM", &pid.to_string()]);
        c
    };
    let _ = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

/// Like `shutil.which`: look for `name` in each folder of `path`, trying the PATHEXT extensions on Windows.
pub fn which(name: &str, path: &OsStr) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) {
        let pathext = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        pathext.split(';').filter(|e| !e.is_empty()).map(str::to_lowercase).collect()
    } else {
        vec![String::new()]
    };
    env::split_paths(path).filter(|dir| !dir.as_os_str().is_empty()).find_map(|dir| {
        exts.iter().map(|ext| dir.join(format!("{name}{ext}"))).find(|p| p.is_file())
    })
}

/// Percent-decoding as Python's `urllib.parse.unquote` does it: bad escapes stay as they are, bad UTF-8 is replaced.
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Opens a folder or URL with its default program, like double-clicking it.
pub fn shell_open(target: &Path) {
    #[cfg(windows)]
    crate::win::shell_open(target.as_os_str());
    #[cfg(not(windows))]
    let _ = Command::new("xdg-open").arg(target).spawn();
}
