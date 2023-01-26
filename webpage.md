# Web page
## Web page for your application
On this same repository, we can found the app (index.js) and a web page to present your application.

## Structure
We can found an index.html that is the home page. You also have a privacy folder with another index.html that present the privacy policy of the app. Be careful to respect it when update the app or update it.

## Contact mail address
Also change, in index.html, the contact mail that is harcoded in the bottom of home page. I'm not responsible of your application.

## Web server configuration
You can use apache, nginx or any other web server to serve the root directory.

When configuring your web server, be careful to not let user access to `config` folder used by the app to store private informations (like client_secret, signing_secret and also the json that store bot-token for the app using your app.

Also, i've denied the access to `node_modules`.

Be careful, if you don't want the user access to your app source code to deny access to `/index.js`.

I'm using nginx and you can deny access to folder or file like this :
```
location /config {
deny all;
return 404;
}
```

