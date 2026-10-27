# Launch guide

How to start, use, stop and look after My Tube once it is installed. For the first-time install, see [BUILD-GUIDE.md](BUILD-GUIDE.md) and the [setup checklist](#first-time-setup-on-a-new-pc) at the end of this page.

## Every day

### The app: MyTube.exe (recommended)

Double-click **`dist\MyTube.exe`**. A window titled *My Tube* opens at once, shows "Starting the engine" while WSL and the containers boot (about a minute on a cold start, under half a minute when WSL is warm), then loads your feed. **Close the window to stop everything**; if a download is still running you are asked first.

- **How long it takes:** the window opens in 2 to 4 seconds. If you already have a feed, it is shown straight away from its saved copy, with a small banner while the engine boots; thumbnails and playback appear when it is ready, about 16 seconds after the click on a cold start. That time is almost all WSL's virtual machine booting (about 8 s) and Docker starting the containers (about 5 s), which nothing in this project can skip. The very first launch after building a new exe is slower, because Windows Defender scans it once.
- **First time only:** build it with `build-exe.bat` (needs Python; PyInstaller is installed automatically). Then pin `dist\MyTube.exe` to the taskbar or make a desktop shortcut.
- **Second click:** clicking it again while it runs opens another window onto the same session; closing that extra window does not stop anything.
- **Already started with `start-yt.bat`?** The exe attaches to that session and leaves it running when you close the window.
- **Its own data:** the app window keeps its subscriptions and history separately from your browser. Move them with **Settings → Export JSON** in the browser and **Import JSON** in the app.
- **Logs and settings** live in `%LOCALAPPDATA%\MyTube` (`mytube.log`, and an optional `config.json`, see [below](#changing-things)).
- **Windows warns about the exe?** It is unsigned. Choose *More info → Run anyway*, or just run `python launcher.py`, which does the same thing without an exe.

### Or in a browser tab: start-yt.bat

### 1. Start it

Double-click **`start-yt.bat`**.

What happens, in order:

1. A minimized window called `yt-wsl` opens. It boots WSL, starts the three containers (Invidious, companion, Postgres) and stays open so Windows doesn't shut WSL down.
2. A minimized window called `yt-ui` opens. It runs the local web server on port 8080.
3. The script waits until Invidious answers (about a minute on a cold start, a few seconds if it was already running).
4. Your browser opens **http://localhost:8080**.

Leave both minimized windows alone while you use the app. If you close the `yt-wsl` window, WSL goes idle and the containers stop after a minute or so.

Nothing starts by itself with Windows, so after a reboot you simply run `start-yt.bat` again.

> Tip: right-click `start-yt.bat` → **Show more options** → **Send to** → **Desktop (create shortcut)**. Do the same for `stop-yt.bat`.

### 2. Use it

| You want to | Do this |
|---|---|
| Find something | Type in the search box. Suggestions appear as you type; use the arrow keys and Enter. |
| Follow a channel | Open the channel and press **Subscribe**. The **Feed** page shows their newest videos. |
| Watch | Click a video. Playback quality follows **Settings → Playback quality** and falls back automatically if a stream fails. |
| Download | Press **Download** on a video, choose **Video** (480p / 720p / 1080p) or **Audio only** (MP3), check the path shown, press **Download**. |
| Download a playlist | Press **Download playlist** on a playlist page, on a playlist in the search results (filter by *Playlists*), or in the playlist panel beside a video you opened from one. Choose the format, then **Videos to download**: all of it, or the first 10 / 25 / 50 / 100. |
| See downloads | **Saved** shows running jobs and your library. **Play** plays a file in the app, **Save copy** saves another copy through the browser, **Open folder** opens it in Explorer. |
| Watch offline | Videos in your library play from disk with no network use. |

Downloads are stored on this PC:

| Type | Folder |
|---|---|
| Video | `%USERPROFILE%\Videos\yt` |
| Audio | `%USERPROFILE%\Music\yt` |

### Playlist downloads in detail

- Progress shows as `video 4 of 10` with an overall bar on the **Saved** page, and files appear in your library as each one finishes.
- **Cancel** stops the job at once. Files already finished are kept, and a half-downloaded file resumes next time.
- Videos you already downloaded in the same kind (video or audio) are skipped, tracked in `archive-video.txt` and `archive-audio.txt` next to `server.py`. Delete the matching file if you really want to download everything again.
- Unavailable videos (private, deleted, region-blocked) are passed over, and the job says how many.
- YouTube *Mix* playlists (their address contains `list=RD...`) are endless and cannot be downloaded.
- Two jobs run at a time; the rest wait in the queue.

### 3. Stop it

Double-click **`stop-yt.bat`**. It stops the containers cleanly, shuts WSL down (so all its memory goes back to Windows), and closes the local web server. While stopped, the project uses 0 MB of RAM.

## Starting by hand (if the .bat file fails)

Open **PowerShell** in the project folder:

```powershell
# 1. WSL + containers (leave this window open; it keeps WSL alive)
wsl -d Ubuntu-24.04 -- bash -lc "cd ~/invidious && docker compose up -d && exec sleep infinity"
```

Open a **second** PowerShell window in the project folder:

```powershell
# 2. local web server
python server.py
```

Then open http://localhost:8080. To stop: press `Ctrl+C` in the second window, then run `wsl --shutdown`.

## Quick health check

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" http://localhost:8080/config.json          # 200 = web server up
curl.exe -s -o NUL -w "%{http_code}`n" "http://localhost:3000/api/v1/search/suggestions?q=a"   # 200 = Invidious up
wsl -d Ubuntu-24.04 -- docker compose -f ~/invidious/compose.yaml ps              # 3 containers "Up"
```

| Port | Service | Reachable from |
|---|---|---|
| 8080 | Web interface and local backend | This PC only |
| 3000 | Invidious | This PC only |
| 8282 | invidious-companion (streams) | This PC only |

## Weekly and monthly care

| When | What |
|---|---|
| Weekly, or as soon as playback or downloads break | Run **`update-yt.bat`** with the stack running. It updates Invidious and companion, yt-dlp, Deno and ffmpeg. |
| Monthly | **Settings → Export JSON**. Your subscriptions, history and watch-later list live only in your browser, so this file is your backup. Restore it with **Import JSON**. |
| Occasionally | `wsl -d Ubuntu-24.04 -- sudo apt update` then `sudo apt full-upgrade -y` to update Ubuntu. |

YouTube changes often. When something stops working, updating is the first fix, as it is for almost every Invidious and yt-dlp problem.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The page loads but says "Invidious unreachable" | The containers are still starting (give it a minute) or WSL went idle. Run `start-yt.bat` again. |
| Search works, video won't play | Run `update-yt.bat`. Then check `wsl -d Ubuntu-24.04 -- docker compose -f ~/invidious/compose.yaml logs --tail 50 companion`. |
| Video takes several seconds to start at 720p/1080p | Normal: the adaptive manifest is generated on demand. Choose 360p in Settings for the fastest start. |
| Download fails with `HTTP Error 403` | yt-dlp is out of date. Run `update-yt.bat` (or `python -m pip install -U "yt-dlp[default]"`). |
| "Sign in to confirm you're not a bot" | Update everything. If it persists, restart your router to get a new IP address. |
| `start-yt.bat` opens the browser but the page is blank | Another program uses port 8080. Close it, or start the server on another port: `set YT_PORT=8090` then `python server.py`. |
| Containers stop on their own | The `yt-wsl` window was closed. Start again with `start-yt.bat`. |
| Everything is slow or memory is tight | Check **Task Manager → VmmemWSL**. After `stop-yt.bat` it must disappear. Lower `memory=` in `%USERPROFILE%\.wslconfig` if you need more RAM for Windows. |
| The exe says yt-dlp was not found | Install it with `winget install yt-dlp.yt-dlp`, or set `ytdlp` in `config.json` (see Changing things). |
| The exe shows "WSL distribution not found" | Your distro has another name. Set `distro` in `config.json`. |
| `python` is not recognized | Install Python 3 and tick "Add to PATH", or edit `start-yt.bat` to use the full path of your Python. |

## First-time setup on a new PC

Short version; every step is explained in [BUILD-GUIDE.md](BUILD-GUIDE.md).

1. Windows 11 with virtualization enabled. Enable **WSL2** and install Ubuntu: `wsl --install -d Ubuntu-24.04`, then reboot.
2. Create `%USERPROFILE%\.wslconfig` (section 6.2 of the guide) to cap WSL at 1.5 GB.
3. Install Docker Engine inside Ubuntu (section 7): `curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER`, then `wsl --shutdown`.
4. Install the Windows tools:
   ```powershell
   winget install Python.Python.3.12
   winget install Gyan.FFmpeg
   winget install DenoLand.Deno
   python -m pip install -U "yt-dlp[default]"
   ```
5. Clone this repository, then set up Invidious in WSL with the included script (it generates the secret keys for you):
   ```powershell
   git clone https://github.com/mohameddddt/mytube-invidious.git
   cd mytube-invidious
   wsl -d Ubuntu-24.04 -- bash deploy/setup-invidious.sh
   ```
   WSL opens in the same folder you are in, so the relative path works. The script installs Invidious in `~/invidious` inside Ubuntu and starts it. Run it with `--no-start` to only prepare the files.
6. Run `build-exe.bat` once, then double-click `dist\MyTube.exe` (or use `start-yt.bat` for a browser tab). If your distro isn't called `Ubuntu-24.04`, set `distro` in `%LOCALAPPDATA%\MyTube\config.json` for the exe, and edit the name in the three `.bat` files for the browser route.

## Changing things

| You want | Change |
|---|---|
| Another download folder | `VIDEO_DIR` / `AUDIO_DIR` at the top of `server.py` |
| Another web port | Environment variable `YT_PORT` |
| Another WSL distro name, or a yt-dlp in an unusual place (exe) | `%LOCALAPPDATA%\MyTube\config.json`, for example `{"distro": "Ubuntu-22.04", "ytdlp": "C:\\tools\\yt-dlp.exe"}` |
| Different Invidious address (another machine) | `INVIDIOUS_URL` and `INVIDIOUS_PUBLIC_URL` environment variables, and `public_url` in `compose.yaml` |
| Phone or other devices | [BUILD-GUIDE.md](BUILD-GUIDE.md), section 12 (Tailscale is the safe way) |
