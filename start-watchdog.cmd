@echo off
title Goal Watchdog - ChatGPT Local Coder
set WATCHDOG_PARENT_PID=
for /f %%P in ('powershell -NoProfile -Command "$c=Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue ^| Select-Object -First 1; if($c){$c.OwningProcess}"') do set WATCHDOG_PARENT_PID=%%P
if not defined WATCHDOG_PARENT_PID (
  echo MCP is not running on port 3000. Watchdog was not started.
  exit /b 1
)
node "%~dp0scripts\goal-watchdog.mjs"
echo.
echo Watchdog exited. Press any key to close.
pause >nul
