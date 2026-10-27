"""Build dist/MyTube.exe with PyInstaller (run through build-exe.bat).

Conda-based Pythons keep libffi outside the interpreter folder, so PyInstaller misses it and the exe
dies with "DLL load failed while importing _ctypes". This script finds those DLLs and bundles them.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "dist"  # where MyTube.exe is written
prefix = Path(sys.base_prefix)

extra = []
for folder in (prefix / "Library" / "bin", prefix / "DLLs", prefix):
    for dll in folder.glob("*ffi*.dll"):
        extra += ["--add-binary", f"{dll};."]

subprocess.check_call([sys.executable, str(ROOT / "tools" / "make_version_info.py")])

cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--windowed",
       "--name", "MyTube", "--icon", str(ROOT / "assets" / "mytube.ico"),
       "--add-data", f"{ROOT / 'web'};web", "--add-data", f"{ROOT / 'VERSION'};.",
       "--version-file", str(ROOT / "tools" / "version_info.generated.txt"), *extra,
       "--distpath", str(OUT), "--workpath", str(ROOT / "build"), "--specpath", str(ROOT / "build"),
       str(ROOT / "launcher.py")]
print("bundling:", [Path(a.split(";")[0]).name for a in extra[1::2]] or "no extra DLLs needed")
sys.exit(subprocess.call(cmd))
