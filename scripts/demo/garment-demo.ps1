<#
.SYNOPSIS
  The Ethnic Threads demo: TMS in Docker as the support desk of a shop that
  runs on this machine (the garment-web-scraper repository; ADR 0027, 0028).

.DESCRIPTION
  start       Everything in one go: starts the demo stack, then the shop's server
              and its site, each in its own window (skipped when already running).
              -Rebuild builds the stack again from the code first (data is kept).
              -Load runs "load" before the shop starts.
  stop        Stops the shop's server and site and the demo stack, keeping its data.
  up          Builds and starts the demo stack (its own project, ports and database).
  load        Sets TMS up for Ethnic Threads and writes the shop's .env.
              -Llm scripted uses the scripted model (no key); the default leaves
              the model to you: add one under Settings > Providers and Models,
              then run load again to load the knowledge base.
              -Rekey makes new API keys and secrets for an existing setup.
  shop        Runs the shop's server (port 8765). -StepSeconds is how long an
              order stays at each step (default 20).
  storefront  Runs the shop's site (http://localhost:5173).
  status      Shows what is running and where.
  reset       Stops the stack and deletes its database, the shop's database and
              the shop's record of webhook events. The default TMS stack is not touched.
  down        Stops the stack, keeping its data.

  The walk-through is docs/runbooks/phase-14b-shop-demo.md.

.EXAMPLE
  ./scripts/demo/garment-demo.ps1 start
  ./scripts/demo/garment-demo.ps1 start -Rebuild -Load
  ./scripts/demo/garment-demo.ps1 stop
  ./scripts/demo/garment-demo.ps1 up
  ./scripts/demo/garment-demo.ps1 load -Llm scripted
  ./scripts/demo/garment-demo.ps1 shop
  ./scripts/demo/garment-demo.ps1 storefront
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'up', 'load', 'shop', 'storefront', 'status', 'reset', 'down')]
  [string]$Command = 'status',
  [ValidateSet('none', 'scripted')]
  [string]$Llm = 'none',
  [switch]$Rekey,
  # With "start": build the stack again from the code, and run "load".
  [switch]$Rebuild,
  [switch]$Load,
  [int]$StepSeconds = 20,
  # The garment-web-scraper clone; by default the folder next to this repository.
  [string]$GarmentDir = $env:GARMENT_DIR
)

$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $GarmentDir) { $GarmentDir = Join-Path (Split-Path $Repo -Parent) 'garment-web-scraper' }

$ApiUrl = 'http://localhost:3200'
$WidgetUrl = 'http://localhost:8090'
$ShopUrl = 'http://localhost:8765/api/health'
$StorefrontUrl = 'http://localhost:5173/'
$Compose = @(
  'compose',
  '-f', (Join-Path $Repo 'infra\docker-compose.yml'),
  '-f', (Join-Path $Repo 'infra\docker-compose.garment.yml'),
  '--profile', 'app'
)

# Runs a program whose progress goes to stderr (docker, git). Windows PowerShell turns
# redirected stderr into errors, which must not stop the script: the exit code decides.
function Invoke-Tool {
  $exe = $args[0]
  $rest = @($args | Select-Object -Skip 1)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $exe @rest
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($LASTEXITCODE -ne 0) { throw "$exe $($rest -join ' ') failed with exit code $LASTEXITCODE" }
}

function Assert-Garment {
  if (-not (Test-Path (Join-Path $GarmentDir 'shop\server.py'))) {
    throw "The shop was not found at $GarmentDir (branch feat/shop of garment-web-scraper). Pass -GarmentDir or set GARMENT_DIR."
  }
}

function Test-Url([string]$Url) {
  try {
    $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
    return $true
  } catch {
    return $false
  }
}

function Show-Status {
  $rows = @(
    @{ Name = 'TMS API'; Url = "$ApiUrl/api/v1/health/live"; Open = "$ApiUrl/docs" },
    @{ Name = 'Orbit Desk'; Url = 'http://localhost:8091/'; Open = 'http://localhost:8091' },
    @{ Name = 'Chat widget'; Url = "$WidgetUrl/widget/tms-chat.js"; Open = "$WidgetUrl/widget/tms-chat.js" },
    @{ Name = 'Shop server'; Url = $ShopUrl; Open = $ShopUrl },
    @{ Name = 'Storefront'; Url = $StorefrontUrl; Open = 'http://localhost:5173' }
  )
  foreach ($row in $rows) {
    $state = 'down'
    if (Test-Url $row.Url) { $state = 'up  ' }
    Write-Host ("{0,-12} {1}  {2}" -f $row.Name, $state, $row.Open)
  }
}

function Wait-Url([string]$Url, [string]$What, [int]$Minutes = 5) {
  $deadline = (Get-Date).AddMinutes($Minutes)
  while (-not (Test-Url $Url)) {
    if ((Get-Date) -gt $deadline) { throw "$What did not come up at $Url" }
    Start-Sleep -Seconds 3
  }
}

function Start-Stack([switch]$Build) {
  if ($Build) {
    Invoke-Tool docker @Compose up -d --build
  } else {
    Invoke-Tool docker @Compose up -d
  }
  Write-Host 'Waiting for the API...'
  Wait-Url "$ApiUrl/api/v1/health/live" 'The API'
}

function Invoke-Load {
  Assert-Garment
  $env:API_URL = $ApiUrl
  $env:WIDGET_URL = $WidgetUrl
  # Passed through the environment: a Windows path does not survive pnpm's argument quoting.
  $env:GARMENT_ENV = Join-Path $GarmentDir '.env'
  $env:GARMENT_LLM = $Llm
  $env:GARMENT_REKEY = ''
  if ($Rekey) { $env:GARMENT_REKEY = '1' }
  Push-Location $Repo
  try {
    # The loader reads the shared packages as they were last built on this machine.
    Invoke-Tool pnpm --filter '@tms/shared' --filter '@tms/db' --filter '@tms/sdk' build
    Invoke-Tool pnpm garment:load
  } finally {
    Pop-Location
  }
}

# Runs one of this script's long-running commands in a window of its own, which stays
# open so its output (and a failure) can be read.
function Start-InWindow([string]$Name) {
  $run = "-NoExit -ExecutionPolicy Bypass -File `"$PSCommandPath`" $Name -StepSeconds $StepSeconds -GarmentDir `"$GarmentDir`""
  Start-Process powershell -ArgumentList $run | Out-Null
}

# Stops whatever of ours listens on a port. Only python and node are touched: another
# program that happens to use the port is left alone and named.
function Stop-OnPort([int]$Port, [string]$What) {
  $owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique)
  if (-not $owners.Count) {
    Write-Host "$What was not running."
    return
  }
  foreach ($id in $owners) {
    $process = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    if ($process.ProcessName -notmatch '^(python|pythonw|py|node)') {
      Write-Host "Port $Port is used by $($process.ProcessName), which is not $What. Left running."
      continue
    }
    Stop-Process -Id $id -Force -Confirm:$false
    Write-Host "$What stopped."
  }
}

switch ($Command) {
  'start' {
    Assert-Garment
    Start-Stack -Build:$Rebuild
    $shopWasUp = Test-Url $ShopUrl
    if ($Load) { Invoke-Load }
    if ($shopWasUp) {
      Write-Host 'The shop server is already running.'
      if ($Load) { Write-Host 'Restart it (Ctrl+C in its window, then "start" again) so it reads the new settings.' }
    } else {
      Start-InWindow 'shop'
    }
    if (Test-Url $StorefrontUrl) {
      Write-Host 'The storefront is already running.'
    } else {
      Start-InWindow 'storefront'
    }
    Write-Host 'Waiting for the shop...'
    Wait-Url $ShopUrl 'The shop server' 2
    Wait-Url $StorefrontUrl 'The storefront' 3
    Show-Status
  }

  'stop' {
    Stop-OnPort 5173 'The storefront'
    Stop-OnPort 8765 'The shop server'
    Invoke-Tool docker @Compose down
    Write-Host 'The demo stack is stopped; its data is kept. "start" brings everything back.'
  }

  'up' {
    Start-Stack -Build
    Show-Status
  }

  'load' {
    Invoke-Load
    Write-Host ''
    Write-Host 'Restart the shop server so it reads the new settings.'
  }

  'shop' {
    Assert-Garment
    Push-Location $GarmentDir
    try {
      & python -m shop.server --step-seconds $StepSeconds
    } finally {
      Pop-Location
    }
  }

  'storefront' {
    Assert-Garment
    Push-Location (Join-Path $GarmentDir 'frontend')
    try {
      if (-not (Test-Path 'node_modules')) { & npm ci --no-audit --no-fund }
      & npm run dev
    } finally {
      Pop-Location
    }
  }

  'status' { Show-Status }

  'reset' {
    Invoke-Tool docker @Compose down -v
    # The shop starts again too: its accounts and orders belong to the tickets that are gone.
    foreach ($leftover in @('outputs\support\events.jsonl', 'outputs\shop\shop.db', 'outputs\shop\shop.db-wal', 'outputs\shop\shop.db-shm')) {
      $path = Join-Path $GarmentDir $leftover
      if (Test-Path $path) { Remove-Item $path -Confirm:$false }
    }
    Write-Host 'The demo stack and its data are gone. Stop the shop server if it is running, then run "up" and "load".'
  }

  'down' { Invoke-Tool docker @Compose down }
}
