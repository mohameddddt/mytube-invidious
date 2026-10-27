# Builds the signed installer:  dist\MyTube-Setup-<version>.exe  (+ SHA256SUMS.txt)
#   1. PyInstaller builds build\exe\MyTube.exe      2. sign it       3. Inno Setup builds the installer
#   4. sign the installer                       5. write checksums
$ErrorActionPreference = "Continue"  # native tools log to stderr; failures are caught through exit codes below
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$version = (Get-Content (Join-Path $root "VERSION") -Raw).Trim()

$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
          "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
          "$env:ProgramFiles\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup 6 not found. Install it with: winget install JRSoftware.InnoSetup --scope user" }

"== 1/5 building MyTube.exe ($version)"
New-Item -ItemType Directory -Force dist | Out-Null
python tools\build_exe.py (Join-Path $root "build\exe")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

"== 2/5 signing MyTube.exe"
& "$PSScriptRoot\sign.ps1" "build\exe\MyTube.exe"
if ($LASTEXITCODE -ne 0) { throw "Signing failed" }

"== 3/5 building the installer"
& $iscc "/DAppVersion=$version" "/Qp" "installer\mytube.iss"
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed" }
$setup = "dist\MyTube-Setup-$version.exe"

"== 4/5 signing the installer"
& "$PSScriptRoot\sign.ps1" $setup
if ($LASTEXITCODE -ne 0) { throw "Signing failed" }

"== 5/5 checksums"
$files = @($setup, "assets\mytube-signing.cer")
$lines = foreach ($f in $files) { "{0}  {1}" -f (Get-FileHash $f -Algorithm SHA256).Hash.ToLower(), (Split-Path $f -Leaf) }
Set-Content -Path "dist\SHA256SUMS.txt" -Value $lines -Encoding ascii
$lines
""
"Done: $((Resolve-Path $setup).Path)  ({0:N1} MB)" -f ((Get-Item $setup).Length / 1MB)
