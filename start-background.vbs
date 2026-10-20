' Telegram AI Remote Laptop Agent Runner - Silent Background Launcher
' Pure Win32 WMI process creation - 100% windowless background daemon

Set objWMIService = GetObject("winmgmts:\\.\root\cimv2")
Set colProcesses = objWMIService.ExecQuery("Select ProcessId, CommandLine from Win32_Process Where Name = 'node.exe'")

Dim isRunning
isRunning = False

For Each objProcess In colProcesses
    If Not IsNull(objProcess.CommandLine) Then
        If InStr(1, objProcess.CommandLine, "laptop-runner.js", 1) > 0 Then
            isRunning = True
            Exit For
        End If
    End If
Next

If Not isRunning Then
    Set objProcess = objWMIService.Get("Win32_Process")
    cmd = "node.exe ""D:\projects\telegram-ai-bot\laptop-runner.js"" --user 8199950189 --server https://telegram-ai-bot-znei.onrender.com"
    cwd = "D:\projects\telegram-ai-bot"
    objProcess.Create cmd, cwd, Null, intProcessID
End If
