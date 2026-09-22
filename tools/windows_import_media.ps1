param(
    [string]$ZipPath = "$env:USERPROFILE\Downloads\Company Vault.zip",
    [switch]$PublishOnly
)

$ErrorActionPreference = "Stop"

$ExpectedRemote = "https://github.com/thebusinessflowtv/thebusinessflow.git"
$GitUserName = "The Business Flow"
$GitUserEmail = "thebusinessflowtv@gmail.com"

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

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)
    & git @Args
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Args -join ' ') failed with exit code $LASTEXITCODE"
    }
}

$Python = Resolve-PythonCommand
$RepoRoot = Split-Path -Parent $PSScriptRoot
$OutputDir = Join-Path $RepoRoot "media-library\generated"
$BuildScript = Join-Path $RepoRoot "tools\build_media_catalog.py"
$PublishScript = Join-Path $RepoRoot "tools\publish_media_to_github.py"

Assert-Command "git"

Push-Location $RepoRoot
try {
    $InsideWorkTree = (& git rev-parse --is-inside-work-tree 2>$null)
    if ($LASTEXITCODE -ne 0 -or $InsideWorkTree.Trim() -ne "true") {
        throw "This folder is not a Git repository: $RepoRoot"
    }

    $Origin = (& git remote get-url origin 2>$null)
    if ($LASTEXITCODE -ne 0) {
        throw "Git remote 'origin' is missing."
    }
    $NormalizedOrigin = $Origin.Trim().TrimEnd('/')
    $AllowedOrigins = @(
        "https://github.com/thebusinessflowtv/thebusinessflow.git",
        "https://github.com/thebusinessflowtv/thebusinessflow",
        "git@github.com:thebusinessflowtv/thebusinessflow.git"
    )
    if ($AllowedOrigins -notcontains $NormalizedOrigin) {
        throw "Refusing to publish to unexpected Git remote: $Origin"
    }

    # Keep identity local to this repository. This prevents 'Author identity unknown'
    # on fresh Windows/Dell installations without changing the user's global Git config.
    Invoke-Git config user.name $GitUserName
    Invoke-Git config user.email $GitUserEmail
    Write-Host "Git identity configured locally: $GitUserName <$GitUserEmail>" -ForegroundColor DarkGray

    # A previous run may already have staged hundreds of LFS files before a commit error.
    # Pull only when the working tree/index is clean so reruns resume instead of failing.
    $ExistingChanges = @(& git status --porcelain)
    if ($ExistingChanges.Count -eq 0) {
        Write-Host "Synchronizing thebusinessflowtv/thebusinessflow..." -ForegroundColor Yellow
        Invoke-Git pull --rebase origin main
    } else {
        Write-Host "Local/staged media changes already exist; skipping pull and resuming publish safely." -ForegroundColor DarkYellow
    }
} finally {
    Pop-Location
}

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
    Write-Host "PublishOnly mode: reusing the already-generated catalog and organized assets." -ForegroundColor DarkGray
}

Write-Host "Checking Git LFS..." -ForegroundColor Yellow
& git lfs version
if ($LASTEXITCODE -ne 0) {
    throw "Git LFS is not installed. Install Git LFS on the Dell, then rerun this command."
}

Write-Host "Preparing GitHub-only media library..." -ForegroundColor Yellow
Invoke-Python $PublishScript $OutputDir --repo-root $RepoRoot

Push-Location $RepoRoot
try {
    Invoke-Git lfs install --local

    Write-Host "Staging catalog + Git LFS assets..." -ForegroundColor Yellow
    Invoke-Git add .gitattributes media-library/catalog.json media-library/summary.json media-library/assets

    $Pending = @(& git status --porcelain)
    if ($Pending.Count -eq 0) {
        Write-Host "Nothing new to commit. The GitHub media library is already up to date." -ForegroundColor Green
    } else {
        Write-Host "Creating media-library commit..." -ForegroundColor Yellow
        Invoke-Git commit -m "Add The Business Flow reusable media library"

        Write-Host "Uploading media directly to thebusinessflowtv/thebusinessflow via Git LFS..." -ForegroundColor Yellow
        Invoke-Git push origin HEAD:main
    }

    Write-Host ""
    Write-Host "=== DONE ===" -ForegroundColor Green
    Write-Host "The Business Flow media library is now stored only in GitHub." -ForegroundColor Green
    Write-Host "Repository: thebusinessflowtv/thebusinessflow"
    Write-Host "Assets: media-library/assets/ (Git LFS)"
    Write-Host "Catalog: media-library/catalog.json"
} finally {
    Pop-Location
}
