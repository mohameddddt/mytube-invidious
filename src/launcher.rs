//! The desktop app. Click MyTube.exe and it
//!   1. starts the Invidious containers in WSL (unless they are already running),
//!   2. starts the local web server (built into the exe),
//!   3. opens the interface in its own window (WebView2, see window.rs).
//! Closing that window stops everything it started and gives all of WSL's memory back.
use crate::config::CONFIG;
use crate::util::{kill_tree, quiet_command};
use crate::win::{self, IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_ICONQUESTION, MB_YESNO};
use crate::{jobs, server, window};
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::thread;
use std::time::{Duration, Instant};

const APP: &str = "My Tube";
/// Set once we are shutting down on purpose.
static STOPPING: AtomicBool = AtomicBool::new(false);
static URL: LazyLock<String> = LazyLock::new(|| format!("http://localhost:{}", CONFIG.port));
static DISTRO: LazyLock<String> = LazyLock::new(|| CONFIG.setting("distro").unwrap_or("Ubuntu-24.04").to_string());

pub fn log_file() -> PathBuf {
    CONFIG.data_dir.join("mytube.log")
}

// --------------------------------------------------------------------------- small helpers
pub fn log(text: &str) {
    let path = log_file();
    let _ = fs::create_dir_all(&CONFIG.data_dir);
    if fs::metadata(&path).is_ok_and(|m| m.len() > 512_000) {
        let _ = fs::write(&path, "");
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let t = win::local_time();
        let _ = writeln!(f, "{}-{:02}-{:02} {:02}:{:02}:{:02}  {text}", t.year, t.month, t.day, t.hour, t.minute, t.second);
    }
}

pub fn message(text: &str, style: u32) -> i32 {
    win::message_box(text, APP, style)
}

/// Run a command without a window, killing it if it takes longer than `timeout`.
fn run_quiet(program: &str, args: &[&str], timeout: Duration) -> Option<ExitStatus> {
    let child = quiet_command(program).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            log(&format!("command failed {program} {:?}: {e}", &args[..args.len().min(2)]));
            return None;
        }
    };
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            _ => {
                log(&format!("command timed out {program} {:?}", &args[..args.len().min(2)]));
                let _ = child.kill();
                return None;
            }
        }
    }
}

fn url_ok(path: &str) -> bool {
    matches!(server::fetch(&format!("{}{path}", *URL), Duration::from_secs(2)), Ok((200, _)))
}

// --------------------------------------------------------------------------- the stack in WSL
struct Stack {
    pid: u32,
    exited: Arc<AtomicBool>,
}

impl Stack {
    /// A hidden WSL session that starts the containers and then keeps the VM alive.
    fn start() -> Option<Stack> {
        let boot = "until docker info >/dev/null 2>&1; do sleep 0.2; done; cd ~/invidious && docker compose up -d && exec sleep infinity";
        let spawned = quiet_command("wsl")
            .args(["-d", DISTRO.as_str(), "--", "bash", "-lc", boot])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                log(&format!("cannot start WSL: {e}"));
                thread::spawn(move || stack_failed(&format!("WSL could not be started: {e}")));
                return None;
            }
        };
        let exited = Arc::new(AtomicBool::new(false));
        let stack = Stack { pid: child.id(), exited: Arc::clone(&exited) };
        // The keepalive session never ends by itself. If it does, WSL or Docker could not be started.
        thread::spawn(move || {
            let code = child.wait().ok().and_then(|s| s.code());
            exited.store(true, Ordering::SeqCst);
            if STOPPING.load(Ordering::SeqCst) {
                return;
            }
            let code = code.map_or("unknown".into(), |c| c.to_string());
            log(&format!("stack process ended early with code {code}"));
            stack_failed(&format!("exit code {code}"));
        });
        Some(stack)
    }

    fn stop(&self) {
        log("stopping containers and WSL");
        if !self.exited.load(Ordering::SeqCst) {
            kill_tree(self.pid);
        }
        run_quiet("wsl", &["-d", DISTRO.as_str(), "--", "bash", "-lc", "cd ~/invidious && docker compose stop"], Duration::from_secs(120));
        run_quiet("wsl", &["--shutdown"], Duration::from_secs(60));
    }
}

fn stack_failed(reason: &str) {
    message(
        &format!(
            "The Invidious containers could not be started ({reason}).\n\nCheck that the WSL distribution \"{}\" exists, \
             that Docker is installed in it and that ~/invidious has been set up (see the launch guide).\n\n\
             You can set \"distro\" in {}.",
            *DISTRO,
            CONFIG.config_file().display()
        ),
        MB_ICONERROR,
    );
}

fn port_in_use() {
    message(
        &format!(
            "Port {} is in use by another program, so My Tube cannot start.\n\n\
             Close that program, or set the YT_PORT environment variable.",
            CONFIG.port
        ),
        MB_ICONERROR,
    );
}

/// Stops everything we started, also when the launcher panics.
struct Shutdown {
    server: Arc<tiny_http::Server>,
    stack: Option<Stack>,
}

impl Drop for Shutdown {
    fn drop(&mut self) {
        STOPPING.store(true, Ordering::SeqCst);
        for job in jobs::active() {
            jobs::cancel(&job.id);
        }
        self.server.unblock();
        if let Some(stack) = &self.stack {
            stack.stop();
        }
        log("bye");
    }
}

// --------------------------------------------------------------------------- main
/// The window onto the server, until the user closes it. Without WebView2, the default browser instead.
fn show_window() {
    log("opening window");
    match window::run(&URL) {
        Ok(()) => log("window closed"),
        Err(e) => {
            log(&format!("no app window ({e}), using the default browser"));
            loop {
                win::shell_open(OsStr::new(URL.as_str()));
                message("My Tube is running in your browser.\n\nClick OK when you want to stop it.", MB_ICONINFORMATION);
                let busy = jobs::active().len();
                if busy == 0
                    || message(&format!("{busy} download(s) are still running.\n\nQuit anyway and cancel them?"), MB_ICONQUESTION | MB_YESNO) == IDYES
                {
                    break;
                }
            }
        }
    }
}

pub fn run() {
    log("---- launch");
    let second_copy = win::already_running("Local\\MyTubeLauncher");
    // A second click: bring the open window forward instead of starting anything.
    if second_copy && window::focus_existing() {
        log("showing the window that is already open");
        return;
    }

    // Socket checks only: an HTTP request to a closed localhost port costs about 2 s on Windows.
    let already_serving = server::port_open(CONFIG.port);
    let invidious_port = CONFIG.invidious_addr().map_or(3000, |a| a.port());

    // Start WSL before anything else: booting its VM takes the longest (about 8 s) and now overlaps with the rest.
    let mut stack = None;
    if !second_copy && !already_serving && !server::port_open(invidious_port) {
        // we only stop what we started
        stack = Stack::start();
        log("starting containers");
    }

    // Already running without a window of ours (start-yt.bat is in use): a window onto that session.
    if second_copy || already_serving {
        log("attaching to a running instance");
        if !already_serving {
            message("My Tube is already starting or shutting down.\n\nTry again in a few seconds.", MB_ICONINFORMATION);
        } else if !url_ok("/config.json") {
            port_in_use(); // something listens on our port, but it is not My Tube
        } else {
            show_window();
        }
        return;
    }

    let server = match server::create() {
        Ok(s) => s,
        Err(e) => {
            log(&format!("cannot bind port: {e}"));
            STOPPING.store(true, Ordering::SeqCst);
            if let Some(stack) = &stack {
                stack.stop();
            }
            return port_in_use();
        }
    };
    let serving = Arc::clone(&server);
    thread::spawn(move || server::serve(serving));
    log(&format!("server up on {}", *URL));
    let _shutdown = Shutdown { server, stack };
    show_window();
}
