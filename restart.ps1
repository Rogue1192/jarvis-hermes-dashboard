# Actually restart JARVIS.
#
# start.ps1 -> launch.py is deliberately idempotent: if something is already
# listening on the port it just reopens the browser window and leaves the
# running server alone. That is right for a double-clicked shortcut and wrong
# after a code change -- the old process keeps serving the old code and nothing
# says so. This stops it first, then starts fresh.
$ErrorActionPreference = "Stop"

$procs = @(Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*launch.py*" -or $_.CommandLine -like "*server.py*" })

if ($procs.Count -eq 0) {
    Write-Host "JARVIS was not running." -ForegroundColor Yellow
} else {
    foreach ($p in $procs) {
        Write-Host ("stopping pid {0} (started {1})" -f $p.ProcessId, $p.CreationDate)
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    # Give the socket a moment to actually free, or launch.py sees the dying
    # server, decides JARVIS is up, and reopens the window instead of starting.
    Start-Sleep -Milliseconds 1500
}

& (Join-Path $PSScriptRoot "start.ps1")
