' Telegram AI Remote Laptop Agent Runner - 100% Silent Background Launcher
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

currentDir = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FileExists(currentDir & "\laptop-runner.js") Then
  currentDir = "D:\projects\telegram-ai-bot"
End If

nodeExe = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then
  nodeExe = "node.exe"
End If

' Launch node laptop-runner.js with SW_HIDE (0) so NO window ever appears
WshShell.CurrentDirectory = currentDir
WshShell.Run """" & nodeExe & """ """ & currentDir & "\laptop-runner.js""", 0, False

Set WshShell = Nothing
Set fso = Nothing
