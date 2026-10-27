# My Tube

A personal, self-hosted YouTube interface for Windows. It runs [Invidious](https://github.com/iv-org/invidious) and its companion service in Docker inside WSL2, with a small hand-written web app on top: search, watch, subscribe without an account, and download videos or audio to your PC.

Everything runs on your own machine, costs nothing, and shuts down completely when you are done, so it uses 0 MB of RAM while stopped.

![status](https://img.shields.io/badge/platform-Windows%2011%20%2B%20WSL2-informational) ![deps](https://img.shields.io/badge/runtime%20deps-none%20(stdlib%20only)-success)

## Features

- **Search and watch** with suggestions, filters (type, sort, date, length) and an adaptive player that falls back from your downloaded file, to DASH (480p to 1080p), to a 360p stream, to the embedded player.
- **Subscriptions without an account.** The feed is built on demand from your channels and cached for 20 minutes. History, watch later and settings live in your browser, with JSON export and import as backup.
- **Downloads that land on your PC.** Choose Video (480p, 720p, 1080p) or Audio only (MP3), see exactly where it will be saved, and find the file again in the app's **Saved** page. Play it offline, save another copy, or open its folder in Explorer.
- **Whole playlists.** Download a playlist from its page, from a search result, or from the video you are watching. Pick all of it or just the first 10, 25, 50 or 100 videos, follow per-video progress, and cancel at any time. Videos you already have are skipped and unavailable ones are passed over.
- **Light by design.** No frameworks, no build step, no web fonts. The backend is one Python file using only the standard library. Containers have memory caps, and Invidious's background crawlers are turned off.
- **Private.** Every service listens on `127.0.0.1` only. Avatars and thumbnails go through Invidious, so your browser never talks to Google directly.

## How it fits together

```
Browser ── http://localhost:8080 ──> server.py ──> Invidious ──> companion ──> YouTube
                 (this repo)            │           (WSL, Docker)   (stream tokens)
                                        └──> yt-dlp + ffmpeg + Deno ──> Videos\yt, Music\yt
```

Watching and downloading both use your home IP address, so hosting adds no extra internet traffic.

## Requirements

- Windows 11 with virtualization enabled, 8 GB RAM recommended (4 GB minimum)
- WSL2 with Ubuntu 24.04, and Docker Engine inside it
- Python 3.9+, [yt-dlp](https://github.com/yt-dlp/yt-dlp), [ffmpeg](https://ffmpeg.org) and [Deno](https://deno.com) on Windows

## Quick start

**Already installed?** Double-click **`dist\MyTube.exe`** (build it once with `build-exe.bat`). It starts everything and opens My Tube in its own window; closing the window stops everything. Prefer a browser tab? Double-click `start-yt.bat` instead, and `stop-yt.bat` when you finish.

**First time on this PC?** Follow the [setup checklist in the launch guide](docs/LAUNCH-GUIDE.md#first-time-setup-on-a-new-pc). In short:

```powershell
winget install Python.Python.3.12 Gyan.FFmpeg DenoLand.Deno
python -m pip install -U "yt-dlp[default]"
git clone https://github.com/mohameddddt/mytube-invidious.git
cd mytube-invidious
wsl -d Ubuntu-24.04 -- bash deploy/setup-invidious.sh   # Invidious + companion + Postgres, keys generated for you
.\start-yt.bat
```

## The desktop app

`MyTube.exe` is one file of about 7 MB that contains the launcher, the local server and the whole interface. Click it and it:

1. starts the Invidious containers in WSL (unless they are already running),
2. starts the local server,
3. opens My Tube in its own window (Edge in app mode: no tabs, no address bar).

Closing the window stops everything it started and returns all of WSL's memory. If a download is still running it asks first.

Build it with `build-exe.bat`, which installs PyInstaller on first use and writes `dist\MyTube.exe`. The exe still needs WSL, Docker, Invidious and yt-dlp on the PC, so it is for your own machine, not a standalone installer. It is unsigned, so Windows SmartScreen or an antivirus may warn about it; building it yourself is the safe way.

The app window keeps its own subscriptions, history and settings. To bring them over from a browser, use **Settings → Export JSON** there and **Import JSON** in the app.

## Documentation

| Document | What is in it |
|---|---|
| [docs/LAUNCH-GUIDE.md](docs/LAUNCH-GUIDE.md) | Starting and stopping, starting by hand, health checks, weekly care, troubleshooting, new-PC setup |
| [docs/BUILD-GUIDE.md](docs/BUILD-GUIDE.md) | The full design: why it is built this way, architecture, every install phase, resource budget, security notes |

## Repository layout

```
launcher.py               desktop launcher, packaged as MyTube.exe (starts the stack, the server and the app window)
server.py                 local backend: serves the UI, proxies Invidious, runs yt-dlp jobs
web/                      the interface (index.html, style.css, app.js), no build step
build-exe.bat             build dist\MyTube.exe (PyInstaller)
start-yt.bat              start everything on demand, in a browser tab
stop-yt.bat               stop everything and free all WSL memory
update-yt.bat             update Invidious, companion, yt-dlp, Deno and ffmpeg
deploy/                   compose template and the script that installs Invidious in WSL
tools/, assets/           build helpers and the app icon
docs/                     build guide and launch guide
```

## Backend routes

| Route | Purpose |
|---|---|
| `GET /` | the UI |
| `GET /api/*` | forwarded to Invidious `/api/v1/*` |
| `POST /download` | `{id, profile}` or `{playlist, profile, limit?}` (plus an optional display `title`), starts a yt-dlp job, returns 202 |
| `GET /jobs` | progress of download jobs, including per-video progress for playlists |
| `POST /cancel` | `{job}` stops a queued or running download |
| `GET /downloads` | files in your download folders |
| `GET /files/<name>` | a downloaded file, with Range support for seeking |
| `POST /open-folder` | opens a download folder in Explorer (the PC itself only) |

Download profiles are fixed (`data_saver`, `standard`, `high`, `audio`), video IDs are validated, and no user text reaches the command line. Requests with an unexpected `Host` header or a foreign `Origin` are refused.

## Keeping it working

YouTube changes constantly. Run `update-yt.bat` weekly, and straight away if playback or downloads break. Back up your subscriptions with **Settings → Export JSON**.

## Legal

Downloading from YouTube is against its Terms of Service except where YouTube allows it. Use this for personal purposes and respect creators' copyright. This project is not affiliated with YouTube, Google or the Invidious project.
