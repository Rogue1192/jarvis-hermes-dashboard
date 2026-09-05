' Stops JARVIS and does not return until the port is actually free.
'
' The old version fired "kill whoever owns port 8730" and returned immediately.
' Two problems: it matched only by port, so a JARVIS that had not finished
' binding survived; and it did not wait, so clicking Start straight after found
' the dying server still answering, decided JARVIS was up, and merely reopened a
' window onto a process about to disappear.
Option Explicit
Dim sh, q, ps
q = Chr(34)
Set sh = CreateObject("WScript.Shell")

ps = "$ErrorActionPreference='SilentlyContinue';" & _
     "Get-CimInstance Win32_Process | " & _
     "  Where-Object { $_.CommandLine -like '*launch.py*' -or $_.CommandLine -like '*server.py*' } | " & _
     "  ForEach-Object { Stop-Process -Id $_.ProcessId -Force };" & _
     "Get-NetTCPConnection -LocalPort 8730 -State Listen | " & _
     "  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force };" & _
     "for ($i=0; $i -lt 40; $i++) {" & _
     "  if (-not (Get-NetTCPConnection -LocalPort 8730 -State Listen)) { break };" & _
     "  Start-Sleep -Milliseconds 250 }"

' True = wait for it to finish, so a Start clicked right after is safe.
sh.Run "powershell -NoProfile -WindowStyle Hidden -Command " & q & ps & q, 0, True
