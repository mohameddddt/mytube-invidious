@echo off
rem Builds dist\MyTube-Setup-<version>.exe, signed with the My Tube certificate (see tools\make_cert.ps1).
cd /d "%~dp0"
python -m pip show pyinstaller >nul 2>&1 || python -m pip install pyinstaller
python -m pip show pillow >nul 2>&1 || python -m pip install pillow
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\build_installer.ps1"
if errorlevel 1 (
  echo.
  echo Build failed.
  exit /b 1
)
