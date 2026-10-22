' Telegram AI Remote Laptop Agent Runner - 100% Silent Background Launcher
' Uses WScript.Shell with SW_HIDE (0) so zero CMD or terminal windows ever appear
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = currentDir
WshShell.Run Chr(34) & currentDir & "\run.bat" & Chr(34), 0, False
Set WshShell = Nothing
