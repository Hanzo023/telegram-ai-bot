@echo off
title Disable Telegram AI Laptop Runner
cd /d "%~dp0"
cls
echo ========================================================
echo   Stopping and Disabling Telegram AI Laptop Runner...
echo ========================================================
echo.

:: 1. Stop all running laptop-runner processes
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"CommandLine like '%%laptop-runner.js%%'\" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('[STOPPED] Terminated process PID ' + $_.ProcessId) }"

:: 2. Remove from Windows Startup folder
set "STARTUP_VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\TelegramAILaptopRunner.vbs"
if exist "%STARTUP_VBS%" (
  del /f /q "%STARTUP_VBS%"
  echo [REMOVED] Deleted Startup entry: %STARTUP_VBS%
) else (
  echo [OK] No Startup folder entry found.
)

:: 3. Remove from HKCU Run Registry
powershell -NoProfile -Command "Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'TelegramAILaptopRunner' -ErrorAction SilentlyContinue; Write-Host '[REMOVED] Removed HKCU Run registry auto-start key.'"

echo.
echo ========================================================
echo  [DISABLED] Telegram AI Laptop Runner is now OFF!
echo ========================================================
echo  - Background process has been stopped.
echo  - Auto-start on Windows boot/login is TURNED OFF.
echo.
echo  To re-enable anytime, run: Enable-Laptop-Agent.bat
echo ========================================================
timeout /t 5 >nul
exit /b 0
