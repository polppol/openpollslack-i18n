# Self‑hosting on a generic Linux server (v4)

> **Shortcut — reuse the Proxmox kit's scripts.** Those in‑CT setup scripts are
> plain Debian 12 + systemd and run on any non‑Proxmox Debian box/VM/LXC too.
> Instead of the manual steps below you can run
> [`setup-db.in-ct.sh`](../proxmox/db/setup-db.in-ct.sh),
> [`setup-app.in-ct.sh`](../proxmox/app/setup-app.in-ct.sh) and
> [`install-caddy.in-ct.sh`](../proxmox/app/install-caddy.in-ct.sh) **directly** on
> your server — skip the `pct` wrappers + `create-containers.sh` / `ha-setup.sh`.
> Needs systemd (not a plain Docker container); MongoDB needs an x86‑64 CPU with AVX.

## Self hosted installation guide
### Requirements
To use the app you will configure, you need:

- a server (this can be a raspberry at your home or a dedicated server in any provider you want) with internet access
- a domain name with HTTPS certificate. (Free certs via [Let's Encrypt](https://letsencrypt.org/), or use a [No-IP Hostname](https://www.noip.com/support/knowledgebase/how-to-configure-your-no-ip-hostname/).)
- [Node.js](https://nodejs.org/) **>= 20.19** (LTS recommended; tested on 24.x)
- [Corepack](https://nodejs.org/api/corepack.html) — bundled with Node.js 16.10+; just needs to be enabled once (see below)
- [MongoDB](https://www.mongodb.com/) server **4.2 or newer** (the app uses the MongoDB Node.js driver 7.x) — a local `mongod` or a hosted instance such as MongoDB Atlas

### Get the code
Firstly you need to get the source code. Go back to the root repository page and click on `Clone or download`.

Clone method requires `git` installed on your server. Download method requires `zip` installed on your server. You can also unzip it on your host machine and rsync the files or drop it into ftp.

### Install dependencies
The package manager is **Yarn 4** (pinned via the `packageManager` field in `package.json`). Corepack downloads and runs the exact yarn version on demand — no global yarn install required.

```bash
# One-time on the server (and dev machine):
corepack enable
# (On Linux you may need sudo if Node was installed system-wide.)

# From the project root:
yarn install
```

That's all. `node_modules/` is populated and `yarn.lock` stays in sync with `package.json`.

### Update dependencies (pulling in newer versions)
When `package.json` or `yarn.lock` changes upstream:

```bash
git pull
yarn install
pm2 restart <id>   # if running under pm2 (see "Run the app" below)
```

To check for outdated packages:

```bash
yarn outdated
```

To bump a single package within its current semver range:

```bash
yarn up <package>
```

To bump to the latest version (may be a major upgrade — review the changelog first):

```bash
yarn up <package>@latest
```

After any `yarn up`, commit both `package.json` and `yarn.lock`.

### Upgrade Yarn itself
Yarn's version is pinned by the `packageManager` field. To upgrade:

```bash
# Pick a version from https://yarnpkg.com/getting-started/install
corepack use yarn@<version>
yarn install
```

`corepack use` rewrites the `packageManager` field (with an integrity hash) and refreshes `yarn.lock`. Commit both files.

### Run the app
You have many way to run the app. Basically, you can use `node index.js`. But if you leave your shell, your app stop working. Prefer use package like [pm2](https://pm2.keymetrics.io/):

- pm2 start index.js to run your app
- pm2 list to list running node apps
- pm2 show ID (ID is provided by previous command`) to monitor your app
- pm2 stop ID to stop the app
- pm2 restart ID to restart the app
- pm2 del ID to delete your app from pm2

### Health check & logs
- `GET /ping` returns a static `pong` (process up). `GET /healthz` additionally pings MongoDB and returns `200 {ok:true, mongo:"up", version, uptime_s}` or `503 {ok:false, mongo:"down"}` — point your uptime monitor at `/healthz`. Note: if you only proxy `/slack/*` (as in [apache-ssl.md](../apache/apache-ssl.md)), probe the app port directly (`http://127.0.0.1:5000/healthz`) or add `/healthz` to the proxy rules.
- Logs are written to the `log_dir` folder (default `logs/`) with daily rotation (`YYYY-MM-DD_app.log` / `_bolt.log`). Old files are pruned per `log_max_files` (default `30d`). Log levels default to `info`; set the `log_level_*` keys to `debug` only when diagnosing.

### Database
The app stores polls, votes, schedules and per-team config in MongoDB. Install and start a local `mongod` (or use a hosted instance such as MongoDB Atlas), then set `mongo_url` and `mongo_db_name` in `config/default.json` (defaults: `mongodb://localhost:27017` / `open_poll`). Collections are created automatically — no schema setup is needed. Without a reachable MongoDB the app logs "Failed to connect to MongoDB" and exits at startup.

### Configuration
Inside the `config` folder, you have a `default.json.dist`. Copy it into `config/default.json`. Then, you need to edit the config values (see [README.md](../../../README.md#self-host-server-configuration-configdefaultjson) )

The app listens on the `port` key from `config/default.json` (default `5000`); your HTTPS reverse proxy must forward the `/slack/*` paths to it — see [apache-ssl.md](../apache/apache-ssl.md) for an Apache example.


### Create an app into slack
To use the poll in slack workspace, you need to create an app into slack. Go to this page : https://api.slack.com/apps and click on `Create New App`. Fill the fields :

- App Name : what you want. This represents your app in Slack app directory
- Development Slack Workspace : you need to choose a workspace to develop your app or test it before publishing
Once done, you will be redirected to your app "Basic Information"

Expand the "Add features and functionality" and activate :

- App Home
- Interactive Components
- Slash Commands
- Event Subscriptions
- Bots
- Permissions

#### App Home
Set App Display Name, Enable Home Tab(Optional), Enable Messages Tab(Optional).
If you doesn't enable this, user will not get any schedule notification in case of any schedule error occure, 
please set `app_allow_dm` to `false` in you doesn't enable this otherwise you will get an error!

#### Interactive Components
Activate it with the On/Off button. Fill the `Request URL` with `https://YOURHOSTNAME/slack/actions`. Replace `YOURHOSTNAME` with yours. Keep `/slack/actions` at the end !

#### Slash Commands
Inside the "Basic Information" page, click on "Slash Commands" under "Add features and functionality".

The app registers TWO slash commands, one for each of the `command` / `command2` keys in `config/default.json` (defaults: `poll` and `openpoll`). Create both in Slack — or set those config keys to match the command(s) you create.

In this page, click on "Create New Command" Fill the next fields:

- Command: The name of the command inside slack. First "/poll", then repeat for "/openpoll" (or whatever you set in `command` / `command2`)
- Request URL: Fill with `https://YOURHOSTNAME/slack/commands` and replace `YOURHOSTNAME` with yours.
- Short Description: describe the command, e.g. "Create a poll".
- Usage Hint: a usage example, e.g. `"What is your favourite color?" "Red" "Green" "Blue" "Yellow"`.
- Escape channels, users, and links sent to your app: leave it unchecked — not used by the app.

#### Event Subscriptions
Activate it with the On/Off button. Fill the `Request URL` with `https://YOURHOSTNAME/slack/events`. Replace `YOURHOSTNAME` with yours. Keep `/slack/events` at the end !
and add the `app_home_opened` event under "Subscribe to bot events".



#### Shortcut (optional, but useful to your users)
Create a new shortcut by clicking on `Create New Shortcut`, select `Global` and click on `Next` button. Fill the next fields:

- Name: anything you like; it appears in Slack's shortcut menu, e.g. "Create new poll".
- Short Description: describe the shortcut, e.g. "Create a new poll from modal".
- Callback ID: fill with `open_modal_new`. Keep the same, this is use into the app's code.
Now, click on "Create". Once your shortcut created, click on "Save Changes" and go back to "Basic Information"

#### Bots
This step is required to activate "Slash Commands".

Inside the "Basic Information" page, click on "Bots" under "Add features and functionality".

Leave the "Messages Tab" disabled — nothing in the app uses it.


#### Permissions
Inside the "Basic Information" page, click on "Premissions" under "Add features and functionality" or find the "OAuth & Permissions" entry in left menu.

Firstly, click on "Add New Redirect URL". Fill it with `https://YOURHOSTNAME/slack/oauth_redirect` and replace `YOURHOSTNAME` with yours. Then click on "Add" button.

Under "Scopes" section and "Bot Token Scopes" subsection, click on "Add an OAuth Scope". Then, add theses scopes (the same list the app requests during the OAuth install):

- `commands` : slash commands and the global shortcut
- `chat:write` : post and update poll messages
- `chat:write.public` : to write in the workspace channels
- `groups:write` : write access in private channels the bot is a member of
- `users:read` : to read user time zone, and to resolve names for CSV export
- `channels:read`,`groups:read`,`mpim:read` : to check if bot in selected channel (if not using `response_url`)

Also, but optional, in the "Restrict API Token Usage" section, you can add your server IP address to restrict api usage.

### Install the app to your workspace
The final step — without it, the bot has no token for your workspace and nothing will work:

1. From the app's "Basic Information" page, copy the credentials into `config/default.json`: `client_id`, `client_secret`, `signing_secret`. Also set `state_secret` to a random string of your own, and point `oauth_success` / `oauth_failure` at pages on your domain (the user's browser is redirected there after install).
2. Start (or restart) the app.
3. Open `https://YOURHOSTNAME/slack/install` in your browser and click through the Slack authorization screen.

On success you are redirected to your `oauth_success` URL and the app is installed — try `/poll` in your workspace.