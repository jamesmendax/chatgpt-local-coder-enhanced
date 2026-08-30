@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0save-free-key.ps1"
set "exitCode=%ERRORLEVEL%"
echo.
if "%exitCode%"=="0" (
    echo Free key enrollment completed. You can now use start-free-plugin.cmd.
) else (
    echo Free key enrollment failed or was canceled. The existing key was not changed unless replacement was confirmed.
)
pause
exit /b %exitCode%
