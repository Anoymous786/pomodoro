@echo off
taskkill /f /im node.exe 2>nul
cd /d C:\Users\utsi2\Desktop\pomodoro-dashboard
rmdir /s /q .next 2>nul
start /b cmd /c "npx next dev -p 3000 > dev-server.log 2>&1"
echo Server restarting...
