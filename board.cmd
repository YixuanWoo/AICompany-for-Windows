@echo off
rem Shortcut to open the control-plane board (the GUI).
rem The board is a WEB PAGE, not a desktop app window. Service runs in background.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

curl -s -m 3 -o nul http://127.0.0.1:3100/ >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [X] Control-plane service is not running. Board cannot open.
  echo       Start it:  npm run win:start
  echo       Or foreground:  npm run start:prod
  echo.
  pause
  exit /b 1
)

start "" http://127.0.0.1:3100/
exit /b 0
