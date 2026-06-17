# Migrating Open Poll Plus to Proxmox (LXC + Ceph, with HA)

This is a complete, copy‑paste example for moving the app off a single Windows
machine onto a **Proxmox cluster with Ceph**, so a node going down for
maintenance (or crashing) no longer takes the app offline.

It targets the common, simple case: **two lightweight LXC containers** — one for
the Node.js app, one for MongoDB — both registered as **Proxmox HA resources**,
fronted by **Caddy running inside the App container** for HTTPS, serving the app
under a `/node/5000/` path prefix. No separate
proxy box, no paid cloud, no load balancers, no database clustering — everything
here is free and open source.

> **This example targets** a brief (~1–2 min) auto‑restart if a node dies, with
> zero/near‑zero downtime for *planned* maintenance. If you want true
> zero‑downtime even on a crash, see [Going further](#going-further).

---

## How it works

```
   Internet ─ HTTPS :443 ─▶ App container (CT 5000)
   (firewall forwards 443;   • Caddy :443  — TLS cert via Cloudflare DNS-01
    Slack → /node/5000/...)  • /node/5000/*  ─ strip prefix ─▶ 127.0.0.1:5000
                             • Node app :5000  (behind Caddy; enable CT firewall to hide :5000)
                             • systemd: openpoll + caddy  ·  HA resource
                                      │
                                      │  mongodb://10.100.51.42:27017
                                      ▼
                            DB container (CT 5010)
                             • MongoDB :27017  — auth, LAN-only  ·  HA resource

   Both CT disks live in Ceph → either CT runs on any node:
     Node dies        → HA reboots the CT on another node (~1–2 min).
     Planned patching → migrate the CT off the node first, then reboot it.
     Disk/OSD dies    → Ceph keeps 3 copies; no downtime, no data loss.
```

**No separate proxy box.** The App container is self‑contained: **Caddy**
terminates HTTPS on `:443` and reverse‑proxies the **Node app on
`localhost:5000`**. There is no separate reverse‑proxy box to stand up or
maintain.

**The `/node/5000/` path prefix.** Slack calls the app at
`https://poll.example.com/node/5000/slack/...`; Caddy **strips** the prefix
before handing the request to Node, which sees the plain `/slack/...` paths. The
prefix is just an example label — use whatever path you register in Slack.

**Why two containers and not one?** You can patch/restart/migrate the app
without touching the database, the DB gets its own RAM limits and backup
schedule, and failover is per‑service.

**Why this survives maintenance:** the container disks live in Ceph, which every
node can read. So any node can run either container — that is what makes HA and
migration "just work."

---

## What's in this folder

```
docs/example/proxmox/
├── README.md                      ← you are here (the runbook)
├── proxmox/
│   ├── create-containers.sh       # pct create both LXC CTs on Ceph
│   └── ha-setup.sh                # register both CTs as HA resources
├── db/
│   ├── deploy-db-to-ct.sh         # RUN ON THE NODE → sets up the whole DB CT  ← use this
│   ├── setup-db.in-ct.sh          # (runs inside CT 5010 — the wrapper runs it)
│   ├── mongod.conf                # reference config (auth + bind + cache)
│   ├── create-app-user.js         # manual user creation (alternative)
│   ├── backup-mongo.sh            # mongodump with rotation (pushed into the CT)
│   ├── mongo-backup.service       # systemd oneshot for the backup
│   └── mongo-backup.timer         # daily backup schedule
├── app/
│   ├── deploy-app-to-ct.sh        # RUN ON THE NODE → sets up the whole app CT  ← use this
│   ├── setup-app.in-ct.sh         # (runs inside CT 5000 — the wrapper runs it)
│   ├── default.json.example       # copy → default.json, fill in; the wrapper pushes it
│   ├── openpoll.service           # systemd unit for the Node app
│   ├── install-caddy.in-ct.sh     # (runs inside CT 5000 — the wrapper runs it)
│   ├── Caddyfile                  # Caddy config: TLS + /node/5000/ → localhost:5000
│   ├── tls-cloudflare-dns.md      # the Cloudflare DNS-01 cert setup Caddy uses
│   └── apache-vhost.conf          # ALTERNATIVE: only if a SEPARATE external proxy fronts it
└── migration/
    ├── dump-from-windows.ps1      # mongodump on the old Windows box
    └── restore-to-ct.sh           # mongorestore into the new DB CT
```

Every script has its settings (IPs, passwords, storage names) as variables at
the top. **Read and edit those before running.** The examples use:

| Thing            | Example value                          |
|------------------|----------------------------------------|
| App container    | ID `5000`, IP `10.100.51.41`, app on `:5000` |
| DB container     | ID `5010`, IP `10.100.51.42`              |
| Ceph storage     | `ceph-ct` (check `pvesm status`)       |
| Bridge / gateway | `vmbr0` / `10.100.51.254`                    |
| HTTPS front door | **Caddy inside the App CT** (`:443`) — no separate proxy box |
| Public host      | `poll.example.com` (your domain → the App CT's `:443`) |
| DB user          | `openpoll` on db `open_poll`           |

> This example assumes the CTs sit on **VLAN 51** (`10.100.51.0/24`, gateway
> `.254`). Change the IPs, gateway, and `VLAN_TAG` in `create-containers.sh` to
> match your network.

---

## Before you start

- A working Proxmox **cluster with quorum** and a healthy **Ceph** pool
  (`ceph -s` is `HEALTH_OK`, pool `size=3/min_size=2`). With 4 nodes you keep
  quorum and full Ceph availability with one node offline.
- A **domain name** for the app (e.g. `poll.example.com`) and a **Cloudflare API
  token** for its zone. Caddy — installed *inside the App container* in Step 4 —
  uses the token to get the TLS cert via the DNS-01 challenge, so you only forward
  **port 443** from your router to the App container (no port 80, no separate
  proxy box; the old Windows Apache is fully replaced).
- Your **Slack app credentials** (`client_id`, `client_secret`,
  `signing_secret`) — already in your current Windows `config/default.json`.

> The whole migration is done **in parallel**: build the new stack while Windows
> keeps serving. The only downtime is a short cutover window at the very end.

---

## Step 1 — Create the two containers

Get this kit onto a Proxmox node (clone the repo or copy `docs/example/proxmox/`)
and `cd` into it — every `bash …/…` and `pct push …/…` command below uses paths
relative to that folder. Then edit the variables in `proxmox/create-containers.sh`
(storage name, template, IPs) and run:

```bash
bash proxmox/create-containers.sh
```

This creates CT `5000` (app) and CT `5010` (db) on Ceph, unprivileged, set to
start on boot. **No root password is set** — you administer the containers from
the Proxmox host with `pct enter 5010` (drops you into a root shell, no login
needed) and copy files in with `pct push 5010 localfile /root/localfile`. Set a
password with `pct exec 5010 -- passwd` only if you want console/SSH login.

> The root filesystem **must** be on Ceph (shared storage). A container on local
> storage cannot be made highly available or migrated.

## Step 2 — Set up MongoDB (CT 5010)

Set `DB_BIND_IP` (the DB CT's IP from `create-containers.sh`) and the two
passwords, then run the deploy wrapper **on the Proxmox node** — it pushes the
scripts into CT 5010 and runs them there for you:

```bash
nano db/setup-db.in-ct.sh    # set DB_BIND_IP + the two passwords
nano db/backup-mongo.sh      # set the same openpoll password
bash db/deploy-db-to-ct.sh   # pushes + runs everything inside CT 5010
```

`deploy-db-to-ct.sh` installs MongoDB 8.0, writes a hardened `/etc/mongod.conf`
(auth on, bound to loopback + the CT's LAN IP only — never the internet),
creates an `admin` user and an `openpoll` app user scoped to `open_poll`, and
enables the daily `mongodump` backup timer. It fails fast (clear message) if the
CPU lacks AVX or a user can't be created, so a green run means success.

## Step 3 — Set up the app + HTTPS (CT 5000)

Prepare three files in the `app/` folder **on the node**, then run one wrapper:

```bash
cp app/default.json.example app/default.json
nano app/default.json        # mongo_url (10.100.51.42 + openpoll password),
                             # client_id / client_secret / signing_secret,
                             # state_secret, oauth_success / oauth_failure
nano app/Caddyfile           # set your real domain (e.g. poll.example.com)
printf 'CF_API_TOKEN=%s\n' 'YOUR_CLOUDFLARE_TOKEN' > app/cloudflare.env

bash app/deploy-app-to-ct.sh  # pushes + sets up everything inside CT 5000
```

`deploy-app-to-ct.sh` installs Node 24 + Yarn 4 and the app under
`/opt/openpollslack-i18n`, pushes your `default.json` (`chmod 600`), starts the
`openpoll` systemd service, then installs Caddy and starts it on `:443` (see
**Step 4** for what Caddy does and how the cert works). A healthy start logs
`Bolt app is running!`. Verify:

```bash
pct exec 5000 -- curl -s http://127.0.0.1:5000/healthz   # {"ok":true,"mongo":"up",...}
```

> **Secrets:** `app/default.json` and `app/cloudflare.env` hold your secrets and
> are git‑ignored. Back them up off‑box (NAS / Proxmox Backup Server) with the
> Mongo dumps — they're the only copy of `state_secret`, the Slack secrets, and
> the Cloudflare token. Ceph protects against a dead disk, not an accidental
> delete or a rebuilt container.

## Step 4 — How HTTPS works (Caddy, set up by Step 3)

`deploy-app-to-ct.sh` already installed and started Caddy inside CT 5000 — this
section just explains it. Caddy terminates HTTPS on `:443`, serves the app under
the **`/node/5000/`** prefix, strips it, and forwards only the app's real paths
(`/slack/*`, `/healthz`, `/ping`) to `localhost:5000`; everything else returns
403. The certificate comes from the **Cloudflare DNS‑01** challenge using the
token from `app/cloudflare.env` — no inbound port 80 needed. Details + how to
create the scoped token: [`app/tls-cloudflare-dns.md`](app/tls-cloudflare-dns.md).

Point your router's **443** forward at the App container (`10.100.51.41`), then:

```bash
pct exec 5000 -- journalctl -u caddy -n 20    # watch it obtain the cert via DNS-01
curl -s https://poll.example.com/node/5000/healthz
```

> **Slack signs each request against the raw body**, so don't add body/charset
> rewriting in the Caddyfile (it doesn't by default). The `/node/5000/` prefix
> doesn't affect the signature (that covers the timestamp + body, not the URL).
>
> **Keep `:5000` off the LAN.** Only `:443` is forwarded from the internet, and
> Caddy reaches the app over `localhost:5000`. But the Node app binds
> `0.0.0.0:5000`, so other hosts on VLAN 51 could hit `http://10.100.51.41:5000`
> directly — bypassing Caddy's TLS and the `/node/5000/` allowlist. Enable the
> Proxmox firewall on CT 5000 and allow inbound only `:443` (drop `:5000`) — see
> the firewall note under Gotchas.
>
> **Already run a separate reverse proxy?** If you'd rather front the app from an
> external Apache/Caddy box instead of Caddy‑in‑the‑CT, see
> [`app/apache-vhost.conf`](app/apache-vhost.conf) (it proxies `/node/5000/` to
> `http://10.100.51.41:5000`). For a clean migration *off* Windows, the
> Caddy‑in‑the‑CT path above is the self‑contained option.

## Step 5 — Update your Slack app's URLs

Because the app now lives under `/node/5000/`, update the request URLs in your
Slack app config (<https://api.slack.com/apps> → your app):

| Setting (Slack app config) | New value |
|---|---|
| Event Subscriptions → Request URL | `https://poll.example.com/node/5000/slack/events` |
| Slash Commands → each command's Request URL | `https://poll.example.com/node/5000/slack/commands` |
| Interactivity & Shortcuts → Request URL | `https://poll.example.com/node/5000/slack/actions` |
| OAuth & Permissions → Redirect URLs (add) | `https://poll.example.com/node/5000/slack/oauth_redirect` |
| Install / re‑install link (open in a browser) | `https://poll.example.com/node/5000/slack/install` |

- **No reinstall needed.** Workspace tokens live in MongoDB and don't depend on
  these URLs, so existing installs keep working. When you save the new Events
  URL, Slack sends a verification challenge that the app answers automatically.
- **Why OAuth still works behind the prefix (no code change):** this app sets
  `redirectUriPath` but no explicit `redirectUri` (`index.js`), so Bolt never
  sends a `redirect_uri` to Slack — it relies on the Redirect URL you register
  above. Slack sends the browser to that prefixed URL; Caddy strips `/node/5000/`;
  the app receives `/slack/oauth_redirect` and completes the install.
  (`stateVerification:false` is a separate setting — it skips the OAuth state‑param
  check — not what makes the prefix work.)

### Optional — running behind a non‑standard external port

If your firewall can't forward 443 (or it's already in use), NAT a different
external port to the App container — e.g. `WAN :1234 → App CT (10.100.51.41) :443`.
HTTPS still works (TLS doesn't care about the port; the cert is bound to the
hostname, not a port), with three adjustments:

- **Caddy still listens on 443 inside the CT** — do *not* change the Caddyfile
  site address. The custom port lives only in the firewall NAT rule and in the
  public URLs.
- **Issue the cert via the Cloudflare DNS‑01 challenge**
  ([`app/tls-cloudflare-dns.md`](app/tls-cloudflare-dns.md)). HTTP‑01 needs
  inbound port 80 and TLS‑ALPN‑01 needs inbound 443 — neither is forwarded
  here — but DNS‑01 needs no inbound port at all.
- **Put the port in every Slack URL**, e.g.
  `https://poll.example.com:1234/node/5000/slack/events` (and `commands`,
  `actions`, `oauth_redirect`, `install`). Slack has no documented port
  restriction — it needs HTTPS, a publicly‑trusted cert, and a passing
  verification challenge — and it checks the Events URL the moment you save it,
  so you'll know immediately. OAuth still works because the app uses the redirect
  URL you *register* (port and all), not one it generates.

## Step 6 — Migrate the data + cut over

All Slack tokens live in MongoDB, so once the data and config are in place and
your router forwards 443 to the App container (where Caddy terminates HTTPS), the
app just keeps working.

**Dry run first** (Windows stays live):

```powershell
# on the Windows server (PowerShell, MongoDB Database Tools installed):
.\dump-from-windows.ps1            # -> open_poll_<date>.archive.gz
```

```bash
# copy the archive to the DB CT (WinSCP/scp), then:
pct push 5010 open_poll_<date>.archive.gz /root/dump.archive.gz
pct push 5010 migration/restore-to-ct.sh  /root/restore-to-ct.sh
pct enter 5010
nano /root/restore-to-ct.sh       # set the openpoll password
bash /root/restore-to-ct.sh /root/dump.archive.gz
```

> **Do the App container's first start now, during the dry run — not in the
> cutover window.** On first start the app runs its DB migrations *before* the
> web server comes up (`migrations.migrate()` in `index.js`). If your Windows
> data already migrated (it has, since it runs this same app version) this is a
> quick no‑op; but if you ever import very old, pre‑migration data, the one‑time
> votes‑collection rewrite can run long and must not be interrupted. Either way,
> watch the logs for `End database migration.` followed by `Bolt app is
> running!` before trusting it. Doing it here means the cutover re‑sync starts
> from an already‑migrated database and comes up fast.

Confirm your real workspaces/polls are present (`/healthz` green, counts look
right).

**Cutover window** (the only downtime — a few minutes):

1. **Stop** the old Windows app (so no new votes land mid‑copy).
2. Re‑run `dump-from-windows.ps1` and `restore-to-ct.sh` to catch the last
   changes (`--drop` makes the restore safe to repeat).
3. **Repoint the firewall:** move your router's port‑443 forward from the
   Windows box to the App container (`10.100.51.41`). Your domain and the
   `/node/5000/` Slack URLs stay the same, so Slack needs no reconfiguration.
4. Confirm `https://poll.example.com/node/5000/healthz` is green and run `/poll` in Slack.

Leave Windows powered off for a day or two as a fallback, then decommission it.

## Step 7 — Turn on Proxmox HA

```bash
# on any node, after both containers work:
bash proxmox/ha-setup.sh
ha-manager status        # both ct:5000 and ct:5010 should be "started"
```

Now if a node fails, the HA manager restarts the affected container on a
surviving node automatically.

## Step 8 — Verify failover (recommended)

Prove it works before you rely on it:

- **Planned migration:** in the Proxmox UI, **Migrate** CT 5000 to another node.
  It restarts there in seconds; Slack keeps working. Do the same for CT 5010.
- **Simulated crash:** hard‑stop the node currently running CT 5000 (or
  `ha-manager crm-command` it). Within ~1–2 minutes HA reboots the container on
  another node and `/healthz` goes green again.

---

## Maintenance routine

When you need to patch/reboot a node:

```bash
ceph osd set noout                 # don't rebalance during a short reboot
# In the Proxmox UI: migrate that node's containers to other nodes
#   (or: pct migrate 5000 <targetnode> --restart)
# reboot/patch the now-empty node
ceph osd unset noout
```

Because the containers move off first, the app stays up across the reboot.

---

## Updating the app & managing files in the containers

### Getting files in and out (no SSH needed)
From a **Proxmox node** (the host) you can manage a container's files without
running SSH inside it — the simplest and lowest‑attack‑surface path:

| Task | Command (run on a Proxmox node) |
|---|---|
| Copy a file **in** | `pct push 5000 ./default.json /opt/openpollslack-i18n/config/default.json` |
| Copy a file **out** | `pct pull 5000 /opt/openpollslack-i18n/logs/2026-06-17_app.log ./out.log` |
| Open a root shell | `pct enter 5000` (then edit with `nano`/`vi`) |
| Run one command | `pct exec 5000 -- systemctl restart openpoll` |

From your **Windows desktop** you *can* use **WinSCP** / `scp`, but only after
installing an SSH server in the container (`apt-get install -y openssh-server`).
That adds attack surface and another service to patch, so prefer
`pct push` / `pct enter` from the Proxmox host for occasional edits — enable SSH
only if you really want desktop drag‑and‑drop.

> After editing `config/default.json`, restart the app so it re‑reads it
> (`systemctl restart openpoll`). Keep that file `chmod 600` and owned by the
> `openpoll` user — it holds secrets.

### Updating the app to a new version
The code is a git clone at `/opt/openpollslack-i18n`. **Snapshot first** so you
can roll back instantly if a release misbehaves (Ceph snapshots are fast):

```bash
# on a Proxmox node — safety net before any update:
pct snapshot 5000 pre-update            # roll back with: pct rollback 5000 pre-update

pct enter 5000
cd /opt/openpollslack-i18n
git pull                               # latest of the current branch (master by default)
# — or deploy a specific version instead of tracking master:
#   git fetch --tags --prune origin && git checkout 4.1.1.1   # a release tag (list: git tag)
corepack yarn install --immutable      # sync deps to that ref's yarn.lock
chown -R openpoll:openpoll .           # setup ran as root; keep ownership correct
systemctl restart openpoll
journalctl -u openpoll -f              # expect "Bolt app is running!"
```

- The app runs any pending **DB migrations on startup**, before it serves
  traffic — watch for `End database migration.` then `Bolt app is running!`
  (same caveat as Step 6).
- If a release bumps the **Node major version**, re‑run the Node install step
  from `app/setup-app.in-ct.sh` first.
- The **DB container** is updated separately: snapshot CT 5010, then
  `apt-get update && apt-get upgrade` inside it, one MongoDB minor series at a
  time. Your nightly `mongodump` is the extra safety net.

---

## Gotchas / troubleshooting

- **Slack URLs return 404 / the app sees `/node/5000/slack/...`** → the prefix
  isn't being stripped. In the Caddyfile that's `handle_path /node/5000/* { … }`
  (not plain `handle`); on an external Apache it's the **trailing slash** on
  `ProxyPass /node/5000/ http://…:5000/`. The app must receive plain `/slack/...`.
- **Every Slack request fails signature check** → something rewrote the request
  body (a proxy body filter), or the clock is off. A container inherits time
  from its Proxmox **host**, so run NTP/chrony on the **host nodes** (you can't
  enable NTP inside an unprivileged CT). Slack rejects requests whose timestamp
  is off by more than ~5 minutes.
- **App logs "Failed to connect to MongoDB"** → check `mongo_url` host/password,
  that `authSource=open_poll` matches where the user was created, and that
  `bindIp` in `mongod.conf` includes the DB CT's IP. Test from CT 5000:
  `mongosh "mongodb://openpoll:<pw>@10.100.51.42:27017/open_poll?authSource=open_poll" --eval 'db.runCommand({ping:1})'`
- **`mongod` dies immediately on start** → MongoDB 5.0+ needs a CPU with AVX
  (`lscpu | grep -i avx`); `setup-db.in-ct.sh` now checks this up front. Also note
  `vm.max_map_count` is set on the **host**, not inside the unprivileged CT.
- **HA won't relocate a container** → its disk must be on shared storage (Ceph),
  not local. Check with `pct config 5000 | grep rootfs`.
- **Lock MongoDB down further (defense in depth):** `bindIp` keeps Mongo off the
  internet; also enable the Proxmox firewall on CT 5010 to accept `27017` only
  from CT 5000's IP, and never port‑forward 27017.
- **Lock down the App CT too:** the Node app binds `0.0.0.0:5000`, so on the LAN
  it's reachable directly (bypassing Caddy + TLS). Enable the Proxmox firewall on
  CT 5000 with inbound `ACCEPT tcp dport 443` (+ established/related) and drop the
  rest — that exposes only HTTPS and hides `:5000` from VLAN 51.
- **502 right after a reboot/failover is normal:** Caddy answers `:443` at once,
  but `/node/5000/*` returns 502 until the app finishes its startup migrations and
  logs `Bolt app is running!`. Point uptime checks at `/healthz` and treat a brief
  startup 502 as expected.
- **Quorum note:** 4 nodes tolerate **one** node down at a time for HA; don't
  take two down together, or the cluster loses quorum and HA pauses. (A corosync
  QDevice on a small always‑on box adds a tie‑breaker vote if you want to
  survive a 2‑node split — optional.)
- **Logs are self‑maintaining — no login needed.** The app auto‑**deletes** its
  own rotated `logs/` older than `log_max_files` (set to `360d` in
  `default.json.example`; it's a winston‑daily‑rotate‑file retention, e.g. `30d`
  / `365d` — change to taste). journald already auto‑caps by size out of the box;
  tighten it with `SystemMaxUse=200M` in `/etc/systemd/journald.conf` if you like.
  MongoDB's `/var/log/mongodb/mongod.log` is rotated by `setup-db.in-ct.sh`
  (logrotate, daily, keeps `MONGO_LOG_KEEP_DAYS=360` days — configurable). So all
  three log sources stay bounded with no manual cleanup.

---

## Going further

You don't need this now, but it's good to know: this app's scheduler is already
**safe to run on multiple instances at once** — each scheduled poll is claimed
with an atomic MongoDB update (`index.js`, `checkAndExecuteTasks`), so two app
copies never double‑post. If a ~1–2 min restart ever becomes unacceptable, you
can later run **two App containers active‑active** behind the same proxy
(load‑balanced) with a **MongoDB replica set**, and a node failure becomes ~0
downtime. That's more moving parts — only do it if you actually need it.

---

## Quick reference

| Action | Command |
|---|---|
| Enter a container | `pct enter 5000` |
| Copy a file in | `pct push 5000 local /root/local` |
| App logs | `journalctl -u openpoll -f` |
| App health (on the CT) | `curl -s http://127.0.0.1:5000/healthz` |
| App health (via proxy) | `curl -s https://poll.example.com/node/5000/healthz` |
| Restart app | `systemctl restart openpoll` |
| Mongo shell | `mongosh "mongodb://openpoll:<pw>@127.0.0.1:27017/open_poll?authSource=open_poll"` |
| HA status | `ha-manager status` |
| Migrate a CT | `pct migrate 5000 <node> --restart` |
| Manual backup | `/usr/local/bin/backup-mongo.sh` |
