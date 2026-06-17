# Self‑hosting Open Poll Plus — examples

Pick the environment that matches yours. Everything here is a copy‑paste example —
edit the variables/config for your setup.

## Choose your host

- **Generic Linux / VM / VPS / Raspberry Pi / LXC‑LXD** → [`linux/self_host.md`](linux/self_host.md)
  The classic single‑server guide: install Node + MongoDB, configure, run the app
  (pm2 or systemd), put a reverse proxy with HTTPS in front.

- **Proxmox cluster with HA (auto‑failover)** → [`proxmox/README.md`](proxmox/README.md)
  Two LXC containers (app + MongoDB) as Proxmox **HA** resources on Ceph, deployed
  from the node with one command per CT (`deploy-db-to-ct.sh` / `deploy-app-to-ct.sh`).
  Includes Caddy HTTPS, daily backups, and migration from an existing (e.g. Windows)
  install.

## Reusable across any host

- **The Proxmox in‑CT setup scripts are generic Debian 12 + systemd** — they run on
  any **non‑Proxmox** Debian box/VM/LXC too. Just run them **directly** on the server
  and skip the Proxmox‑only `pct` wrappers + `create-containers.sh` / `ha-setup.sh`:
  - [`proxmox/db/setup-db.in-ct.sh`](proxmox/db/setup-db.in-ct.sh) — MongoDB, hardened
  - [`proxmox/app/setup-app.in-ct.sh`](proxmox/app/setup-app.in-ct.sh) — Node + the app
  - [`proxmox/app/install-caddy.in-ct.sh`](proxmox/app/install-caddy.in-ct.sh) — Caddy HTTPS

  Requirements: **systemd** (so a normal VM/VPS/LXC/LXD — *not* a plain Docker
  container) and, for MongoDB 8.0, an **x86‑64 CPU with AVX** (rules out ARM /
  Raspberry Pi for the DB — use external/Atlas Mongo there). The scripts' only
  Proxmox‑specific bit is a guard that refuses to run on a Proxmox *host*; on any
  other Debian system that guard simply passes.

- **Reverse proxy / HTTPS** (any host):
  - Apache — [`apache/apache-ssl.md`](apache/apache-ssl.md) (simple `/slack/` proxy)
    or [`proxmox/app/apache-vhost.conf`](proxmox/app/apache-vhost.conf) (`/node/<label>/`, multi‑app)
  - Caddy (automatic HTTPS) — [`proxmox/app/Caddyfile`](proxmox/app/Caddyfile) +
    [`proxmox/app/tls-cloudflare-dns.md`](proxmox/app/tls-cloudflare-dns.md) (DNS‑01 cert)

## Common to every method

- **Create the Slack app** (scopes, slash commands, OAuth redirect) — see the
  Slack‑app section of [`linux/self_host.md`](linux/self_host.md).
- **Config:** copy `config/default.json.dist` → `config/default.json` and edit it
  (see the [config reference](../../README.md#self-host-server-configuration-configdefaultjson)).
- **Public webpage / install button:** [`../../webpage.md`](../../webpage.md)
