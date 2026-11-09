@echo off
rem Builds dist\MyTube.exe: the launcher, the local server and the web interface in one file.
rem Needs Rust (https://rustup.rs, or: winget install Rustlang.Rustup).
cd /d "%~dp0"

where cargo >nul 2>&1 || (
  echo Rust is not installed. Get it from https://rustup.rs or run: winget install Rustlang.Rustup
  exit /b 1
)
cargo build --release
if errorlevel 1 (
  echo.
  echo Build failed.
  exit /b 1
)
if not exist dist mkdir dist
copy /y target\release\MyTube.exe dist\MyTube.exe >nul
echo.
echo Built: %~dp0dist\MyTube.exe
