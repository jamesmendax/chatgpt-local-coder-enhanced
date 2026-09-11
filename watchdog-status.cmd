@echo off
set "WATCHDOG_SCRIPT=%~dp0scripts\goal-watchdog.mjs"
powershell -NoProfile -Command "$needle=[regex]::Escape($env:WATCHDOG_SCRIPT); $p=Get-CimInstance Win32_Process ^| Where-Object { $_.CommandLine -match $needle }; if(-not $p){Write-Host 'Goal Watchdog: OFF'; exit 0}; foreach($x in $p){Write-Host ('Goal Watchdog: ON  PID='+$x.ProcessId)}"