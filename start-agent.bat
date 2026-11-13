@echo off
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

wscript.exe "%~dp0start-background.vbs"
exit /b 0

:FOREGROUND
echo Starting in foreground mode, press Ctrl+C to stop...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"CommandLine like '%%laptop-runner.js%%'\" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
node laptop-runner.js --visible %*
exit /b 0

:DISABLE
call "%~dp0Disable-Laptop-Agent.bat"
