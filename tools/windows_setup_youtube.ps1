param(
    [string]$ClientSecretJson = "$env:USERPROFILE\Downloads\client_secret.json"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

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

if (-not (Test-Path -LiteralPath $ClientSecretJson)) {
    throw "OAuth client JSON not found: $ClientSecretJson`nDownload the Desktop OAuth client JSON from Google Cloud and save it there, or pass -ClientSecretJson with the correct path."
}

Write-Host "=== The Business Flow YouTube OAuth Setup ===" -ForegroundColor Cyan
Write-Host "Repository: thebusinessflowtv/thebusinessflow" -ForegroundColor DarkGray
Write-Host "OAuth JSON: $ClientSecretJson" -ForegroundColor DarkGray
Write-Host "Installing/checking YouTube dependencies..." -ForegroundColor Yellow
Invoke-Python -m pip install -r (Join-Path $RepoRoot "youtube-worker\requirements.txt")

Write-Host ""
Write-Host "A browser will open." -ForegroundColor Yellow
Write-Host "SIGN IN ONLY with the Google account that owns the The Business Flow YouTube channel." -ForegroundColor Yellow
Write-Host ""
Invoke-Python (Join-Path $RepoRoot "youtube-worker\setup_oauth.py") $ClientSecretJson

Write-Host ""
Write-Host "Next: add the four printed values to GitHub > thebusinessflowtv/thebusinessflow > Settings > Secrets and variables > Actions." -ForegroundColor Green
