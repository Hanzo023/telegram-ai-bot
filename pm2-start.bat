@echo off
cd /d "%~dp0"
pm2 start laptop-runner.js --name "telegram-agent"
pm2 save
echo.
echo ========================================================
echo   [OK] Telegram Agent is running in background via PM2!
echo ========================================================
echo   - Check status anytime with: pm2 status
echo   - View live logs with:       pm2 logs
echo   - Stop runner anytime with:  pm2 stop telegram-agent
echo ========================================================
pause
