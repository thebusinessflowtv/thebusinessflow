param(
    [string]$ZipPath = "$env:USERPROFILE\Downloads\Company Vault.zip"
)

$ErrorActionPreference = "Stop"

Write-Host "=== The Business Flow Media Import (Windows) ===" -ForegroundColor Cyan

if (-not (Test-Path -LiteralPath $ZipPath)) {
    throw "ZIP not found: $ZipPath"
}

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

Write-Host "Installing/checking Python dependencies..." -ForegroundColor Yellow
Invoke-Python -m pip install --upgrade requests pillow

$RepoRoot = Split-Path -Parent $PSScriptRoot
$OutputDir = Join-Path $RepoRoot "media-library\generated"
$BuildScript = Join-Path $RepoRoot "tools\build_media_catalog.py"
$UploadScript = Join-Path $RepoRoot "tools\upload_media_library.py"

Write-Host "Building catalog and organizing media..." -ForegroundColor Yellow
Invoke-Python $BuildScript $ZipPath --output-dir $OutputDir

$env:SUPABASE_URL = "https://rhddgfvtrkmusbvphnlg.supabase.co"
$env:THEBUSINESSFLOW_MEDIA_BUCKET = "mediaforge-assets"
$env:THEBUSINESSFLOW_MEDIA_PREFIX = "thebusinessflow/media-library"

$ExistingKey = $env:SUPABASE_SECRET_KEY
if ([string]::IsNullOrWhiteSpace($ExistingKey)) {
    $ExistingKey = $env:SUPABASE_SERVICE_ROLE_KEY
}

$PromptedForKey = $false
if ([string]::IsNullOrWhiteSpace($ExistingKey)) {
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
    $PromptedForKey = $true
} else {
    $env:SUPABASE_SECRET_KEY = $ExistingKey
    Write-Host "Using Supabase key already configured on this computer." -ForegroundColor DarkGray
}

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
    if ($PromptedForKey) {
        Remove-Item Env:SUPABASE_SECRET_KEY -ErrorAction SilentlyContinue
        $PlainKey = $null
    }
}
