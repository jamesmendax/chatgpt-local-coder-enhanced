@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0_one-click-control.ps1" -Action RestartMcp
set "exitCode=%ERRORLEVEL%"
echo.
if not "%exitCode%"=="0" (
    echo Shared MCP restart failed. Read the message above.
) else (
    echo Shared MCP restarted. Business and Free tunnels were not restarted.
)
pause
exit /b %exitCode%