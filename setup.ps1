param(
  [string]$Password = "",
  [switch]$SkipPython,
  [switch]$SkipNode
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$FaceDir = Join-Path $Root "face_service"
$VenvDir = Join-Path $FaceDir "venv"

function Require-Command($Name, $InstallHint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name was not found. $InstallHint"
  }
}

function Invoke-Checked($FilePath, [string[]]$Arguments, $FailureMessage) {
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw $FailureMessage
  }
}

function Require-PythonVersion() {
  $versionCheck = "import sys; raise SystemExit(0 if sys.version_info[:2] in ((3, 10), (3, 11)) else 1)"
  & python -c $versionCheck
  if ($LASTEXITCODE -ne 0) {
    $actual = (& python --version 2>&1)
    throw "Unsupported Python version: $actual. Install Python 3.10 or 3.11 and make it the default 'python' before running setup."
  }
}

function Get-Sha256($Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join "")
}

Set-Location $Root

Write-Host "[setup] VaultOS setup in $Root"

if (-not $SkipNode) {
  Require-Command "node" "Install Node.js 20 LTS or newer: https://nodejs.org/"
  Require-Command "npm" "Install npm with Node.js."
  Write-Host "[setup] Node: $(node --version)"
  Write-Host "[setup] npm:  $(npm --version)"
}

if (-not $SkipPython) {
  Require-Command "python" "Install Python 3.10 or 3.11: https://python.org/"
  Write-Host "[setup] Python: $(python --version)"
  Require-PythonVersion
}

foreach ($dir in @("media", "media\.thumbs", "media\.face-thumbs")) {
  $full = Join-Path $Root $dir
  if (-not (Test-Path -LiteralPath $full)) {
    New-Item -ItemType Directory -Path $full | Out-Null
    Write-Host "[setup] Created $dir"
  }
}

$envPath = Join-Path $Root ".env"
$envExample = Join-Path $Root ".env.example"
if (-not (Test-Path -LiteralPath $envPath)) {
  Copy-Item -LiteralPath $envExample -Destination $envPath
  Write-Host "[setup] Created .env from .env.example"
}

$envText = Get-Content -LiteralPath $envPath -Raw
if ($envText -match "PASS_HASH=(replace_with_sha256_password_hash|your_sha256_hash_here)?\s*(\r?\n|$)") {
  if (-not $Password) {
    $secure = Read-Host "Choose a VaultOS login password" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $Password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  }
  if (-not $Password) { throw "A password is required to generate PASS_HASH." }
  $hash = Get-Sha256 $Password
  $envText = $envText -replace "PASS_HASH=.*", "PASS_HASH=$hash"
  Set-Content -LiteralPath $envPath -Value $envText -NoNewline
  Write-Host "[setup] Wrote PASS_HASH to .env"
}

if (-not $SkipNode) {
  if (Test-Path -LiteralPath (Join-Path $Root "package-lock.json")) {
    Write-Host "[setup] Installing Node dependencies with npm ci"
    Invoke-Checked "npm" @("ci") "npm ci failed."
  } else {
    Write-Host "[setup] Installing Node dependencies with npm install"
    Invoke-Checked "npm" @("install") "npm install failed."
  }
}

if (-not $SkipPython) {
  if (-not (Test-Path -LiteralPath (Join-Path $VenvDir "Scripts\python.exe"))) {
    Write-Host "[setup] Creating Python virtual environment"
    python -m venv $VenvDir
  }
  $VenvPython = Join-Path $VenvDir "Scripts\python.exe"
  Write-Host "[setup] Installing Python dependencies"
  Invoke-Checked $VenvPython @("-m", "pip", "install", "--upgrade", "pip") "pip upgrade failed."
  Invoke-Checked $VenvPython @("-m", "pip", "install", "-r", (Join-Path $FaceDir "requirements.txt")) "Python dependency installation failed."
}

if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
  Write-Host "[setup] FFmpeg found on PATH"
} else {
  Write-Warning "FFmpeg was not found on PATH. Install it for video thumbnails and video face scanning."
  Write-Warning "Windows: winget install Gyan.FFmpeg"
}

Write-Host ""
Write-Host "[setup] Done. Start VaultOS with:"
Write-Host "  .\start.ps1"
