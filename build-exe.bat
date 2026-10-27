@echo off
rem Builds dist\MyTube.exe: the launcher, the local server and the web interface in one file.
rem Needs Python 3 on PATH. PyInstaller and Pillow are installed on first use.
cd /d "%~dp0"

python -m pip show pyinstaller >nul 2>&1 || python -m pip install pyinstaller
python -m pip show pillow >nul 2>&1 || python -m pip install pillow
if not exist "assets\mytube.ico" python tools\make_icon.py

python tools\build_exe.py
if errorlevel 1 (
  echo.
  echo Build failed.
  exit /b 1
)
echo.
echo Built: %~dp0dist\MyTube.exe
