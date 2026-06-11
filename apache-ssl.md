# Apache SSL Proxy example
# httpd.conf
```
	LoadModule proxy_module modules/mod_proxy.so
	LoadModule proxy_http_module modules/mod_proxy_http.so
```


# ssl.vh.conf
```
<VirtualHost *:443>
...
SSLProxyEngine on
SSLEngine on
...
ProxyPass /slack/ http://127.0.0.1:5000/slack/
ProxyPassReverse /slack/ http://127.0.0.1:5000/slack/
# Optional: expose the health endpoints through the proxy so an external
# uptime monitor can probe https://YOURHOSTNAME/healthz
ProxyPass /healthz http://127.0.0.1:5000/healthz
ProxyPass /ping http://127.0.0.1:5000/ping
```

- `5000` must match the `port` key in `config/default.json` (default `5000`).
- This forwards all the app's endpoints (`/slack/events`, `/slack/commands`, `/slack/actions`, `/slack/install`, `/slack/oauth_redirect`), so the `https://YOURHOSTNAME/slack/...` request URLs from [self_host.md](self_host.md) work as-is.
- The proxy must pass the request body through unmodified — do not add filters/modules that rewrite or re-encode the body, or Slack's request signature verification will fail on every request.
