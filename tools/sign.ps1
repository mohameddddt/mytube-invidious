# Signs files with the My Tube code-signing certificate (see make_cert.ps1). Skips quietly if there is none.
# After signing it re-reads each file and fails if no signature is actually attached.
param([Parameter(Mandatory, Position = 0)][string[]]$Path)
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
    Where-Object { $_.Subject -like "CN=My Tube*" -and $_.NotAfter -gt (Get-Date) } |
    Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $cert) {
    Write-Warning "No My Tube signing certificate found; run tools\make_cert.ps1. Leaving the file(s) unsigned."
    exit 0
}
$failed = $false
foreach ($p in $Path) {
    # A timestamp keeps the signature valid after the certificate expires; fall back if the server is unreachable.
    foreach ($stamp in "http://timestamp.digicert.com", $null) {
        $args2 = @{ FilePath = $p; Certificate = $cert; HashAlgorithm = "SHA256"; ErrorAction = "SilentlyContinue" }
        if ($stamp) { $args2.TimestampServer = $stamp }
        [void](Set-AuthenticodeSignature @args2)
        $sig = Get-AuthenticodeSignature $p
        if ($sig.SignerCertificate -and $sig.SignerCertificate.Thumbprint -eq $cert.Thumbprint) { break }
        Write-Warning "Signing $p ($(if ($stamp) { 'with timestamp' } else { 'without timestamp' })) did not attach a signature; retrying."
    }
    if (-not $sig.SignerCertificate) { Write-Error "Could not sign $p"; $failed = $true; continue }
    $ts = if ($sig.TimeStamperCertificate) { "timestamped" } else { "no timestamp" }
    # "UnknownError" just means the certificate is self-signed and not trusted on this PC: the signature is attached.
    "{0,-12} {1}  ({2}, signer {3})" -f $sig.Status, $p, $ts, $sig.SignerCertificate.Subject
}
if ($failed) { exit 1 }
