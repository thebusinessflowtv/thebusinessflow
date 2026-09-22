param(
    [string]$ZipPath = "$env:USERPROFILE\Downloads\Company Vault.zip",
    [switch]$UploadOnly
)

$ErrorActionPreference = "Stop"

Write-Host "=== The Business Flow Media Import (Windows) ===" -ForegroundColor Cyan

function Resolve-PythonCommand {
    if (Get-Command python -ErrorAction SilentlyContinue) {
        return @{ Exe = "python"; Prefix = @() }
    }
    if (Get-Command py -ErrorAction SilentlyContinue) {
        return @{ Exe = "py"; Prefix = @("-3") }
    }
    throw "Python 3 was not found in PATH."
}

function Invoke-Python {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)
    & $script:Python.Exe @($script:Python.Prefix) @Args
    if ($LASTEXITCODE -ne 0) {
        throw "Python command failed with exit code $LASTEXITCODE"
    }
}

$Python = Resolve-PythonCommand
$RepoRoot = Split-Path -Parent $PSScriptRoot
$OutputDir = Join-Path $RepoRoot "media-library\generated"
$BuildScript = Join-Path $RepoRoot "tools\build_media_catalog.py"
$UploadScript = Join-Path $RepoRoot "tools\upload_media_library.py"

Write-Host "Installing/checking Python dependencies..." -ForegroundColor Yellow
Invoke-Python -m pip install --upgrade "requests==2.34.2" "pillow==12.3.0" "supabase==2.31.0"

if (-not $UploadOnly) {
    if (-not (Test-Path -LiteralPath $ZipPath)) {
        throw "ZIP not found: $ZipPath"
    }
    if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
        throw "ffmpeg was not found in PATH."
    }
    if (-not (Get-Command ffprobe -ErrorAction SilentlyContinue)) {
        throw "ffprobe was not found in PATH."
    }

    Write-Host "Python:" -ForegroundColor DarkGray
    Invoke-Python --version
    Write-Host "FFmpeg:" -ForegroundColor DarkGray
    ffmpeg -version | Select-Object -First 1

    Write-Host "Building catalog and organizing media..." -ForegroundColor Yellow
    Invoke-Python $BuildScript $ZipPath --output-dir $OutputDir
} else {
    if (-not (Test-Path -LiteralPath (Join-Path $OutputDir "catalog.json"))) {
        throw "UploadOnly requested, but generated catalog was not found at $OutputDir"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $OutputDir "organized"))) {
        throw "UploadOnly requested, but organized media folder was not found at $OutputDir"
    }
    Write-Host "UploadOnly mode: reusing the already-generated catalog and organized media." -ForegroundColor DarkGray
}

$env:SUPABASE_URL = "https://rhddgfvtrkmusbvphnlg.supabase.co"
$env:THEBUSINESSFLOW_MEDIA_BUCKET = "mediaforge-assets"
$env:THEBUSINESSFLOW_MEDIA_PREFIX = "thebusinessflow/media-library"

# Avoid accidentally reusing a stale/wrong legacy key from an earlier attempt.
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Use the modern Secret key from THIS exact Supabase project:" -ForegroundColor Cyan
Write-Host "Portal Leonidanos - project ref rhddgfvtrkmusbvphnlg" -ForegroundColor Cyan
Write-Host "Supabase > Settings > API Keys > Secret keys" -ForegroundColor Cyan
Write-Host "The key should start with sb_secret_." -ForegroundColor Yellow
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
if (-not $PlainKey.StartsWith("sb_secret_")) {
    throw "Expected a modern sb_secret_* key from project rhddgfvtrkmusbvphnlg."
}
$env:SUPABASE_SECRET_KEY = $PlainKey

try {
    Write-Host "Uploading organized media to Supabase Storage..." -ForegroundColor Yellow
    Invoke-Python $UploadScript $OutputDir

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
