' Stop, wait for the port, start again. Use this after any code change --
' "Start JARVIS" alone only reopens the window when a server is already up,
' which means the old code keeps serving and nothing tells you.
Option Explicit
Dim sh, fso, root, q
q = Chr(34)
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root

' Stop, and wait for it (True).
sh.Run q & root & "\Stop JARVIS.vbs" & q, 0, True
' Then start in the background, no console window.
sh.Run q & root & "\JARVIS (background).vbs" & q, 0, False
