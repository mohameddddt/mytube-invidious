"""My Tube desktop launcher. PyInstaller turns this into MyTube.exe (see build-exe.bat).

Click it and it
  1. starts the Invidious containers in WSL (unless they are already running),
  2. starts the local web server (bundled inside the exe),
  3. opens the interface in its own app window (Edge in app mode: no tabs, no address bar).
Closing that window stops everything it started and gives all of WSL's memory back.
Run it from source with:  python launcher.py
"""
import ctypes
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime

import server

APP = "My Tube"
URL = f"http://localhost:{server.PORT}"
DATA = server.DATA_DIR
stopping = threading.Event()  # set once we are shutting down on purpose
PROFILE = DATA / "window-profile"  # the app window keeps its own settings (subscriptions, history) here
LOG = DATA / "mytube.log"
DISTRO = str(server.CONFIG.get("distro") or "Ubuntu-24.04")
NO_WINDOW = subprocess.CREATE_NO_WINDOW
user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32


# --------------------------------------------------------------------------- small helpers
def log(text):
    try:
        DATA.mkdir(parents=True, exist_ok=True)
        if LOG.exists() and LOG.stat().st_size > 512_000:
            LOG.write_text("", encoding="utf-8")
        with LOG.open("a", encoding="utf-8") as f:
            f.write(f"{datetime.now():%Y-%m-%d %H:%M:%S}  {text}\n")
    except OSError:
        pass


def message(text, style=0x40):
    """Native message box. style: 0x10 error, 0x20 question, 0x40 info, plus 0x4 for Yes/No."""
    return user32.MessageBoxW(0, text, APP, style | 0x10000)  # 0x10000 = bring to front


def run_quiet(cmd, timeout):
    try:
        return subprocess.run(cmd, capture_output=True, timeout=timeout, creationflags=NO_WINDOW)
    except (subprocess.TimeoutExpired, OSError) as exc:
        log(f"command failed {cmd[:3]}: {exc}")
        return None


def url_ok(path, timeout=2):
    try:
        with urllib.request.urlopen(URL + path, timeout=timeout) as r:
            return r.status == 200
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
        return False


def port_open(port, timeout=0.3):
    """Fast 'is anything listening' check. Much cheaper than an HTTP request through WSL's relay."""
    try:
        socket.create_connection(("127.0.0.1", port), timeout).close()
        return True
    except OSError:
        return False


def find_browser():
    pf, pf86 = os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    candidates = [shutil.which("msedge"),
                  rf"{pf86}\Microsoft\Edge\Application\msedge.exe", rf"{pf}\Microsoft\Edge\Application\msedge.exe",
                  rf"{pf}\Google\Chrome\Application\chrome.exe", rf"{pf86}\Google\Chrome\Application\chrome.exe"]
    return next((c for c in candidates if c and os.path.isfile(c)), None)


def open_window(browser):
    """App-mode window with a private profile, so the process lives exactly as long as the window."""
    PROFILE.mkdir(parents=True, exist_ok=True)
    return subprocess.Popen([browser, f"--app={URL}", f"--user-data-dir={PROFILE}", "--no-first-run",
                             "--no-default-browser-check", "--disable-background-mode", "--disable-extensions",
                             "--disable-sync", "--disable-component-update", "--window-size=1360,860"])


def profile_in_use(browser):
    """True while a main browser process (not a helper) is running with our window profile."""
    name = os.path.basename(browser)
    script = (f"@(Get-CimInstance Win32_Process -Filter \"Name='{name}'\" | Where-Object "
              f"{{ $_.CommandLine -like '*window-profile*' -and $_.CommandLine -notlike '*--type=*' }}).Count")
    res = run_quiet(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], 20)
    return bool(res and res.stdout.strip().isdigit() and int(res.stdout.strip()) > 0)


def wait_for_window(browser):
    """Open the window and block until the user closes it.

    If the browser exits at once it handed the window to a process that already owned the profile
    (for example one still shutting down from the previous run), so keep waiting for that one.
    """
    started = time.time()
    open_window(browser).wait()
    if time.time() - started < 10:
        log("window process exited quickly, waiting for the profile's browser to finish")
        time.sleep(3)
        while profile_in_use(browser):
            time.sleep(2)


# --------------------------------------------------------------------------- the stack in WSL
def start_stack():
    boot = "until docker info >/dev/null 2>&1; do sleep 0.2; done; cd ~/invidious && docker compose up -d && exec sleep infinity"
    cmd = ["wsl", "-d", DISTRO, "--", "bash", "-lc", boot]
    return subprocess.Popen(cmd, creationflags=NO_WINDOW, stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def watch_stack(keepalive):
    """The keepalive session never ends by itself. If it does, WSL or Docker could not be started."""
    code = keepalive.wait()
    if stopping.is_set():
        return
    log(f"stack process ended early with code {code}")
    message(f'The Invidious containers could not be started (exit code {code}).\n\n'
            f'Check that the WSL distribution "{DISTRO}" exists, that Docker is installed in it and that '
            f'~/invidious has been set up (see the launch guide).\n\nYou can set "distro" in {DATA / "config.json"}.', 0x10)


def stop_stack(keepalive):
    log("stopping containers and WSL")
    if keepalive and keepalive.poll() is None:
        server.kill_tree(keepalive.pid)
    run_quiet(["wsl", "-d", DISTRO, "--", "bash", "-lc", "cd ~/invidious && docker compose stop"], 120)
    run_quiet(["wsl", "--shutdown"], 60)


# --------------------------------------------------------------------------- main
def main():
    if sys.stdout is None:  # windowed exe has no console; keep stray prints out of the way
        sys.stdout = sys.stderr = open(os.devnull, "w")
    log("---- launch")

    mutex = kernel32.CreateMutexW(None, False, "Local\\MyTubeLauncher")  # noqa: F841 - held for the process lifetime
    second_copy = kernel32.GetLastError() == 183  # ERROR_ALREADY_EXISTS

    # Socket checks only: an HTTP request to a closed localhost port costs about 2 s on Windows.
    already_serving = port_open(server.PORT)

    # Start WSL before anything else: booting its VM takes the longest (about 8 s) and now overlaps with the rest.
    keepalive = None
    if not second_copy and not already_serving and not port_open(3000):  # we only stop what we started
        keepalive = start_stack()
        threading.Thread(target=watch_stack, args=(keepalive,), daemon=True).start()
        log("starting containers")

    browser = find_browser()

    # Already running (second click, or start-yt.bat is in use): just show another window onto it.
    if second_copy or already_serving:
        log("attaching to a running instance")
        if not already_serving:
            return message("My Tube is already starting or shutting down.\n\nTry again in a few seconds.")
        if not url_ok("/config.json"):  # something listens on our port, but it is not My Tube
            return message(f"Port {server.PORT} is in use by another program, so My Tube cannot start.\n\n"
                           f"Close that program, or set the YT_PORT environment variable.", 0x10)
        if browser:
            open_window(browser)
        else:
            os.startfile(URL)
        return

    try:
        httpd = server.create_server()
    except OSError as exc:
        log(f"cannot bind port: {exc}")
        stopping.set()
        if keepalive is not None:
            stop_stack(keepalive)
        return message(f"Port {server.PORT} is in use by another program, so My Tube cannot start.\n\n"
                       f"Close that program, or set the YT_PORT environment variable.", 0x10)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    log(f"server up on {URL}")

    try:
        while True:
            if browser:
                log(f"opening window ({os.path.basename(browser)})")
                wait_for_window(browser)
                log("window closed")
            else:  # no Edge/Chrome: use the default browser and wait for the user to say stop
                os.startfile(URL)
                message("My Tube is running in your browser.\n\nClick OK when you want to stop it.")
            busy = server.active_jobs()
            if busy and message(f"{len(busy)} download(s) are still running.\n\nQuit anyway and cancel them?", 0x20 | 0x4) != 6:
                continue  # chose No: bring the window back
            break
    finally:
        stopping.set()
        for job in server.active_jobs():
            server.cancel_job(job["id"])
        httpd.shutdown()
        httpd.server_close()
        if keepalive is not None:
            stop_stack(keepalive)
        log("bye")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - last resort: tell the user instead of vanishing
        log(f"fatal: {exc!r}")
        message(f"My Tube hit a problem and has to close.\n\n{exc}\n\nDetails: {LOG}", 0x10)
