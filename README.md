
# About this fork 

I have make some change to make it more customizable :
## config/default.json
- `app_lang` for translation (Please put language file in language folder), Translate some text to Thai (th-ภาษาไทย)
- `app_lang_user_selectable` if set to `true`; Let user who create poll (Via Modal) select language of poll UI (Most of the UI text, some error and exception message might still in default app language ) 
- `bot_name` for refering bot name in some help text
- `use_response_url` if set to `true`; app will respond to request using `response_url` instead of using `app.client.chat.post`
  so user will be able to create poll in private channel without adding bot to that channel (using /command or Modal that called by /command, but not via shortcut), But it might get timeout if user not response after Modal was created (click create poll) within slack time limit(30 minutes).
- `menu_at_the_end` if set to `true`; Rearrange Menu to the end of poll so no more big menu btn between question and answer when using smartphone
- `add_number_emoji_to_choice` and `add_number_emoji_to_choice_btn`  if set to `true`; Number emoji (customizeable) will show in the vote option text / button
- `show_help_link` if set to `false`; help link will be removed from poll
- `show_command_info` if set to `false`; command that use to create poll will be removed

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

If you have an error when submitting poll, please use the "Add to slack" button [on site](https://openpoll.slack.alcor.space/) to re-authorize the bot on your workspace

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

Wiki pages are available to help you with the [app configuration](https://gitlab.com/KazuAlex/openpollslack/-/wikis/Self-hosted-installation-(v2)) and the [web page configuration](https://gitlab.com/KazuAlex/openpollslack/-/wikis/Web-page).

## Support me

To support or thank me, you can contact me. I would be happy to provide you my PayPal address.
