' Starts JARVIS with no console window. Nothing to keep open, nothing to
' close by accident. Output goes to jarvis.log next to this file.
Option Explicit
Dim sh, fso, root, py, cmd
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
py = root & "\.venv\Scripts\python.exe"
If Not fso.FileExists(py) Then py = "python"
sh.CurrentDirectory = root
cmd = "cmd /c """"" & py & """ ""server.py"" > ""jarvis.log"" 2>&1"""
sh.Run cmd, 0, False
