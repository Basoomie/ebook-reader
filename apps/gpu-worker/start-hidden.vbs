' Starts the ttsu Reader GPU worker without a console window (used by the sign-in task).
' The worker writes its log to C:\ttsu-worker\logs\worker.log.
Set shell = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run "node """ & here & "\app\main.js"" run", 0, False
