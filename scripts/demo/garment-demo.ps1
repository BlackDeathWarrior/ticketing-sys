<#
.SYNOPSIS
  The Ethnic Threads demo: TMS in Docker as the support desk of the
  garment-web-scraper app, which runs on this machine (ADR 0027).

.DESCRIPTION
  up          Builds and starts the demo stack (its own project, ports and database).
  load        Sets TMS up for Ethnic Threads and writes the app's .env.
              -Llm scripted uses the scripted model (no key); the default leaves
              the model to you: add one under Settings > Providers and Models, then run load again
              to load the knowledge base.
              -Rekey makes new API keys and secrets for an existing setup.
  worker      Runs the app's worker (port 8765). By default it scrapes only when
              asked: -Sources myntra -MaxProducts 5 keeps a scrape short.
              -Sources notasource makes every run fail, to show an incident.
              -Autostart starts the continuous scrape on boot, as in production.
  storefront  Runs the app's site (http://localhost:5173).
  status      Shows what is running and where.
  reset       Stops the stack and deletes its database, and the app's record of
              webhook events. The default TMS stack is not touched.
  down        Stops the stack, keeping its data.

  The walk-through is docs/runbooks/phase-14-garment-demo.md.

.EXAMPLE
  ./scripts/demo/garment-demo.ps1 up
  ./scripts/demo/garment-demo.ps1 load -Llm scripted
  ./scripts/demo/garment-demo.ps1 worker
  ./scripts/demo/garment-demo.ps1 storefront
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('up', 'load', 'worker', 'storefront', 'status', 'reset', 'down')]
  [string]$Command = 'status',
  [ValidateSet('none', 'scripted')]
  [string]$Llm = 'none',
  [switch]$Rekey,
  [string]$Sources = 'myntra',
  [int]$MaxProducts = 5,
  [switch]$Autostart,
  # The garment-web-scraper clone; by default the folder next to this repository.
  [string]$GarmentDir = $env:GARMENT_DIR
)

$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $GarmentDir) { $GarmentDir = Join-Path (Split-Path $Repo -Parent) 'garment-web-scraper' }

$ApiUrl = 'http://localhost:3200'
$WidgetUrl = 'http://localhost:8090'
$Compose = @(
  'compose',
  '-f', (Join-Path $Repo 'infra\docker-compose.yml'),
  '-f', (Join-Path $Repo 'infra\docker-compose.garment.yml'),
  '--profile', 'app'
)

function Assert-Garment {
  if (-not (Test-Path (Join-Path $GarmentDir 'scraper\worker.py'))) {
    throw "The garment-web-scraper clone was not found at $GarmentDir. Pass -GarmentDir or set GARMENT_DIR."
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
    @{ Name = 'App worker'; Url = 'http://localhost:8765/api/health'; Open = 'http://localhost:8765/api/health' },
    @{ Name = 'Storefront'; Url = 'http://localhost:5173/'; Open = 'http://localhost:5173' }
  )
  foreach ($row in $rows) {
    $state = 'down'
    if (Test-Url $row.Url) { $state = 'up  ' }
    Write-Host ("{0,-12} {1}  {2}" -f $row.Name, $state, $row.Open)
  }
}

switch ($Command) {
  'up' {
    & docker @Compose up -d --build
    if ($LASTEXITCODE -ne 0) { throw 'docker compose up failed' }
    Write-Host 'Waiting for the API...'
    $deadline = (Get-Date).AddMinutes(5)
    while (-not (Test-Url "$ApiUrl/api/v1/health/live")) {
      if ((Get-Date) -gt $deadline) { throw "The API did not come up at $ApiUrl" }
      Start-Sleep -Seconds 3
    }
    Show-Status
  }

  'load' {
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
      & pnpm garment:load
      if ($LASTEXITCODE -ne 0) { throw 'The loader failed' }
    } finally {
      Pop-Location
    }
    Write-Host ''
    Write-Host 'Restart the app worker so it reads the new settings.'
  }

  'worker' {
    Assert-Garment
    # A scrape adds to outputs\products.json. A fresh clone has only the published copy:
    # without this, the first scrape would replace the whole catalogue with what it found.
    $working = Join-Path $GarmentDir 'outputs\products.json'
    $published = Join-Path $GarmentDir 'frontend\public\products.json'
    if (-not (Test-Path $working) -and (Test-Path $published)) {
      New-Item -ItemType Directory -Force (Split-Path $working -Parent) | Out-Null
      Copy-Item $published $working
    }
    $workerArgs = @('-m', 'scraper.worker', '--sources', $Sources, '--max-products', $MaxProducts)
    if (-not $Autostart) { $workerArgs += '--no-autostart' }
    Push-Location $GarmentDir
    try {
      & python @workerArgs
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
    & docker @Compose down -v
    $events = Join-Path $GarmentDir 'outputs\support\events.jsonl'
    if (Test-Path $events) { Remove-Item $events -Confirm:$false }
    # Back to the catalogue as committed (last scraped in April 2026), so the
    # stale-catalogue incident can be shown again.
    $working = Join-Path $GarmentDir 'outputs\products.json'
    if (Test-Path $working) { Remove-Item $working -Confirm:$false }
    & git -C $GarmentDir checkout -- frontend/public/products.json
    Write-Host 'The demo stack and its data are gone. Run "up", then "load".'
  }

  'down' { & docker @Compose down }
}
