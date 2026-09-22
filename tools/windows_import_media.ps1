param(
    [string]$ZipPath = "$env:USERPROFILE\Downloads\Company Vault.zip",
    [switch]$PublishOnly
)

$ErrorActionPreference = "Stop"

Write-Host "=== The Business Flow Media Import -> GitHub LFS ===" -ForegroundColor Cyan

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

function Assert-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name was not found in PATH."
    }
}

$Python = Resolve-PythonCommand
$RepoRoot = Split-Path -Parent $PSScriptRoot
$OutputDir = Join-Path $RepoRoot "media-library\generated"
$BuildScript = Join-Path $RepoRoot "tools\build_media_catalog.py"
$PublishScript = Join-Path $RepoRoot "tools\publish_media_to_github.py"

Assert-Command "git"

Write-Host "Installing/checking Python dependencies..." -ForegroundColor Yellow
Invoke-Python -m pip install --upgrade "pillow==12.3.0"

if (-not $PublishOnly) {
    if (-not (Test-Path -LiteralPath $ZipPath)) {
        throw "ZIP not found: $ZipPath"
    }
    Assert-Command "ffmpeg"
    Assert-Command "ffprobe"

    Write-Host "Python:" -ForegroundColor DarkGray
    Invoke-Python --version
    Write-Host "FFmpeg:" -ForegroundColor DarkGray
    ffmpeg -version | Select-Object -First 1

    Write-Host "Building catalog and organizing media..." -ForegroundColor Yellow
    Invoke-Python $BuildScript $ZipPath --output-dir $OutputDir
} else {
    if (-not (Test-Path -LiteralPath (Join-Path $OutputDir "catalog.json"))) {
        throw "PublishOnly requested, but generated catalog was not found at $OutputDir"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $OutputDir "organized"))) {
        throw "PublishOnly requested, but organized media folder was not found at $OutputDir"
    }
    Write-Host "PublishOnly mode: reusing the already-generated catalog and 221 organized assets." -ForegroundColor DarkGray
}

Write-Host "Preparing GitHub-only media library..." -ForegroundColor Yellow
Invoke-Python $PublishScript $OutputDir --repo-root $RepoRoot

Write-Host "Checking Git LFS..." -ForegroundColor Yellow
& git lfs version
if ($LASTEXITCODE -ne 0) {
    throw "Git LFS is not installed. Install Git LFS on the Dell, then rerun this command."
}

Push-Location $RepoRoot
try {
    git lfs install --local
    if ($LASTEXITCODE -ne 0) { throw "git lfs install failed" }

    # Make sure the local checkout has the newest text configuration before pushing binaries.
    git pull --rebase origin main
    if ($LASTEXITCODE -ne 0) { throw "git pull --rebase failed" }

    Write-Host "Staging catalog + Git LFS assets..." -ForegroundColor Yellow
    git add .gitattributes media-library/catalog.json media-library/summary.json media-library/assets
    if ($LASTEXITCODE -ne 0) { throw "git add failed" }

    $Pending = git status --porcelain
    if ([string]::IsNullOrWhiteSpace(($Pending -join ""))) {
        Write-Host "Nothing new to commit. The GitHub media library is already up to date." -ForegroundColor Green
    } else {
        git commit -m "Add The Business Flow reusable media library"
        if ($LASTEXITCODE -ne 0) { throw "git commit failed" }

        Write-Host "Uploading media directly to thebusinessflowtv/thebusinessflow via Git LFS..." -ForegroundColor Yellow
        git push origin main
        if ($LASTEXITCODE -ne 0) { throw "git push failed" }
    }

    Write-Host ""
    Write-Host "=== DONE ===" -ForegroundColor Green
    Write-Host "The Business Flow media library is now stored only in GitHub." -ForegroundColor Green
    Write-Host "Repository: thebusinessflowtv/thebusinessflow"
    Write-Host "Assets: media-library/assets/ (Git LFS)"
    Write-Host "Catalog: media-library/catalog.json"
}
finally {
    Pop-Location
}
