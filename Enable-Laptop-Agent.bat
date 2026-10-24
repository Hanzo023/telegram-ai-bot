@echo off
title Enable Telegram AI Laptop Runner
cd /d "%~dp0"
cls
echo ========================================================
echo   Enabling Telegram AI Laptop Runner...
echo ========================================================
echo.

:: 1. Re-install into Windows Startup folder
set "STARTUP_VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\TelegramAILaptopRunner.vbs"
copy /y "%~dp0start-background.vbs" "%STARTUP_VBS%" >nul
echo [OK] Restored to Windows Startup folder.

:: 2. Launch background process
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-hidden.ps1"
echo [OK] Started silent background runner!

echo.
echo ========================================================
echo  [ENABLED] Telegram AI Laptop Runner is ACTIVE!
echo ========================================================
echo  - Runner started in background without terminal windows.
echo  - Auto-start on Windows boot/login is ON.
echo.
echo  To disable anytime, run: Disable-Laptop-Agent.bat
echo ========================================================
timeout /t 3 >nul
exit /b 0
