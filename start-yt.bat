@echo off
rem Starts the whole stack on demand (guide section 11.2):
rem   1. hidden WSL session that runs the containers and keeps the VM alive
rem   2. UI backend on http://localhost:8080 (MyTube.exe --server, no window)
rem   3. opens the browser once Invidious answers
cd /d "%~dp0"

rem the newest build wins: cargo's output, then build-exe.bat's, then the prebuilt copy
set "EXE=%~dp0release\MyTube.exe"
if exist "%~dp0dist\MyTube.exe" set "EXE=%~dp0dist\MyTube.exe"
if exist "%~dp0target\release\MyTube.exe" set "EXE=%~dp0target\release\MyTube.exe"

curl.exe -s -f -o nul "http://localhost:3000/api/v1/search/suggestions?q=a" && goto invidious_up
start "yt-wsl" /min wsl -d Ubuntu-24.04 -- bash -lc "until docker info >/dev/null 2>&1; do sleep 0.2; done; cd ~/invidious && docker compose up -d && exec sleep infinity"
:invidious_up

curl.exe -s -f -o nul "http://localhost:8080/config.json" && goto ui_up
start "" "%EXE%" --server
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
