@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0save-business-key.ps1"
set "exitCode=%ERRORLEVEL%"
echo.
if "%exitCode%"=="0" (
    echo Business key enrollment completed. You can now use start-business-plugin.cmd.
) else (
    echo Business key enrollment failed or was canceled. The existing key was not changed unless replacement was confirmed.
)
pause
exit /b %exitCode%
