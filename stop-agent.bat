@echo off
title Stop Telegram AI Laptop Runner
powershell -Command "Get-CimInstance Win32_Process -Filter \"CommandLine like '%%laptop-runner.js%%'\" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('Stopped laptop-runner PID ' + $_.ProcessId) }"
echo.
echo Telegram AI Laptop Runner stopped.
timeout /t 2 >nul
