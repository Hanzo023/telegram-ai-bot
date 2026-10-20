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
copy /y "D:\projects\telegram-ai-bot\start-background.vbs" "%STARTUP_VBS%" >nul
echo [OK] Restored to Windows Startup folder.

:: 2. Re-register HKCU Run key
powershell -NoProfile -Command "Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'TelegramAILaptopRunner' -Value 'wscript.exe \"D:\projects\telegram-ai-bot\start-background.vbs\"'; Write-Host '[OK] Restored HKCU Run registry auto-start key.'"

:: 3. Launch background process
start "" wscript.exe "D:\projects\telegram-ai-bot\start-background.vbs"
echo [OK] Started silent background runner!

echo.
echo ========================================================
echo  [ENABLED] Telegram AI Laptop Runner is ACTIVE!
echo ========================================================
echo  - Connected to: https://telegram-ai-bot-znei.onrender.com
echo  - Auto-start on Windows boot/login is ON.
echo.
echo  To disable anytime, run: Disable-Laptop-Agent.bat
echo ========================================================
timeout /t 4 >nul
exit /b 0
