<#
Save the Business Runtime API Key once for the current Windows user.

The key is entered as a SecureString and exported with Windows DPAPI via
Export-Clixml. The resulting file can be decrypted by the same Windows user
on the same machine; the plaintext key is not written to this script.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SecretDir = Join-Path $ScriptDir ".secrets"
$KeyFile = Join-Path $SecretDir "business-runtime-key.xml"

try {
    if (Test-Path -LiteralPath $KeyFile -PathType Leaf) {
        $confirm = Read-Host "An encrypted Business key already exists. Type YES to replace it"
        if ($confirm -cne "YES") {
            Write-Host "Canceled. The existing encrypted key was not changed." -ForegroundColor Yellow
            exit 2
        }
    }

    New-Item -ItemType Directory -Path $SecretDir -Force | Out-Null
    $secureKey = Read-Host "Enter the Business Runtime API Key once (hidden)" -AsSecureString
    if ($secureKey.Length -eq 0) {
        throw "No Business Runtime API Key was entered."
    }

    $secureKey | Export-Clixml -LiteralPath $KeyFile -Force
    Write-Host "Business key saved as an encrypted DPAPI file:" -ForegroundColor Green
    Write-Host $KeyFile -ForegroundColor Green
    Write-Host "It is bound to this Windows user and machine. The plaintext key was not displayed or written." -ForegroundColor Cyan
} finally {
    if ($secureKey) {
        $secureKey.Dispose()
    }
}
