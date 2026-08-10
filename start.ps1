param(
  [switch]$NoAI
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$FaceDir = Join-Path $Root "face_service"
$VenvPython = Join-Path $FaceDir "venv\Scripts\python.exe"
$EnvPath = Join-Path $Root ".env"

function Read-DotEnv($Path) {
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or $line -notmatch "=") { return }
    $parts = $line.Split("=", 2)
    $map[$parts[0].Trim()] = $parts[1].Trim().Trim('"').Trim("'")
  }
  $map
}

function Get-FaceEndpoint($Config) {
  $url = $Config["FACE_SERVICE_URL"]
  if (-not $url) {
    $hostName = $Config["FACE_SERVICE_HOST"]
    $port = $Config["FACE_SERVICE_PORT"]
    if (-not $hostName) { $hostName = "127.0.0.1" }
    if (-not $port) { $port = "7860" }
    $url = "http://${hostName}:${port}"
  }
  [Uri]$url
}

Set-Location $Root
$config = Read-DotEnv $EnvPath
foreach ($key in $config.Keys) {
  [Environment]::SetEnvironmentVariable($key, $config[$key], "Process")
}

$aiProcess = $null
try {
  if (-not $NoAI) {
    if (-not (Test-Path -LiteralPath $VenvPython)) {
      throw "Python virtualenv not found at $VenvPython. Run .\setup.ps1 first."
    }

    $endpoint = Get-FaceEndpoint $config
    $hostName = $endpoint.Host
    $port = $endpoint.Port
    Write-Host "[start] Starting face AI service at $($endpoint.AbsoluteUri.TrimEnd('/'))"
    $aiProcess = Start-Process -FilePath $VenvPython `
      -ArgumentList @("-m", "uvicorn", "face_service.main:app", "--host", $hostName, "--port", "$port", "--workers", "1", "--log-level", "info") `
      -WorkingDirectory $Root `
      -PassThru `
      -WindowStyle Hidden

    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
      Start-Sleep -Seconds 2
      try {
        $health = Invoke-RestMethod -Uri "$($endpoint.AbsoluteUri.TrimEnd('/'))/health" -TimeoutSec 5
        if ($health.ready) { $ready = $true; break }
      } catch {}
    }
    if (-not $ready) {
      Write-Warning "Face AI service did not report ready yet. Node will still start; the worker will retry."
    }
  }

  Write-Host "[start] Starting Node service"
  npm start
  if ($LASTEXITCODE -ne 0) {
    throw "Node service exited with code $LASTEXITCODE."
  }
} finally {
  if ($aiProcess -and -not $aiProcess.HasExited) {
    Write-Host "[start] Stopping face AI service"
    Stop-Process -Id $aiProcess.Id -Force -ErrorAction SilentlyContinue
  }
}
