@echo off
rem Weekly maintenance (guide section 13.1), or run immediately when playback / downloads break.
rem Run it while the stack is up (start-yt.bat) so the containers restart on the new images.
echo [1/3] Invidious + companion (git pull, new images, restart, prune old images)
wsl -d Ubuntu-24.04 -- bash -lc "cd ~/invidious && git pull --ff-only && docker compose pull && docker compose up -d && docker image prune -f"
echo.
echo [2/3] yt-dlp
python -m pip install -U "yt-dlp[default]"
echo.
echo [3/3] Deno + ffmpeg (monthly is enough; "no update" messages are normal)
winget upgrade DenoLand.Deno
winget upgrade Gyan.FFmpeg
echo.
echo If playback still fails after an update, compare compose.yaml with the official file:
echo   https://docs.invidious.io/installation/   and re-apply deltas D1-D9 (guide section 8.3).
pause
