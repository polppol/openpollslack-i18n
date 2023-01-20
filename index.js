const { App, ExpressReceiver, LogLevel } = require('@slack/bolt');
const config = require('config');

const { MongoClient } = require('mongodb');

const { Migrations } = require('./utils/migrations');

const { Mutex } = require('async-mutex');

const fileLang = require('node:fs');

const globLang = require('glob');

let langDict = {};

let langList = {};

const port = config.get('port');
const signing_secret = config.get('signing_secret');
const slackCommand = config.get('command');
const helpLink = config.get('help_link');
const supportUrl = config.get('support_url');
const gAppLang = config.get('app_lang');
const gIsAppLangSelectable = config.get('app_lang_user_selectable');
const isUseResponseUrl = config.get('use_response_url');
const gIsMenuAtTheEnd = config.get('menu_at_the_end');
const botName = config.get('bot_name');
const gIsShowHelpLink = config.get('show_help_link');
const gIsShowCommandInfo = config.get('show_command_info');
const gIsShowNumberInChoice = config.get('add_number_emoji_to_choice');
const gIsShowNumberInChoiceBtn = config.get('add_number_emoji_to_choice_btn');

const validTeamOverrideConfigTF = ["app_lang_user_selectable","menu_at_the_end","show_help_link","show_command_info","add_number_emoji_to_choice","add_number_emoji_to_choice_btn"];

const client = new MongoClient(config.get('mongo_url'));
let orgCol = null;
let votesCol = null;
let closedCol = null;
let hiddenCol = null;

let migrations = null;

const mutexes = {};

try {
  console.log('Connecting to database server...');
  client.connect();
  console.log('Connected successfully to server')
  const db = client.db(config.get('mongo_db_name'));
  orgCol = db.collection('token');
  votesCol = db.collection('votes');
  closedCol = db.collection('closed');
  hiddenCol = db.collection('hidden');

  migrations = new Migrations(db);
} catch (e) {
  client.close();
  console.error(e)
  process.exit();
}

let langCount = 0;
globLang.sync( './language/*.json' ).forEach( function( file ) {
  let dash = file.split("/");
  if(dash.length === 3) {
    let dot = dash[2].split(".");
    if(dot.length === 2) {
      let lang = dot[0];
      console.log("Lang file ["+lang+"]: "+file);
      let fileData = fileLang.readFileSync(file);
      langDict[lang] = JSON.parse(fileData.toString());
      if(langDict[lang].hasOwnProperty('info_lang_name'))
        langList[lang] = langDict[lang]['info_lang_name'];
      else
        langList[lang] = lang;
      langCount++;
    }
  }
});
console.log("Lang Count: "+langCount);
console.log("Selected Lang: "+gAppLang);
if(!langDict.hasOwnProperty('en')) {
  console.error("language/en.json NOT FOUND!");
  throw new Error("language/en.json NOT FOUND!");
}
if(!langDict.hasOwnProperty(gAppLang)) {
  console.error(`language/${gAppLang}.json NOT FOUND!`);
  throw new Error(`language/${gAppLang}.json NOT FOUND!`);
}

const parameterizedString = (str,varArray) => {
  if(str==undefined) str = `MissingStr`;
  let outputStr = str;
  for (let key in varArray) {
    if (varArray.hasOwnProperty(key)) {
      outputStr = outputStr.replaceAll("{{"+key+"}}",varArray[key])
    }
  }
  return outputStr;
}

const stri18n = (lang,key) => {
  if(langDict.hasOwnProperty(lang)) {
    if(langDict[lang].hasOwnProperty(key)) {
      return langDict[lang][key];
    }
  }
  //fallback to en if not exist
  if(langDict['en'].hasOwnProperty(key)) {
    return langDict['en'][key];
  }
  else {
    return `MissingStr`;
  }
}

const getTeamOverride  = async (mTeamId) => {
    let ret = {};
    try {
        const team = await orgCol.findOne({ 'team.id': mTeamId });
        if (team) {
            if(team.hasOwnProperty("openPollConfig")) ret = team.openPollConfig;
        }
    }
    catch (e) {

    }
    return ret;
}
const receiver = new ExpressReceiver({
  signingSecret: signing_secret,
  clientId: config.get('client_id'),
  clientSecret: config.get('client_secret'),
  scopes: ['commands', 'chat:write.public', 'chat:write', 'groups:write','channels:read','groups:read','mpim:read','im:read'],
  stateSecret: config.get('state_secret'),
  endpoints: {
    events: '/slack/events',
    commands: '/slack/commands',
    actions: '/slack/actions',
  },
  installerOptions: {
    installPath: '/slack/install',
    redirectUriPath: '/slack/oauth_redirect',
    stateVerification: false,
    callbackOptions: {
      success: (installation, installOptions, req, res) => {
        res.redirect(config.get('oauth_success'));
      },
      failure: (error, installOptions , req, res) => {
        res.redirect(config.get('oauth_failure'));
      },
    },
  },
  installationStore: {
    storeInstallation: async (installation) => {
      let mTeamId = "";
      if (installation.isEnterpriseInstall && installation.enterprise !== undefined) {
        mTeamId = installation.enterprise.id;
      }
      if (installation.team !== undefined) {
        // single team app installation
        mTeamId = installation.team.id;
      }

      const team = await orgCol.findOne({ 'team.id': mTeamId });
      if (team) {
        await orgCol.replaceOne({ 'team.id': mTeamId }, installation);
      } else {
        await orgCol.insertOne(installation);
      }

      return installation.team.id;
    },
    fetchInstallation: async (installQuery) => {
      let mTeamId = "";
      if (installQuery.isEnterpriseInstall && installQuery.enterpriseId !== undefined) {
        // org wide app installation lookup
        mTeamId = installQuery.enterpriseId;
      }
      if (installQuery.teamId !== undefined) {
        // single team app installation lookup
        mTeamId = installQuery.teamId;
      }

      try {
        return await orgCol.findOne({ 'team.id': mTeamId });
      } catch (e) {
        console.error(e)
        throw new Error('No matching authorizations');
      }
    },
  },
  logLevel: LogLevel.DEBUG,
});

receiver.router.get('/ping', (req, res) => {
  res.status(200).send('pong');
})

const app = new App({
  receiver: receiver,
});

const sendMessageUsingUrl = async (url,newMessage) => {
  await fetch(url, {
    method: 'POST',
    body: JSON.stringify(newMessage),
    headers: {'Content-Type': 'application/json'}
  });
}

const postChat = async (url,type,requestBody) => {
  if(isUseResponseUrl && url!=undefined && url!="")
  {
    delete requestBody['token'];
    delete requestBody['channel'];
    delete requestBody['user'];
    switch (type) {
      case "post":
        requestBody['response_type'] = 'in_channel';
        requestBody['replace_original'] = false;
        break;
      case "update":
        requestBody['response_type'] = 'in_channel';
        requestBody['replace_original'] = true;
        break;
      case "ephemeral":
        requestBody['response_type'] = 'ephemeral';
        requestBody['replace_original'] = false;
        break;
      case "delete":
        requestBody['delete_original'] = true;
        break;
      default:
        console.error("Invalid post type:"+type);
        return;
    }
    await sendMessageUsingUrl(url,requestBody);
  }
  else
  {
    try {
      switch (type) {
        case "post":
          await app.client.chat.postMessage(requestBody);
          break;
        case "update":
          await app.client.chat.update(requestBody);
          break;
        case "ephemeral":
          await app.client.chat.postEphemeral(requestBody);
          break;
        case "delete":
          await app.client.chat.delete(requestBody);
          break;
        default:
          console.error("Invalid post type:"+type)
          return;
      }
    } catch (e) {
      if (
          e && e.data && e.data && e.data.error
          && 'channel_not_found' === e.data.error
      ) {
        console.error('Channel not found error : ignored')
      }
    }
  }
}

const slackNumToEmoji = (seq,userLang) => {
  let outText = "["+seq+"]";
  if(langDict.hasOwnProperty(userLang))
    if(langDict[userLang].hasOwnProperty('emoji_'+seq))
      outText = langDict[userLang]['emoji_'+seq];

  return outText;
}

app.event('app_home_opened', async ({ event, client, context }) => {
  try {
    const result = await client.views.publish({
      user_id: event.user,
      view: {
        type: "home",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Hello, here is how to create a poll with OpenPoll.",
            },
          },
          {
            type: "divider",
          },
          {
            type: "header",
            text: {
              type: "plain_text",
              text: "Create poll",
              emoji: true,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*From command*\nJust typing `/poll` where you type the message, following with options (see below) and your choices surrounding by quotes.\nBe careful, this way open the shortcuts. But you just need to ignore it and continue typing options and choices.",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*From shortcuts*\nOpen shortcuts (lightning bolt below to message input, or just type `/` into message input) and type \"poll\"",
            },
          },
          {
            type: "header",
            text: {
              type: "plain_text",
              text: "Delete poll",
              emoji: true,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "When you create a poll, a red button will appear at bottom of your poll.\nOnly the creator can delete a poll.",
            },
          },
          {
            type: "divider",
          },
          {
            type: "header",
            text: {
              type: "plain_text",
              text: "Options",
              emoji: true,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "The options are optionals settings to apply to the poll.\nDon't surround options with quotes.",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Anonymous*\n`anonymous` inside command.\nThis option allow you to hide voters.",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Limited choices*\n`limit x` inside command. Replace \"x\" by desired number.\nThis option limit maximum choice for each users. If \"2\", each user can only select 2 choices.",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Hidden*\n`hidden` inside command.\nThis option hide the number of votes for each choice. You can reveal votes with a button at bottom of poll. Only the creator can reveal votes.",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Allow choices from others*\n`add-choice` inside command.\nThis option allow other member to add more choice to this poll.",
            },
          },
          {
            type: "divider",
          },
          {
            type: "header",
            text: {
              type: "plain_text",
              text: "Examples",
              emoji: true,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Simple poll*\nThis example will create a basic poll.",
            },
          },
          {
            type: "input",
            element: {
              type: "plain_text_input",
              initial_value: "/poll \"What's you favourite color ?\" \"Red\" \"Green\" \"Blue\" \"Yellow\""
            },
            label: {
              type: "plain_text",
              text: " ",
              emoji: true,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Anonymous poll*\nThis example will create anonymous poll.",
            },
          },
          {
            type: "input",
            element: {
              type: "plain_text_input",
              initial_value: "/poll anonymous \"What's you favourite color ?\" \"Red\" \"Green\" \"Blue\" \"Yellow\"",
            },
            label: {
              type: "plain_text",
              text: " ",
              emoji: true,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Limited poll*\nThis example will create anonymous poll.",
            },
          },
          {
            type: "input",
            element: {
              type: "plain_text_input",
              initial_value: "/poll limit 2 \"What's you favourite color ?\" \"Red\" \"Green\" \"Blue\" \"Yellow\"",
            },
            label: {
              type: "plain_text",
              text: " ",
              emoji: true,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Hidden poll*\nThis example will create hidden poll and allow you to reveal votes.",
            },
          },
          {
            type: "input",
            element: {
              type: "plain_text_input",
              initial_value: "/poll hidden \"What's you favourite color ?\" \"Red\" \"Green\" \"Blue\" \"Yellow\"",
            },
            label: {
              type: "plain_text",
              text: " ",
              emoji: true,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Mixed options poll*\nThis example will create anonymous and limited poll.",
            },
          },
          {
            type: "input",
            element: {
              type: "plain_text_input",
              initial_value: "/poll anonymous limit 2 \"What's you favourite color ?\" \"Red\" \"Green\" \"Blue\" \"Yellow\"",
            },
            label: {
              type: "plain_text",
              text: " ",
              emoji: true,
            },
          },
          {
            type: "divider",
          },
          {
            type: "header",
            text: {
              type: "plain_text",
              text: "Tips",
              emoji: true,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Private channel*\nTo create poll in private channels, you need to invite the bot inside with `/invite` command.",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Private messages*\nTo create poll in private messages, you need to invite the bot inside with `/invite` command.",
            },
          },
          {
            type: "divider",
          },
          {
            type: "header",
            text: {
              type: "plain_text",
              text: "Recurring poll",
              emoji: true,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Slack has a feature called \"Workflow\" that allow you to create recurring poll. Check at <https://slack.com/slack-tips/speed-up-poll-creation-with-simple-poll|this example> from slack. But it require a paid plan.",
            },
          },
          {
            type: "divider",
          },
          {
            type: "header",
            text: {
              type: "plain_text",
              text: "Limitations",
              emoji: true,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Slack have limitations and that include \"message length\". So you can't have more than 15 options per poll. You can create multiple polls if you want more options",
            },
          },
        ],
      },
    });
  } catch (error) {
    console.error(error);
  }
});

app.command(`/${slackCommand}`, async ({ ack, body, client, command, context, say, respond }) => {
  await ack();

  let cmdBody = (command && command.text) ? command.text.trim() : null;

  const isHelp = cmdBody ? 'help' === cmdBody : false;

  const channel = (command && command.channel_id) ? command.channel_id : null;

  const userId = (command && command.user_id) ? command.user_id : null;

  const teamConfig = await getTeamOverride(body.team_id);
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;

  let isMenuAtTheEnd = gIsMenuAtTheEnd;
  let isShowHelpLink = gIsShowHelpLink;
  let isShowCommandInfo = gIsShowCommandInfo;
  let isShowNumberInChoice = gIsShowNumberInChoice;
  let isShowNumberInChoiceBtn = gIsShowNumberInChoiceBtn;

  if(teamConfig.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = teamConfig.menu_at_the_end;
  if(teamConfig.hasOwnProperty("show_help_link")) isShowHelpLink = teamConfig.show_help_link;
  if(teamConfig.hasOwnProperty("show_command_info")) isShowCommandInfo = teamConfig.show_command_info;
  if(teamConfig.hasOwnProperty("add_number_emoji_to_choice")) isShowNumberInChoice = teamConfig.add_number_emoji_to_choice;
  if(teamConfig.hasOwnProperty("add_number_emoji_to_choice_btn")) isShowNumberInChoiceBtn = teamConfig.add_number_emoji_to_choice_btn;

  if (isHelp) {
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Open source poll for slack*',
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Simple poll*',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "```\n/"+slackCommand+" \"What's your favourite color ?\" \"Red\" \"Green\" \"Blue\" \"Yellow\"\n```",
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Anonymous poll*',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "```\n/"+slackCommand+" anonymous \"What's your favourite color ?\" \"Red\" \"Green\" \"Blue\" \"Yellow\"\n```",
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Hidden poll votes*',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "```\n/"+slackCommand+" hidden \"What's your favourite color ?\" \"Red\" \"Green\" \"Blue\" \"Yellow\"\n```",
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Limited choice poll*',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "```\n/"+slackCommand+" limit 2 \"What's your favourite color ?\" \"Red\" \"Green\" \"Blue\" \"Yellow\"\n```",
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Anonymous limited choice poll*',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "```\n/"+slackCommand+" anonymous limit 2 \"What's your favourite color ?\" \"Red\" \"Green\" \"Blue\" \"Yellow\"\n```",
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Allow choices add by others*',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "```\n/"+slackCommand+" add-choice \"What's your favourite color ?\" \"Red\" \"Green\" \"Blue\" \"Yellow\"\n```",
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Change poll language for current poll only*',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "```\n/"+slackCommand+" lang th \"What's your favourite color ?\" \"Red\" \"Green\" \"Blue\" \"Yellow\"\n```",
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Config Open Poll for this Workspace*',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "```\n/"+slackCommand+" config```",
        },
      },
    ];

    let mRequestBody = {
      token: context.botToken,
      channel: channel,
      user: userId,
      blocks: blocks,
    };
    await postChat(body.response_url,'ephemeral',mRequestBody);
    return;
  } else if (!cmdBody) {
    createModal(context, client, body.trigger_id,body.response_url);
  } else {
    const cmd = `/${slackCommand} ${cmdBody}`;
    let question = null;
    const options = [];

    let userLang = appLang;
    let isAnonymous = false;
    let isLimited = false;
    let limit = null;
    let isHidden = false;
    let isAllowUserAddChoice = false;
    let fetchArgs = true;

    while (fetchArgs) {
      fetchArgs = false;
      if (cmdBody.startsWith('anonymous')) {
        fetchArgs = true;
        isAnonymous = true;
        cmdBody = cmdBody.substring(9).trim();
      } else if (cmdBody.startsWith('limit')) {
        fetchArgs = true;
        cmdBody = cmdBody.substring(5).trim();
        isLimited = true;
        if (!isNaN(parseInt(cmdBody.charAt(0)))) {
          limit = parseInt(cmdBody.substring(0, cmdBody.indexOf(' ')));
          cmdBody = cmdBody.substring(cmdBody.indexOf(' ')).trim();
        }
      } else if (cmdBody.startsWith('lang')) {
        fetchArgs = true;
        cmdBody = cmdBody.substring(4).trim();
        isLimited = true;
        let inputLang = (cmdBody.substring(0, cmdBody.indexOf(' ')));
        if(langList.hasOwnProperty(inputLang)){
          userLang = inputLang;
        }

        cmdBody = cmdBody.substring(cmdBody.indexOf(' ')).trim();
      } else if (cmdBody.startsWith('hidden')) {
        fetchArgs = true;
        cmdBody = cmdBody.substring(6).trim();
        isHidden = true;
      } else if (cmdBody.startsWith('add-choice')) {
        fetchArgs = true;
        cmdBody = cmdBody.substring(10).trim();
        isAllowUserAddChoice = true;
      } else if (cmdBody.startsWith('config')) {
        await respond(`/${slackCommand} ${command.text}`);
        fetchArgs = true;
        cmdBody = cmdBody.substring(6).trim();

        let validWritePara = `\n/${slackCommand} config write app_lang [`;
        let isFirstLang = true;
        for (let key in langList) {
          if(isFirstLang) isFirstLang = false;
          else validWritePara += "/";
          validWritePara += key;
        }
        validWritePara += "]";
        for (const eachOverrideable of validTeamOverrideConfigTF) {
          validWritePara += `\n/${slackCommand} config write ${eachOverrideable} [true/false]`;
        }

        let team = await orgCol.findOne({ 'team.id': body.team_id });
        let validConfigUser = "";
        if (team) {
          if(team.hasOwnProperty("user"))
            if(team.user.hasOwnProperty("id")) {
              validConfigUser = team.user.id;
            }
        }
        else {
          let mRequestBody = {
            token: context.botToken,
            channel: channel,
            //blocks: blocks,
            text: `Error while reading config`,
          };
          await postChat(body.response_url,'ephemeral',mRequestBody);
          return;
        }

        if(body.user_id != validConfigUser) {
          let mRequestBody = {
            token: context.botToken,
            channel: channel,
            //blocks: blocks,
            text: stri18n(userLang,'err_only_installer'),
          };
          await postChat(body.response_url,'ephemeral',mRequestBody);
          return;
        }

        if(cmdBody.startsWith("read")){


          let configTxt = "Config: not found";
          if (team) {
            if(team.hasOwnProperty("openPollConfig")) {
              configTxt = "Override found:\n```"+JSON.stringify(team.openPollConfig)+"```";

            }
            else {
              configTxt = "No override: using server setting";
            }
          }


          let mRequestBody = {
            token: context.botToken,
            channel: channel,
            //blocks: blocks,
            text: `${configTxt}`,
          };
          await postChat(body.response_url,'ephemeral',mRequestBody);
          return;
        } else if (cmdBody.startsWith("write")){
          cmdBody = cmdBody.substring(5).trim();

          let inputPara = (cmdBody.substring(0, cmdBody.indexOf(' ')));
          let isWriteValid = false;

          if(validTeamOverrideConfigTF.includes(inputPara)) {
            cmdBody = cmdBody.substring(inputPara.length).trim();
            isWriteValid = true;
          }

          if(inputPara=="app_lang") {
            cmdBody = cmdBody.substring(8).trim();
            isWriteValid = true;
          }

          if(isWriteValid) {
            let inputVal = cmdBody.trim();
            if(inputPara=="app_lang") {
              if(!langList.hasOwnProperty(inputVal)){
                let mRequestBody = {
                  token: context.botToken,
                  channel: channel,
                  //blocks: blocks,
                  text: `Lang file [${inputVal}] not found`,
                };
                await postChat(body.response_url,'ephemeral',mRequestBody);
                return;
              }
            } else {
              if (cmdBody.startsWith("true")) {
                inputVal = true;
              } else if (cmdBody.startsWith("false")) {
                inputVal = false;
              }
              else {
                let mRequestBody = {
                  token: context.botToken,
                  channel: channel,
                  //blocks: blocks,
                  text: `Usage: ${inputPara} [true/false]`,
                };
                await postChat(body.response_url,'ephemeral',mRequestBody);
                return;
              }
          }
          if(!team.hasOwnProperty("openPollConfig")) team.openPollConfig = {};
          team.openPollConfig.isset = true;
          team.openPollConfig[inputPara] = inputVal;
          //console.log(team);
          try {
              await orgCol.replaceOne({'team.id': body.team_id}, team);
          }
          catch (e) {
              console.error(e);
              let mRequestBody = {
                  token: context.botToken,
                  channel: channel,
                  //blocks: blocks,
                  text: `Error while update [${inputPara}] to [${inputVal}]`,
              };
              await postChat(body.response_url,'ephemeral',mRequestBody);
              return;

          }

          let mRequestBody = {
            token: context.botToken,
            channel: channel,
            //blocks: blocks,
            text: `[${inputPara}] is set to [${inputVal}] for this Team`,
          };
          await postChat(body.response_url,'ephemeral',mRequestBody);
          return;

        }
        else {
          let mRequestBody = {
            token: context.botToken,
            channel: channel,
            //blocks: blocks,
            text: `[${inputPara}] is not valid config parameter or value is missing\nUsage: ${validWritePara}`,
          };
          await postChat(body.response_url,'ephemeral',mRequestBody);
          return;
        }



        } else {
          let mRequestBody = {
            token: context.botToken,
            channel: channel,
            //blocks: blocks,
            text: `Usage:\n/${slackCommand} config read`+
                  `\n${validWritePara}`
            ,
          };
          await postChat(body.response_url,'ephemeral',mRequestBody);
          return;
        }

      }
    }

    const lastSep = cmdBody.split('').pop();
    const firstSep = cmdBody.charAt(0);

    if (isLimited && null === limit) {
      limit = 1;
    }

    try {
      const regexp = new RegExp(firstSep+'[^'+firstSep+'\\\\]*(?:\\\\[\S\s][^'+lastSep+'\\\\]*)*'+lastSep, 'g');
      for (let option of cmdBody.match(regexp)) {
        let opt = option.substring(1, option.length - 1);
        if (question === null) {
          question = opt;
        } else {
          options.push(opt);
        }
      }
    }
    catch (e) {
      let mRequestBody = {
        token: context.botToken,
        channel: channel,
        //blocks: blocks,
        text: stri18n(userLang,'err_process_command')
        ,
      };
      await postChat(body.response_url,'ephemeral',mRequestBody);
      return;
    }



    const blocks = createPollView(question, options, isAnonymous, isLimited, limit, isHidden, isAllowUserAddChoice, isMenuAtTheEnd, isShowHelpLink, isShowCommandInfo, isShowNumberInChoice, isShowNumberInChoiceBtn, userLang, userId, cmd);

    if (null === blocks) {
      return;
    }

    let mRequestBody = {
      token: context.botToken,
      channel: channel,
      blocks: blocks,
      text: `Poll : ${question}`,
    };
    await postChat(body.response_url,'post',mRequestBody);
  }
});

const createModalBlockInput = (userLang)  => {
    return {
      type: 'input',
      element: {
        type: 'plain_text_input',
        placeholder: {
          type: 'plain_text',
          text: stri18n(userLang,'modal_input_choice'),
        },
      },
      label: {
        type: 'plain_text',
        text: ' ',
      },
  }
};

(async () => {
  console.log('Start database migration.');
  await migrations.init();
  await migrations.migrate();
  console.log('End database migration.')

  await app.start(process.env.PORT || port);

  console.log('Bolt app is running!');
})();

app.action('btn_add_choice', async ({ action, ack, body, client, context }) => {

  if (
    !body
    || !body.view
    || !body.view.blocks
    || !body.view.hash
    || !body.view.type
    || !body.view.title
    || !body.view.submit
    || !body.view.close
    || !body.view.id
    || !body.view.private_metadata
  ) {
    console.log('error');
    return;
  }
  const teamConfig = await getTeamOverride(context.teamId);
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang
  let blocks = body.view.blocks;
  const hash = body.view.hash;

  let beginBlocks = blocks.slice(0, blocks.length - 1);
  let endBlocks = blocks.slice(-1);

  let tempModalBlockInput = JSON.parse(JSON.stringify(createModalBlockInput(appLang)));
  tempModalBlockInput.block_id = 'choice_'+(blocks.length-8);

  beginBlocks.push(tempModalBlockInput);
  blocks = beginBlocks.concat(endBlocks);

  const view = {
    type: body.view.type,
    private_metadata: body.view.private_metadata,
    callback_id: 'modal_poll_submit',
    title: body.view.title,
    submit: body.view.submit,
    close: body.view.close,
    blocks: blocks,
    external_id: body.view.id,
  };

  try {
    const result = await client.views.update({
      token: context.botToken,
      hash: hash,
      view: view,
      view_id: body.view.id,
    });

    await ack();
  }
  catch (e) {
    //do not ack so user can see some error
    console.debug("Error on btn_add_choice (maybe user click too fast");
  }

});

app.action('btn_my_votes', async ({ ack, body, client, context }) => {
  await ack();

  if (
    !body.hasOwnProperty('user')
    || !body.user.hasOwnProperty('id')
  ) {
    return;
  }

  const blocks = body.message.blocks;
  let votes = [];
  const userId = body.user.id;
  const teamConfig = await getTeamOverride(body.team_id);
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;

  for (const block of blocks) {
    if (
      'section' !== block.type
      || !block.hasOwnProperty('accessory')
      || !block.accessory.hasOwnProperty('action_id')
      || 'btn_vote' !== block.accessory.action_id
      || !block.accessory.hasOwnProperty('value')
      || !block.hasOwnProperty('text')
      || !block.text.hasOwnProperty('text')
    ) {
      continue;
    }
    const value = JSON.parse(block.accessory.value);

    if (value.voters.includes(userId)) {
      votes.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: block.text.text,
        },
      });
      votes.push({
        type: 'divider',
      });
    }
  }

  if (0 === votes.length) {
    votes.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: stri18n(appLang,'you_have_not_voted'),
      },
    });
  } else {
    votes.pop();
  }

  try {
    await client.views.open({
      token: context.botToken,
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        title: {
          type: 'plain_text',
          text: stri18n(appLang,'info_your_vote'),
        },
        close: {
          type: 'plain_text',
          text: stri18n(appLang,'info_close'),
        },
        blocks: votes,
      }
    });
  } catch (e) {
    console.error(e);
  }
});

app.action('btn_delete', async ({ action, ack, body, context }) => {
  await ack();

  if (
    !body
    || !body.user
    || !body.user.id
    || !body.message
    || !body.message.ts
    || !body.channel
    || !body.channel.id
    || !action
    || !action.value
  ) {
    console.log('error');
    return;
  }
  const teamConfig = await getTeamOverride(body.team_id);
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;

  if (body.user.id !== action.value) {
    console.log('invalid user');
    let mRequestBody = {
      token: context.botToken,
      channel: body.channel.id,
      user: body.user.id,
      attachments: [],
      text: stri18n(appLang,'can_not_delete_other'),
    };
    await postChat(body.response_url,'ephemeral',mRequestBody);
    return;
  }

  let mRequestBody = {
    token: context.botToken,
    channel: body.channel.id,
    ts: body.message.ts,
  };
  await postChat(body.response_url,'delete',mRequestBody);
});

app.action('btn_reveal', async ({ action, ack, body, context }) => {
  await ack();

  if (
    !body
    || !body.user
    || !body.user.id
    || !body.message
    || !body.message.ts
    || !body.message.blocks
    || !body.channel
    || !body.channel.id
    || !action
    || !action.value
  ) {
    console.log('error');
    return;
  }
  const teamConfig = await getTeamOverride(body.team_id);
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
  let value = JSON.parse(action.value);

  if (body.user.id !== value.user) {
    console.log('invalid user');
    let mRequestBody = {
      token: context.botToken,
      channel: body.channel.id,
      user: body.user.id,
      attachments: [],
      text: stri18n(appLang,'err_reveal_other'),
    };
    await postChat(body.response_url,'ephemeral',mRequestBody);
    return;
  }

  let mRequestBody = {
    token: context.botToken,
    channel: body.channel.id,
    user: body.user.id,
    attachments: [],
    text: stri18n(appLang,'err_poll_too_old'),
  };
  await postChat(body.response_url,'ephemeral',mRequestBody);
});

app.action('btn_vote', async ({ action, ack, body, context }) => {
  await ack();
  let menuAtIndex = 0;
  const teamConfig = await getTeamOverride(body.team_id);

  if (
    !body
    || !action
    || !body.user
    || !body.user.id
    || !body.message
    || !body.message.blocks
    || !body.message.ts
    || !body.channel
    || !body.channel.id
  ) {
    console.log('error');
    return;
  }
  const user_id = body.user.id;
  const message = body.message;
  let blocks = message.blocks;

  const channel = body.channel.id;

  let value = JSON.parse(action.value);

  let userLang = null;
  if(value.hasOwnProperty('user_lang'))
    if(value.user_lang!="" && value.user_lang != null)
      userLang = value.user_lang;

  if(userLang==null)
  {
    userLang= gAppLang;
    if(teamConfig.hasOwnProperty("app_lang")) userLang = teamConfig.app_lang;
  }

  let isMenuAtTheEnd = gIsMenuAtTheEnd;
  if(value.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = value.menu_at_the_end;
  else if (teamConfig.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = teamConfig.menu_at_the_end;

  if(isMenuAtTheEnd) menuAtIndex = body.message.blocks.length-1;

  if (!mutexes.hasOwnProperty(`${message.team}/${channel}/${message.ts}`)) {
    mutexes[`${message.team}/${channel}/${message.ts}`] = new Mutex();
  }

  let release = null;
  let countTry = 0;
  do {
    ++countTry;

    try {
      release = await mutexes[`${message.team}/${channel}/${message.ts}`].acquire();
    } catch (e) {
      console.log(`[Try #${countTry}] Error while attempt to acquire mutex lock.`, e)
    }
  } while (!release && countTry < 3);

  if (release) {
    try {

      let isClosed = false
      try {
        const data = await closedCol.findOne({ channel, ts: message.ts });
        isClosed = data !== null && data.closed;
      } catch {}

      if (isClosed) {
        let mRequestBody = {
          token: context.botToken,
            channel: body.channel.id,
            user: body.user.id,
            attachments: [],
            text: stri18n(userLang,'err_change_vote_poll_closed'),
        };
        await postChat(body.response_url,'ephemeral',mRequestBody);
          return;
      }

      let poll = null;
      const data = await votesCol.findOne({ channel: channel, ts: message.ts });
      if (data === null) {
        await votesCol.insertOne({
          team: message.team,
          channel,
          ts: message.ts,
          votes: {},
        });
        poll = {};
        for (const b of blocks) {
          if (
            b.hasOwnProperty('accessory')
            && b.accessory.hasOwnProperty('value')
          ) {
            const val = JSON.parse(b.accessory.value);
            poll[val.id] = val.voters ? val.voters : [];
          }
        }
        await votesCol.updateOne({
          channel,
          ts: message.ts,
        }, {
          $set: {
            votes: poll,
          }
        });
      } else {
        poll = data.votes;
      }

      //if not exist that mean this choice just add to poll
      if(!poll.hasOwnProperty(value.id))
      {
        console.log("Vote array not found creating value.id="+value.id);
        poll[value.id] = [];
      }

      const isHidden = await getInfos(
        'hidden',
        blocks,
        {
          team: message.team,
          channel,
          ts: message.ts,
        },
      )

      let button_id = 3 + (value.id * 2);
      let context_id = 3 + (value.id * 2) + 1;
      let blockBtn = blocks[button_id];
      let block = blocks[context_id];
      let voters = value.voters ? value.voters : [];

      let removeVote = false;

      if (poll[value.id].includes(user_id)) {
        removeVote = true;
      }

      if (value.limited && value.limit) {
        let voteCount = 0;
        if (0 !== Object.keys(poll).length) {
          for (const p in poll) {
            if (poll[p].includes(user_id)) {
              ++voteCount;
            }
          }
        }

        if (removeVote) {
          voteCount -= 1;
        }

        if (voteCount >= value.limit) {
          let mRequestBody = {
            token: context.botToken,
            channel: channel,
            user: body.user.id,
            attachments: [],
            text : parameterizedString(stri18n(userLang,'err_vote_over_limit'),{limit:value.limit}),
          };
          await postChat(body.response_url,'ephemeral',mRequestBody);
          return;
        }
      }

      if (removeVote) {
        poll[value.id] = poll[value.id].filter(voter_id => voter_id !== user_id);
      } else {
        poll[value.id].push(user_id);
      }

      for (const i in blocks) {
        let b = blocks[i];
        if (
          b.hasOwnProperty('accessory')
          && b.accessory.hasOwnProperty('value')
        ) {
          let val = JSON.parse(b.accessory.value);
          if (!val.hasOwnProperty('voters')) {
            val.voters = [];
          }

          if (!poll.hasOwnProperty(val.id)) {
            poll[val.id] = [];
          }

          val.voters = poll[val.id];
          let newVoters = '';

          if (isHidden) {
            newVoters = stri18n(userLang,'info_wait_reveal');
          } else if (poll[val.id].length === 0) {
            newVoters = stri18n(userLang,'info_no_vote');
          } else {
            newVoters = '';
            for (const voter of poll[val.id]) {
              if (!val.anonymous) {
                newVoters += `<@${voter}> `;
              }
            }

            newVoters += poll[val.id].length +' ';
            if (poll[val.id].length === 1) {
              newVoters += 'vote';
            } else {
              newVoters += 'votes';
            }
          }

          blocks[i].accessory.value = JSON.stringify(val);
          const nextI = ''+(parseInt(i)+1);
          if (blocks[nextI].hasOwnProperty('elements')) {
            blocks[nextI].elements[0].text = newVoters;
          }
        }
      }

      const infosIndex = blocks.findIndex(el => el.type === 'context' && el.elements)
      blocks[infosIndex].elements = await buildInfosBlocks(
        blocks,
        {
          team: message.team,
          channel,
          ts: message.ts,
        },
        userLang
      );
      blocks[menuAtIndex].accessory.option_groups[0].options =
        await buildMenu(blocks, {
          team: message.team,
          channel,
          ts: message.ts,
        },userLang,isMenuAtTheEnd);

      await votesCol.updateOne({
        channel,
        ts: message.ts,
      }, {
        $set: {
          votes: poll,
        }
      });

      let mRequestBody = {
        token: context.botToken,
        channel: channel,
        ts: message.ts,
        blocks: blocks,
        text: message.text,
      };
      await postChat(body.response_url,'update',mRequestBody);
    } catch (e) {
      console.error(e);
      let mRequestBody = {
        token: context.botToken,
        channel: body.channel.id,
        user: body.user.id,
        attachments: [],
        text: stri18n(userLang,'err_vote_exception'),
      };
      await postChat(body.response_url,'ephemeral',mRequestBody);

    } finally {
      release();
    }
  } else {
    let mRequestBody = {
      token: context.botToken,
      channel: body.channel.id,
      user: body.user.id,
      attachments: [],
      text: stri18n(userLang,'err_vote_exception'),
    };
    await postChat(body.response_url,'ephemeral',mRequestBody);

  }
});
app.action('add_choice_after_post', async ({ ack, body, action, context,client }) => {
  await ack();

  if (
    !body
    || !action
    || !body.user
    || !body.user.id
    || !body.message
    || !body.message.blocks
    || !body.message.ts
    || !body.channel
    || !body.channel.id
  ) {
    console.log('error');
    return;
  }
  const teamConfig = await getTeamOverride(body.team_id);
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
  const user_id = body.user.id;
  const message = body.message;
  let blocks = message.blocks;

  const channel = body.channel.id;

  const value = action.value.trim();

  let isMenuAtTheEnd = gIsMenuAtTheEnd;
  if(teamConfig.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = teamConfig.menu_at_the_end;
  let isShowHelpLink = gIsShowHelpLink;
  if(teamConfig.hasOwnProperty("show_help_link")) isShowHelpLink = teamConfig.show_help_link;
  let isShowCommandInfo = gIsShowCommandInfo;
  if(teamConfig.hasOwnProperty("show_command_info")) isShowCommandInfo = teamConfig.show_command_info;
  let isShowNumberInChoice = gIsShowNumberInChoice;
  if(teamConfig.hasOwnProperty("add_number_emoji_to_choice")) isShowNumberInChoice = teamConfig.add_number_emoji_to_choice;
  let isShowNumberInChoiceBtn = gIsShowNumberInChoiceBtn;
  if(teamConfig.hasOwnProperty("add_number_emoji_to_choice_btn")) isShowNumberInChoiceBtn = teamConfig.add_number_emoji_to_choice_btn;

  let userLang = appLang;

  if (!mutexes.hasOwnProperty(`${message.team}/${channel}/${message.ts}`)) {
    mutexes[`${message.team}/${channel}/${message.ts}`] = new Mutex();
  }
  let release = null;
  let countTry = 0;
  do {
    ++countTry;

    try {
      release = await mutexes[`${message.team}/${channel}/${message.ts}`].acquire();
    } catch (e) {
      console.log(`[Try #${countTry}] Error while attempt to acquire mutex lock.`, e)
    }
  } while (!release && countTry < 3);
  if (release) {
    try {
      //find next option id
      let lastestOptionId = -1;
      let lastestVoteBtnVal = [];
      for (const idx in body.message.blocks) {
        if (body.message.blocks[idx].hasOwnProperty('type') && body.message.blocks[idx].hasOwnProperty('accessory')) {
          if (body.message.blocks[idx]['type'] == 'section') {
            if (body.message.blocks[idx]['accessory']['type'] == 'button') {
              if (body.message.blocks[idx]['accessory'].hasOwnProperty('action_id') &&
                  body.message.blocks[idx]['accessory'].hasOwnProperty('value')
              ) {
                const voteBtnVal = JSON.parse(body.message.blocks[idx]['accessory']['value']);
                const voteBtnId = parseInt(voteBtnVal['id']);
                if (voteBtnId > lastestOptionId) {
                  lastestOptionId = voteBtnId;
                  lastestVoteBtnVal = voteBtnVal;
                  if(voteBtnVal.hasOwnProperty('user_lang'))
                    if(voteBtnVal['user_lang']!="" && voteBtnVal['user_lang'] != null)
                      userLang = voteBtnVal['user_lang'];

                  if(voteBtnVal.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = voteBtnVal.menu_at_the_end;
                  if(voteBtnVal.hasOwnProperty("show_help_link")) isShowHelpLink = voteBtnVal.show_help_link;
                  if(voteBtnVal.hasOwnProperty("show_command_info")) isShowCommandInfo = voteBtnVal.show_command_info;
                  if(voteBtnVal.hasOwnProperty("add_number_emoji_to_choice")) isShowNumberInChoice = voteBtnVal.add_number_emoji_to_choice;
                  if(voteBtnVal.hasOwnProperty("add_number_emoji_to_choice_btn")) isShowNumberInChoiceBtn = voteBtnVal.add_number_emoji_to_choice_btn;

                }

                let thisChoice = body.message.blocks[idx]['text']['text'].trim();
                if (isShowNumberInChoice) {
                  thisChoice = thisChoice.replace(slackNumToEmoji((voteBtnId + 1),userLang) + " ", '');
                }

                if (thisChoice == value) {
                  let mRequestBody = {
                    token: context.botToken,
                    channel: body.channel.id,
                    user: body.user.id,
                    attachments: [],
                    text: parameterizedString(stri18n(userLang, 'err_duplicate_add_choice'), {text: value}),
                  };
                  await postChat(body.response_url, 'ephemeral', mRequestBody);
                  return;
                }


              }
            }
          }
        }
      }
      //update post
      let newChoiceIndex = body.message.blocks.length-1;
      if(isShowHelpLink||isShowCommandInfo) newChoiceIndex--;
      if(isMenuAtTheEnd) newChoiceIndex--;

      const tempAddBlock = blocks[newChoiceIndex];

      lastestVoteBtnVal['id'] = (lastestOptionId + 1);
      lastestVoteBtnVal['voters'] = [];
      blocks.splice(newChoiceIndex, 1,buildVoteBlock(lastestVoteBtnVal, value, isShowNumberInChoice, isShowNumberInChoiceBtn));

      let block = {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: lastestVoteBtnVal['hidden'] ? stri18n(userLang,'info_wait_reveal') : stri18n(userLang,'info_no_vote'),
          }
        ],
      };
      blocks.splice(newChoiceIndex+1,0,block);

      blocks.splice(newChoiceIndex+2,0,{
        type: 'divider',
      });

      let mRequestBody2 = {
        token: context.botToken,
        channel: channel,
        ts: message.ts,
        blocks: blocks,
        text: message.text
      };
      await postChat(body.response_url, 'update', mRequestBody2);

      //re-add add-choice section
      blocks.splice(newChoiceIndex+3, 0,tempAddBlock);

      mRequestBody2 = {
        token: context.botToken,
        channel: channel,
        ts: message.ts,
        blocks: blocks,
        text: message.text
      };
      await postChat(body.response_url, 'update', mRequestBody2);

    } catch (e) {
      console.error(e);
      let mRequestBody = {
        token: context.botToken,
        channel: body.channel.id,
        user: body.user.id,
        attachments: [],
        text: stri18n(userLang,'err_add_choice_exception'),
      };
      await postChat(body.response_url, 'ephemeral', mRequestBody);
    } finally {
      release();
    }
  }

  return;

});

app.shortcut('open_modal_new', async ({ shortcut, ack, context, client }) => {
  await ack();
  createModal(context, client, shortcut.trigger_id);
});

async function createModal(context, client, trigger_id,response_url) {
  try {
    const teamConfig = await getTeamOverride(context.teamId);
    let appLang= gAppLang;
    if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
    let tempModalBlockInput = JSON.parse(JSON.stringify(createModalBlockInput(appLang)));
    tempModalBlockInput.block_id = 'choice_0';
    let isMenuAtTheEnd = gIsMenuAtTheEnd;
    if(teamConfig.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = teamConfig.menu_at_the_end;
    let isShowHelpLink = gIsShowHelpLink;
    if(teamConfig.hasOwnProperty("show_help_link")) isShowHelpLink = teamConfig.show_help_link;
    let isShowCommandInfo = gIsShowCommandInfo;
    if(teamConfig.hasOwnProperty("show_command_info")) isShowCommandInfo = teamConfig.show_command_info;
    let isShowNumberInChoice = gIsShowNumberInChoice;
    if(teamConfig.hasOwnProperty("add_number_emoji_to_choice")) isShowNumberInChoice = teamConfig.add_number_emoji_to_choice;
    let isShowNumberInChoiceBtn = gIsShowNumberInChoiceBtn;
    if(teamConfig.hasOwnProperty("add_number_emoji_to_choice_btn")) isShowNumberInChoiceBtn = teamConfig.add_number_emoji_to_choice_btn;
    const privateMetadata = {
      user_lang: appLang,
      anonymous: false,
      limited: false,
      hidden: false,
      user_add_choice: false,
      menu_at_the_end: isMenuAtTheEnd,
      show_help_link: isShowHelpLink,
      show_command_info: isShowCommandInfo,
      add_number_emoji_to_choice: isShowNumberInChoice,
      add_number_emoji_to_choice_btn: isShowNumberInChoiceBtn,
      response_url: response_url,
      channel: null,
    };

    let blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: stri18n(appLang,'modal_create_poll'),
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: stri18n(appLang,'modal_ch_manual_select'),
        },
      }
    ];
    //console.debug(response_url);
    if(response_url!== "" && response_url && isUseResponseUrl)
    {
      blocks = blocks.concat([
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: stri18n(appLang,'modal_ch_response_url_auto'),
            },
          ],
        }
      ]);
    }
    else
    {
      let warnStr = "modal_ch_warn";
      if(isUseResponseUrl) warnStr = "modal_ch_warn_with_response_url";
      blocks = blocks.concat([
        {
          type: 'actions',
          block_id: 'channel',
          elements: [
            {
              type: 'conversations_select',
              action_id: 'modal_poll_channel',
              placeholder: {
                type: 'plain_text',
                text: stri18n(appLang,'modal_ch_select'),
              },
            },
          ],
        },
        {
          type: 'context',
          block_id: 'ch_select_help',
          elements: [
            {
              type: 'mrkdwn',
              text: parameterizedString(langDict[appLang][warnStr],{slack_command:slackCommand,bot_name:botName}),
            },
          ],
        }
      ]);
    }

    let isAppLangSelectable = gIsAppLangSelectable;
    if(teamConfig.hasOwnProperty("app_lang_user_selectable"))
      isAppLangSelectable = teamConfig.app_lang_user_selectable;
    if(isAppLangSelectable)
    {
      let allOptions = [];
      let defaultOption = {};
      for (const langKey in langList) {
        const thisLangOp = {
          "text": {
            "type": "plain_text",
            "text": langList[langKey],
            "emoji": true
          },
          "value": langKey
        };
        if(appLang == langKey)
        {
          defaultOption = thisLangOp;
        }
        allOptions.push(thisLangOp);
      }

      blocks = blocks.concat([
        {
          "type": "input",
          "element": {
            "type": "static_select",
            "placeholder": {
              "type": "plain_text",
              "text": stri18n(appLang,'info_lang_select_hint'),
              "emoji": true
            },
            "options": allOptions,
            "initial_option" : defaultOption,
            //"action_id": "modal_select_lang"
          },
          "label": {
            "type": "plain_text",
            "text": stri18n(appLang,'info_lang_select_label'),
            "emoji": true
          },
          block_id: 'user_lang',
        }
      ]);
    }

    blocks = blocks.concat([
      {
        type: 'divider',
      },
      {
        type: 'section',
        block_id: 'options',
        text: {
          type: 'mrkdwn',
          text: stri18n(appLang,'modal_option')
        },
        accessory: {
          type: 'checkboxes',
          action_id: 'modal_poll_options',
          options: [
            {
              text: {
                type: 'mrkdwn',
                text: stri18n(appLang,'modal_option_anonymous')
              },
              description: {
                type: 'mrkdwn',
                text: stri18n(appLang,'modal_option_anonymous_hint')
              },
              value: 'anonymous'
            },
            {
              text: {
                type: 'mrkdwn',
                text: stri18n(appLang,'modal_option_limited')
              },
              description: {
                type: 'mrkdwn',
                text: stri18n(appLang,'modal_option_limited_hint')
              },
              value: 'limit'
            },
            {
              text: {
                type: 'mrkdwn',
                text: stri18n(appLang,'modal_option_hidden')
              },
              description: {
                type: 'mrkdwn',
                text: stri18n(appLang,'modal_option_hidden_hint')
              },
              value: 'hidden'
            },
            {
              text: {
                type: 'mrkdwn',
                text: stri18n(appLang,'modal_option_add_choice')
              },
              description: {
                type: 'mrkdwn',
                text: stri18n(appLang,'modal_option_add_choice_hint')
              },
              value: 'user_add_choice'
            }
          ]
        }
      },
      {
        type: 'divider',
      },
      {
        type: 'input',
        label: {
          type: 'plain_text',
          text: stri18n(appLang,'modal_input_limit_text'),
        },
        element: {
          type: 'plain_text_input',
          placeholder: {
            type: 'plain_text',
            text: stri18n(appLang,'modal_input_limit_hint'),
          },
        },
        optional: true,
        block_id: 'limit',
      },
      {
        type: 'divider',
      },
      {
        type: 'input',
        label: {
          type: 'plain_text',
          text: stri18n(appLang,'modal_input_question_text'),
        },
        element: {
          type: 'plain_text_input',
          placeholder: {
            type: 'plain_text',
            text: stri18n(appLang,'modal_input_question_hint'),
          },
        },
        block_id: 'question',
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: stri18n(appLang,'modal_input_choice_text'),
        },
      },
      tempModalBlockInput,
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'btn_add_choice',
            text: {
              type: 'plain_text',
              text: stri18n(appLang,'modal_input_choice_add'),
              emoji: true,
            },
          },
        ],
      },
    ]);

    //console.debug(JSON.stringify(blocks));
    const result = await client.views.open({
      token: context.botToken,
      trigger_id: trigger_id,
      view: {
        type: 'modal',
        callback_id: 'modal_poll_submit',
        private_metadata: JSON.stringify(privateMetadata),
        title: {
          type: 'plain_text',
          text: stri18n(appLang,'info_create_poll'),
        },
        submit: {
          type: 'plain_text',
          text: stri18n(appLang,'btn_create'),
        },
        close: {
          type: 'plain_text',
          text: stri18n(appLang,'btn_cancel'),
        },
        blocks: blocks,
      }
    });
  } catch (error) {
    console.error(error);
  }
}

app.action('modal_poll_channel', async ({ action, ack, body, client, context }) => {
  await ack();

  if (
    !action
    && !action.selected_channel
  ) {
    return;
  }
  const teamConfig = await getTeamOverride(body.team_id);
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
  const privateMetadata = JSON.parse(body.view.private_metadata);
  privateMetadata.channel = action.selected_channel || action.selected_conversation;

  //console.debug(action);
  //console.debug("CH:"+privateMetadata.channel);
  let isChFound = true;
  let isChErr = false;
  try {
    const result = await client.conversations.info({
      token: context.botToken,
      hash: body.view.hash,
      channel: privateMetadata.channel
     });
  }
  catch (e) {
    if(e.message.includes('channel_not_found'))
    {
      isChFound = false;
    }
    else
    {
      //ignote it!
      console.debug("Error on client.conversations.info (maybe user click too fast) :"+e.message);
      isChErr = true;
    }

  }

  let blocks = body.view.blocks;
  for (const i in blocks) {
    let b = blocks[i];
    if(b.hasOwnProperty('block_id')){
      //test next element
      let nextIndex = parseInt(i)+1;
      if(blocks.length > nextIndex  ){
        console.log("Block" +nextIndex +"IS:");
        console.log(blocks[nextIndex]);
        if(blocks[nextIndex].hasOwnProperty('elements') && blocks[nextIndex].type=="context"){
          console.log("TEST of" +nextIndex +"IS:"+ blocks[nextIndex].elements[0].text)
          if(isChErr) {
            blocks[nextIndex].elements[0].text = stri18n(appLang,'err_poll_ch_exception');
          }
          else if (isChFound) {
            blocks[nextIndex].elements[0].text = stri18n(appLang,'modal_bot_in_ch');
          }
          else {
            blocks[nextIndex].elements[0].text = parameterizedString(langDict[appLang]['modal_bot_not_in_ch'],{slack_command:slackCommand,bot_name:botName})
          }
          break;
        }
      }
    }
  }
  //console.debug(blocks);
  const view = {
    type: body.view.type,
    private_metadata: JSON.stringify(privateMetadata),
    callback_id: 'modal_poll_submit',
    title: body.view.title,
    submit: body.view.submit,
    close: body.view.close,
    blocks: body.view.blocks,
    external_id: body.view.id,
  };

  try {
    const result = await client.views.update({
      token: context.botToken,
      hash: body.view.hash,
      view: view,
      view_id: body.view.id,
    });
  }
  catch (e) {
    console.debug("Error on modal_poll_channel (maybe user click too fast");
  }
});

app.action('modal_poll_options', async ({ action, ack, body, client, context }) => {
  await ack();

  if (
    !body
    || !body.view
    || !body.view.private_metadata
  ) {
    return;
  }

  const privateMetadata = JSON.parse(body.view.private_metadata);

  privateMetadata.anonymous = false;
  privateMetadata.limited = false;
  for (const option of action.selected_options) {
    if ('anonymous' === option.value) {
      privateMetadata.anonymous = true;
    } else if ('limit' === option.value) {
      privateMetadata.limited = true;
    } else if ('hidden' === option.value) {
      privateMetadata.hidden = true;
    } else if ('user_add_choice' === option.value) {
      privateMetadata.user_add_choice = true;
    }
  }

  const view = {
    type: body.view.type,
    private_metadata: JSON.stringify(privateMetadata),
    callback_id: 'modal_poll_submit',
    title: body.view.title,
    submit: body.view.submit,
    close: body.view.close,
    blocks: body.view.blocks,
    external_id: body.view.id,
  };
  try {
    const result = await client.views.update({
      token: context.botToken,
      hash: body.view.hash,
      view: view,
      view_id: body.view.id,
    });
  }
  catch (e){
    //just ignore it will be process again on modal_poll_submit
    console.debug("Error on modal_poll_submit (maybe user click too fast");
  }
});

app.view('modal_poll_submit', async ({ ack, body, view, context }) => {
  if(!isUseResponseUrl) await ack();
  else await ack();

  if (
    !view
    || !body
    || !view.blocks
    || !view.state
    || !view.private_metadata
    || !body.user
    || !body.user.id
  ) {
    return;
  }
  const teamConfig = await getTeamOverride(body.team_id);
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
  const privateMetadata = JSON.parse(view.private_metadata);
  const userId = body.user.id;

  const state = view.state;
  let question = null;
  let userLang = appLang;
  const options = [];
  let limit = 1;

  if (state.values) {
    for (const optionName in state.values) {
      const option = state.values[optionName][Object.keys(state.values[optionName])[0]];
      if ('question' === optionName) {
        question = option.value;
      } else if ('user_lang' === optionName) {
        if(langList.hasOwnProperty(option.selected_option.value)){
          userLang = option.selected_option.value;
        }
      } else if ('limit' === optionName) {
        limit = parseInt(option.value, 10);
      } else if (optionName.startsWith('choice_')) {
        options.push(option.value);
      } else if ('options' === optionName) {
        const checkedbox = state.values[optionName]['modal_poll_options']['selected_options'];
        if (checkedbox) {
          for (const each in checkedbox) {
            const checkedValue = checkedbox[each].value;
            if ('anonymous' === checkedValue) {
              privateMetadata.anonymous = true;
            } else if ('limit' === checkedValue) {
              privateMetadata.limited = true;
            } else if ('hidden' === checkedValue) {
              privateMetadata.hidden = true;
            } else if ('user_add_choice' === checkedValue) {
              privateMetadata.user_add_choice = true;
            }
          }
        }
      }
    }
  }

  if(isNaN(limit)) limit = 1;
  privateMetadata.user_lang = userLang;
  const isAnonymous = privateMetadata.anonymous;
  const isLimited = privateMetadata.limited;
  const isHidden = privateMetadata.hidden;
  const channel = privateMetadata.channel;
  const isAllowUserAddChoice = privateMetadata.user_add_choice;
  const response_url = privateMetadata.response_url;

  if (
    !question
    || 0 === options.length
  ) {
    return;
  }

  const cmd = createCmdFromInfos(question, options, isAnonymous, isLimited, limit, isHidden, isAllowUserAddChoice, userLang);

  let isMenuAtTheEnd = gIsMenuAtTheEnd;
  let isShowHelpLink = gIsShowHelpLink;
  let isShowCommandInfo = gIsShowCommandInfo;
  let isShowNumberInChoice = gIsShowNumberInChoice;
  let isShowNumberInChoiceBtn = gIsShowNumberInChoiceBtn;
  if(privateMetadata.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = privateMetadata.menu_at_the_end;
  else if(teamConfig.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = teamConfig.menu_at_the_end;
  if(privateMetadata.hasOwnProperty("show_help_link")) isShowHelpLink = privateMetadata.show_help_link;
  else if(teamConfig.hasOwnProperty("show_help_link")) isShowHelpLink = teamConfig.show_help_link;
  if(privateMetadata.hasOwnProperty("show_command_info")) isShowCommandInfo = privateMetadata.show_command_info;
  else if(teamConfig.hasOwnProperty("show_command_info")) isShowCommandInfo = teamConfig.show_command_info;
  if(privateMetadata.hasOwnProperty("add_number_emoji_to_choice")) isShowNumberInChoice = privateMetadata.add_number_emoji_to_choice;
  else if(teamConfig.hasOwnProperty("add_number_emoji_to_choice")) isShowNumberInChoice = teamConfig.add_number_emoji_to_choice;
  if(privateMetadata.hasOwnProperty("add_number_emoji_to_choice_btn")) isShowNumberInChoiceBtn = privateMetadata.add_number_emoji_to_choice_btn;
  else if(teamConfig.hasOwnProperty("add_number_emoji_to_choice_btn")) isShowNumberInChoiceBtn = teamConfig.add_number_emoji_to_choice_btn;

  const blocks = createPollView(question, options, isAnonymous, isLimited, limit, isHidden, isAllowUserAddChoice, isMenuAtTheEnd, isShowHelpLink, isShowCommandInfo, isShowNumberInChoice, isShowNumberInChoiceBtn, userLang, userId, cmd);

  let mRequestBody = {
    token: context.botToken,
    channel: channel,
    blocks: blocks,
    text: `Poll : ${question}`,
  };
  await postChat(response_url,'post',mRequestBody);
});

function createCmdFromInfos(question, options, isAnonymous, isLimited, limit, isHidden, isAllowUserAddChoice, userLang) {
  let cmd = `/${slackCommand}`;
  if (isAnonymous) {
    cmd += ` anonymous`
  }
  if (isLimited) {
    cmd += ` limit`
  }
  if (limit > 1) {
    cmd += ` ${limit}`
  }
  if (isHidden) {
    cmd += ` hidden`
  }
  if (isAllowUserAddChoice) {
    cmd += ` add-choice`
  }
  if (userLang!=null) {
    cmd += ` lang ${userLang}`
  }

  question = question.replace(/"/g, "\\\"");
  cmd += ` "${question}"`

  for (let option of options) {
    option = option.replace(/"/g, "\\\"");
    cmd += ` "${option}"`
  }

  return cmd;
}

function createPollView(question, options, isAnonymous, isLimited, limit, isHidden, isAllowUserAddChoice, isMenuAtTheEnd, isShowHelpLink, isShowCommandInfo, isShowNumberInChoice, isShowNumberInChoiceBtn, userLang, userId, cmd) {
  if (
    !question
    || !options
    || 0 === options.length
  ) {
    return null;
  }

  //const userLang = appLang;

  const blocks = [];

  const staticSelectElements = [{
    label: {
      type: 'plain_text',
      text: stri18n(userLang,'menu_poll_action'),
    },
    options: [{
      text: {
        type: 'plain_text',
        text: isHidden ? stri18n(userLang,'menu_reveal_vote') : stri18n(userLang,'menu_hide_vote'),
      },
      value:
        JSON.stringify({action: 'btn_reveal', revealed: !isHidden, user: userId, user_lang: userLang, menu_at_the_end: isMenuAtTheEnd, show_help_link: isShowHelpLink, show_command_info: isShowCommandInfo}),
    }, {
      text: {
        type: 'plain_text',
        text: stri18n(userLang,'menu_all_user_vote'),
      },
      value: JSON.stringify({action: 'btn_users_votes', user: userId, user_lang: userLang}),
    }, {
      text: {
        type: 'plain_text',
        text: stri18n(userLang,'menu_delete_poll'),
      },
      value: JSON.stringify({action: 'btn_delete', user: userId, user_lang: userLang}),
    }, {
      text: {
        type: 'plain_text',
        text: stri18n(userLang,'menu_close_poll'),
      },
      value: JSON.stringify({action: 'btn_close', user: userId, user_lang: userLang, menu_at_the_end: isMenuAtTheEnd, show_help_link: isShowHelpLink, show_command_info: isShowCommandInfo}),
    }],
  }, {
    label: {
      type: 'plain_text',
      text: stri18n(userLang,'menu_user_action'),
    },
    options: [{
      text: {
        type: 'plain_text',
        text: stri18n(userLang,'menu_user_self_vote'),
      },
      value: JSON.stringify({action: 'btn_my_votes', user: userId, user_lang: userLang }),
    }],
  }];

  if (supportUrl) {
    staticSelectElements.push({
      label: {
        type: 'plain_text',
        text: stri18n(userLang,'menu_support'),
      },
      options: [{
        text: {
          type: 'plain_text',
          text: stri18n(userLang,'menu_love_open_poll'),
        },
        value: JSON.stringify({action: 'btn_love_open_poll', user: userId}),
      }],
    });
  }

  if(isMenuAtTheEnd)
  {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: question,
      },
    });
  }
  else
  {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: question,
      },
      accessory: {
        type: 'static_select',
        placeholder: { type: 'plain_text', text: 'Menu' },
        action_id: 'static_select_menu',
        option_groups: staticSelectElements,
      },
    });
  }

  let elements = [];
  if (isAnonymous || isLimited || isHidden) {
    if (isAnonymous) {
      elements.push({
        type: 'mrkdwn',
        text: stri18n(userLang,'info_anonymous'),
      });
    }
    if (isLimited) {
      elements.push({
        type: 'mrkdwn',
        text: parameterizedString(stri18n(userLang,'info_limited'),{limit:limit})+stri18n(userLang,'info_s'),
      });
    }
    if (isHidden) {
      elements.push({
        type: 'mrkdwn',
        text: stri18n(userLang,'info_hidden'),
      });
    }
  }
  elements.push({
    type: 'mrkdwn',
    text: parameterizedString(stri18n(userLang,'info_by'),{user_id:userId}),
  });
  blocks.push({
    type: 'context',
    elements: elements,
  });
  if(stri18n(userLang,'info_addon')!=="")
  {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: stri18n(userLang,'info_addon'),
      }],
    });
  }
  blocks.push({
    type: 'divider',
  });

  let button_value = {
    user_lang: userLang,
    anonymous: isAnonymous,
    limited: isLimited,
    limit: limit,
    hidden: isHidden,
    user_add_choice: isAllowUserAddChoice,
    menu_at_the_end: isMenuAtTheEnd,
    show_help_link: isShowHelpLink,
    show_command_info: isShowCommandInfo,
    add_number_emoji_to_choice: isShowNumberInChoice,
    add_number_emoji_to_choice_btn: isShowNumberInChoiceBtn,
    voters: [],
    id: null,
  };

  for (let i in options) {
    let option = options[i];
    let btn_value = JSON.parse(JSON.stringify(button_value));
    btn_value.id = i;

    blocks.push(buildVoteBlock(btn_value, option, isShowNumberInChoice, isShowNumberInChoiceBtn));

    let block = {
      type: 'context',
      elements: [
        {
          type: 'plain_text',
          text: btn_value['hidden'] ? stri18n(userLang,'info_wait_reveal') : stri18n(userLang,'info_no_vote'),
        }
      ],
    };
    blocks.push(block);


    blocks.push({
      type: 'divider',
    });


  }

  if(isAllowUserAddChoice)
  {
    blocks.push({
      "type": "input",
      "dispatch_action": true,
      "element": {
        "type": "plain_text_input",
        "action_id": "add_choice_after_post",
        "dispatch_action_config": {
          "trigger_actions_on": [
            "on_enter_pressed"
          ]
        },
        "placeholder": {
          "type": "plain_text",
          "text": stri18n(userLang,'info_others_add_choice_hint')
        }
      },
      "label": {
        "type": "plain_text",
        "text": stri18n(userLang,'info_others_add_choice'),
        "emoji": true
      }
    });
  }

  if(isShowHelpLink)
  {
    if(isShowCommandInfo)
    {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `<${helpLink}|`+stri18n(userLang,'info_need_help')+`>`,
          },
          {
            type: 'mrkdwn',
            text: stri18n(userLang,'info_need_help')+' '+cmd,
          },
        ],
      });
    }
    else
    {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `<${helpLink}|`+stri18n(userLang,'info_need_help')+`>`,
          }
        ],
      });
    }

  }
  else if(isShowCommandInfo)
  {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: ':information_source: '+cmd,
        },
      ],
    });
  }

  if(isMenuAtTheEnd)
  {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ' ',
      },
      accessory: {
        type: 'static_select',
        placeholder: { type: 'plain_text', text: stri18n(userLang,'menu_text') },
        action_id: 'static_select_menu',
        option_groups: staticSelectElements,
      },
    });
  }

  return blocks;
}

// btn actions
app.action('overflow_menu', btnActions);
app.action('static_select_menu', btnActions);
app.action('ignore_me', async ({ ack }) => { await ack() });

async function btnActions(args) {
  const {ack, action, body, client, context} = args;
  await ack();

  if (
    !action
    || !action.selected_option
    || !action.selected_option.value
  ) {
    return;
  }

  const value = JSON.parse(action.selected_option.value);

  if (!value || !value.action || !value.user) {
    return;
  }

  if ('btn_love_open_poll' === value.action)
    supportAction(body, client, context)
  else if ('btn_my_votes' === value.action)
    myVotes(body, client, context);
  else if ('btn_users_votes' === value.action)
    usersVotes(body, client, context, value);
  else if ('btn_reveal' === value.action)
    revealOrHideVotes(body, context, value);
  else if ('btn_delete' === value.action)
    deletePoll(body, context, value);
  else if ('btn_close' === value.action)
    closePoll(body, client, context, value);
}

async function supportAction(body, client, context) {
  if (
    !body.user
    || !body.user.id
    || !body.channel
    || !body.channel.id
  ) {
    return;
  }

  const blocks = [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: stri18n(gAppLang,'menu_support_love_app'),
    },
  },
  { type: 'divider' },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: stri18n(gAppLang,'menu_support_contribute'),
    },
    accessory: {
      type: 'button',
      text: {
        type: 'plain_text',
        text: stri18n(gAppLang,'menu_support_source'),
      },
      style: 'primary',
      url: helpLink,
      action_id: 'ignore_me',
    }
  },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: stri18n(gAppLang,'menu_support_me'),
    },
    accessory: {
      type: 'button',
      text: {
        type: 'plain_text',
        text: stri18n(gAppLang,'menu_support_me_buy_coffee'),
      },
      url: supportUrl,
      action_id: 'ignore_me',
    }
  }];

  let mRequestBody = {
    token: context.botToken,
    channel: body.channel.id,
    user: body.user.id,
    blocks,
    text: stri18n(gAppLang,'menu_support_open_poll'),
  };
  await postChat(body.response_url,'ephemeral',mRequestBody);

}

async function myVotes(body, client, context) {
  if (
    !body.hasOwnProperty('user')
    || !body.user.hasOwnProperty('id')
  ) {
    return;
  }
  const teamConfig = await getTeamOverride(body.team_id);
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
  const blocks = body.message.blocks;
  let votes = [];
  const userId = body.user.id;
  let userLang = appLang;

  for (const block of blocks) {
    if (
      'section' !== block.type
      || !block.hasOwnProperty('accessory')
      || !block.accessory.hasOwnProperty('action_id')
      || 'btn_vote' !== block.accessory.action_id
      || !block.accessory.hasOwnProperty('value')
      || !block.hasOwnProperty('text')
      || !block.text.hasOwnProperty('text')
    ) {
      continue;
    }
    const value = JSON.parse(block.accessory.value);


    if(value.hasOwnProperty('user_lang'))
      if(value.user_lang!="" && value.user_lang != null)
        userLang = value.user_lang;

    if (value.voters.includes(userId)) {
      votes.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: block.text.text,
        },
      });
      votes.push({
        type: 'divider',
      });
    }
  }

  if (0 === votes.length) {
    votes.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: stri18n(userLang,'info_not_vote_yet'),
      },
    });
  } else {
    votes.pop();
  }

  try {
    await client.views.open({
      token: context.botToken,
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        title: {
          type: 'plain_text',
          text: stri18n(userLang,'info_your_vote'),
        },
        close: {
          type: 'plain_text',
          text: stri18n(userLang,'info_close'),
        },
        blocks: votes,
      }
    });
  } catch (e) {
    console.error(e);
  }
}

async function usersVotes(body, client, context, value) {
  if (
    !body
    || !body.user
    || !body.user.id
    || !body.message
    || !body.message.ts
    || !body.message.blocks
    || !body.channel
    || !body.channel.id
    || !value
  ) {
    console.log('error');
    return;
  }
  const teamConfig = await getTeamOverride(body.team_id);
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
  if (body.user.id !== value.user) {
    console.log('invalid user');
    let mRequestBody = {
      token: context.botToken,
      channel: body.channel.id,
      user: body.user.id,
      attachments: [],
      text: stri18n(appLang,'err_see_all_vote_other'),
    };
    await postChat(body.response_url,'ephemeral',mRequestBody);

    return;
  }

  const message = body.message;
  const channel = body.channel.id;
  const blocks = message.blocks;

  const votes = [];
  let poll = null;

  try {
    const data = await votesCol.findOne({ channel: channel, ts: message.ts });
    if (data === null) {
      await votesCol.insertOne({
        team: message.team,
        channel,
        ts: message.ts,
        votes: {},
      });
      poll = {};
      for (const b of blocks) {
        if (
          b.hasOwnProperty('accessory')
          && b.accessory.hasOwnProperty('value')
        ) {
          const val = JSON.parse(b.accessory.value);
          poll[val.id] = val.voters ? val.voters : [];
        }
      }
      await votesCol.updateOne({
        channel,
        ts: message.ts,
      }, {
        $set: {
          votes: poll,
        }
      });
    } else {
      poll = data.votes;
    }
  } catch(e) {
  }

  let userLang = appLang;
  for (const block of blocks) {
    if (
      block.hasOwnProperty('accessory')
      && block.accessory.hasOwnProperty('value')
    ) {
      const value = JSON.parse(block.accessory.value);
      const voters = poll ? (poll[value.id] || []) : [];


      if(value.hasOwnProperty('user_lang'))
        if(value.user_lang!="" && value.user_lang != null)
          userLang = value.user_lang;

      votes.push({
        type: 'divider',
      });
      votes.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: block.text.text,
        },
      });
      votes.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: !voters.length
            ? stri18n(userLang,'info_no_vote')
            : voters.map(el => {
                return `<@${el}>`;
              }).join(', '),
        }],
      });
    }
  }

  try {
    await client.views.open({
      token: context.botToken,
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        title: {
          type: 'plain_text',
          text: stri18n(userLang,'info_all_user_vote'),
        },
        close: {
          type: 'plain_text',
          text: stri18n(userLang,'info_close'),
        },
        blocks: votes,
      },
    });
  } catch (e) {
    console.error(e);
  }
}

async function revealOrHideVotes(body, context, value) {

  let menuAtIndex = 0;
  const teamConfig = await getTeamOverride(body.team_id);
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
  let isMenuAtTheEnd = gIsMenuAtTheEnd;
  if(value.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = value.menu_at_the_end;
  else if (teamConfig.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = teamConfig.menu_at_the_end;
  if(isMenuAtTheEnd) menuAtIndex = body.message.blocks.length-1;
  if (
    !body
    || !body.user
    || !body.user.id
    || !body.message
    || !body.message.ts
    || !body.message.blocks
    || !body.channel
    || !body.channel.id
    || !value
    || !body.message.blocks[0]
    || !body.message.blocks[menuAtIndex].accessory
    || (
      !body.message.blocks[menuAtIndex].accessory.options
      && !body.message.blocks[menuAtIndex].accessory.option_groups
    )
  ) {
    console.log('error');
    return;
  }

  if (body.user.id !== value.user) {
    console.log('invalid user');
    let mRequestBody = {
      token: context.botToken,
      channel: body.channel.id,
      user: body.user.id,
      attachments: [],
      text: stri18n(appLang,'err_reveal_other'),
    };
    await postChat(body.response_url,'ephemeral',mRequestBody);

    return;
  }

  if (!value.hasOwnProperty('revealed')) {
    console.log('Missing `revealed` information on poll');
    let mRequestBody = {
      token: context.botToken,
      channel: body.channel.id,
      user: body.user.id,
      attachments: [],
      text: stri18n(appLang,'err_poll_unconsistent_exception'),
    };
    await postChat(body.response_url,'ephemeral',mRequestBody);
    return;
  }

  let isHidden = !value.revealed;
  let message = body.message;
  let channel = body.channel.id;
  let blocks = message.blocks;

  if (!mutexes.hasOwnProperty(`${message.team}/${channel}/${message.ts}`)) {
    mutexes[`${message.team}/${channel}/${message.ts}`] = new Mutex();
  }

  let release = null;
  let countTry = 0;
  do {
    ++countTry;

    try {
      release = await mutexes[`${message.team}/${channel}/${message.ts}`].acquire();
    } catch (e) {
      console.log(`[Try #${countTry}] Error while attempt to acquire mutex lock.`, e)
    }
  } while (!release && countTry < 3);

  let userLang = appLang;
  let isUserLangFound = false;
  if (release) {
    try {
      let poll = null;
      const data = await votesCol.findOne({ channel: channel, ts: message.ts });

      if (data === null) {
        await votesCol.insertOne({
          team: message.team,
          channel,
          ts: message.ts,
          votes: {},
        });
        poll = {};
        for (const b of blocks) {
          if (
            b.hasOwnProperty('accessory')
            && b.accessory.hasOwnProperty('value')
          ) {
            const val = JSON.parse(b.accessory.value);
            poll[val.id] = val.voters ? val.voters : [];
          }
        }
        await votesCol.updateOne({
          channel,
          ts: message.ts,
        }, {
          $set: {
            votes: poll,
          }
        });
      } else {
        poll = data.votes;
      }

      for (const b of blocks) {
        if(isUserLangFound) break;
        if (
            b.hasOwnProperty('accessory')
            && b.accessory.hasOwnProperty('value')
        ) {
          const val = JSON.parse(b.accessory.value);
          if(val.hasOwnProperty('user_lang')) {
            isUserLangFound = true;
            userLang = val.user_lang;
          }
        }
      }

      const infos = await getInfos(
        ['anonymous', 'limited', 'limit', 'hidden'],
        blocks,
        {
          team: message.team,
          channel,
          ts: message.ts,
        }
      );
      isHidden = !infos.hidden;

      await hiddenCol.updateOne({
        channel,
        ts: message.ts,
      }, {
        $set: {
          hidden: isHidden,
        },
      });
      //console.debug(blocks);
      for (const i in blocks) {
        let b = blocks[i];
        if (
          b.hasOwnProperty('accessory')
          && b.accessory.hasOwnProperty('value')
        ) {
          let val = JSON.parse(b.accessory.value);
          val.hidden = isHidden;

          val.voters = poll[val.id];
          let newVoters = '';

          if (isHidden) {
            newVoters = stri18n(userLang,'info_wait_reveal');
          } else {
            if (poll[val.id].length === 0) {
              newVoters = stri18n(userLang,'info_no_vote');
            } else {
              newVoters = '';
              for (const voter of poll[val.id]) {
                if (!val.anonymous) {
                  newVoters += `<@${voter}> `;
                }
              }

              const vLength = poll[val.id].length;
              newVoters += `${poll[val.id].length} vote${vLength === 1 ? '' : 's'}`;
            }
          }

          blocks[i].accessory.value = JSON.stringify(val);
          const nextI = ''+(parseInt(i)+1);
          if (blocks[nextI].hasOwnProperty('elements')) {
            blocks[nextI].elements[0].text = newVoters;
          }
        }
      }

      if (blocks[menuAtIndex].accessory.options) {
        blocks[menuAtIndex].accessory.options = await buildMenu(blocks, {
          team: message.team,
          channel,
          ts: message.ts,
        },userLang,isMenuAtTheEnd);
      } else if (blocks[menuAtIndex].accessory.option_groups) {
        blocks[menuAtIndex].accessory.option_groups[0].options = await buildMenu(blocks, {
          team: message.team,
          channel,
          ts: message.ts,
        },userLang,isMenuAtTheEnd);
      }

      const infosIndex = blocks.findIndex(el => el.type === 'context' && el.elements)
      blocks[infosIndex].elements = await buildInfosBlocks(
        blocks,
        {
          team: message.team,
          channel,
          ts: message.ts,
        },
        userLang
      );

      let mRequestBody = {
        token: context.botToken,
        channel: channel,
        ts: message.ts,
        blocks: blocks,
        text: message.text
      };
      await postChat(body.response_url,'update',mRequestBody);
    } catch (e) {
      console.error(e);
      let mRequestBody = {
        token: context.botToken,
        channel: body.channel.id,
        user: body.user.id,
        attachments: [],
        text: (isHidden ? stri18n(userLang,'err_poll_hide_exception'): stri18n(userLang,'err_poll_reveal_exception')),
      };
      await postChat(body.response_url,'ephemeral',mRequestBody);
    } finally {
      release();
    }
  } else {
    let mRequestBody = {
      token: context.botToken,
      channel: body.channel.id,
      user: body.user.id,
      attachments: [],
      text: stri18n(userLang,'err_vote_exception'),
    };
    await postChat(body.response_url,'ephemeral',mRequestBody);
  }
}

async function deletePoll(body, context, value) {
  if (
    !body
    || !body.user
    || !body.user.id
    || !body.message
    || !body.message.ts
    || !body.channel
    || !body.channel.id
    || !value
  ) {
    console.log('error');
    return;
  }
  const teamConfig = await getTeamOverride(body.team_id);
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
  if (body.user.id !== value.user) {
    console.log('invalid user');
    let mRequestBody = {
      token: context.botToken,
      channel: body.channel.id,
      user: body.user.id,
      attachments: [],
      text: stri18n(appLang,'err_delete_other'),
    };
    await postChat(body.response_url,'ephemeral',mRequestBody);
    return;
  }

  let mRequestBody = {
    token: context.botToken,
    channel: body.channel.id,
    ts: body.message.ts,
  };
  await postChat(body.response_url,'delete',mRequestBody);
}

async function closePoll(body, client, context, value) {
  let menuAtIndex = 0;
  const teamConfig = await getTeamOverride(body.team_id);
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;

  let isMenuAtTheEnd = gIsMenuAtTheEnd;
  if(value.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = value.menu_at_the_end;
  else if (teamConfig.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = teamConfig.menu_at_the_end;

  if(isMenuAtTheEnd) menuAtIndex = body.message.blocks.length-1;
  if (
    !body
    || !body.user
    || !body.user.id
    || !body.message
    || !body.message.ts
    || !body.message.blocks
    || !body.channel
    || !body.channel.id
    || !value
  ) {
    console.log('error');
    return;
  }

  if (body.user.id !== value.user) {
    console.log('invalid user');
    let mRequestBody = {
      token: context.botToken,
          channel: body.channel.id,
          user: body.user.id,
          attachments: [],
          text: stri18n(appLang,'err_close_other'),
    };
    await postChat(body.response_url,'ephemeral',mRequestBody);
    return;
  }

  const message = body.message;
  const channel = body.channel.id;
  const blocks = message.blocks;

  if (!mutexes.hasOwnProperty(`${message.team}/${channel}/${message.ts}`)) {
    mutexes[`${message.team}/${channel}/${message.ts}`] = new Mutex();
  }

  let release = null;
  let countTry = 0;
  do {
    ++countTry;

    try {
      release = await mutexes[`${message.team}/${channel}/${message.ts}`].acquire();
    } catch (e) {
      console.log(`[Try #${countTry}] Error while attempt to acquire mutex lock.`, e)
    }
  } while (!release && countTry < 3);

  if (release) {
    try {
      let isClosed = false
      try {
        const data = await closedCol.findOne({ channel, ts: message.ts });
        if (data === null) {
          await closedCol.insertOne({
            team: message.team,
            ts: message.ts,
            closed: false,
          });
        }
        isClosed = data !== null && data.closed;
      } catch {}

      await closedCol.updateOne({
        channel,
        ts: message.ts,
      }, {
        $set: { closed: !isClosed }
      });

      let userLang = appLang;
      if (isClosed) {
        for (const i in blocks) {
          const block = blocks[i];

          if (
            block.hasOwnProperty('accessory')
            && block.accessory.hasOwnProperty('value')
          ) {
            const value = JSON.parse(block.accessory.value);

            value.closed = false;

            blocks[i].accessory.value = JSON.stringify(value);

            if(value.hasOwnProperty('user_lang'))
              if(value.user_lang!="" && value.user_lang != null)
                userLang = value.user_lang;

          }
        }
      } else {
        for (const i in blocks) {
          const block = blocks[i];

          if (
            block.hasOwnProperty('accessory')
            && block.accessory.hasOwnProperty('value')
          ) {
            const value = JSON.parse(block.accessory.value);

            value.closed = true;

            blocks[i].accessory.value = JSON.stringify(value);

            if(value.hasOwnProperty('user_lang'))
              if(value.user_lang!="" && value.user_lang != null)
                userLang = value.user_lang;
          }
        }
      }

      if (blocks[menuAtIndex].accessory.option_groups) {
        const staticSelectMenu = blocks[menuAtIndex].accessory.option_groups[0].options;
        blocks[menuAtIndex].accessory.option_groups[0].options =
          await buildMenu(blocks, {
            team: message.team,
            channel,
            ts: message.ts,
          },userLang,isMenuAtTheEnd);
      }

      const infosIndex =
        blocks.findIndex(el => el.type === 'context' && el.elements);
      blocks[infosIndex].elements = await buildInfosBlocks(
        blocks,
        {
          team: message.team,
          channel,
          ts: message.ts,
        },
        userLang
      );

      let mRequestBody = {
        token: context.botToken,
        channel,
        ts: message.ts,
        blocks: blocks,
        text: message.text,
      };
      await postChat(body.response_url,'update',mRequestBody);
    } catch (e) {
      console.error(e);
      let mRequestBody = {
        token: context.botToken,
        channel: body.channel.id,
        user: body.user.id,
        attachments: [],
        text: stri18n(userLang,'err_close_other'),
      };
      await postChat(body.response_url,'ephemeral',mRequestBody);
    } finally {
      release();
    }
  } else {
    let mRequestBody = {
      token: context.botToken,
      channel: body.channel.id,
      user: body.user.id,
      attachments: [],
      text: stri18n(userLang,'err_close_other'),
    };
    await postChat(body.response_url,'ephemeral',mRequestBody);
  }
}


// global functions
async function getInfos(infos, blocks, pollInfos) {
  const multi = Array.isArray(infos);
  let result = multi ? {} : null;
  let toFix = [];

  if (pollInfos) {
    if (multi && infos.includes('closed')) {
      const data = await closedCol.findOne({
        channel: pollInfos.channel,
        ts: pollInfos.ts,
      });

      if (data !== null) {
        result['closed'] = data.closed;
        infos = infos.filter(i => i !== 'closed');
      } else {
        toFix.push('closed');
      }
    } else if (infos === 'closed') {
      const data = await closedCol.findOne({
        channel: pollInfos.channel,
        ts: pollInfos.ts,
      });

      if (data !== null) return data.closed;
      else toFix.push('closed');
    }

    if (multi && infos.includes('hidden')) {
      const data = await hiddenCol.findOne({
        channel: pollInfos.channel,
        ts: pollInfos.ts,
      });

      if (data !== null) {
        result['hidden'] = data.hidden;
        infos = infos.filter(i => i !== 'hidden');
      } else {
        toFix.push('hidden');
      }
    } else if (infos === 'hidden') {
      const data = await hiddenCol.findOne({
        channel: pollInfos.channel,
        ts: pollInfos.ts,
      });

      if (data !== null) return data.hidden;
      else toFix.push('hidden');
    }
  }

  if (multi) {
    for (const i of infos) {
      result[i] = null;
    }
  }

  for (const block of blocks) {
    if (
      block.hasOwnProperty('accessory')
      && block.accessory.hasOwnProperty('value')
    ) {
      const value = JSON.parse(block.accessory.value);

      if (multi) {
        for (const i of infos) {
          if (result[i] === null && value.hasOwnProperty(i)) {
            result[i] = value[i];
          }
        }

        if (!Object.keys(result).find(i => result[i] === null)) {
          break;
        }
      } else {
        if (value.hasOwnProperty(infos)) {
          result = value[infos];
          break;
        }
      }
    }
  }

  if (toFix.length > 0) {
    if (multi) {
      if (toFix.includes('closed') && result['closed'] !== null) {
        closedCol.insertOne({
          team: pollInfos.team,
          channel: pollInfos.channel,
          ts: pollInfos.ts,
          closed: result['closed'],
        });
      }
      if (toFix.includes('hidden') && result['hidden'] !== null) {
        hiddenCol.insertOne({
          team: pollInfos.team,
          channel: pollInfos.channel,
          ts: pollInfos.ts,
          hidden: result['hidden'],
        });
      }
    } else {
      if (toFix.includes('closed') && result !== null) {
        closedCol.insertOne({
          team: pollInfos.team,
          channel: pollInfos.channel,
          ts: pollInfos.ts,
          closed: result,
        });
      } else if (toFix.includes('hidden') && result !== null) {
        hiddenCol.insertOne({
          team: pollInfos.team,
          channel: pollInfos.channel,
          ts: pollInfos.ts,
          hidden: result,
        });
      }
    }
  }

  return result;
}

async function buildInfosBlocks(blocks, pollInfos,userLang) {
  if(userLang == null) userLang = gAppLang;
  const infosIndex =
    blocks.findIndex(el => el.type === 'context' && el.elements);
  const infosBlocks = [];
  const infos = await getInfos(['anonymous', 'limited', 'limit', 'hidden', 'closed'], blocks, pollInfos);

  if (infos.anonymous) {
    infosBlocks.push({
      type: 'mrkdwn',
      text: stri18n(userLang,'info_anonymous'),
    });
  }
  if (infos.limited) {
    infosBlocks.push({
      type: 'mrkdwn',
      text : parameterizedString(stri18n(userLang,'info_limited'),{limit:infos.limit})+stri18n(userLang,'info_s'),
    });
  }
  if (infos.hidden) {
    infosBlocks.push({
      type: 'mrkdwn',
      text: stri18n(userLang,'info_hidden'),
    });
  }
  if (infos.closed) {
    infosBlocks.push({
      type: 'mrkdwn',
      text: stri18n(userLang,'info_closed'),
    });
  }
  infosBlocks.push(blocks[infosIndex].elements.pop());
  return infosBlocks;
}

async function buildMenu(blocks, pollInfos,userLang,isMenuAtTheEnd) {
  let menuAtIndex = 0;
  if(isMenuAtTheEnd) menuAtIndex = blocks.length-1;
  if(userLang == null) userLang = gAppLang;
  const infos = await getInfos(['closed', 'hidden'], blocks, pollInfos);

  if (blocks[menuAtIndex].accessory.option_groups) {
    return blocks[menuAtIndex].accessory.option_groups[0].options.map(el => {
      const value = JSON.parse(el.value);
      if (value && 'btn_close' === value.action) {
        el.text.text = infos['closed'] ? stri18n(userLang,'menu_reopen_poll') : stri18n(userLang,'menu_close_poll');
        value.closed = !value.closed;
        el.value = JSON.stringify(value);
      } else if (value && 'btn_reveal' === value.action) {
        el.text.text = infos['hidden'] ? stri18n(userLang,'menu_reveal_vote') : stri18n(userLang,'menu_hide_vote');
        value.revealed = !value.closed;
        el.value = JSON.stringify(value);
      }

      return el;
    });
  } else if (blocks[menuAtIndex].accessory.options) {
    return blocks[menuAtIndex].accessory.options.map((el) => {
      const value = JSON.parse(el.value);
      if (value && 'btn_reveal' === value.action) {
        el.text.text = infos['hidden'] ? stri18n(userLang,'menu_reveal_vote') : stri18n(userLang,'menu_hide_vote');
        value.revealed = !value.closed;
        el.value = JSON.stringify(value);
      }

      return el;
    });
  }

  return null;
}

function buildVoteBlock(btn_value, option_text, isShowNumberInChoice, isShowNumberInChoiceBtn) {
  let emojiPrefix = "";
  let emojiBthPostfix = "";
  let voteId = parseInt(btn_value.id);
  let userLang = gAppLang;
  if(btn_value.hasOwnProperty('user_lang'))
    if(btn_value['user_lang']!="" && btn_value['user_lang'] != null)
    userLang = btn_value['user_lang'];
  if(isShowNumberInChoice) emojiPrefix = slackNumToEmoji(voteId+1,userLang)+" ";
  if(isShowNumberInChoiceBtn) emojiBthPostfix = " "+slackNumToEmoji(voteId+1,userLang);
  let block = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: emojiPrefix+""+option_text,
    },
    accessory: {
      type: 'button',
      action_id: 'btn_vote',
      text: {
        type: 'plain_text',
        emoji: true,
        text: stri18n(userLang,'btn_vote')+""+emojiBthPostfix,
      },
      value: JSON.stringify(btn_value),
    },
  };
  return block;
}
