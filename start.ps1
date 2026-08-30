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

# Open in a chrome-less app window rather than a browser tab.
#
# Deliberately NOT a separate browser profile: the microphone permission you
# granted to 127.0.0.1:8730 lives in your normal profile, and a fresh profile
# would make you grant it again every launch.
#
# Chrome app mode is used in preference to a native webview wrapper because a
# webview host has to broker microphone permission itself, and a wrapper that
# silently denies the mic would break voice while looking fine.
$chrome = $null
foreach ($c in @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)) { if (Test-Path $c) { $chrome = $c; break } }

$port = if ($env:JARVIS_PORT) { $env:JARVIS_PORT } else { "8730" }
$url  = "http://127.0.0.1:$port"

if ($chrome -and $env:JARVIS_APP_WINDOW -ne "0") {
    $env:JARVIS_OPEN = "0"          # stop server.py opening a second tab
    Start-Job -ScriptBlock {
        param($exe, $target)
        # Wait for the port to answer rather than guessing at a delay -- the
        # first run loads the wake word model and is much slower than later ones.
        for ($i = 0; $i -lt 60; $i++) {
            try {
                (New-Object Net.Sockets.TcpClient).Connect("127.0.0.1", ([Uri]$target).Port)
                break
            } catch { Start-Sleep -Milliseconds 500 }
        }
        & $exe "--app=$target" "--window-size=1600,950"
    } -ArgumentList $chrome, $url | Out-Null
    Write-Host "Window:  app mode ($([IO.Path]::GetFileName($chrome)))"
} else {
    Write-Host "Window:  browser tab (no Chrome or Edge found)"
}

Write-Host "Python:  $python"
Write-Host "Hermes:  $(if ($env:HERMES_CMD) { $env:HERMES_CMD } elseif ($hermes) { $hermes.Source } else { 'not found' })"
Write-Host ""

& $python server.py
