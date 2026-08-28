[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("StartFree", "StopFree", "StartBusiness", "StopBusiness")]
    [string]$Action
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $Root

$McpPort = 3000
$AdminPort = 3001
$FreeHealthPort = 8080
$BusinessHealthPort = 8081
$FreeProfile = "codex-local.yaml"
$BusinessProfile = "business-local.yaml"

$ServerScript = Join-Path $Root "start.ps1"
$FreeScript = Join-Path $Root "openai-tunnel.ps1"
$BusinessScript = Join-Path $Root "openai-tunnel-business.ps1"
$TunnelExe = Join-Path $Root "bin\tunnel-client.exe"
$FreeKeyFile = Join-Path $Root ".secrets\free-runtime-key.xml"
$BusinessKeyFile = Join-Path $Root ".secrets\business-runtime-key.xml"

function Require-File([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label not found: $Path"
    }
}

function Get-DotEnvValue([string]$Name) {
    if (-not (Test-Path -LiteralPath ".env" -PathType Leaf)) { return $null }
    $line = Get-Content -LiteralPath ".env" | Where-Object {
        $_ -match "^\s*$Name\s*=" -and -not $_.TrimStart().StartsWith("#")
    } | Select-Object -First 1
    if (-not $line) { return $null }
    return (($line -split "=", 2)[1].Trim()).Trim("'").Trim('"')
}

function Get-ListeningPids([int]$Port) {
    $pids = @()
    try {
        $pids += @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess)
    } catch {}

    if ($pids.Count -eq 0) {
        $lines = netstat -ano | Select-String ":$Port\s" | Select-String "LISTENING"
        foreach ($line in $lines) {
            $parts = ($line -replace "\s+", " ").ToString().Trim().Split(" ")
            if ($parts.Count -gt 0) {
                $candidate = 0
                if ([int]::TryParse($parts[-1], [ref]$candidate) -and $candidate -gt 0) {
                    $pids += $candidate
                }
            }
        }
    }

    return @($pids | ForEach-Object { [int]$_ } | Sort-Object -Unique)
}

function Get-ProcessInfo([int]$ProcessId) {
    return Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $ProcessId) -ErrorAction SilentlyContinue
}

function Test-Ready([int]$Port) {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/readyz" -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -eq 200 -and ([string]$response.Content -match "(?i)ready")
    } catch {
        return $false
    }
}

function Get-McpHealth {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$McpPort/health" -TimeoutSec 2
        if ($health.status -eq "ok" -and $health.name -eq "codex-mcp-server") {
            return $health
        }
    } catch {}
    return $null
}

function Wait-For([scriptblock]$Test, [int]$TimeoutSeconds, [string]$Description) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (& $Test) { return $true }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    Write-Warning "$Description was not ready within $TimeoutSeconds seconds."
    return $false
}

function Start-ProjectPowerShell([string]$ScriptPath, [string[]]$Arguments) {
    $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath)
    if ($Arguments) { $args += $Arguments }
    return Start-Process -FilePath $powershell -ArgumentList $args -WorkingDirectory $Root -WindowStyle Normal -PassThru
}

function Find-TunnelProcess([int]$Port, [string]$ProfileName) {
    foreach ($owner in (Get-ListeningPids $Port)) {
        $info = Get-ProcessInfo $owner
        if (-not $info) { continue }
        if ($info.Name -ieq "tunnel-client.exe" -and
            $info.CommandLine -and
            $info.CommandLine.IndexOf($ProfileName, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $info
        }
    }
    return $null
}

function Find-RoleLauncher([string]$ScriptName) {
    $result = @()
    foreach ($info in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue)) {
        if ($info.CommandLine -and $info.CommandLine.IndexOf($ScriptName, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $result += $info
        }
    }
    return @($result)
}

function Test-RoleActivity([int]$Port, [string]$ProfileName, [string]$ScriptName) {
    if ((Get-ListeningPids $Port).Count -gt 0) { return $true }
    if (Find-TunnelProcess $Port $ProfileName) { return $true }
    if ((Find-RoleLauncher $ScriptName).Count -gt 0) { return $true }
    return $false
}

function Ensure-SharedMcpServer {
    $health = Get-McpHealth
    if ($health) {
        Write-Host "[Shared MCP] already running on port $McpPort; workspace: $($health.workspace)" -ForegroundColor Green
        return
    }

    if ((Get-ListeningPids $McpPort).Count -gt 0) {
        throw "Port $McpPort is occupied by a process that is not the expected MCP server. Nothing was stopped."
    }

    $mutex = New-Object -TypeName System.Threading.Mutex -ArgumentList $false, "Local\ChatGPTLocalCoder-McpStart"
    $hasMutex = $false
    try {
        try {
            $hasMutex = $mutex.WaitOne(0)
        } catch [System.Threading.AbandonedMutexException] {
            $hasMutex = $true
        }

        if (-not $hasMutex) {
            if (Wait-For { $null -ne (Get-McpHealth) } 35 "Shared MCP server") { return }
            throw "Another launcher is starting the MCP server, but it did not become healthy. Check the server window."
        }

        $health = Get-McpHealth
        if ($health) {
            Write-Host "[Shared MCP] another launcher completed startup; workspace: $($health.workspace)" -ForegroundColor Green
            return
        }
        if ((Get-ListeningPids $McpPort).Count -gt 0) {
            throw "Port $McpPort became occupied by an unknown process. Nothing was stopped."
        }

        Require-File $ServerScript "Shared MCP start script"
        Require-File (Join-Path $Root "dist\index.js") "Built MCP server"
        Require-File (Join-Path $Root ".env") ".env"

        $serverProcess = Start-ProjectPowerShell $ServerScript @()
        Write-Host "[Shared MCP] started server window (PID $($serverProcess.Id)); waiting for /health..." -ForegroundColor Cyan
        if (-not (Wait-For { $null -ne (Get-McpHealth) } 35 "Shared MCP server")) {
            throw "Shared MCP server did not become healthy. Inspect the server window; no process was force-killed."
        }
        $health = Get-McpHealth
        Write-Host "[Shared MCP] ready; workspace: $($health.workspace)" -ForegroundColor Green
    } finally {
        if ($hasMutex) {
            try { $mutex.ReleaseMutex() } catch {}
        }
        $mutex.Dispose()
    }
}

function Start-RoleTunnel([string]$Role, [int]$HealthPort, [string]$ScriptPath, [string]$ProfileName) {
    if (Test-Ready $HealthPort) {
        Write-Host "[$Role] tunnel already ready on port $HealthPort; no duplicate process started." -ForegroundColor Green
        return
    }

    if ((Get-ListeningPids $HealthPort).Count -gt 0) {
        throw "[$Role] port $HealthPort is occupied but is not a ready tunnel. Nothing was stopped."
    }

    Require-File $TunnelExe "tunnel-client.exe"
    Require-File $ScriptPath "$Role tunnel script"

    if ($Role -eq "Free") {
        Require-File (Join-Path $Root ".env") ".env"
        if ([string]::IsNullOrWhiteSpace((Get-DotEnvValue "OPENAI_TUNNEL_ID"))) {
            throw "[Free] OPENAI_TUNNEL_ID is missing from .env. No tunnel was started."
        }
        if (-not (Test-Path -LiteralPath $FreeKeyFile -PathType Leaf) -and
            [string]::IsNullOrWhiteSpace((Get-DotEnvValue "OPENAI_TUNNEL_API_KEY"))) {
            throw "[Free] no encrypted key file or OPENAI_TUNNEL_API_KEY was found. Run save-free-key.cmd once. No tunnel was started."
        }
    }

    $child = if ($Role -eq "Free") {
        Start-ProjectPowerShell $ScriptPath @("-Port", "$McpPort", "-HealthPort", "$HealthPort")
    } else {
        Start-ProjectPowerShell $ScriptPath @()
    }

    Write-Host "[$Role] tunnel window started (PowerShell PID $($child.Id))." -ForegroundColor Cyan
    if ($Role -eq "Free" -and (Test-Path -LiteralPath $FreeKeyFile -PathType Leaf)) {
        Write-Host "[Free] using the encrypted key saved for this Windows user; no key prompt is expected." -ForegroundColor Green
    }
    if ($Role -eq "Business") {
        if (Test-Path -LiteralPath $BusinessKeyFile -PathType Leaf) {
            Write-Host "[Business] using the encrypted key saved for this Windows user; no key prompt is expected." -ForegroundColor Green
            if (-not (Wait-For { Test-Ready $HealthPort } 45 "Business tunnel")) {
                throw "[Business] tunnel did not become ready. Check the Business window and the saved key; no process was force-killed."
            }
            Write-Host "[Business] tunnel is ready." -ForegroundColor Green
        } else {
            Write-Host "[Business] no saved key found; enter the hidden key in the new window, or run save-business-key.cmd once." -ForegroundColor Yellow
            if (Test-Ready $HealthPort) {
                Write-Host "[Business] tunnel is ready." -ForegroundColor Green
            } else {
                Write-Host "[Business] waiting for key input. Check http://127.0.0.1:$HealthPort/readyz after entering it." -ForegroundColor Yellow
            }
        }
        return
    }

    if (-not (Wait-For { Test-Ready $HealthPort } 45 "Free tunnel")) {
        throw "[Free] tunnel did not become ready. Inspect the Free tunnel window; no process was force-killed."
    }
    Write-Host "[Free] tunnel ready on http://127.0.0.1:$HealthPort/readyz." -ForegroundColor Green
}

function Stop-Role([string]$Role, [int]$HealthPort, [string]$ProfileName, [string]$ScriptName) {
    $tunnel = Find-TunnelProcess $HealthPort $ProfileName
    $launchers = @(Find-RoleLauncher $ScriptName)

    if (-not $tunnel -and $launchers.Count -eq 0) {
        if ((Get-ListeningPids $HealthPort).Count -gt 0 -or (Test-Ready $HealthPort)) {
            throw "[$Role] port $HealthPort is active, but the process is not recognized as this project's tunnel. Nothing was stopped."
        }
        Write-Host "[$Role] tunnel is not running." -ForegroundColor Yellow
        return $false
    }

    if ($tunnel) {
        Write-Host "[$Role] stopping tunnel process PID $($tunnel.ProcessId)..." -ForegroundColor Yellow
        Stop-Process -Id ([int]$tunnel.ProcessId) -Force -ErrorAction SilentlyContinue
    }

    foreach ($launcher in $launchers) {
        if ($launcher.ProcessId -ne $PID) {
            Write-Host "[$Role] closing launcher window PID $($launcher.ProcessId)..." -ForegroundColor Yellow
            Stop-Process -Id ([int]$launcher.ProcessId) -Force -ErrorAction SilentlyContinue
        }
    }

    if (-not (Wait-For { (Get-ListeningPids $HealthPort).Count -eq 0 } 10 "$Role tunnel shutdown")) {
        throw "[$Role] tunnel port $HealthPort is still in use. Nothing else was stopped."
    }
    Write-Host "[$Role] tunnel stopped." -ForegroundColor Green
    return $true
}

function Stop-SharedMcpIfUnused {
    if ((Test-RoleActivity $FreeHealthPort $FreeProfile "openai-tunnel.ps1") -or
        (Test-RoleActivity $BusinessHealthPort $BusinessProfile "openai-tunnel-business.ps1")) {
        Write-Host "[Shared MCP] kept running because the other account still has activity." -ForegroundColor Cyan
        return
    }

    $health = Get-McpHealth
    if (-not $health) {
        Write-Host "[Shared MCP] no healthy shared server to stop." -ForegroundColor Yellow
        return
    }

    $stopped = $false
    foreach ($owner in (Get-ListeningPids $McpPort)) {
        $info = Get-ProcessInfo $owner
        if ($info -and $info.Name -ieq "node.exe" -and $info.CommandLine -match "dist[\\/]index\.js") {
            Write-Host "[Shared MCP] stopping expected server process PID $($info.ProcessId)..." -ForegroundColor Yellow
            Stop-Process -Id ([int]$info.ProcessId) -Force -ErrorAction SilentlyContinue
            $stopped = $true
        }
    }

    if (-not $stopped) {
        throw "Shared MCP health is up, but its port owner is not the expected dist/index.js Node process. Nothing was stopped."
    }
    if (-not (Wait-For { (Get-ListeningPids $McpPort).Count -eq 0 } 10 "Shared MCP shutdown")) {
        throw "Shared MCP port $McpPort is still in use. Inspect it manually."
    }
    Write-Host "[Shared MCP] stopped because neither account has an active tunnel." -ForegroundColor Green
}

try {
    switch ($Action) {
        "StartFree" {
            Ensure-SharedMcpServer
            Start-RoleTunnel "Free" $FreeHealthPort $FreeScript $FreeProfile
        }
        "StartBusiness" {
            Ensure-SharedMcpServer
            Start-RoleTunnel "Business" $BusinessHealthPort $BusinessScript $BusinessProfile
        }
        "StopFree" {
            if (Stop-Role "Free" $FreeHealthPort $FreeProfile "openai-tunnel.ps1") { Stop-SharedMcpIfUnused }
        }
        "StopBusiness" {
            if (Stop-Role "Business" $BusinessHealthPort $BusinessProfile "openai-tunnel-business.ps1") { Stop-SharedMcpIfUnused }
        }
    }
    exit 0
} catch {
    Write-Host "[ONE-CLICK ERROR] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
