# Creates (once) a self-signed code-signing certificate for My Tube.
#   - the private key stays in your Windows user certificate store and is not exportable
#   - the public certificate is written to assets\mytube-signing.cer
#   - unless -SkipTrust is given, it is trusted for the CURRENT USER only, so Windows shows the
#     signature as valid on this PC (Windows asks you to confirm adding it to Trusted Root)
param([switch]$SkipTrust)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$subject = "CN=My Tube, O=mohameddddt"

$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
    Where-Object { $_.Subject -eq $subject -and $_.NotAfter -gt (Get-Date).AddDays(30) } |
    Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $cert) {
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject `
        -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyUsage DigitalSignature `
        -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddYears(5) `
        -CertStoreLocation Cert:\CurrentUser\My
    "Created certificate $($cert.Thumbprint)"
} else {
    "Using existing certificate $($cert.Thumbprint)"
}

$cer = Join-Path $root "assets\mytube-signing.cer"
[void](Export-Certificate -Cert $cert -FilePath $cer -Force)
"Public certificate: $cer"
"SHA-1 thumbprint : $($cert.Thumbprint)"
"Valid until      : $($cert.NotAfter)"

if (-not $SkipTrust) {
    foreach ($store in "TrustedPublisher", "Root") {
        $already = Get-ChildItem "Cert:\CurrentUser\$store" | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
        if (-not $already) {
            "Trusting it in CurrentUser\$store (confirm the Windows prompt if one appears)..."
            [void](Import-Certificate -FilePath $cer -CertStoreLocation "Cert:\CurrentUser\$store")
        }
    }
}
