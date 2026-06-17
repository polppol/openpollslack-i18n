<#
  cert-renew-hook.ps1 - runs AFTER win-acme successfully issues/renews the cert.
  Registered automatically by setup-autocert.ps1 (win-acme --installation script).

  win-acme calls this ONLY on a successful renewal, so reaching this script means
  fresh PEM files exist. It then:
    1. Copies the fresh certificate + private key to the paths YOUR web server reads.
    2. Restarts YOUR service - but ONLY after the copy has succeeded.
    3. Logs every run (success or failure) and prunes its own old log lines.

  Fully self-configured from the block below: edit those values to match
  setup-autocert.ps1 and your server. Under the renewal Scheduled Task this runs as
  SYSTEM via Windows PowerShell 5.1, which can write C:\ and restart services.
#>

param(
    # Passed by win-acme via --scriptparameters "{RenewalId}", for the log only.
    [string]$RenewalId = ''
)

$ErrorActionPreference = 'Stop'

# =========================== settings to review ============================ #
# Source PEM files written by win-acme. $PemWorkDir + $PemName MUST match the
# values in setup-autocert.ps1.
$PemWorkDir = 'C:\cert\_acme'
$PemName    = 'poll'

# Which source file becomes your certificate file:
#   "<name>-chain.pem" = leaf certificate + intermediate chain ("fullchain";
#                        recommended - this is what most servers want).
#   "<name>-crt.pem"   = leaf certificate only (then serve the chain separately).
$SourceCert = Join-Path $PemWorkDir "$PemName-chain.pem"
$SourceKey  = Join-Path $PemWorkDir "$PemName-key.pem"

# Where YOUR web server reads the cert + key (the paths already in your config).
$DestCert = 'C:\cert\cert.crt'
$DestKey  = 'C:\cert\cert.key'

# The Windows service to restart so it loads the new cert. Find the exact name:
#     Get-Service | Where-Object DisplayName -like '*apache*'
# and use its "Name" (not the display name). Leave EMPTY to skip the restart and
# reload your server some other way.
$ServiceName = 'REPLACE_WITH_SERVICE_NAME'

# Log file, and how many days of log lines to keep (older lines are pruned every
# run so nobody has to log in to clean them).
$LogFile     = 'C:\cert\cert-renew-hook.log'
$LogKeepDays = 360
# =========================================================================== #

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    $dir = Split-Path -Parent $LogFile
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -LiteralPath $LogFile -Value $line
    Write-Host $line
}

function Remove-OldLogLines {
    if (-not (Test-Path -LiteralPath $LogFile)) { return }
    $cutoff = (Get-Date).AddDays(-$LogKeepDays)
    # Read fully into memory BEFORE rewriting the same file.
    $keep = @(Get-Content -LiteralPath $LogFile | Where-Object {
        if ($_ -match '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) ') {
            try { [datetime]::ParseExact($Matches[1], 'yyyy-MM-dd HH:mm:ss', $null) -ge $cutoff }
            catch { $true }   # unparseable line -> keep it
        } else { $true }
    })
    # Write a temp sibling then rename, so an interruption can't truncate the live log.
    $tmp = "$LogFile.tmp"
    Set-Content -LiteralPath $tmp -Value $keep
    Move-Item -LiteralPath $tmp -Destination $LogFile -Force
}

try {
    $idMsg = if ($RenewalId) { " (renewal $RenewalId)" } else { '' }
    Write-Log "Post-renewal hook started$idMsg."

    foreach ($f in @($SourceCert, $SourceKey)) {
        if (-not (Test-Path -LiteralPath $f)) {
            throw "Source PEM not found: $f - check that PemWorkDir/PemName match setup-autocert.ps1."
        }
    }

    foreach ($dest in @($DestCert, $DestKey)) {
        $d = Split-Path -Parent $dest
        if ($d -and -not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    }

    # Stage both files, then promote with near-atomic renames. If anything fails
    # midway, the live cert/key are untouched - never a NEW cert paired with the
    # OLD key (a mismatched pair breaks TLS). Both temp files sit on the
    # destination volume, so Move-Item is a metadata rename, not a re-copy.
    $tmpCert = "$DestCert.new"
    $tmpKey  = "$DestKey.new"
    Copy-Item -LiteralPath $SourceCert -Destination $tmpCert -Force
    Copy-Item -LiteralPath $SourceKey  -Destination $tmpKey  -Force
    Move-Item -LiteralPath $tmpCert -Destination $DestCert -Force
    Move-Item -LiteralPath $tmpKey  -Destination $DestKey  -Force
    Write-Log "Installed certificate -> $DestCert and key -> $DestKey."

    # Service restart is reached ONLY because the copy above succeeded.
    if ([string]::IsNullOrWhiteSpace($ServiceName) -or $ServiceName -eq 'REPLACE_WITH_SERVICE_NAME') {
        Write-Log 'No service configured (ServiceName not set); skipping restart - reload your server manually.' 'WARN'
    } else {
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (-not $svc) { throw "Service '$ServiceName' not found. Set ServiceName to the exact Get-Service Name." }
        Write-Log "Restarting service '$ServiceName'..."
        Restart-Service -Name $ServiceName -Force
        $svc = Get-Service -Name $ServiceName
        if ($svc.Status -ne 'Running') {
            throw "Service '$ServiceName' is '$($svc.Status)' after restart (expected Running)."
        }
        Write-Log "Service '$ServiceName' restarted and Running."
    }

    # Housekeeping last, and never fatal: a transiently locked log must not turn a
    # good renewal into a recorded failure.
    try { Remove-OldLogLines } catch { Write-Log "log prune skipped: $($_.Exception.Message)" 'WARN' }

    Write-Log 'Post-renewal hook finished OK.'
    exit 0
}
catch {
    Write-Log $_.Exception.Message 'ERROR'
    Write-Log 'Post-renewal hook FAILED - the cert files and/or service may be stale.' 'ERROR'
    exit 1
}
