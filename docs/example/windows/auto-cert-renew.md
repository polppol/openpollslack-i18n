# Automatic HTTPS certificate renewal on Windows

Automates the whole certificate lifecycle on a Windows server so it never has to
be done by hand: **issue -> renew -> write the new `.crt`/`.key` -> restart the
service**. It replaces the manual "download a new cert, copy the files into place,
restart the server" routine.

This covers **certificate automation only**. It does not configure Apache/IIS/etc.
The scripts write the cert and key to whatever paths you already point your web
server at, and restart whatever service you name.

> **Why not certbot?** EFF discontinued certbot's Windows support in Feb 2024, and
> even before that certbot on Windows never installed the cert for you. The
> maintained Windows tool is **win-acme**, used below.

## What you get

- **[win-acme](https://www.win-acme.com/)** issues a Let's Encrypt certificate
  using the **DNS-01 challenge via Cloudflare** - so **no inbound port 80/443** is
  needed (the same DNS-01 approach the rest of this kit uses; see
  [`../proxmox/app/tls-cloudflare-dns.md`](../proxmox/app/tls-cloudflare-dns.md)).
- win-acme **auto-creates a daily Windows Scheduled Task** that renews ~30 days
  before expiry.
- On each successful renewal a hook script copies the fresh cert/key to your paths
  and restarts your service - **only when issuance actually succeeded**.

Three files (the two `.ps1` scripts each have a `settings to review` block; the
`.bat` is just a launcher — nothing to edit):

| File | Run | Purpose |
|------|-----|---------|
| [`setup-autocert.ps1`](setup-autocert.ps1) | once, as admin | downloads win-acme, issues the cert, registers the hook + Scheduled Task |
| [`cert-renew-hook.ps1`](cert-renew-hook.ps1) | by win-acme, every renewal | copies cert/key to your paths, restarts your service on success |
| [`setup-autocert.bat`](setup-autocert.bat) | optional | double-clickable launcher for `setup-autocert.ps1` (bypasses execution policy) |

## Requirements

- Windows with **Administrator** access.
- Your domain's DNS hosted at **Cloudflare** (DNS-01 writes a temporary
  `_acme-challenge` TXT record through Cloudflare's API).
- A **scoped Cloudflare API token**. Create one at Cloudflare -> My Profile ->
  API Tokens (see [`../proxmox/app/tls-cloudflare-dns.md` -> Step 1](../proxmox/app/tls-cloudflare-dns.md#step-1--create-a-scoped-cloudflare-api-token)
  for the click-path) but with **win-acme's** scope, which differs from that example:
  - **Permissions:** `Zone:DNS:Edit` **and** `Zone:Zone:Read`
  - **Zone Resources:** `All zones` — *not* a single zone, because win-acme looks the
    zone up by name and cannot be locked to one zone.

## Setup

### 1. Configure the hook (`cert-renew-hook.ps1`)

Edit its `settings to review` block:

- `$DestCert` / `$DestKey` - the cert and key paths your web server already reads
  (e.g. `C:\cert\cert.crt` / `C:\cert\cert.key`). The hook overwrites these.
- `$ServiceName` - the exact service name to restart. Find it with:

  ```powershell
  Get-Service | Where-Object DisplayName -like '*apache*'
  ```

  Use the **`Name`** column (not the display name). Leave empty to skip the restart.
- `$PemWorkDir` / `$PemName` - the working folder + filename prefix win-acme exports
  PEM files to. Must match the same two values in `setup-autocert.ps1`.

`$SourceCert` defaults to `<name>-chain.pem` (leaf + intermediate chain = the
"fullchain" most servers want). Switch it to `<name>-crt.pem` if you serve the
chain from a separate file.

### 2. Configure the setup (`setup-autocert.ps1`)

Edit its `settings to review` block: `$Domain`, `$Email`, `$CloudflareToken`, and
the matching `$PemWorkDir` / `$PemName`. Leave `$WacsPath` empty to auto-download
win-acme, or point it at an existing `wacs.exe`.

> Optional dry run: set `$UseStaging = $true` first to issue an **untrusted**
> staging cert (no rate limits) and prove the whole flow, then set it back to
> `$false` and run again for the real certificate.

### 3. Run it once, as Administrator

```powershell
# Elevated PowerShell:
.\setup-autocert.ps1
```

or right-click **`setup-autocert.bat` -> Run as administrator**.

This downloads the win-acme *pluggable* build (the Cloudflare plugin isn't in the
trimmed build), issues the certificate over DNS-01, exports the PEM files, runs the
hook once (copying the files and restarting your service), and registers the daily
renewal Scheduled Task.

### 4. Verify

```powershell
# The renewal task win-acme created:
Get-ScheduledTask | Where-Object TaskName -like 'win-acme*'

# The hook's own log (copies + restarts, one line each):
Get-Content C:\cert\cert-renew-hook.log -Tail 20

# Force a full end-to-end renewal now (re-runs the hook) without waiting for the
# ~30-days-before-expiry trigger.
# Use the wacs.exe that setup downloaded, e.g.:
& .\win-acme\wacs.exe --renew --force
```

## How renewal works from here on

The daily Scheduled Task (runs as **SYSTEM**) checks the cert and renews it ~30
days before expiry. win-acme runs the hook **only after a successful renewal**, so
a failed or not-yet-due check never touches your files or restarts your service.
The hook also restarts the service only after the file copy succeeds, and confirms
the service comes back `Running`. Nothing to do manually again.

## Notes

- **Token storage:** after issuance win-acme keeps its own copy of the token,
  DPAPI-encrypted (machine-scoped) in its renewal config under
  `C:\ProgramData\win-acme`, for the daily renewal task. The token you pasted is
  *also* left in plaintext inside `setup-autocert.ps1` — clear `$CloudflareToken`
  (or delete the script) once setup succeeds, and never commit it. For the strictest
  handling, store the token in win-acme's secret vault and pass
  `--cloudflareapitoken vault://json/<name>`, so it is never inlined or put on a
  command line at all.
- **Private-key permissions:** `setup-autocert.ps1` locks the PEM export folder
  (`$PemWorkDir`) down to SYSTEM + Administrators automatically. It deliberately does
  **not** touch the ACLs on your destination folder (where `$DestCert` / `$DestKey`
  live), so it cannot break your web server's read access — make sure that folder is
  restricted to Administrators/SYSTEM plus your web-server's service account, e.g.
  `icacls C:\cert /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"`
  (add your service account too if it isn't SYSTEM).
- **Scope:** this only manages the certificate. Your web-server config (which port,
  which vhost, where the cert/key live) is yours to set once.

## Alternatives

win-acme is the recommended path. Two others work but have sharper edges on Windows:

- **[Posh-ACME](https://poshac.me/)** (pure PowerShell, great DNS-01 support). The
  renewal task **must run as the same Windows user** that created the order - its
  config and the encrypted Cloudflare token live in that user's profile (DPAPI), so
  a task running as SYSTEM or another account can't decrypt it. There's no built-in
  hook; you wrap deploy/restart in `if ($cert = Submit-Renewal) { ... }`.
- **[acme.sh](https://github.com/acmesh-official/acme.sh)** (via Git Bash/Cygwin;
  `--install-cert --key-file ... --fullchain-file ... --reloadcmd ...`). Its
  auto-generated Windows Scheduled Task is **known to break when Git is under
  `C:\Program Files\`** (the unquoted path fails to launch), so the task often needs
  fixing by hand for unattended use.
