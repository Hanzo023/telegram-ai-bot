@echo off
title Telegram AI Laptop Agent Runner (User 2)
cd /d "%~dp0"
cls
echo ========================================================
echo   Starting Telegram AI Remote Laptop Agent Runner (User 2)...
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js is not installed or not in PATH!
  echo Please install Node.js from https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo [INFO] node_modules not found. Installing dependencies...
  call npm install
)

node laptop-runner.js --user 1509442723 %*
if %errorlevel% neq 0 (
  echo.
  echo [ERROR] Runner stopped with error code %errorlevel%.
  pause
)
