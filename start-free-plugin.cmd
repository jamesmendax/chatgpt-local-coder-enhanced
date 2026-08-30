@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0_one-click-control.ps1" -Action StartFree
set "exitCode=%ERRORLEVEL%"
if not "%exitCode%"=="0" (
    echo.
    echo Free start failed. Read the message above.
    pause
)
exit /b %exitCode%
