
# About this fork 

I have make some change to make it more customizable such as 
- Allow choices add by others
- Customizeable UI (Order, Show/Hide Element you don't want to make it cleaner)
- UI Language, Multiple language support
- Separate configuation for each Slack team.
- Better error handling that may crash the server


(Please see detail below)

### If I just want to use it without self-host?
You can use "Add to slack" button [on this ite](https://siamhos.com/openpollplus/index_plus.html)

PLEASE NOTE: Link above will run lastest code on my devlopment server, you can use it for free, but it may contain bugs or may down for mantanance without any notice, If you found any bugs please feel free to report. 

After add to slack please use `/poll config` to config what options you want to enable/disable on your Slack team.


## Additional server config (config/default.json)
- `app_lang` for translation (Please put language file in language folder), Translate some text to Thai (th-ภาษาไทย)
- `app_lang_user_selectable` if set to `true`; Let user who create poll (Via Modal) select language of poll UI 
- `use_response_url` if set to `true`; app will respond to request using `response_url` instead of using `app.client.chat.post`
  so user will be able to create poll in private channel without adding bot to that channel (using /command or Modal that called by /command, but not via shortcut), But it might get timeout if user not response after Modal was created (click create poll) within slack time limit(30 minutes).
- `menu_at_the_end` if set to `true`; Rearrange Menu to the end of poll so no more big menu button between question and answer when using smartphone
- `add_number_emoji_to_choice` and `add_number_emoji_to_choice_btn`  if set to `true`; Number emoji (customizeable) will show in the vote option text / button
- `compact_ui` if set to `true`; Choice text will compact to voter name
- `show_divider` if set to `false`; Poll will be more compact (divider between choice will be removed)
- `show_help_link` if set to `false`; help link will be removed from poll
- `show_command_info` if set to `false`; command that use to create poll will be removed
- `log_level` valid options are: `debug` `info` `warn` `error`

## Team config (Override Server config)

If some of your team would like to using different config than what is on default.json you can use `/poll config` .
- this command only work on user who install app to Slack only
- If app was re-add to workspace all Override config will be removed

Usage:
```
/poll config read
/poll config write app_lang [en/th/(or language file)]
/poll config write app_lang_user_selectable [true/false]
/poll config write menu_at_the_end [true/false]
/poll config write compact_ui [true/false]
/poll config write show_divider [true/false]
/poll config write show_help_link [true/false]
/poll config write show_command_info [true/false]
/poll config write add_number_emoji_to_choice [true/false]
/poll config write add_number_emoji_to_choice_btn [true/false]
```

## Example

- if `response_url` is not enable or not in use, user will get feedback if poll can create in that channel or not (required `channels:read`,`groups:read`,`mpim:read`,`im:read` Permissions)

  ![Alt text](./assets/poll-ch-check-feedback.png?raw=true "poll-ch-check-feedback")
- User language selectable

  ![Alt text](./assets/poll-lang-select.png?raw=true "poll-lang-select")
- User add choice

  ![Alt text](./assets/poll-add-choice-en.png?raw=true "User add choice")
- UI Config

  ![Alt text](./assets/UI-compare.png?raw=true "UI-compare")
  ![Alt text](./assets/UI-compare-mobile.png?raw=true "UI-compare-mobile")
  ![Alt text](./assets/UI-menu-location.png?raw=true "UI-menu-location")
- Emoji On/Off

 ![Alt text](./assets/UI-emoji.png?raw=true "UI-Emoji")

- You also can add notice to user when anonymous was used (since creator still can see their votes) by add text you want in `info_anonymous_notice` of language file 

 ![Alt text](./assets/poll-anonymous-note.png?raw=true "poll-anonymous-note")
## Additional Permissions

`channels:read`,`groups:read`,`mpim:read`,`im:read` : to check if bot in selected channel (if not using `response_url`)
## Command usages
### Allow choices add by others
```
/poll add-choice "What's your favourite color ?" "Red" "Green" "Blue" "Yellow"
```

### Change poll language for current poll only
```
/poll lang th "What's your favourite color ?" "Red" "Green" "Blue" "Yellow"
```

# Open source poll for slack

Welcome to the open source poll for slack.  
This repository is hosted on [GitLab](https://gitlab.com/openpollslack/openpollslack). [Github repository](https://github.com/KazuAlex/openpollslack) is only a mirror.  
But feel free to open new issues on both.  

## Important update

If you have an error when submitting poll, please use the "Add to slack" button [on site](https://siamhos.com/openpollplus/index_plus.html) to re-authorize the bot on your workspace

### Migrate to v3

To upgrade to v3, you need to have a mongo database.  
Setup your `config/default.json` with new database url and database name:
- `mongo_url`: the url to connect to your mongo database
- `mongo_db_name`: your mongo database name

After that, migrate your old database to the mongo with the script:  
At the root directory, run `./scripts/migrate-v3.sh [MONGO_URL] [MONGO_DB_NAME]`  
Replace `[MONGO_URL]` by the same `mongo_url` and `[MONGO_DB_NAME]` with the same `mongo_db_name` set in your `config/default.json`.  
As an example, with the default data from `config/default.json.dist`, the command line to migrate is:
```
./scripts/migrate-v3.sh mongodb://localhost:27017 open_poll
```

## License

The code is under GNU GPL license. So, you are free to modify the code and redistribute it under same license.  
  
Remember the four freedoms of the GPL :  
> the freedom to use the software for any purpose,
> * the freedom to change the software to suit your needs,
> * the freedom to share the software with your friends and neighbors, and
> * the freedom to share the changes you make.

## Command usages

### Simple poll
```
/poll "What's your favourite color ?" "Red" "Green" "Blue" "Yellow"
```
### Anonymous poll
```
/poll anonymous "What's your favourite color ?" "Red" "Green" "Blue" "Yellow"
```
### Limited choice poll
```
/poll limit 2 "What's your favourite color ?" "Red" "Green" "Blue" "Yellow"
```
### Hidden poll votes
```
/poll hidden "What's your favourite color ?" "Red" "Green" "Blue" "Yellow"
```
### Anonymous limited choice poll
```
/poll anonymous limit 2 "What's your favourite color ?" "Red" "Green" "Blue" "Yellow"
```

### Allow choices add by others
```
/poll add-choice "What's your favourite color ?" "Red" "Green" "Blue" "Yellow"
```

### Allow choices add by others with Limited and Anonymous
```
/poll add-choice anonymous limit 2 "What's your favourite color ?" "Red" "Green" "Blue" "Yellow"
```

### Change poll language for current poll only
```
/poll lang th "What's your favourite color ?" "Red" "Green" "Blue" "Yellow"
```
  
For both question and choices, feel free to use slack's emoji, `*bold*` `~strike~` `_italics_` and `` `code` ``  

## Self hosted installation

- [self_host.md](self_host.md)
- [webpage.md](webpage.md)
- [apache-ssl.md](apache-ssl.md)
## Support me

To support or thank me, you can contact me. I would be happy to provide you my PayPal address.
