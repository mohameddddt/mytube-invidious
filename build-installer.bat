@echo off
rem Builds dist\MyTube-Setup-<version>.exe, signed with the My Tube certificate (see tools\make_cert.ps1).
rem Needs Rust (https://rustup.rs) and Inno Setup 6.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\build_installer.ps1"
if errorlevel 1 (
  echo.
  echo Build failed.
  exit /b 1
)
