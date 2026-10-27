# Personal YouTube Interface — Self-Hosted Invidious on Windows (Option B)

> **Scope:** architecture, decisions, sources, and the exact build/operate procedure.
> Application code is intentionally out of scope — this guide defines *what* to build and *how it fits together*, not the implementation.
>
> **Target machine:** Windows 11, x86-64, 8 GB+ RAM recommended (4 GB minimum).
> **Constraints:** 0 payments · minimal RAM/CPU · video downloads · no extra internet cost from hosting.

---

## Table of contents

1. [Goals and constraints](#1-goals-and-constraints)
2. [Why Option B](#2-why-option-b)
3. [The 2025–2026 YouTube landscape (read first)](#3-the-20252026-youtube-landscape-read-first)
4. [Architecture](#4-architecture)
5. [Prerequisites and sources](#5-prerequisites-and-sources)
6. [Phase 1 — Prepare the Windows host (WSL2)](#6-phase-1--prepare-the-windows-host-wsl2)
7. [Phase 2 — Install Docker Engine inside WSL](#7-phase-2--install-docker-engine-inside-wsl)
8. [Phase 3 — Deploy Invidious + Companion + Postgres](#8-phase-3--deploy-invidious--companion--postgres)
9. [Phase 4 — Download toolchain (yt-dlp)](#9-phase-4--download-toolchain-yt-dlp)
10. [Phase 5 — Design of your own interface](#10-phase-5--design-of-your-own-interface)
11. [Phase 6 — On-demand lifecycle (start / stop)](#11-phase-6--on-demand-lifecycle-start--stop)
12. [Phase 7 — Optional: access from other devices](#12-phase-7--optional-access-from-other-devices)
13. [Phase 8 — Maintenance](#13-phase-8--maintenance)
14. [Resource and bandwidth budget](#14-resource-and-bandwidth-budget)
15. [Acceptance checklist](#15-acceptance-checklist)
16. [Troubleshooting](#16-troubleshooting)
17. [Security and legal notes](#17-security-and-legal-notes)
18. [Reference sources](#18-reference-sources)

---

## 1. Goals and constraints

| # | Requirement | How this design satisfies it |
|---|---|---|
| R1 | **Zero payments** | Every component is free/open source. No cloud, no card verification, no subscriptions. |
| R2 | **Very lightweight RAM/CPU** | Docker Engine inside WSL (no Docker Desktop), memory caps per container, Invidious background jobs disabled, stack runs **only when you use it** and is fully shut down otherwise (0 MB). |
| R3 | **Download YouTube videos** | `yt-dlp` + `ffmpeg` + `deno` on Windows, triggered from your interface or manually. Independent of Invidious. |
| R4 | **No extra internet cost from hosting** | Server and viewer share the same home connection and the same public IP → traffic is identical to watching YouTube normally. No relay, no double traffic, no idle background crawling. |
| R5 | **Own interface** | A custom, framework-free web UI served locally, consuming the Invidious REST API. |

---

## 2. Why Option B

| Option | Rejected / chosen because |
|---|---|
| A. Public instances | Unreliable: most disable API/CORS, rate-limit, go down, or are blocked by YouTube. Kept only as an emergency fallback. |
| **B. Self-host on this Windows PC** | **Chosen.** Free, residential IP (rarely blocked), same-IP streaming (no double bandwidth), can be fully stopped when not in use. |
| C. Spare always-on machine | Good later if you want phone/TV access 24/7. Migration from B is copying one folder (see §13.4). |
| D. Free cloud VPS | Requires card verification, datacenter IP is heavily blocked, all video must be proxied → double traffic. |
| E. No Invidious (yt-dlp only) | Lightest, but slow (2–5 s per page) and loses the Invidious API. |

---

## 3. The 2025–2026 YouTube landscape (read first)

These facts drive several design decisions. Any tutorial that ignores them is outdated.

1. **Invidious alone can no longer play videos.** YouTube enforces *Proof-of-Origin (PO) tokens* and bot detection. Invidious now requires a sidecar service, **invidious-companion** (built on YouTube.js), which retrieves streams, generates tokens, and serves video data.
2. **Stream URLs are IP-bound.** A `googlevideo.com` URL is valid only from the public IP that requested it. Hosting at home and watching at home means the IPs match — this is the core reason Option B costs no extra bandwidth.
3. **Datacenter IPs are blocked aggressively** ("Sign in to confirm you're not a bot"). Residential IPs are the most reliable.
4. **yt-dlp requires an external JavaScript runtime (Deno)** for full YouTube support, plus **ffmpeg** to merge separate video/audio streams above 360p.
5. **YouTube removed its Trending page (2025).** Invidious "Trending"/"Popular" are empty or broken → design your UI around **search + subscriptions**, not trending.
6. **Invidious changes frequently.** The official Docker Compose file is the source of truth. This guide gives a reference version and lists which deltas to apply on top of the official one (§8.3).

---

## 4. Architecture

### 4.1 Component overview

```
┌──────────────────────────────── Windows 11 host ─────────────────────────────────┐
│                                                                                  │
│   Browser (Edge/Firefox)                                                         │
│     │  http://localhost:8080                                                     │
│     ▼                                                                            │
│   ┌──────────────────────────┐        ┌──────────────────────────────┐          │
│   │  UI backend  :8080       │ spawn  │  yt-dlp  (+ deno, ffmpeg)    │          │
│   │  - serves static UI      │───────►│  runs only while downloading │          │
│   │  - /api/* → Invidious    │        └──────────────┬───────────────┘          │
│   │  - /download → yt-dlp    │                       │ writes                   │
│   └────────────┬─────────────┘                       ▼                          │
│                │                          %USERPROFILE%\Videos\yt               │
│                │ localhost forwarding                                           │
│ ┌──────────────┼──────────────── WSL2 VM (Ubuntu 24.04, capped 1.5 GB) ───────┐ │
│ │              ▼                     Docker Engine                            │ │
│ │   ┌────────────────────┐   private   ┌────────────────────┐                 │ │
│ │   │ invidious   :3000  │────────────►│ companion   :8282  │                 │ │
│ │   │ API + metadata     │   key auth  │ streams, PO tokens │                 │ │
│ │   └─────────┬──────────┘             └─────────┬──────────┘                 │ │
│ │             ▼                                  │                            │ │
│ │   ┌────────────────────┐                       │                            │ │
│ │   │ postgres (internal)│                       │                            │ │
│ │   └────────────────────┘                       │                            │ │
│ └────────────────────────────────────────────────┼────────────────────────────┘ │
└──────────────────────────────────────────────────┼──────────────────────────────┘
                                                   ▼
                                     YouTube (from your home IP)
```

### 4.2 Responsibilities

| Component | Runs where | Responsibility | Does NOT do |
|---|---|---|---|
| **Your UI (static files)** | Browser | Pages, layout, player, subscriptions & history (browser storage) | Talk to YouTube directly |
| **UI backend** | Windows, port 8080 | Serve UI files, forward API calls to Invidious (single origin, no CORS issues), launch yt-dlp jobs, list downloaded files | Store user data, stream video |
| **Invidious** | WSL/Docker, port 3000 | REST API: search, video metadata, channels, playlists, comments, thumbnails, DASH manifests | Fetch video bytes itself (delegated to companion) |
| **invidious-companion** | WSL/Docker, port 8282 | Retrieve stream URLs, solve PO tokens, serve/proxy video data to the browser | Metadata/search |
| **PostgreSQL** | WSL/Docker, internal only | Invidious's required database (cache, preferences) | Anything you need to back up |
| **yt-dlp + ffmpeg + deno** | Windows | Download and merge video/audio files | Anything while idle |

### 4.3 Data flows

**Search / browse**
```
UI ──GET /api/search?q=…──► UI backend ──GET /api/v1/search?q=…──► Invidious ──► YouTube
UI ◄──────────── JSON ◄──────────────────────────────────────────── Invidious
```

**Playback**
```
UI ──GET /api/videos/{id}──► (backend) ──► Invidious      → returns metadata + stream info
<video>/DASH player ──► Invidious (latest_version / DASH manifest, local=true)
                    ──► redirected to companion public_url ──► YouTube video servers
```
The browser must be able to reach the companion **public URL** directly. On this PC that is `http://localhost:8282/companion`.

**Download**
```
UI ──POST /download {id, type, maxRes}──► UI backend ──spawn──► yt-dlp ──► YouTube
                                                                   └──► ffmpeg merge ──► Videos\yt
```
Downloads never pass through Invidious. They use your home IP directly, which is why they keep working even if Invidious breaks.

**Subscriptions feed (no account)**
```
UI reads channel list from browser storage
 └─ for each channel: GET /api/channels/{ucid}/videos → merge → sort by "published" → render
```
The feed is computed on demand. Invidious background crawlers stay disabled, so idle CPU and network are zero.

### 4.4 Ports and network boundaries

| Port | Service | Bound to | Reachable from |
|---|---|---|---|
| 8080 | UI backend | `127.0.0.1` | This PC only |
| 3000 | Invidious | `127.0.0.1` (in Docker) → forwarded to Windows localhost by WSL | This PC only |
| 8282 | Companion | `127.0.0.1` → forwarded to Windows localhost | This PC only |
| 5432 | Postgres | Docker internal network only | Invidious only |

Nothing is exposed to your LAN or the internet by default. §12 covers the opt-in changes.

### 4.5 Storage locations

| Data | Location | Backup needed? |
|---|---|---|
| Invidious repo + compose file | `~/invidious` (inside WSL) | Keep a copy of `docker-compose.yml` |
| Postgres data | Docker volume `postgresdata` | No (cache only, since accounts are disabled) |
| Companion cache | Docker volume `companioncache` | No |
| UI files + backend | The folder where you cloned this repository | Yes (your project) |
| Subscriptions, history, settings | Browser storage | Yes, through an export/import feature in the UI (§10.5) |
| Downloads | `%USERPROFILE%\Videos\yt`, `%USERPROFILE%\Music\yt` | Your choice |

### 4.6 Lifecycle model

The stack is **on-demand**:

```
[stopped: 0 MB] ──start-yt.bat──► [WSL boots → containers up → UI backend up → browser opens]
                                          │
                                   watch / download
                                          │
[stopped: 0 MB] ◄──stop-yt.bat── [containers stop → WSL shuts down → backend killed]
```

---

## 5. Prerequisites and sources

### 5.1 Hardware

| Item | Minimum | Recommended |
|---|---|---|
| CPU | 2 cores x86-64 with virtualization enabled in BIOS/UEFI | 4 cores |
| RAM | 4 GB | 8 GB+ |
| Disk | 10 GB free | 20 GB + space for downloads |
| Internet | Any home connection | — |

Check virtualization: Task Manager → Performance → CPU → "Virtualization: Enabled".

### 5.2 Software

| Software | Role | Install method | Official source |
|---|---|---|---|
| WSL2 | Linux VM | `wsl --install` | https://learn.microsoft.com/windows/wsl/install |
| Ubuntu 24.04 LTS | Linux distro | `wsl --install -d Ubuntu-24.04` | https://ubuntu.com/desktop/wsl |
| Docker Engine (not Desktop) | Container runtime | `get.docker.com` script | https://docs.docker.com/engine/install/ubuntu/ |
| Invidious | API/front service | Docker image `quay.io/invidious/invidious` | https://docs.invidious.io/installation/ |
| invidious-companion | Stream/PO-token service | Docker image `quay.io/invidious/invidious-companion` | https://github.com/iv-org/invidious-companion |
| PostgreSQL 14 | Invidious DB | Docker image `postgres:14` | https://hub.docker.com/_/postgres |
| Python 3.12+ | UI backend runtime (suggested; stdlib only) | `winget install Python.Python.3.12` | https://www.python.org |
| yt-dlp | Downloader | `winget install yt-dlp.yt-dlp` | https://github.com/yt-dlp/yt-dlp |
| ffmpeg | Merge video+audio | `winget install Gyan.FFmpeg` | https://www.gyan.dev/ffmpeg/builds/ |
| Deno | JS runtime for yt-dlp | `winget install DenoLand.Deno` | https://deno.com |
| dash.js (optional) | 720p+ playback in browser | CDN (cdnjs) | https://github.com/Dash-Industry-Forum/dash.js |

---

## 6. Phase 1 — Prepare the Windows host (WSL2)

**Goal:** a Linux VM that uses at most ~1.5 GB of RAM, reclaims memory when idle, and runs systemd.

### 6.1 Install WSL2 and Ubuntu
PowerShell **as Administrator**:
```powershell
wsl --install -d Ubuntu-24.04
```
Reboot. Launch **Ubuntu 24.04** from the Start menu and create a Linux username and password.

Verify:
```powershell
wsl -l -v        # Ubuntu-24.04 should show VERSION 2
```

### 6.2 Cap WSL resources
Create `%USERPROFILE%\.wslconfig`:
```ini
[wsl2]
memory=1536MB
processors=2
swap=1GB
# networkingMode=mirrored    # enable only in Phase 7 (LAN access)

[experimental]
autoMemoryReclaim=gradual
```
Apply it with `wsl --shutdown`, then reopen Ubuntu.

**Why:** by default WSL can take up to 50% of host RAM and keep it after use. The cap and gradual reclaim keep the footprint predictable. Reference: https://learn.microsoft.com/windows/wsl/wsl-config

### 6.3 Confirm systemd is enabled
Inside Ubuntu:
```bash
cat /etc/wsl.conf
```
It must contain:
```ini
[boot]
systemd=true
```
If it's missing, add it with `sudo nano /etc/wsl.conf`, then run `wsl --shutdown` from Windows. Docker relies on systemd to start automatically when WSL boots.

### 6.4 Update the system
```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y ca-certificates curl git openssl
```

---

## 7. Phase 2 — Install Docker Engine inside WSL

**Why not Docker Desktop:** it adds its own VM, GUI and background services, costing roughly 0.5–1 GB more RAM and starting with Windows. Docker Engine inside your WSL distro has none of that overhead.

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
exit
```
Reopen Ubuntu, then verify:
```bash
docker version
docker compose version
docker run --rm hello-world
systemctl is-enabled docker     # → enabled
```

---

## 8. Phase 3 — Deploy Invidious + Companion + Postgres

### 8.1 Get the official files
```bash
cd ~
git clone https://github.com/iv-org/invidious.git
cd invidious
```
The repo provides the database schema (`config/sql/`) and init script (`docker/init-invidious-db.sh`) that the Postgres container needs on first start.

### 8.2 Generate secrets
```bash
openssl rand -hex 8     # COMPANION_KEY — must be exactly 16 characters
openssl rand -hex 20    # HMAC_KEY
```
Rules:
- The two keys must be **different**.
- `invidious_companion_key` (Invidious) and `SERVER_SECRET_KEY` (companion) must be **identical** (both equal COMPANION_KEY).

### 8.3 Compose file: official base + lightweight deltas

**Procedure:** open the current official compose file from https://docs.invidious.io/installation/ (Docker method), then apply the deltas in the table. The reference file in §8.4 already contains them.

| Delta | Setting | Purpose |
|---|---|---|
| D1 | Ports prefixed with `127.0.0.1:` | No LAN/internet exposure |
| D2 | `mem_limit` on each service | Hard RAM ceiling; the Invidious leak is contained by an automatic restart |
| D3 | `channel_threads: 0`, `feed_threads: 0` | No background crawling → zero idle CPU/network |
| D4 | `popular_enabled: false`, `statistics_enabled: false` | Disable unused features |
| D5 | `registration_enabled: false`, `login_enabled: false`, `captcha_enabled: false` | No accounts; subscriptions live in your UI |
| D6 | `default_user_preferences` (`local: true`, `quality: dash`, `quality_dash: 720p`) | Streams go through companion; sensible default quality to save data |
| D7 | Postgres `command:` tuning (`shared_buffers=32MB`, etc.) | Shrink the DB memory footprint |
| D8 | Logging `max-size: 10m`, `max-file: 2` | Logs can't fill the disk |
| D9 | Remove the healthcheck that calls `/api/v1/trending` | Trending is gone, so the check fails needlessly and wastes cycles |

### 8.4 Reference `docker-compose.yml`
```yaml
services:
  invidious:
    image: quay.io/invidious/invidious:latest
    restart: unless-stopped
    mem_limit: 512m
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      INVIDIOUS_CONFIG: |
        db:
          dbname: invidious
          user: kemal
          password: kemal
          host: invidious-db
          port: 5432
        check_tables: true
        invidious_companion:
          - private_url: "http://companion:8282/companion"
            public_url: "http://localhost:8282/companion"
        invidious_companion_key: "PUT_COMPANION_KEY"
        hmac_key: "PUT_HMAC_KEY"
        channel_threads: 0
        feed_threads: 0
        popular_enabled: false
        statistics_enabled: false
        registration_enabled: false
        login_enabled: false
        captcha_enabled: false
        default_user_preferences:
          local: true
          quality: dash
          quality_dash: 720p
          autoplay: false
    logging:
      options: { max-size: "10m", max-file: "2" }
    depends_on: [invidious-db]

  companion:
    image: quay.io/invidious/invidious-companion:latest
    restart: unless-stopped
    mem_limit: 300m
    environment:
      - SERVER_SECRET_KEY=PUT_COMPANION_KEY
    ports:
      - "127.0.0.1:8282:8282"
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    volumes:
      - companioncache:/var/tmp/youtubei.js:rw
    logging:
      options: { max-size: "10m", max-file: "2" }

  invidious-db:
    image: docker.io/library/postgres:14
    restart: unless-stopped
    mem_limit: 256m
    command: postgres -c shared_buffers=32MB -c effective_cache_size=128MB -c work_mem=2MB
    volumes:
      - postgresdata:/var/lib/postgresql/data
      - ./config/sql:/config/sql
      - ./docker/init-invidious-db.sh:/docker-entrypoint-initdb.d/init-invidious-db.sh
    environment:
      POSTGRES_DB: invidious
      POSTGRES_USER: kemal
      POSTGRES_PASSWORD: kemal

volumes:
  postgresdata:
  companioncache:
```

> ⚠️ **If the official docs differ from this file** (for example, `public_url` becoming optional because Invidious now proxies companion itself, or fields being renamed), **the official docs win**. Re-apply only deltas D1–D9.

### 8.5 First start
```bash
cd ~/invidious
docker compose up -d
docker compose ps                       # all three "running"
docker compose logs -f invidious        # wait for the "ready" line, then Ctrl+C
```

### 8.6 Verify each layer
| Test | Command / action | Expected result |
|---|---|---|
| API alive | `curl -s "http://localhost:3000/api/v1/search?q=test" \| head -c 200` | JSON array |
| Video metadata | `curl -s http://localhost:3000/api/v1/videos/<any-id> \| head -c 200` | JSON with `title` |
| Companion reachable | Open `http://localhost:8282/companion` in the Windows browser | A response (not "connection refused") |
| Playback end to end | Open `http://localhost:3000`, search, play a video | Video plays |
| RAM | `docker stats --no-stream` | Within the `mem_limit` values |

Once playback works in the stock Invidious web UI, the backend is done. Everything after this is your own layer on top.

---

## 9. Phase 4 — Download toolchain (yt-dlp)

### 9.1 Install (PowerShell, normal user)
```powershell
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg
winget install DenoLand.Deno
```
Open a **new** terminal so PATH refreshes, then verify:
```powershell
yt-dlp --version
ffmpeg -version
deno --version
```

### 9.2 Download policy (define once, use from the UI)

| Profile | yt-dlp options | Typical size |
|---|---|---|
| **Data saver** | `-S "res:480" --merge-output-format mp4` | ~0.2–0.4 GB/h |
| **Standard** (default) | `-S "res:720" --merge-output-format mp4` | ~0.5–1 GB/h |
| **High** | `-S "res:1080" --merge-output-format mp4` | ~1–2 GB/h |
| **Audio** | `-x --audio-format mp3` | ~60–100 MB/h |
| **Playlist** | add `--download-archive archive.txt` | skips files already downloaded |

Common options for every profile:
- Output folder: `-P "%USERPROFILE%\Videos\yt"` (audio: `Music\yt`)
- Filename template: `-o "%(title)s [%(id)s].%(ext)s"` (the ID makes names unique and searchable)

Why `-S "res:N"` instead of `-f`: it picks the best format up to that resolution and degrades gracefully, so the command doesn't fail when a given format code is missing.

### 9.3 Rules for the UI-triggered downloads
1. **Validate the video ID** (11 characters `[A-Za-z0-9_-]`) before passing it to yt-dlp, which prevents argument injection.
2. **Never pass free-form user text** to the command line. Map UI choices to the fixed profiles above.
3. **Run downloads as background processes.** The UI gets an immediate "accepted" response and polls a downloads list.
4. **Limit concurrency to 1–2 downloads** to keep CPU (ffmpeg merge) and bandwidth predictable.

### 9.4 Bot-check fallback
If yt-dlp reports "Sign in to confirm you're not a bot":
1. Update first (`winget upgrade yt-dlp.yt-dlp`).
2. Restart your router to get a new IP.
3. Last resort: `--cookies-from-browser firefox`. This uses your logged-in session, so use it rarely.

Reference: https://github.com/yt-dlp/yt-dlp/wiki/FAQ and https://github.com/yt-dlp/yt-dlp/wiki/EJS

---

## 10. Phase 5 — Design of your own interface

This section defines **what** the interface consists of and **which sources** it uses. Implementation is left to you.

### 10.1 Technology principles
| Principle | Choice | Reason |
|---|---|---|
| No framework, no build step | Plain HTML + CSS + vanilla JS | Zero build tooling, tiny memory in the browser |
| One origin | All requests go to `localhost:8080` | No CORS problems, one place to change the Invidious address |
| Thin backend | Python standard library (or any minimal HTTP server) | ~20 MB RAM, no dependencies |
| State in the browser | `localStorage` | No database or accounts needed |

### 10.2 Backend contract (UI backend on :8080)

| Route | Method | Behavior |
|---|---|---|
| `/` and static files | GET | Serve the UI folder |
| `/api/*` | GET | Forward to `http://127.0.0.1:3000/api/v1/*` and return the JSON and status unchanged |
| `/download` | POST `{id, profile}` | Validate, start a yt-dlp job, return **202** |
| `/downloads` | GET | List files in the download folders (name, size, date) |
| `/files/<name>` | GET | Serve a downloaded file for offline playback (restricted to the download folder) |

### 10.3 Pages and their Invidious sources
API reference: https://docs.invidious.io/api/

| Page | Purpose | Invidious endpoint(s) |
|---|---|---|
| **Home / Feed** | Latest videos from your subscriptions | `GET /api/v1/channels/{ucid}/videos` per subscribed channel |
| **Search** | Results with filters | `GET /api/v1/search?q=&type=video\|channel\|playlist&sort=&date=&duration=&page=` |
| **Search box** | Autocomplete | `GET /api/v1/search/suggestions?q=` |
| **Watch** | Player, title, description, related videos, download buttons | `GET /api/v1/videos/{id}` (`formatStreams`, `adaptiveFormats`, `recommendedVideos`) |
| **Comments** (lazy-loaded) | Comments under the player | `GET /api/v1/comments/{id}?continuation=` |
| **Channel** | Channel header + videos | `GET /api/v1/channels/{ucid}`, `/api/v1/channels/{ucid}/videos?continuation=` |
| **Playlist** | Playlist items | `GET /api/v1/playlists/{plid}?page=` |
| **Downloads** | Local library and job status | Backend `/downloads`, `/files/<name>` |
| **Settings** | Default quality, download profile, export/import | Browser storage only |

Thumbnails: `http://localhost:3000/vi/{id}/mqdefault.jpg` (small) or `hqdefault.jpg` (larger). Use `loading="lazy"` on images to save bandwidth.

### 10.4 Playback strategy (graceful fallback chain)
| Tier | Source | Quality | When to use |
|---|---|---|---|
| 1 | `http://localhost:3000/latest_version?id={id}&itag=18&local=true` in a native `<video>` | 360p combined stream | Default in data-saver mode; simplest; no library needed |
| 2 | DASH manifest `http://localhost:3000/api/manifest/dash/id/{id}?local=true` played by dash.js | 480p–1080p+ (adaptive) | Default in standard/high mode |
| 3 | `<iframe src="http://localhost:3000/embed/{id}">` | Whatever Invidious offers | If tiers 1–2 fail |
| 4 | Local file from `/files/<name>` | As downloaded | Offline / repeat viewing (zero network) |

Rules:
- Cap DASH at your configured default quality (for example 720p) to control data use.
- If a stream errors, fall back one tier automatically.
- **Prefer playing downloaded files** when the video is already in the library.

### 10.5 Browser-side data model (`localStorage`)
| Key | Content |
|---|---|
| `subscriptions` | List of `{ucid, name, thumbnail}` |
| `history` | Last N watched `{id, title, watchedAt, position}` (cap N, for example 500) |
| `watchLater` | List of video IDs |
| `settings` | `{defaultQuality, downloadProfile, autoplay, theme}` |
| `feedCache` | Last computed feed + timestamp (refresh at most every 15–30 min) |

Provide **Export / Import as JSON** in Settings. This is your backup, since the server holds no user data.

### 10.6 Performance and data-saving rules
- Cache the subscription feed (15–30 min). Don't refetch on every page load.
- Fetch channels in small batches (for example 4 at a time) to avoid hammering Invidious.
- Lazy-load comments and related videos only when they're scrolled into view.
- Use small thumbnails in grids and larger ones only on the watch page.
- Never auto-play the next video unless you enable it.

---

## 11. Phase 6 — On-demand lifecycle (start / stop)

### 11.1 Why a keep-alive is needed
WSL2 shuts its VM down after a short idle period when no Windows process is attached, which would stop the containers. The start procedure therefore keeps one hidden WSL process alive. Stopping kills it and shuts the VM down, returning 100% of the RAM.

### 11.2 Start procedure (`start-yt.bat`)
1. Launch WSL minimized, run `docker compose up -d` in `~/invidious`, then keep the session alive (`sleep infinity`).
2. Launch the UI backend minimized.
3. Wait ~8 seconds for Invidious to be ready.
4. Open `http://localhost:8080`.

```bat
@echo off
start "yt-wsl" /min wsl -d Ubuntu-24.04 -- bash -lc "cd ~/invidious && docker compose up -d && exec sleep infinity"
start "yt-ui"  /min python "%~dp0server.py"
timeout /t 8 >nul
start http://localhost:8080
```

### 11.3 Stop procedure (`stop-yt.bat`)
1. `docker compose stop` (clean container shutdown).
2. `wsl --shutdown` (frees all VM memory).
3. Kill the UI backend window.

```bat
@echo off
wsl -d Ubuntu-24.04 -- bash -lc "cd ~/invidious && docker compose stop"
wsl --shutdown
taskkill /fi "WINDOWTITLE eq yt-ui*" /f >nul 2>&1
```

Optional: pin both scripts as desktop shortcuts. Avoid auto-start with Windows; on-demand use is the lightweight choice.

---

## 12. Phase 7 — Optional: access from other devices

Only do this if you need it. Each step widens exposure.

### 12.1 Key rule
The player loads video from the **companion `public_url`**, so that URL must resolve and be reachable **from the viewing device**. `localhost` only works on the PC itself.

### 12.2 Same Wi-Fi (LAN)
1. In `.wslconfig`, enable `networkingMode=mirrored` (Windows 11 22H2+), then run `wsl --shutdown`.
2. In `docker-compose.yml`, change ports `127.0.0.1:3000:3000` → `3000:3000` and `127.0.0.1:8282:8282` → `8282:8282`.
3. Set `public_url: "http://<PC-LAN-IP>:8282/companion"`, then `docker compose up -d`.
4. Make the UI backend listen on `0.0.0.0:8080`.
5. Windows Defender Firewall: allow inbound TCP 8080, 3000 and 8282 on **Private** networks only.
6. Reserve the PC's IP in your router (DHCP reservation) so the URL doesn't change.

### 12.3 Outside home: Tailscale (free personal plan)
1. Install Tailscale on the PC and phone, signed in to the same account. Source: https://tailscale.com/kb/1017/install
2. Use the PC's Tailscale IP (`100.x.y.z`) in `public_url` and in the address you open.
3. Video then travels over your **home upload** (~0.5–1 GB/h at 720p). Set a lower default quality for remote use.

### 12.4 Don't
- ❌ Port-forward these services on your router to the open internet.
- ❌ Use Cloudflare Tunnel's free plan for video. Its terms restrict serving video content.
- ❌ Reuse the same key for `hmac_key` and the companion key.

---

## 13. Phase 8 — Maintenance

### 13.1 Routine
| Task | When | Command |
|---|---|---|
| Update Invidious + companion | Weekly, **or immediately when playback breaks** | `cd ~/invidious && git pull && docker compose pull && docker compose up -d` |
| Update yt-dlp | Weekly, or when downloads fail | `winget upgrade yt-dlp.yt-dlp` |
| Update Deno / ffmpeg | Monthly | `winget upgrade DenoLand.Deno Gyan.FFmpeg` |
| Remove old images | Monthly | `docker image prune -f` |
| Update Ubuntu | Monthly | `sudo apt update && sudo apt full-upgrade -y` |
| Export UI data (subscriptions etc.) | Monthly | UI Settings → Export |

When pulling updates, compare the official compose file for new or renamed fields (§8.3) before restarting.

### 13.2 Memory leak handling
Invidious is known to grow in memory. In on-demand use the stack restarts every session, so this rarely matters. For long sessions, `mem_limit` plus `restart: unless-stopped` restarts it automatically when it hits the cap.

### 13.3 Monitoring (when curious)
```bash
docker stats --no-stream
docker compose logs --tail 100 companion
```
Windows Task Manager: the `VmmemWSL` process is the total WSL footprint.

### 13.4 Migrating to Option C later
Copy `~/invidious/docker-compose.yml` to the new Linux machine, clone the repo there, run `docker compose up -d`, and point the UI backend's Invidious address and the companion `public_url` to that machine's IP. There's nothing else to migrate.

---

## 14. Resource and bandwidth budget

### 14.1 RAM (while running)
| Component | Expected | Hard cap |
|---|---|---|
| WSL2 kernel / base | 150–300 MB | `.wslconfig` 1.5 GB total |
| Invidious | 150–400 MB | 512 MB |
| Companion | 80–200 MB | 300 MB |
| Postgres | 30–80 MB | 256 MB |
| UI backend | ~20 MB | — |
| yt-dlp + ffmpeg (only during downloads) | 100–300 MB, briefly | — |
| **Total** | **≈ 0.45–0.9 GB** | — |
| **When stopped** | **0 MB** | — |

### 14.2 CPU
Idle: ~0% (background jobs disabled). Watching: low, mostly the browser decoding video. Downloads: short ffmpeg merge spikes.

### 14.3 Internet
| Activity | Data |
|---|---|
| Stack idle | ~0 |
| Browsing / search / thumbnails | Few MB per session |
| Watching 360p / 480p / 720p / 1080p | ~0.3 / ~0.4 / ~0.5–1 / ~1–2 GB per hour |
| Rewatching a downloaded file | 0 |
| Hosting overhead | **0** (same IP, no relay) |

---

## 15. Acceptance checklist

| Phase | Check | ✔ |
|---|---|---|
| 1 | `wsl -l -v` shows Ubuntu-24.04 on version 2; `VmmemWSL` stays under ~1.5 GB | ☑ |
| 2 | `docker run --rm hello-world` succeeds without sudo | ☑ |
| 3 | `/api/v1/search?q=test` returns JSON | ☑ |
| 3 | Video plays in the stock Invidious UI at `localhost:3000` | ☑ |
| 3 | `docker stats` shows every container under its cap | ☑ |
| 4 | Manual 720p download produces a single merged `.mp4` | ☑ |
| 4 | Audio profile produces an `.mp3` | ☑ |
| 5 | Your UI: search → watch → play works at the default quality | ☑ |
| 5 | Download button creates a file; Downloads page lists it and plays it offline | ☑ |
| 5 | Subscriptions feed builds; export/import round-trips | ☑ |
| 6 | `stop-yt.bat` makes `VmmemWSL` disappear from Task Manager | ☑ |
| 7 | (Optional) Phone plays video over LAN/Tailscale | ☐ |

---

### Deployment notes (this machine, verified 2026-10-27)

Everything except the optional Phase 7 is built and checked. Deviations from the text above:

| Topic | What is actually deployed |
|---|---|
| Distro | An existing `Ubuntu-24.04` distro was reused. Its own files were not touched. |
| WSL cap | `.wslconfig` now caps **every** WSL distro at 1.5 GB / 2 CPUs, not only this stack. Raise `memory=` if you run heavy Linux work in the same distro. |
| Compose file | Lives at `~/invidious/compose.yaml` (untracked) instead of overwriting the repo's `docker-compose.yml`, so `git pull` in §13.1 never conflicts. `.env` pins `COMPOSE_FILE=compose.yaml`. The real keys exist only there; `deploy/compose.template.yml` has placeholders, and `deploy/setup-invidious.sh` fills them in. |
| Compose tweak | Added the official Postgres healthcheck and `depends_on: service_healthy`, so Invidious never races the database. |
| yt-dlp | Already installed through pip (miniconda). Update it with `python -m pip install -U yt-dlp`; `winget upgrade yt-dlp.yt-dlp` does not apply. `update-yt.bat` does this. |
| Companion key | Must be 16 **alphanumeric** characters; `openssl rand -hex 8` satisfies this. |
| Start script | `start-yt.bat` polls until Invidious answers instead of a fixed 8 s wait, and does not start duplicates. `stop-yt.bat` also kills the backend by port. |
| Extras | `POST /download` also accepts `{playlist, profile}` (uses `archive.txt`); `GET /jobs` reports progress; POSTs from other origins and unknown `Host` headers are refused. |
| Measured | Cold start to ready ≈ 1 min. `VmmemWSL` ≈ 1.0 GB while running (page cache included), 0 when stopped. Containers: companion ≈ 100–130 MB, Invidious ≈ 25 MB, Postgres ≈ 40–50 MB. |

Repository layout: `server.py`, `web/` (UI), `start-yt.bat`, `stop-yt.bat`, `update-yt.bat`, `deploy/` (compose template and setup script), `docs/`.

---

## 16. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Search works, video won't play | Companion unreachable or key mismatch | Check that `invidious_companion_key` equals `SERVER_SECRET_KEY` (16 characters). Open the `public_url` in the browser. Check `docker compose logs companion`. Update the images. |
| "Sign in to confirm you're not a bot" | IP flagged or outdated components | Update the images and yt-dlp, then restart the router for a new IP. Don't move to a cloud server. |
| Containers stop on their own a minute after start | WSL idle shutdown | Use the keep-alive start script (§11). |
| `localhost:3000` unreachable from Windows | WSL localhost forwarding off, or container not running | `docker compose ps`; check that `.wslconfig` hasn't disabled `localhostForwarding`; `wsl --shutdown` and retry. |
| DB errors on first start | Init script or schema not mounted | Run from the cloned repo folder. `docker compose down -v` then `up -d` (wipes cache data only). |
| Invidious RAM climbs | Known leak | Expected; `mem_limit` restarts it automatically. |
| yt-dlp only gets low quality or fails | Outdated yt-dlp, missing Deno or ffmpeg | `winget upgrade yt-dlp.yt-dlp`; verify `deno --version` and `ffmpeg -version`. |
| Trending page empty | YouTube removed Trending | Expected; don't build on it. |
| Phone loads pages but not video | `public_url` still `localhost` | Set it to the LAN or Tailscale IP (§12). |
| Upgrade broke the config | Upstream changed fields | Diff against the official compose file and re-apply deltas D1–D9. |

Community help: Invidious Matrix room and GitHub issues (https://github.com/iv-org/invidious/issues, https://github.com/iv-org/invidious-companion/issues).

---

## 17. Security and legal notes

- All services are bound to `127.0.0.1` by default, so only this PC can reach them.
- Keep `hmac_key` and the companion key private. Don't commit them to a public repository.
- The UI backend must only ever execute yt-dlp with validated IDs and fixed profiles.
- `/files/<name>` must refuse paths outside the download folder (no `..` traversal).
- **Legal:** downloading YouTube content is against YouTube's Terms of Service except where YouTube allows it. Keep downloads for personal use and respect creators' copyright.

---

## 18. Reference sources

| Topic | Source |
|---|---|
| Invidious installation (canonical compose file) | https://docs.invidious.io/installation/ |
| Invidious configuration options | https://github.com/iv-org/invidious/blob/master/config/config.example.yml |
| Invidious API | https://docs.invidious.io/api/ |
| Invidious source / issues | https://github.com/iv-org/invidious |
| invidious-companion | https://github.com/iv-org/invidious-companion |
| Public instance list (fallback only) | https://api.invidious.io |
| YouTube.js (used by companion) | https://github.com/LuanRT/YouTube.js |
| yt-dlp | https://github.com/yt-dlp/yt-dlp |
| yt-dlp format selection / sorting (`-S`) | https://github.com/yt-dlp/yt-dlp#sorting-formats |
| yt-dlp JS runtime requirement (EJS) | https://github.com/yt-dlp/yt-dlp/wiki/EJS |
| ffmpeg Windows builds | https://www.gyan.dev/ffmpeg/builds/ |
| Deno | https://deno.com |
| WSL install | https://learn.microsoft.com/windows/wsl/install |
| WSL `.wslconfig` / `wsl.conf` | https://learn.microsoft.com/windows/wsl/wsl-config |
| WSL mirrored networking | https://learn.microsoft.com/windows/wsl/networking |
| Docker Engine on Ubuntu | https://docs.docker.com/engine/install/ubuntu/ |
| Docker Compose file reference | https://docs.docker.com/reference/compose-file/ |
| dash.js player | https://github.com/Dash-Industry-Forum/dash.js |
| Tailscale install | https://tailscale.com/kb/1017/install |
