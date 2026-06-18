# Deploying Open Poll Plus on Proxmox (LXC + Ceph, with HA)

This is a complete, copy‑paste example for running Open Poll Plus on a **Proxmox
cluster with Ceph**, so a node going down for maintenance (or crashing) no longer
takes the app offline. It works for a **brand‑new install** *and* for **moving an
existing server** (e.g. off a single Windows box) onto Proxmox — the setup is
identical either way; migrating just adds **one optional step** at the end to
restore your data ([Step 6](#step-6--go-live-optionally-restore-from-an-existing-install)).

It targets the common, simple case: **two lightweight LXC containers** — one for
the Node.js app, one for MongoDB — both registered as **Proxmox HA resources**,
fronted by **Caddy running inside the App container** for HTTPS, serving the app
under a `/node/5000/` path prefix. No paid cloud, no load balancers, no database
clustering — everything here is free and open source.

That bundled shape is the **default**. If you want to run **several independent
Open Poll Plus deployments** (e.g. production + dev, or several workspaces)
behind one front door, there is also a **split** topology: a dedicated
reverse‑proxy container fronting many app‑only containers — see
[Bundled vs Split](#bundled-vs-split--which-do-i-want) below.

> **The deploy scripts are interactive.** Every value shown in this guide
> (CT ids `5000`/`5010`, IPs, storage names, …) is just an **example default** —
> each `bash …/deploy-*.sh` / `create-containers.sh` **prompts** you for it,
> Enter keeps the default, a typed value overrides. Run with `NONINTERACTIVE=1`
> (or `--yes`) to accept all defaults. **HTTPS is optional too** — pick Cloudflare
> auto‑certs *or* a manual cert you install yourself (see [TLS](#step-4--how-https-works-caddy-set-up-by-step-3)).

> **This example targets** a brief (~1–2 min) auto‑restart if a node dies, with
> zero/near‑zero downtime for *planned* maintenance. If you want true
> zero‑downtime even on a crash, see [Going further](#going-further).

---

## How it works

**Bundled topology (the default).** Caddy lives in the App CT. (The CT ids below
are example defaults — the scripts prompt you for them.)

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

**No separate proxy box (in the bundled topology).** The App container is
self‑contained: **Caddy** terminates HTTPS on `:443` and reverse‑proxies the
**Node app on `localhost:5000`**. There is no separate reverse‑proxy box to stand
up or maintain. (The split topology trades this for one shared rproxy CT — see
[Bundled vs Split](#bundled-vs-split--which-do-i-want).)

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

## Bundled vs Split — which do I want?

| | **Bundled** (default) | **Split** |
|---|---|---|
| Layout | Caddy + Node app in ONE App CT | One **reverse‑proxy CT** + N **app‑only CTs** |
| Good for | a single deployment | **several independent** deployments behind one domain |
| HTTPS | terminated in the App CT | terminated once in the rproxy CT |
| Deploy | `deploy-app-to-ct.sh` | `deploy-app-to-ct.sh --app-only` (×N) + `deploy-rproxy-to-ct.sh` |

**Most people want bundled.** Choose **split** when you run **more than one
independent Open Poll Plus instance** — e.g. a *production* app and a *dev* app,
or one per customer — and want a single front door. Each instance is a **separate
Slack app** (its own `signing_secret`/`client_id`/OAuth) with **its own database**
(its own `mongo_url`/`mongo_db_name`). The reverse proxy only routes by path — it
cannot share Slack credentials or data across backends.

```
                         ┌───────────────────────────────────────────┐
   Internet ─HTTPS:443─▶ │ Reverse‑proxy CT (example 5030)            │
   (router → rproxy CT)  │  • Caddy :443 — TLS once for your domain   │
                         │  • /node/5000/* ─▶ 10.100.51.61:5000  (prod)│
                         │  • /node/5001/* ─▶ 10.100.51.63:5001  (dev) │
                         └───────────────────────────────────────────┘
                              │ http (LAN)            │ http (LAN)
                              ▼                        ▼
                  App CT "prod" (5000)        App CT "dev" (5001)
                   • Node app only             • Node app only
                   • own Slack app             • own Slack app
                          │                           │
                          ▼                           ▼
                   db open_poll_prod          db open_poll_dev   (one DB CT, or several)
```

- **Each `/node/<port>/` is a different Slack app.** Register that instance's
  Request URLs in its **own** Slack app config (Step 5), under its own prefix.
  Pointing one Slack app at two prefixes will not work — only one backend's
  `signing_secret` matches, the other 401s every request.
- **Each instance gets its own database.** Use a distinct `mongo_db_name`
  (e.g. `open_poll_prod`, `open_poll_dev`); add the extra DB + user with
  `db/create-app-user.js` (no MongoDB reinstall). Two *different* Slack apps must
  **not** share one database — their per‑team documents collide.
- **The rproxy is a single point of failure** for everything behind it (see
  [Step 7](#step-7--turn-on-proxmox-ha) — register it as an HA resource).

Split‑topology steps are flagged **“(split)”** inline in the steps below.

---

## What's in this folder

```
docs/example/proxmox/
├── README.md                      ← you are here (the runbook)
├── lib/                           # shared helpers the node-run wrappers source
│   ├── ask.sh                     #   interactive prompts (ask / ask_secret / confirm)
│   ├── caddy.sh                   #   fill the Caddyfile TLS line from TLS_MODE
│   └── secrets.sh                 #   xtrace-safe token fill (default.json secrets)
├── proxmox/
│   ├── create-containers.sh       # pct create the LXC CTs on Ceph (DB + App, optional rproxy)
│   └── ha-setup.sh                # register the CTs as HA resources
├── db/
│   ├── deploy-db-to-ct.sh         # RUN ON THE NODE → sets up the whole DB CT  ← use this
│   ├── setup-db.in-ct.sh          # (runs inside the DB CT — the wrapper runs it)
│   ├── mongod.conf                # reference config (auth + bind + cache)
│   ├── create-app-user.js         # add ANOTHER db + user (a 2nd instance), no reinstall
│   ├── backup-mongo.sh            # mongodump with rotation (pushed into the CT)
│   ├── mongo-backup.service       # systemd oneshot for the backup
│   └── mongo-backup.timer         # daily backup schedule
├── app/
│   ├── deploy-app-to-ct.sh        # RUN ON THE NODE → sets up an app CT (bundled, or --app-only)  ← use this
│   ├── setup-app.in-ct.sh         # (runs inside the App CT — the wrapper runs it)
│   ├── update-app-to-ct.sh        # RUN ON THE NODE → snapshot + update an app CT to a new version  ← use this
│   ├── update-app.in-ct.sh        # (runs inside the App CT — the update wrapper runs it)
│   ├── default.json.example       # copy → default.json, fill in; the wrapper pushes it
│   ├── openpoll.service           # systemd unit for the Node app
│   ├── install-caddy.in-ct.sh     # (runs inside the CT that terminates TLS — App or rproxy)
│   ├── Caddyfile                  # BUNDLED Caddy config: TLS + /node/5000/ → localhost:5000
│   ├── tls-cloudflare-dns.md      # TLS options: Cloudflare DNS-01, certbot, acme.sh, or manual
│   └── apache-vhost.conf          # ALTERNATIVE: only if a SEPARATE external Apache fronts it
├── rproxy/                        # SPLIT topology — a standalone reverse-proxy CT
│   ├── deploy-rproxy-to-ct.sh     # RUN ON THE NODE → sets up the rproxy CT  ← use this (split)
│   └── Caddyfile.multi            # multi-backend Caddy config: /node/<port>/ → each app CT
└── migration/
    ├── dump-from-windows.ps1      # mongodump on the old Windows box
    └── restore-to-ct.sh           # mongorestore into the new DB CT
```

Each node‑run script has its settings (IPs, ids, storage names) as variables at
the top **and prompts you for them** (Enter keeps the default). Passwords + the
Cloudflare token are prompted **hidden**. The example defaults:

| Thing            | Example value                          |
|------------------|----------------------------------------|
| App container    | ID `5000`, IP `10.100.51.41`, app on `:5000` |
| DB container     | ID `5010`, IP `10.100.51.42`              |
| Rproxy container | ID `5030`, IP `10.100.51.40` (**split** only) |
| Ceph storage     | `ceph-ct` (check `pvesm status`)       |
| Bridge / gateway | `vmbr0` / `10.100.51.254`                    |
| HTTPS front door | **Caddy** — in the App CT (bundled) or the rproxy CT (split), `:443` |
| TLS              | Cloudflare DNS‑01 auto‑cert (default), or a manual cert you install |
| Public host      | `poll.example.com` (your domain → whatever terminates `:443`) |
| DB user / db     | `openpoll` on db `open_poll` (per instance, e.g. `open_poll_dev`) |

> This example assumes the CTs sit on **VLAN 51** (`10.100.51.0/24`, gateway
> `.254`). Change the IPs, gateway, and `VLAN_TAG` in `create-containers.sh` to
> match your network.

---

## Before you start

- A working Proxmox **cluster with quorum** and a healthy **Ceph** pool
  (`ceph -s` is `HEALTH_OK`, pool `size=3/min_size=2`). With 4 nodes you keep
  quorum and full Ceph availability with one node offline.
- A **domain name** for the app (e.g. `poll.example.com`). For the default TLS
  mode, a **Cloudflare API token** for its zone — Caddy uses it to get the cert via
  the DNS-01 challenge, so you only forward **port 443** from your router (no port
  80). (Or pick `TLS_MODE=manual` and install your own cert — no token needed.)
- Your **Slack app credentials** (`client_id`, `client_secret`, `signing_secret`)
  — from your Slack app at <https://api.slack.com/apps> (create one if this is a
  new install). **Migrating?** They're already in your existing
  `config/default.json`.

> **Migrating from an existing server?** You can build the whole new stack **in
> parallel** while the old box keeps serving, then do the optional data restore +
> cutover ([Step 6](#step-6--go-live-optionally-restore-from-an-existing-install))
> last — the only downtime is a short cutover window. A fresh install has no
> cutover at all.

---

## Step 1 — Create the two containers

Get this kit onto a Proxmox node (clone the repo or copy `docs/example/proxmox/`)
and `cd` into it — every `bash …/…` and `pct push …/…` command below uses paths
relative to that folder. Then run:

```bash
bash proxmox/create-containers.sh
```

It **prompts** for the storage name, template, bridge/VLAN/gateway and each CT's
id/host/IP/size (Enter keeps the shown default), and asks whether to also create a
**reverse‑proxy CT** (answer yes for the **split** topology). This creates CT
`5000` (app) and CT `5010` (db) — plus the rproxy CT if you enabled it — on Ceph,
unprivileged, set to start on boot. To add **another** app instance later, re‑run
it with a different App id/host/IP (existing CTs are skipped; a clashing IP is
rejected). **No root password is set** — you administer the containers from
the Proxmox host with `pct enter 5010` (drops you into a root shell, no login
needed) and copy files in with `pct push 5010 localfile /root/localfile`. Set a
password with `pct exec 5010 -- passwd` only if you want console/SSH login.

> The root filesystem **must** be on Ceph (shared storage). A container on local
> storage cannot be made highly available or migrated.

## Step 2 — Set up MongoDB (the DB CT)

Run the deploy wrapper **on the Proxmox node** — it prompts for the DB CT id,
bind IP, app user/database name, and the two MongoDB passwords (**hidden**), then
pushes the scripts into the DB CT and runs them there for you:

```bash
bash db/deploy-db-to-ct.sh   # prompts, then sets up everything inside the DB CT
```

> Prefer to type nothing? Pass values as env:
> `NONINTERACTIVE=1 ADMIN_DB_PASS=… APP_DB_PASS=… bash db/deploy-db-to-ct.sh`.
> Secrets are never written into the kit's tracked files — the passwords go
> straight into the CT (the backup credential lands in a root‑only
> `/etc/openpoll/mongo-backup.env` the timer reads). Use a **URI‑safe** password
> (it goes into a `mongodb://…` string) or URL‑encode reserved characters.

`deploy-db-to-ct.sh` installs MongoDB (**7.0 by default** — safe on every current
kernel, incl. ≥ 6.19; pick 8.0 at the prompt only on a host kernel ≤ 6.18), writes a hardened `/etc/mongod.conf`
(auth on, bound to loopback + the CT's LAN IP only — never the internet),
creates an `admin` user and your app user scoped to its database, and enables the
daily `mongodump` backup timer. It fails fast (clear message) if the CPU lacks
AVX or a user can't be created, so a green run means success.

> **(split)** For a second independent instance sharing this DB CT, give it its
> own database + user (e.g. `open_poll_dev`) **without** reinstalling MongoDB —
> see `db/create-app-user.js`.

## Step 3 — Set up the app + HTTPS (the App CT)

Copy the config template and set the values that aren't secrets, then run the
wrapper — it **prompts** for the App CT id/port, whether to install Caddy here,
the TLS mode, and (hidden) the Slack secrets + Cloudflare token:

```bash
cp app/default.json.example app/default.json
nano app/default.json        # mongo_url HOST (+ db name), oauth_success/oauth_failure,
                             # your domain. The Slack secrets + mongo password can be
                             # answered at the prompts instead (hidden) — or set here.
nano app/Caddyfile           # BUNDLED only: set your real domain (poll.example.com)

bash app/deploy-app-to-ct.sh             # BUNDLED: app + Caddy in this CT
# or, for the split topology (no Caddy here):
bash app/deploy-app-to-ct.sh --app-only  # SPLIT: app only, fronted by the rproxy CT
```

`deploy-app-to-ct.sh` installs Node 24 + Yarn 4 and the app under
`/opt/openpollslack-i18n`, pushes your `default.json` (`chmod 600`), starts the
`openpoll` systemd service, and — unless `--app-only` — installs Caddy on `:443`
(see **Step 4**). At the prompts it offers to fill the Slack secrets in
`default.json` (hidden, never echoed); the **mongo password** you set by hand in
the `mongo_url` line. A healthy start logs `Bolt app is running!`. Verify:

```bash
pct exec 5000 -- curl -s http://127.0.0.1:5000/healthz   # {"ok":true,"mongo":"up",...}
```

> **(split)** Run `deploy-app-to-ct.sh --app-only` **once per instance** (edit
> `app/default.json` for each instance's Slack app + database before each run).
> No Caddyfile or Cloudflare token is needed on app‑only CTs — those live on the
> rproxy CT. After the app CTs are up, do **Step 3b**.

> **Secrets:** `app/default.json` and `app/cloudflare.env` hold your secrets and
> are git‑ignored. Back them up off‑box (NAS / Proxmox Backup Server) with the
> Mongo dumps — they're the only copy of `state_secret`, the Slack secrets, and
> the Cloudflare token. Ceph protects against a dead disk, not an accidental
> delete or a rebuilt container.

## Step 3b — Set up the reverse proxy (split topology only)

Skip this for the bundled setup. With your app‑only CTs running, point the proxy
at them and bring up HTTPS in one place:

```bash
nano rproxy/Caddyfile.multi   # set your domain + one backend block per instance, e.g.:
                              #   handle_path /node/5000/* {
                              #       import app_backend 10.100.51.61:5000
                              #   }
bash rproxy/deploy-rproxy-to-ct.sh   # prompts rproxy CT id + TLS mode (+ CF token, hidden)
```

`deploy-rproxy-to-ct.sh` installs Caddy in the rproxy CT (reusing the same
installer as the bundled path), finalizes the TLS line from your chosen mode,
validates the config, and starts Caddy. Each `/node/<port>/` backend is a
**separate Slack app + database** — register its URLs in its own Slack app
(Step 5), and give it its own `mongo_db_name`.

## Step 4 — How HTTPS works (Caddy, set up by Step 3)

Step 3 already installed and started Caddy (in the App CT for bundled, the rproxy
CT for split) — this section just explains it. Caddy terminates HTTPS on `:443`,
serves the app under the **`/node/<port>/`** prefix, strips it, and forwards only
the app's real paths (`/slack/*`, `/healthz`, `/ping`) to the app; everything else
returns 403.

**TLS mode (you chose this at the prompt).**
- **`cloudflare`** (default): the certificate comes from the **Cloudflare DNS‑01**
  challenge using the token you entered — no inbound port 80 needed. Details + how
  to create the scoped token: [`app/tls-cloudflare-dns.md`](app/tls-cloudflare-dns.md).
- **`manual`**: Caddy is installed with **no** auto‑cert and needs **no** token —
  the deploy writes a `tls <cert> <key>` line and you drop your own cert/key in
  (or run your own certbot/acme.sh). See *Option D* in
  [`app/tls-cloudflare-dns.md`](app/tls-cloudflare-dns.md).

Point your router's **443** forward at the App CT's IP (whatever you set — the
demo scripts use `10.100.51.41` as the example), then:

```bash
pct exec 5000 -- journalctl -u caddy -n 20    # watch it obtain the cert via DNS-01
curl -s https://poll.example.com/node/5000/healthz
```

> **Slack signs each request against the raw body**, so don't add body/charset
> rewriting in the Caddyfile (it doesn't by default). The `/node/5000/` prefix
> doesn't affect the signature (that covers the timestamp + body, not the URL).
>
> **Keep `:5000` off the LAN (bundled).** Only `:443` is forwarded from the
> internet, and Caddy reaches the app over `localhost:5000`. But the Node app
> binds `0.0.0.0:5000`, so other hosts on VLAN 51 could hit the app directly at
> `http://<App-CT-IP>:5000` (the demo's `10.100.51.41`) — bypassing Caddy's TLS
> and the `/node/5000/` allowlist. Enable the Proxmox firewall on the App CT and allow
> inbound only `:443` (drop `:5000`) — see the firewall note under Gotchas.
>
> **(split)** In the split topology the app CTs run **no Caddy** and the rproxy
> CT reaches them over the LAN at `:5000`, so the rule is different: the app CT
> ACCEPTs `:5000` **only from the rproxy CT's IP** (and has no `:443`); the rproxy
> CT ACCEPTs `:443`. Exact per‑role rules are under Gotchas.
>
> **Already run a separate reverse proxy?** If you'd rather front the app from an
> external Apache/Caddy box instead of Caddy‑in‑the‑CT, see
> [`app/apache-vhost.conf`](app/apache-vhost.conf) (it proxies `/node/5000/` to
> `http://10.100.51.41:5000`). If you don't already run one, the Caddy‑in‑the‑CT
> path above is the self‑contained option (nothing external to maintain).

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
- **(split)** Do this **per instance**, each in its **own** Slack app: production
  under `/node/5000/`, dev under `/node/5001/`, etc. Each app's five URLs use its
  own prefix and its own `signing_secret`/`client_id`. The reverse proxy routes by
  path only — one Slack app pointed at two prefixes will fail signature checks on
  the backend whose `signing_secret` doesn't match.

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

## Step 6 — Go live (optionally restore from an existing install)

The stack is now running. **A fresh install has nothing to migrate** — just go
live:

1. Point your router's **443** at whatever terminates TLS — the **App CT**
   (bundled) or the **rproxy CT** (split), e.g. `10.100.51.41`.
2. Confirm it's reachable: `curl -s https://poll.example.com/node/5000/healthz`.
3. **Install it into Slack:** open the install URL in a browser —
   `https://poll.example.com/node/5000/slack/install` — to add the app to your
   workspace, then run `/poll`.

That's it: the app starts with an empty database and fills as people use it. (No
migration, no cutover.) Skip the rest of this step unless you're moving data from
an existing server.

### Optional — restore data from an existing Open Poll Plus server

Do this **only if** you're moving from an existing install (a Windows box, or
anywhere) and want your workspaces, polls and scheduled polls to carry over. All
Slack tokens live in MongoDB, so restoring the database is all it takes — your
domain and Slack URLs don't change, so Slack needs no reconfiguration.

**Dry run first** (the old server stays live — build the new stack in parallel):

```powershell
# on the OLD server (PowerShell + MongoDB Database Tools; dump-from-windows.ps1 shown):
.\dump-from-windows.ps1            # -> open_poll_<date>.archive.gz
```

```bash
# copy the archive to the DB CT (scp/WinSCP), then on a Proxmox node:
pct push 5010 open_poll_<date>.archive.gz /root/dump.archive.gz
pct push 5010 migration/restore-to-ct.sh  /root/restore-to-ct.sh
# restore (pass the openpoll password as env — set APP_DB_NAME too for a non-default db):
pct exec 5010 -- env APP_DB_PASS='your-openpoll-password' \
  bash /root/restore-to-ct.sh /root/dump.archive.gz
```

> **Watch the first start.** On first start the app runs its DB migrations
> *before* the web server comes up (`migrations.migrate()` in `index.js`). If your
> existing data is already on this app version (likely — same app) it's a quick
> no‑op; importing very old, pre‑migration data can run long and must not be
> interrupted. Watch the logs for `End database migration.` then
> `Bolt app is running!`. Doing the restore during the dry run means the final
> cutover re‑sync starts from an already‑migrated DB and comes up fast.

Confirm your real workspaces/polls are present (`/healthz` green, counts look
right).

**Cutover window** (the only downtime — a few minutes):

1. **Stop** the old app (so no new votes land mid‑copy).
2. Re‑run the dump + `restore-to-ct.sh` to catch the last changes (`--drop` makes
   the restore safe to repeat).
3. **Repoint the firewall:** move your router's port‑443 forward from the old box
   to the new front door (your front-door CT's IP — `10.100.51.41` is just the
   demo's example). Your domain and the `/node/5000/` Slack
   URLs stay the same, so Slack needs no reconfiguration.
4. Confirm `https://poll.example.com/node/5000/healthz` is green and run `/poll` in Slack.

Leave the old server off for a day or two as a fallback, then decommission it.

## Step 7 — Turn on Proxmox HA

```bash
# on any node, after the containers work:
bash proxmox/ha-setup.sh   # prompts for the DB id, app id(s), and rproxy id
ha-manager status          # the registered ct:NNNN should be "started"
```

It prompts for the DB CT id, the app CT id(s) (space‑separated — list them all in
the split topology), and the reverse‑proxy CT id (blank for bundled). Re‑running
is safe — already‑registered resources are skipped.

Now if a node fails, the HA manager restarts the affected container on a
surviving node automatically.

> **(split) Register the rproxy CT.** It terminates TLS for **every** backend, so
> it is a **single point of failure** — if it (or its node) goes down, all
> instances are unreachable until it restarts. HA bounds that to a ~1–2 min
> node‑failure restart; it does **not** prevent a bad Caddy reload / cert failure
> from taking everything down at once. For true proxy redundancy you'd run two
> proxies behind a VIP (keepalived) or DNS failover — out of scope here, but worth
> knowing the rproxy concentrates risk that bundled per‑app CTs don't.

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
The code is a git clone at `/opt/openpollslack-i18n`. One wrapper does the whole
thing **on the node** — it takes a pre‑update Ceph snapshot (instant rollback),
pulls/checks out the version, re‑syncs deps to that ref's `yarn.lock`, fixes
ownership, restarts the service, and waits for a healthy start:

```bash
bash app/update-app-to-ct.sh                  # prompts: CT id, version (blank = pull latest), snapshot? (Y)
# or non-interactively:
APP_REF=4.1.1.1 NONINTERACTIVE=1 bash app/update-app-to-ct.sh   # deploy a specific release tag
```

It prompts for the App CT id, the version to deploy (a **tag/branch**, or blank
to pull the latest of the current branch), and whether to snapshot first
(default yes). Roll back instantly if a release misbehaves:

```bash
pct rollback <APP_ID> pre-update
```

Works for **both** bundled and app‑only CTs (it only touches the Node app, never
Caddy). Run it once per app CT in the split topology. Under the hood it runs
`app/update-app.in-ct.sh` inside the CT (`git pull`/`checkout` →
`corepack yarn install --immutable` → `chown` → `systemctl restart openpoll` →
wait on `/healthz`).

- The app runs any pending **DB migrations on startup**, before it serves
  traffic — the wrapper waits for `/healthz`; watch for `End database migration.`
  then `Bolt app is running!` (same caveat as Step 6).
- If a release bumps the **Node major version**, re‑run `app/deploy-app-to-ct.sh`
  (or the Node install step in `app/setup-app.in-ct.sh`) first, then update again.
- The **DB container** is updated separately: snapshot the DB CT, then
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
- **`mongod` dies immediately on start** → two common causes, both checked
  up‑front by `setup-db.in-ct.sh`:
  - **No AVX:** MongoDB 5.0+ needs a CPU with AVX (`lscpu | grep -i avx`). Run the
    CT on an AVX‑capable node, or pin `MONGO_MAJOR=4.4`.
  - **Host kernel ≥ 6.19** (log: *"Linux kernel versions 6.19 and newer has a known
    incompatibility"*, MongoDB [SERVER‑121912](https://jira.mongodb.org/browse/SERVER-121912)):
    MongoDB **8.0+** bundles a TCMalloc that crashes on kernel 6.19+. An LXC shares
    the **host** kernel, so the CT inherits the node's. **The kit defaults to
    MongoDB 7.0** (unaffected), so you only hit this if you *chose* 8.0 on a 6.19+
    host. **Fixed entirely inside the CT — this kit never touches the host** (no
    kernel pinning, no node reboot): re‑deploy with **MongoDB 7.0** — re‑run
    `deploy-db` and keep/choose `7.0` (or pass `MONGO_MAJOR=7.0`). To switch an
    already‑provisioned CT (apt won't downgrade 8.0→7.0 in place), re‑run with
    **`--reset`**, which purges MongoDB + its data in the CT first, then reinstalls
    (DESTRUCTIVE; confirmed before it runs):
    `MONGO_MAJOR=7.0 bash db/deploy-db-to-ct.sh --reset`.
    Return to 8.0 once SERVER‑121912 is fixed.
  - Also note `vm.max_map_count` is set on the **host**, not inside the unprivileged CT.
- **HA won't relocate a container** → its disk must be on shared storage (Ceph),
  not local. Check with `pct config 5000 | grep rootfs`.
- **Lock MongoDB down further (defense in depth):** `bindIp` keeps Mongo off the
  internet; also enable the Proxmox firewall on the DB CT to accept `27017` only
  from **each app CT's IP** (a list — in the split topology there are several),
  and never port‑forward 27017.
- **Firewall — per role (this matters; the bundled and split rules differ):**
  the Node app binds `0.0.0.0:5000`, so on the LAN it's reachable directly
  (bypassing TLS). Enable the Proxmox firewall and set inbound rules to match
  your topology:
  - **Bundled App CT:** `ACCEPT tcp dport 443` (+ established/related), **drop the
    rest** — exposes only HTTPS, hides `:5000` from the LAN. (Caddy reaches the app
    over `localhost`, so nothing on the LAN needs `:5000`.)
  - **Split app‑only CT:** `ACCEPT tcp dport 5000` **only from the rproxy CT's IP**
    (+ established/related), drop the rest, and **no `:443`** (no Caddy here). A
    blanket "drop `:5000`" here would 502 every request — the rproxy must reach it.
  - **Split rproxy CT:** `ACCEPT tcp dport 443` (+ established/related), drop the
    rest; no inbound `:5000`.
- **502 right after a reboot/failover is normal:** Caddy answers `:443` at once,
  but `/node/<port>/*` returns 502 until that app finishes its startup migrations
  and logs `Bolt app is running!`. **(split)** a single app CT failing over 502s
  **only its own** `/node/<port>/` while the others stay green; the rproxy CT
  failing over takes **all** backends down for its restart window. Point uptime
  checks at each `/node/<port>/healthz`.
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

> Note this is **not** the [split topology](#bundled-vs-split--which-do-i-want):
> active‑active runs **two copies of one** Slack app under **one** prefix
> (load‑balanced, shared replica‑set DB) for redundancy. Split runs **several
> different** Slack apps under **different** prefixes (each its own DB). Different
> goals — don't confuse one prefix‑per‑instance (split) with two‑backends‑one‑prefix
> (active‑active).

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
