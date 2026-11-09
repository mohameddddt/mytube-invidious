//! The few Windows API calls the app needs, declared directly (no binding crate).
use std::ffi::{OsStr, c_void};
use std::os::windows::ffi::OsStrExt;
use std::ptr::null_mut;

#[repr(C)]
#[derive(Default)]
pub struct SystemTime {
    pub year: u16,
    pub month: u16,
    pub day_of_week: u16,
    pub day: u16,
    pub hour: u16,
    pub minute: u16,
    pub second: u16,
    pub milliseconds: u16,
}

#[link(name = "user32")]
unsafe extern "system" {
    fn MessageBoxW(hwnd: *mut c_void, text: *const u16, caption: *const u16, kind: u32) -> i32;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateMutexW(attributes: *const c_void, initial_owner: i32, name: *const u16) -> *mut c_void;
    fn AttachConsole(process_id: u32) -> i32;
    fn GetLocalTime(time: *mut SystemTime);
}

#[link(name = "shell32")]
unsafe extern "system" {
    fn ShellExecuteW(hwnd: *mut c_void, op: *const u16, file: *const u16, params: *const u16, dir: *const u16, show: i32) -> *mut c_void;
}

pub const MB_ICONERROR: u32 = 0x10;
pub const MB_ICONQUESTION: u32 = 0x20;
pub const MB_ICONINFORMATION: u32 = 0x40;
pub const MB_YESNO: u32 = 0x4;
pub const IDYES: i32 = 6;
const MB_SETFOREGROUND: u32 = 0x10000;
const ERROR_ALREADY_EXISTS: i32 = 183;

fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain([0]).collect()
}

/// Native message box, brought to the front. Returns the button pressed (IDYES, ...).
pub fn message_box(text: &str, caption: &str, style: u32) -> i32 {
    let (text, caption) = (wide(text), wide(caption));
    unsafe { MessageBoxW(null_mut(), text.as_ptr(), caption.as_ptr(), style | MB_SETFOREGROUND) }
}

/// Creates a named mutex that is held until the process exits. True if another process already holds it.
pub fn already_running(name: &str) -> bool {
    let name = wide(name);
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    let exists = std::io::Error::last_os_error().raw_os_error() == Some(ERROR_ALREADY_EXISTS);
    let _ = handle; // never closed: the mutex lives as long as the process
    exists
}

/// Lets a windowed exe print to the console it was started from, if any.
pub fn attach_parent_console() {
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    unsafe { AttachConsole(ATTACH_PARENT_PROCESS) };
}

pub fn local_time() -> SystemTime {
    let mut t = SystemTime::default();
    unsafe { GetLocalTime(&mut t) };
    t
}

/// Open a folder, file or URL with its default program (like Python's os.startfile).
pub fn shell_open(target: &OsStr) {
    const SW_SHOWNORMAL: i32 = 1;
    let target = wide(target);
    unsafe { ShellExecuteW(null_mut(), std::ptr::null(), target.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
}
