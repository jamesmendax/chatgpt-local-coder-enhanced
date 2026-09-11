[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("StartFree", "StopFree", "StartBusiness", "StopBusiness", "RestartMcp", "StatusMcp")]
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

function Test-ProcessAlive([int]$ProcessId) {
    return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Stop-ProjectProcessTree([int]$ProcessId, [string]$Label) {
    if (-not (Test-ProcessAlive $ProcessId)) { return }

    Write-Host "[$Label] terminating process tree PID $ProcessId..." -ForegroundColor Yellow
    $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
    if ($taskkill) {
        & $taskkill.Source /PID $ProcessId /T /F 2>$null | Out-Null
    }

    if (Wait-For { -not (Test-ProcessAlive $ProcessId) } 8 "$Label PID $ProcessId exit") {
        return
    }

    Write-Warning "[$Label] PID $ProcessId survived taskkill; retrying with Stop-Process -Force."
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    if (-not (Wait-For { -not (Test-ProcessAlive $ProcessId) } 4 "$Label PID $ProcessId forced exit")) {
        throw "[$Label] PID $ProcessId could not be terminated."
    }
}

function Get-ExpectedMcpLauncher([object]$NodeProcess) {
    if (-not $NodeProcess -or -not $NodeProcess.ParentProcessId) { return $null }
    $parent = Get-ProcessInfo ([int]$NodeProcess.ParentProcessId)
    if (-not $parent) { return $null }
    if ($parent.Name -ine "powershell.exe" -and $parent.Name -ine "pwsh.exe") { return $null }
    if (-not $parent.CommandLine -or $parent.CommandLine -notmatch "(?i)(^|[\\/])start\.ps1(?:\s|$)") { return $null }
    return $parent
}

function Stop-McpProcessTree([object]$NodeProcess, [string]$Reason = "requested stop") {
    if (-not $NodeProcess) { return }
    $targetPid = [int]$NodeProcess.ProcessId
    if (-not (Test-ProcessAlive $targetPid)) { return }

    $launcher = Get-ExpectedMcpLauncher $NodeProcess
    $killPid = if ($launcher) { [int]$launcher.ProcessId } else { $targetPid }
    $scope = if ($launcher) { "launcher tree PID $killPid -> node PID $targetPid" } else { "node tree PID $targetPid" }
    Write-Host "[Shared MCP] terminating $scope ($Reason)..." -ForegroundColor Yellow

    $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
    if ($taskkill) {
        & $taskkill.Source /PID $killPid /T /F 2>$null | Out-Null
    } else {
        Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
    }

    if (-not (Wait-For { -not (Test-ProcessAlive $targetPid) } 6 "Shared MCP PID $targetPid exit")) {
        Write-Warning "PID $targetPid survived the first termination attempt; retrying the node process directly."
        if ($taskkill) {
            & $taskkill.Source /PID $targetPid /T /F 2>$null | Out-Null
        }
        Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
        if (-not (Wait-For { -not (Test-ProcessAlive $targetPid) } 4 "Shared MCP PID $targetPid forced exit")) {
            throw "Shared MCP PID $targetPid could not be terminated even after taskkill /T /F and Stop-Process -Force."
        }
    }

    if ($launcher -and (Test-ProcessAlive ([int]$launcher.ProcessId))) {
        Stop-Process -Id ([int]$launcher.ProcessId) -Force -ErrorAction SilentlyContinue
    }
}

function Ensure-McpPortReleased([int]$FormerPid) {
    if (Wait-For { (Get-ListeningPids $McpPort).Count -eq 0 } 3 "Shared MCP port release") { return }

    foreach ($owner in (Get-ListeningPids $McpPort)) {
        $info = Get-ProcessInfo $owner
        if ($info -and $info.Name -ieq "node.exe" -and $info.CommandLine -match "dist[\\/]index\.js") {
            Write-Warning "Port $McpPort is still owned by project MCP PID $owner after stopping PID $FormerPid; cleaning that MCP instance too."
            Stop-McpProcessTree $info "port cleanup after PID $FormerPid"
        }
    }

    if (-not (Wait-For { (Get-ListeningPids $McpPort).Count -eq 0 } 8 "Shared MCP port release")) {
        $owners = @()
        foreach ($owner in (Get-ListeningPids $McpPort)) {
            $info = Get-ProcessInfo $owner
            if ($info) { $owners += "PID $owner $($info.Name): $($info.CommandLine)" }
            else { $owners += "PID $owner (process details unavailable)" }
        }
        throw "Shared MCP port $McpPort is still in use after terminating PID $FormerPid. Owner(s): $($owners -join ' | ')"
    }
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

function Get-LatestDistWriteTimeUtc {
    $dist = Join-Path $Root "dist"
    if (-not (Test-Path -LiteralPath $dist -PathType Container)) { return $null }
    $latest = Get-ChildItem -LiteralPath $dist -Recurse -File -Filter "*.js" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if ($latest) { return $latest.LastWriteTimeUtc }
    return $null
}

function Get-DistRuntimeManifest {
    $manifestModule = Join-Path $Root "dist\lib\runtime-manifest.js"
    if (-not (Test-Path -LiteralPath $manifestModule -PathType Leaf)) { return $null }
    try {
        $javascript = "import 'dotenv/config'; import { getRuntimeManifest } from './dist/lib/runtime-manifest.js'; console.log(JSON.stringify(getRuntimeManifest()));"
        $json = & node --input-type=module -e $javascript 2>$null
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace(($json -join "`n"))) {
            return (($json -join "`n") | ConvertFrom-Json)
        }
    } catch {}
    return $null
}

function Get-ExpectedMcpProcess {
    foreach ($owner in (Get-ListeningPids $McpPort)) {
        $info = Get-ProcessInfo $owner
        if ($info -and $info.Name -ieq "node.exe" -and $info.CommandLine -match "dist[\\/]index\.js") {
            return $info
        }
    }
    return $null
}

function Get-McpRuntimeState {
    $health = Get-McpHealth
    $expectedManifest = Get-DistRuntimeManifest
    if (-not $health) {
        return [pscustomobject]@{
            Running = $false
            Health = $null
            Process = $null
            Stale = $false
            Reason = "MCP health endpoint is not available."
            DistLatestUtc = Get-LatestDistWriteTimeUtc
            ProcessStartedUtc = $null
            ExpectedManifest = $expectedManifest
        }
    }

    $processInfo = Get-ExpectedMcpProcess
    $processStartedUtc = $null
    if ($processInfo) {
        try {
            $processStartedUtc = (Get-Process -Id ([int]$processInfo.ProcessId) -ErrorAction Stop).StartTime.ToUniversalTime()
        } catch {}
    }
    $distLatestUtc = Get-LatestDistWriteTimeUtc

    $runtimeSaysStale = $false
    if ($health.runtime -and $null -ne $health.runtime.stale_build) {
        $runtimeSaysStale = [bool]$health.runtime.stale_build
    }
    $mtimeSaysStale = $false
    if ($distLatestUtc -and $processStartedUtc) {
        $mtimeSaysStale = $distLatestUtc -gt $processStartedUtc.AddSeconds(1)
    }
    $manifestSaysStale = $false
    if ($expectedManifest -and $health.runtime -and $health.runtime.tool_manifest_hash) {
        $manifestSaysStale = [string]$expectedManifest.tool_manifest_hash -ne [string]$health.runtime.tool_manifest_hash
    }
    $stale = $runtimeSaysStale -or $manifestSaysStale -or $mtimeSaysStale
    $reason = if ($runtimeSaysStale) {
        "The running process reports that its loaded build is older than the current dist files."
    } elseif ($manifestSaysStale) {
        "The running process tool manifest does not match the current dist manifest."
    } elseif ($mtimeSaysStale) {
        "The newest dist file is newer than the running Node process."
    } else {
        "The running MCP matches the current dist build."
    }

    return [pscustomobject]@{
        Running = $true
        Health = $health
        Process = $processInfo
        Stale = $stale
        Reason = $reason
        DistLatestUtc = $distLatestUtc
        ProcessStartedUtc = $processStartedUtc
        ExpectedManifest = $expectedManifest
    }
}

function Write-McpRuntimeState([object]$State) {
    if (-not $State.Running) {
        Write-Host "[Shared MCP] not running." -ForegroundColor Yellow
        if ($State.DistLatestUtc) {
            Write-Host "[Shared MCP] latest dist: $($State.DistLatestUtc.ToString('u'))"
        }
        if ($State.ExpectedManifest) {
            Write-Host "[Current dist] build=$($State.ExpectedManifest.build_id) tools=$($State.ExpectedManifest.tool_count) manifest=$(([string]$State.ExpectedManifest.tool_manifest_hash).Substring(0,12))" -ForegroundColor Cyan
            Write-Host "[Current dist] tools: $((@($State.ExpectedManifest.tool_names)) -join ', ')"
        }
        return
    }

    $health = $State.Health
    $pidText = if ($State.Process) { [string]$State.Process.ProcessId } else { "unknown" }
    $build = if ($health.runtime -and $health.runtime.build_id) { [string]$health.runtime.build_id } else { "legacy/unknown" }
    $toolCount = if ($health.runtime -and $null -ne $health.runtime.tool_count) { [string]$health.runtime.tool_count } else { "unknown" }
    $manifest = if ($health.runtime -and $health.runtime.tool_manifest_hash) { ([string]$health.runtime.tool_manifest_hash).Substring(0, [Math]::Min(12, ([string]$health.runtime.tool_manifest_hash).Length)) } else { "unknown" }
    $color = if ($State.Stale) { "Red" } else { "Green" }

    Write-Host "[Shared MCP] PID=$pidText build=$build tools=$toolCount manifest=$manifest" -ForegroundColor $color
    if ($State.ProcessStartedUtc) { Write-Host "[Shared MCP] process started: $($State.ProcessStartedUtc.ToString('u'))" }
    if ($State.DistLatestUtc) { Write-Host "[Shared MCP] latest dist:    $($State.DistLatestUtc.ToString('u'))" }
    Write-Host "[Shared MCP] $($State.Reason)" -ForegroundColor $color
    if ($State.ExpectedManifest) {
        $expectedHash = ([string]$State.ExpectedManifest.tool_manifest_hash).Substring(0, [Math]::Min(12, ([string]$State.ExpectedManifest.tool_manifest_hash).Length))
        Write-Host "[Current dist] build=$($State.ExpectedManifest.build_id) tools=$($State.ExpectedManifest.tool_count) manifest=$expectedHash" -ForegroundColor Cyan
        Write-Host "[Current dist] tools: $((@($State.ExpectedManifest.tool_names)) -join ', ')"
    }
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
    foreach ($info in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        if ($info.Name -match '(?i)^(powershell|pwsh)\.exe$' -and
            $info.CommandLine -and
            $info.CommandLine.IndexOf($ScriptName, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
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
    $state = Get-McpRuntimeState
    if ($state.Running) {
        Write-McpRuntimeState $state
        if ($state.Stale) {
            Write-Warning "Shared MCP is healthy but its loaded build is older than dist. Continuing so the selected tunnel can start; run restart-mcp.cmd later if you need to reload the newest build."
        }
        Write-Host "[Shared MCP] already running on port $McpPort." -ForegroundColor Green
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
            $state = Get-McpRuntimeState
            Write-McpRuntimeState $state
            if ($state.Stale) {
                Write-Warning "Another launcher started a healthy MCP process with an older build. Continuing with that running server."
            }
            Write-Host "[Shared MCP] another launcher completed startup." -ForegroundColor Green
            return
        }
        if ((Get-ListeningPids $McpPort).Count -gt 0) {
            throw "Port $McpPort became occupied by an unknown process. Nothing was stopped."
        }

        Require-File $ServerScript "Shared MCP start script"
        Require-File (Join-Path $Root "dist\index.js") "Built MCP server"
        Require-File (Join-Path $Root ".env") ".env"

        $serverProcess = Start-ProjectPowerShell $ServerScript @("-SkipBuild")
        Write-Host "[Shared MCP] started server window (PID $($serverProcess.Id)); waiting for /health..." -ForegroundColor Cyan
        if (-not (Wait-For { $null -ne (Get-McpHealth) } 35 "Shared MCP server")) {
            throw "Shared MCP server did not become healthy. Inspect the server window; no process was force-killed."
        }
        $health = Get-McpHealth
        $state = Get-McpRuntimeState
        Write-McpRuntimeState $state
        if ($state.Stale) {
            Write-Warning "Shared MCP started and is healthy, but its loaded build is older than dist. Run restart-mcp.cmd later if you need to reload the newest build."
        }
        Write-Host "[Shared MCP] ready." -ForegroundColor Green
    } finally {
        if ($hasMutex) {
            try { $mutex.ReleaseMutex() } catch {}
        }
        $mutex.Dispose()
    }
}

function Restart-SharedMcp {
    $state = Get-McpRuntimeState
    if ($state.Running) {
        Write-McpRuntimeState $state
        if (-not $state.Process) {
            throw "Port $McpPort is healthy, but the owner is not the expected node dist/index.js process. Nothing was stopped."
        }
        $oldPid = [int]$state.Process.ProcessId
        Stop-McpProcessTree $state.Process "restart"
        Ensure-McpPortReleased $oldPid
    }

    Require-File $ServerScript "Shared MCP start script"
    Require-File (Join-Path $Root ".env") ".env"
    $serverProcess = Start-ProjectPowerShell $ServerScript @()
    Write-Host "[Shared MCP] restart window started (PID $($serverProcess.Id)); waiting for current build..." -ForegroundColor Cyan
    if (-not (Wait-For { $null -ne (Get-McpHealth) } 60 "Shared MCP restart")) {
        throw "Shared MCP did not become healthy. Inspect the server window. Tunnels were not touched."
    }
    $newState = Get-McpRuntimeState
    Write-McpRuntimeState $newState
    if ($newState.Stale) {
        throw "Restart completed, but the loaded build is still stale. Inspect build output before scanning the App."
    }
    Write-Host "[Shared MCP] restart complete. Tunnels were left running." -ForegroundColor Green
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

    foreach ($launcher in $launchers) {
        if ($launcher.ProcessId -ne $PID) {
            Stop-ProjectProcessTree ([int]$launcher.ProcessId) "$Role launcher"
        }
    }

    if ($tunnel -and (Test-ProcessAlive ([int]$tunnel.ProcessId))) {
        Stop-ProjectProcessTree ([int]$tunnel.ProcessId) "$Role tunnel"
    }

    $remainingTunnel = Find-TunnelProcess $HealthPort $ProfileName
    $remainingLaunchers = @(Find-RoleLauncher $ScriptName | Where-Object { $_.ProcessId -ne $PID })
    if ($remainingTunnel -or $remainingLaunchers.Count -gt 0) {
        $remaining = @()
        if ($remainingTunnel) { $remaining += "tunnel PID $($remainingTunnel.ProcessId)" }
        foreach ($remainingLauncher in $remainingLaunchers) { $remaining += "launcher PID $($remainingLauncher.ProcessId)" }
        throw "[$Role] matching process still exists after termination: $($remaining -join ', ')"
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
    $lastStoppedPid = 0
    foreach ($owner in (Get-ListeningPids $McpPort)) {
        $info = Get-ProcessInfo $owner
        if ($info -and $info.Name -ieq "node.exe" -and $info.CommandLine -match "dist[\\/]index\.js") {
            $lastStoppedPid = [int]$info.ProcessId
            Stop-McpProcessTree $info "shared MCP no longer needed"
            $stopped = $true
        }
    }

    if (-not $stopped) {
        throw "Shared MCP health is up, but its port owner is not the expected dist/index.js Node process. Nothing was stopped."
    }
    Ensure-McpPortReleased $lastStoppedPid
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
        "RestartMcp" {
            Restart-SharedMcp
        }
        "StatusMcp" {
            Write-McpRuntimeState (Get-McpRuntimeState)
        }
    }
    exit 0
} catch {
    Write-Host "[ONE-CLICK ERROR] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
