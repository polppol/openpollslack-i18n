#Requires -RunAsAdministrator
<#
  setup-autocert.ps1 - one-time setup of automatic HTTPS certificate renewal on
  Windows, using win-acme (wacs.exe) with the Let's Encrypt DNS-01 challenge via
  Cloudflare. Run this ONCE, as Administrator.

  What it does:
    1. Downloads the win-acme "pluggable" release (or uses the one you point at).
    2. Issues a certificate for your domain, validated over DNS-01 through
       Cloudflare - so NO inbound port 80/443 is required.
    3. Exports it as PEM files to a private working folder.
    4. Registers cert-renew-hook.ps1 as win-acme's post-renewal hook, so on every
       renewal the fresh cert/key are copied to YOUR paths and YOUR service is
       restarted (see cert-renew-hook.ps1 for those settings).
    5. win-acme then auto-creates a daily Windows Scheduled Task that renews ~30
       days before expiry and fires the hook - fully unattended from here on.

  This does NOT change your web-server configuration. You point your server at the
  cert/key paths (one time) yourself.

  Usage (elevated PowerShell):
      .\setup-autocert.ps1
  or right-click setup-autocert.bat -> Run as administrator (it bypasses the
  PowerShell execution policy for you).
#>

$ErrorActionPreference = 'Stop'

# =========================== settings to review ============================ #
# The public hostname(s) on the certificate. Comma-separate for several names;
# a wildcard (*.example.com) is allowed because validation is over DNS-01.
$Domain          = 'poll.example.com'

# Contact email for the Let's Encrypt account (expiry warnings are sent here).
$Email           = 'REPLACE_WITH_YOUR_EMAIL'

# Cloudflare API *token* (NOT the Global API Key). Create it at Cloudflare ->
# My Profile -> API Tokens with permissions Zone:DNS:Edit + Zone:Zone:Read and
# Zone Resources = All zones (it cannot be locked to one zone - win-acme looks the
# zone up by name). NOTE: the value you paste below is PLAINTEXT in this file. Once
# setup succeeds, win-acme keeps its OWN DPAPI-encrypted copy (machine-scoped, under
# C:\ProgramData\win-acme) for renewals, so clear this value (or delete the script)
# and never commit it. For stricter handling, store it in win-acme's secret vault
# and pass --cloudflareapitoken vault://json/<name> instead.
$CloudflareToken = 'REPLACE_WITH_CLOUDFLARE_API_TOKEN'

# Where win-acme writes the freshly-issued PEM files. The hook copies FROM here
# to your real cert/key paths. Keep it private - it holds the private key.
# These two MUST match $PemWorkDir / $PemName in cert-renew-hook.ps1.
$PemWorkDir      = 'C:\cert\_acme'
$PemName         = 'poll'

# Path to wacs.exe. Leave EMPTY to auto-download the latest pluggable x64 release
# into .\win-acme next to this script; or set it to an existing wacs.exe.
$WacsPath        = ''

# The post-renewal hook this script registers with win-acme.
$HookScript      = Join-Path $PSScriptRoot 'cert-renew-hook.ps1'

# $true = dry run against Let's Encrypt STAGING (untrusted cert, no rate limits)
# to prove the whole flow end-to-end; set back to $false for the real cert.
$UseStaging      = $false
# =========================================================================== #

function Assert-Configured {
    param([string]$Name, [string]$Value, [string]$Placeholder)
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -eq $Placeholder) {
        throw "Edit `$$Name at the top of this script first (still set to the placeholder)."
    }
}

function Resolve-Wacs {
    param([string]$Preset)
    if ($Preset) {
        if (-not (Test-Path -LiteralPath $Preset)) { throw "WacsPath '$Preset' was set but not found." }
        return $Preset
    }
    $dir = Join-Path $PSScriptRoot 'win-acme'
    $exe = Join-Path $dir 'wacs.exe'
    if (Test-Path -LiteralPath $exe) { return $exe }

    Write-Host 'Downloading the latest win-acme (pluggable, x64)...'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $headers = @{ 'User-Agent' = 'setup-autocert' }
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/win-acme/win-acme/releases/latest' -Headers $headers
    # The Cloudflare DNS plugin ships only in the "pluggable" build, not the trimmed one.
    $asset = $rel.assets |
        Where-Object { $_.name -match 'pluggable' -and $_.name -match 'x64' -and $_.name -like '*.zip' } |
        Select-Object -First 1
    if (-not $asset) {
        throw "Could not find a pluggable x64 .zip in the latest win-acme release. Download it manually from https://github.com/win-acme/win-acme/releases and set `$WacsPath."
    }
    $zip = Join-Path $env:TEMP $asset.name
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -Headers $headers
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
    Remove-Item -LiteralPath $zip -Force
    if (-not (Test-Path -LiteralPath $exe)) { throw "wacs.exe not found after extracting to $dir." }
    Write-Host "win-acme ready at $exe"
    return $exe
}

function Protect-Dir {
    # Create $Path if needed and restrict it to SYSTEM + Administrators only, so the
    # private key win-acme exports here is not readable by every local user (folders
    # under C:\ otherwise inherit a BUILTIN\Users:Read ACE). SIDs are used instead of
    # names so this works on non-English Windows: *S-1-5-18 = SYSTEM,
    # *S-1-5-32-544 = Administrators.
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
    & icacls $Path /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning "Could not tighten ACLs on $Path - check it is not world-readable." }
}

# --- validate -------------------------------------------------------------- #
Assert-Configured -Name 'Email'           -Value $Email           -Placeholder 'REPLACE_WITH_YOUR_EMAIL'
Assert-Configured -Name 'CloudflareToken' -Value $CloudflareToken -Placeholder 'REPLACE_WITH_CLOUDFLARE_API_TOKEN'
if ($Domain -like '*example.com') {
    throw "Set `$Domain to your real hostname (still 'poll.example.com')."
}
if (-not (Test-Path -LiteralPath $HookScript)) {
    throw "Hook script not found: $HookScript (expected next to this script)."
}

# --- run win-acme ---------------------------------------------------------- #
$wacs = Resolve-Wacs -Preset $WacsPath

# Lock down the PEM export folder BEFORE win-acme writes the private key into it.
Protect-Dir -Path $PemWorkDir

$wacsArgs = @(
    '--source', 'manual',
    '--host', $Domain,
    '--validation', 'cloudflare',
    '--cloudflareapitoken', $CloudflareToken,
    '--store', 'pemfiles',
    '--pemfilespath', $PemWorkDir,
    '--pemfilesname', $PemName,
    '--installation', 'script',
    '--script', $HookScript,
    '--scriptparameters', '{RenewalId}',
    '--accepttos',
    '--emailaddress', $Email
)
if ($UseStaging) {
    Write-Host 'STAGING mode: issuing an untrusted test certificate.'
    $wacsArgs += '--test'
}

# Show the command without leaking the token (it appears verbatim in $wacsArgs).
$display = ($wacsArgs -join ' ') -replace [regex]::Escape($CloudflareToken), '<redacted>'
Write-Host "Running: $wacs $display"
& $wacs @wacsArgs
if ($LASTEXITCODE -ne 0) {
    throw "win-acme exited with code $LASTEXITCODE - certificate was not set up. See win-acme's own log for details."
}

Write-Host ''
Write-Host 'Done. win-acme issued the certificate and ran the post-renewal hook once.'
Write-Host 'A daily Scheduled Task ("win-acme renew (...)") now renews it automatically.'
Write-Host 'Verify it:  Get-ScheduledTask | Where-Object TaskName -like "win-acme*"'
Write-Host 'Force a full end-to-end test now (re-runs the hook):'
Write-Host "    & '$wacs' --renew --force"
Write-Host ''
Write-Host 'SECURITY: win-acme now keeps its own encrypted copy of the Cloudflare token'
Write-Host '  for renewals. The token you pasted is still PLAINTEXT in this script - clear'
Write-Host '  $CloudflareToken (or delete the script) and never commit it.'
