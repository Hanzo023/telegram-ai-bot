@echo off
title Telegram AI Laptop Agent Runner
cd /d "%~dp0"
cls
echo ========================================================
echo   Starting Telegram AI Remote Laptop Agent Runner...
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js is not installed or not in PATH!
  echo Opening https://nodejs.org to download Node.js LTS...
  start https://nodejs.org/
  pause
  exit /b 1
)

set "SERVER_URL=https://telegram-ai-bot-znei.onrender.com"
set "USER_ID=8199950189"

if not exist node_modules\ws (
  echo [INFO] Installing required dependencies (ws, dotenv)...
  call npm install ws dotenv --no-audit --no-fund
)

node laptop-runner.js --user %USER_ID% --server %SERVER_URL% %*
if %errorlevel% neq 0 (
  echo.
  echo [ERROR] Runner stopped with error code %errorlevel%.
  pause
)
