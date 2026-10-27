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


def distro_exists():
    res = run_quiet(["wsl", "-l", "-q"], 20)
    if not res or res.returncode != 0:
        return False
    names = res.stdout.decode("utf-16-le", errors="ignore").replace("\x00", "").split()
    return DISTRO in names


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
                             "--no-default-browser-check", "--disable-background-mode", "--window-size=1360,860"])


# --------------------------------------------------------------------------- the stack in WSL
def start_stack():
    cmd = ["wsl", "-d", DISTRO, "--", "bash", "-lc", "cd ~/invidious && docker compose up -d && exec sleep infinity"]
    return subprocess.Popen(cmd, creationflags=NO_WINDOW, stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


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
    browser = find_browser()

    # Already running (second click, or start-yt.bat is in use): just show another window onto it.
    if second_copy or url_ok("/config.json"):
        log("attaching to a running instance")
        if not url_ok("/config.json"):
            return message("My Tube is already starting or shutting down.\n\nTry again in a few seconds.")
        if browser:
            open_window(browser)
        else:
            os.startfile(URL)
        return

    if not distro_exists():
        return message(f'The WSL distribution "{DISTRO}" was not found.\n\nInstall it as described in the launch guide, '
                       f'or set "distro" in {DATA / "config.json"}.', 0x10)

    try:
        httpd = server.create_server()
    except OSError as exc:
        log(f"cannot bind port: {exc}")
        return message(f"Port {server.PORT} is in use by another program, so My Tube cannot start.\n\n"
                       f"Close that program, or set the YT_PORT environment variable.", 0x10)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    log(f"server up on {URL}")

    keepalive = None
    if not server.invidious_up():  # we only stop what we started
        keepalive = start_stack()
        log("starting containers")

    try:
        while True:
            if browser:
                proc = open_window(browser)
                log(f"window opened ({os.path.basename(browser)})")
                proc.wait()
                log("window closed")
            else:  # no Edge/Chrome: use the default browser and wait for the user to say stop
                os.startfile(URL)
                message("My Tube is running in your browser.\n\nClick OK when you want to stop it.")
            busy = server.active_jobs()
            if busy and message(f"{len(busy)} download(s) are still running.\n\nQuit anyway and cancel them?", 0x20 | 0x4) != 6:
                continue  # chose No: bring the window back
            break
    finally:
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
