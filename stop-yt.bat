@echo off
rem Stops everything and returns all WSL memory (guide section 11.3).
wsl -d Ubuntu-24.04 -- bash -lc "cd ~/invidious && docker compose stop"
wsl --shutdown
rem UI backend: kill whatever listens on port 8080 (more reliable than matching a window title)
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
taskkill /fi "WINDOWTITLE eq yt-ui*" /f >nul 2>&1
taskkill /fi "WINDOWTITLE eq yt-wsl*" /f >nul 2>&1
echo Stopped.
