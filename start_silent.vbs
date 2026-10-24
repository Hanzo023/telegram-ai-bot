' Telegram AI Remote Laptop Agent Runner - 100% Silent Background Launcher
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)

If Not fso.FileExists(currentDir & "\laptop-runner.js") Then
  currentDir = "D:\projects\telegram-ai-bot"
End If

psCmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & currentDir & "\start-hidden.ps1"""
WshShell.Run psCmd, 0, False
Set WshShell = Nothing
