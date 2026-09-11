@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0_one-click-control.ps1" -Action StatusMcp
set "exitCode=%ERRORLEVEL%"
echo.
pause
exit /b %exitCode%