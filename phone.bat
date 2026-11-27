@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from the page that opens, then run this file again.
  start https://nodejs.org
  pause
  exit /b 1
)
echo Phone access is on. Open http://localhost:4600 on this computer, go to Settings, and use the link shown there on your phone.
echo Your phone must be on the same Wi-Fi. If Windows asks about Node.js and the firewall, click Allow.
rem Open the browser two seconds from now, once the app has started.
start "" /min cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:4600"
node scripts\phone.js
pause
