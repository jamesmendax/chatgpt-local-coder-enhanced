param([int]$Port = 3000)

$lines = netstat -ano | Select-String ":$Port\s" | Select-String "LISTENING"
$pids = @()

foreach ($line in $lines) {
    $parts = ($line -replace '\s+', ' ').ToString().Trim().Split(' ')
    $processId = [int]$parts[-1]
    if ($processId -gt 0) { $pids += $processId }
}

$pids = $pids | Select-Object -Unique

if ($pids.Count -eq 0) {
    Write-Host "Khong co server nao dang chay tren port $Port" -ForegroundColor Yellow
    exit 0
}

foreach ($processId in $pids) {
    $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
    $name = if ($proc) { $proc.ProcessName } else { "unknown" }
    $info = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $processId) -ErrorAction SilentlyContinue
    $killPid = $processId
    $scope = "PID $processId ($name)"

    if ($info -and $info.ParentProcessId) {
        $parent = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f ([int]$info.ParentProcessId)) -ErrorAction SilentlyContinue
        if ($parent -and ($parent.Name -ieq "powershell.exe" -or $parent.Name -ieq "pwsh.exe") -and
            $parent.CommandLine -and $parent.CommandLine -match "(?i)(^|[\\/])start\.ps1(?:\s|$)") {
            $killPid = [int]$parent.ProcessId
            $scope = "launcher tree PID $killPid -> node PID $processId"
        }
    }

    Write-Host "Dang tat $scope..." -ForegroundColor Yellow
    $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
    if ($taskkill) {
        & $taskkill.Source /PID $killPid /T /F 2>$null | Out-Null
    } else {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }

    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Process -Id $processId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }
    if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }
}

$remaining = @(netstat -ano | Select-String ":$Port\s" | Select-String "LISTENING")
if ($remaining.Count -gt 0) {
    Write-Host "Khong the giai phong port $Port. Listener con lai:" -ForegroundColor Red
    $remaining | ForEach-Object { Write-Host $_.Line -ForegroundColor Red }
    exit 1
}

Write-Host "Da tat server tren port $Port" -ForegroundColor Green
