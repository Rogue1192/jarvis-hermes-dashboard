' Starts JARVIS with no console window. Nothing to keep open, nothing to
' close by accident. Output goes to jarvis.log next to this file.
Option Explicit
Dim sh, fso, root, py, cmd, q
q = Chr(34)
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
py = root & "\.venv\Scripts\python.exe"
If Not fso.FileExists(py) Then py = "python"
sh.CurrentDirectory = root
' UTF-8 mode: Windows would otherwise use cp1252 for redirected output.
sh.Environment("PROCESS")("PYTHONUTF8") = "1"
sh.Environment("PROCESS")("PYTHONIOENCODING") = "utf-8"
cmd = "cmd /c " & q & q & py & q & " launch.py > jarvis.log 2>&1" & q
sh.Run cmd, 0, False
