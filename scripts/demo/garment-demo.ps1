<#
.SYNOPSIS
  The Ethnic Threads demo: TMS in Docker as the support desk of a shop that
  runs on this machine (the garment-web-scraper repository; ADR 0027, 0028).

.DESCRIPTION
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
  ./scripts/demo/garment-demo.ps1 up
  ./scripts/demo/garment-demo.ps1 load -Llm scripted
  ./scripts/demo/garment-demo.ps1 shop
  ./scripts/demo/garment-demo.ps1 storefront
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('up', 'load', 'shop', 'storefront', 'status', 'reset', 'down')]
  [string]$Command = 'status',
  [ValidateSet('none', 'scripted')]
  [string]$Llm = 'none',
  [switch]$Rekey,
  [int]$StepSeconds = 20,
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
    @{ Name = 'Shop server'; Url = 'http://localhost:8765/api/health'; Open = 'http://localhost:8765/api/health' },
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
    Invoke-Tool docker @Compose up -d --build
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
      Invoke-Tool pnpm garment:load
    } finally {
      Pop-Location
    }
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
