@echo off
rem Starts the whole stack on demand (guide section 11.2):
rem   1. hidden WSL session that runs the containers and keeps the VM alive
rem   2. UI backend on http://localhost:8080
rem   3. opens the browser once Invidious answers
cd /d "%~dp0"

curl.exe -s -f -o nul "http://localhost:3000/api/v1/search/suggestions?q=a" && goto invidious_up
start "yt-wsl" /min wsl -d Ubuntu-24.04 -- bash -lc "cd ~/invidious && docker compose up -d && exec sleep infinity"
:invidious_up

curl.exe -s -f -o nul "http://localhost:8080/config.json" && goto ui_up
start "yt-ui" /min python "%~dp0server.py"
:ui_up

echo Waiting for Invidious (up to 2 minutes)...
set /a n=0
:wait
curl.exe -s -f -o nul "http://localhost:3000/api/v1/search/suggestions?q=a" && goto ready
set /a n+=1
if %n% geq 60 goto ready
timeout /t 2 >nul
goto wait

:ready
start "" http://localhost:8080
