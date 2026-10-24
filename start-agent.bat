@echo off
title Telegram AI Remote Laptop Agent Runner
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js is not installed or not in PATH!
  pause
  exit /b 1
)

if "%1"=="--foreground" goto FOREGROUND
if "%1"=="-f" goto FOREGROUND
if "%1"=="--disable" goto DISABLE
if "%1"=="--stop" goto DISABLE
if "%1"=="-d" goto DISABLE

echo ========================================================
echo   Telegram AI Remote Laptop Agent Runner
echo ========================================================
echo [CLEANUP] Stopping previous instances and starting silent background runner...

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-hidden.ps1"

echo.
echo ========================================================
echo  [OK] Telegram AI Laptop Runner started in background!
echo ========================================================
echo  - Device:   %COMPUTERNAME%
echo  - Status:   RUNNING SILENTLY (No terminal window)
echo  - Logs:     runner.log
echo.
echo  To stop or disable anytime, double-click:
echo    Disable-Laptop-Agent.bat
echo ========================================================
echo This window will close in 3 seconds...
timeout /t 3 >nul
exit /b 0

:FOREGROUND
echo Starting in foreground mode, press Ctrl+C to stop...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"CommandLine like '%%laptop-runner.js%%'\" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
node laptop-runner.js %*
exit /b 0

:DISABLE
call "%~dp0Disable-Laptop-Agent.bat"
