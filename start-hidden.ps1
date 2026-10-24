# Telegram AI Remote Laptop Agent Runner - Hidden Detached Process Starter
$ErrorActionPreference = 'SilentlyContinue'

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $projectDir -or -not (Test-Path "$projectDir\laptop-runner.js")) {
    $projectDir = "D:\projects\telegram-ai-bot"
}

# 1. Stop any existing laptop-runner.js processes to prevent duplicates or port clashes
$existing = Get-CimInstance Win32_Process -Filter "CommandLine like '%laptop-runner.js%'"
foreach ($proc in $existing) {
    if ($proc.ProcessId -ne $PID) {
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Host "[CLEANUP] Stopped existing runner PID $($proc.ProcessId)"
        } catch {}
    }
}

# 2. Give OS a moment to release port 52199
Start-Sleep -Milliseconds 600

# 3. Locate node.exe
$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
    $nodeExe = "C:\Program Files\nodejs\node.exe"
}

# 4. Launch completely hidden (laptop-runner.js manages runner.log internally)
$proc = Start-Process -FilePath $nodeExe -ArgumentList "laptop-runner.js" -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru

if ($proc) {
    Write-Host "[OK] Telegram AI Laptop Runner started in background (PID: $($proc.Id)). Zero terminal windows."
} else {
    Write-Host "[ERROR] Failed to start laptop-runner.js process."
}
