const { App, ExpressReceiver, LogLevel } = require('@slack/bolt');
const config = require('config');

const { MongoClient } = require('mongodb');

const { Migrations } = require('./utils/migrations');

const { Mutex } = require('async-mutex');

const fileLang = require('node:fs');

const globLang = require('glob');

let langDict = {};

const port = config.get('port');
const signing_secret = config.get('signing_secret');
const slackCommand = config.get('command');
const helpLink = config.get('help_link');
const supportUrl = config.get('support_url');
const appLang = config.get('app_lang');
const isUseResponseUrl = config.get('use_response_url');
const isMenuAtTheEnd = config.get('menu_at_the_end');
const botName = config.get('bot_name');
const isShowHelpLink = config.get('show_help_link');
const isShowCommandInfo = config.get('show_command_info');
const isShowNumberInChoice = config.get('add_number_emoji_to_choice');
const isShowNumberInChoiceBtn = config.get('add_number_emoji_to_choice_btn');

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
      langCount++;
    }
  }
});
//console.debug(langDict);
console.log("Lang Count: "+langCount);
console.log("Selected Lang: "+appLang);

const parameterizedString = (str,varArray) => {
  let outputStr = str;
  for (let key in varArray) {
    if (varArray.hasOwnProperty(key))
    {
      outputStr = outputStr.replaceAll("{{"+key+"}}",varArray[key])
    }
  }
  return outputStr;
}

const receiver = new ExpressReceiver({
  signingSecret: signing_secret,
  clientId: config.get('client_id'),
  clientSecret: config.get('client_secret'),
  scopes: ['commands', 'chat:write.public', 'chat:write', 'groups:write'],
  stateSecret: config.get('state_secret'),
  endpoints: {
    events: '/slack/events',
    commands: '/slack/commands',
    actions: '/slack/actions',
  },
  installerOptions: {
    installPath: '/slack/install',
    redirectUriPath: '/slack/oauth_redirect',
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
  })//.then(res => res.json())
  //.then(console.debug)
  ;
}

const postChat = async (url,type,requestBody) => {
  if(isUseResponseUrl)
  {
    delete requestBody['token'];
    delete requestBody['channel'];
    delete requestBody['user'];
    switch (type)
    {
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
      switch (type)
      {
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

const slackNumToEmoji = (seq) => {
  let outText = "["+seq+"]";
  if(langDict[appLang].hasOwnProperty('emoji_'+seq))
  {
    outText = langDict[appLang]['emoji_'+seq];
  }
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

app.command(`/${slackCommand}`, async ({ ack, body, client, command, context, say }) => {
  //if(!isResponseInCh)
  await ack();

  let cmdBody = (command && command.text) ? command.text.trim() : null;

  const isHelp = cmdBody ? 'help' === cmdBody : false;

  const channel = (command && command.channel_id) ? command.channel_id : null;

  const userId = (command && command.user_id) ? command.user_id : null;

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

    let isAnonymous = false;
    let isLimited = false;
    let limit = null;
    let isHidden = false;
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
      } else if (cmdBody.startsWith('hidden')) {
        fetchArgs = true;
        cmdBody = cmdBody.substring(6).trim();
        isHidden = true;
      }
    }

    const lastSep = cmdBody.split('').pop();
    const firstSep = cmdBody.charAt(0);

    if (isLimited && null === limit) {
      limit = 1;
    }

    const regexp = new RegExp(firstSep+'[^'+firstSep+'\\\\]*(?:\\\\[\S\s][^'+lastSep+'\\\\]*)*'+lastSep, 'g');
    for (let option of cmdBody.match(regexp)) {
      let opt = option.substring(1, option.length - 1);
      if (question === null) {
        question = opt;
      } else {
        options.push(opt);
      }
    }

    const blocks = createPollView(question, options, isAnonymous, isLimited, limit, isHidden, userId, cmd);

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

const modalBlockInput = {
  type: 'input',
  element: {
    type: 'plain_text_input',
    placeholder: {
      type: 'plain_text',
      text: langDict[appLang]['modal_input_choice'],
    },
  },
  label: {
    type: 'plain_text',
    text: ' ',
  },
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
  await ack();

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

  let blocks = body.view.blocks;
  const hash = body.view.hash;

  let beginBlocks = blocks.slice(0, blocks.length - 1);
  let endBlocks = blocks.slice(-1);

  let tempModalBlockInput = JSON.parse(JSON.stringify(modalBlockInput));
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

  const result = await client.views.update({
    token: context.botToken,
    hash: hash,
    view: view,
    view_id: body.view.id,
  });
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
        text: langDict[appLang]['you_have_not_voted'],
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
          text: langDict[appLang]['info_your_vote'],
        },
        close: {
          type: 'plain_text',
          text: langDict[appLang]['info_close'],
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

  if (body.user.id !== action.value) {
    console.log('invalid user');
    let mRequestBody = {
      token: context.botToken,
      channel: body.channel.id,
      user: body.user.id,
      attachments: [],
      text: langDict[appLang]['can_not_delete_other'],
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

  let value = JSON.parse(action.value);

  if (body.user.id !== value.user) {
    console.log('invalid user');
    let mRequestBody = {
      token: context.botToken,
      channel: body.channel.id,
      user: body.user.id,
      attachments: [],
      text: langDict[appLang]['err_reveal_other'],
    };
    await postChat(body.response_url,'ephemeral',mRequestBody);
    return;
  }

  let mRequestBody = {
    token: context.botToken,
    channel: body.channel.id,
    user: body.user.id,
    attachments: [],
    text: langDict[appLang]['err_poll_too_old'],
  };
  await postChat(body.response_url,'ephemeral',mRequestBody);
});

app.action('btn_vote', async ({ action, ack, body, context }) => {
  await ack();
  let menuAtIndex = 0;
  if(isMenuAtTheEnd) menuAtIndex = body.message.blocks.length-1;
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
            text: langDict[appLang]['err_change_vote_poll_closed'],
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
            text : parameterizedString(langDict[appLang]['err_vote_over_limit'],{limit:value.limit}),
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

          val.voters = poll[val.id];
          let newVoters = '';

          if (isHidden) {
            newVoters = 'Wait for reveal';
          } else if (poll[val.id].length === 0) {
            newVoters = 'No votes';
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
        }
      );
      blocks[menuAtIndex].accessory.option_groups[0].options =
        await buildMenu(blocks, {
          team: message.team,
          channel,
          ts: message.ts,
        });

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
        text: langDict[appLang]['err_vote_exception'],
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
      text: langDict[appLang]['err_vote_exception'],
    };
    await postChat(body.response_url,'ephemeral',mRequestBody);

  }
});

app.shortcut('open_modal_new', async ({ shortcut, ack, context, client }) => {
  await ack();
  createModal(context, client, shortcut.trigger_id);
});

async function createModal(context, client, trigger_id,response_url) {
  try {
    let tempModalBlockInput = JSON.parse(JSON.stringify(modalBlockInput));
    tempModalBlockInput.block_id = 'choice_0';

    const privateMetadata = {
      anonymous: false,
      limited: false,
      hidden: false,
      response_url: response_url,
      channel: null,
    };

    let blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: langDict[appLang]['modal_create_poll'],
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: langDict[appLang]['modal_ch_manual_select'],
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
              text: langDict[appLang]['modal_ch_response_url_auto'],
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
                text: langDict[appLang]['modal_ch_select'],
              },
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: parameterizedString(langDict[appLang][warnStr],{slack_command:slackCommand,bot_name:botName}),
            },
          ],
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
          text: langDict[appLang]['modal_option']
        },
        accessory: {
          type: 'checkboxes',
          action_id: 'modal_poll_options',
          options: [
            {
              text: {
                type: 'mrkdwn',
                text: langDict[appLang]['modal_option_anonymous']
              },
              description: {
                type: 'mrkdwn',
                text: langDict[appLang]['modal_option_anonymous_hint']
              },
              value: 'anonymous'
            },
            {
              text: {
                type: 'mrkdwn',
                text: langDict[appLang]['modal_option_limited']
              },
              description: {
                type: 'mrkdwn',
                text: langDict[appLang]['modal_option_limited_hint']
              },
              value: 'limit'
            },
            {
              text: {
                type: 'mrkdwn',
                text: langDict[appLang]['modal_option_hidden']
              },
              description: {
                type: 'mrkdwn',
                text: langDict[appLang]['modal_option_hidden_hint']
              },
              value: 'hidden'
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
          text: langDict[appLang]['modal_input_limit_text'],
        },
        element: {
          type: 'plain_text_input',
          placeholder: {
            type: 'plain_text',
            text: langDict[appLang]['modal_input_limit_hint'],
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
          text: langDict[appLang]['modal_input_question_text'],
        },
        element: {
          type: 'plain_text_input',
          placeholder: {
            type: 'plain_text',
            text: langDict[appLang]['modal_input_question_hint'],
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
          text: langDict[appLang]['modal_input_choice_text'],
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
              text: langDict[appLang]['modal_input_choice_add'],
              emoji: true,
            },
          },
        ],
      },
    ]);

    const result = await client.views.open({
      token: context.botToken,
      trigger_id: trigger_id,
      view: {
        type: 'modal',
        callback_id: 'modal_poll_submit',
        private_metadata: JSON.stringify(privateMetadata),
        title: {
          type: 'plain_text',
          text: langDict[appLang]['info_create_poll'],
        },
        submit: {
          type: 'plain_text',
          text: langDict[appLang]['btn_create'],
        },
        close: {
          type: 'plain_text',
          text: langDict[appLang]['btn_cancel'],
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

  const privateMetadata = JSON.parse(body.view.private_metadata);
  privateMetadata.channel = action.selected_channel || action.selected_conversation;

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

  const result = await client.views.update({
    token: context.botToken,
    hash: body.view.hash,
    view: view,
    view_id: body.view.id,
  });
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

  const result = await client.views.update({
    token: context.botToken,
    hash: body.view.hash,
    view: view,
    view_id: body.view.id,
  });
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

  const privateMetadata = JSON.parse(view.private_metadata);
  const userId = body.user.id;

  const state = view.state;
  let question = null;
  const options = [];
  const isAnonymous = privateMetadata.anonymous;
  const isLimited = privateMetadata.limited;
  let limit = 1;
  const isHidden = privateMetadata.hidden;
  const channel = privateMetadata.channel;
  const response_url = privateMetadata.response_url;

  if (state.values) {
    for (const optionName in state.values) {
      const option = state.values[optionName][Object.keys(state.values[optionName])[0]];
      if ('question' === optionName) {
        question = option.value;
      } else if ('limit' === optionName) {
        limit = parseInt(option.value, 10);
      } else if (optionName.startsWith('choice_')) {
        options.push(option.value);
      }
    }
  }

  if (
    !question
    || 0 === options.length
  ) {
    return;
  }

  const cmd = createCmdFromInfos(question, options, isAnonymous, isLimited, limit, isHidden);

  const blocks = createPollView(question, options, isAnonymous, isLimited, limit, isHidden, userId, cmd);

    let mRequestBody = {
      token: context.botToken,
      channel: channel,
      blocks: blocks,
      text: `Poll : ${question}`,
    };
    await postChat(response_url,'post',mRequestBody);
});

function createCmdFromInfos(question, options, isAnonymous, isLimited, limit, isHidden) {
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

  question = question.replace(/"/g, "\\\"");
  cmd += ` "${question}"`

  for (let option of options) {
    option = option.replace(/"/g, "\\\"");
    cmd += ` "${option}"`
  }

  return cmd;
}

function createPollView(question, options, isAnonymous, isLimited, limit, isHidden, userId, cmd) {
  if (
    !question
    || !options
    || 0 === options.length
  ) {
    return null;
  }

  const blocks = [];

  const staticSelectElements = [{
    label: {
      type: 'plain_text',
      text: langDict[appLang]['menu_poll_action'],
    },
    options: [{
      text: {
        type: 'plain_text',
        text: isHidden ? langDict[appLang]['menu_reveal_vote'] : langDict[appLang]['menu_hide_vote'],
      },
      value:
        JSON.stringify({action: 'btn_reveal', revealed: !isHidden, user: userId}),
    }, {
      text: {
        type: 'plain_text',
        text: langDict[appLang]['menu_all_user_vote'],
      },
      value: JSON.stringify({action: 'btn_users_votes', user: userId}),
    }, {
      text: {
        type: 'plain_text',
        text: langDict[appLang]['menu_delete_poll'],
      },
      value: JSON.stringify({action: 'btn_delete', user: userId}),
    }, {
      text: {
        type: 'plain_text',
        text: langDict[appLang]['menu_close_poll'],
      },
      value: JSON.stringify({action: 'btn_close', user: userId}),
    }],
  }, {
    label: {
      type: 'plain_text',
      text: langDict[appLang]['menu_user_action'],
    },
    options: [{
      text: {
        type: 'plain_text',
        text: langDict[appLang]['menu_user_self_vote'],
      },
      value: JSON.stringify({action: 'btn_my_votes', user: userId}),
    }],
  }];

  if (supportUrl) {
    staticSelectElements.push({
      label: {
        type: 'plain_text',
        text: langDict[appLang]['menu_support'],
      },
      options: [{
        text: {
          type: 'plain_text',
          text: langDict[appLang]['menu_love_open_poll'],
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
        text: langDict[appLang]['info_anonymous'],
      });
    }
    if (isLimited) {
      elements.push({
        type: 'mrkdwn',
        text: parameterizedString(langDict[appLang]['info_limited'],{limit:limit})+langDict[appLang]['info_s'],
      });
    }
    if (isHidden) {
      elements.push({
        type: 'mrkdwn',
        text: langDict[appLang]['info_hidden'],
      });
    }
  }
  elements.push({
    type: 'mrkdwn',
    text: parameterizedString(langDict[appLang]['info_by'],{user_id:userId}),
  });
  blocks.push({
    type: 'context',
    elements: elements,
  });
  if(langDict[appLang]['info_addon']!=="")
  {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: langDict[appLang]['info_addon'],
      }],
    });
  }
  blocks.push({
    type: 'divider',
  });

  let button_value = {
    anonymous: isAnonymous,
    limited: isLimited,
    limit: limit,
    hidden: isHidden,
    voters: [],
    id: null,
  };

  let optionCount = 0;
  for (let i in options) {
    optionCount++;
    let emojiPrefix = "";
    let emojiBthPostfix = "";
    if(isShowNumberInChoice) emojiPrefix = slackNumToEmoji(optionCount)+" ";
    if(isShowNumberInChoiceBtn) emojiBthPostfix = " "+slackNumToEmoji(optionCount);
    let option = options[i];
    let btn_value = JSON.parse(JSON.stringify(button_value));
    btn_value.id = i;
    let block = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: emojiPrefix+""+option,
      },
      accessory: {
        type: 'button',
        action_id: 'btn_vote',
        text: {
          type: 'plain_text',
          emoji: true,
          text: langDict[appLang]['btn_vote']+""+emojiBthPostfix,
        },
        value: JSON.stringify(btn_value),
      },
    };
    blocks.push(block);
    block = {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: isHidden ? langDict[appLang]['info_wait_reveal'] : langDict[appLang]['info_no_vote'],
        }
      ],
    };
    blocks.push(block);
    blocks.push({
      type: 'divider',
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
            text: `<${helpLink}|`+langDict[appLang]['info_need_help']+`>`,
          },
          {
            type: 'mrkdwn',
            text: langDict[appLang]['info_need_help']+' '+cmd,
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
            text: `<${helpLink}|`+langDict[appLang]['info_need_help']+`>`,
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
        placeholder: { type: 'plain_text', text: langDict[appLang]['menu_text'] },
        action_id: 'static_select_menu',
        option_groups: staticSelectElements,
      }, //move to the end
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
      text: ':heart: You love the app ?',
    },
  },
  { type: 'divider' },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: ':technologist: Contribute on it',
    },
    accessory: {
      type: 'button',
      text: {
        type: 'plain_text',
        text: 'Open GitLab',
      },
      style: 'primary',
      url: 'https://gitlab.com/KazuAlex/openpollslack',
      action_id: 'ignore_me',
    }
  },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: ':coffee: Buy me a coffee to help me to maintain servers or just thanks me',
    },
    accessory: {
      type: 'button',
      text: {
        type: 'plain_text',
        text: 'Buy a coffee',
      },
      url: 'https://www.buymeacoffee.com/kazualex',
      action_id: 'ignore_me',
    }
  }];

  let mRequestBody = {
    token: context.botToken,
    channel: body.channel.id,
    user: body.user.id,
    blocks,
    text: 'Support Open Poll',
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

  const blocks = body.message.blocks;
  let votes = [];
  const userId = body.user.id;

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
        text: langDict[appLang]['info_not_vote_yet'],
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
          text: langDict[appLang]['info_your_vote'],
        },
        close: {
          type: 'plain_text',
          text: langDict[appLang]['info_close'],
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

  if (body.user.id !== value.user) {
    console.log('invalid user');
    let mRequestBody = {
      token: context.botToken,
      channel: body.channel.id,
      user: body.user.id,
      attachments: [],
      text: langDict[appLang]['err_see_all_vote_other'],
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

  for (const block of blocks) {
    if (
      block.hasOwnProperty('accessory')
      && block.accessory.hasOwnProperty('value')
    ) {
      const value = JSON.parse(block.accessory.value);
      const voters = poll ? (poll[value.id] || []) : [];
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
            ? langDict[appLang]['info_no_vote']
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
          text: langDict[appLang]['info_all_user_vote'],
        },
        close: {
          type: 'plain_text',
          text: langDict[appLang]['info_close'],
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
      text: langDict[appLang]['err_reveal_other'],
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
      text: langDict[appLang]['err_poll_unconsistent_exception'],
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
            newVoters = langDict[appLang]['info_wait_reveal'];
          } else {
            if (poll[val.id].length === 0) {
              newVoters = langDict[appLang]['info_no_vote'];
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
        });
      } else if (blocks[menuAtIndex].accessory.option_groups) {
        blocks[menuAtIndex].accessory.option_groups[0].options = await buildMenu(blocks, {
          team: message.team,
          channel,
          ts: message.ts,
        });
      }

      const infosIndex = blocks.findIndex(el => el.type === 'context' && el.elements)
      blocks[infosIndex].elements = await buildInfosBlocks(
        blocks,
        {
          team: message.team,
          channel,
          ts: message.ts,
        }
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
        text: `An error occurred during ${isHidden ? 'hide' : 'reveal'} process. Please try again in few seconds.`,
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
      text: langDict[appLang]['err_vote_exception'],
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

  if (body.user.id !== value.user) {
    console.log('invalid user');
    let mRequestBody = {
      token: context.botToken,
      channel: body.channel.id,
      user: body.user.id,
      attachments: [],
      text: langDict[appLang]['err_delete_other'],
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
          text: langDict[appLang]['err_close_other'],
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
          });
      }

      const infosIndex =
        blocks.findIndex(el => el.type === 'context' && el.elements);
      blocks[infosIndex].elements = await buildInfosBlocks(
        blocks,
        {
          team: message.team,
          channel,
          ts: message.ts,
        }
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
        text: langDict[appLang]['err_close_other'],
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
      text: langDict[appLang]['err_close_other'],
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

async function buildInfosBlocks(blocks, pollInfos) {
  const infosIndex =
    blocks.findIndex(el => el.type === 'context' && el.elements);
  const infosBlocks = [];
  const infos = await getInfos(['anonymous', 'limited', 'limit', 'hidden', 'closed'], blocks, pollInfos);

  if (infos.anonymous) {
    infosBlocks.push({
      type: 'mrkdwn',
      text: langDict[appLang]['info_anonymous'],
    });
  }
  if (infos.limited) {
    infosBlocks.push({
      type: 'mrkdwn',
      text : parameterizedString(langDict[appLang]['info_limited'],{limit:infos.limit})+langDict[appLang]['info_s'],
    });
  }
  if (infos.hidden) {
    infosBlocks.push({
      type: 'mrkdwn',
      text: langDict[appLang]['info_hidden'],
    });
  }
  if (infos.closed) {
    infosBlocks.push({
      type: 'mrkdwn',
      text: langDict[appLang]['info_closed'],
    });
  }
  infosBlocks.push(blocks[infosIndex].elements.pop());
  return infosBlocks;
}

async function buildMenu(blocks, pollInfos) {
  let menuAtIndex = 0;
  if(isMenuAtTheEnd) menuAtIndex = blocks.length-1;
  const infos = await getInfos(['closed', 'hidden'], blocks, pollInfos);

  if (blocks[menuAtIndex].accessory.option_groups) {
    return blocks[menuAtIndex].accessory.option_groups[0].options.map(el => {
      const value = JSON.parse(el.value);
      if (value && 'btn_close' === value.action) {
        el.text.text = infos['closed'] ? langDict[appLang]['menu_reopen_poll'] : langDict[appLang]['menu_close_poll'];
        value.closed = !value.closed;
        el.value = JSON.stringify(value);
      } else if (value && 'btn_reveal' === value.action) {
        el.text.text = infos['hidden'] ? langDict[appLang]['menu_reveal_vote'] : langDict[appLang]['menu_hide_vote'];
        value.revealed = !value.closed;
        el.value = JSON.stringify(value);
      }

      return el;
    });
  } else if (blocks[menuAtIndex].accessory.options) {
    return blocks[menuAtIndex].accessory.options.map((el) => {
      const value = JSON.parse(el.value);
      if (value && 'btn_reveal' === value.action) {
        el.text.text = infos['hidden'] ? langDict[appLang]['menu_reveal_vote'] : langDict[appLang]['menu_hide_vote'];
        value.revealed = !value.closed;
        el.value = JSON.stringify(value);
      }

      return el;
    });
  }

  return null;
}
