"""Write build/version_info.txt (the Windows file-properties block) from the VERSION file."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
nums = [int(x) for x in version.split(".")[:3]] + [0] * (4 - len(version.split(".")[:3]))
tup = tuple(nums[:4])
text = f"""VSVersionInfo(
  ffi=FixedFileInfo(filevers={tup}, prodvers={tup}, mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable('040904B0', [
      StringStruct('CompanyName', 'mohameddddt'),
      StringStruct('FileDescription', 'My Tube - personal YouTube interface'),
      StringStruct('FileVersion', '{version}'),
      StringStruct('InternalName', 'MyTube'),
      StringStruct('LegalCopyright', 'Personal project. Not affiliated with YouTube or Google.'),
      StringStruct('OriginalFilename', 'MyTube.exe'),
      StringStruct('ProductName', 'My Tube'),
      StringStruct('ProductVersion', '{version}')])]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
"""
out = ROOT / "tools" / "version_info.generated.txt"
out.parent.mkdir(exist_ok=True)
out.write_text(text, encoding="utf-8")
print("version", version, "->", out)
