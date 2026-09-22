param(
    [string]$ZipPath = "$env:USERPROFILE\Downloads\Company Vault.zip"
)

$ErrorActionPreference = "Stop"

Write-Host "=== The Business Flow Media Import (Windows) ===" -ForegroundColor Cyan

if (-not (Test-Path -LiteralPath $ZipPath)) {
    throw "ZIP not found: $ZipPath"
}

function Resolve-Python {
    if (Get-Command python -ErrorAction SilentlyContinue) {
        return @("python")
    }
    if (Get-Command py -ErrorAction SilentlyContinue) {
        return @("py", "-3")
    }
    throw "Python 3 was not found in PATH."
}

$Python = Resolve-Python

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    throw "ffmpeg was not found in PATH."
}
if (-not (Get-Command ffprobe -ErrorAction SilentlyContinue)) {
    throw "ffprobe was not found in PATH."
}

Write-Host "Installing/checking Python dependencies..." -ForegroundColor Yellow
& $Python[0] @($Python[1..($Python.Count-1)]) -m pip install --upgrade requests pillow
if ($LASTEXITCODE -ne 0) { throw "pip dependency install failed" }

$RepoRoot = Split-Path -Parent $PSScriptRoot
$OutputDir = Join-Path $RepoRoot "media-library\generated"
$BuildScript = Join-Path $RepoRoot "tools\build_media_catalog.py"
$UploadScript = Join-Path $RepoRoot "tools\upload_media_library.py"

Write-Host "Building catalog and organizing media..." -ForegroundColor Yellow
& $Python[0] @($Python[1..($Python.Count-1)]) $BuildScript $ZipPath --output-dir $OutputDir
if ($LASTEXITCODE -ne 0) { throw "Media catalog build failed" }

$env:SUPABASE_URL = "https://rhddgfvtrkmusbvphnlg.supabase.co"
$env:THEBUSINESSFLOW_MEDIA_BUCKET = "mediaforge-assets"
$env:THEBUSINESSFLOW_MEDIA_PREFIX = "thebusinessflow/media-library"

Write-Host ""
Write-Host "Paste the Supabase Secret Key. Input will stay hidden." -ForegroundColor Cyan
$SecureKey = Read-Host "SUPABASE_SECRET_KEY" -AsSecureString
$BSTR = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureKey)
try {
    $PlainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($BSTR)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)
}

if ([string]::IsNullOrWhiteSpace($PlainKey)) {
    throw "Supabase secret key was empty"
}

$env:SUPABASE_SECRET_KEY = $PlainKey

try {
    Write-Host "Uploading organized media to Supabase Storage..." -ForegroundColor Yellow
    & $Python[0] @($Python[1..($Python.Count-1)]) $UploadScript $OutputDir
    if ($LASTEXITCODE -ne 0) { throw "Media upload failed" }

    Write-Host ""
    Write-Host "=== DONE ===" -ForegroundColor Green
    Write-Host "The Business Flow media library is organized, cataloged and uploaded." -ForegroundColor Green
    Write-Host "Catalog: $OutputDir\catalog.json"
    Write-Host "Summary: $OutputDir\summary.json"
    Write-Host "Storage: mediaforge-assets/thebusinessflow/media-library/"
}
finally {
    Remove-Item Env:SUPABASE_SECRET_KEY -ErrorAction SilentlyContinue
    $PlainKey = $null
}
