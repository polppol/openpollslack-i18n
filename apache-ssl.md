apache ssl proxy example
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
ProxyPass /node/3002/ http://127.0.0.1:3002/
ProxyPassReverse /node/3002/ http://127.0.0.1:3002/
```