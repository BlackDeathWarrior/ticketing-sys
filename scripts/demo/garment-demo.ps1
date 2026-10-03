<#
.SYNOPSIS
  The Ethnic Threads demo: TMS in Docker as the support desk of a shop that
  runs on this machine (the garment-web-scraper repository; ADR 0027, 0028).

.DESCRIPTION
  start       Everything in one go, brought up to date with the code: starts the
              demo stack, then the shop's server and its site, each in its own
              window. What changed since the last start is updated first, and
              only that (data is always kept):
                platform code      the stack is built again
                the loader's data  "load" runs
                the shop's code or its .env   the shop's server is restarted
                the site's packages           they are installed again
              The site reloads its own changed files, so it is left running.
              -Rebuild and -Load do the first two whether or not anything changed.
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
  reset       Stops the stack and deletes its database, the shop's database (it
              lives on the stack's PostgreSQL server) and the shop's record of
              webhook events. The default TMS stack is not touched.
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

# ---- What "start" updates ----
#
# "start" remembers a mark of each part it brought up: the size and the time of
# every file that part is made from. A part whose mark differs now has changed.
# The marks are kept outside both repositories; "reset" forgets them.
$StateFile = Join-Path $env:LOCALAPPDATA 'tms-garment-demo\state.json'
# What goes into the stack's images.
$StackPaths = @('apps', 'packages', 'infra', 'Dockerfile', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json')

# A mark of the files git knows or would add under $Paths (so never node_modules or
# build output), plus $Extra files that git ignores, such as a .env.
function Get-CodeMark([string]$Dir, [string[]]$Paths, [string[]]$Extra = @()) {
  $files = @(Invoke-Tool git -C $Dir ls-files -co --exclude-standard @Paths) + $Extra
  $lines = foreach ($file in $files) {
    $item = Get-Item -LiteralPath (Join-Path $Dir $file) -ErrorAction SilentlyContinue
    if ($item) { '{0}|{1}|{2}' -f $file, $item.Length, $item.LastWriteTimeUtc.Ticks }
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes((@($lines) | Sort-Object) -join "`n")
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').Substring(0, 16)
  } finally {
    $sha.Dispose()
  }
}

function Read-State {
  if (Test-Path $StateFile) {
    try { return Get-Content $StateFile -Raw | ConvertFrom-Json } catch { }
  }
  return [pscustomobject]@{}
}

# True when the part has changed since "start" last brought it up, or never was.
function Test-Changed([string]$Part, [string]$Mark) {
  return (Read-State).$Part -ne $Mark
}

function Save-Mark([string]$Part, [string]$Mark) {
  $state = Read-State
  $state | Add-Member -NotePropertyName $Part -NotePropertyValue $Mark -Force
  New-Item -ItemType Directory -Force (Split-Path $StateFile) | Out-Null
  $state | ConvertTo-Json | Set-Content -Path $StateFile -Encoding utf8
}

# The shop keeps its accounts and orders in a database of its own on the stack's
# PostgreSQL server (SHOP_DATABASE_URL in its .env). A new stack, or one that was
# reset, has neither the role nor the database: they are made here, with the password
# the shop already has. The shop creates its tables itself. A shop that uses its
# SQLite file, or a server that is not this stack's, is left alone.
function Initialize-ShopDatabase {
  $envFile = Join-Path $GarmentDir '.env'
  if (-not (Test-Path $envFile)) { return }
  $line = Get-Content $envFile | Where-Object { $_ -match '^\s*SHOP_DATABASE_URL\s*=' } | Select-Object -First 1
  $ours = '=\s*["'']?postgres(?:ql)?://(?<user>[a-z_][a-z0-9_]*):(?<password>[^@\s"'']+)@(?:localhost|127\.0\.0\.1):5442/(?<db>[a-z_][a-z0-9_]*)'
  if (-not $line -or $line -notmatch $ours) { return }
  $user = $Matches.user
  $db = $Matches.db
  $password = $Matches.password -replace "'", "''"
  $found = Invoke-Tool docker @Compose exec -T postgres psql -U tms -d postgres -X -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'"
  if ("$found".Trim() -eq '1') { return }
  # Through standard input, so the password is on no command line.
  $sql = @(
    "DO `$`$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$user') THEN CREATE ROLE $user LOGIN PASSWORD '$password'; END IF; END `$`$;",
    "CREATE DATABASE $db OWNER $user;",
    "REVOKE CONNECT ON DATABASE $db FROM PUBLIC;"
  ) -join "`n"
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $sql | & docker @Compose exec -T postgres psql -U tms -d postgres -X -q -v ON_ERROR_STOP=1
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($LASTEXITCODE -ne 0) { throw "The shop's database '$db' could not be created on the stack's PostgreSQL server." }
  Write-Host "The shop's database '$db' was created on the stack's PostgreSQL server."
}

# A shop on PostgreSQL needs its driver. Installed once, when it is missing.
function Assert-ShopDriver {
  $envFile = Join-Path $GarmentDir '.env'
  if (-not (Test-Path $envFile) -or -not (Select-String -Path $envFile -Pattern '^\s*SHOP_DATABASE_URL\s*=\s*\S' -Quiet)) { return }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & python -c 'import psycopg; psycopg.pq.version()' *> $null
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($LASTEXITCODE -eq 0) { return }
  Write-Host "Installing the shop's PostgreSQL driver (psycopg)..."
  Invoke-Tool python -m pip install --quiet 'psycopg[binary]'
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

    # The stack: built again when the platform's code changed since it was last built.
    $stackMark = Get-CodeMark $Repo $StackPaths
    $build = $Rebuild -or (Test-Changed 'stack' $stackMark)
    if ($build -and -not $Rebuild) {
      Write-Host 'The platform code changed since the stack was last built here: building it again (data is kept).'
    }
    Start-Stack -Build:$build
    Save-Mark 'stack' $stackMark
    Initialize-ShopDatabase

    # The desk's setup for the shop: loaded again when the loader's data changed.
    $dataMark = Get-CodeMark $Repo @('scripts/sample-data/garment')
    if ($Load -or (Test-Changed 'data' $dataMark)) {
      if (-not $Load) { Write-Host "The loader's data changed since it was last loaded: loading it (what exists is left alone)." }
      Invoke-Load
      Save-Mark 'data' $dataMark
    }

    # The shop's server: Python reads its code once, so a change needs a restart.
    # Marked after the load, which may have written new settings into the shop's .env.
    Assert-ShopDriver
    $shopMark = Get-CodeMark $GarmentDir @('shop', 'scraper/support') @('.env')
    $shopUp = Test-Url $ShopUrl
    if ($shopUp -and (Test-Changed 'shop' $shopMark)) {
      Write-Host "The shop's code or settings changed since its server was started here: restarting it."
      Stop-OnPort 8765 'The shop server'
      $shopUp = $false
    }
    if ($shopUp) {
      Write-Host 'The shop server is already running, on the current code.'
    } else {
      Start-InWindow 'shop'
    }
    Save-Mark 'shop' $shopMark

    # The site reloads its own changed files. Only a change of its packages needs
    # an install, and that needs the site stopped.
    $siteMark = Get-CodeMark $GarmentDir @('frontend/package-lock.json')
    $siteUp = Test-Url $StorefrontUrl
    $frontend = Join-Path $GarmentDir 'frontend'
    if ((Read-State).storefront -and (Test-Changed 'storefront' $siteMark) -and (Test-Path (Join-Path $frontend 'node_modules'))) {
      Write-Host "The storefront's packages changed: installing them."
      if ($siteUp) {
        Stop-OnPort 5173 'The storefront'
        $siteUp = $false
      }
      Push-Location $frontend
      try {
        Invoke-Tool npm ci --no-audit --no-fund
      } finally {
        Pop-Location
      }
    }
    if ($siteUp) {
      Write-Host 'The storefront is already running.'
    } else {
      Start-InWindow 'storefront'
    }
    Save-Mark 'storefront' $siteMark

    Write-Host 'Waiting for the shop...'
    Wait-Url $ShopUrl 'The shop server' 2
    Wait-Url $StorefrontUrl 'The storefront' 3
    Show-Status
  }

  'stop' {
    Stop-OnPort 5173 'The storefront'
    Stop-OnPort 8765 'The shop server'
    Invoke-Tool docker @Compose down
    Write-Host 'Everything is stopped; the data is kept (the desk''s and the shop''s). "start" brings it all back.'
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
    # Nothing is built or loaded any more: the next "start" does all of it again.
    if (Test-Path $StateFile) { Remove-Item $StateFile -Confirm:$false }
    Write-Host 'The demo stack and its data are gone, the shop''s accounts and orders with it. Stop the shop server if it is running, then run "start".'
  }

  'down' { Invoke-Tool docker @Compose down }
}
