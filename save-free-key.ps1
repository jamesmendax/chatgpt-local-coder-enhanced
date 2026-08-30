<#
Save the Free Runtime API Key once for the current Windows user.

The key is entered as a SecureString and exported with Windows DPAPI via
Export-Clixml. The resulting file can be decrypted by the same Windows user
on the same machine; the plaintext key is not written to this script.
#>

[CmdletBinding()]
param(
    [switch]$Prompt
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SecretDir = Join-Path $ScriptDir ".secrets"
$KeyFile = Join-Path $SecretDir "free-runtime-key.xml"

function Get-DotEnvValue([string]$Name) {
    $envFile = Join-Path $ScriptDir ".env"
    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { return $null }
    $line = Get-Content -LiteralPath $envFile | Where-Object {
        $_ -match "^\s*$Name\s*=" -and -not $_.TrimStart().StartsWith("#")
    } | Select-Object -First 1
    if (-not $line) { return $null }
    return (($line -split "=", 2)[1].Trim()).Trim("'").Trim('"')
}

try {
    if (Test-Path -LiteralPath $KeyFile -PathType Leaf) {
        $confirm = Read-Host "An encrypted Free key already exists. Type YES to replace it"
        if ($confirm -cne "YES") {
            Write-Host "Canceled. The existing encrypted key was not changed." -ForegroundColor Yellow
            exit 2
        }
    }

    New-Item -ItemType Directory -Path $SecretDir -Force | Out-Null
    $dotEnvKey = if ($Prompt) { $null } else { Get-DotEnvValue "OPENAI_TUNNEL_API_KEY" }
    if ([string]::IsNullOrWhiteSpace($dotEnvKey)) {
        $secureKey = Read-Host "Enter the Free Runtime API Key once (hidden)" -AsSecureString
    } else {
        Write-Host "Found the existing Free key in .env; encrypting it without displaying it." -ForegroundColor Cyan
        $secureKey = ConvertTo-SecureString $dotEnvKey -AsPlainText -Force
    }
    $dotEnvKey = $null
    if ($secureKey.Length -eq 0) {
        throw "No Free Runtime API Key was entered."
    }

    $secureKey | Export-Clixml -LiteralPath $KeyFile -Force
    Write-Host "Free key saved as an encrypted DPAPI file:" -ForegroundColor Green
    Write-Host $KeyFile -ForegroundColor Green
    Write-Host "It is bound to this Windows user and machine. The plaintext key was not displayed or written." -ForegroundColor Cyan
} finally {
    if ($secureKey) {
        $secureKey.Dispose()
    }
}
