"""Build dist/MyTube.exe with PyInstaller (run through build-exe.bat).

Conda-based Pythons keep libffi outside the interpreter folder, so PyInstaller misses it and the exe
dies with "DLL load failed while importing _ctypes". This script finds those DLLs and bundles them.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
prefix = Path(sys.base_prefix)

extra = []
for folder in (prefix / "Library" / "bin", prefix / "DLLs", prefix):
    for dll in folder.glob("*ffi*.dll"):
        extra += ["--add-binary", f"{dll};."]

cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--windowed",
       "--name", "MyTube", "--icon", str(ROOT / "assets" / "mytube.ico"),
       "--add-data", f"{ROOT / 'web'};web", *extra,
       "--distpath", str(ROOT / "dist"), "--workpath", str(ROOT / "build"), "--specpath", str(ROOT / "build"),
       str(ROOT / "launcher.py")]
print("bundling:", [Path(a.split(";")[0]).name for a in extra[1::2]] or "no extra DLLs needed")
sys.exit(subprocess.call(cmd))
