# HTTPS certificate via the Cloudflare DNS‑01 challenge

Whatever terminates HTTPS needs a certificate. That is **Caddy** — inside the
**App container** in the bundled setup, or inside the **reverse‑proxy container**
in the split setup. (A separate external Apache box is another alternative.)
The **DNS‑01 challenge** proves you own the domain by writing a temporary
`_acme-challenge` TXT record through your DNS provider's API — instead of the
default HTTP‑01 challenge that needs Let's Encrypt to reach you on **port 80**.

> **Want to skip auto‑certs entirely?** Run the deploy wrapper with
> `TLS_MODE=manual`: it installs Caddy + the routing but issues **no** certificate
> and needs **no Cloudflare token** — you install/renew the cert yourself. See
> **Option D — Manual cert (TLS_MODE=manual)** at the bottom.

Use DNS‑01 when you want to:
- **not open port 80** to the App container at all (smaller attack surface), or
- reach the App container on a **non‑standard external port** (e.g. a firewall NAT of
  `:1234 → :443`, so neither port 80 nor 443 is forwarded inbound), or
- issue a **wildcard** cert like `*.example.com` (wildcards *require* DNS‑01).

This example uses **Cloudflare** as the DNS provider.

---

## Step 1 — Create a scoped Cloudflare API token

Do **not** use the Global API Key. Create a token limited to editing DNS on the
one zone:

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token**.
2. Use the **"Edit zone DNS"** template (or Custom token) with:
   - **Permissions:** `Zone` → `DNS` → `Edit`
   - **Zone Resources:** `Include` → `Specific zone` → `example.com`
   - (optional) **Client IP Address Filtering:** the public/outbound IP of whatever CT runs Caddy — the **App CT** in the bundled setup, the **reverse‑proxy CT** in the split setup (scope it to the box that actually issues the cert, or issuance gets a 403)
   - (optional) **TTL:** an expiry date
3. **Continue → Create Token** and copy the token — it is shown only once.

Keep this token secret. It can edit DNS for that zone, nothing more.

---

## Option A — Caddy (the default — runs inside the App container)

This is what `install-caddy.in-ct.sh` automates for the standard setup (Caddy in the
App CT). The standard Caddy binary doesn't include DNS provider plugins, so add
the Cloudflare module (the official binary can rebuild itself):

```bash
caddy add-package github.com/caddy-dns/cloudflare
systemctl restart caddy
caddy list-modules | grep dns.providers.cloudflare   # confirm it's present
```

> `install-caddy.in-ct.sh` runs the above for you. The cert is actually issued later
> (README Step 4) once your token + Caddyfile are in place — not at this first
> restart against Caddy's stock config.

Give Caddy the token via an environment file (never hard‑code it in the
Caddyfile), readable only by root:

```bash
install -m 600 /dev/null /etc/caddy/cloudflare.env
echo 'CF_API_TOKEN=your-cloudflare-token-here' > /etc/caddy/cloudflare.env
```

Load it into the caddy service with a systemd drop‑in
`/etc/systemd/system/caddy.service.d/cloudflare.conf`:

```ini
[Service]
EnvironmentFile=/etc/caddy/cloudflare.env
```

```bash
systemctl daemon-reload && systemctl restart caddy
```

Then tell Caddy to use DNS‑01 in the Caddyfile (see `app/Caddyfile` for the full
reverse‑proxy block):

```caddy
poll.example.com {
    tls {
        dns cloudflare {env.CF_API_TOKEN}
    }

    # ... your /node/<label>/ handle_path blocks ...
}

# Wildcard variant — one cert for every app/subdomain (DNS-01 only):
# *.example.com {
#     tls {
#         dns cloudflare {env.CF_API_TOKEN}
#     }
#     ...
# }
```

Caddy now obtains and auto‑renews the cert over DNS — **no port 80 required**.

---

## Option B — Apache + certbot (only for the external‑Apache alternative)

Use this only if you front the app from a separate Apache box
(`app/apache-vhost.conf`) instead of Caddy‑in‑the‑container. Apache doesn't do
ACME itself; **certbot** fetches the cert and Apache points at the files.

```bash
apt-get update
apt-get install -y certbot python3-certbot-dns-cloudflare
```

Put the token in a credentials file, root‑only:

```bash
install -m 600 /dev/null /etc/letsencrypt/cloudflare.ini
cat > /etc/letsencrypt/cloudflare.ini <<'EOF'
# Cloudflare API token with Zone:DNS:Edit on this zone only.
dns_cloudflare_api_token = your-cloudflare-token-here
EOF
chmod 600 /etc/letsencrypt/cloudflare.ini
```

Obtain the certificate via DNS‑01 (add `-d '*.example.com'` for a wildcard):

```bash
certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  --dns-cloudflare-propagation-seconds 30 \
  -d poll.example.com \
  --deploy-hook "systemctl reload apache2"
```

Point your vhost (see `app/apache-vhost.conf`) at the issued files:

```apache
SSLCertificateFile    /etc/letsencrypt/live/poll.example.com/fullchain.pem
SSLCertificateKeyFile /etc/letsencrypt/live/poll.example.com/privkey.pem
```

```bash
apachectl configtest && systemctl reload apache2
```

**Auto‑renewal** is already handled: installing certbot adds a systemd timer
(`systemctl list-timers | grep certbot`). The `--deploy-hook` above is saved
with the cert, so Apache is reloaded automatically after each renewal. Verify
the whole flow without touching the live cert:

```bash
certbot renew --dry-run
```

---

## Option C — acme.sh (lightweight alternative to certbot)

If you prefer a shell‑only client (no Python):

```bash
export CF_Token="your-cloudflare-token-here"
acme.sh --issue --dns dns_cf -d poll.example.com
acme.sh --install-cert -d poll.example.com \
  --fullchain-file /etc/ssl/proxy/fullchain.pem \
  --key-file       /etc/ssl/proxy/privkey.pem \
  --reloadcmd      "systemctl reload apache2"
```

acme.sh installs its own cron entry for renewal.

---

## Option D — Manual cert (TLS_MODE=manual, no automation)

Use this when you don't want Caddy issuing certificates at all — you already have
a cert (corporate CA, an existing wildcard, your own certbot/acme.sh elsewhere),
or you simply prefer to manage it by hand. Run the deploy wrapper with
`TLS_MODE=manual`:

```bash
bash app/deploy-app-to-ct.sh                 # then answer: TLS mode -> manual
# or non-interactively:
TLS_MODE=manual bash app/deploy-app-to-ct.sh
#   (split: TLS_MODE=manual bash rproxy/deploy-rproxy-to-ct.sh)
```

`install-caddy.in-ct.sh` then installs the **stock** Caddy (no Cloudflare module,
no token, no `apt-mark hold`) and the wrapper writes a `tls <cert> <key>` line
into the Caddyfile (default paths `/etc/caddy/cert.pem` and `/etc/caddy/key.pem`).
Put your fullchain + private key there inside the CT, then reload:

```bash
pct push <CT ID> fullchain.pem /etc/caddy/cert.pem
pct push <CT ID> privkey.pem   /etc/caddy/key.pem
pct exec <CT ID> -- systemctl restart caddy
```

Renewal is yours to wire (Caddy will not do it in this mode): run certbot/acme.sh
on a schedule and drop the renewed files at those paths, reloading Caddy after.

---

## Notes

- **Least privilege:** the token only needs `Zone:DNS:Edit` on the single zone.
  Never put the Global API Key in a file on the server.
- **Permissions:** keep `cloudflare.ini` / `cloudflare.env` `chmod 600`,
  root‑owned. Back them up with your other secrets (see README Step 3).
- **Where this runs:** on whatever terminates TLS, so the token + cert live
  there. Bundled setup → **Caddy in the App CT**. Split setup → **Caddy in the
  reverse‑proxy CT** (the app‑only CTs hold **no** Cloudflare token — keep it that
  way; smaller blast radius). External‑Apache alternative → that separate box.
- **DNS‑01 vs HTTP‑01:** with DNS‑01 you don't forward port 80 at all; only 443
  needs to reach the App container. HTTP‑01 (the default) instead needs port 80 open.
