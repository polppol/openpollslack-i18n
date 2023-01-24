# Self hosted installation (v2)
## Self hosted installation guide
### Requirements
To use the app you will configure, you need two things:

- a server (this can be a raspberry at your home or a dedicated server in any provider you want) that can access to internet
- a domain name with https certificate. Maybe that work with http, but you can generate free certificates with [Let's Encrypt](https://letsencrypt.org/). This is more secure. You also can use [No-IP Hostname](https://www.noip.com/support/knowledgebase/how-to-configure-your-no-ip-hostname/).
- [Node.js®](https://nodejs.org/fr/) >= 12
- [npm](https://www.npmjs.com/) >= 6 or [yarn](https://yarnpkg.com/)

### Get the code
Firstly you need to get the source code. Go back to the root repository page and click on `Clone or download`.

Clone method require `git` installed on your server. Download method require `zip` installed on your server. You can also unzip it on your host machine and rsync the files or drop it into a ftp.

### Install dependencies
To install dependencies, run `npm install` or `yarn install`. That's all.

### Run the app
You have many way to run the app. Basically, you can use `node index.js`. But if you leave your shell, your app stop working. Prefer use package like [pm2](https://pm2.keymetrics.io/):

- pm2 start index.js to run your app
- pm2 list to list running node apps
- pm2 show ID (ID is provided by previous command`) to monitor your app
- pm2 stop ID to stop the app
- pm2 restart ID to restart the app
- pm2 del ID to delete your app from pm2

### Configuration
Inside the `config` folder, you have a `default.json.dist`. Copy it into `config/default.json`. Then, you need to edit the config values :

- `port`: the port you will use to listen http requests. Can also be configured as environment variable (like PORT=5000 node index.js
- `command`: the command name you want to use your poll inside slack
- `help_link`: a link to provide help to use the poll
- `client_id`: a value provided by slack (we will see it later)
- `client_secret`: another value provided by slack (see later)
- `signing_secret`: another value provided by slack again
- `state_secret`: a secret state passed to slack. Please update it with random string or what you want.
- `oauth_success`: at the end of oauth flow, to register your app in workspace, the user will be redirected to this page if the registration succeeds
- `oauth_failure`: at the end of oauth flow, to register your app in workspace, the user will be redirected to this page if the registration failed
- `app_lang` : for translation (Please put language file in language folder), Translate some text to Thai (th-ภาษาไทย)
- `app_lang_user_selectable` : if set to `true`; Let user who create poll (Via Modal) select language of poll UI (Most of the UI text, some error and exception message might still in default app language )
- `bot_name` : for refering bot name in some help text
- `use_response_url` : if set to `true`; app will respond to request using `response_url` instead of using `app.client.chat.post`
  so user will be able to create poll in private channel without adding bot to that channel (using /command or Modal that called by /command, but not via shortcut), But it might get timeout if user not response after Modal was created (click create poll) within slack time limit(30 minutes).
- `menu_at_the_end` : if set to `true`; Rearrange Menu to the end of poll so no more big menu btn between question and answer when using smartphone
- `add_number_emoji_to_choice` and `add_number_emoji_to_choice_btn` : if set to `true`; Number emoji (customizeable) will show in the vote option text / button
- `compact_ui` if set to `true`; Choice text will compact to voter name
- `show_divider` if set to `false`; Poll will be more compact (divider between choice will be removed)
- `show_help_link` : if set to `false`; help link will be removed from poll
- `show_command_info` : if set to `false`; command that use to create poll will be removed
- `log_level` valid options are: `debug` `info` `warn` `error`

### Create an app into slack
To use the poll in slack workspace, you need to create an app into slack. Go to this page : https://api.slack.com/apps and click on `Create New App`. Fill the fields :

- App Name : what you want. This represents your app in Slack app directory
- Development Slack Workspace : you need to choose a workspace to develop your app or test it before publishing
Once done, you will be redirected to your app "Basic Information"

Expand the "Add features and functionality" and activate :

- Interactive Components
- Slash Commands
- Bots
- Permissions

#### Interactive Components
Activate it with the On/Off button. Fill the `Request URL` with `https://YOURHOSTNAME/slack/actions`. Replace `YOURHOSTNAME` with yours. Mine is `https://api.openpoll.slack.alcor.space/slack/actions`. Keep `/slack/actions` at the end !

#### Shortcut (optional, but useful to your users)
Create a new shortcut by clicking on `Create New Shortcut`, select `Global` and click on `Next` button. Fill the next fields:

- Name: what you want, but this will appear in Slack's shortcut. Mine is "Create new poll"
- Short Description: what you to describe your shortcut. Mine is "Create a new poll from modal"
- Callback ID: fill with `open_modal_new`. Keep the same, this is use into the app's code.
Now, click on "Create". Once your shortcut created, click on "Save Changes" and go back to "Basic Information"

#### Bots
This step is required to activate "Slash Commands".

Inside the "Basic Information" page, click on "Bots" under "Add features and functionality".

In this step, I have deactivated "Messages Tab". Nothing to use it are really implemented in this app.

#### Slash Commands
Inside the "Basic Information" page, click on "Slash Commands" under "Add features and functionality".

In this page, click on "Create New Command" Fill the next fields:

- Command: The name of the command inside slack. Mine is "/openpoll"
- Request URL: Fill with `https://YOURHOSTNAME/slack/commands` and replace `YOURHOSTNAME` with yours. Mine is `https://api.openpoll.dev.slack.alcor.space/slack/commands`
- Short Description: Describe the command here. Mine is simply "Create a poll"
- Usage Hint: Give hint to user. Mine is `"What is you favourite color ?" "Red" "Green" "Blue" "Yellow"`
- Escape channels, users, and links sent to your app: I've not ticked the box. No usage required in the app.

#### Permissions
Inside the "Basic Information" page, click on "Premissions" under "Add features and functionality" or find the "OAuth & Permissions" entry in left menu.

Firstly, click on "Add New Redirect URL". Fill it with `https://YOURHOSTNAME/slack/oauth_redirect` and replace `YOURHOSTNAME` with yours. Mine is `https://api.openpoll.dev.slack.alcor.space/slack/oauth_redirect`. Then click on "Add" button.

Under "Scopes" section and "Bot Token Scopes" subsection, click on "Add an OAuth Scope". Then, add theses scopes :

- `chat:write` : requested by next scope
- `chat:write.public` : to write in the workspace channels
- `channels:read`,`groups:read`,`mpim:read`,`im:read` : to check if bot in selected channel (if not using `response_url`)

Also, but optional, in the "Restrict API Token Usage" section, you can add your server IP address to restrict api usage.