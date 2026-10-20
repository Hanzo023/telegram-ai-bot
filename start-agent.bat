@echo off
title Telegram AI Remote Laptop Agent Runner
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

echo ========================================================
echo   Telegram AI Remote Laptop Agent Runner
echo ========================================================
echo [SERVER]  https://telegram-ai-bot-znei.onrender.com
echo [USER ID] 8199950189
echo.

if not exist node_modules\ws (
  echo [INFO] Installing required dependencies...
  call npm install ws dotenv --no-audit --no-fund
)

set "LOG_FILE=%~dp0runner.log"

echo [STARTING] Launching silent detached background runner...
start "" wscript.exe "%~dp0start-background.vbs"

echo [WAITING] Connecting to Telegram AI server and confirming handshake...
echo.

set /a ATTEMPTS=0
:WAIT_LOOP
set /a ATTEMPTS+=1
timeout /t 1 >nul 2>nul

findstr /C:"Server handshake confirmed" "%LOG_FILE%" >nul 2>nul
if %errorlevel% equ 0 goto SHOW_CONFIRMED

if %ATTEMPTS% geq 10 goto TIMEOUT_WAIT
goto WAIT_LOOP

:SHOW_CONFIRMED
echo ========================================================
echo   [OK] HANDSHAKE CONFIRMED WITH TELEGRAM AI BOT!
echo ========================================================
echo  Device:   %COMPUTERNAME%
echo  Status:   CONNECTED AND READY FOR TELEGRAM COMMANDS
echo  Server:   wss://telegram-ai-bot-znei.onrender.com
echo  Mode:     PERMANENT BACKGROUND DAEMON [Detached]
echo.
echo  Closing this window will NOT disconnect the agent.
echo  The runner is running completely independently in background.
echo.
echo  To stop or disable anytime, double-click:
echo    Disable-Laptop-Agent.bat on your Desktop.
echo ========================================================
echo Window closing in 4 seconds or press any key...
timeout /t 4
exit /b 0

:TIMEOUT_WAIT
echo ========================================================
echo  [INFO] Background runner launched.
echo  If the cloud server is waking up, connection may
echo  take up to 25 seconds to establish.
echo.
echo  Check live status in Telegram with: /status
echo  Closing this window will NOT terminate the background runner.
echo ========================================================
timeout /t 5
exit /b 0

:FOREGROUND
echo Starting in foreground mode, press Ctrl+C to stop...
node laptop-runner.js --user 8199950189 --server https://telegram-ai-bot-znei.onrender.com %*
exit /b 0

:DISABLE
call "%~dp0disable-agent.bat"
exit /b 0
