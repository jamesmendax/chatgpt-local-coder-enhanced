<#
Generic launcher for a second (for example ChatGPT Business) OpenAI Secure MCP Tunnel.

Configuration comes from .env and no tunnel ID or Runtime API key is hard-coded.
The Runtime API key is preferably stored as a Windows-DPAPI protected SecureString
in .secrets\business-runtime-key.xml by save-business-key.cmd.
#>

[CmdletBinding()]
param(
    [string]$TunnelId = "",
    [int]$Port = 0,
    [int]$HealthPort = 0,
    [string]$KeyFile = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TunnelExe = Join-Path $ScriptDir "bin\tunnel-client.exe"
$ProfileDir = Join-Path $ScriptDir "profiles"
$ProfileFile = Join-Path $ProfileDir "business-local.yaml"
$DefaultKeyFile = Join-Path $ScriptDir ".secrets\business-runtime-key.xml"

function Get-DotEnvValue([string]$Name) {
    $envFile = Join-Path $ScriptDir ".env"
    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { return $null }
    $line = Get-Content -LiteralPath $envFile | Where-Object {
        $_ -match "^\s*$Name\s*=" -and -not $_.TrimStart().StartsWith("#")
    } | Select-Object -First 1
    if (-not $line) { return $null }
    return (($line -split "=", 2)[1].Trim()).Trim("'").Trim('"')
}

function Ensure-Profile([string]$ResolvedTunnelId, [int]$ResolvedPort, [int]$ResolvedHealthPort) {
    New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
    $yaml = @"
config_version: 1
control_plane:
  tunnel_id: $ResolvedTunnelId
  api_key: env:OPENAI_TUNNEL_API_KEY
log:
  level: info
  format: struct-text
health:
  listen_addr: 127.0.0.1:$ResolvedHealthPort
mcp:
  server_urls:
    - channel: main
      url: http://127.0.0.1:$ResolvedPort/mcp
"@
    Set-Content -LiteralPath $ProfileFile -Value $yaml -Encoding UTF8
}

$resolvedTunnelId = if (-not [string]::IsNullOrWhiteSpace($TunnelId)) {
    $TunnelId.Trim()
} else {
    (Get-DotEnvValue "OPENAI_BUSINESS_TUNNEL_ID")
}
$resolvedPort = if ($Port -gt 0) {
    $Port
} elseif (Get-DotEnvValue "PORT") {
    [int](Get-DotEnvValue "PORT")
} else {
    3000
}
$resolvedHealthPort = if ($HealthPort -gt 0) {
    $HealthPort
} elseif (Get-DotEnvValue "OPENAI_BUSINESS_TUNNEL_HEALTH_PORT") {
    [int](Get-DotEnvValue "OPENAI_BUSINESS_TUNNEL_HEALTH_PORT")
} else {
    8081
}

if ([string]::IsNullOrWhiteSpace($resolvedTunnelId)) {
    throw "OPENAI_BUSINESS_TUNNEL_ID is not configured. Add it to .env or pass -TunnelId."
}
if ($resolvedTunnelId -notmatch '^tunnel_[0-9a-fA-F]{32}$') {
    throw "OPENAI_BUSINESS_TUNNEL_ID must be tunnel_ followed by 32 hex characters."
}
if (-not (Test-Path -LiteralPath $TunnelExe -PathType Leaf)) {
    throw "tunnel-client.exe not found: $TunnelExe. Run .\openai-tunnel.ps1 -Install once first."
}

try {
    $health = Invoke-WebRequest -Uri "http://127.0.0.1:$resolvedPort/health" -UseBasicParsing -TimeoutSec 3
    if ($health.StatusCode -ne 200) {
        throw "Local MCP server returned HTTP $($health.StatusCode)"
    }
} catch {
    throw "Local MCP server is not running on port $resolvedPort. Start .\start.ps1 first. Error: $($_.Exception.Message)"
}

$busy = Get-NetTCPConnection -LocalPort $resolvedHealthPort -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    throw "Port $resolvedHealthPort is already in use. Check the process before starting the Business tunnel."
}

Ensure-Profile -ResolvedTunnelId $resolvedTunnelId -ResolvedPort $resolvedPort -ResolvedHealthPort $resolvedHealthPort

$oldTunnelKey = [Environment]::GetEnvironmentVariable("OPENAI_TUNNEL_API_KEY", "Process")
$oldControlKey = [Environment]::GetEnvironmentVariable("CONTROL_PLANE_API_KEY", "Process")
$oldControlId = [Environment]::GetEnvironmentVariable("CONTROL_PLANE_TUNNEL_ID", "Process")
$secureKey = $null
$keyPtr = [IntPtr]::Zero
$plainKey = $null

try {
    Write-Host "Business tunnel: $resolvedTunnelId" -ForegroundColor Cyan
    Write-Host "Local MCP: http://127.0.0.1:$resolvedPort/mcp" -ForegroundColor Cyan
    Write-Host "Health: http://127.0.0.1:$resolvedHealthPort/readyz" -ForegroundColor Cyan
    Write-Host ""

    $keyPath = if ([string]::IsNullOrWhiteSpace($KeyFile)) { $DefaultKeyFile } else { $KeyFile }
    if (Test-Path -LiteralPath $keyPath -PathType Leaf) {
        try {
            $secureKey = Import-Clixml -LiteralPath $keyPath
        } catch {
            throw "Saved Business Runtime API Key could not be decrypted for this Windows user: $keyPath. Run save-business-key.cmd again."
        }
        if ($secureKey -isnot [System.Security.SecureString]) {
            throw "Saved Business Runtime API Key is not a valid SecureString: $keyPath. Run save-business-key.cmd again."
        }
        Write-Host "Using the encrypted Business Runtime API Key from $keyPath" -ForegroundColor Green
    } else {
        $secureKey = Read-Host "Enter the Business Runtime API Key (hidden; not written to .env)" -AsSecureString
    }

    $keyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPtr)
    if ([string]::IsNullOrWhiteSpace($plainKey)) {
        throw "No Runtime API Key was entered."
    }

    $env:OPENAI_TUNNEL_API_KEY = $plainKey
    $env:CONTROL_PLANE_API_KEY = $plainKey
    $env:CONTROL_PLANE_TUNNEL_ID = $resolvedTunnelId

    Write-Host "Running Business tunnel doctor..." -ForegroundColor Yellow
    $doctorOutput = (& $TunnelExe doctor --profile-file $ProfileFile --explain 2>&1 | Out-String)
    $doctorCode = $LASTEXITCODE
    Write-Host $doctorOutput
    if ($doctorCode -ne 0) {
        $failedChecksMatch = [regex]::Match($doctorOutput, '(?m)^FAILED_CHECKS\s+([^\r\n]+)')
        $failedChecks = if ($failedChecksMatch.Success) { $failedChecksMatch.Groups[1].Value.Trim() } else { "" }
        if ($failedChecks -eq "oauth_metadata") {
            Write-Warning "OAuth metadata is not configured on this local server. If your ChatGPT app is configured with No authentication, this warning is expected."
        } else {
            throw "Doctor failed ($failedChecks). Check that the Runtime key belongs to the Platform organization that owns this tunnel and has Tunnels Read + Use."
        }
    }

    Write-Host ""
    Write-Host "Business tunnel is starting. Keep this terminal open." -ForegroundColor Green
    & $TunnelExe run --profile-file $ProfileFile
    if ($LASTEXITCODE -ne 0) {
        throw "Business tunnel exited with code $LASTEXITCODE"
    }
} finally {
    if ($keyPtr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPtr)
    }
    if ($secureKey) {
        $secureKey.Dispose()
    }
    $plainKey = $null

    if ($null -eq $oldTunnelKey) { Remove-Item Env:OPENAI_TUNNEL_API_KEY -ErrorAction SilentlyContinue } else { $env:OPENAI_TUNNEL_API_KEY = $oldTunnelKey }
    if ($null -eq $oldControlKey) { Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue } else { $env:CONTROL_PLANE_API_KEY = $oldControlKey }
    if ($null -eq $oldControlId) { Remove-Item Env:CONTROL_PLANE_TUNNEL_ID -ErrorAction SilentlyContinue } else { $env:CONTROL_PLANE_TUNNEL_ID = $oldControlId }
}
