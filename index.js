const { App, ExpressReceiver, LogLevel } = require('@slack/bolt');
const config = require('config');

const { MongoClient, ObjectId } = require('mongodb');

const { Migrations } = require('./utils/migrations');

const { Mutex } = require('async-mutex');

const fileLang = require('node:fs');

//const globLang = require('glob');
const {globSync} = require("glob");

const cron = require('node-cron');
const { CronExpressionParser } = require('cron-parser');
const cronstrue = require('cronstrue');
const cronstrueOp = { use24HourTimeFormat: true };

const { createLogger, format, transports } = require('winston');
const fs = require('fs');
const path = require('path');
//const moment = require('moment');
const moment = require('moment-timezone');

const { v4: uuidv4 } = require('uuid');

let langDict = {};

let langList = {};

const port = config.get('port');
const signing_secret = config.get('signing_secret');
const slackCommand = config.get('command');
const slackCommand2 = config.get('command2');
const helpLink = config.get('help_link');
const helpEmail = config.get('help_email');
const supportUrl = config.get('support_url');
const gAppLang = config.get('app_lang');
const gAppAllowDM = config.get('app_allow_dm');
const gSlackLimitChoices = config.get('slack_limit_choices');
const gAppDatetimeFormat = config.get('app_datetime_format');
const gIsAppLangSelectable = config.get('app_lang_user_selectable');
const isUseResponseUrl = config.get('use_response_url');
const gIsViaCmdOnly = config.get('create_via_cmd_only');
const gIsMenuAtTheEnd = config.get('menu_at_the_end');
const botName = config.get('bot_name');
const gIsCompactUI = config.get('compact_ui');
const gIsShowDivider = config.get('show_divider');
const gIsShowHelpLink = config.get('show_help_link');
const gIsShowCommandInfo = config.get('show_command_info');
const gTrueAnonymous = config.get('true_anonymous');
const gIsShowNumberInChoice = config.get('add_number_emoji_to_choice');
const gIsShowNumberInChoiceBtn = config.get('add_number_emoji_to_choice_btn');
const gIsDeleteDataOnRequest = config.get('delete_data_on_poll_delete');
const gLogLevelApp = config.get('log_level_app');
const gLogLevelAppFile = config.get('log_level_app_file');
const gLogLevelBolt = config.get('log_level_bolt');
const gLogLevelBoltFile = config.get('log_level_bolt_file');
const gLogToFile = config.get('log_to_file');
const gScheduleLimitHr = config.get('schedule_limit_hrs');
const gScheduleMaxRun = parseInt(config.get('schedule_max_run'));
const gScheduleAutoDeleteDay = config.get('schedule_auto_delete_invalid_day');

const validTeamOverrideConfigTF = ["create_via_cmd_only","app_lang_user_selectable","menu_at_the_end","compact_ui","show_divider","show_help_link","show_command_info","true_anonymous","add_number_emoji_to_choice","add_number_emoji_to_choice_btn","delete_data_on_poll_delete","app_allow_dm"];

const validUserOverrideConfigTF = ["user_allow_dm"];

const mClient = new MongoClient(config.get('mongo_url'));
let orgCol = null;
let userCol = null;
let votesCol = null;
let closedCol = null;
let hiddenCol = null;
let pollCol = null;
let scheduleCol = null;

let migrations = null;

const mutexes = {};

// Define the accepted quotes and the standard quote
const acceptedQuotes = [
  `"`,    // Standard Double Quote (U+0022)
  `“`,    // Left Double Quotation Mark (U+201C)
  `”`,    // Right Double Quotation Mark (U+201D)
  `„`,    // Double Low-9 Quotation Mark (U+201E)
  `‟`,    // Double High-Reversed-9 Quotation Mark (U+201F)
  // `«`,    // Left-Pointing Double Angle Quotation Mark (U+00AB)
  // `»`,    // Right-Pointing Double Angle Quotation Mark (U+00BB)
  `〝`,   // Reversed Double Prime Quotation Mark (U+301D)
  `〞`,   // Double Prime Quotation Mark (U+301E)
  `〟`,   // Low Double Prime Quotation Mark (U+301F)
  // `「`,   // Left Corner Bracket (U+300C, used in CJK languages)
  // `」`,   // Right Corner Bracket (U+300D, used in CJK languages)
  // `『`,   // Left White Corner Bracket (U+300E, used in CJK languages)
  // `』`    // Right White Corner Bracket (U+300F, used in CJK languages)
];
const standardQuote = `"`;

console.log('Init Logger..');

const prettyJson = format.printf(info => {
  try {
    if (info.message.constructor === Object) {
      info.message = JSON.stringify(info.message, null, 4)
    }
  }
  catch (e) {
    console.error(e);
    console.error(info);
    info.message = JSON.stringify(info, null, 4)
    return `${info.timestamp} ${info.level}: ${info.message}`
  }
  return `${info.timestamp} ${info.level}: ${info.message}`
})

const appTransportsArray = [
  new transports.Console({
    level: gLogLevelApp,
    format: format.combine(
        format.colorize(),
        format.prettyPrint(),
        prettyJson,
        format.printf(
            info => `${info.timestamp} ${info.level}: ${info.message}`
        )
    )
  })
];

const boltTransportsArray = [
  new transports.Console({
    level: gLogLevelBolt,
    format: format.combine(
        format.colorize(),
        format.prettyPrint(),
        prettyJson,
        format.printf(
            info => `${info.timestamp} ${info.level}: ${info.message}`
        )
    )
  })
];

if (gLogToFile) {
  const gLogDir = path.normalize(config.get('log_dir').toString());
  // Create the log directory if it does not exist
  if (!fs.existsSync(gLogDir)) {
    fs.mkdirSync(gLogDir);
  }
  const logTS = moment().format('YYYY-MM-DD');
  const filenameLogApp = path.join(gLogDir, logTS+'_app.log');
  const filenameLogBolt = path.join(gLogDir, logTS+'_bolt.log');

  let logFileWritable = true;
  fs.access(filenameLogApp, fs.constants.W_OK, (err) => {

    if (err) {
      if (err.code === 'ENOENT') {
        //logger.info('The file does not exist, it can be created');
        logger.info(`Log file '${filenameLogApp}' is writable`);
      } else {
        logger.error(`Log file '${filenameLogApp}' is not writable, SKIP LOG TO FILE!`);
        logFileWritable = false;
      }
    } else {
      logger.info(`Log file '${filenameLogApp}' is writable`);
    }
  });
  if(logFileWritable) {
    appTransportsArray.push(new transports.File({ filename:filenameLogApp }));
  }

  logFileWritable = true;
  fs.access(filenameLogBolt, fs.constants.W_OK, (err) => {
    if (err) {
      if (err.code === 'ENOENT') {
        //logger.info('The file does not exist, it can be created');
        logger.info(`Log file '${filenameLogBolt}' is writable`);
      } else {
        logger.error(`Log file '${filenameLogBolt}' is not writable, SKIP LOG TO FILE!`);
        logFileWritable = false;
      }
    } else {
      logger.info(`Log file '${filenameLogBolt}' is writable`);
    }
  });
  if(logFileWritable) {
    boltTransportsArray.push(new transports.File({ filename:filenameLogBolt }));
  }
}

const logger = createLogger({
  level: gLogLevelAppFile,
  format: format.combine(
      format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
      }),
      format.printf(info => `${info.timestamp} ${info.level}[App]: ${info.message}`)
  ),
  transports: appTransportsArray
});

const loggerBolt = createLogger({
  level: gLogLevelBoltFile,
  format: format.combine(
      format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
      }),
      format.printf(info => `${info.timestamp} ${info.level}[Bolt]: ${info.message}`)
  ),
  transports: boltTransportsArray
});

logger.info('Server starting...');

try {
  logger.info('Connecting to database server...');
  mClient.connect();
  logger.info('Connected successfully to server')
  const db = mClient.db(config.get('mongo_db_name'));
  orgCol = db.collection('token');
  userCol = db.collection('user_config');
  votesCol = db.collection('votes');
  closedCol = db.collection('closed');
  hiddenCol = db.collection('hidden');
  pollCol = db.collection('poll_data');
  scheduleCol = db.collection('poll_schedule');

  migrations = new Migrations(db);
} catch (e) {
  mClient.close();
  logger.error(e)
  logger.error(e.toString()+"\n"+e.stack);
  console.log(e);
  process.exit();
}

const createDBIndex = async () => {
  orgCol.createIndex({"team.id": 1});
  orgCol.createIndex({"enterprise.id": 1});
  userCol.createIndex({team_id: 1, user_id: 1});
  votesCol.createIndex({ channel: 1, ts: 1 });
  votesCol.createIndex({ poll_id: 1 });
  closedCol.createIndex({ channel: 1, ts: 1 });
  hiddenCol.createIndex({ channel: 1, ts: 1 });
  pollCol.createIndex({ channel: 1, ts: 1 });
  pollCol.createIndex({ schedule_end_active: 1, schedule_end_ts: 1 });
  scheduleCol.createIndex({ poll_id: 1, next_ts: 1, is_enable: 1, is_done: 1   });
  scheduleCol.createIndex({ next_ts: 1, is_enable: 1 , is_done: 1  });
}

let langCount = 0;

//globLang.sync( './language/*.json' ).forEach( function( file ) {
globSync( './language/*.json' ).forEach( function( file ) {
  let dash = file.split(/[\\/]+/);
    let dot = dash[dash.length-1].split(".");
    if(dot.length === 2) {
      let lang = dot[0];
      logger.info("Lang file ["+lang+"]: "+file);
      let fileData = fileLang.readFileSync(file);
      langDict[lang] = JSON.parse(fileData.toString());
      if(langDict[lang].hasOwnProperty('info_lang_name'))
        langList[lang] = langDict[lang]['info_lang_name'];
      else
        langList[lang] = lang;
      langCount++;
    }
});


logger.info("Lang Count: "+langCount);
logger.info("Selected Lang: "+gAppLang);
if(!langDict.hasOwnProperty('en')) {
  logger.error("language/en.json NOT FOUND!");
  throw new Error("language/en.json NOT FOUND!");
}
if(!langDict.hasOwnProperty(gAppLang)) {
  logger.error(`language/${gAppLang}.json NOT FOUND!`);
  throw new Error(`language/${gAppLang}.json NOT FOUND!`);
}

logger.info('Init cron jobs...');

function calculateNextScheduleTime(cronString,timeZoneString) {
  try {
    if(timeZoneString===null) timeZoneString = 'UTC';
    const options = {
      tz: timeZoneString
    };
    const interval = CronExpressionParser.parse(cronString,options);
    return interval.next().toDate();
  } catch (e) {
    //console.log(e);
    logger.debug(e.toString()+"\n"+e.stack);
    return null;
  }
}
const checkAndExecuteTasks = async () => {
  const currentDateTime = new Date();
  try {
    const pendingTasks = await scheduleCol.find({
      next_ts: { $lte: currentDateTime },
      is_enable: true,
      is_done: false,
    }).toArray();

    for (const task of pendingTasks) {
      logger.debug(`[Schedule] processing poll_id: ${task.poll_id}.`);
      let calObjId = null;
      let pollData = null;
      let pollCh = null;

      let dmOwnerString = null;

      try {
        calObjId = new ObjectId(task.poll_id);
        pollData = await pollCol.findOne({ _id: calObjId  });
      }
      catch (e) { }

      let isPollValid = true;
      let mBotToken = null;
      let mTaskOwner = null;

      let appLang= gAppLang;
      let isAppAllowDM = gAppAllowDM;
      if(pollData?.team !== "" && pollData?.team != null) {
        const teamConfig = await getTeamOverride(pollData?.team);
        if (teamConfig.hasOwnProperty("app_allow_dm")) isAppAllowDM = teamConfig.app_allow_dm;
        if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
      }

      let taskRunCounter = 1;
      let taskRunMax = gScheduleMaxRun;
      if(task.hasOwnProperty('run_counter')) taskRunCounter = task.run_counter + 1;
      if(task.hasOwnProperty('run_max')) taskRunMax = Math.min(task.run_max,gScheduleMaxRun);
      let cmdNote = `Run: ${taskRunCounter} of ${taskRunMax}`;

      if(task.hasOwnProperty('created_user_id')) mTaskOwner = task.created_user_id;

      if (!pollData) {
        isPollValid = false;
      }
      else
      {
        // Perform poll info checking
        let errMsg = "";
        if(pollData.hasOwnProperty('team') && pollData.hasOwnProperty('channel')) {
          if(pollData.team !== "" && pollData.team != null &&
              pollData.channel !== "" && pollData.channel != null
          ) {
            //get req info to run task
            const teamInfo = await getTeamInfo(pollData.team);
            //logger.debug("Got team info:");
            //logger.debug(teamInfo);
            if(teamInfo?.bot?.token !== undefined) {
              mBotToken = teamInfo.bot.token;
              pollCh = pollData.channel;
            } else {
              errMsg = `[Schedule] poll_id: ${task.poll_id}: Unable to get valid bot token.`;
              isPollValid = false;
            }
          } else {
            errMsg = `[Schedule] poll_id: ${task.poll_id}: Poll create with older version of App which is not support to create task.`;
            dmOwnerString = errMsg;
            isPollValid = false;
          }
        } else {
          errMsg = `[Schedule] poll_id: ${task.poll_id}: Poll create with older version of App which is not support to create task.`;
          dmOwnerString = errMsg;
          isPollValid = false;
        }

        if(!isPollValid) {
          logger.verbose(errMsg);
          logger.verbose(`[Schedule] poll_id: ${task.poll_id}: Delete invalid task from DB.`);
          await scheduleCol.updateOne(
              { _id: task._id },
              { $set: { is_enable: false, last_error_ts: new Date(), last_error_text: errMsg} }
          );
          continue;
          // Delete the invalid task from scheduleCol
          //await scheduleCol.deleteOne({ _id: task._id });
          //continue; // Skip this task and move to the next one
        }


        if(task.hasOwnProperty('poll_ch')) {
          if(task.poll_ch !== "" && task.poll_ch != null ) {
            pollCh = task.poll_ch;
          }
        }


        logger.verbose(`[Schedule] Executing task for poll_id: ${task.poll_id} to CH:${pollCh} ${cmdNote}`);
        try {
          const pollView = (await createPollView(pollData.team, pollCh, pollData.question, pollData.options, pollData.para?.anonymous??false, pollData.para?.limited, pollData.para?.limit, pollData.para?.hidden, pollData.para?.user_add_choice,
              pollData.para?.menu_at_the_end, pollData.para?.compact_ui, pollData.para?.show_divider, pollData.para?.show_help_link, pollData.para?.show_command_info, pollData.para?.true_anonymous, pollData.para?.add_number_emoji_to_choice, pollData.para?.add_number_emoji_to_choice_btn, pollData.schedule_end_ts, pollData.para?.user_lang, task.created_user_id, pollData.cmd,"task_schedule",task.poll_id,cmdNote,false,null));
          const blocks = pollView?.blocks;
          const pollID = pollView?.poll_id;

          if (null === pollView || null === blocks) {
            errMsg = `[Schedule] Failed to create poll ch:${pollData.channel} ID:${task.poll_id} CMD:${pollData.cmd}`;
            dmOwnerString = errMsg;
            logger.warn(errMsg);
            return;
          }

          let mRequestBody = {
            token: mBotToken,
            channel: pollCh,
            blocks: blocks,
            text: `Poll : ${pollData.question}`,
          };
          const postRes = await postChat("",'post',mRequestBody);
          let localizeTS = await getAndlocalizeTimeStamp(mBotToken,mTaskOwner,task.next_ts);
          if(postRes.status === false) {
            dmOwnerString = parameterizedString(stri18n(gAppLang,'task_scheduled_post_noti_error'), {error:postRes.message,poll_id:task.poll_id,poll_cmd:pollData.cmd,ts:localizeTS,note:`\n${cmdNote}`} )

            if(task.hasOwnProperty('next_error_disable_poll'))  {
              if(task.next_error_disable_poll === true) {
                await scheduleCol.updateOne(
                    { _id: task._id },
                    { $set: { is_enable: false } }
                );
                continue;
              }
            }

            await scheduleCol.updateOne(
                { _id: task._id },
                { $set: { last_error_ts: new Date(), last_error_text: postRes?.message, next_error_disable_poll: true } }
            );
            //continue;
          } else {
            //update slack_ts
            await pollCol.updateOne(
                { _id: new ObjectId(pollID)},
                { $set: { ts: postRes.slack_ts } }
            );
            if(taskRunCounter>=taskRunMax) {
              //last one
              dmOwnerString = parameterizedString(stri18n(gAppLang,'task_scheduled_post_noti_done'), {info:"",poll_id:task.poll_id,poll_cmd:pollData.cmd,ts:localizeTS,note:`\n${cmdNote}`} );
            } else {
              //Dont spam user!
              //dmOwnerString = parameterizedString(stri18n(gAppLang,'task_scheduled_post_noti'), {poll_id:task.poll_id,poll_cmd:pollData.cmd,ts:localizeTS,note:`\n${cmdNote}`} )
            }

            await scheduleCol.updateOne(
                { _id: task._id },
                { $set: { next_error_disable_poll: false  } }
            );

          }



        } catch (e) {
          errMsg = `[Schedule] Executing task for poll_id: ${task.poll_id} to CH:${pollCh} FAILED!`;
          dmOwnerString = errMsg;
          logger.verbose(errMsg);
          logger.verbose(e);
          logger.error(e.toString()+"\n"+e.stack);
          console.log(e);
        }
      }
      //get user config
      let isUserAllowDM = isAppAllowDM;
      if(pollData?.team !== null && mTaskOwner !== null) {
        let uConfig = await getUserConfig(pollData?.team??null,mTaskOwner??null);
        if(uConfig?.config?.hasOwnProperty('user_allow_dm')) {
          isUserAllowDM = uConfig.config.user_allow_dm;
        }
      }


      try {
        if(dmOwnerString !== null && mTaskOwner!==null) {

          if (isUserAllowDM) {
            let mRequestBody = {
              token: mBotToken,
              channel: mTaskOwner,
              text: dmOwnerString,
            };
            await postChat("", 'post', mRequestBody);
          }
        }
      } catch (e) {
        logger.error("Can not send DM, you might not enable Bot Messages Tab in Slack App!");
      }
      dmOwnerString=null;




      let taskIsEnable = true;
      if(taskRunCounter>=taskRunMax) taskIsEnable = false;

      // Update is_done to true
      await scheduleCol.updateOne(
          { _id: task._id },
          { $set: { is_done: true, last_run_ts: new Date(), run_counter: taskRunCounter,run_max: taskRunMax, is_enable: taskIsEnable  } }
      );


      if (task.cron_string && taskIsEnable) {
        // Calculate the next schedule time
        const nextScheduleTime = calculateNextScheduleTime(task.cron_string,null);

        if (!nextScheduleTime) {
          dmOwnerString = `[Schedule] Error parsing cron_string for poll_id ${task.poll_id} and cron_string ${task.cron_string}`;

          console.error(dmOwnerString);
          // Set cron_string to null when it's invalid
          await scheduleCol.updateOne(
              { _id: task._id },
              { $set: { is_enable: false, last_error_ts: new Date(), last_error_text: `cron_string '${task.cron_string}' is invalid` } }
          );
          continue; // Skip this task and move to the next one
        }

        // Check if the task is scheduled within the gScheduleLimitHr
        const timeDifferenceHr = (nextScheduleTime - currentDateTime) / (1000 * 60 * 60);
        let nextScheduleValid = false;
        let nextWarn = false;
        if (timeDifferenceHr < gScheduleLimitHr) {
          // Check if next_ts_warn is false or null or not set (only allow once)
          if (!task.next_ts_warn) {
            dmOwnerString = `[Schedule] ${task.poll_id} First scheduled job and next one is less than ${gScheduleLimitHr} hours (current `+convertHoursToString(timeDifferenceHr)+` hours).`;
            logger.verbose(dmOwnerString);
            dmOwnerString = parameterizedString(stri18n(appLang,'task_scheduled_warn_too_fast'),
                {
                  poll_id:task.poll_id,
                  run_max_hrs: gScheduleLimitHr,
                  run_current_hrs: convertHoursToString(timeDifferenceHr),
                }
            );
            // Set next_ts_warn to true
            await scheduleCol.updateOne(
                { _id: task._id },
                { $set: { is_enable: true, next_ts_warn: true } }
            );
            nextScheduleValid = true;
            nextWarn= true;
          } else {
            dmOwnerString = `[Schedule] ${task.poll_id} Scheduled job is less than ${gScheduleLimitHr} hours (current `+convertHoursToString(timeDifferenceHr)+` hours). Job is now disabled.`;
            logger.verbose(dmOwnerString);
            // Set next_ts_warn to false and cron_string to null
            await scheduleCol.updateOne(
                { _id: task._id },
                { $set: { next_ts_warn: false, is_enable: false , last_error_ts: new Date(), last_error_text: `Scheduled job is less than ${gScheduleLimitHr} hours (current `+convertHoursToString(timeDifferenceHr)+` hours). Job is now disabled.`} }
            );

            dmOwnerString = parameterizedString(stri18n(appLang,'task_scheduled_error_too_fast'),
                {
                  poll_id:task.poll_id,
                  run_max_hrs: gScheduleLimitHr,
                  run_current_hrs: convertHoursToString(timeDifferenceHr),
                }
            );

          }
        }
        else {
          nextScheduleValid = true;
        }

        if(nextScheduleValid) {
          // Set the next_ts to the next schedule time and reset is_done to false
          await scheduleCol.updateOne(
              { _id: task._id },
              { $set: { next_ts: nextScheduleTime, is_done: false, is_enable: true,next_ts_warn:nextWarn } }
          );
        }

      }//end cron_string

      try {
        if(dmOwnerString !== null && mTaskOwner!==null) {
          if (isUserAllowDM) {
            let mRequestBody = {
              token: mBotToken,
              channel: mTaskOwner,
              text: dmOwnerString,
            };
            await postChat("", 'post', mRequestBody);
          }
        }
      } catch (e) {
        logger.error("Can not send DM, you might not enable Bot Messages Tab in Slack App!");
      }
      dmOwnerString=null;

    }
  } catch (e) {
    logger.error(e);
  }

  try {
    const closingTasks = await pollCol.find({
      schedule_end_active: true,
      schedule_end_ts: { $lte: currentDateTime },

    }).toArray();

    for (const poll of closingTasks) {
      logger.debug(`[closingTasks] closing poll_id: ${poll._id}.`);
      closePollById(poll._id);
    }

  } catch (e) {
    logger.error(e);
    console.log(e);
  }

};

const autoCleanupTask = async () => {
  try {
    const dateToCleanup = new Date();
    dateToCleanup.setDate(dateToCleanup.getDate() - gScheduleAutoDeleteDay);

    const deleteRes = await scheduleCol.deleteMany({
      is_enable: false,
      next_ts: { $lt: dateToCleanup }
    });

    logger.verbose(`[Cleanup] Total documents deleted: ${deleteRes.deletedCount}`);

  } catch (e) {
    logger.error("[Cleanup] Task failed!");
    logger.error(e);
  }
};

const parameterizedString = (str,varArray) => {
  if(str===undefined) str = `MissingStr ${str}`;
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
    return `MissingStr ${key}`;
  }
}

function getTeamOrEnterpriseId (body) {
  body = JSON.parse(JSON.stringify(body));
  //logger.debug(body);
  if(body.hasOwnProperty('isEnterpriseInstall')) {
    if(body.isEnterpriseInstall==='true' || body.isEnterpriseInstall === true) {
      if(body.hasOwnProperty('enterprise_id')) return body.enterprise_id;
      else if(body.hasOwnProperty('enterpriseId')) return body.enterpriseId;
      else if(body?.enterprise?.id !== undefined) return body.enterprise.id;
    }
    else {
      if(body.hasOwnProperty('team_id')) return body.team_id;
      else if(body.hasOwnProperty('teamId')) return body.teamId;
      else if(body?.team?.id !== undefined) return body.team.id;
    }
  }
  else if(body.hasOwnProperty('is_enterprise_install')) {
    if(body.is_enterprise_install==='true' || body.is_enterprise_install === true ) {
      if(body.hasOwnProperty('enterprise_id')) return body.enterprise_id;
      else if(body.hasOwnProperty('enterpriseId')) return body.enterpriseId;
      else if(body?.enterprise?.id !== undefined) return body.enterprise.id;
    }
    else {
      if(body.hasOwnProperty('team_id')) return body.team_id;
      else if(body.hasOwnProperty('teamId')) return body.teamId;
      else if(body?.team?.id !== undefined) return body.team.id;
    }
  }
  else
  {
    if(body.hasOwnProperty('enterprise_id')) return body.enterprise_id;
    else if(body.hasOwnProperty('enterpriseId')) return body.enterpriseId;
    else if(body?.enterprise?.id !== undefined) return body.enterprise.id;
    else if(body.hasOwnProperty('team_id')) return body.team_id;
    else if(body.hasOwnProperty('teamId')) return body.teamId;
    else if(body?.team?.id !== undefined) return body.team.id;
  }
  return null;
}

const getTeamInfo = async (mTeamId) => {
  let ret = {};
  try {
    ret = await orgCol.findOne(
        {
          $or: [
            {'team.id': mTeamId},
            {'enterprise.id': mTeamId},
          ]
        }
    );
  }
  catch (e) {

  }
  return ret;
}

const getUserConfig = async (mTeamId,mUserId) => {
  let ret = {};
  try {
    ret = await userCol.findOne(
        {
          $and: [
            {'team_id': mTeamId},
            {'user_id': mUserId},
          ]
        }
    );
  }
  catch (e) {

  }
  return ret;
}
const getTeamOverride  = async (mTeamId) => {
    let ret = {};
    try {
        //const team = await orgCol.findOne({ 'team.id': mTeamId });
        const team = await getTeamInfo(mTeamId);
        if (team) {
            if(team.hasOwnProperty("openPollConfig")) ret = team.openPollConfig;
        }
    }
    catch (e) {

    }
    return ret;
}

const boltLoggerAdapter = {
  debug: (msg) => loggerBolt.debug(msg),
  info: (msg) => loggerBolt.info(msg),
  warn: (msg) => loggerBolt.warn(msg),
  error: (msg) => loggerBolt.error(msg),
  setLevel: (level) => loggerBolt.level = level,
  getLevel: () => loggerBolt.level,
  setName: () => {} // This can be a no-op if you don't need to implement it
};

const receiver = new ExpressReceiver({
  signingSecret: signing_secret,
  logger: boltLoggerAdapter,
  //logLevel: gLogLevelBolt,
  clientId: config.get('client_id'),
  clientSecret: config.get('client_secret'),
  scopes: ['commands', 'chat:write.public', 'chat:write', 'groups:write','channels:read','groups:read','mpim:read','users:read'],
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
        logger.debug(res);
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

      const team = await orgCol.findOne({
        $or: [
          {'team.id': mTeamId},
          {'enterprise.id': mTeamId},
        ]
      });
      if (team) {
        logger.info(`Team ${mTeamId} is reinstall app.`)
        if(team.hasOwnProperty('openPollConfig')) {
          logger.info(`Team ${mTeamId} is reinstall app with previous config, config will carry over.`)
          installation.openPollConfig = team.openPollConfig;
        }
        if(team.hasOwnProperty('created_ts')) {
          installation.created_ts = team.created_ts;
        } else {
          installation.created_ts = new Date();
        }
        installation.update_ts = new Date();
        await orgCol.replaceOne(
            {
              $or: [
                {'team.id': mTeamId},
                {'enterprise.id': mTeamId},
              ]
            }, installation);
      } else {
        installation.created_ts = new Date();
        await orgCol.insertOne(installation);
      }

      return mTeamId;
    },
    fetchInstallation: async (installQuery) => {
      let mTeamId = "";
      //logger.debug(installQuery);
      if (installQuery.isEnterpriseInstall && installQuery.enterpriseId !== undefined) {
        // org wide app installation lookup
        mTeamId = installQuery.enterpriseId;

        try {
          return await orgCol.findOne({ 'enterprise.id': mTeamId });
        } catch (e) {
          logger.error(e);
          throw new Error('No matching authorizations');
        }

      }
      if (installQuery.teamId !== undefined) {
        // single team app installation lookup
        mTeamId = installQuery.teamId;

        try {
          return await orgCol.findOne({ 'team.id': mTeamId });
        } catch (e) {
          logger.error(e);
          throw new Error('No matching authorizations');
        }
      }


    },
  },
});

receiver.router.get('/ping', (req, res) => {
  res.status(200).send('pong');
})

const app = new App({
  receiver: receiver
});

const sendMessageUsingUrl = async (url,newMessage) => {
  return await fetch(url, {
    method: 'POST',
    body: JSON.stringify(newMessage),
    headers: {'Content-Type': 'application/json'}
  });
}

const postChat = async (url,type,requestBody) => {
  let ret = {status:false,message : "N/A",slack_response:null, slack_ts:null };
  const addChNotFoundErr = "(Bot might not in this channel)";
  try {
    if(isUseResponseUrl && url!==undefined && url!=="")
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
          logger.error("Invalid post type:"+type);
          ret.status = false;
          ret.message = "Invalid post type:"+type;
          return ret;
      }
      ret.slack_response = await sendMessageUsingUrl(url,requestBody);
      if(ret.slack_response?.status!==200) {
        ret.status = false;
        ret.message = ret.slack_response?.statusText+` ${addChNotFoundErr}`;
        return ret;
      }
    }
    else
    {

        switch (type) {
          case "post":
            ret.slack_response = await app.client.chat.postMessage(requestBody);
            break;
          case "update":
            ret.slack_response = await app.client.chat.update(requestBody);
            break;
          case "ephemeral":
            ret.slack_response = await app.client.chat.postEphemeral(requestBody);
            break;
          case "delete":
            ret.slack_response = await app.client.chat.delete(requestBody);
            break;
          default:
            logger.error("Invalid post type:"+type)
            ret.status = false;
            ret.message = "Invalid post type:"+type;
            return ret;
        }
        if(ret.slack_response) ret.slack_ts = ret.slack_response?.ts;

    }
  } catch (e) {
    if (
        e && e.data && e.data && e.data.error
        && 'channel_not_found' === e.data.error
    ) {
      logger.error('Channel not found error : ignored');
      ret.message = "Channel not found error : ignored"+` ${addChNotFoundErr}`;
    }
    else if (
        e && e.data && e.data && e.data.error
        && 'team_not_found' === e.data.error
    ) {
      logger.error('Team not found error : ignored');
      ret.message = "Team not found error : ignored"+` ${addChNotFoundErr}`;
    }
    else if (
        e && e.data && e.data && e.data.error
        && 'team_access_not_granted' === e.data.error
    ) {
      logger.error('Team not found/not granted error : ignored');
      ret.message = "Team not found/not grante error : ignored"+` ${addChNotFoundErr}`;
    }
    else if (
        e && e.data && e.data && e.data.error
        && 'message_not_found' === e.data.error
    ) {
      logger.error('message_not_found error : ignored');
      ret.message = "message_not_found error : ignored"+` ${addChNotFoundErr}`;
    } else {
      logger.error(e);
      console.log(e);
      console.log(requestBody);
      logger.error(e.toString()+"\n"+e.stack);
      console.trace();
      ret.message = "Unknown error: "+e?.data?.error;
    }
    ret.status = false;
    return ret;
  }
  ret.status = true;
  return ret;
}

const slackNumToEmoji = (seq,userLang) => {
  let outText = "["+seq+"]";
  if(langDict.hasOwnProperty(userLang))
    if(langDict[userLang].hasOwnProperty('emoji_'+seq))
      outText = langDict[userLang]['emoji_'+seq];

  return outText;
}

function createHelpBlock(appLang) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Hello*, here is how to create a poll with OpenPoll+.",
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
        text: "*From command*\nJust type `/"+slackCommand+"` where you type the message and press Enter without any options. A modal dialog will pop up and guide you to create one.\n\nIf you want to create one with single line of command, please add options, question and your choices.\n" +
            "   - For both the question and your choices, please surround them with  \"quotes\"\n" +
            "   - For options, DO NOT surround them with quotes unless specified.",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*From shortcuts*\nOpen shortcuts and select \"Create Poll\"",
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
        text: "Click Menu and select Delete at your poll.\nOnly the creator can delete a poll.",
      },
    },
    {
      type: "divider",
    },
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Command Options",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "The options are optional settings to apply to the poll. Do not surround options with quotes.",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "`anonymous` - Make vote anonymous.\n" +
            "`limit x` - Limit the maximum number of choices each user can vote for to `x` choices.\n" +
            "`hidden` - Vote results will be hidden until revealed.\n" +
            "`add-choice` - Allow other members to add more choices to this poll.\n" +
            "`on TIME_STAMP` - Schedule a poll to be posted on TIME_STAMP.\n" +
            "`end TIME_STAMP` - Schedule a poll to be closed on TIME_STAMP.\n" +
            "   - TIME_STAMP in ISO8601 format eg. `YYYY-MM-DDTHH:mm:ss.sssZ`",
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
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '"Question" and "Options" should enclosed in double quotation marks, no double quotation marks for poll options. If you have "Double Quotation" in your question or choices escaped quotes it with `\\"` and escaped `\\ ` with `\\\\` ',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '(Supported double quote: '+getSupportDoubleQuoteToStr()+')',
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "```"+"/"+slackCommand+" \"What's you favourite color ?\" \"Red\" \"Green\" \"Blue\" \"Yellow\""+"```",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "```"+"/"+slackCommand+" \"Please select \\\"HELLO\\\" ?\" \"HELLO\" \"HELlo\" \"helLo\" \"HE\\\"LL\\\"O\""+"```",
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
      type: "section",
      text: {
        type: "mrkdwn",
        text: "```"+"/"+slackCommand+" anonymous \"What's you favourite color ?\" \"Red\" \"Green\" \"Blue\" \"Yellow\""+"```",
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
      type: "section",
      text: {
        type: "mrkdwn",
        text: "```"+"/"+slackCommand+" limit 2 \"What's you favourite color ?\" \"Red\" \"Green\" \"Blue\" \"Yellow\""+"```",
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
      type: "section",
      text: {
        type: "mrkdwn",
        text: "```"+"/"+slackCommand+" hidden \"What's you favourite color ?\" \"Red\" \"Green\" \"Blue\" \"Yellow\""+"```",
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
      type: "section",
      text: {
        type: "mrkdwn",
        text: "```"+"/"+slackCommand+" anonymous limit 2 \"What's you favourite color ?\" \"Red\" \"Green\" \"Blue\" \"Yellow\""+"```",
      },
    },
    // {
    //   type: "section",
    //   text: {
    //     type: "mrkdwn",
    //     text: "*Private messages*\nTo create poll in private messages, you need to invite the bot inside with `/invite` command.",
    //   },
    // },
    {
      type: "divider",
    },
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Schedule and Recurring polling",
        emoji: true,
      },
    },

    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Create Simple Schedule poll*",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Schedule poll\n" +
            "```/"+slackCommand+" on 2023-11-15T10:30:00+07:00 \"What's your favourite color ?\" \"Red\" \"Green\" \"Blue\" \"Yellow\"```\n" +
            "Schedule poll with schedule close poll\n" +
            "```/"+slackCommand+" on 2023-11-15T10:30:00+07:00 end 2023-11-30T00:00:00+07:00 \"What's your favourite color ?\" \"Red\" \"Green\" \"Blue\" \"Yellow\"```",
      },
    },

    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Create Advanced Schedule and Recurring poll*",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "```/"+slackCommand+" schedule create [POLL_ID] [TS] [CH_ID] \"[CRON_EXP]\" [MAX_RUN]```",
      },
    },

    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "- Bot MUST in the channel.\n" +
            "- Only one schedule for each poll, reschedule will replace previous one.\n" +
            "- `POLL_ID` = ID of poll to schedule (eg. `0123456789abcdef01234567`).\n" +
            "  - To get Poll ID: go to exist poll > `Menu` > `Command Info.`.\n" +
            "- `TS` = Time stamp of first run (ISO8601 format `YYYY-MM-DDTHH:mm:ss.sssZ`, eg. `2023-11-17T21:54:00+07:00`).\n" +
            "- `CH_ID` = (Optional) Channel ID to post the poll, set to `-` to post to orginal channel that poll was created (eg. `A0123456`).\n" +
            "  - To get channel ID: go to your channel, Click down arrow next to channel name, channel ID will be at the very bottom.\n" +
            "- `CRON_EXP` = (Optional) Do not set to run once, or put [cron expression] in UTC Timezone (with \"Double Quote\") here (eg. `\"30 12 15 * *\"` , Post poll 12:30 PM on the 15th day of every month in UTC).\n" +
            "- `MAX_RUN` = (Optional) Do not set to run maximum time that server allows (`"+gScheduleMaxRun+"` times), After Run Counter greater than this number; schedule will disable itself.\n" +
            "\n" +
            "NOTE: If a cron expression results in having more than 1 job within `"+gScheduleLimitHr+"` hours, the Poll will post once, and then the job will get disabled.\n" +
            "For more information please visit <"+helpLink+"|full document here>.",
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "Example:\n"+
            "```/"+slackCommand+" schedule create 0123456789abcdef01234567 2023-11-18T08:00:00+07:00```\n" +
            "```/"+slackCommand+" schedule create 0123456789abcdef01234567 2023-11-15T10:30:00+07:00 - \"30 12 15 * *\" 12```\n" +
            "```/"+slackCommand+" schedule create 0123456789abcdef01234567 2023-11-15T10:30:00+07:00 C0000000000 \"30 12 15 * *\" 12```"
      },
    },

    {
      type: "divider",
    },
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Config Open Poll for this Workspace",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "```\n/" + slackCommand + " config```",
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
        text: "*Private channel & schedule poll*\nTo create poll in private channels, please use `/"+slackCommand+"` command. If you using Shortcut or Schedule you need to invite the bot inside with `/invite` command.",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Limitations*\nSlack have limitations and that include \"message length\". So you can't have more than 15 options per poll. You can create multiple polls if you want more options",
      },
    },
    {
        type: 'divider',
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: parameterizedString(stri18n(appLang, 'info_need_help'), {email: helpEmail, link: helpLink}),
        //text: stri18n(appLang,'info_need_help')
      },
    },
  ];
}
app.event('app_home_opened', async ({ event, client, context }) => {
  try {
    const teamOrEntId = getTeamOrEnterpriseId(context);
    const teamConfig = await getTeamOverride(teamOrEntId);
    let appLang = gAppLang;
    if (teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;

    //if (event.tab === 'messages') {

      let uConfig = await getUserConfig(teamOrEntId,event.user);
      if(uConfig!==null && uConfig.flag?.hasOwnProperty("welcome_send") && uConfig.flag?.welcome_send === true) {

      } else {
        // Post a welcome message to the user
        await client.chat.postMessage({
          channel: event.channel,
          text: parameterizedString(stri18n(appLang, 'info_welcome_message'), {slack_command: slackCommand, link: helpLink}),
        });
      if(uConfig===null) {
        uConfig = {
          team_id: teamOrEntId,
          user_id: event.user,
        }
      }
      if(!uConfig.hasOwnProperty('flag')) uConfig.flag = { }
      uConfig.flag.welcome_send = true;
      uConfig.flag.welcome_send_ts = new Date();
        await userCol.replaceOne({
          team_id: teamOrEntId,
          user_id: event.user,
          },
          uConfig
          , {
            upsert: true,
          }
        );

      }

    //}

    const result = await client.views.publish({
      user_id: event.user,
      view: {
        type: "home",
        blocks: createHelpBlock(appLang),
      },
    });
  } catch (e) {
    logger.error(`UNEXPECTED ERROR in app_home_opened :` + e.message);
    logger.error(e.toString() + "\n" + e.stack);
    console.log(e);
    console.trace();
  }
});

app.command(`/${slackCommand}`, async ({ ack, body, client, command, context, say, respond }) => {
  await processCommand(ack, body, client, command, context, say, respond);
});

app.command(`/${slackCommand2}`, async ({ ack, body, client, command, context, say, respond }) => {
  await processCommand(ack, body, client, command, context, say, respond);
});


async function processCommand(ack, body, client, command, context, say, respond) {
  try {
    const receivedTime = new Date().getTime();
    //if response_url with simple poll, no schedule bot is not required in ch
    let reqBotInCh = false;
    let forceNotUsingResponseURL = false;
    await ack();
    let cmdBody = (command && command.text) ? command.text.trim() : null;

    if (cmdBody?.startsWith('ping')) {
      const ackedTime = new Date().getTime();
      const timeDiff = ackedTime - receivedTime;
      // Respond with the time difference
      await respond(`Time from receiving to acknowledging: ${timeDiff} ms`);
      return;
    }
    // Create a pattern for matching escaped quotes
    const escapedQuotesPattern = acceptedQuotes.map(q => `\\\\${q}`).join('|');

    // Replace non-standard quotes with the standard quote, but ignore already escaped quotes
    const acceptedQuotesPattern = acceptedQuotes.filter(q => q !== standardQuote).map(q => `\\${q}`).join('');
    if (!cmdBody) {

    } else {
      cmdBody = cmdBody.replace(new RegExp(`(^|[^\\\\])([${acceptedQuotesPattern}])`, 'g'), `$1${standardQuote}`);
    }
    const fullCmd = `/${slackCommand} ${cmdBody}`

    const isHelp = cmdBody ? 'help' === cmdBody : false;
    const channel = (command && command.channel_id) ? command.channel_id : null;
    const userId = (command && command.user_id) ? command.user_id : null;

    const teamOrEntId = getTeamOrEnterpriseId(context);
    const teamConfig = await getTeamOverride(teamOrEntId);
    let appLang = gAppLang;
    if (teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;

    let isMenuAtTheEnd = gIsMenuAtTheEnd;
    let isCompactUI = gIsCompactUI;
    let isShowDivider = gIsShowDivider;
    let isShowHelpLink = gIsShowHelpLink;
    let isShowCommandInfo = gIsShowCommandInfo;
    let isTrueAnonymous = gTrueAnonymous;
    let isShowNumberInChoice = gIsShowNumberInChoice;
    let isShowNumberInChoiceBtn = gIsShowNumberInChoiceBtn;

    if (teamConfig.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = teamConfig.menu_at_the_end;
    if (teamConfig.hasOwnProperty("compact_ui")) isCompactUI = teamConfig.compact_ui;
    if (teamConfig.hasOwnProperty("show_divider")) isShowDivider = teamConfig.show_divider;
    if (teamConfig.hasOwnProperty("show_help_link")) isShowHelpLink = teamConfig.show_help_link;
    if (teamConfig.hasOwnProperty("show_command_info")) isShowCommandInfo = teamConfig.show_command_info;
    if (teamConfig.hasOwnProperty("true_anonymous")) isTrueAnonymous = teamConfig.true_anonymous;
    if (teamConfig.hasOwnProperty("add_number_emoji_to_choice")) isShowNumberInChoice = teamConfig.add_number_emoji_to_choice;
    if (teamConfig.hasOwnProperty("add_number_emoji_to_choice_btn")) isShowNumberInChoiceBtn = teamConfig.add_number_emoji_to_choice_btn;

    let myTz = null;
    try {
      const userInfo = await app.client.users.info({
        token: context.botToken,
        user: userId
      });
      myTz = userInfo?.user?.tz;
    } catch (e) {
    }

    if (isHelp) {
      const blocks = createHelpBlock(appLang);
      let mRequestBody = {
        token: context.botToken,
        channel: channel,
        user: userId,
        blocks: blocks,
      };
      await postChat(body.response_url, 'ephemeral', mRequestBody);
      return;
    } else if (!cmdBody) {
      createModal(context, client, body.trigger_id, body.response_url, channel);
    } else {
      //const cmd = `/${slackCommand} ${cmdBody}`;
      let question = null;
      const options = [];

      let userLang = appLang;
      let isAnonymous = false;
      let isLimited = false;
      let limit = null;
      let isHidden = false;
      let isAllowUserAddChoice = false;
      let fetchArgs = true;
      let postDateTime = null;
      let endDateTime = null;


      while (fetchArgs) {
        fetchArgs = false;
        if (cmdBody.startsWith('anonymous')) {
          fetchArgs = true;
          isAnonymous = true;
          cmdBody = cmdBody.substring(9).trim();
        } else if (cmdBody.startsWith('schedule')) {
          cmdBody = cmdBody.substring(8).trim();

          let isEndOfCmd = false;
          let schTsText = '';//'2023-11-17T21:54:00+07:00';
          let schPollID = null;
          let schCH = null;
          let schMAXRUN = gScheduleMaxRun;
          let schCron = null;
          let schTs = new Date(schTsText);
          let cmdMode = "";
          let ignoreOwnerCheck = false;
          let validConfigUser = "";
          //get mode
          let inputPara = (cmdBody.substring(0, cmdBody.indexOf(' ')));
          if (inputPara === "") {
            inputPara = cmdBody;
            isEndOfCmd = true;
          }
          cmdMode = inputPara;
          //console.log(cmdMode);
          cmdBody = cmdBody.substring(inputPara.length).trim();
          let isParaValid = false;

          if (cmdMode === "create_force") {
            cmdMode = "create";
            ignoreOwnerCheck = true;
          } else if (cmdMode === "delete_force") {
            cmdMode = "delete";
            ignoreOwnerCheck = true;
          } else if (cmdMode === "") {
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              //blocks: blocks,
              text: parameterizedString(stri18n(userLang, 'task_usage_help'), {
                slack_command: slackCommand,
                help_link: helpLink
              })
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }

          const team = await getTeamInfo(teamOrEntId);
          if (team) {
            if (team.hasOwnProperty("user"))
              if (team.user.hasOwnProperty("id")) {
                validConfigUser = team.user.id;
              }
          }

          if (ignoreOwnerCheck) {
            if (userId !== validConfigUser) {
              let mRequestBody = {
                token: context.botToken,
                channel: channel,
                user: userId,
                //blocks: blocks,
                text: stri18n(userLang, 'err_only_installer'),
              };
              await postChat(body.response_url, 'ephemeral', mRequestBody);
              return;
            }
          }


          //phase POLL_ID
          inputPara = (cmdBody.substring(0, cmdBody.indexOf(' ')));
          if (inputPara === "") {
            inputPara = cmdBody;
            isEndOfCmd = true;
          }
          //console.log(inputPara);
          cmdBody = cmdBody.substring(inputPara.length).trim();
          isParaValid = false;
          let chkPollData;
          if (cmdMode === 'create' || cmdMode === 'delete') {
            let idError = "";
            if (inputPara.trim().length > 0) {
              schPollID = inputPara.trim();
              try {
                const calObjId = new ObjectId(schPollID);
                chkPollData = await pollCol.findOne({_id: calObjId});
                if (!chkPollData) {
                  isParaValid = false;
                  idError = "Not found";
                } else {
                  if (chkPollData.hasOwnProperty('team') && chkPollData.hasOwnProperty('channel')) {
                    if (chkPollData.team !== "" && chkPollData.team != null &&
                        chkPollData.channel !== "" && chkPollData.channel != null
                    ) {
                      isParaValid = true;
                    } else {
                      isParaValid = false;
                      idError = "Not Support EMPTY";
                    }
                  } else {
                    isParaValid = false;
                    idError = "Not Support NO_KEY";
                  }
                }
              } catch (e) {
                idError = "INVALID";
              }
            }
            if (!isParaValid) {
              let mRequestBody = {
                token: context.botToken,
                channel: channel,
                user: userId,
                //blocks: blocks,
                text: "```" + fullCmd + "```\n" + stri18n(userLang, 'task_error_poll_id_invalid') + `(${idError})` + "\n" + parameterizedString(stri18n(userLang, 'task_usage_help'), {
                  slack_command: slackCommand,
                  help_link: helpLink
                })
              };
              await postChat(body.response_url, 'ephemeral', mRequestBody);
              return;
            } else {
              //check owner
              if (!ignoreOwnerCheck) {
                if (body.user_id !== chkPollData?.user_id) {
                  //logger.debug('reject request because not owner');
                  let mRequestBody = {
                    token: context.botToken,
                    channel: channel,
                    user: userId,
                    text: "```" + fullCmd + "```\n" + stri18n(appLang, 'err_action_other') + " (MISMATCH_USER)",
                  };
                  await postChat(body.response_url, 'ephemeral', mRequestBody);
                  return;
                }
              } else {
                //check team
                if (teamOrEntId !== chkPollData?.team) {
                  //logger.debug('reject request because not valid team');
                  let mRequestBody = {
                    token: context.botToken,
                    channel: channel,
                    user: userId,
                    text: "```" + fullCmd + "```\n" + stri18n(appLang, 'err_action_other') + " (MISMATCH_TEAM)",
                  };
                  await postChat(body.response_url, 'ephemeral', mRequestBody);
                  return;
                }
              }
            }

            if (cmdMode === 'create') {

              if (isEndOfCmd) {
                let mRequestBody = {
                  token: context.botToken,
                  channel: channel,
                  user: userId,
                  //blocks: blocks,
                  text: "```" + fullCmd + "```\n" + parameterizedString(stri18n(userLang, 'err_para_missing'), {parameter: "[TS]"}) + "\n" + parameterizedString(stri18n(userLang, 'task_usage_help'), {
                    slack_command: slackCommand,
                    help_link: helpLink
                  })
                };
                await postChat(body.response_url, 'ephemeral', mRequestBody);
                return;
              }
              //phase TS
              inputPara = (cmdBody.substring(0, cmdBody.indexOf(' ')));
              if (inputPara === "") {
                inputPara = cmdBody;
                isEndOfCmd = true;
              }
              cmdBody = cmdBody.substring(inputPara.length).trim();
              isParaValid = false;
              schTsText = inputPara.trim();

              if (!isValidISO8601(schTsText)) {
                let mRequestBody = {
                  token: context.botToken,
                  channel: channel,
                  user: userId,
                  //blocks: blocks,
                  text: "```" + fullCmd + "```\n" + stri18n(userLang, 'task_error_date_invalid') + "\n" + parameterizedString(stri18n(userLang, 'task_usage_help'), {
                    slack_command: slackCommand,
                    help_link: helpLink
                  })
                };
                await postChat(body.response_url, 'ephemeral', mRequestBody);
                return;
              }

              //phase CH_ID
              schCH = null;
              let chToCheck = channel;
              if (!isEndOfCmd) {
                inputPara = (cmdBody.substring(0, cmdBody.indexOf(' ')));
                if (inputPara === "") {
                  inputPara = cmdBody;
                  isEndOfCmd = true;
                }
                cmdBody = cmdBody.substring(inputPara.length).trim();

                if (inputPara !== '-') {
                  schCH = inputPara.trim();
                  chToCheck = schCH
                }
              }

              try {
                const result = await client.conversations.info({
                  token: context.botToken,
                  channel: chToCheck
                });
              } catch (e) {
                if (e.message.includes('channel_not_found') || e.message.includes('team_not_found') || e.message.includes('team_access_not_granted')) {
                  let mRequestBody = {
                    token: context.botToken,
                    channel: channel,
                    user: userId,
                    text: "```" + fullCmd + "```\n" + parameterizedString(stri18n(userLang, 'err_para_invalid'), {
                      parameter: "[CH_ID]",
                      value: inputPara,
                      error_msg: "(Bot not in Channel or not found)"
                    })
                  };
                  await postChat(body.response_url, 'ephemeral', mRequestBody);
                  return;
                } else {
                  //ignore it!
                  logger.debug(`Error on client.conversations.info (CH:${chToCheck}) :` + e.message);
                  console.log(e);
                  console.trace();
                }
              }

              //phase CRON_EXP
              //schCron = "0 */5 * * * *";
              if (!isEndOfCmd) {
                let firstQt = cmdBody.indexOf('"');
                let lastQt = cmdBody.lastIndexOf('"');
                if (firstQt !== 0 || lastQt === -1 || firstQt === lastQt) {
                  let mRequestBody = {
                    token: context.botToken,
                    channel: channel,
                    user: userId,
                    text: fullCmd + "\n" + parameterizedString(stri18n(userLang, 'err_para_invalid'), {
                      parameter: "[CRON_EXP]",
                      value: cmdBody,
                      error_msg: "Cron Expression should enclosed in Double Quote marks \"* * * * *\""
                    })
                  };
                  await postChat(body.response_url, 'ephemeral', mRequestBody);
                  return;
                }


                inputPara = (cmdBody.substring(1, lastQt));
                cmdBody = cmdBody.substring(inputPara.length + 2).trim();
                if (cmdBody === "") isEndOfCmd = true;

                //test cron
                const nextScheduleTime = calculateNextScheduleTime(inputPara, null);

                if (!nextScheduleTime) {
                  logger.debug(`Command reject: Cron Expression is invalid [${inputPara}] `)
                  let mRequestBody = {
                    token: context.botToken,
                    channel: channel,
                    user: userId,
                    text: "```" + fullCmd + "```\n" + parameterizedString(stri18n(userLang, 'err_para_invalid'), {
                      parameter: "[CRON_EXP]",
                      value: inputPara,
                      error_msg: "Cron Expression is invalid"
                    })
                  };
                  await postChat(body.response_url, 'ephemeral', mRequestBody);
                  return;
                } else {
                  schCron = inputPara;
                }
              }

              //phase MAX_RUN
              if (!isEndOfCmd) {
                inputPara = (cmdBody.substring(0, cmdBody.indexOf(' ')));
                if (inputPara === "") {
                  inputPara = cmdBody;
                  isEndOfCmd = true;
                }
                cmdBody = cmdBody.substring(inputPara.length).trim();

                if (!isNaN(parseInt(inputPara)) && parseInt(inputPara) >= 1) {
                  schMAXRUN = Math.min(parseInt(inputPara), gScheduleMaxRun);
                } else {
                  let mRequestBody = {
                    token: context.botToken,
                    channel: channel,
                    user: userId,
                    text: "```" + fullCmd + "```\n" + parameterizedString(stri18n(userLang, 'err_para_invalid'), {
                      parameter: "[MAX_RUN]",
                      value: inputPara,
                      error_msg: ""
                    })
                  };
                  await postChat(body.response_url, 'ephemeral', mRequestBody);
                  return;
                }
              }

              schTs = new Date(schTsText);

              if(schCron===null) schMAXRUN = 1;

              const dataToInsert = {
                poll_id: new ObjectId(schPollID),
                next_ts: schTs,
                created_cmd: fullCmd,
                created_ts: new Date(),
                created_user_id: userId,
                run_max: schMAXRUN,
                is_done: false,
                is_enable: true,
                poll_ch: schCH,
                cron_string: schCron,
              };

              // Insert the data into scheduleCol
              //await scheduleCol.insertOne(dataToInsert);
              await scheduleCol.replaceOne(
                  {poll_id: new ObjectId(dataToInsert.poll_id)}, // Filter document with the same poll_id
                  dataToInsert, // New document to be inserted
                  {upsert: true} // Option to insert a new document if no matching document is found
              );
              let localizeTS = await getAndlocalizeTimeStamp(context.botToken,userId,schTs);
              let actString = "```" + fullCmd + "```\n" + parameterizedString(stri18n(userLang, 'task_scheduled'), {
                poll_id: schPollID,
                ts: localizeTS,
                poll_ch: schCH,
                run_max: schMAXRUN
              });

              if (schCron !== null) {
                actString += "\n" + parameterizedString(stri18n(userLang, 'task_scheduled_with_cron'), {
                  cron: schCron,
                  run_max_hrs: gScheduleLimitHr
                });
              }

              let mRequestBody = {
                token: context.botToken,
                channel: channel,
                user: userId,
                text: actString
                ,
              };
              await postChat(body.response_url, 'ephemeral', mRequestBody);

              logger.verbose(`[Schedule] New schedule, Poll ID: ${schPollID}`);
              logger.debug(`[Schedule] CMD: ${fullCmd}`);
              return;

            } else if (cmdMode === 'delete') {
              // const updateRes = await scheduleCol.updateMany(
              //     { poll_id: schPollID },
              //     { $set: { is_enable: false,is_done: true, last_error_ts: new Date(), last_error_text: "Disable by user request"} }
              // ); //updateRes.modifiedCount
              const deleteRes = await scheduleCol.deleteMany(
                  {poll_id: new ObjectId(schPollID)}
              );

              let mRequestBody = {
                token: context.botToken,
                channel: channel,
                user: userId,
                //blocks: blocks,
                text: parameterizedString(stri18n(userLang, 'task_delete'), {
                  poll_id: schPollID,
                  deleted_count: deleteRes.deletedCount
                })
              };
              await postChat(body.response_url, 'ephemeral', mRequestBody);
              return;
            }

          } else if (cmdMode === "delete_done") {

            let deletedCount = 0;
            if (userId !== validConfigUser) {
              // let mRequestBody = {
              //   token: context.botToken,
              //   channel: channel,
              //   //blocks: blocks,
              //   text: stri18n(userLang,'err_only_installer'),
              // };
              // await postChat(body.response_url,'ephemeral',mRequestBody);
              // return;
              const deleteRes = await scheduleCol.deleteMany(
                  {created_user_id: userId, is_enable: false}
              );
              deletedCount = deleteRes.deletedCount;
            } else {
              const queryRes = await scheduleCol.aggregate([
                {
                  $match: {is_enable: false} // Filter by is_enable before the lookup
                },
                {
                  $lookup: {
                    from: 'poll_data', // collection to join
                    localField: 'poll_id', // field from the input documents
                    foreignField: '_id', // field from the documents of the "from" collection
                    as: 'pollData' // output array field
                  }
                },
                {
                  $match: {'pollData.team': teamOrEntId} // match condition
                },
                {
                  $unwind: '$pollData' // deconstructs the 'pollData' array
                }
              ]).toArray();

              const idsToDelete = queryRes.map(doc => doc._id);

              const deleteRes = await scheduleCol.deleteMany(
                  {_id: {$in: idsToDelete}}
              );
              deletedCount = deleteRes.deletedCount;
            }


            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: parameterizedString(stri18n(userLang, 'task_delete_multiple'), {deleted_count: deletedCount}),
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;


          } else if (cmdMode === "list_self" || cmdMode === "list") {
            const queryRes = await scheduleCol.aggregate([
              {
                $match: {created_user_id: body.user_id} // Filter by is_enable before the lookup
              },
              {
                $lookup: {
                  from: 'poll_data', // collection to join
                  localField: 'poll_id', // field from the input documents
                  foreignField: '_id', // field from the documents of the "from" collection
                  as: 'pollData' // output array field
                }
              },
              // {
              //   $match: { 'pollData.user_id': body.user_id } // match condition
              // },
              {
                $unwind: '$pollData' // deconstructs the 'pollData' array
              }
            ]).toArray();

            //console.log(queryRes);
            let resString = "";
            let foundCount = 0;
            for (const item of queryRes) {
              let cronHumanText = "";
              if (item?.cron_string && item?.cron_string !== "") {
                try {
                  cronHumanText = cronstrue.toString(item?.cron_string, cronstrueOp) + ", ";
                } catch (e) {
                }
              }
              resString += "```";
              resString += `Poll ID: ${item.poll_id}\n`;
              resString += `Next Run: ` + localizeTimeStamp(myTz, item.next_ts) + `\n`;
              resString += `Cron Expression: ${item.cron_string} (${cronHumanText}UTC Time Zone)\n`;
              resString += `Enable: ${item.is_enable}\n`;
              resString += `Override CH: ${item.poll_ch}\n`;
              //resString+=`Question : ${item.pollData?.question}\n`;
              resString += `CMD : ${item.pollData?.cmd}\n`;
              resString += `Run Counter : ${item.run_counter}/${item.run_max ?? gScheduleMaxRun}\n`;
              resString += `Last Error : ${item.last_error_text}\n`;
              resString += `Last Error TS : ` + localizeTimeStamp(myTz, item.last_error_ts) + `\n`;
              resString += "```\n";
              foundCount++;
            }

            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: parameterizedString(stri18n(userLang, 'task_list'), {
                poll_count: foundCount,
                slack_command: slackCommand
              }) + "\n" + resString,
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;


          } else if (cmdMode === "list_all") {
            if (userId !== validConfigUser) {
              let mRequestBody = {
                token: context.botToken,
                channel: channel,
                user: userId,
                //blocks: blocks,
                text: stri18n(userLang, 'err_only_installer'),
              };
              await postChat(body.response_url, 'ephemeral', mRequestBody);
              return;
            }
            const queryRes = await scheduleCol.aggregate([
              // {
              //   $match: { created_user_id: body.user_id } // Filter by is_enable before the lookup
              // },
              {
                $lookup: {
                  from: 'poll_data', // collection to join
                  localField: 'poll_id', // field from the input documents
                  foreignField: '_id', // field from the documents of the "from" collection
                  as: 'pollData' // output array field
                }
              },
              {
                $match: {'pollData.team': teamOrEntId} // match condition
              },
              {
                $unwind: '$pollData' // deconstructs the 'pollData' array
              }
            ]).toArray();

            //console.log(queryRes);
            let resString = "";
            let foundCount = 0;
            for (const item of queryRes) {
              let cronHumanText = "";
              if (item?.cron_string && item?.cron_string !== "") {
                try {
                  cronHumanText = cronstrue.toString(item?.cron_string, cronstrueOp) + ", ";
                } catch (e) {
                }
              }
              resString += "```";
              resString += `Poll ID: ${item.poll_id}\n`;
              resString += `Owner: ${item.created_user_id}\n`;
              resString += `Next Run: ` + localizeTimeStamp(myTz, item.next_ts) + `\n`;
              resString += `Cron Expression: ${item.cron_string} (${cronHumanText}UTC Time Zone)\n`;
              resString += `Enable: ${item.is_enable}\n`;
              resString += `Override CH: ${item.poll_ch}\n`;
              //resString+=`Question : ${item.pollData?.question}\n`;
              resString += `CMD : ${item.pollData?.cmd}\n`;
              resString += `Run Counter : ${item.run_counter}/${item.run_max ?? gScheduleMaxRun}\n`;
              resString += `Last Error : ${item.last_error_text}\n`;
              resString += `Last Error TS : ` + localizeTimeStamp(myTz, item.last_error_ts) + `\n`;
              resString += "```\n";
              foundCount++;
            }

            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: parameterizedString(stri18n(userLang, 'task_list'), {
                poll_count: foundCount,
                slack_command: slackCommand
              }) + "\n" + resString,
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          } else {
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              //blocks: blocks,
              text: "```" + fullCmd + "```\n" + parameterizedString(stri18n(userLang, 'task_error_command_invalid'), {slack_command: slackCommand}) + "\n" + parameterizedString(stri18n(userLang, 'task_usage_help'), {
                slack_command: slackCommand,
                help_link: helpLink
              })
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }
          return;


        } else if (cmdBody.startsWith('test')) {
          //test functiom
          try {
            logger.debug(context);
            cmdBody = cmdBody.substring(4).trim();
            let teamId = getTeamOrEnterpriseId(context);
            logger.debug("TeamID:" + teamId);

            // const userInfo = await app.client.users.info({
            //   token: context.botToken,
            //   user: userId
            // });
            //
            const testDate = new Date();
            const testDateStr = testDate.toString();
            let mRequestBody = {
              token: context.botToken,
              channel: cmdBody,
              //blocks: blocks,
              text: `UserID ${userId} Date ${testDateStr}}\n` +
                  //`Your time zone is: ${userInfo?.user?.tz} (${userInfo?.user?.tz_label}, Offset: ${userInfo?.user?.tz_offset} seconds)\n`+
                  (await getAndlocalizeTimeStamp(context.botToken, userId, testDate))
              ,
            };
            //logger.debug(mRequestBody);
            await postChat(body.response_url, 'post', mRequestBody);
            return;
          } catch (e) {
            logger.debug("Error: Failed to get user timezone");
            logger.debug(e.toString() + "\n" + e.stack);
          }


        } else if (cmdBody.startsWith('limit')) {
          fetchArgs = true;
          cmdBody = cmdBody.substring(5).trim();
          isLimited = true;
          if (!isNaN(parseInt(cmdBody.charAt(0)))) {
            limit = parseInt(cmdBody.substring(0, cmdBody.indexOf(' ')));
            cmdBody = cmdBody.substring(cmdBody.indexOf(' ')).trim();
          }
        } else if (cmdBody.startsWith('on')) {
          fetchArgs = true;
          reqBotInCh = true;
          cmdBody = cmdBody.substring(2).trim();

          postDateTime = (cmdBody.substring(0, cmdBody.indexOf(' ')));

          if (!isValidISO8601(postDateTime)) {
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              //blocks: blocks,
              text: "```" + fullCmd + "```\n" + stri18n(userLang, 'task_error_date_invalid')
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }

          cmdBody = cmdBody.substring(cmdBody.indexOf(' ')).trim();
        } else if (cmdBody.startsWith('end')) {
          fetchArgs = true;
          reqBotInCh = true;
          forceNotUsingResponseURL = true;
          cmdBody = cmdBody.substring(3).trim();

          endDateTime = (cmdBody.substring(0, cmdBody.indexOf(' ')));

          if (!isValidISO8601(endDateTime)) {
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              //blocks: blocks,
              text: "```" + fullCmd + "```\n" + stri18n(userLang, 'task_error_date_invalid')
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }

          cmdBody = cmdBody.substring(cmdBody.indexOf(' ')).trim();
        }
        else if (cmdBody.startsWith('lang')) {
          fetchArgs = true;
          cmdBody = cmdBody.substring(4).trim();
          let inputLang = (cmdBody.substring(0, cmdBody.indexOf(' ')));
          if (langList.hasOwnProperty(inputLang)) {
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
            if (isFirstLang) isFirstLang = false;
            else validWritePara += "/";
            validWritePara += key;
          }
          validWritePara += "]";
          for (const eachOverrideable of validTeamOverrideConfigTF) {
            validWritePara += `\n/${slackCommand} config write ${eachOverrideable} [true/false]`;
          }

          validWritePara += '\n' + parameterizedString(stri18n(userLang, 'info_need_help'), {
            email: helpEmail,
            link: helpLink
          });
          //validWritePara += `\n${helpEmail}\n<${helpLink}|`+stri18n(userLang,'info_need_help')+`>`;
          //let teamOrEntId = getTeamOrEnterpriseId(context);
          let team = await orgCol.findOne(
              {
                $or: [
                  {'team.id': teamOrEntId},
                  {'enterprise.id': teamOrEntId},
                ]
              }
          );
          let validConfigUser = "";
          if (team) {
            if (team.hasOwnProperty("user"))
              if (team.user.hasOwnProperty("id")) {
                validConfigUser = team.user.id;
              }
          } else {
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              //blocks: blocks,
              text: `Error while reading config`,
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }

          if (body.user_id !== validConfigUser) {
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              //blocks: blocks,
              text: stri18n(userLang, 'err_only_installer'),
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }

          if (cmdBody.startsWith("read")) {


            let configTxt = "Config: not found";
            if (team) {
              if (team.hasOwnProperty("openPollConfig")) {
                configTxt = "Override found:\n```" + JSON.stringify(team.openPollConfig) + "```";

              } else {
                configTxt = "No override: using server setting";
              }
            }


            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              //blocks: blocks,
              text: `${configTxt}`,
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          } else if (cmdBody.startsWith("write")) {
            cmdBody = cmdBody.substring(5).trim();

            let inputPara = (cmdBody.substring(0, cmdBody.indexOf(' ')));
            let isWriteValid = false;

            if (validTeamOverrideConfigTF.includes(inputPara)) {
              cmdBody = cmdBody.substring(inputPara.length).trim();
              isWriteValid = true;
            }

            if (inputPara === "app_lang") {
              cmdBody = cmdBody.substring(8).trim();
              isWriteValid = true;
            }

            if (isWriteValid) {
              let inputVal = cmdBody.trim();
              if (inputPara === "app_lang") {
                if (!langList.hasOwnProperty(inputVal)) {
                  let mRequestBody = {
                    token: context.botToken,
                    channel: channel,
                    user: userId,
                    //blocks: blocks,
                    text: `Lang file [${inputVal}] not found`,
                  };
                  await postChat(body.response_url, 'ephemeral', mRequestBody);
                  return;
                }
              } else {
                if (cmdBody.startsWith("true")) {
                  inputVal = true;
                } else if (cmdBody.startsWith("false")) {
                  inputVal = false;
                } else {
                  let mRequestBody = {
                    token: context.botToken,
                    channel: channel,
                    user: userId,
                    //blocks: blocks,
                    text: `Usage: ${inputPara} [true/false]`,
                  };
                  await postChat(body.response_url, 'ephemeral', mRequestBody);
                  return;
                }
              }
              if (!team.hasOwnProperty("openPollConfig")) team.openPollConfig = {};
              team.openPollConfig.isset = true;
              team.openPollConfig[inputPara] = inputVal;
              //logger.info(team);
              try {
                //await orgCol.replaceOne({'team.id': getTeamOrEnterpriseId(body)}, team);
                await orgCol.replaceOne(
                    {
                      $or: [
                        {'team.id': teamOrEntId},
                        {'enterprise.id': teamOrEntId},
                      ]
                    }
                    , team);
              } catch (e) {
                logger.error(e);
                let mRequestBody = {
                  token: context.botToken,
                  channel: channel,
                  user: userId,
                  //blocks: blocks,
                  text: `Error while update [${inputPara}] to [${inputVal}]`,
                };
                await postChat(body.response_url, 'ephemeral', mRequestBody);
                return;

              }

              let mRequestBody = {
                token: context.botToken,
                channel: channel,
                user: userId,
                //blocks: blocks,
                text: `[${inputPara}] is set to [${inputVal}] for this Team`,
              };
              await postChat(body.response_url, 'ephemeral', mRequestBody);
              return;

            } else {
              let mRequestBody = {
                token: context.botToken,
                channel: channel,
                user: userId,
                //blocks: blocks,
                text: `[${inputPara}] is not valid config parameter or value is missing\nUsage: ${validWritePara}`,
              };
              await postChat(body.response_url, 'ephemeral', mRequestBody);
              return;
            }


          } else {
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              //blocks: blocks,
              text: `Usage:\n/${slackCommand} config read` +
                  `\n${validWritePara}`
              ,
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }

        } else if (cmdBody.startsWith('user_config')) {
          await respond(`/${slackCommand} ${command.text}`);
          fetchArgs = false;
          cmdBody = cmdBody.substring(11).trim();

          let validWritePara = ""
          for (const eachOverrideable of validUserOverrideConfigTF) {
            validWritePara += `\n/${slackCommand} user_config write ${eachOverrideable} [true/false]`;
          }

          let uConfig = await getUserConfig(teamOrEntId,userId);
          if(uConfig===null) {
            uConfig = {
              team_id: teamOrEntId,
              user_id: userId,
            }
          }

          if (cmdBody.startsWith("reset")) {
            cmdBody = cmdBody.substring(5).trim();

            let configTxt = `Usage: /${slackCommand} user_config reset true`;

            if (cmdBody.startsWith('true')) {
              configTxt = "Reset user_config to default stage.";

              uConfig.flag = {
                reset_ts: new Date()
              };
              try {
                await userCol.replaceOne({
                      team_id: teamOrEntId,
                      user_id: userId,
                    },
                    uConfig
                    , {
                      upsert: true,
                    }
                );
              } catch (e) {
                configTxt = "Reset user_config FAILED!";
              }
            }

            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              //blocks: blocks,
              text: `${configTxt}`,
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;

          } else if (cmdBody.startsWith("read")) {

            let configTxt = "Config: not found";
            if (uConfig) {
              if (uConfig.hasOwnProperty("config")) {
                configTxt = "User Config:\n```" + JSON.stringify(uConfig.config) + "```";

              } else {
                configTxt = "No User Config: using server default";
              }
            }


            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              //blocks: blocks,
              text: `${configTxt}`,
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          } else if (cmdBody.startsWith("write")) {
            cmdBody = cmdBody.substring(5).trim();

            let inputPara = (cmdBody.substring(0, cmdBody.indexOf(' ')));
            let isWriteValid = false;

            if (validUserOverrideConfigTF.includes(inputPara)) {
              cmdBody = cmdBody.substring(inputPara.length).trim();
              isWriteValid = true;
            }

            if (isWriteValid) {
              let inputVal = cmdBody.trim();

              if (cmdBody.startsWith("true")) {
                inputVal = true;
              } else if (cmdBody.startsWith("false")) {
                inputVal = false;
              } else {
                let mRequestBody = {
                  token: context.botToken,
                  channel: channel,
                  user: userId,
                  //blocks: blocks,
                  text: `Usage: ${inputPara} [true/false]`,
                };
                await postChat(body.response_url, 'ephemeral', mRequestBody);
                return;
              }

              if (!uConfig.hasOwnProperty("config")) uConfig.config = {};

              uConfig.config.isset = true;
              uConfig.config[inputPara] = inputVal;
              //logger.info(team);
              try {
                //await orgCol.replaceOne({'team.id': getTeamOrEnterpriseId(body)}, team);
                await userCol.replaceOne(
                    {
                      team_id: teamOrEntId,
                      user_id: userId,
                    }
                    ,
                    uConfig
                    ,
                    {
                      upsert: true,
                    });
              } catch (e) {
                logger.error(e);
                let mRequestBody = {
                  token: context.botToken,
                  channel: channel,
                  user: userId,
                  //blocks: blocks,
                  text: `Error while update [${inputPara}] to [${inputVal}]`,
                };
                await postChat(body.response_url, 'ephemeral', mRequestBody);
                return;

              }

              let mRequestBody = {
                token: context.botToken,
                channel: channel,
                user: userId,
                //blocks: blocks,
                text: `[${inputPara}] is set to [${inputVal}] for this User`,
              };
              await postChat(body.response_url, 'ephemeral', mRequestBody);
              return;

            } else {
              let mRequestBody = {
                token: context.botToken,
                channel: channel,
                user: userId,
                //blocks: blocks,
                text: `[${inputPara}] is not valid user_config parameter or value is missing\nUsage: ${validWritePara}`,
              };
              await postChat(body.response_url, 'ephemeral', mRequestBody);
              return;
            }

          } else {
              let mRequestBody = {
                token: context.botToken,
                channel: channel,
                user: userId,
                //blocks: blocks,
                text: `Usage:\n/${slackCommand} user_config read` +
                    `${validWritePara}` +
                    `\n/${slackCommand} user_config reset`,
              };
              await postChat(body.response_url, 'ephemeral', mRequestBody);
              return;
          }
        }
      }

      //V1
      // const lastSep = cmdBody.split('').pop();
      // const firstSep = cmdBody.charAt(0);

      if (isLimited && null === limit) {
        limit = 1;
      }

      try {

        //V3
        // Build a regular expression that matches the standard double quote
        const quotePattern = `\\${standardQuote}`;
        const regexp = new RegExp(`${quotePattern}(?:[^${quotePattern}\\\\]|\\\\.)*${quotePattern}`, 'g');

        const matches = cmdBody.match(regexp);
        if (matches) {
          for (let option of matches) {
            // Remove the first and last characters (quotes)
            let opt = option.substring(1, option.length - 1);

            // For question and options, unescape quotes and double backslashes for user readability
            let unescapedOpt = opt.replace(new RegExp(escapedQuotesPattern, 'g'), (match) => match[1])
                .replace(/\\\\/g, "\\");
            if (question === null) {
              question = unescapedOpt;
            } else {
              options.push(unescapedOpt);
            }
          }
        }
      } catch (e) {
        let mRequestBody = {
          token: context.botToken,
          channel: channel,
          user: userId,
          //blocks: blocks,
          text: `\`${fullCmd}\`\n` + stri18n(userLang, 'err_invalid_command')
          ,
        };
        await postChat(body.response_url, 'ephemeral', mRequestBody);
        return;
      }


      if (options.length > gSlackLimitChoices) {
        try {
          let mRequestBody = {
            token: context.botToken,
            channel: channel,
            user: userId,
            text: `\`\`\`${fullCmd}\`\`\`\n` + parameterizedString(stri18n(appLang, 'err_slack_limit_choices_max'), {slack_limit_choices: gSlackLimitChoices}),
          };
          await postChat(body.response_url, 'ephemeral', mRequestBody);
        } catch (e) {
          //not able to dm user
          console.log(e);
        }
        return;
      }

      let endTs = null;
      if(endDateTime !== null) {
        endTs = new Date(endDateTime);
      }

      if(reqBotInCh) {
        try {
          const result = await client.conversations.info({
            token: context.botToken,
            channel: channel
          });
        } catch (e) {
          if (e.message.includes('channel_not_found') || e.message.includes('team_not_found') || e.message.includes('team_access_not_granted')) {
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: "```" + fullCmd + "```\n" + parameterizedString(stri18n(userLang, 'err_bot_not_in_ch_schedule'), {
                bot_name: botName,
              })
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          } else {
            //ignore it!
            logger.debug(`Error on client.conversations.info (CH:${channel}) :` + e.message);
            console.log(e);
            console.trace();
          }
        }
      }

      const pollView = (await createPollView(teamOrEntId, channel, question, options, isAnonymous, isLimited, limit, isHidden, isAllowUserAddChoice, isMenuAtTheEnd, isCompactUI, isShowDivider, isShowHelpLink, isShowCommandInfo, isTrueAnonymous, isShowNumberInChoice, isShowNumberInChoiceBtn, endTs, userLang, userId, fullCmd, "cmd", null, null,false,null));
      const blocks = pollView?.blocks;
      const pollID = pollView?.poll_id;
      if (null === pollView || null === blocks) {
        let mRequestBody = {
          token: context.botToken,
          channel: channel,
          user: userId,
          //blocks: blocks,
          text: `\`${fullCmd}\`\n` + stri18n(userLang, 'err_invalid_command')
        };
        await postChat(body.response_url, 'ephemeral', mRequestBody);
        return;
      }

      if (postDateTime === null) {
        let mRequestBody = {
          token: context.botToken,
          channel: channel,
          blocks: blocks,
          text: `Poll : ${question}`,
        };
        const postRes = await postChat((forceNotUsingResponseURL?"":body.response_url), 'post', mRequestBody);
        if (postRes.status === false) {
          try {
            logger.debug("Block count:" + blocks?.length);
            console.log(postRes);
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: `Error while create poll: \`${fullCmd}\` \nERROR:${postRes.message}`
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
          } catch (e) {
            //not able to dm user
            console.log(e);
          }
        } else {
          //update slack_ts
          await pollCol.updateOne(
              { _id: new ObjectId(pollID)},
              { $set: { ts: postRes.slack_ts } }
          );
        }
      } else {
        try {
          const schTs = new Date(postDateTime);
          const dataToInsert = {
            poll_id: new ObjectId(pollID),
            next_ts: schTs,
            created_cmd: fullCmd,
            created_ts: new Date(),
            created_user_id: userId,
            run_max: 1,
            is_done: false,
            is_enable: true,
            poll_ch: null,
            cron_string: null,
          };

          await scheduleCol.replaceOne(
              {poll_id: new ObjectId(pollID)}, // Filter document with the same poll_id
              dataToInsert, // New document to be inserted
              {upsert: true} // Option to insert a new document if no matching document is found
          );
          let localizeTS = await getAndlocalizeTimeStamp(context.botToken,userId,schTs);
          let actString = "```" + fullCmd + "```\n" + parameterizedString(stri18n(userLang, 'task_scheduled'), {
            poll_id: pollID,
            ts: localizeTS,
            poll_ch: null,
            cron_string: null,
            run_max: 1
          });

          let mRequestBody = {
            token: context.botToken,
            channel: channel,
            user: userId,
            text: actString
            ,
          };
          const postRes = await postChat(body.response_url, 'ephemeral', mRequestBody);
          logger.verbose(`[Schedule] New simple task create from CMD (PollID:${pollID})`);

        } catch (e) {

          logger.error(`[Schedule] New simple task create from CMD (PollID:${pollID}) ERROR`);
          logger.error(e.toString() + "\n" + e.stack);
          console.log(e);
          console.trace();
          let mRequestBody = {
            token: context.botToken,
            channel: channel,
            user: userId,
            text: "```" + fullCmd + "```\n" +"[Schedule] Scheduled Error"
          };
          await postChat(body.response_url, 'ephemeral', mRequestBody);
          return;
        }
      }

    }
  } catch (e) {
    logger.error(`UNEXPECTED ERROR in /command processing :` + e.message);
    logger.error(e.toString() + "\n" + e.stack);
    console.log(e);
    console.trace();
  }
}

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

const createModalBlockInputDelete = (userLang)  => {
  return {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": " "
      },
      "accessory": {
        "type": "button",
        "text": {
          "type": "plain_text",
          "text": "🗑",
          "emoji": true
        },
        "value": "del-0",
        "action_id": "btn_del_choice"
      }
    }
};

(async () => {
  logger.info('Start database migration.');
  await migrations.init();
  await migrations.migrate();
  logger.info('End database migration.')

  logger.info('Check create DB index if not exist...');
  await createDBIndex();

  await app.start(process.env.PORT || port);

  logger.info('Bolt app is running!');

  logger.info('Check and start cron jobs.');
  // Schedule the task checker to run every minute
  cron.schedule('* * * * *', checkAndExecuteTasks);
  // Cleanup every day
  cron.schedule('0 22 * * *', autoCleanupTask);

  // Start the task checker immediately
  checkAndExecuteTasks();
  autoCleanupTask();

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
    logger.info('error');
    return;
  }
  const teamConfig = await getTeamOverride(getTeamOrEnterpriseId(context));
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang
  let blocks = body.view.blocks;
  const hash = body.view.hash;

  let beginBlocks = blocks.slice(0, blocks.length - 1);
  let endBlocks = blocks.slice(-1);

  let tempModalBlockInput = JSON.parse(JSON.stringify(createModalBlockInput(appLang)));
  //tempModalBlockInput.block_id = 'choice_'+(blocks.length-8);
  tempModalBlockInput.block_id = 'choice_'+uuidv4();

  let tempModalBlockInputDelete = JSON.parse(JSON.stringify(createModalBlockInputDelete(appLang)));
  tempModalBlockInputDelete.block_id = tempModalBlockInput.block_id+"_del";
  tempModalBlockInputDelete.accessory.value = tempModalBlockInput.block_id;
  //tempModalBlockInputDelete.text.text = tempModalBlockInput.block_id;


  beginBlocks.push(tempModalBlockInput);
  beginBlocks.push(tempModalBlockInputDelete);
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
    logger.debug("Error on btn_add_choice (maybe user click too fast");
  }

});
app.action('btn_del_choice', async ({ action, ack, body, client, context }) => {

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
    logger.info('error');
    return;
  }
  const teamConfig = await getTeamOverride(getTeamOrEnterpriseId(context));
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang
  let blocks = body.view.blocks;
  const hash = body.view.hash;

  logger.debug("DEL:"+action.value);

  // Filter out the block that has a block_id starting with action.value
  blocks = blocks.filter(block => {
    if (!block.block_id || !block.block_id.startsWith(action.value)) {
      return true;
    }
    return false;
  });

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
    logger.debug("Error on btn_del_choice (maybe user click too fast");
  }

});

app.action('btn_vote', async ({ action, ack, body, context }) => {
  try {
    await ack();
    //let menuAtIndex = 0;
    const teamConfig = await getTeamOverride(getTeamOrEnterpriseId(body));

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
      logger.info('error');
      return;
    }
    const user_id = body.user.id;
    const message = body.message;
    let blocks = message.blocks;

    const channel = body.channel.id;

    let value = JSON.parse(action.value);

    let poll_id = null;
    if (value.hasOwnProperty('poll_id'))
      poll_id = value.poll_id;

    let userLang = null;
    if (value.hasOwnProperty('user_lang'))
      if (value.user_lang !== "" && value.user_lang != null)
        userLang = value.user_lang;

    let isAnonymous = false;
    if (value.hasOwnProperty('anonymous'))
      if (value.anonymous !== "" && value.anonymous != null)
        isAnonymous = value.anonymous;

    if (userLang == null) {
      userLang = gAppLang;
      if (teamConfig.hasOwnProperty("app_lang")) userLang = teamConfig.app_lang;
    }

    let isMenuAtTheEnd = gIsMenuAtTheEnd;
    if (value.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = value.menu_at_the_end;
    else if (teamConfig.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = teamConfig.menu_at_the_end;

    let isCompactUI = gIsCompactUI;
    if (value.hasOwnProperty("compact_ui")) isCompactUI = value.compact_ui;
    else if (teamConfig.hasOwnProperty("compact_ui")) isCompactUI = teamConfig.compact_ui;

    let isShowDivider = gIsShowDivider;
    if (value.hasOwnProperty("show_divider")) isShowDivider = value.show_divider;
    else if (teamConfig.hasOwnProperty("show_divider")) isShowDivider = teamConfig.show_divider;


    // if (isMenuAtTheEnd) menuAtIndex = body.message.blocks.length - 1;

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
        logger.info(`[Try #${countTry}] Error while attempt to acquire mutex lock.`, e)
      }
    } while (!release && countTry < 3);

    if (release) {
      let removeVote = false;
      try {

        let isClosed = false
        try {
          const data = await closedCol.findOne({channel, ts: message.ts});
          isClosed = data !== null && data.closed;
        } catch {
        }

        if (isClosed) {
          let mRequestBody = {
            token: context.botToken,
            channel: body.channel.id,
            user: body.user.id,
            attachments: [],
            text: stri18n(userLang, 'err_change_vote_poll_closed'),
          };
          await postChat(body.response_url, 'ephemeral', mRequestBody);
          return;
        }

        let poll = null;
        const data = await votesCol.findOne({channel: channel, ts: message.ts});
        if (data === null) {
          await votesCol.insertOne({
            team: message.team,
            channel,
            ts: message.ts,
            poll_id: poll_id,
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
        if (!poll.hasOwnProperty(value.id)) {
          //logger.info("Vote array not found creating value.id="+value.id);
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

        // let button_id = 3 + (value.id * 2);
        // let context_id = 3 + (value.id * 2) + 1;
        // let blockBtn = blocks[button_id];
        // let block = blocks[context_id];
        // let voters = value.voters ? value.voters : [];


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
              text: parameterizedString(stri18n(userLang, 'err_vote_over_limit'), {limit: value.limit}),
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }
        }

        let voteType = '+';
        if (removeVote) {
          poll[value.id] = poll[value.id].filter(voter_id => voter_id !== user_id);
          voteType = '-';
        } else {
          poll[value.id].push(user_id);
        }

        blocks = await updateVoteBlock(message.team,channel,message.ts,blocks,poll,userLang,isHidden,isCompactUI,isMenuAtTheEnd);

        await votesCol.updateOne({
          channel,
          ts: message.ts,
        }, {
          $set: {
            votes: poll,
          }
        });
        logger.debug(`Vote ${voteType} For ${poll_id} : ${value.id}`);

        let mRequestBody = {
          token: context.botToken,
          channel: channel,
          ts: message.ts,
          blocks: blocks,
          text: message.text,
        };
        await postChat(body.response_url, 'update', mRequestBody);

        if (isAnonymous) {
          let mesStr = parameterizedString(stri18n(userLang, 'info_anonymous_vote'), {choice: ""});
          if (removeVote) mesStr = parameterizedString(stri18n(userLang, 'info_anonymous_unvote'), {choice: ""});
          let mRequestBody = {
            token: context.botToken,
            channel: body.channel.id,
            user: body.user.id,
            attachments: [],
            text: mesStr
          };
          await postChat(body.response_url, 'ephemeral', mRequestBody);
        }

      } catch (e) {
        logger.error(e);
        let mRequestBody = {
          token: context.botToken,
          channel: body.channel.id,
          user: body.user.id,
          attachments: [],
          text: stri18n(userLang, 'err_vote_exception'),
        };
        await postChat(body.response_url, 'ephemeral', mRequestBody);

      } finally {
        release();
      }
    } else {
      let mRequestBody = {
        token: context.botToken,
        channel: body.channel.id,
        user: body.user.id,
        attachments: [],
        text: stri18n(userLang, 'err_vote_exception'),
      };
      await postChat(body.response_url, 'ephemeral', mRequestBody);

    }
  } catch (e) {
    logger.error(`UNEXPECTED ERROR in btn_vote :` + e.message);
    logger.error(e.toString() + "\n" + e.stack);
    console.log(e);
    console.trace();
  }
});
app.action('add_choice_after_post', async ({ ack, body, action, context,client }) => {
  try {
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
      logger.info('error');
      return;
    }
    const teamConfig = await getTeamOverride(getTeamOrEnterpriseId(body));
    let appLang = gAppLang;
    if (teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
    const user_id = body.user.id;
    const message = body.message;
    let blocks = message.blocks;

    const channel = body.channel.id;

    if(!action.value) return;
    const value = action.value.trim();

    let poll_id = null;

    let isMenuAtTheEnd = gIsMenuAtTheEnd;
    if (teamConfig.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = teamConfig.menu_at_the_end;
    let isCompactUI = gIsCompactUI;
    if (teamConfig.hasOwnProperty("compact_ui")) isCompactUI = teamConfig.compact_ui;
    let isShowDivider = gIsShowDivider;
    if (teamConfig.hasOwnProperty("show_divider")) isShowDivider = teamConfig.show_divider;
    let isShowHelpLink = gIsShowHelpLink;
    if (teamConfig.hasOwnProperty("show_help_link")) isShowHelpLink = teamConfig.show_help_link;
    let isShowCommandInfo = gIsShowCommandInfo;
    if (teamConfig.hasOwnProperty("show_command_info")) isShowCommandInfo = teamConfig.show_command_info;
    let isTrueAnonymous = gTrueAnonymous;
    if (teamConfig.hasOwnProperty("true_anonymous")) isTrueAnonymous = teamConfig.true_anonymous;
    let isShowNumberInChoice = gIsShowNumberInChoice;
    if (teamConfig.hasOwnProperty("add_number_emoji_to_choice")) isShowNumberInChoice = teamConfig.add_number_emoji_to_choice;
    let isShowNumberInChoiceBtn = gIsShowNumberInChoiceBtn;
    if (teamConfig.hasOwnProperty("add_number_emoji_to_choice_btn")) isShowNumberInChoiceBtn = teamConfig.add_number_emoji_to_choice_btn;

    let userLang = appLang;

    let isClosed = false
    try {
      const data = await closedCol.findOne({channel, ts: message.ts});
      isClosed = data !== null && data.closed;
    } catch {
    }

    if (isClosed) {
      let mRequestBody = {
        token: context.botToken,
        channel: body.channel.id,
        user: body.user.id,
        attachments: [],
        text: stri18n(userLang, 'err_change_vote_poll_closed'),
      };
      await postChat(body.response_url, 'ephemeral', mRequestBody);
      return;
    }

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
        logger.info(`[Try #${countTry}] Error while attempt to acquire mutex lock.`, e)
      }
    } while (!release && countTry < 3);
    if (release) {
      try {
        //find next option id
        let lastestOptionId = -1;
        let lastestVoteBtnVal = [];
        for (const idx in body.message.blocks) {
          if (body.message.blocks[idx].hasOwnProperty('type') && body.message.blocks[idx].hasOwnProperty('accessory')) {
            if (body.message.blocks[idx]['type'] === 'section') {
              if (body.message.blocks[idx]['accessory']['type'] === 'button') {
                if (body.message.blocks[idx]['accessory'].hasOwnProperty('action_id') &&
                    body.message.blocks[idx]['accessory'].hasOwnProperty('value')
                ) {
                  const voteBtnVal = JSON.parse(body.message.blocks[idx]['accessory']['value']);
                  const voteBtnId = parseInt(voteBtnVal['id']);
                  if (voteBtnId > lastestOptionId) {
                    lastestOptionId = voteBtnId;
                    lastestVoteBtnVal = voteBtnVal;
                    if (voteBtnVal.hasOwnProperty('user_lang'))
                      if (voteBtnVal['user_lang'] !== "" && voteBtnVal['user_lang'] != null)
                        userLang = voteBtnVal['user_lang'];
                    if (voteBtnVal.hasOwnProperty("poll_id")) poll_id = voteBtnVal.poll_id;
                    if (voteBtnVal.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = voteBtnVal.menu_at_the_end;
                    if (voteBtnVal.hasOwnProperty("compact_ui")) isCompactUI = voteBtnVal.compact_ui;
                    if (voteBtnVal.hasOwnProperty("show_divider")) isShowDivider = voteBtnVal.show_divider;
                    if (voteBtnVal.hasOwnProperty("show_help_link")) isShowHelpLink = voteBtnVal.show_help_link;
                    if (voteBtnVal.hasOwnProperty("show_command_info")) isShowCommandInfo = voteBtnVal.show_command_info;
                    if (voteBtnVal.hasOwnProperty("true_anonymous")) isTrueAnonymous = voteBtnVal.true_anonymous;
                    if (voteBtnVal.hasOwnProperty("add_number_emoji_to_choice")) isShowNumberInChoice = voteBtnVal.add_number_emoji_to_choice;
                    if (voteBtnVal.hasOwnProperty("add_number_emoji_to_choice_btn")) isShowNumberInChoiceBtn = voteBtnVal.add_number_emoji_to_choice_btn;

                  }

                  let thisChoice = body.message.blocks[idx]['text']['text'].trim();
                  if (isShowNumberInChoice) {
                    thisChoice = thisChoice.replace(slackNumToEmoji((voteBtnId + 1), userLang) + " ", '');
                  }

                  if (thisChoice === value) {
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
        let newChoiceIndex = body.message.blocks.length - 1;
        if (isShowHelpLink || isShowCommandInfo) newChoiceIndex--;
        if (isMenuAtTheEnd) newChoiceIndex--;

        const tempAddBlock = blocks[newChoiceIndex];

        lastestVoteBtnVal['id'] = (lastestOptionId + 1);
        lastestVoteBtnVal['voters'] = [];

        if (lastestVoteBtnVal['id'] + 1 > gSlackLimitChoices) {
          try {
            let mRequestBody = {
              token: context.botToken,
              channel: body.channel.id,
              user: body.user.id,
              text: parameterizedString(stri18n(appLang, 'err_slack_limit_choices_max'), {slack_limit_choices: gSlackLimitChoices}),
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
          } catch (e) {
            //not able to dm user
            console.log(e);
          }
          return;
        }

        blocks.splice(newChoiceIndex, 1, buildVoteBlock(lastestVoteBtnVal, value, isCompactUI, isShowDivider, isShowNumberInChoice, isShowNumberInChoiceBtn));

        let divSpace = 0;
        if (!isCompactUI) {
          divSpace++;
          let block = {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: lastestVoteBtnVal['hidden'] ? stri18n(userLang, 'info_wait_reveal') : stri18n(userLang, 'info_no_vote'),
              }
            ],
          };
          blocks.splice(newChoiceIndex + divSpace, 0, block);
        }
        if (isShowDivider) {
          divSpace++;
          blocks.splice(newChoiceIndex + divSpace, 0, {
            type: 'divider',
          });
        }

        let mRequestBody2 = {
          token: context.botToken,
          channel: channel,
          ts: message.ts,
          blocks: blocks,
          text: message.text
        };
        await postChat(body.response_url, 'update', mRequestBody2);

        //re-add add-choice section
        blocks.splice(newChoiceIndex + 1 + divSpace, 0, tempAddBlock);

        mRequestBody2 = {
          token: context.botToken,
          channel: channel,
          ts: message.ts,
          blocks: blocks,
          text: message.text
        };
        await postChat(body.response_url, 'update', mRequestBody2);

        //update polldata
        if (poll_id != null) {
          pollCol.updateOne(
              {_id: new ObjectId(poll_id)},
              {$push: {options: value}}
          );
        }

      } catch (e) {
        logger.error(e);
        let mRequestBody = {
          token: context.botToken,
          channel: body.channel.id,
          user: body.user.id,
          attachments: [],
          text: stri18n(userLang, 'err_add_choice_exception'),
        };
        await postChat(body.response_url, 'ephemeral', mRequestBody);
      } finally {
        release();
      }
    }

    return;
  } catch (e) {
    logger.error(`UNEXPECTED ERROR in add_choice_after_post :` + e.message);
    logger.error(e.toString() + "\n" + e.stack);
    console.log(e);
    console.trace();
  }

});

app.shortcut('open_modal_new', async ({ shortcut, ack, context, client }) => {
  try {
    await ack();
    createModal(context, client, shortcut.trigger_id);
  } catch (e) {
    logger.error(`UNEXPECTED ERROR in open_modal_new :` + e.message);
    logger.error(e.toString() + "\n" + e.stack);
    console.log(e);
    console.trace();
  }
});

async function createModal(context, client, trigger_id,response_url,channel) {
  try {
    const teamConfig = await getTeamOverride(getTeamOrEnterpriseId(context));
    let appLang= gAppLang;
    if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
    let tempModalBlockInput = JSON.parse(JSON.stringify(createModalBlockInput(appLang)));
    tempModalBlockInput.block_id = 'choice_0';

    let tempModalBlockInput2 = JSON.parse(JSON.stringify(createModalBlockInput(appLang)));
    tempModalBlockInput2.block_id = 'choice_'+uuidv4();
    let tempModalBlockInputDelete2 = JSON.parse(JSON.stringify(createModalBlockInputDelete(appLang)));
    tempModalBlockInputDelete2.block_id = tempModalBlockInput2.block_id+"_del";
    tempModalBlockInputDelete2.accessory.value = tempModalBlockInput2.block_id;

    let isMenuAtTheEnd = gIsMenuAtTheEnd;
    if(teamConfig.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = teamConfig.menu_at_the_end;
    let isShowHelpLink = gIsShowHelpLink;
    if(teamConfig.hasOwnProperty("show_help_link")) isShowHelpLink = teamConfig.show_help_link;
    let isShowCommandInfo = gIsShowCommandInfo;
    if(teamConfig.hasOwnProperty("show_command_info")) isShowCommandInfo = teamConfig.show_command_info;
    let isTrueAnonymous = gTrueAnonymous;
    if(teamConfig.hasOwnProperty("true_anonymous")) isTrueAnonymous = teamConfig.true_anonymous;
    let isShowNumberInChoice = gIsShowNumberInChoice;
    if(teamConfig.hasOwnProperty("add_number_emoji_to_choice")) isShowNumberInChoice = teamConfig.add_number_emoji_to_choice;
    let isShowNumberInChoiceBtn = gIsShowNumberInChoiceBtn;
    if(teamConfig.hasOwnProperty("add_number_emoji_to_choice_btn")) isShowNumberInChoiceBtn = teamConfig.add_number_emoji_to_choice_btn;
    let isViaCmdOnly = gIsViaCmdOnly;
    if(teamConfig.hasOwnProperty("create_via_cmd_only")) isViaCmdOnly = teamConfig.create_via_cmd_only;

    const privateMetadata = {
      user_lang: appLang,
      anonymous: false,
      limited: false,
      hidden: false,
      user_add_choice: false,
      menu_at_the_end: isMenuAtTheEnd,
      show_help_link: isShowHelpLink,
      show_command_info: isShowCommandInfo,
      true_anonymous: isTrueAnonymous,
      add_number_emoji_to_choice: isShowNumberInChoice,
      add_number_emoji_to_choice_btn: isShowNumberInChoiceBtn,
      response_url: response_url,
      channel: channel,
    };

    if( isUseResponseUrl && (response_url=== "" || response_url===undefined) && isViaCmdOnly) {
      let blocks = [

        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: parameterizedString(stri18n(appLang,'modal_ch_via_cmd_only'),{slack_command:slackCommand,bot_name:botName})
            //text: stri18n(appLang,'modal_ch_via_cmd_only'),
          },
        }
      ];

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
          close: {
            type: 'plain_text',
            text: stri18n(appLang,'btn_cancel'),
          },
          blocks: blocks,
        }
      });
      return;

    }

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
    //logger.debug(response_url);
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
              filter: {
                include: ['private','public']
              },
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
              text: parameterizedString(stri18n(appLang, warnStr),{slack_command:slackCommand,bot_name:botName}),
            },
          ],
        }
      ]);
    }

  //select when to post
    const nowBlock = {
      "text": {
        "type": "plain_text",
        "text": stri18n(appLang,'task_scheduled_now'),
        "emoji": true
      },
      "value": "now"
    };
    const laterBlock = {
      "text": {
        "type": "plain_text",
        "text": stri18n(appLang,'task_scheduled_later'),
        "emoji": true
      },
      "value": "later"
    };
    blocks = blocks.concat([

      {
        "type": "input",
        "dispatch_action": true,
        "element": {
          "type": "static_select",
          "action_id": "modal_select_when",
          // "placeholder": {
          //   "type": "plain_text",
          //   "text": stri18n(appLang,'info_lang_select_hint'),
          //   "emoji": true
          // },
          "options": [
            nowBlock,laterBlock
          ],
          "initial_option" : nowBlock,
          
        },
        "label": {
          "type": "plain_text",
          "text": stri18n(appLang,'task_scheduled_when'),
          "emoji": true
        },
        "block_id": 'task_when',

      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: parameterizedString(stri18n(appLang,'task_scheduled_when_note'),{slack_command:slackCommand,bot_name:botName,task_scheduled_later:stri18n(appLang, 'task_scheduled_later')}),
          },
        ],
      },
      {
        type: 'divider',
      },
    ]);

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
        if(appLang === langKey)
        {
          defaultOption = thisLangOp;
        }
        allOptions.push(thisLangOp);
      }

      allOptions.sort((a, b) => {
        if (a.text.text < b.text.text) {
          return -1;
        } else if (a.text.text > b.text.text) {
          return 1;
        } else {
          return 0;
        }
      });

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
            //"action_id": "task_scheduled_when"
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
      tempModalBlockInput2,
      tempModalBlockInputDelete2,
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

    //logger.debug(JSON.stringify(blocks));
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
    logger.error(error);
  }
}

app.action('modal_select_when', async ({ action, ack, body, client, context }) => {
  try {
    await ack();

    //console.log(action);
    //console.log(body);
    if (
        !action
        || !action.selected_option.value
    ) {
      return;
    }

    let isNow = true;
    if (action.selected_option.value === "now") {
      isNow = true;
    } else {
      isNow = false;
    }
    const teamConfig = await getTeamOverride(getTeamOrEnterpriseId(body));
    let appLang = gAppLang;
    if (teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
    const privateMetadata = JSON.parse(body.view.private_metadata);
    //privateMetadata.channel = action.selected_channel || action.selected_conversation;

    //logger.debug(action);
    //logger.debug("CH:"+privateMetadata.channel);
    let isChFound = true;
    let isChErr = false;
    try {
      const result = await client.conversations.info({
        token: context.botToken,
        hash: body.view.hash,
        channel: privateMetadata.channel
      });
    } catch (e) {
      if (e.message.includes('channel_not_found') || e.message.includes('team_not_found') || e.message.includes('team_access_not_granted')) {
        isChFound = false;
      } else {
        //ignote it!
        // logger.debug(`Error on client.conversations.info (CH:${privateMetadata?.channel}) :`+e.message);
        // console.log(e);
        // console.trace();
        isChErr = true;
      }

    }

    let foundHintString = false;
    let blockPointer = 0;
    let blocks = body.view.blocks;
    for (const i in blocks) {
      let b = blocks[i];
      if (b.hasOwnProperty('block_id')) {
        //test next element
        let nextIndex = parseInt(i) + 1;
        if (blocks.length > nextIndex) {
          //logger.info("Block" +nextIndex +"IS:");
          //logger.info(blocks[nextIndex]);
          if (!foundHintString) {
            if (blocks[nextIndex].hasOwnProperty('elements') && blocks[nextIndex].type === "context") {
              //logger.info("TEST of" +nextIndex +"IS:"+ blocks[nextIndex].elements[0].text)
              if (isNow && privateMetadata?.response_url !== "" && privateMetadata?.response_url && isUseResponseUrl) {
                blocks[nextIndex].elements[0].text = stri18n(appLang, 'modal_ch_response_url_auto');
              } else {
                if (isChErr) {
                  blocks[nextIndex].elements[0].text = stri18n(appLang, 'err_poll_ch_exception');
                } else if (isChFound) {
                  blocks[nextIndex].elements[0].text = stri18n(appLang, 'modal_bot_in_ch');
                } else {
                  blocks[nextIndex].elements[0].text = parameterizedString(stri18n(appLang, 'modal_bot_not_in_ch'), {
                    slack_command: slackCommand,
                    bot_name: botName
                  })
                }
                //break;
              }
              foundHintString = true;
            }
          } else {
            //find time select element
            //console.log(blockPointer + ":" + b.block_id)
            if (b.block_id === "task_when") {
              //input date time should be in nexr box
              //console.log("task_when FOUND!")
              if (isNow) {
                //delete date picker
                //console.log("change back to now");
                let beginBlocks = blocks.slice(0, blockPointer + 1);
                let endBlocks = blocks.slice(blockPointer + 2);
                blocks = beginBlocks.concat(endBlocks);
              } else {
                //add date picker
                if (blocks[nextIndex]?.block_id === "task_when_ts") {
                  //already exist
                  //console.log("task_when_ts already exist");
                } else {
                  let beginBlocks = blocks.slice(0, blockPointer + 1);
                  let endBlocks = blocks.slice(blockPointer + 1);

                  const dateTimeInput = {
                    "type": "input",
                    "block_id": 'task_when_ts',
                    "element": {
                      "type": "datetimepicker",
                      //"action_id": "datetimepicker-action"
                    },
                    // "hint": {
                    //   "type": "plain_text",
                    //   "text": "This is some hint text",
                    //   "emoji": true
                    // },
                    "label": {
                      "type": "plain_text",
                      "text": stri18n(appLang, 'task_scheduled_post_on'),
                      "emoji": true
                    }
                  };

                  let tempModalBlockInput = JSON.parse(JSON.stringify(dateTimeInput));
                  //tempModalBlockInput.block_id = 'TEST_choice_'+(blocks.length-8);

                  beginBlocks.push(tempModalBlockInput);
                  blocks = beginBlocks.concat(endBlocks);
                }
              }


              break;
            }
          }
        }
      }
      blockPointer++;
    }
    //logger.debug(blocks);
    const view = {
      type: body.view.type,
      private_metadata: JSON.stringify(privateMetadata),
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
        hash: body.view.hash,
        view: view,
        view_id: body.view.id,
      });
    } catch (e) {
      logger.debug("Error on modal_select_when (maybe user click too fast");
    }
  } catch (e) {
    logger.error(`UNEXPECTED ERROR in modal_select_when :` + e.message);
    logger.error(e.toString() + "\n" + e.stack);
    console.log(e);
    console.trace();
  }
});

app.action('modal_poll_channel', async ({ action, ack, body, client, context }) => {
  try {
    await ack();

    if (
        !action
        && !action.selected_channel
    ) {
      return;
    }
    const teamConfig = await getTeamOverride(getTeamOrEnterpriseId(body));
    let appLang = gAppLang;
    if (teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
    const privateMetadata = JSON.parse(body.view.private_metadata);
    privateMetadata.channel = action.selected_channel || action.selected_conversation;

    //logger.debug(action);
    //logger.debug("CH:"+privateMetadata.channel);
    let isChFound = true;
    let isChErr = false;
    try {
      const result = await client.conversations.info({
        token: context.botToken,
        hash: body.view.hash,
        channel: privateMetadata.channel
      });
    } catch (e) {
      if (e.message.includes('channel_not_found') || e.message.includes('team_not_found') || e.message.includes('team_access_not_granted')) {
        isChFound = false;
      } else {
        //ignote it!
        // logger.debug(`Error on client.conversations.info (CH:${privateMetadata?.channel}) :`+e.message);
        // console.log(e);
        // console.trace();
        isChErr = true;
      }

    }

    let blocks = body.view.blocks;
    for (const i in blocks) {
      let b = blocks[i];
      if (b.hasOwnProperty('block_id')) {
        //test next element
        let nextIndex = parseInt(i) + 1;
        if (blocks.length > nextIndex) {
          //logger.info("Block" +nextIndex +"IS:");
          //logger.info(blocks[nextIndex]);
          if (blocks[nextIndex].hasOwnProperty('elements') && blocks[nextIndex].type === "context") {
            //logger.info("TEST of" +nextIndex +"IS:"+ blocks[nextIndex].elements[0].text)
            if (isChErr) {
              blocks[nextIndex].elements[0].text = stri18n(appLang, 'err_poll_ch_exception');
            } else if (isChFound) {
              blocks[nextIndex].elements[0].text = stri18n(appLang, 'modal_bot_in_ch');
            } else {
              blocks[nextIndex].elements[0].text = parameterizedString(stri18n(appLang, 'modal_bot_not_in_ch'), {
                slack_command: slackCommand,
                bot_name: botName
              })
            }
            break;
          }
        }
      }
    }
    //logger.debug(blocks);
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
    } catch (e) {
      logger.debug("Error on modal_poll_channel (maybe user click too fast");
    }
  } catch (e) {
    logger.error(`UNEXPECTED ERROR in modal_poll_channel :` + e.message);
    logger.error(e.toString() + "\n" + e.stack);
    console.log(e);
    console.trace();
  }
});

app.action('modal_poll_options', async ({ action, ack, body, client, context }) => {
  try {
    await ack();
    return; //won't need to process anything anymore
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
    } catch (e) {
      //just ignore it will be process again on modal_poll_submit
      logger.debug("Error on modal_poll_options (maybe user click too fast)");
    }
  } catch (e) {
    logger.error(`UNEXPECTED ERROR in modal_poll_options :` + e.message);
    logger.error(e.toString() + "\n" + e.stack);
    console.log(e);
    console.trace();
  }
});

app.view('modal_poll_submit', async ({ ack, body, view, context,client }) => {

  try {
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
    let forceNotUsingResponseURL = false;
    const teamOrEntId = getTeamOrEnterpriseId(context);
    const teamConfig = await getTeamOverride(teamOrEntId);
    let appLang = gAppLang;
    let postDateTime = null;
    let endDateTime = null;
    if (teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
    let isAppAllowDM = gAppAllowDM;
    if (teamConfig.hasOwnProperty("app_allow_dm")) isAppAllowDM = teamConfig.app_allow_dm;

    const privateMetadata = JSON.parse(view.private_metadata);
    const userId = body.user.id;

    const state = view.state;
    let question = null;
    let userLang = appLang;
    const options = [];
    let elementToAlert = "task_when";
    let limit = 1;

    let isAck = false;

    if (state.values) {
      for (const optionName in state.values) {
        const option = state.values[optionName][Object.keys(state.values[optionName])[0]];
        if ('question' === optionName) {
          question = option.value;
        } else if ('user_lang' === optionName) {
          if (langList.hasOwnProperty(option.selected_option.value)) {
            userLang = option.selected_option.value;
          }
        } else if ('limit' === optionName) {
          limit = parseInt(option.value, 10);
        } else if (optionName.startsWith('choice_')) {
          options.push(option.value);
          elementToAlert = optionName;
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
        } else if ('task_when_ts' === optionName) {
          postDateTime = option.selected_date_time;
          //console.log(option);
        } else if ('channel' === optionName) {
          privateMetadata.channel = option.selected_conversation;
        } else if ('task_when' === optionName) {
          privateMetadata.when = option.selected_option?.value;
        } else if ('poll_end' === optionName) {
          privateMetadata.poll_end = option.selected_option?.value;
        } else if ('poll_end_ts' === optionName) {
          endDateTime = option.selected_date_time;
        }
      }
    }

    if(privateMetadata.when==="later" && postDateTime==null) {
      let ackErr = {
        response_action: 'errors',
        errors: {
          task_when: parameterizedString(stri18n(appLang, 'task_scheduled_time_missing'),{task_scheduled_later:stri18n(appLang, 'task_scheduled_later')}),
        },
      };
      await ack(ackErr);
      return;
    }

    if(privateMetadata.poll_end==="schedule" && endDateTime==null) {
      let ackErr = {
        response_action: 'errors',
        errors: {
          poll_end_ts: parameterizedString(stri18n(appLang, 'task_scheduled_time_missing'),{task_scheduled_later:stri18n(appLang, 'task_scheduled_later')}),
        },
      };
      await ack(ackErr);
      return;
    }

    if (isNaN(limit)) limit = 1;
    privateMetadata.user_lang = userLang;
    const isAnonymous = privateMetadata.anonymous;
    const isLimited = privateMetadata.limited;
    const isHidden = privateMetadata.hidden;
    const channel = privateMetadata.channel;
    const isAllowUserAddChoice = privateMetadata.user_add_choice;
    const response_url = privateMetadata.response_url;

    if( (!isUseResponseUrl || !response_url || response_url === "" ) && (privateMetadata.channel===undefined || privateMetadata.channel==null) ) {
      let ackErr = {
        response_action: 'errors',
        errors: {
          task_when: parameterizedString(stri18n(appLang, 'err_para_missing'), {parameter: "Channel to post"}),
        },
      };
      await ack(ackErr);
      return;
    }

    // logger.silly(body);
    // logger.silly(context);

    let posttimestamp = null;
    let schTs = null;
    let isoStr = null;

    if(postDateTime !== null) {
      forceNotUsingResponseURL = true;
      posttimestamp = parseInt(postDateTime, 10);
      schTs = new Date(posttimestamp * 1000); // multiply by 1000 to convert seconds to milliseconds
      isoStr = schTs.toISOString();
    }

    let endtimestamp = null;
    let endTs = null;
    let endisoStr = null;

    if(endDateTime !== null) {
      forceNotUsingResponseURL = true;
      endtimestamp = parseInt(endDateTime, 10);
      endTs = new Date(endtimestamp * 1000); // multiply by 1000 to convert seconds to milliseconds
      endisoStr = endTs.toISOString();
    }

    if (!isUseResponseUrl || !response_url || response_url === "" || forceNotUsingResponseURL) {
      try {
        const result = await client.conversations.info({
          token: context.botToken,
          channel: channel
        });
      } catch (e) {
        let errMsg = parameterizedString(stri18n(appLang, 'err_bot_not_in_ch'), {bot_name: botName});
        if(forceNotUsingResponseURL)  errMsg = parameterizedString(stri18n(appLang, 'err_bot_not_in_ch_schedule'), {bot_name: botName});
        if (e.message.includes('channel_not_found') || e.message.includes('team_not_found') || e.message.includes('team_access_not_granted')) {
          await ack({
            response_action: 'errors',
            errors: {
              task_when: errMsg,
            },
          });
          return;
        } else {
          //ignore it!
          logger.debug(`Error on client.conversations.info (CH:${channel}) :` + e.message);
          logger.debug(e.toString() + "\n" + e.stack);
          console.log(e);
          console.trace();
        }
      }
      //await ack();
    }


    if (
        !question
        || 0 === options.length
    ) {
      await ack({
        response_action: 'errors',
        errors: {
          question: stri18n(appLang, 'err_please_check_input'),
        },
      });
      return;
    }

    let cmd = "";
    try {
      cmd = createCmdFromInfos(question, options, isAnonymous, isLimited, limit, isHidden, isAllowUserAddChoice, userLang, isoStr, endisoStr);
    } catch (e) {
      logger.error(e);

      await ack({
        response_action: 'errors',
        errors: {
          question: stri18n(appLang, 'err_process_command'),
        },
      });

      let mRequestBody = {
        token: context.botToken,
        channel: channel,
        user: body.user.id,
        attachments: [],
        text: stri18n(userLang, 'err_process_command'),
      };
      await postChat(response_url, 'ephemeral', mRequestBody);
      return;
    }

    let isMenuAtTheEnd = gIsMenuAtTheEnd;
    let isCompactUI = gIsCompactUI;
    let isShowDivider = gIsShowDivider;
    let isShowHelpLink = gIsShowHelpLink;
    let isShowCommandInfo = gIsShowCommandInfo;
    let isTrueAnonymous = gTrueAnonymous;
    let isShowNumberInChoice = gIsShowNumberInChoice;
    let isShowNumberInChoiceBtn = gIsShowNumberInChoiceBtn;
    if (privateMetadata.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = privateMetadata.menu_at_the_end;
    else if (teamConfig.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = teamConfig.menu_at_the_end;
    if (privateMetadata.hasOwnProperty("compact_ui")) isCompactUI = privateMetadata.compact_ui;
    else if (teamConfig.hasOwnProperty("compact_ui")) isCompactUI = teamConfig.compact_ui;
    if (privateMetadata.hasOwnProperty("show_divider")) isShowDivider = privateMetadata.show_divider;
    else if (teamConfig.hasOwnProperty("show_divider")) isShowDivider = teamConfig.show_divider;
    if (privateMetadata.hasOwnProperty("show_help_link")) isShowHelpLink = privateMetadata.show_help_link;
    else if (teamConfig.hasOwnProperty("show_help_link")) isShowHelpLink = teamConfig.show_help_link;
    if (privateMetadata.hasOwnProperty("show_command_info")) isShowCommandInfo = privateMetadata.show_command_info;
    else if (teamConfig.hasOwnProperty("show_command_info")) isShowCommandInfo = teamConfig.show_command_info;
    if (privateMetadata.hasOwnProperty("true_anonymous")) isTrueAnonymous = privateMetadata.true_anonymous;
    else if (teamConfig.hasOwnProperty("true_anonymous")) isTrueAnonymous = teamConfig.true_anonymous;
    if (privateMetadata.hasOwnProperty("add_number_emoji_to_choice")) isShowNumberInChoice = privateMetadata.add_number_emoji_to_choice;
    else if (teamConfig.hasOwnProperty("add_number_emoji_to_choice")) isShowNumberInChoice = teamConfig.add_number_emoji_to_choice;
    if (privateMetadata.hasOwnProperty("add_number_emoji_to_choice_btn")) isShowNumberInChoiceBtn = privateMetadata.add_number_emoji_to_choice_btn;
    else if (teamConfig.hasOwnProperty("add_number_emoji_to_choice_btn")) isShowNumberInChoiceBtn = teamConfig.add_number_emoji_to_choice_btn;

    let isUserAllowDM = isAppAllowDM;
    let uConfig = await getUserConfig(teamOrEntId,userId);
    if(uConfig?.config?.hasOwnProperty('user_allow_dm')) {
      isUserAllowDM = uConfig.config.user_allow_dm;
    }

    let cmd_via;
    if (response_url !== undefined && response_url !== "") cmd_via = "modal_auto"
    else cmd_via = "modal_manual";

    if (options.length > gSlackLimitChoices) {

      let ackErr = {
        response_action: 'errors',
        errors: {
        },
      };
      ackErr.errors[elementToAlert] = parameterizedString(stri18n(appLang, 'err_slack_limit_choices_max'), {slack_limit_choices: gSlackLimitChoices});
      await ack(ackErr);

      if(isUserAllowDM) {
        try {
          let mRequestBody = {
            token: context.botToken,
            channel: userId,
            text: `\`\`\`${cmd}\`\`\`\n` + parameterizedString(stri18n(appLang, 'err_slack_limit_choices_max'), {slack_limit_choices: gSlackLimitChoices}),
          };
          await postChat("", 'post', mRequestBody);
        } catch (e) {
          //not able to dm user
          console.log(e);
        }
      }

      return;
    }

    const pollView = await createPollView(teamOrEntId, channel, question, options, isAnonymous, isLimited, limit, isHidden, isAllowUserAddChoice, isMenuAtTheEnd, isCompactUI, isShowDivider, isShowHelpLink, isShowCommandInfo, isTrueAnonymous, isShowNumberInChoice, isShowNumberInChoiceBtn, endTs, userLang, userId, cmd, cmd_via, null, null,false,null);
    const blocks = pollView.blocks;
    const pollID = pollView.poll_id;

    if (null === pollView || null === blocks) {
      let ackErr = {
        response_action: 'errors',
        errors: {
        },
      };
      ackErr.errors[elementToAlert] = `Error while create poll: Invalid input data`;
      await ack(ackErr);
      return;
    }

    if (postDateTime === null) {
      let mRequestBody = {
        token: context.botToken,
        channel: channel,
        blocks: blocks,
        text: `Poll : ${question}`,
      };
      const postRes = await postChat((forceNotUsingResponseURL?"":response_url), 'post', mRequestBody);
      //console.log(postRes.slack_response);
      if (postRes.status === false) {
        let ackErr = {
          response_action: 'errors',
          errors: {
          },
        };
        ackErr.errors[elementToAlert] = `Error while create poll:${postRes.message}`;
        await ack(ackErr);

        if(isUserAllowDM) {
          try {
            let mRequestBody = {
              token: context.botToken,
              channel: userId,
              text: `Error while create poll: \`\`\`${cmd}\`\`\` \nERROR:${postRes.message}`
            };
            await postChat(response_url, 'post', mRequestBody);
          } catch (e) {
            //not able to dm user
            console.log("not able to dm user");
            console.log(postRes);
            console.trace();
            console.log(e);
          }
        }

        return;
      } else {
        //update slack_ts
        //slack_ts will be null if response_url is use!
        await pollCol.updateOne(
            { _id: new ObjectId(pollID)},
            { $set: { ts: postRes.slack_ts } }
        );
      }
    } else {
      //schedule
      //console.log(postDateTime);
      try {


        //console.log(isoStr);
        //console.log(schTs);;
        const dataToInsert = {
          poll_id: new ObjectId(pollID),
          next_ts: schTs,
          created_ts: new Date(),
          created_user_id: userId,
          run_max: 1,
          is_done: false,
          is_enable: true,
          poll_ch: null,
          cron_string: null,
        };

        // Insert the data into scheduleCol
        //await scheduleCol.insertOne(dataToInsert);
        await scheduleCol.replaceOne(
            {poll_id: new ObjectId(pollID)}, // Filter document with the same poll_id
            dataToInsert, // New document to be inserted
            {upsert: true} // Option to insert a new document if no matching document is found
        );
        let localizeTS = await getAndlocalizeTimeStamp(context.botToken,userId,schTs);
        let actString = "```" + cmd + "```\n" + parameterizedString(stri18n(userLang, 'task_scheduled'), {
          poll_id: pollID,
          ts: localizeTS,
          //ts: isoStr,
          poll_ch: null,
          cron_string: null,
          run_max: 1
        });

        if (!isAck) await ack();
        isAck = true;

        let mRequestBody = {
          token: context.botToken,
          channel: channel,
          user: body.user.id,
          text: actString
          ,
        };
        const postRes = await postChat(response_url, 'ephemeral', mRequestBody);
        logger.verbose(`[Schedule] New task create from UI (PollID:${pollID})`);
      } catch (e) {

        await ack({
          response_action: 'errors',
          errors: {
            task_when: `[Schedule] Scheduled Error`,
          },
        });

        logger.error(`[Schedule] New task create from UI (PollID:${pollID}) ERROR`);
        logger.error(e);
        let mRequestBody = {
          token: context.botToken,
          channel: channel,
          user: userId,
          text: "[Schedule] Scheduled Error"
        };
        await postChat(response_url, 'ephemeral', mRequestBody);
        return;
      }
    }
    if (!isAck) {
      try {
        await ack();
      } catch (e) {

      }
    }
  } catch (e) {
    logger.error(`UNEXPECTED ERROR in modal_poll_submit :` + e.message);
    logger.error(e.toString() + "\n" + e.stack);
    console.log(e);
    console.trace();
  }
});

app.view('modal_delete_confirm', async ({ ack, body, view, context }) => {
  try {
    await ack();
    const privateMetadata = JSON.parse(view.private_metadata);
    deletePollConfirm(body, context, privateMetadata);
  } catch (e) {
    logger.error(`UNEXPECTED ERROR in modal_delete_confirm :` + e.message);
    logger.error(e.toString() + "\n" + e.stack);
    console.log(e);
    console.trace();
  }
});
function createCmdFromInfos(question, options, isAnonymous, isLimited, limit, isHidden, isAllowUserAddChoice, userLang, postDateTime, endisoStr) {
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
  if (postDateTime!=null) {
    cmd += ` on ${postDateTime}`
  }
  if (endisoStr!=null) {
    cmd += ` end ${endisoStr}`
  }

  let processingOption = "";
  try{
    question = question.replace(/\\/g, "\\\\");
    question = question.replace(/"/g, "\\\"");
    cmd += ` "${question}"`

    for (let option of options) {
      processingOption = option;
      option = option.replace(/\\/g, "\\\\");
      option = option.replace(/"/g, "\\\"");
      cmd += ` "${option}"`
    }

  }
  catch (e)
  {
    logger.error("question = "+question);
    logger.error("processingOption = "+processingOption);
    //logger.error(e);
    throw e;
  }


  return cmd;
}

async function createPollView(teamOrEntId,channel, question, options, isAnonymous, isLimited, limit, isHidden, isAllowUserAddChoice, isMenuAtTheEnd, isCompactUI, isShowDivider, isShowHelpLink, isShowCommandInfo, isTrueAnonymous, isShowNumberInChoice, isShowNumberInChoiceBtn, endDateTime, userLang, userId, cmd,cmd_via,cmd_via_ref,cmd_via_note,is_update,exist_poll_id) {
  if (
    !question
    || !options
    || 0 === options.length
  ) {
    return null;
  }

  let button_value = {
    user_lang: userLang,
    anonymous: isAnonymous,
    limited: isLimited,
    limit: limit,
    hidden: isHidden,
    user_add_choice: isAllowUserAddChoice,
    menu_at_the_end: isMenuAtTheEnd,
    compact_ui: isCompactUI,
    show_divider: isShowDivider,
    show_help_link: isShowHelpLink,
    show_command_info: isShowCommandInfo,
    true_anonymous: isTrueAnonymous,
    add_number_emoji_to_choice: isShowNumberInChoice,
    add_number_emoji_to_choice_btn: isShowNumberInChoiceBtn,
    voters: [],
    id: null,
  };

  let isScheduleEndActive = false;
  if( endDateTime!== null && endDateTime!== undefined ) isScheduleEndActive = true
  const pollData = {
    team: teamOrEntId,
    channel,
    ts: null,
    created_ts: new Date(),
    schedule_end_ts: endDateTime,
    schedule_end_active: isScheduleEndActive,
    user_id: userId,
    cmd: cmd,
    cmd_via,
    cmd_via_ref,
    cmd_via_note,
    question: question,
    options: options,
    para: button_value
  };

  let pollID = exist_poll_id;
  if(!is_update) {
    await pollCol.insertOne(pollData);
    pollID = pollData._id;

    logger.verbose(`[${cmd_via}] New Poll:${pollID} ${cmd_via_note}`);
    //logger.debug(pollData)
    logger.debug(`Poll CMD:${cmd}`);
  }

  button_value.poll_id = pollID;

  const blocks = [];
  //WARN: value limit is 151 char! change group will need to change buildMenu
  const staticSelectElements = [
    {//GRP 0
      label: {
        type: 'plain_text',
        text: stri18n(userLang, 'menu_poll_action'),
      },
      options: [{
        text: {
          type: 'plain_text',
          text: isHidden ? stri18n(userLang, 'menu_reveal_vote') : stri18n(userLang, 'menu_hide_vote'),
        },
        value:
            JSON.stringify({
              action: 'btn_reveal',
              revealed: !isHidden,
              user: userId,
              user_lang: userLang,
              mte: isMenuAtTheEnd ? 1 : 0,
              cui: isCompactUI ? 1 : 0,
              sdv: isShowDivider ? 1 : 0,
              shp: isShowHelpLink ? 1 : 0,
              scm: isShowCommandInfo ? 1 : 0
            }),
      }, {
        text: {
          type: 'plain_text',
          text: stri18n(userLang, 'menu_all_user_vote'),
        },
        value: JSON.stringify({
          action: 'btn_users_votes',
          p_id: pollID,
          user: userId,
          user_lang: userLang,
          anonymous: isAnonymous,
          true_anonymous: isTrueAnonymous
        }),
      }, {
        text: {
          type: 'plain_text',
          text: stri18n(userLang, 'menu_close_poll'),
        },
        value: JSON.stringify({
          action: 'btn_close',
          p_id: pollID,
          user: userId,
          user_lang: userLang,
          mte: isMenuAtTheEnd ? 1 : 0,
          cui: isCompactUI ? 1 : 0,
          sdv: isShowDivider ? 1 : 0,
          shp: isShowHelpLink ? 1 : 0,
          scm: isShowCommandInfo ? 1 : 0
        }),
      }, {
        text: {
          type: 'plain_text',
          text: stri18n(userLang, 'menu_delete_poll'),
        },
        value: JSON.stringify({action: 'btn_delete', p_id: pollID, user: userId, user_lang: userLang}),
      }
      ],
    },
    {//GRP 1
      label: {
        type: 'plain_text',
        text: stri18n(userLang, 'menu_user_action'),
      },
      options: [{
        text: {
          type: 'plain_text',
          text: stri18n(userLang, 'menu_user_self_vote'),
        },
        value: JSON.stringify({action: 'btn_my_votes', p_id: pollID, user: userId, user_lang: userLang}),
      }, {
        text: {
          type: 'plain_text',
          text: stri18n(userLang, 'menu_command_info'),
        },
        value: JSON.stringify({action: 'btn_command_info', p_id: pollID, user: userId, user_lang: userLang}),
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
          text: stri18n(userLang,'menu_support_contact'),
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
  let addInfo = stri18n(userLang,'info_addon');
  if(isAnonymous&&!isTrueAnonymous) {
    if(addInfo!=="") addInfo += "\n";
    addInfo+=stri18n(userLang,'info_anonymous_notice')
  }
  if(addInfo!=="")
  {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: addInfo,
      }],
    });
  }
  blocks.push({
    type: 'divider',
  });


  for (let i in options) {
    let option = options[i];
    let btn_value = JSON.parse(JSON.stringify(button_value));
    btn_value.id = i;

    blocks.push(buildVoteBlock(btn_value, option, isCompactUI, isShowDivider, isShowNumberInChoice, isShowNumberInChoiceBtn));

    if(!isCompactUI) {
      let block = {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: btn_value['hidden'] ? stri18n(userLang,'info_wait_reveal') : stri18n(userLang,'info_no_vote'),
          }
        ],
      };
      blocks.push(block);
    }
    if(isShowDivider) {
      blocks.push({
        type: 'divider',
      });
    }

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
            text: parameterizedString(stri18n(userLang, 'info_need_help'), {email: helpEmail,link:helpLink}),
            //text: `<${helpLink}|`+stri18n(userLang,'info_need_help')+`>`,
          },
          {
            type: 'mrkdwn',
            text: stri18n(userLang,'info_command_source')+' '+cmd,
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
            text: parameterizedString(stri18n(userLang, 'info_need_help'), {email: helpEmail,link:helpLink}),
            //text: `<${helpLink}|`+stri18n(userLang,'info_need_help')+`>`,
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
          text: stri18n(userLang,'info_command_source')+' '+cmd,
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

  return {blocks:blocks,poll_id:pollID};
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
  else if ('btn_command_info' === value.action)
    commandInfo(body, client, context, value);
  else if ('btn_users_votes' === value.action)
    usersVotes(body, client, context, value);
  else if ('btn_reveal' === value.action)
    revealOrHideVotes(body, context, value);
  else if ('btn_delete' === value.action)
    deletePoll(body, client, context, value);
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

  const teamConfig = await getTeamOverride(getTeamOrEnterpriseId(body));
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;

  const blocks = [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: parameterizedString(stri18n(appLang, 'menu_support_info'), {email: helpEmail,link:helpLink}),
      //text: stri18n(appLang,'menu_support_info'),
    },
  },
  { type: 'divider' },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: stri18n(appLang,'menu_support_contribute'),
    },
    accessory: {
      type: 'button',
      text: {
        type: 'plain_text',
        text: stri18n(appLang,'menu_support_source'),
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
      text: stri18n(appLang,'menu_support_me'),
    },
    accessory: {
      type: 'button',
      text: {
        type: 'plain_text',
        text: stri18n(appLang,'menu_support_me_buy_coffee'),
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

async function commandInfo(body, client, context, value) {
  const teamConfig = await getTeamOverride(getTeamOrEnterpriseId(context));
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;

  const pollData = await pollCol.findOne({ _id: new ObjectId(value.p_id) });
  let pollCmd = "NOTFOUND";
  let poll_id = value.p_id.toString();
  if(poll_id.length === 0) poll_id = "N/A";
  if (pollData) {
    if(pollData.hasOwnProperty("cmd")) {
      if(pollData.cmd.trim().length > 0) {
        pollCmd = pollData.cmd;
      }
    }
  }

  let createdVia = pollData.cmd_via;
  if(pollData.cmd_via_ref!=null) createdVia += `\nSource ID: ${pollData.cmd_via_ref}`
  if(pollData.cmd_via_note!=null) createdVia += `\nNote: ${pollData.cmd_via_note}`
  if(pollData.cmd_via_ref!=null) createdVia += "\n"+parameterizedString(stri18n(appLang,'task_usage_stop_poll'),{slack_command:slackCommand, poll_id: pollData.cmd_via_ref } );
  let blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: stri18n(appLang,'info_command_source_text'),
      },
    },
    {
      type: 'divider',
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: pollCmd
      },
    },
    {
      type: 'divider',
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "Poll ID: "+poll_id
      },
    },
    {
      type: 'divider',
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "Created via: "+createdVia
      },
    }
  ];

  try {
    const result = await client.views.open({
      token: context.botToken,
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        title: {
          type: 'plain_text',
          text: stri18n(appLang,'menu_command_info'),
        },
        close: {
          type: 'plain_text',
          text: stri18n(appLang,'btn_close'),
        },
        blocks: blocks,
      }
    });
  }
  catch (e) {
    logger.error("Failed to create commandInfo")
    logger.error(e)
    logger.error(e.toString()+"\n"+e.stack);
  }

  return;

}

async function myVotes(body, client, context) {
  if (
    !body.hasOwnProperty('user')
    || !body.user.hasOwnProperty('id')
  ) {
    return;
  }
  const teamConfig = await getTeamOverride( getTeamOrEnterpriseId(body) );
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
      if(value.user_lang!=="" && value.user_lang != null)
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
    logger.error(e);
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
    logger.info('error');
    return;
  }
  const teamConfig = await getTeamOverride(getTeamOrEnterpriseId(body));
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
  if (body.user.id !== value.user) {
    //logger.debug('reject request because not owner');
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

  if(value.hasOwnProperty('anonymous') && value.hasOwnProperty('true_anonymous'))
  {
    if(value.anonymous===true&&value.true_anonymous===true) {
      let mRequestBody = {
        token: context.botToken,
        channel: body.channel.id,
        user: body.user.id,
        attachments: [],
        text: stri18n(appLang,'err_see_all_vote_true_anonymous'),
      };
      await postChat(body.response_url,'ephemeral',mRequestBody);

      return;
    }
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
        if(value.user_lang!=="" && value.user_lang != null)
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
    logger.error(e);
  }
}

async function revealOrHideVotes(body, context, value) {

  let menuAtIndex = 0;
  const teamConfig = await getTeamOverride(getTeamOrEnterpriseId(body));
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
  let isMenuAtTheEnd = gIsMenuAtTheEnd;
  if(value.hasOwnProperty("mte")) isMenuAtTheEnd = toBoolean(value.mte);
  if(value.hasOwnProperty("z_mat")) isMenuAtTheEnd = toBoolean(value.z_mat);
  else if (teamConfig.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = teamConfig.menu_at_the_end;

  let isCompactUI = gIsCompactUI;
  if(value.hasOwnProperty("cui")) isCompactUI = toBoolean(value.cui);
  if(value.hasOwnProperty("z_cp")) isCompactUI = toBoolean(value.z_cp);
  else if (teamConfig.hasOwnProperty("compact_ui")) isCompactUI = teamConfig.compact_ui;

  let isShowDivider = gIsShowDivider;
  if(value.hasOwnProperty("sdv")) isShowDivider = toBoolean(value.sdv);
  if(value.hasOwnProperty("z_div")) isShowDivider = toBoolean(value.z_div);
  else if (teamConfig.hasOwnProperty("show_divider")) isShowDivider = teamConfig.show_divider;
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
    logger.info('error');
    return;
  }

  if (body.user.id !== value.user) {
    //logger.debug('reject request because not owner');
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
    logger.info('Missing `revealed` information on poll');
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
      logger.info(`[Try #${countTry}] Error while attempt to acquire mutex lock.`, e)
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
      //logger.debug(blocks);
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
          if(!isCompactUI) {
            const nextI = ''+(parseInt(i)+1);
            if (blocks[nextI].hasOwnProperty('elements')) {
              blocks[nextI].elements[0].text = newVoters;
            }
          }
          else {
            let choiceNL = blocks[i].text.text.indexOf('\n');
            if(choiceNL===-1) choiceNL = blocks[i].text.text.length;
            const choiceText = blocks[i].text.text.substring(0,choiceNL);
            blocks[i].text.text = `${choiceText}\n${newVoters}`;
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
      logger.error(e);
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
async function deletePoll(body, client, context, value) {
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
    logger.info('error');
    return;
  }

  const teamConfig = await getTeamOverride(getTeamOrEnterpriseId(body));
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;

  try {
    value.channel = {id:body.channel.id};
    value.message = {ts:body.message.ts};
    value.response_url = body.response_url;

    if (body.user.id !== value.user) {
      //logger.debug('reject request because not owner');
      let mRequestBody = {
        token: context.botToken,
        channel: value.channel.id,
        user: body.user.id,
        attachments: [],
        text: stri18n(appLang,'err_delete_other'),
      };
      await postChat(value.response_url,'ephemeral',mRequestBody);
      return;
    }

    await client.views.open({
      token: context.botToken,
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'modal_delete_confirm',
        private_metadata: JSON.stringify(value),
        title: {
          type: 'plain_text',
          text: stri18n(appLang,'menu_title_confirm'),
        },
        submit: {
          type: 'plain_text',
          text: stri18n(appLang,'menu_delete_poll'),
        },
        close: {
          type: 'plain_text',
          text: stri18n(appLang,'btn_cancel'),
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: stri18n(appLang,'menu_are_you_sure'),
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: stri18n(appLang,'task_delete_refer_warn'),
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error(error);
  }

}
async function deletePollConfirm(body, context, value) {
  if (
    !body
    || !body.user
    || !body.user.id
    // || !body.message
    // || !body.message.ts
    // || !body.channel
    // || !body.channel.id
    || !value
  ) {
    logger.info('error');
    return;
  }
  const teamConfig = await getTeamOverride(getTeamOrEnterpriseId(body));
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
  if (body.user.id !== value.user) {
    //logger.debug('reject request because not owner');
    let mRequestBody = {
      token: context.botToken,
      channel: value.channel.id,
      user: body.user.id,
      attachments: [],
      text: stri18n(appLang,'err_delete_other'),
    };
    await postChat(value.response_url,'ephemeral',mRequestBody);
    return;
  }

  let mRequestBody = {
    token: context.botToken,
    channel: value.channel.id,
    ts: value.message.ts,
  };
  await postChat(value.response_url,'delete',mRequestBody);

  if(gIsDeleteDataOnRequest) {
    if(value.hasOwnProperty('p_id')) {
      //delete from database
      pollCol.deleteOne(
          { _id: new ObjectId(value.p_id) }
      );
      votesCol.deleteOne(
          { channel: value.channel.id, ts: value.message.ts }
      );
      closedCol.deleteOne(
          { channel: value.channel.id, ts: value.message.ts }
      );
      hiddenCol.deleteOne(
          { channel: value.channel.id, ts: value.message.ts }
      );
      scheduleCol.deleteMany(
          { poll_id: new ObjectId(value.p_id) }
      );
    }
  }

}

async function closePollById(poll_id) {
  let menuAtIndex = 0;
  try {
    let pollData = await pollCol.findOne({_id: new ObjectId(poll_id)});
    if (!pollData) {
      logger.warn(`Invalid poll_id ${poll_id} on closePollById`);
      return false;
    }
    logger.verbose(`[Schedule_close] poll_id: ${poll_id}`);
    if (pollData.hasOwnProperty('team') &&
        pollData.hasOwnProperty('channel') &&
        pollData.hasOwnProperty('user_id') &&
        pollData.hasOwnProperty('ts')
    ) {
      if (!pollData.team || !pollData.channel || !pollData.user_id | !pollData.ts) {
        logger.warn(`Cannot close poll_id ${poll_id} on closePollById due to incomplete data `);
        await pollCol.updateOne(
            {_id: pollData._id},
            {$set: {schedule_end_active: false}}
        );
        return false;
      }

      const teamConfig = await getTeamOverride(pollData.team);

      //get info from exist poll
      let userLang = null;
      if (pollData.para?.hasOwnProperty('user_lang'))
        if (pollData.para?.user_lang !== "" && pollData.para?.user_lang != null)
          userLang = pollData.para?.user_lang;

      let isAnonymous = false;
      if (pollData.para?.hasOwnProperty('anonymous'))
        if (pollData.para?.anonymous !== "" && pollData.para?.anonymous != null)
          isAnonymous = pollData.para?.anonymous;

      if (userLang == null) {
        userLang = gAppLang;
        if (teamConfig.hasOwnProperty("app_lang")) userLang = teamConfig.app_lang;
      }

      let isMenuAtTheEnd = gIsMenuAtTheEnd;
      if (pollData.para?.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = pollData.para?.menu_at_the_end;
      else if (teamConfig.hasOwnProperty("menu_at_the_end")) isMenuAtTheEnd = teamConfig.menu_at_the_end;

      let isCompactUI = gIsCompactUI;
      if (pollData.para?.hasOwnProperty("compact_ui")) isCompactUI = pollData.para?.compact_ui;
      else if (teamConfig.hasOwnProperty("compact_ui")) isCompactUI = teamConfig.compact_ui;


      //this req conversations.history and *:history scope to read message Retrieve the original message
      //Or just recreate whole thing.
      if (!mutexes.hasOwnProperty(`${pollData.team}/${pollData.channel}/${pollData.ts}`)) {
        mutexes[`${pollData.team}/${pollData.channel}/${pollData.ts}`] = new Mutex();
      }

      let release = null;
      let countTry = 0;
      do {
        ++countTry;

        try {
          release = await mutexes[`${pollData.team}/${pollData.channel}/${pollData.ts}`].acquire();
        } catch (e) {
          logger.info(`[Try #${countTry}] Error while attempt to acquire mutex lock.`, e)
        }
      } while (!release && countTry < 3);

      if (release) {
        try {
          let mBotToken = null;
          const teamInfo = await getTeamInfo(pollData.team);
          if (teamInfo?.bot?.token !== undefined) {
            mBotToken = teamInfo.bot.token;
          } else {
            logger.warn(`[Schedule_close] poll_id: ${poll_id}: Unable to get valid bot token.`);
            await pollCol.updateOne(
                {_id: pollData._id},
                {$set: {schedule_end_active: false}}
            );
            return false;
          }

          const pollView = (await createPollView(pollData.team, pollData.channel, pollData.question, pollData.options, pollData.para?.anonymous ?? false, pollData.para?.limited, pollData.para?.limit, pollData.para?.hidden, pollData.para?.user_add_choice,
              pollData.para?.menu_at_the_end, pollData.para?.compact_ui, pollData.para?.show_divider, pollData.para?.show_help_link, pollData.para?.show_command_info, pollData.para?.true_anonymous, pollData.para?.add_number_emoji_to_choice, pollData.para?.add_number_emoji_to_choice_btn, pollData.schedule_end_ts, pollData.para?.user_lang, pollData.user_id, pollData.cmd, pollData.cmd_via, pollData.cmd_via_ref, pollData.cmd_via_note,
              true,pollData._id));
          let blocks = pollView?.blocks;
          const pollID = pollView?.poll_id;

          if (null === pollView || null === blocks) {
            const errMsg = `[Schedule_close] Failed to recreate poll ch:${pollData.channel} ID:${pollID} CMD:${pollData.cmd}`;
            logger.warn(errMsg);
            await pollCol.updateOne(
                {_id: pollData._id},
                {$set: {schedule_end_active: false}}
            );
            return false;
          }

          //mark schedule_end_active false
          await pollCol.updateOne(
              {_id: pollData._id},
              {$set: {schedule_end_active: false}}
          );

          //close it
          await closedCol.updateOne({
            channel: pollData.channel,
            ts: pollData.ts,
          }, {
            $setOnInsert: { team: pollData.team },
            $set: { closed: true }
          }, {
            upsert: true
          });

          //rebuild vote block
          let poll = null;
          const data = await votesCol.findOne({channel: pollData.channel, ts: pollData.ts});
          if (data === null) {
            await votesCol.insertOne({
              team: pollData.team,
              channel:pollData.channel,
              ts: pollData.ts,
              poll_id: poll_id,
              votes: {},
            });
            poll = {};
          } else {
            poll = data.votes;
          }

          const isHidden = await getInfos(
              'hidden',
              blocks,
              {
                team: pollData.team,
                channel: pollData.channel,
                ts: pollData.ts,
              },
          )

          blocks = await updateVoteBlock(pollData.team,pollData.channel,pollData.ts,blocks,poll,userLang,isHidden,isCompactUI,isMenuAtTheEnd);

          let mRequestBody = {
            token: mBotToken,
            channel: pollData.channel,
            ts: pollData.ts,
            blocks: blocks,
            text: `Poll : ${pollData.question}`,
          };
          const postRes = await postChat("", 'update', mRequestBody);
          if (postRes.status === false) {
            logger.warn("[Schedule_close] Failed to update poll data.");
            logger.warn(postRes);
            //continue;
          }

        } catch (e) {
          logger.warn(`Cannot close poll_id ${poll_id}  `);
          logger.warn(e);
          logger.warn(e.toString() + "\n" + e.stack);
          return false;
        } finally {
          release();
        }
      }//end on release

    } else {
      logger.warn(`Cannot close poll_id ${poll_id} on closePollById due to incomplete data `);
      await pollCol.updateOne(
          {_id: pollData._id},
          {$set: {schedule_end_active: false}}
      );
    }
  } catch (e) {
    logger.error(`UNEXPECTED ERROR in closePollById`);
    logger.error(e);
    logger.error(e.toString() + "\n" + e.stack);
    console.log(e);
    console.trace();
    return false;
  }

}
async function closePoll(body, client, context, value) {
  let menuAtIndex = 0;
  const teamConfig = await getTeamOverride(getTeamOrEnterpriseId(body));
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;

  let isMenuAtTheEnd = gIsMenuAtTheEnd;
  if(value.hasOwnProperty("mte")) isMenuAtTheEnd = toBoolean(value.mte);
  if(value.hasOwnProperty("z_mat")) isMenuAtTheEnd = toBoolean(value.z_mat);
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
    logger.info('error');
    return;
  }
  if (body.user.id !== value.user) {
    //logger.debug('reject request because not owner');
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
      logger.info(`[Try #${countTry}] Error while attempt to acquire mutex lock.`, e)
    }
  } while (!release && countTry < 3);

  if (release) {
    try {
      let isClosed = false
      try {
        const data = await closedCol.findOne({ channel, ts: message.ts });
        if (data === null) {
          await closedCol.insertOne({
            //poll_id: value.p_id,
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

            if(value.hasOwnProperty('user_lang'))
              if(value.user_lang!=="" && value.user_lang != null)
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
              if(value.user_lang!=="" && value.user_lang != null)
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
      logger.error(e);
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

function buildVoteBlock(btn_value, option_text, isCompactUI, isShowDivider, isShowNumberInChoice, isShowNumberInChoiceBtn) {
  let emojiPrefix = "";
  let emojiBthPostfix = "";
  let voteId = parseInt(btn_value.id);
  let userLang = gAppLang;
  if(btn_value.hasOwnProperty('user_lang'))
    if(btn_value['user_lang']!=="" && btn_value['user_lang'] != null)
    userLang = btn_value['user_lang'];
  if(isShowNumberInChoice) emojiPrefix = slackNumToEmoji(voteId+1,userLang)+" ";
  if(isShowNumberInChoiceBtn) emojiBthPostfix = " "+slackNumToEmoji(voteId+1,userLang);
  let compactVoteTxt = "";
  if(isCompactUI) compactVoteTxt = "\n" + (btn_value['hidden'] ? stri18n(userLang,'info_wait_reveal') : stri18n(userLang,'info_no_vote')) ;
  let block = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: emojiPrefix+""+option_text+""+compactVoteTxt,
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

async function updateVoteBlock(team,channel,ts,blocks,poll,userLang,isHidden,isCompactUI,isMenuAtTheEnd) {
  let menuAtIndex = 0;
  if (isMenuAtTheEnd) menuAtIndex = blocks.length - 1;

  // let button_id = 3 + (value.id * 2);
  // let context_id = 3 + (value.id * 2) + 1;
  // let blockBtn = blocks[button_id];
  // let block = blocks[context_id];
  // let voters = value.voters ? value.voters : [];

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
        newVoters = stri18n(userLang, 'info_wait_reveal');
      } else if (poll[val.id].length === 0) {
        newVoters = stri18n(userLang, 'info_no_vote');
      } else {
        newVoters = '';
        for (const voter of poll[val.id]) {
          if (!val.anonymous) {
            newVoters += `<@${voter}> `;
          }
        }

        newVoters += poll[val.id].length + ' ';
        if (poll[val.id].length === 1) {
          newVoters += 'vote';
        } else {
          newVoters += 'votes';
        }
      }

      blocks[i].accessory.value = JSON.stringify(val);
      if (!isCompactUI) {
        const nextI = '' + (parseInt(i) + 1);
        if (blocks[nextI].hasOwnProperty('elements')) {
          blocks[nextI].elements[0].text = newVoters;
        }
      } else {
        let choiceNL = blocks[i].text.text.indexOf('\n');
        if (choiceNL === -1) choiceNL = blocks[i].text.text.length;
        const choiceText = blocks[i].text.text.substring(0, choiceNL);
        blocks[i].text.text = `${choiceText}\n${newVoters}`;
      }
    }
  }

  const infosIndex = blocks.findIndex(el => el.type === 'context' && el.elements)
  blocks[infosIndex].elements = await buildInfosBlocks(
      blocks,
      {
        team: team,
        channel,
        ts: ts,
      },
      userLang
  );
  blocks[menuAtIndex].accessory.option_groups[0].options =
      await buildMenu(blocks, {
        team: team,
        channel,
        ts: ts,
      }, userLang, isMenuAtTheEnd);

  return blocks;
}

function isValidISO8601(inputTS) {
  // Regular expression to check ISO 8601 format
  const regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(.\d+)?([+-]\d{2}:\d{2}|Z)?$/;

  if (regex.test(inputTS)) {
    // Check if the date is valid
    const date = new Date(inputTS);
    return !isNaN(date.getTime());
  } else {
    return false;
  }
}

async function getAndlocalizeTimeStamp(botToken, userId, mongoDateObject) {
  //const timeFormat = 'ddd MMM DD YYYY HH:mm:ss [GMT]ZZ';
  //const iso8601Format = 'YYYY-MM-DDTHH:mm:ssZ'; // ISO 8601 format
  const timeFormat = gAppDatetimeFormat;
  if (botToken == null || botToken === "" || userId == null || userId === "") return moment(mongoDateObject).format(timeFormat);
  try {
    const userInfo = await app.client.users.info({
      token: botToken,
      user: userId
    });

    //`Your time zone is: ${userInfo?.user?.tz} (${userInfo?.user?.tz_label}, Offset: ${userInfo?.user?.tz_offset} seconds)`
    return localizeTimeStamp(userInfo?.user?.tz,  mongoDateObject);
  } catch (e) {
    return moment(mongoDateObject).format(timeFormat);
  }
}

function localizeTimeStamp(tz,  mongoDateObject) {
  //const timeFormat = 'ddd MMM DD YYYY HH:mm:ss [GMT]ZZ';
  //const iso8601Format = 'YYYY-MM-DDTHH:mm:ssZ'; // ISO 8601 format
  const timeFormat = gAppDatetimeFormat;
  if(mongoDateObject==null) return null;
  if(tz===null||tz===undefined) return moment(mongoDateObject).format(timeFormat);
  try {
    return moment(mongoDateObject).tz(tz).format(timeFormat) + ` (${tz})`;
  } catch (e) {
    return moment(mongoDateObject).format(timeFormat);
  }
}

function getIANATimezoneFromISO8601(isoString) {
  // Parse the ISO 8601 string
  const momentDate = moment.parseZone(isoString);

  // Get the timezone offset in hours and minutes
  const offset = momentDate.format('Z'); // e.g., +02:00

  // Optional: Convert offset to IANA timezone name
  // Note: This might not always be accurate
  const ianaTimezones = moment.tz.names();
  const matchingTimezone = ianaTimezones.find(tz => {
    return moment.tz(tz).format('Z') === offset;
  });

  return matchingTimezone || offset; // returns IANA timezone name or the offset
}

function convertHoursToString(hourNumber) {
  // Extract whole hours
  let hours = Math.floor(hourNumber);

  // Convert fractional hours to minutes
  let minutes = Math.round((hourNumber - hours) * 60);

  // Adjust for when minutes round to 60
  if (minutes === 60) {
    hours += 1;
    minutes = 0;
  }

  // Format the string
  return `${hours}:${minutes.toString().padStart(2, '0')}`;
}


function toBoolean(value) {
  return (value === 1 || value === true);
}

function getSupportDoubleQuoteToStr() {
  return acceptedQuotes.map(item => `\`${item}\``).join(' ');
}

//hasNestedProperty(objData, 'key1.key2.key3')
function hasNestedProperty(obj, propertyPath) {
  let properties = propertyPath.split('.');
  let currentObject = obj;

  for (let i = 0; i < properties.length; i++) {
    let property = properties[i];
    if (!currentObject || !currentObject.hasOwnProperty(property)) {
      return false;
    }
    currentObject = currentObject[property];
  }

  return true;
}