//! The app window: a plain Win32 window hosting WebView2, the Edge engine that is part of Windows 11.
//!
//! It uses about a third less memory than an Edge app-mode window and lives exactly as long as this process.
//! While the window is minimized WebView2 is asked to keep its memory use low.
use crate::config::CONFIG;
use crate::jobs;
use crate::launcher::log;
use crate::util::shell_open;
use std::cell::RefCell;
use std::ffi::c_void;
use std::fs;
use std::path::Path;
use std::sync::mpsc;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    ContainsFullScreenElementChangedEventHandler, CreateCoreWebView2ControllerCompletedHandler,
    CreateCoreWebView2EnvironmentCompletedHandler, DocumentTitleChangedEventHandler, NavigationStartingEventHandler,
    NewWindowRequestedEventHandler, take_pwstr,
};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Dwm::{DWMWA_USE_IMMERSIVE_DARK_MODE, DwmSetWindowAttribute};
use windows::Win32::Graphics::Gdi::{CreateSolidBrush, GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow};
use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress, LoadLibraryW};
use windows::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
use windows::Win32::System::WinRT::EventRegistrationToken;
use windows::Win32::UI::HiDpi::GetDpiForSystem;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{HSTRING, Interface, PCWSTR, PWSTR, s, w};

const CLASS: PCWSTR = w!("MyTubeWindow");
/// Microsoft's redistributable loader from the WebView2 SDK, kept inside the exe so My Tube stays one file.
static LOADER: &[u8] = include_bytes!("../assets/WebView2Loader.dll");

type CreateEnvironment = unsafe extern "system" fn(PCWSTR, PCWSTR, *mut c_void, *mut c_void) -> windows::core::HRESULT;

struct View {
    controller: ICoreWebView2Controller,
    webview: ICoreWebView2,
    /// Window style and placement saved while a video is full screen.
    restore: Option<(isize, WINDOWPLACEMENT)>,
}

thread_local! {
    static VIEW: RefCell<Option<View>> = const { RefCell::new(None) };
}

/// If another copy of the app has its window open, bring that window to the front.
pub fn focus_existing() -> bool {
    unsafe {
        let Ok(hwnd) = FindWindowW(CLASS, PCWSTR::null()) else { return false };
        if hwnd.is_invalid() {
            return false;
        }
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let _ = SetForegroundWindow(hwnd);
        true
    }
}

/// Show `url` in the app window and return when the user has closed it.
/// Fails (before any window is shown) when WebView2 cannot start, so the caller can fall back to a browser.
pub fn run(url: &str) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let hwnd = create_window().map_err(|e| format!("window: {e}"))?;
        if let Err(e) = attach_webview(hwnd, url) {
            let _ = DestroyWindow(hwnd);
            return Err(e);
        }
        let _ = ShowWindow(hwnd, SW_SHOWNORMAL);
        let _ = SetForegroundWindow(hwnd);
        remove_old_profile();
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    Ok(())
}

fn dark_mode() -> bool {
    let mut value = 1u32;
    let mut size = 4u32;
    let path = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
    let err = unsafe {
        RegGetValueW(HKEY_CURRENT_USER, path, w!("AppsUseLightTheme"), RRF_RT_REG_DWORD, None,
                     Some(&mut value as *mut u32 as *mut c_void), Some(&mut size))
    };
    err.is_ok() && value == 0
}

/// The page background (style.css --bg), so nothing flashes white while it loads.
fn background() -> (u8, u8, u8) {
    if dark_mode() { (0x10, 0x0e, 0x0c) } else { (0xf5, 0xef, 0xe4) }
}

unsafe fn create_window() -> windows::core::Result<HWND> {
    unsafe {
        let instance = GetModuleHandleW(None)?;
        let (r, g, b) = background();
        let icon = LoadIconW(instance, PCWSTR(1 as _)).unwrap_or_default(); // group icon 1, written by build.rs
        let class = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(window_proc),
            hInstance: instance.into(),
            hIcon: icon,
            hIconSm: icon,
            hCursor: LoadCursorW(None, IDC_ARROW)?,
            hbrBackground: CreateSolidBrush(COLORREF(r as u32 | (g as u32) << 8 | (b as u32) << 16)),
            lpszClassName: CLASS,
            ..Default::default()
        };
        RegisterClassExW(&class);
        let scale = |v: i32| v * GetDpiForSystem() as i32 / 96;
        let hwnd = CreateWindowExW(WINDOW_EX_STYLE(0), CLASS, w!("My Tube"), WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT,
                                   scale(1360), scale(860), None, None, instance, None)?;
        let dark = BOOL::from(dark_mode());
        let _ = DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark as *const BOOL as *const c_void, 4);
        Ok(hwnd)
    }
}

/// Writes the embedded WebView2 loader next to the app's data (once) and returns its entry point.
fn loader() -> Result<CreateEnvironment, String> {
    let path = CONFIG.data_dir.join("WebView2Loader.dll");
    if fs::read(&path).map_or(true, |existing| existing != LOADER) {
        fs::create_dir_all(&CONFIG.data_dir).map_err(|e| e.to_string())?;
        fs::write(&path, LOADER).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    unsafe {
        let module = LoadLibraryW(&HSTRING::from(path.as_os_str())).map_err(|e| format!("WebView2Loader.dll: {e}"))?;
        let entry = GetProcAddress(module, s!("CreateCoreWebView2EnvironmentWithOptions")).ok_or("WebView2Loader.dll has no entry point")?;
        Ok(std::mem::transmute::<unsafe extern "system" fn() -> isize, CreateEnvironment>(entry))
    }
}

fn attach_webview(hwnd: HWND, url: &str) -> Result<(), String> {
    let t = std::time::Instant::now();
    let create = loader()?;
    let data = HSTRING::from(CONFIG.data_dir.join("webview").as_os_str());
    let err = |e: webview2_com::Error| format!("{e:?}");

    let (tx, rx) = mpsc::channel();
    CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| unsafe {
            create(PCWSTR::null(), PCWSTR(data.as_ptr()), std::ptr::null_mut(), handler.as_raw())
                .ok()
                .map_err(webview2_com::Error::WindowsError)
        }),
        Box::new(move |result, env| {
            let _ = tx.send(result.and_then(|()| env.ok_or_else(|| E_POINTER.into())));
            Ok(())
        }),
    )
    .map_err(err)?;
    let env = rx.recv().map_err(|e| e.to_string())?.map_err(|e| format!("WebView2 is not available: {e}"))?;

    let (tx, rx) = mpsc::channel();
    CreateCoreWebView2ControllerCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| unsafe { env.CreateCoreWebView2Controller(hwnd, &handler).map_err(webview2_com::Error::WindowsError) }),
        Box::new(move |result, controller| {
            let _ = tx.send(result.and_then(|()| controller.ok_or_else(|| E_POINTER.into())));
            Ok(())
        }),
    )
    .map_err(err)?;
    let controller = rx.recv().map_err(|e| e.to_string())?.map_err(|e| format!("WebView2 window: {e}"))?;

    unsafe { setup(hwnd, controller, url) }.map_err(|e| format!("WebView2 setup: {e}"))?;
    log(&format!("window ready in {} ms", t.elapsed().as_millis()));
    Ok(())
}

/// Pages that belong in the app window; everything else opens in the default browser.
fn is_internal(uri: &str) -> bool {
    if !(uri.starts_with("http://") || uri.starts_with("https://")) {
        return true; // about:, data:, blob: and the like
    }
    let port = CONFIG.port;
    let ours = [format!("http://localhost:{port}"), format!("http://127.0.0.1:{port}"), CONFIG.invidious_public.clone()];
    ours.iter().any(|origin| uri == origin || uri.starts_with(&format!("{}/", origin.trim_end_matches('/'))))
}

fn open_external(uri: &str) {
    if uri.starts_with("http://") || uri.starts_with("https://") {
        shell_open(Path::new(uri));
    }
}

unsafe fn setup(hwnd: HWND, controller: ICoreWebView2Controller, url: &str) -> windows::core::Result<()> {
    unsafe {
        let mut rect = RECT::default();
        GetClientRect(hwnd, &mut rect)?;
        controller.SetBounds(rect)?;
        if let Ok(c2) = controller.cast::<ICoreWebView2Controller2>() {
            let (r, g, b) = background();
            let _ = c2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR { A: 255, R: r, G: g, B: b });
        }
        let webview = controller.CoreWebView2()?;
        let settings = webview.Settings()?;
        settings.SetIsStatusBarEnabled(false)?;
        settings.SetAreDevToolsEnabled(cfg!(debug_assertions))?;
        if let Ok(s4) = settings.cast::<ICoreWebView2Settings4>() {
            let _ = s4.SetIsGeneralAutofillEnabled(false);
            let _ = s4.SetIsPasswordAutosaveEnabled(false);
        }

        let mut token = EventRegistrationToken::default();
        // target=_blank links and window.open: the default browser
        webview.add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    let mut uri = PWSTR::null();
                    args.Uri(&mut uri)?;
                    args.SetHandled(true)?;
                    open_external(&take_pwstr(uri));
                }
                Ok(())
            })),
            &mut token,
        )?;
        // a plain link to another site: the default browser too, so the app never navigates away
        webview.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    let mut uri = PWSTR::null();
                    args.Uri(&mut uri)?;
                    let uri = take_pwstr(uri);
                    if !is_internal(&uri) {
                        args.SetCancel(true)?;
                        open_external(&uri);
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
        // the player's full screen fills the monitor, not just the window
        webview.add_ContainsFullScreenElementChanged(
            &ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
                if let Some(sender) = sender {
                    let mut full = BOOL::default();
                    sender.ContainsFullScreenElement(&mut full)?;
                    set_full_screen(hwnd, full.as_bool());
                }
                Ok(())
            })),
            &mut token,
        )?;
        webview.add_DocumentTitleChanged(
            &DocumentTitleChangedEventHandler::create(Box::new(move |sender, _| {
                if let Some(sender) = sender {
                    let mut title = PWSTR::null();
                    sender.DocumentTitle(&mut title)?;
                    let title = take_pwstr(title);
                    let _ = SetWindowTextW(hwnd, &HSTRING::from(if title.is_empty() { "My Tube" } else { title.as_str() }));
                }
                Ok(())
            })),
            &mut token,
        )?;

        webview.Navigate(&HSTRING::from(url))?;
        controller.SetIsVisible(true)?;
        VIEW.with(|v| *v.borrow_mut() = Some(View { controller, webview, restore: None }));
        Ok(())
    }
}

fn set_full_screen(hwnd: HWND, on: bool) {
    // Resizing sends WM_SIZE, which needs VIEW, so nothing may hold it while the window changes.
    let saved = VIEW.with(|v| v.borrow_mut().as_mut().and_then(|view| view.restore.take()));
    let restore = unsafe {
        match (on, saved) {
            (true, None) => {
                let mut placement = WINDOWPLACEMENT { length: size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
                let mut monitor = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
                let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
                if GetWindowPlacement(hwnd, &mut placement).is_ok()
                    && GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut monitor).as_bool()
                {
                    SetWindowLongPtrW(hwnd, GWL_STYLE, style & !(WS_OVERLAPPEDWINDOW.0 as isize));
                    let m = monitor.rcMonitor;
                    let _ = SetWindowPos(hwnd, HWND_TOP, m.left, m.top, m.right - m.left, m.bottom - m.top,
                                         SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
                    Some((style, placement))
                } else {
                    None
                }
            }
            (false, Some((style, placement))) => {
                SetWindowLongPtrW(hwnd, GWL_STYLE, style);
                let _ = SetWindowPlacement(hwnd, &placement);
                let _ = SetWindowPos(hwnd, None, 0, 0, 0, 0,
                                     SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
                None
            }
            (_, unchanged) => unchanged,
        }
    };
    VIEW.with(|v| {
        if let Some(view) = v.borrow_mut().as_mut() {
            view.restore = restore;
        }
    });
}

fn with_view(f: impl FnOnce(&View)) {
    VIEW.with(|v| {
        if let Ok(v) = v.try_borrow() {
            if let Some(view) = v.as_ref() {
                f(view);
            }
        }
    });
}

unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        match msg {
            WM_SIZE => {
                let minimized = wparam.0 == SIZE_MINIMIZED as usize;
                with_view(|view| {
                    if let Ok(w19) = view.webview.cast::<ICoreWebView2_19>() {
                        let level = if minimized { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
                        let _ = w19.SetMemoryUsageTargetLevel(level);
                    }
                    if !minimized {
                        let mut rect = RECT::default();
                        if GetClientRect(hwnd, &mut rect).is_ok() {
                            let _ = view.controller.SetBounds(rect);
                        }
                    }
                });
                LRESULT(0)
            }
            WM_MOVE | WM_MOVING => {
                with_view(|view| {
                    let _ = view.controller.NotifyParentWindowPositionChanged();
                });
                DefWindowProcW(hwnd, msg, wparam, lparam)
            }
            WM_SETFOCUS => {
                with_view(|view| {
                    let _ = view.controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                });
                LRESULT(0)
            }
            WM_DPICHANGED => {
                let r = &*(lparam.0 as *const RECT);
                let _ = SetWindowPos(hwnd, None, r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_NOZORDER | SWP_NOACTIVATE);
                LRESULT(0)
            }
            WM_GETMINMAXINFO => {
                let info = &mut *(lparam.0 as *mut MINMAXINFO);
                let scale = GetDpiForSystem() as i32;
                info.ptMinTrackSize = POINT { x: 480 * scale / 96, y: 360 * scale / 96 };
                LRESULT(0)
            }
            WM_CLOSE => {
                let busy = jobs::active().len();
                if busy > 0 {
                    let text = HSTRING::from(format!("{busy} download(s) are still running.\n\nQuit anyway and cancel them?"));
                    if MessageBoxW(hwnd, &text, w!("My Tube"), MB_YESNO | MB_ICONQUESTION) != IDYES {
                        return LRESULT(0); // chose No: keep the window
                    }
                }
                let _ = DestroyWindow(hwnd);
                LRESULT(0)
            }
            WM_DESTROY => {
                if let Some(view) = VIEW.with(|v| v.borrow_mut().take()) {
                    let _ = view.controller.Close();
                }
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_internal;

    #[test]
    fn links() {
        let port = crate::config::CONFIG.port;
        assert!(is_internal(&format!("http://localhost:{port}/#/watch/abc")));
        assert!(is_internal(&format!("http://localhost:{port}")));
        assert!(is_internal("about:blank"));
        assert!(is_internal("blob:http://localhost/x"));
        assert!(!is_internal("https://www.youtube.com/watch?v=abc"));
        assert!(!is_internal(&format!("http://localhost:{port}0/")), "another port is another site");
        assert!(!is_internal(&format!("http://localhost:{port}.evil.com/")));
    }
}

/// The Edge app-mode window of earlier versions kept a whole browser profile here; nothing uses it any more.
fn remove_old_profile() {
    let old = CONFIG.data_dir.join("window-profile");
    if old.is_dir() {
        std::thread::spawn(move || match fs::remove_dir_all(&old) {
            Ok(()) => log("removed the old Edge window profile"),
            Err(e) => log(&format!("could not remove the old Edge window profile: {e}")),
        });
    }
}
