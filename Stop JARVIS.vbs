' Stops JARVIS. No window, no output -- he is simply gone afterwards.
Option Explicit
Dim sh, q
q = Chr(34)
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell -NoProfile -WindowStyle Hidden -Command " & q & _
  "Get-NetTCPConnection -LocalPort 8730 -State Listen -ErrorAction SilentlyContinue | " & _
  "ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }" & q, 0, False
