@echo off
title Telegram AI Remote Laptop Agent
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js is not installed or not in PATH!
  echo Opening https://nodejs.org to download Node.js LTS...
  start https://nodejs.org/
  pause
  exit /b 1
)

if "%1"=="--foreground" goto FOREGROUND
if "%1"=="-f" goto FOREGROUND
if "%1"=="--disable" goto DISABLE
if "%1"=="--stop" goto DISABLE
if "%1"=="-d" goto DISABLE

:: Check if already running in background
for /f "tokens=*" %%P in ('powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*laptop-runner.js*' }).ProcessId"') do set "RUNNER_PID=%%P"

if not "%RUNNER_PID%"=="" (
  echo ========================================================
  echo   Telegram AI Remote Laptop Agent Runner
  echo ========================================================
  echo [STATUS] Running silently in background (PID: %RUNNER_PID%)
  echo [SERVER] https://telegram-ai-bot-znei.onrender.com
  echo [STARTUP] Auto-start on Windows login is ACTIVE.
  echo.
  echo  You do not need to keep this terminal window open!
  echo  To stop the agent anytime, run: stop-agent.bat
  echo  To view live terminal logs, run: start-agent.bat --foreground
  echo ========================================================
  timeout /t 4 >nul
  exit /b 0
)

:: Ensure dependencies are present
if not exist node_modules\ws (
  echo [INFO] Installing required dependencies (ws, dotenv)...
  call npm install ws dotenv --no-audit --no-fund
)

:: Launch silently via VBScript
start "" wscript.exe "%~dp0start-background.vbs"

echo ========================================================
echo   Telegram AI Remote Laptop Agent Runner
echo ========================================================
echo [OK] Remote Laptop Agent started in silent background mode!
echo [SERVER] https://telegram-ai-bot-znei.onrender.com
echo [STARTUP] Auto-start on Windows login is ACTIVE.
echo.
echo  Zero window popups. You can safely close this window now.
echo ========================================================
timeout /t 3 >nul
exit /b 0

:FOREGROUND
echo Starting in foreground mode (press Ctrl+C to stop)...
node laptop-runner.js --user 8199950189 --server https://telegram-ai-bot-znei.onrender.com %*
exit /b 0

:DISABLE
call "%~dp0disable-agent.bat"
exit /b 0
