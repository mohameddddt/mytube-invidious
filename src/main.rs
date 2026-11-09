//! My Tube: a personal, self-hosted YouTube interface on top of Invidious.
//!
//!   MyTube.exe            the desktop app: starts Invidious in WSL, the local server and the app window
//!   MyTube.exe --server   only the local server on http://localhost:8080 (what start-yt.bat uses)
//!
//! Release builds are windowed (no console); debug builds keep the console so `cargo run -- --server` logs and
//! stops with Ctrl+C.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod config;
mod jobs;
#[cfg(windows)]
mod launcher;
mod server;
mod state;
mod util;
#[cfg(windows)]
mod win;
#[cfg(windows)]
mod window;

use config::CONFIG;
use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--server") || cfg!(not(windows)) {
        run_server();
    } else if args.iter().any(|a| a == "--version") {
        println!("My Tube {}", config::VERSION);
    } else {
        #[cfg(windows)]
        run_app();
    }
}

fn run_server() {
    #[cfg(windows)]
    win::attach_parent_console();
    let server = match server::create() {
        Ok(s) => s,
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "cannot listen on {}:{}: {e}", CONFIG.bind, CONFIG.port);
            std::process::exit(1);
        }
    };
    let _ = writeln!(std::io::stdout(), "UI backend on http://{}:{}  ->  Invidious {}", CONFIG.bind, CONFIG.port, CONFIG.invidious);
    server::serve(server);
}

#[cfg(windows)]
fn run_app() {
    // A panic in a request thread only loses that request; it is logged and the app carries on.
    std::panic::set_hook(Box::new(|info| launcher::log(&format!("panic: {info}"))));
    // Last resort for the launcher itself: tell the user instead of vanishing.
    if let Err(panic) = std::panic::catch_unwind(launcher::run) {
        let text = panic
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| panic.downcast_ref::<&str>().copied())
            .unwrap_or("unknown error");
        launcher::log(&format!("fatal: {text}"));
        launcher::message(
            &format!("My Tube hit a problem and has to close.\n\n{text}\n\nDetails: {}", launcher::log_file().display()),
            win::MB_ICONERROR,
        );
    }
}
