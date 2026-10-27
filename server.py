"""UI backend for the personal YouTube interface (guide section 10.2).

Standard library only. Binds to 127.0.0.1:8080 unless YT_BIND / YT_PORT say otherwise.

Routes
  GET  /                 static UI from ./web
  GET  /config.json      addresses the UI needs (Invidious base, download folders)
  GET  /status           whether Invidious answers yet (the UI shows a start-up screen until it does)
  GET  /api/*            forwarded to Invidious /api/v1/*
  POST /download         {id | playlist, profile, title?, limit?} -> 202, runs yt-dlp
  POST /cancel           {job} stops a queued or running download
  POST /open-folder      {kind: "video"|"audio"} opens that download folder in Explorer (local PC only)
  GET  /jobs             status of download jobs
  GET  /downloads        files in the download folders
  GET  /files/<name>     a downloaded file (Range supported, no path traversal)
"""
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

FROZEN = getattr(sys, "frozen", False)  # True inside the PyInstaller exe
ROOT = Path(sys._MEIPASS) if FROZEN else Path(__file__).resolve().parent  # where web/ lives
HOME = Path(os.environ.get("USERPROFILE", str(Path.home())))
# Things that must survive restarts (archives, config, window profile): next to the source when
# developing, in %LOCALAPPDATA%\MyTube when running as the exe (the exe's own folder is temporary).
DATA_DIR = Path(os.environ.get("LOCALAPPDATA", str(HOME / "AppData" / "Local"))) / "MyTube" if FROZEN else ROOT
WEB = ROOT / "web"
VIDEO_DIR = HOME / "Videos" / "yt"
AUDIO_DIR = HOME / "Music" / "yt"


def load_config():
    """Optional config.json in DATA_DIR: {"ytdlp": "C:\\path\\yt-dlp.exe", "distro": "Ubuntu-24.04"}."""
    try:
        data = json.loads((DATA_DIR / "config.json").read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


CONFIG = load_config()


def archive_for(profile):
    """yt-dlp archive file per kind, so an audio run never makes a later video run skip everything."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return DATA_DIR / ("archive-audio.txt" if PROFILES[profile]["dir"] == AUDIO_DIR else "archive-video.txt")


BIND = os.environ.get("YT_BIND", "127.0.0.1")
PORT = int(os.environ.get("YT_PORT", "8080"))
INVIDIOUS = os.environ.get("INVIDIOUS_URL", "http://127.0.0.1:3000")
# What the *browser* uses for thumbnails/streams. Change here when hosting moves (section 13.4).
INVIDIOUS_PUBLIC = os.environ.get("INVIDIOUS_PUBLIC_URL", "http://localhost:3000")
MAX_JOBS = 2

ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
PLAYLIST_RE = re.compile(r"^[A-Za-z0-9_-]{10,64}$")
MEDIA_EXT = {".mp4", ".mkv", ".webm", ".mp3", ".m4a", ".opus"}
AUDIO_EXT = {".mp3", ".m4a", ".opus"}

# Fixed download profiles (guide 9.2). UI choices map to these and nothing else.
COMMON = ["-o", "%(title)s [%(id)s].%(ext)s", "--no-mtime", "--newline", "--no-colors"]
PROFILES = {
    "data_saver": {"dir": VIDEO_DIR, "args": ["-S", "res:480", "--merge-output-format", "mp4"]},
    "standard": {"dir": VIDEO_DIR, "args": ["-S", "res:720", "--merge-output-format", "mp4"]},
    "high": {"dir": VIDEO_DIR, "args": ["-S", "res:1080", "--merge-output-format", "mp4"]},
    "audio": {"dir": AUDIO_DIR, "args": ["-x", "--audio-format", "mp3"]},
}

jobs = {}
procs = {}  # job id -> running yt-dlp process (kept apart from `jobs`, which is sent to the UI as JSON)
jobs_lock = threading.Lock()
ITEM_RE = re.compile(r"Downloading item (\d+) of (\d+)")
MAX_LIMIT = 500
executor = ThreadPoolExecutor(max_workers=MAX_JOBS)


# ---------------------------------------------------------------- downloads
def tool_env():
    """Make sure yt-dlp can find deno and ffmpeg even if PATH is stale."""
    env = os.environ.copy()
    extra = [
        HOME / "AppData" / "Local" / "Microsoft" / "WinGet" / "Links",
        HOME / ".deno" / "bin",
    ]
    env["PATH"] = os.pathsep.join([str(p) for p in extra if p.exists()] + [env.get("PATH", "")])
    return env


def find_ytdlp(env):
    """PATH first, then the places yt-dlp usually lands, so a double-clicked exe works with a bare PATH."""
    configured = CONFIG.get("ytdlp")
    if isinstance(configured, str) and Path(configured).is_file():
        return configured
    found = shutil.which("yt-dlp", path=env["PATH"])
    if found:
        return found
    local = HOME / "AppData" / "Local"
    roaming = HOME / "AppData" / "Roaming"
    candidates = [local / "Microsoft" / "WinGet" / "Links" / "yt-dlp.exe"]
    for base in (HOME / "miniconda3", HOME / "anaconda3", HOME / "AppData" / "Local" / "miniconda3"):
        candidates.append(base / "Scripts" / "yt-dlp.exe")
    for pattern_root in (roaming / "Python", local / "Programs" / "Python"):
        if pattern_root.is_dir():
            candidates += sorted(pattern_root.glob("Python*/Scripts/yt-dlp.exe"), reverse=True)
    return next((str(c) for c in candidates if c.is_file()), None)


YTDLP_MISSING = ('yt-dlp was not found. Install it with "winget install yt-dlp.yt-dlp" (or '
                 '"python -m pip install -U yt-dlp[default]"), or set "ytdlp" in ' + str(DATA_DIR / "config.json"))


def active_jobs():
    with jobs_lock:
        return [j for j in jobs.values() if j["status"] in ("queued", "running")]


def invidious_up():
    """Does Invidious answer HTTP at all? Its home page is rendered locally, so unlike a search this
    does not wait for a round trip to YouTube. Any HTTP reply counts, even an error page."""
    try:
        with urllib.request.urlopen(f"{INVIDIOUS}/", timeout=3):
            return True
    except urllib.error.HTTPError:
        return True
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
        return False


def clean_title(value):
    """Display-only text for the jobs list. It never reaches a command line."""
    if not isinstance(value, str):
        return ""
    return re.sub(r"[\x00-\x1f\x7f]", "", value).strip()[:120]


def kill_tree(pid):
    if sys.platform == "win32":  # also stops the ffmpeg child
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True,
                       creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        os.kill(pid, 15)


def finish(job, **changes):
    """Apply a final state unless the user cancelled in the meantime."""
    with jobs_lock:
        if job["status"] != "cancelled":
            job.update(changes)
        job["finished"] = time.time()


def run_job(job_id):
    job = jobs[job_id]
    if job["status"] == "cancelled":  # cancelled while it was still queued
        return
    env = tool_env()
    exe = find_ytdlp(env)
    if not exe:
        return finish(job, status="error", error=YTDLP_MISSING)
    profile = PROFILES[job["profile"]]
    profile["dir"].mkdir(parents=True, exist_ok=True)
    cmd = [exe, *profile["args"], *COMMON, "-P", str(profile["dir"]),
           "--progress-template", "download:PCT %(progress._percent_str)s"]
    playlist = job["kind"] == "playlist"
    if playlist:
        # --ignore-errors: one private or deleted video must not stop the rest
        cmd += ["--download-archive", str(archive_for(job["profile"])), "--yes-playlist", "--ignore-errors"]
        if job["limit"]:
            cmd += ["--playlist-end", str(job["limit"])]
        url = "https://www.youtube.com/playlist?list=" + job["target"]
    else:
        cmd += ["--no-playlist"]
        url = "https://www.youtube.com/watch?v=" + job["target"]
    cmd += ["--", url]
    job.update(status="running", started=time.time())
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                encoding="utf-8", errors="replace", env=env, creationflags=flags)
        procs[job_id] = proc
        if job["status"] == "cancelled":  # cancel arrived while the process was starting
            kill_tree(proc.pid)
        tail = []
        for line in proc.stdout:
            line = line.strip()
            if line.startswith("PCT "):
                m = re.search(r"([\d.]+)%", line)
                if m:
                    job["percent"] = float(m.group(1))
            else:
                m = ITEM_RE.search(line)
                if m:
                    job["index"], job["total"], job["percent"] = int(m.group(1)), int(m.group(2)), 0.0
                elif "already been recorded in the archive" in line:
                    job["skipped"] += 1
                elif line.startswith("ERROR:"):
                    job["failed"] += 1
                    tail.append(line)
                elif line:
                    tail.append(line)
                tail = tail[-6:]
            if playlist and job["total"]:
                job["overall"] = round(((job["index"] - 1) + job["percent"] / 100) / job["total"] * 100, 1)
        proc.wait()
        procs.pop(job_id, None)
        saved = max(0, job["index"] - job["failed"] - job["skipped"])
        if playlist:
            parts = [f"{saved} saved"]
            if job["skipped"]:
                parts.append(f"{job['skipped']} already downloaded")
            if job["failed"]:
                parts.append(f"{job['failed']} unavailable")
            job["message"] = ", ".join(parts)
        if proc.returncode == 0 or (playlist and (saved > 0 or job["skipped"] > 0)):
            finish(job, status="done", percent=100.0, overall=100.0)
        else:
            finish(job, status="error", error=" | ".join(tail[-3:])[:400] or f"yt-dlp exit {proc.returncode}")
    except Exception as exc:  # noqa: BLE001 - report any launch failure to the UI
        procs.pop(job_id, None)
        finish(job, status="error", error=str(exc)[:400])


def start_job(kind, target, profile, title="", limit=None):
    with jobs_lock:
        for j in jobs.values():  # don't queue the same thing twice
            if (j["target"] == target and j["profile"] == profile and j["limit"] == limit
                    and j["status"] in ("queued", "running")):
                return j["id"]
        job_id = f"{int(time.time() * 1000)}"
        jobs[job_id] = {"id": job_id, "kind": kind, "target": target, "profile": profile, "title": title,
                        "limit": limit, "status": "queued", "percent": 0.0, "overall": 0.0, "index": 0,
                        "total": 0, "skipped": 0, "failed": 0, "message": "", "error": None,
                        "created": time.time()}
        for old in sorted(jobs)[:-50]:  # keep the list short
            if jobs[old]["status"] in ("done", "error", "cancelled"):
                del jobs[old]
    executor.submit(run_job, job_id)
    return job_id


def cancel_job(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job or job["status"] not in ("queued", "running"):
            return False
        job["status"] = "cancelled"
        job["finished"] = time.time()
    proc = procs.get(job_id)
    if proc and proc.poll() is None:
        kill_tree(proc.pid)
    return True


def list_downloads():
    items = []
    for folder in (VIDEO_DIR, AUDIO_DIR):
        if not folder.is_dir():
            continue
        for p in folder.iterdir():
            if p.is_file() and p.suffix.lower() in MEDIA_EXT:
                st = p.stat()
                m = re.search(r"\[([A-Za-z0-9_-]{11})\]\.[^.]+$", p.name)
                items.append({"name": p.name, "size": st.st_size, "mtime": int(st.st_mtime),
                              "id": m.group(1) if m else None,
                              "kind": "audio" if p.suffix.lower() in AUDIO_EXT else "video"})
    items.sort(key=lambda i: i["mtime"], reverse=True)
    return items


def open_folder(kind):
    """Open one of the two fixed download folders in the file manager."""
    folder = AUDIO_DIR if kind == "audio" else VIDEO_DIR
    folder.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        os.startfile(str(folder))  # noqa: S606 - fixed path chosen by us, never user input
    else:
        subprocess.Popen(["xdg-open", str(folder)])


def resolve_download(name):
    """Return the real path of a downloaded file, or None. Rejects anything that is not a bare file name."""
    if not name or name != Path(name).name or name in (".", "..") or "\x00" in name:
        return None
    for folder in (VIDEO_DIR, AUDIO_DIR):
        try:
            base = folder.resolve()
            cand = (base / name).resolve()
        except OSError:
            continue
        if cand.parent == base and cand.is_file() and cand.suffix.lower() in MEDIA_EXT:
            return cand
    return None


# ------------------------------------------------------------------ handler
class Handler(BaseHTTPRequestHandler):
    server_version = "YTLocal/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet; the console is a hidden window anyway
        pass

    # --- helpers
    def host_ok(self):
        """Defence against DNS rebinding / drive-by requests to a local service."""
        if BIND != "127.0.0.1":
            return True  # LAN mode (section 12) deliberately accepts other host names
        host = (self.headers.get("Host") or "").lower()
        return host in (f"localhost:{PORT}", f"127.0.0.1:{PORT}", "localhost", "127.0.0.1")

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, message):
        self.send_json({"error": message}, status)

    # --- routing
    def do_GET(self):
        if not self.host_ok():
            return self.send_error_json(403, "bad host")
        path = urlsplit(self.path).path
        if path == "/config.json":
            return self.send_json({"invidious": INVIDIOUS_PUBLIC, "maxJobs": MAX_JOBS,
                                   "videoDir": str(VIDEO_DIR), "audioDir": str(AUDIO_DIR)})
        if path == "/status":
            return self.send_json({"invidious": invidious_up(), "ytdlp": bool(find_ytdlp(tool_env()))})
        if path.startswith("/api/"):
            return self.proxy_api()
        if path == "/jobs":
            with jobs_lock:
                return self.send_json(sorted(jobs.values(), key=lambda j: j["created"], reverse=True))
        if path == "/downloads":
            return self.send_json(list_downloads())
        if path.startswith("/files/"):
            return self.serve_download(unquote(path[len("/files/"):]))
        return self.serve_static(path)

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        if not self.host_ok():
            return self.send_error_json(403, "bad host")
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc.lower() != (self.headers.get("Host") or "").lower():
            return self.send_error_json(403, "cross-origin request refused")
        path = urlsplit(self.path).path
        if path not in ("/download", "/open-folder", "/cancel"):
            return self.send_error_json(404, "not found")
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self.send_error_json(415, "expected application/json")
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 4096:
                raise ValueError
            data = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self.send_error_json(400, "bad request body")
        if path == "/cancel":
            job_id = data.get("job") if isinstance(data, dict) else None
            if not (isinstance(job_id, str) and re.fullmatch(r"\d{10,16}", job_id)):
                return self.send_error_json(400, "invalid job")
            if not cancel_job(job_id):
                return self.send_error_json(404, "no such running job")
            return self.send_json({"cancelled": True})
        if path == "/open-folder":
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                return self.send_error_json(403, "only available on the PC itself")
            kind = data.get("kind") if isinstance(data, dict) else None
            if kind not in ("video", "audio"):
                return self.send_error_json(400, "unknown folder")
            open_folder(kind)
            return self.send_json({"opened": True})
        profile = data.get("profile") if isinstance(data, dict) else None
        if profile not in PROFILES:
            return self.send_error_json(400, "unknown profile")
        vid, pl = data.get("id"), data.get("playlist")
        title = clean_title(data.get("title"))
        if isinstance(vid, str) and ID_RE.match(vid):
            job_id = start_job("video", vid, profile, title)
        elif isinstance(pl, str) and PLAYLIST_RE.match(pl):
            if pl.startswith("RD"):
                return self.send_error_json(400, "YouTube Mix playlists are endless and cannot be downloaded. Open a normal playlist instead.")
            limit = data.get("limit")
            if limit is not None and not (isinstance(limit, int) and not isinstance(limit, bool) and 1 <= limit <= MAX_LIMIT):
                return self.send_error_json(400, f"limit must be a whole number from 1 to {MAX_LIMIT}")
            job_id = start_job("playlist", pl, profile, title, limit)
        else:
            return self.send_error_json(400, "invalid video or playlist id")
        self.send_json({"accepted": True, "job": job_id}, 202)

    # --- Invidious proxy
    def proxy_api(self):
        parts = urlsplit(self.path)
        upstream = f"{INVIDIOUS}/api/v1/{parts.path[len('/api/'):]}"
        if parts.query:
            upstream += "?" + parts.query
        try:
            with urllib.request.urlopen(urllib.request.Request(upstream), timeout=45) as r:
                status, body = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, body = e.code, e.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            return self.send_error_json(502, f"Invidious unreachable: {getattr(e, 'reason', e)}")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # --- files
    def serve_static(self, path):
        rel = "index.html" if path in ("", "/") else unquote(path).lstrip("/")
        base = WEB.resolve()
        try:
            target = (base / rel).resolve()
        except OSError:
            return self.send_error_json(404, "not found")
        if base not in target.parents or not target.is_file():
            return self.send_error_json(404, "not found")
        self.send_file(target, cache="no-cache")

    def serve_download(self, name):
        target = resolve_download(name)
        if not target:
            return self.send_error_json(404, "not found")
        self.send_file(target, cache="no-cache")

    def send_file(self, path, cache):
        size = path.stat().st_size
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
            if not m or (not m.group(1) and not m.group(2)):
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            else:  # suffix range: last N bytes
                start = max(size - int(m.group(2)), 0)
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", cache)
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        try:
            with open(path, "rb") as f:
                f.seek(start)
                left = length
                while left > 0:
                    chunk = f.read(min(256 * 1024, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # the player closed the connection (seek / navigation)


def create_server():
    """Bind the HTTP server (raises OSError if the port is taken). Used by main() and by launcher.py."""
    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer((BIND, PORT), Handler)
    httpd.daemon_threads = True
    return httpd


def main():
    httpd = create_server()
    print(f"UI backend on http://{BIND}:{PORT}  ->  Invidious {INVIDIOUS}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
