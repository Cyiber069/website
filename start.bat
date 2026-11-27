@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from the page that opens, then run this file again.
  start https://nodejs.org
  pause
  exit /b 1
)
where claude >nul 2>nul
if errorlevel 1 if not exist "%USERPROFILE%\.local\bin\claude.exe" (
  echo.
  echo   Claude Code is not installed, so agents will only make demo placeholders.
  echo   A Claude API key on its own is not enough: Claude Code must be installed too.
  echo   To install it, open PowerShell and run:   irm https://claude.ai/install.ps1 ^| iex
  echo   Then open Settings in the app and press "Check again". No restart needed.
  echo.
)
rem Open the browser two seconds from now, once the app has started.
start "" /min cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:4600"
node server\index.js
pause
