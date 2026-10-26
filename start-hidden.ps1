# Telegram AI Remote Laptop Agent Runner - Hidden Detached Process Starter
$ErrorActionPreference = 'SilentlyContinue'

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $projectDir -or -not (Test-Path "$projectDir\laptop-runner.js")) {
    $projectDir = "D:\projects\telegram-ai-bot"
}

# 1. Stop any existing laptop-runner.js processes to prevent duplicates or port clashes
$existing = Get-CimInstance Win32_Process -Filter "CommandLine like '%laptop-runner.js%'"
foreach ($p in $existing) {
    if ($p.ProcessId -ne $PID) {
        try {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Host "[CLEANUP] Stopped existing runner PID $($p.ProcessId)"
        } catch {}
    }
}

# 2. Give OS a moment to release port 52199
Start-Sleep -Milliseconds 600

# 3. Launch via VBScript runner with SW_HIDE (0) so Windows Terminal NEVER intercepts or pops up
$vbsPath = Join-Path $projectDir "start-background.vbs"
Start-Process -FilePath "wscript.exe" -ArgumentList "`"$vbsPath`"" -WorkingDirectory $projectDir
Write-Host "[OK] Telegram AI Laptop Runner started in 100% silent background mode via wscript (SW_HIDE)."
