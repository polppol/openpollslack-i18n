# Debugging

> Internal debugging aid. **Not** linked from the README on purpose. For development /
> troubleshooting on a trusted network only.

## Deep logs

The app logs through winston at the levels set in the config:

```json
  "log_level_app": "debug",
  "log_level_app_file": "debug",
  "log_level_bolt": "debug",
  "log_level_bolt_file": "debug",
```

At `debug` level the deep traces are emitted (e.g. the multi‑question **builder** prints
`[mq] handleQType …`, `[mq] handleAddQuestion …`, `[mq] handleQuestionSubmit …`, and any
swallowed Slack API rejection as `[mq builder] … failed: <error> :: <field>`). At `info`
and above these are silent, so they never spam normal logs. Set the levels back to `info`
in production.

## `debug_interface` — read-only log HTTP port

`debug_interface` (default **`0` = OFF**) opens a tiny **read-only** HTTP server that serves
the app's logs, so you can pull them remotely while debugging instead of shelling into the
host.

```json
  "debug_interface": 5051
```

Restart the app, then browse / curl (replace `<HOST>` with the app host/IP):

| Path | What |
| --- | --- |
| `http://<HOST>:5051/` | HTML index: log-file links + the last 500 in-memory log lines |
| `http://<HOST>:5051/log` | full in-memory ring (recent lines), `text/plain` |
| `http://<HOST>:5051/log?n=500` | last N ring lines |
| `http://<HOST>:5051/file?name=YYYY-MM-DD_app.log` | a specific on-disk log file (needs `log_to_file: true`) |

```bash
curl -s http://<HOST>:5051/log?n=300
curl -s "http://<HOST>:5051/file?name=$(date +%F)_app.log" | grep -i '\[mq'
```

The in-memory ring works even when `log_to_file` is `false`; with file logging on you also get
the full history via `/file`. Obvious live secrets (Slack `xox?-…` tokens, Mongo URI
passwords, `*_secret` values) are redacted from everything the port serves.

## ⚠️ Security

- **Plain HTTP, no authentication.** Anyone who can reach the port can read the (redacted)
  logs. Keep it on a trusted LAN, behind a firewall, and **disable it (`0`) in production.**
- Redaction is best-effort for known secret shapes — treat the output as sensitive anyway
  (it contains user/channel ids, poll content, request traces).
- The port binds `0.0.0.0`; restrict access at the network layer.

A typical debugging session: set the four `log_level_*` to `debug` and `debug_interface` to a
port, restart, reproduce the issue, then `curl …/log` (or open the index) to read the trace.
Revert both when done.
