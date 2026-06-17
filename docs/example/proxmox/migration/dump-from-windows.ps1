# dump-from-windows.ps1
#
# Run on your CURRENT Windows server to export the live database.
# Requires the MongoDB Database Tools (mongodump) on PATH:
#   https://www.mongodb.com/try/download/database-tools
#
# Usage (PowerShell):
#   .\dump-from-windows.ps1
#
# If your Windows MongoDB has no auth (default localhost install), the URI
# below works as-is. If you set a username/password, add them to the URI:
#   mongodb://user:pass@localhost:27017/open_poll?authSource=admin
# (authSource=admin here is for the OLD box only. The NEW container's app user
#  lives in the open_poll DB, so its connection strings use authSource=open_poll.)

$ErrorActionPreference = "Stop"

$dbName  = "open_poll"
$stamp   = Get-Date -Format "yyyy-MM-dd_HHmm"
$archive = "open_poll_$stamp.archive.gz"

Write-Host "Dumping '$dbName' to $archive ..."
mongodump --uri="mongodb://localhost:27017/$dbName" --archive="$archive" --gzip

Write-Host ""
Write-Host "Done -> $archive"
Write-Host "Copy this file to the DB container, e.g. with WinSCP or scp, then run"
Write-Host "restore-to-ct.sh inside the DB container."
