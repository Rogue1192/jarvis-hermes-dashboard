# JARVIS dashboard launcher for native Windows.
#
# The upstream project ships start.sh / install.sh, which assume bash and a
# POSIX layout. This is the Windows equivalent: find a usable Python, make sure
# Hermes is reachable, then hand off to server.py.
#
#   .\start.ps1

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# First run: create the private .env from the template.
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "Created .env from .env.example - add your ElevenLabs key there." -ForegroundColor Yellow
}

# Prefer the Python that Hermes installs; fall back to whatever is on PATH.
$python = $null
$candidates = @(
    (Join-Path $PSScriptRoot ".venv\Scripts\python.exe"),
    (Join-Path $env:LOCALAPPDATA "hermes\python\python.exe"),
    (Join-Path $env:LOCALAPPDATA "hermes\hermes-agent\venv\Scripts\python.exe")
)
foreach ($c in $candidates) {
    if (Test-Path $c) { $python = $c; break }
}
if (-not $python) {
    $onPath = Get-Command python -ErrorAction SilentlyContinue
    if ($onPath) { $python = $onPath.Source }
}
if (-not $python) {
    Write-Host "No Python found. Install Hermes first: iex (irm https://hermes-agent.nousresearch.com/install.ps1)" -ForegroundColor Red
    exit 1
}

# Warn early if Hermes is missing - the dashboard is only a face on it.
$hermes = Get-Command hermes -ErrorAction SilentlyContinue
if (-not $hermes) {
    $bundled = Join-Path $env:LOCALAPPDATA "hermes\hermes-agent\venv\Scripts\hermes.exe"
    if (Test-Path $bundled) {
        $env:HERMES_CMD = $bundled
    } else {
        Write-Host "Hermes CLI not found. The dashboard will start but have no brain." -ForegroundColor Yellow
    }
}

Write-Host "Python:  $python"
Write-Host "Hermes:  $(if ($env:HERMES_CMD) { $env:HERMES_CMD } elseif ($hermes) { $hermes.Source } else { 'not found' })"
Write-Host ""

& $python launch.py
