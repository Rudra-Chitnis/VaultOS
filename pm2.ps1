param(
  [ValidateSet("start", "stop", "status", "restart", "logs")]
  [string]$Action = "status"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Pm2Home = Join-Path $Root ".pm2"

if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
  throw "PM2 was not found. Install it first with: npm install -g pm2"
}

if (-not (Test-Path -LiteralPath $Pm2Home)) {
  New-Item -ItemType Directory -Path $Pm2Home | Out-Null
}

[Environment]::SetEnvironmentVariable("PM2_HOME", $Pm2Home, "Process")
Set-Location $Root

switch ($Action) {
  "start"   { & pm2 start ecosystem.config.js }
  "stop"    { & pm2 stop ecosystem.config.js }
  "status"  { & pm2 status }
  "restart" { & pm2 restart all }
  "logs"    { & pm2 logs }
}

if ($LASTEXITCODE -ne 0) {
  throw "PM2 $Action failed."
}
