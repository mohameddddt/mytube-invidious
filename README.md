# My Tube

A personal, self-hosted YouTube interface for Windows. It runs [Invidious](https://github.com/iv-org/invidious) and its companion service in Docker inside WSL2, with a small hand-written web app on top: search, watch, subscribe without an account, and download videos or audio to your PC.

Everything runs on your own machine, costs nothing, and shuts down completely when you are done, so it uses 0 MB of RAM while stopped.

![status](https://img.shields.io/badge/platform-Windows%2011%20%2B%20WSL2-informational) ![deps](https://img.shields.io/badge/runtime%20deps-none%20(stdlib%20only)-success)

## Features

- **Search and watch** with suggestions, filters (type, sort, date, length) and an adaptive player that falls back from your downloaded file, to DASH (480p to 1080p), to a 360p stream, to the embedded player.
- **Subscriptions without an account.** The feed is built on demand from your channels and cached for 20 minutes. History, watch later and settings live in your browser, with JSON export and import as backup.
- **Suggestions from what you watch.** The feed mixes in videos related to the ones you liked, finished or saved for later, favouring channels you watch often. It is a small, local, explainable algorithm: each suggestion says which video it came from, and nothing leaves your PC.
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

## Prerequisites: install these first

My Tube is a launcher and interface; the heavy lifting is done by tools that must be on the PC. Everything is free. Do the steps **in this order**, once. After any `winget` install, open a **new** terminal so the new commands are found.

| # | What | What it is for | Download / docs |
|---|---|---|---|
| 1 | Windows 11 (x64) with virtualization on, 8 GB RAM recommended | runs WSL2 | check in *Task Manager → Performance → CPU → Virtualization: Enabled* |
| 2 | WSL2 + Ubuntu 24.04 | the Linux VM that hosts Invidious | [learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install) |
| 3 | Docker Engine (inside Ubuntu, not Docker Desktop) | runs Invidious, its companion and its database | [docs.docker.com/engine/install/ubuntu](https://docs.docker.com/engine/install/ubuntu/) |
| 4 | Invidious + companion + Postgres | search, metadata and streams | [docs.invidious.io/installation](https://docs.invidious.io/installation/) · [Invidious](https://github.com/iv-org/invidious) · [companion](https://github.com/iv-org/invidious-companion) |
| 5 | yt-dlp | downloads | [github.com/yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp/wiki/Installation) |
| 6 | ffmpeg | merges video and audio, makes MP3s | [gyan.dev/ffmpeg/builds](https://www.gyan.dev/ffmpeg/builds/) |
| 7 | Deno | lets yt-dlp solve YouTube's JavaScript checks | [docs.deno.com/runtime/getting_started/installation](https://docs.deno.com/runtime/getting_started/installation/) |
| 8 | Python 3.12+ | installs yt-dlp, runs the browser-tab mode and builds from source | [python.org/downloads/windows](https://www.python.org/downloads/windows/) |
| 9 | Microsoft Edge (or Chrome) | the app window; Edge is already part of Windows 11 | built in |

### 1 and 2. WSL2 with Ubuntu

Open **PowerShell as Administrator**, install, then **reboot**:

```powershell
wsl --install -d Ubuntu-24.04
```

Start *Ubuntu 24.04* from the Start Menu once and create your Linux user name and password. Check it is on version 2:

```powershell
wsl -l -v
```

Recommended: cap the VM's memory so it never grows beyond what Invidious needs. Create `%USERPROFILE%\.wslconfig` with this content, then run `wsl --shutdown`. (It applies to every WSL distro on the PC; raise `memory` if you do heavy work in Linux.)

```ini
[wsl2]
memory=1536MB
processors=2
swap=1GB

[experimental]
autoMemoryReclaim=gradual
```

### 3. Docker Engine inside Ubuntu

Open the Ubuntu terminal and run:

```bash
sudo apt update && sudo apt install -y ca-certificates curl git openssl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Then, in PowerShell, restart WSL so the group change applies, and test Docker:

```powershell
wsl --shutdown
wsl -d Ubuntu-24.04 -- docker run --rm hello-world
```

Docker must start by itself with WSL, which needs systemd. Ubuntu 24.04 on current WSL has it on; if `docker` does not start, check that `/etc/wsl.conf` contains `[boot]` and `systemd=true` (full details: [build guide, section 6.3](docs/BUILD-GUIDE.md)).

### 4. Invidious, companion and Postgres

The repository ships a script that downloads Invidious, generates the secret keys, writes a locked-down `compose.yaml` and starts everything. Run it from a folder that contains `deploy\`: your clone of this repository, or the install folder.

```powershell
# from a clone of this repository
cd mytube-invidious
wsl -d Ubuntu-24.04 -- bash deploy/setup-invidious.sh

# or, if you installed the app with the installer
cd "$env:LOCALAPPDATA\Programs\My Tube"
wsl -d Ubuntu-24.04 -- bash deploy/setup-invidious.sh
```

It installs into `~/invidious` inside Ubuntu and never overwrites existing keys, so it is safe to run again. Add `--no-start` to only prepare the files. Official reference: [docs.invidious.io/installation](https://docs.invidious.io/installation/).

### 5 to 8. yt-dlp, ffmpeg, Deno and Python (Windows)

```powershell
winget install Python.Python.3.12
winget install Gyan.FFmpeg
winget install DenoLand.Deno
```

Open a new terminal, then install yt-dlp with its extras. The `[default]` part bundles the solver for YouTube's JavaScript challenges; without it some videos, Shorts especially, lose formats:

```powershell
python -m pip install -U "yt-dlp[default]"
```

Alternative without Python: `winget install yt-dlp.yt-dlp`. The app finds yt-dlp on your `PATH` and in the usual install folders, so either works. Keep it current, because YouTube changes often (`update-yt.bat` does this).

### Check that everything is in place

```powershell
wsl -l -v                                         # Ubuntu-24.04, VERSION 2
wsl -d Ubuntu-24.04 -- docker run --rm hello-world
wsl -d Ubuntu-24.04 -- ls ~/invidious/compose.yaml
yt-dlp --version
ffmpeg -version
deno --version
python --version
```

### Only if you build from source

```powershell
winget install Git.Git                            # to clone the repository
winget install JRSoftware.InnoSetup --scope user  # to build the installer (build-installer.bat)
```

Links: [git-scm.com/download/win](https://git-scm.com/download/win) · [Inno Setup releases](https://github.com/jrsoftware/issrc/releases). PyInstaller and Pillow, which the build needs, are installed automatically by the build scripts.

## Install

Download **`MyTube-Setup-<version>.exe`** from the [latest release](https://github.com/mohameddddt/mytube-invidious/releases/latest) and run it. It installs for your user account only (no administrator rights), adds a Start Menu entry and an optional desktop shortcut, and registers an uninstaller under *Settings → Apps*. Updating is just running a newer installer over the old one. Uninstalling asks whether to delete your data too; your downloaded videos and music are never touched.

The installer and the app are **signed**, with a free self-signed certificate (a commercial one costs money). That proves the files were not altered, but Windows cannot vouch for an unknown publisher, so SmartScreen may show "Windows protected your PC": choose *More info → Run anyway*. To check a download yourself:

- compare its SHA-256 with `SHA256SUMS.txt` on the release (`Get-FileHash MyTube-Setup-<version>.exe`), and
- look at *Properties → Digital Signatures*: the signer is `CN=My Tube, O=mohameddddt`, certificate thumbprint `308F38A21B22C31059FC072641361D423FF4A3AF`.

To make Windows show the signature as valid on your own PC, install `mytube-signing.cer` (attached to the release) into *Current User → Trusted Root Certification Authorities* yourself. Only do that if you trust this project, since it makes Windows trust anything signed with that key for your account.

The app is a launcher, so everything under [Prerequisites](#prerequisites-install-these-first) must be set up on the PC first.

## Quick start

Prerequisites done? Then:

- **Installed with the installer:** open **My Tube** from the Start Menu. It starts everything and opens in its own window; closing the window stops everything.
- **Prefer a browser tab?** Run `start-yt.bat` from a clone of this repository (and `stop-yt.bat` when you finish).
- **Running from source:**

```powershell
git clone https://github.com/mohameddddt/mytube-invidious.git
cd mytube-invidious
python launcher.py        # the same thing the app does, without building an exe
```

To produce the exe or the installer yourself, see [The desktop app](#the-desktop-app).

## The desktop app

`MyTube.exe` is one file of about 7 MB that contains the launcher, the local server and the whole interface. Click it and it:

1. starts the Invidious containers in WSL (unless they are already running),
2. starts the local server,
3. opens My Tube in its own window (Edge in app mode: no tabs, no address bar).

Closing the window stops everything it started and returns all of WSL's memory. If a download is still running it asks first.

Build just the exe with `build-exe.bat` (writes `dist\MyTube.exe`), or the signed installer with `build-installer.bat` (writes `dist\MyTube-Setup-<version>.exe`; it needs [Inno Setup](https://github.com/jrsoftware/issrc/releases), `winget install JRSoftware.InnoSetup --scope user`, and signs with the certificate from `tools\make_cert.ps1`). The exe still needs WSL, Docker, Invidious and yt-dlp on the PC, so it is for your own machine, not a standalone installer. It is unsigned, so Windows SmartScreen or an antivirus may warn about it; building it yourself is the safe way.

**The app and the browser always match.** Your subscriptions, history, watch-later list, settings and saved feed are stored in one file on the PC, `%LOCALAPPDATA%\MyTube\userdata.json`, behind the local server. The app window, a browser tab on `http://localhost:8080` and any other browser all read and write that same file, so a channel you subscribe to in one shows up in the others (a window refreshes when you switch back to it). The first time a browser or the app connects, whatever it already had is merged in, so nothing is lost.

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
build-installer.bat       build the signed installer dist\MyTube-Setup-<version>.exe
VERSION                   the version number used by the exe, the installer and the release
installer/                Inno Setup script for the installer
start-yt.bat              start everything on demand, in a browser tab
stop-yt.bat               stop everything and free all WSL memory
update-yt.bat             update Invidious, companion, yt-dlp, Deno and ffmpeg
deploy/                   compose template and the script that installs Invidious in WSL
tools/, assets/           build helpers (icon, version info, certificate, signing) and the app icon and public certificate
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

YouTube changes constantly. Run `update-yt.bat` weekly, and straight away if playback or downloads break. Back up your data by copying `%LOCALAPPDATA%\MyTube\userdata.json`, or with **Settings → Export JSON**.

## Legal

Downloading from YouTube is against its Terms of Service except where YouTube allows it. Use this for personal purposes and respect creators' copyright. This project is not affiliated with YouTube, Google or the Invidious project.
