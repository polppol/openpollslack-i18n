const { App, ExpressReceiver, LogLevel } = require('@slack/bolt');

// --- Config self-heal ---------------------------------------------------
// node-config loads config/default.json eagerly when required, and any
// config.get('x') for a missing key throws and crashes startup. That makes
// every new config key a hard upgrade for self-hosters: they have to merge
// the new key into their default.json before the app will boot.
//
// To avoid that, we run a one-time heal pass BEFORE requiring 'config':
// for every key present in config/default.json.dist (which always ships
// with the source) but absent in the user's config/default.json, we copy
// the .dist default into default.json and log a warning. The healed file
// is what node-config then reads, so config.get(...) works everywhere.
//
// .dist is the SSOT for "what keys are expected"; default.json is the
// per-deployment override file. We never touch values that are already set.
(function selfHealConfig() {
  const fs = require('node:fs');
  const path = require('node:path');
  const cfgDir = path.join(__dirname, 'config');
  const cfgPath = path.join(cfgDir, 'default.json');
  const distPath = path.join(cfgDir, 'default.json.dist');

  if (!fs.existsSync(cfgPath) || !fs.existsSync(distPath)) {
    // Either the operator hasn't run initial setup yet, or .dist is missing
    // (shouldn't happen in a clean checkout). Don't synthesise a config from
    // thin air - but DO say what's wrong, because node-config's own error
    // ('property "port" is not defined') doesn't mention the fix.
    if (!fs.existsSync(cfgPath) && fs.existsSync(distPath)) {
      console.error('[ConfigHeal] config/default.json not found. Copy config/default.json.dist to config/default.json and fill in your Slack credentials (see self_host.md).');
    }
    return;
  }
  let current, distDefaults;
  try {
    current = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    distDefaults = JSON.parse(fs.readFileSync(distPath, 'utf8'));
  } catch (e) {
    console.error('[ConfigHeal] Failed to read/parse config files:', e.message);
    return;
  }

  const added = [];
  for (const key of Object.keys(distDefaults)) {
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      current[key] = distDefaults[key];
      added.push(key);
    }
  }
  if (added.length === 0) return;

  try {
    // Preserve 2-space indent + trailing newline to match the .dist style
    // and keep diffs minimal for operators.
    fs.writeFileSync(cfgPath, JSON.stringify(current, null, 2) + '\n', 'utf8');
    console.warn(
      `[ConfigHeal] Added ${added.length} missing config key(s) to config/default.json with .dist defaults: ${added.join(', ')}. ` +
      `Review and customise as needed.`
    );
  } catch (e) {
    console.error('[ConfigHeal] Failed to write back to config/default.json:', e.message);
  }
})();

const config = require('config');

const { MongoClient, ObjectId } = require('mongodb');

const { Migrations } = require('./utils/migrations');

const { Mutex } = require('async-mutex');

const { isValidISO8601 } = require('./src/util/iso');
const { getTeamOrEnterpriseId } = require('./src/util/teamId');
const { acceptedQuotes, standardQuote, getSupportDoubleQuoteToStr } = require('./src/util/quotes');
const { convertHoursToString, toBoolean, parseBooleanToken } = require('./src/util/format');
const { parseNextRun, humanizeCron, auditSchedules } = require('./src/util/cron');
const { richTextToMrkdwn, mrkdwnToRichText, readInputAsMrkdwn } = require('./src/util/richtext');
const { langDict, langList, parameterizedString, stri18n, slackNumToEmoji, loadLanguages } = require('./src/i18n');

// Multi-question polls ("forms") — self-contained, additive, backward-compatible.
// Legacy single-question polls never enter this module (it owns its own mq_* ids).
const mq = require('./src/multiquestion');

const cron = require('node-cron');

const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file'); // side-effect: registers transports.DailyRotateFile
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
//const moment = require('moment');
const moment = require('moment-timezone');

const { v4: uuidv4 } = require('uuid');

const port = config.get('port');
const signing_secret = config.get('signing_secret');
const slackCommand = config.get('command');
const slackCommand2 = config.get('command2');
const helpLink = config.get('help_link');
const helpEmail = config.get('help_email');
const supportUrl = config.get('support_url');
// "Open in dashboard" link (optional integration with the openpollslack-dash
// analytics dashboard). dashboard_url is the PUBLIC base of the dashboard's
// viewer surface; when a poll creator/installer picks "View on dashboard" the
// app mints a short-lived HMAC token (signed with dashboard_link_secret, which
// MUST equal the dashboard's slack_handoff.secret) and DMs them an ephemeral
// link. SERVER-LEVEL ONLY (a per-workspace URL is useless — only the dashboard
// that reads this same DB can serve it). The MENU is disabled by default
// (show_dashboard_link=false) and never renders unless url + secret are both set.
const gDashboardUrl = config.has('dashboard_url') ? config.get('dashboard_url') : '';
const gDashboardLinkSecret = config.has('dashboard_link_secret') ? config.get('dashboard_link_secret') : '';
const gDashboardLinkTtlS = config.has('dashboard_link_ttl_s') ? parseInt(config.get('dashboard_link_ttl_s'), 10) : 300;
const gIsShowDashboardLink = config.has('show_dashboard_link') ? config.get('show_dashboard_link') : false;
const gIsShowCsvExport = config.has('show_csv_export') ? config.get('show_csv_export') : true;
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
// How to deliver system/error notices to the acting user: 'both' (a modal popup AND the
// in-channel ephemeral — the default, so a missed ephemeral is still surfaced), 'modal'
// (modal only; falls back to ephemeral when no fresh trigger is available), or 'text'
// (ephemeral only — the original behavior). Invalid/absent → 'both'. Workspace-overridable.
// config.has guard so adding this key never crashes a config that lacks it.
const normNotifyMethod = (v) => (v === 'modal' || v === 'text' || v === 'both') ? v : 'both';
const gAppUserNotificationMethod = normNotifyMethod(config.has('app_user_notification_method') ? config.get('app_user_notification_method') : 'both');
const gLogLevelApp = config.get('log_level_app');
const gLogLevelAppFile = config.get('log_level_app_file');
const gLogLevelBolt = config.get('log_level_bolt');
const gLogLevelBoltFile = config.get('log_level_bolt_file');
const gLogToFile = config.get('log_to_file');
const gLogMaxFiles = config.has('log_max_files') ? config.get('log_max_files').toString() : '30d';
const gScheduleLimitHr = config.get('schedule_limit_hrs');
const gScheduleMaxRun = parseInt(config.get('schedule_max_run'));
const gScheduleAutoDeleteDay = config.get('schedule_auto_delete_invalid_day');
const gDisplayPollerName = config.get('display_poller_name');
const gEnablePollEdit = config.has('enable_poll_edit') ? config.get('enable_poll_edit') : true;
const gEnablePollEditMaxMins = config.has('enable_poll_edit_max_mins') ? parseInt(config.get('enable_poll_edit_max_mins'), 10) : 60;
const gEnablePollEditKeepVotes = config.has('enable_poll_edit_keep_votes') ? config.get('enable_poll_edit_keep_votes') : true;
// Kill-switch flag for the rich_text_input modal migration. Default false so
// existing tenants see no behavior change. Per-team override via
// `/poll config write enable_rich_text_input true|false`. When false, the
// /poll modal renders the original plain_text_input elements; when true, it
// renders rich_text_input + the converters in src/util/richtext.js bridge to
// the same mrkdwn-string storage shape (DB schema unchanged).
const gIsRichTextInput = config.has('enable_rich_text_input') ? config.get('enable_rich_text_input') : false;

const validTeamOverrideConfigTF = ["create_via_cmd_only","app_lang_user_selectable","menu_at_the_end","compact_ui","show_divider","show_help_link","show_command_info","true_anonymous","add_number_emoji_to_choice","add_number_emoji_to_choice_btn","delete_data_on_poll_delete","app_allow_dm","display_poller_name","enable_poll_edit","enable_poll_edit_keep_votes","enable_rich_text_input","show_dashboard_link","show_csv_export"];

// Integer-valued team overrides. Separate from the true/false list so the
// /poll config write dispatcher knows to parse the value as a non-negative
// integer rather than a boolean.
const validTeamOverrideConfigInt = ["enable_poll_edit_max_mins"];

// SSOT map key -> current server default, used by `/poll config read|list`
// and `/poll config reset` so the displayed effective values can never drift
// from the write validators above. Function (not literal) so it always
// reflects the g* constants resolved at startup.
const serverDefaultsForConfig = () => ({
  app_lang: gAppLang,
  create_via_cmd_only: gIsViaCmdOnly,
  app_lang_user_selectable: gIsAppLangSelectable,
  menu_at_the_end: gIsMenuAtTheEnd,
  compact_ui: gIsCompactUI,
  show_divider: gIsShowDivider,
  show_help_link: gIsShowHelpLink,
  show_command_info: gIsShowCommandInfo,
  true_anonymous: gTrueAnonymous,
  add_number_emoji_to_choice: gIsShowNumberInChoice,
  add_number_emoji_to_choice_btn: gIsShowNumberInChoiceBtn,
  delete_data_on_poll_delete: gIsDeleteDataOnRequest,
  app_allow_dm: gAppAllowDM,
  display_poller_name: gDisplayPollerName,
  enable_poll_edit: gEnablePollEdit,
  enable_poll_edit_keep_votes: gEnablePollEditKeepVotes,
  enable_rich_text_input: gIsRichTextInput,
  show_dashboard_link: gIsShowDashboardLink,
  show_csv_export: gIsShowCsvExport,
  enable_poll_edit_max_mins: gEnablePollEditMaxMins,
  app_user_notification_method: gAppUserNotificationMethod,
});

// SSOT for "is /poll edit allowed?" — server flag is the default, team override
// (if set) wins. Used by the menu builder, CLI subcommand, modal opener, and
// view-submission handler so a single setting governs every entry point.
function isPollEditEnabled(teamConfig) {
  if (teamConfig && teamConfig.hasOwnProperty('enable_poll_edit')) {
    return toBoolean(teamConfig.enable_poll_edit);
  }
  return toBoolean(gEnablePollEdit);
}

// Resolve the effective "edit allowed for N minutes since posting" value:
// team override wins over the server default. 0 means "no time limit".
// Negatives or NaN fall back to the server default to avoid accidental
// hard-locks from a malformed override.
function getPollEditMaxMins(teamConfig) {
  let raw;
  if (teamConfig && teamConfig.hasOwnProperty('enable_poll_edit_max_mins')) {
    raw = teamConfig.enable_poll_edit_max_mins;
  } else {
    raw = gEnablePollEditMaxMins;
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return Number.isFinite(gEnablePollEditMaxMins) && gEnablePollEditMaxMins >= 0 ? gEnablePollEditMaxMins : 60;
  return n;
}

// Vote-preservation policy. When true (default), an option whose text is
// reworded at the same position keeps its existing votes — voters don't
// lose their tally over a typo fix. When false, any text change at a
// position resets the votes for that position. Either way, options whose
// text matches across the edit (even at a different position) keep their
// votes via text-matching in rebuildVoteMap.
function isEditKeepVotes(teamConfig) {
  if (teamConfig && teamConfig.hasOwnProperty('enable_poll_edit_keep_votes')) {
    return toBoolean(teamConfig.enable_poll_edit_keep_votes);
  }
  return toBoolean(gEnablePollEditKeepVotes);
}

// ── "Open in dashboard" link (optional openpollslack-dash integration) ───────
// SSOT for whether the per-poll menu shows the built-in CSV export and the
// external "View on dashboard" link. The server flag is the default; a
// per-workspace boolean override wins. The dashboard link additionally requires
// the server to be configured with a URL + signing secret, so it never renders a
// dead link (and stays hidden by default).
function isShowCsvExport(teamConfig) {
  if (teamConfig && teamConfig.hasOwnProperty('show_csv_export')) {
    return toBoolean(teamConfig.show_csv_export);
  }
  return toBoolean(gIsShowCsvExport);
}
function isShowDashboardLink(teamConfig) {
  if (!gDashboardUrl || !gDashboardLinkSecret) return false;
  if (teamConfig && teamConfig.hasOwnProperty('show_dashboard_link')) {
    return toBoolean(teamConfig.show_dashboard_link);
  }
  return toBoolean(gIsShowDashboardLink);
}

// Mint a short-lived HMAC token for the dashboard "open in dashboard" handoff.
// The format MUST match openpollslack-dash src/handoff.js verify():
//   b64url(JSON payload) + "." + b64url(HMAC-SHA256(payloadB64, secret))
// The payload carries identity + intent ONLY (who clicked / which poll / when);
// the dashboard re-derives all authorization from the shared DB.
function mintDashboardToken(pid, uid, tid) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Number.isFinite(gDashboardLinkTtlS) && gDashboardLinkTtlS > 0 ? gDashboardLinkTtlS : 300;
  const payload = { v: 1, pid: String(pid), uid: String(uid), tid: String(tid), iat: now, exp: now + ttl, jti: crypto.randomBytes(12).toString('hex') };
  const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payloadB64 = b64url(JSON.stringify(payload));
  const sigB64 = b64url(crypto.createHmac('sha256', gDashboardLinkSecret).update(payloadB64).digest());
  return `${payloadB64}.${sigB64}`;
}

// Re-key a vote map across an option-list edit. Returns:
//   { newPoll, droppedCount }
//
// Algorithm:
//   Pass 1 (always): exact-text match. For each new option, find an
//   unmatched old option with the same text and inherit its votes. This
//   handles add / remove / reorder correctly: an option keeps its votes
//   wherever it ends up in the new list, and a removed option's votes
//   are dropped.
//
//   Pass 2 (only if keepVotesOnRename=true): positional fallback for new
//   positions still without votes. If old[i] and new[i] are both unmatched
//   after pass 1, the new[i] inherits old[i]'s votes — preserving votes
//   through pure renames at the same position.
//
//   When keepVotesOnRename=false, pass 2 is skipped: a position whose text
//   changed gets a fresh empty vote list.
//
// droppedCount counts old positions that had voters but didn't match
// anywhere in the new options (effectively lost from the user POV).
// Canonicalize a stored mrkdwn string through the current converter pair so
// strings written under OLDER normalization rules (pre-2026-06 link escaping,
// single-marker multi-line styles) compare equal to freshly-submitted text.
// Falls back to the raw string if the converters reject the input.
function canonMrkdwn(s) {
  try {
    return richTextToMrkdwn(mrkdwnToRichText(String(s ?? '')));
  } catch (e) {
    return String(s ?? '');
  }
}

function rebuildVoteMap(oldOptions, newOptions, oldPoll, keepVotesOnRename) {
  oldOptions = oldOptions || [];
  newOptions = newOptions || [];
  oldPoll = oldPoll || {};
  const newPoll = {};
  const matchedOldIdx = new Set();
  // Compare on canonical form: legacy options stored under older mrkdwn
  // normalization must still exact-match their unchanged re-submission, or
  // votes would be silently treated as "reworded" and dropped.
  const oldCanon = oldOptions.map(canonMrkdwn);
  const newCanon = newOptions.map(canonMrkdwn);

  // Pass 1: exact text match.
  for (let i = 0; i < newOptions.length; i++) {
    for (let j = 0; j < oldOptions.length; j++) {
      if (matchedOldIdx.has(j)) continue;
      if (oldCanon[j] === newCanon[i]) {
        newPoll[String(i)] = (oldPoll[String(j)] || []).slice();
        matchedOldIdx.add(j);
        break;
      }
    }
  }

  // Pass 2: positional fallback for renames.
  for (let i = 0; i < newOptions.length; i++) {
    if (newPoll.hasOwnProperty(String(i))) continue;
    if (keepVotesOnRename && i < oldOptions.length && !matchedOldIdx.has(i)) {
      newPoll[String(i)] = (oldPoll[String(i)] || []).slice();
      matchedOldIdx.add(i);
    } else {
      newPoll[String(i)] = [];
    }
  }

  let droppedCount = 0;
  for (let j = 0; j < oldOptions.length; j++) {
    const oldVotes = oldPoll[String(j)] || [];
    if (!matchedOldIdx.has(j) && oldVotes.length > 0) droppedCount++;
  }

  return { newPoll, droppedCount };
}

// Time-window guard, paired with isPollEditEnabled. Returns:
//   { ok: true }                — within window (or window disabled)
//   { ok: false, maxMins }      — past the window; caller surfaces maxMins
//                                 in the rejection message.
// Measures from pollData.ts (Slack message ts), which is when the poll
// became visible in the channel. Scheduled polls only set ts after they
// post, so the window correctly starts from posting time, not creation.
function isWithinEditWindow(pollData, teamConfig) {
  const maxMins = getPollEditMaxMins(teamConfig);
  if (maxMins === 0) return { ok: true };
  const tsNum = parseFloat(pollData?.ts);
  if (!Number.isFinite(tsNum) || tsNum <= 0) return { ok: true }; // be permissive if ts is malformed
  const ageMs = Date.now() - tsNum * 1000;
  if (ageMs <= maxMins * 60 * 1000) return { ok: true };
  return { ok: false, maxMins };
}

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

// Periodic cleanup of mutexes whose lock has been fully released. The map is
// keyed on `${team}/${channel}/${ts}` and would otherwise grow unbounded as
// every poll the bot ever interacts with leaves an entry behind. This is
// race-free in Node's single-threaded model: the synchronous isLocked() check
// and the synchronous delete cannot be interrupted by another async caller,
// and any new acquirer that arrives later simply gets a fresh Mutex via the
// existing `if (!mutexes.hasOwnProperty(key))` guard at every call site.
setInterval(() => {
  try {
    let removed = 0;
    for (const key of Object.keys(mutexes)) {
      if (typeof mutexes[key]?.isLocked === 'function' && !mutexes[key].isLocked()) {
        delete mutexes[key];
        removed++;
      }
    }
    if (removed > 0) {
      // Use console here because logger may not be initialised yet at very
      // early ticks; once the logger is up, we'd see this via the same
      // colorize transport. Either way it's diagnostic.
      console.log(`[MutexGC] Released ${removed} idle mutex(es); ${Object.keys(mutexes).length} active.`);
    }
  } catch (e) {
    console.error('[MutexGC] cleanup failed:', e);
  }
}, 60 * 60 * 1000).unref(); // hourly; .unref() so it doesn't keep process alive

// Resolve a stored render setting with a stable fallback chain:
// pollData.para -> teamConfig -> server default. Used by paths that rebuild
// a poll's blocks (applyPollEdit, closePollById) so the same value is passed
// to both createPollView (which builds the layout) and updateVoteBlock
// (which writes vote tallies into structurally-significant slots like the
// menu block index and per-choice context blocks). A divergence here causes
// silent corruption — see commit f0239e8.
function resolveFromPara(pollData, teamConfig, key, serverDefault) {
  if (pollData?.para?.hasOwnProperty(key)) return pollData.para[key];
  if (teamConfig?.hasOwnProperty?.(key)) return teamConfig[key];
  return serverDefault;
}

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

// Logger-level normaliser: object payloads render as JSON (instead of
// '[object Object]') and Error objects keep their stack on EVERY transport -
// including the file transports, which carry no format of their own.
const stringifyObjects = format((info) => {
  if (info.message !== null && typeof info.message === 'object') {
    try { info.message = JSON.stringify(info.message, null, 4); }
    catch (e) { info.message = String(info.message); }
  }
  return info;
});

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
    fs.mkdirSync(gLogDir, { recursive: true });
  }

  // Sync directory writability check — must be sync because the result has
  // to be known BEFORE we construct the winston loggers below. The rotating
  // transport stamps its own dated filenames at rollover, so only the
  // directory can be pre-checked.
  const _isLogDirWritable = (dir) => {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    } catch (err) {
      console.error(`Log dir '${dir}' is not writable, SKIP LOG TO FILE!`, err.message);
      return false;
    }
  };

  if (_isLogDirWritable(gLogDir)) {
    // Daily rotation with retention (config key log_max_files, default 30d).
    // Filenames keep the historical YYYY-MM-DD_app.log shape, but the date
    // now re-stamps at midnight instead of freezing at boot time, and old
    // files are pruned instead of accumulating forever.
    appTransportsArray.push(new transports.DailyRotateFile({
      dirname: gLogDir,
      filename: '%DATE%_app.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: gLogMaxFiles,
    }));
    boltTransportsArray.push(new transports.DailyRotateFile({
      dirname: gLogDir,
      filename: '%DATE%_bolt.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: gLogMaxFiles,
    }));
  }
}

const logger = createLogger({
  level: gLogLevelAppFile,
  format: format.combine(
      format.errors({ stack: true }),
      stringifyObjects(),
      format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
      }),
      format.printf(info => `${info.timestamp} ${info.level}[App]: ${info.message}${info.stack ? `\n${info.stack}` : ''}`)
  ),
  transports: appTransportsArray
});

const loggerBolt = createLogger({
  level: gLogLevelBoltFile,
  format: format.combine(
      format.errors({ stack: true }),
      stringifyObjects(),
      format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
      }),
      format.printf(info => `${info.timestamp} ${info.level}[Bolt]: ${info.message}${info.stack ? `\n${info.stack}` : ''}`)
  ),
  transports: boltTransportsArray
});

logger.info('Server starting...');

try {
  // mClient.connect() is awaited inside the startup IIFE below so a failed
  // connection surfaces at startup instead of on the first user request.
  // The driver auto-connects on first op anyway, so the synchronous handle
  // assignments here don't actually do I/O.
  const db = mClient.db(config.get('mongo_db_name'));
  orgCol = db.collection('token');
  userCol = db.collection('user_config');
  votesCol = db.collection('votes');
  closedCol = db.collection('closed');
  hiddenCol = db.collection('hidden');
  pollCol = db.collection('poll_data');
  scheduleCol = db.collection('poll_schedule');
  // Wire the multi-question module to the same DB handle + a resolver so forms
  // respect each team's config defaults (language + true-anonymous), like the
  // single-question modal does.
  mq.init(db, {
    slackCommand,
    // Reuse the single-question poll's response_url posting so forms can post to the
    // command's channel without the bot being a member. postChat is a thunk because it's
    // declared later in this file (avoids the const TDZ at this call site).
    isUseResponseUrl,
    postChat: (url, type, requestBody) => postChat(url, type, requestBody),
    botName,
    // Reuse the single-question poll's per-message in-process mutex so the lazy
    // votes-doc create (response_url mode) is serialized — no duplicate votes docs
    // under concurrent first-interactions. Same key shape btn_vote uses.
    lock: async (key) => { if (!mutexes.hasOwnProperty(key)) mutexes[key] = new Mutex(); return await mutexes[key].acquire(); },
    // System notice routing (app_user_notification_method: both/modal/text) —
    // mirrors the single-poll path. mq passes (body, token, text, lang).
    notify: (body, token, text, lang) => notifyUser(body, { botToken: token }, text, lang),
    resolveTeamDefaults: async (teamId) => {
      let tc = {};
      try { tc = await getTeamOverride(teamId) || {}; } catch (e) { tc = {}; }
      const pick = (k, g) => (tc.hasOwnProperty(k) ? tc[k] : g);
      return {
        app_lang: pick('app_lang', gAppLang),
        app_lang_user_selectable: pick('app_lang_user_selectable', gIsAppLangSelectable),
        true_anonymous: pick('true_anonymous', gTrueAnonymous),
        menu_at_the_end: pick('menu_at_the_end', gIsMenuAtTheEnd),
        show_command_info: pick('show_command_info', gIsShowCommandInfo),
        show_dashboard_link: pick('show_dashboard_link', gIsShowDashboardLink),
        display_poller_name: pick('display_poller_name', gDisplayPollerName),
        delete_data_on_poll_delete: pick('delete_data_on_poll_delete', gIsDeleteDataOnRequest),
      };
    },
    // Reuse the single-question poll's "View on dashboard" flow for forms.
    dashboardLinkAction: (body, client, context, value) => dashboardLinkAction(body, client, context, value),
  });

  migrations = new Migrations(db);
} catch (e) {
  mClient.close();
  logger.error(e)
  logger.error(e.toString()+"\n"+e.stack);
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
  // Indexes that accelerate the read-only analytics dashboard's filtered reads
  // (team/creator/date drilldowns + recurring-series grouping). Background +
  // idempotent; tiny write overhead on poll_data. The app itself also benefits
  // from team/created_ts lookups. cmd_via_ref groups a scheduled template's
  // reposted instances (cmd_via='task_schedule').
  pollCol.createIndex({ team: 1 }, { background: true });
  pollCol.createIndex({ user_id: 1 }, { background: true });
  pollCol.createIndex({ created_ts: 1 }, { background: true });
  pollCol.createIndex({ team: 1, created_ts: 1 }, { background: true });
  pollCol.createIndex({ cmd_via_ref: 1 }, { background: true });
  scheduleCol.createIndex({ poll_id: 1, next_ts: 1, is_enable: 1, is_done: 1   });
  scheduleCol.createIndex({ next_ts: 1, is_enable: 1 , is_done: 1  });
}

loadLanguages(logger, gAppLang);

logger.info('Init cron jobs...');

// Thin wrapper kept for legacy call sites; delegates to the cron SSOT in
// src/util/cron.js so parsing behaviour stays consistent across the app.
function calculateNextScheduleTime(cronString, timeZoneString) {
  return parseNextRun(cronString, timeZoneString);
}

// Best-effort scheduler DM to the poll owner. Centralised so every terminal
// schedule state (disabled, failed, done) notifies through one path.
async function notifyScheduleOwner(botToken, ownerId, allowDM, text) {
  if (text == null || text === '' || ownerId == null || botToken == null || !allowDM) return;
  try {
    await postChat("", 'post', { token: botToken, channel: ownerId, text: text });
  } catch (e) {
    logger.error("Can not send DM, you might not enable Bot Messages Tab in Slack App!");
  }
}

// Poll ids with a close currently in flight - stops an overlapping tick (or
// the startup run) from launching closePollById twice for the same poll.
const closeInFlight = new Set();

// Renders one row for `/poll schedule list*` - skips absent fields instead
// of printing literal 'undefined'/'null' for fresh schedules.
const formatScheduleListItem = (item, myTz, includeOwner) => {
  let s = "```";
  s += `Poll ID: ${item.poll_id}\n`;
  if (includeOwner) s += `Owner: ${item.created_user_id}\n`;
  s += `Next Run: ` + localizeTimeStamp(myTz, item.next_ts) + `\n`;
  if (item.cron_string) {
    const cronHumanRaw = humanizeCron(item.cron_string);
    s += `Cron Expression: ${item.cron_string} (${cronHumanRaw ? cronHumanRaw + ", " : ""}${item.tz ?? 'UTC'} Time Zone)\n`;
  }
  s += `Enable: ${item.is_enable}\n`;
  if (item.poll_ch) s += `Override CH: ${item.poll_ch}\n`;
  if (item.pollData?.cmd) s += `CMD : ${item.pollData.cmd}\n`;
  s += `Run Counter : ${item.run_counter ?? 0}/${item.run_max ?? gScheduleMaxRun}\n`;
  if (item.last_error_text) {
    s += `Last Error : ${item.last_error_text}\n`;
    if (item.last_error_ts) s += `Last Error TS : ` + localizeTimeStamp(myTz, item.last_error_ts) + `\n`;
  }
  s += "```\n";
  return s;
};

const checkAndExecuteTasks = async () => {
  const currentDateTime = new Date();
  try {
    // Reconcile stranded claims: a crash between the claim (is_done:true)
    // and the re-arm/disable would otherwise leave a row no query ever
    // touches again. Anything still claimed 15+ minutes after its run
    // started was interrupted - disable it so cleanup, delete_done and the
    // schedule list regain visibility.
    const strandedRes = await scheduleCol.updateMany(
        {
          is_done: true,
          is_enable: true,
          last_run_ts: { $lt: new Date(currentDateTime.getTime() - 15 * 60 * 1000) },
          next_ts: { $lte: currentDateTime },
        },
        { $set: { is_enable: false, last_error_ts: new Date(), last_error_text: 'Stranded by an interrupted run (process restart mid-task). Re-create the schedule if still needed.' } }
    );
    if (strandedRes?.modifiedCount > 0) {
      logger.warn(`[Schedule] Disabled ${strandedRes.modifiedCount} stranded schedule row(s) (claimed but never re-armed).`);
    }

    const pendingTasks = await scheduleCol.find({
      next_ts: { $lte: currentDateTime },
      is_enable: true,
      is_done: false,
    }).toArray();

    for (const task of pendingTasks) {
      // Blast shield: no single task - via any code path - may abort the tick
      // for the other teams' schedules. (Indentation of the pre-existing body
      // is left untouched to keep the diff reviewable.)
      try {
      logger.debug(`[Schedule] processing poll_id: ${task.poll_id}.`);

      // Claim this run atomically BEFORE any I/O so an overlapping tick (or a
      // second process) can never double-post the same schedule row.
      const claimed = await scheduleCol.findOneAndUpdate(
          { _id: task._id, is_done: false },
          { $set: { is_done: true, last_run_ts: new Date() } }
      );
      if (!claimed) {
        logger.verbose(`[Schedule] poll_id: ${task.poll_id} already claimed by another tick - skipping.`);
        continue;
      }

      let calObjId = null;
      let pollData = null;
      let pollCh = null;

      let dmOwnerString = null;

      try {
        calObjId = new ObjectId(task.poll_id);
        pollData = await pollCol.findOne({ _id: calObjId  });
      }
      catch (e) { }

      if (!pollData) {
        // Source poll deleted: disable instead of zombie-firing every period.
        logger.verbose(`[Schedule] poll_id: ${task.poll_id}: source poll no longer exists. Disabling schedule.`);
        await scheduleCol.updateOne(
            { _id: task._id },
            { $set: { is_enable: false, last_error_ts: new Date(), last_error_text: 'Source poll deleted' } }
        );
        continue;
      }

      let isPollValid = true;
      let mBotToken = null;
      let mTaskOwner = null;
      let postOk = false;
      let lastFailReason = null;

      let appLang= gAppLang;
      let isAppAllowDM = gAppAllowDM;
      if(pollData?.team !== "" && pollData?.team != null) {
        const teamConfig = await getTeamOverride(pollData?.team);
        if (teamConfig.hasOwnProperty("app_allow_dm")) isAppAllowDM = teamConfig.app_allow_dm;
        if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
      }

      if(task.hasOwnProperty('created_user_id')) mTaskOwner = task.created_user_id;

      // User DM preference is needed by every terminal branch below, so it is
      // resolved up front (it used to be fetched only after the posting block).
      let isUserAllowDM = isAppAllowDM;
      if(pollData?.team !== null && mTaskOwner !== null) {
        let uConfig = await getUserConfig(pollData?.team??null,mTaskOwner??null);
        if(uConfig?.config?.hasOwnProperty('user_allow_dm')) {
          isUserAllowDM = uConfig.config.user_allow_dm;
        }
      }

      // Owner-facing "this schedule was turned off" notice (i18n).
      const disabledNoti = (reason) => parameterizedString(stri18n(appLang, 'task_scheduled_disabled_noti'), { poll_id: task.poll_id, reason: reason ?? '' });

      let taskRunCounter = 1;
      let taskRunMax = gScheduleMaxRun;
      if(task.hasOwnProperty('run_counter')) taskRunCounter = task.run_counter + 1;
      if(task.hasOwnProperty('run_max')) taskRunMax = Math.min(task.run_max,gScheduleMaxRun);
      let cmdNote = parameterizedString(stri18n(appLang, 'task_run_counter_note'), { current: taskRunCounter, max: taskRunMax });

      { // pollData is guaranteed non-null here (checked above); block kept so
        // the body's existing closing brace stays balanced.
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
          // Tell the owner the schedule is dead instead of disabling silently
          // (no-op when the bot token could not be resolved).
          await notifyScheduleOwner(mBotToken, mTaskOwner, isUserAllowDM, disabledNoti(errMsg));
          continue;
        }


        if(task.hasOwnProperty('poll_ch')) {
          if(task.poll_ch !== "" && task.poll_ch != null ) {
            pollCh = task.poll_ch;
          }
        }


        logger.verbose(`[Schedule] Executing task for poll_id: ${task.poll_id} to CH:${pollCh} ${cmdNote}`);
        try {
          const pollView = (await createPollView(pollData.team, pollCh, null, pollData.question, pollData.options, pollData.para?.anonymous??false, pollData.para?.limited, pollData.para?.limit, pollData.para?.hidden, pollData.para?.user_add_choice,
              pollData.para?.menu_at_the_end, pollData.para?.compact_ui, pollData.para?.show_divider, pollData.para?.show_help_link, pollData.para?.show_command_info, pollData.para?.true_anonymous, pollData.para?.add_number_emoji_to_choice, pollData.para?.add_number_emoji_to_choice_btn, pollData.schedule_end_ts, pollData.para?.user_lang, task.created_user_id, pollData.cmd,"task_schedule",task.poll_id,cmdNote,false,null));
          const blocks = pollView?.blocks;
          const pollID = pollView?.poll_id;

          if (null === pollView || null === blocks) {
            errMsg = `[Schedule] Failed to create poll ch:${pollData.channel} ID:${task.poll_id} CMD:${pollData.cmd}`;
            logger.warn(errMsg);
            // Disable + notify + move on - a single bad poll must never abort
            // the whole scheduler tick (this used to `return`, starving every
            // other team's schedules forever).
            await scheduleCol.updateOne(
                { _id: task._id },
                { $set: { is_enable: false, last_error_ts: new Date(), last_error_text: errMsg } }
            );
            await notifyScheduleOwner(mBotToken, mTaskOwner, isUserAllowDM, disabledNoti(errMsg));
            continue;
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
            dmOwnerString = parameterizedString(stri18n(appLang,'task_scheduled_post_noti_error'), {error:postRes.message,poll_id:task.poll_id,poll_cmd:pollData.cmd,ts:localizeTS,note:`\n${cmdNote}`} )

            if(task.next_error_disable_poll === true) {
              // Second consecutive failure: this strike kills the schedule -
              // notify the owner (it used to disable silently).
              await scheduleCol.updateOne(
                  { _id: task._id },
                  { $set: { is_enable: false, last_error_ts: new Date(), last_error_text: postRes?.message } }
              );
              await notifyScheduleOwner(mBotToken, mTaskOwner, isUserAllowDM, dmOwnerString + "\n" + disabledNoti(postRes?.message));
              continue;
            }

            await scheduleCol.updateOne(
                { _id: task._id },
                { $set: { last_error_ts: new Date(), last_error_text: postRes?.message, next_error_disable_poll: true } }
            );
            lastFailReason = postRes?.message ?? '';
          } else {
            postOk = true;
            //update slack_ts
            await pollCol.updateOne(
                { _id: new ObjectId(pollID)},
                { $set: { ts: postRes.slack_ts } }
            );
            if(taskRunCounter>=taskRunMax) {
              //last one
              dmOwnerString = parameterizedString(stri18n(appLang,'task_scheduled_post_noti_done'), {info:"",poll_id:task.poll_id,poll_cmd:pollData.cmd,ts:localizeTS,note:`\n${cmdNote}`} );
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
          logger.error(`${errMsg} ${e.toString()}\n${e.stack}`);
          // Thrown failures get the same two-strike bookkeeping as postRes
          // failures - they used to be invisible to the disable mechanism.
          if (task.next_error_disable_poll === true) {
            await scheduleCol.updateOne(
                { _id: task._id },
                { $set: { is_enable: false, last_error_ts: new Date(), last_error_text: e.message } }
            ).catch(() => {});
            await notifyScheduleOwner(mBotToken, mTaskOwner, isUserAllowDM, disabledNoti(e.message));
            continue;
          }
          await scheduleCol.updateOne(
              { _id: task._id },
              { $set: { last_error_ts: new Date(), last_error_text: e.message, next_error_disable_poll: true } }
          ).catch(() => {});
          lastFailReason = e.message;
        }
      }
      await notifyScheduleOwner(mBotToken, mTaskOwner, isUserAllowDM, dmOwnerString);
      dmOwnerString=null;




      let taskIsEnable = true;
      if(postOk && taskRunCounter>=taskRunMax) taskIsEnable = false;

      // A failed ONE-SHOT has no cron re-arm path: disable it instead of
      // leaving an enabled-but-done zombie that autoCleanupTask, delete_done
      // and the schedule list all mis-handle. Failed CRON runs stay enabled -
      // the cron block below re-arms them for the next occurrence.
      const oneShotFailed = !postOk && !task.cron_string;
      if (oneShotFailed) {
        dmOwnerString = disabledNoti(lastFailReason ?? '');
      }

      // Run accounting (is_done was already claimed up front). Only successful
      // posts consume the run_max budget - a failed run keeps its counter so
      // transient errors cannot eat scheduled occurrences.
      await scheduleCol.updateOne(
          { _id: task._id },
          { $set: postOk
              ? { is_done: true, last_run_ts: new Date(), run_counter: taskRunCounter, run_max: taskRunMax, is_enable: taskIsEnable }
              : { is_done: true, last_run_ts: new Date(), run_max: taskRunMax, ...(oneShotFailed ? { is_enable: false } : {}) } }
      );


      if (task.cron_string && taskIsEnable) {
        // Calculate the next schedule time. Evaluated in the creator's Slack
        // timezone when the row has one (new rows store it at create time);
        // legacy rows without tz keep the historical UTC behaviour.
        const nextScheduleTime = calculateNextScheduleTime(task.cron_string, task.tz ?? null);

        if (!nextScheduleTime) {
          const cronErr = `cron_string '${task.cron_string}' is invalid`;
          logger.error(`[Schedule] Error parsing cron_string for poll_id ${task.poll_id} and cron_string ${task.cron_string}`);
          await scheduleCol.updateOne(
              { _id: task._id },
              { $set: { is_enable: false, last_error_ts: new Date(), last_error_text: cronErr } }
          );
          // The owner used to get NO notification on this terminal disable.
          await notifyScheduleOwner(mBotToken, mTaskOwner, isUserAllowDM, disabledNoti(cronErr));
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

      await notifyScheduleOwner(mBotToken, mTaskOwner, isUserAllowDM, dmOwnerString);
      dmOwnerString=null;

      } catch (e) {
        // Blast-shield catch: log with the task identity and move on to the
        // next team's schedule - never abort the whole tick. The run was
        // already claimed (is_done:true), so without a terminal write the
        // row would silently strand forever (never re-armed, never cleaned).
        // Disabling - rather than re-arming - avoids re-posting a poll that
        // may already have gone out before the throw.
        logger.error(`[Schedule] task ${task._id} (poll_id: ${task.poll_id}) failed unexpectedly: ${e.message}\n${e.stack}`);
        await scheduleCol.updateOne(
            { _id: task._id },
            { $set: { is_enable: false, last_error_ts: new Date(), last_error_text: e.message } }
        ).catch(() => {});
      }
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
      const pollIdStr = String(poll._id);
      if (closeInFlight.has(pollIdStr)) {
        logger.verbose(`[closingTasks] close already in flight for poll_id: ${poll._id} - skipping.`);
        continue;
      }
      closeInFlight.add(pollIdStr);
      logger.debug(`[closingTasks] closing poll_id: ${poll._id}.`);
      try {
        await closePollById(poll._id);
      } catch (e) {
        logger.error(`[closingTasks] close failed for poll_id ${poll._id}: ${e.message}\n${e.stack}`);
      } finally {
        closeInFlight.delete(pollIdStr);
      }
    }

  } catch (e) {
    logger.error(e);
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

// Fail fast on unconfigured Slack credentials. With empty strings the app
// boots "cleanly" and then every interaction dies as dispatch_failed - which
// is miserable to diagnose. Mirrors the fail-fast Mongo connect handling.
{
  const missingCreds = [];
  if (!signing_secret) missingCreds.push('signing_secret');
  if (!config.get('client_id')) missingCreds.push('client_id');
  if (!config.get('client_secret')) missingCreds.push('client_secret');
  if (missingCreds.length > 0) {
    console.error(`[Config] Missing required Slack credential(s) in config/default.json: ${missingCreds.join(', ')}. ` +
        `Fill them in (see self_host.md / README "Server configuration") and restart.`);
    process.exit(1);
  }
  for (const k of ['oauth_success', 'oauth_failure']) {
    if (String(config.get(k)).includes('yoururlhere')) {
      console.warn(`[Config] ${k} still contains the placeholder URL - OAuth install redirects will not work until you set it.`);
    }
  }
}

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
        logger.error(`OAuth install failed: ${error?.stack || error}`);
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

// Real health endpoint for uptime monitors: verifies Mongo responds (the
// Slack handlers swallow DB errors, so a dead Mongo leaves /ping green
// while every poll silently fails). 200 = healthy, 503 = Mongo unreachable.
receiver.router.get('/healthz', async (req, res) => {
  try {
    await Promise.race([
      mClient.db(config.get('mongo_db_name')).command({ ping: 1 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('mongo ping timeout')), 2000)),
    ]);
    res.status(200).json({
      ok: true,
      mongo: 'up',
      version: require('./package.json').version,
      uptime_s: Math.floor(process.uptime()),
    });
  } catch (e) {
    res.status(503).json({ ok: false, mongo: 'down' });
  }
})

const app = new App({
  receiver: receiver
});

// Register multi-question poll handlers (mq_* actions/views). Self-contained.
mq.register(app);

// Poll-type selector shared by the single-question modal (createModal) and the
// multi-question builder: swap between them in place. "multi" updates the current
// modal to the form builder; "single" re-opens the single-question modal
// via the action's trigger. Channel is carried in private_metadata so it survives
// the swap. Lives here (not in the mq module) because it bridges createModal.
app.action('mq_poll_type', async ({ ack, body, action, client, context }) => {
  await ack();
  const val = (action && action.selected_option && action.selected_option.value) || 'single';
  let channel = null; let responseUrl = ''; let userLang = 'en'; let langSelectable = false;
  try { const pm = JSON.parse((body.view && body.view.private_metadata) || '{}'); channel = pm.channel || null; responseUrl = pm.response_url || ''; userLang = pm.user_lang || 'en'; langSelectable = pm.hasOwnProperty('lang_selectable') ? !!pm.lang_selectable : null; } catch (e) { /* ignore */ }
  // The single-question modal's metadata doesn't carry lang_selectable, so resolve it
  // from team config when swapping single→multi (else the lang selector goes missing).
  if (langSelectable === null) {
    try { const tc = await getTeamOverride(getTeamOrEnterpriseId(context)); langSelectable = tc.hasOwnProperty('app_lang_user_selectable') ? !!tc.app_lang_user_selectable : !!gIsAppLangSelectable; }
    catch (e) { langSelectable = !!gIsAppLangSelectable; }
  }
  try {
    if (val === 'multi') {
      // Open the VISUAL builder in place (the DSL textarea lives on as the builder's "Advanced" mode).
      await mq.openBuilder({ client, viewId: body.view.id, channel, responseUrl, teamId: getTeamOrEnterpriseId(context), userId: body.user && body.user.id });
    } else {
      // swap back to single-question — update THIS modal in place (no new modal).
      await createModal(context, client, body.trigger_id, responseUrl, channel, body.view.id);
    }
  } catch (e) {
    logger.error('mq_poll_type swap failed:', e && e.message);
  }
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
  // Captured before the response_url branch deletes requestBody.channel, so
  // the catch below can correlate errors to a channel.
  const logCh = requestBody?.channel ?? '(response_url)';
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
      logger.error(`Channel not found error : ignored (CH:${logCh})`);
      ret.message = "Channel not found error : ignored"+` ${addChNotFoundErr}`;
    }
    else if (
        e && e.data && e.data && e.data.error
        && 'team_not_found' === e.data.error
    ) {
      logger.error(`Team not found error : ignored (CH:${logCh})`);
      ret.message = "Team not found error : ignored"+` ${addChNotFoundErr}`;
    }
    else if (
        e && e.data && e.data && e.data.error
        && 'team_access_not_granted' === e.data.error
    ) {
      logger.error(`Team not found/not granted error : ignored (CH:${logCh})`);
      ret.message = "Team not found/not grante error : ignored"+` ${addChNotFoundErr}`;
    }
    else if (
        e && e.data && e.data && e.data.error
        && 'message_not_found' === e.data.error
    ) {
      logger.error(`message_not_found error : ignored (CH:${logCh})`);
      ret.message = "message_not_found error : ignored"+` ${addChNotFoundErr}`;
    } else {
      logger.error(e.toString()+"\n"+e.stack);
      // Redact the bot token before logging - the Web API path keeps it in
      // requestBody, and tokens must never land in log files.
      logger.error(`postChat failed, requestBody: ${JSON.stringify({ ...requestBody, ...(requestBody?.token ? { token: '<redacted>' } : {}) })}`);
      ret.message = "Unknown error: "+e?.data?.error;
    }
    ret.status = false;
    return ret;
  }
  ret.status = true;
  return ret;
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
      type: "header",
      text: {
        type: "plain_text",
        text: "Edit poll",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Click Menu and select Edit at your poll, or:\n```/"+slackCommand+" edit [POLL_ID]```\nOnly the creator can edit a poll (within the configured edit window).",
      },
    },
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Export poll results (CSV)",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Click Menu and select Export at your poll, or:\n```/"+slackCommand+" export [POLL_ID]```\nOnly the creator can export. Exports respect the poll's anonymity settings.",
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
            "`lang XX` - Set this poll's language (`" + Object.keys(langList).join('`/`') + "`).\n" +
            "`on TIME_STAMP` - Schedule a poll to be posted on TIME_STAMP.\n" +
            "`end TIME_STAMP` - Schedule a poll to be closed on TIME_STAMP.\n" +
            "   - TIME_STAMP in ISO8601 format eg. `YYYY-MM-DDTHH:mm:ss.sssZ` (no offset = your Slack timezone).\n" +
            "*Options must come BEFORE the question.*",
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
            "- `CRON_EXP` = (Optional) Do not set to run once, or put [cron expression] (with \"Double Quote\") here (eg. `\"30 12 15 * *\"` , Post poll 12:30 PM on the 15th day of every month). New schedules run in YOUR Slack timezone; schedules created before mid-2026 keep running in UTC.\n" +
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
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Manage schedules*\n" +
            "```/"+slackCommand+" schedule list```\n" +
            "```/"+slackCommand+" schedule delete [POLL_ID]```",
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
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Per-user settings (e.g. allow the bot to DM you):\n```\n/" + slackCommand + " user_config```",
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
        text: "*Limitations*\nSlack have limitations and that include \"message length\". So you can't have more than "+gSlackLimitChoices+" options per poll. You can create multiple polls if you want more options",
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

      // Atomic compare-and-set: flip welcome_send to true ONLY if it isn't
      // already true. Two simultaneous app_home_opened events used to both
      // pass a stale read-then-write check and DM the user twice. updateOne
      // with $set also preserves any existing `config.*` fields (the previous
      // replaceOne would wipe them).
      const setFlagRes = await userCol.updateOne(
        {
          team_id: teamOrEntId,
          user_id: event.user,
          $or: [
            { flag: { $exists: false } },
            { 'flag.welcome_send': { $ne: true } },
          ],
        },
        {
          $set: {
            'flag.welcome_send': true,
            'flag.welcome_send_ts': new Date(),
          },
        }
      );

      let shouldPostWelcome = setFlagRes.matchedCount > 0;

      if (!shouldPostWelcome) {
        // Either welcome_send is already true (skip below), or the document
        // doesn't exist at all — insert it now.
        const existing = await userCol.findOne({
          team_id: teamOrEntId,
          user_id: event.user,
        });
        if (existing === null) {
          try {
            await userCol.insertOne({
              team_id: teamOrEntId,
              user_id: event.user,
              flag: {
                welcome_send: true,
                welcome_send_ts: new Date(),
              },
            });
            shouldPostWelcome = true;
          } catch (e) {
            // Race: a concurrent event just inserted. They post; we skip.
            logger.debug('welcome flag insert race lost', e);
          }
        }
      }

      if (shouldPostWelcome) {
        await client.chat.postMessage({
          channel: event.channel,
          text: parameterizedString(stri18n(appLang, 'info_welcome_message'), {slack_command: slackCommand, link: helpLink}),
        });
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

    // Multi-question poll: "/<cmd> multi" opens the form builder modal. The whole
    // multi-question feature is self-contained in src/multiquestion.js.
    if (cmdBody && /^multi(\b|$)/i.test(cmdBody)) {
      // Auto-detect the channel the command was run in — same source the
      // single-question modal uses below (command.channel_id).
      const mqChannel = (command && command.channel_id) ? command.channel_id : ((body && body.channel_id) || null);
      const mqTeam = getTeamOrEnterpriseId(context);
      const mqResp = (body && body.response_url) || '';
      const mqUser = (command && command.user_id) || (body && body.user_id) || null;
      const rest = cmdBody.replace(/^multi\b\s*/i, '').trim();
      const prev = rest.match(/^preview\b\s*/i);
      try {
        if (!rest) {
          // "/poll multi" with no args → open the empty builder modal
          await mq.openCreateModal(client, body.trigger_id, mqChannel, mqResp, mqTeam, undefined, mqUser);
        } else if (prev) {
          // "/poll multi preview …" → always open the builder PRE-FILLED (review before posting)
          await mq.openCreateModal(client, body.trigger_id, mqChannel, mqResp, mqTeam, rest.slice(prev[0].length).replace(/\s+\|\s+/g, '\n'), mqUser);
        } else {
          // "/poll multi <DSL>" → create directly; on a parse error open the builder
          // PRE-FILLED with what they typed so nothing is lost.
          const r = await mq.createFromCommand({ client, token: context.botToken, teamId: mqTeam, userId: mqUser, channel: mqChannel, dsl: rest, responseUrl: mqResp });
          if (!r.ok) await mq.openCreateModal(client, body.trigger_id, mqChannel, mqResp, mqTeam, r.formText, mqUser);
        }
      } catch (e) { await respond('Could not open the multi-question builder.'); }
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

    const isHelp = cmdBody ? (cmdBody.toLowerCase() === 'help' || cmdBody.toLowerCase().startsWith('help ')) : false;
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
        // Flag keywords match case-insensitively (mobile keyboards
        // auto-capitalise); the original-cased cmdBody is what gets consumed.
        const cmdLower = cmdBody.toLowerCase();
        if (cmdLower.startsWith('anonymous')) {
          fetchArgs = true;
          isAnonymous = true;
          cmdBody = cmdBody.substring(9).trim();
        } else if (cmdLower.startsWith('schedule')) {
          cmdBody = cmdBody.substring(8).trim();

          let isEndOfCmd = false;
          let schTsText = '';//'2023-11-17T21:54:00+07:00';
          let schPollID = null;
          let schCH = null;
          let schMAXRUN = gScheduleMaxRun;
          let schCron = null;
          let schUserTz = null;
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
              await notifyUser(body, context, stri18n(userLang, 'err_only_installer'), userLang);
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

                //test cron - evaluated in the creator's Slack timezone so the
                //recurrence matches their local wall-clock (legacy rows
                //without tz keep UTC; see checkAndExecuteTasks).
                if (schUserTz === null) schUserTz = await getUserTz(context.botToken, userId);
                const nextScheduleTime = calculateNextScheduleTime(inputPara, schUserTz);

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

              // No-offset timestamps are interpreted in the creator's Slack
              // timezone (same rule as on/end in the plain create path).
              if (schUserTz === null) schUserTz = await getUserTz(context.botToken, userId);
              schTs = parseISOInUserTz(schTsText, schUserTz);

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
                tz: schUserTz,
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
              resString += formatScheduleListItem(item, myTz, false);
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
              await notifyUser(body, context, stri18n(userLang, 'err_only_installer'), userLang);
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
              resString += formatScheduleListItem(item, myTz, true);
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


        } else if (cmdLower === 'edit' || cmdLower.startsWith('edit ')) {
          // /poll edit POLL_ID "new question" "opt1" "opt2" ...
          // Edits a posted poll's question/options in place. Owner-only.
          // Votes are re-applied to options whose text is unchanged; votes
          // for renamed or removed options are dropped (we warn the user).
          cmdBody = cmdBody.substring(4).trim();

          if (!isPollEditEnabled(teamConfig)) {
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: "```" + fullCmd + "```\n" + stri18n(userLang, 'poll_edit_disabled'),
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }

          if (cmdBody === '') {
            const usage = `\`/${slackCommand} edit POLL_ID "new question" "opt1" "opt2" ...\``;
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: "```" + fullCmd + "```\n" + stri18n(userLang, 'poll_edit_usage') + "\n" + usage,
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }

          // Pull POLL_ID off the front
          let editPollIdRaw;
          const firstSpace = cmdBody.indexOf(' ');
          if (firstSpace === -1) {
            editPollIdRaw = cmdBody;
            cmdBody = '';
          } else {
            editPollIdRaw = cmdBody.substring(0, firstSpace);
            cmdBody = cmdBody.substring(firstSpace).trim();
          }

          let editPollData = null;
          let editPollObjId = null;
          try {
            editPollObjId = new ObjectId(editPollIdRaw);
            editPollData = await pollCol.findOne({ _id: editPollObjId });
          } catch (e) {
            // fall through; editPollData stays null
          }

          if (!editPollData) {
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: "```" + fullCmd + "```\n" + stri18n(userLang, 'poll_edit_not_found'),
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }

          if (editPollData.user_id !== userId) {
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: "```" + fullCmd + "```\n" + stri18n(userLang, 'err_action_other'),
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }

          if (!editPollData.ts || !editPollData.channel || !editPollData.team) {
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: "```" + fullCmd + "```\n" + stri18n(userLang, 'poll_edit_not_posted'),
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }

          {
            const win = isWithinEditWindow(editPollData, teamConfig);
            if (!win.ok) {
              let mRequestBody = {
                token: context.botToken,
                channel: channel,
                user: userId,
                text: "```" + fullCmd + "```\n" + parameterizedString(stri18n(userLang, 'poll_edit_too_old'), { minutes: win.maxMins }),
              };
              await postChat(body.response_url, 'ephemeral', mRequestBody);
              return;
            }
          }

          // Parse new question + options from the remainder using the same
          // quoted-string grammar as poll create.
          let newQuestion = null;
          const newOptions = [];
          try {
            const quotePattern = `\\${standardQuote}`;
            const regexp = new RegExp(`${quotePattern}(?:[^${quotePattern}\\\\]|\\\\.)*${quotePattern}`, 'g');
            const matches = cmdBody.match(regexp);
            if (matches) {
              for (const option of matches) {
                let opt = option.substring(1, option.length - 1);
                let unescaped = opt.replace(new RegExp(escapedQuotesPattern, 'g'), (match) => match[1])
                    .replace(/\\\\/g, "\\");
                if (newQuestion === null) {
                  newQuestion = unescaped;
                } else {
                  newOptions.push(unescaped);
                }
              }
            }
          } catch (e) {
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: "```" + fullCmd + "```\n" + stri18n(userLang, 'err_invalid_command'),
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }

          if (newQuestion === null || newOptions.length === 0) {
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: "```" + fullCmd + "```\n" + stri18n(userLang, 'poll_edit_no_question'),
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }

          if (newOptions.length > gSlackLimitChoices) {
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: "```" + fullCmd + "```\n" + parameterizedString(stri18n(appLang, 'err_slack_limit_choices_max'), {slack_limit_choices: gSlackLimitChoices}),
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }

          const editResult = await applyPollEdit({
            pollData: editPollData,
            newQuestion: newQuestion,
            newOptions: newOptions,
            editorUserId: userId,
          });

          if (!editResult.ok) {
            const errSuffix = editResult.error ? `: ${editResult.error}` : '';
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: "```" + fullCmd + "```\n" + stri18n(userLang, 'err_invalid_command') + errSuffix,
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }

          let successText = "```" + fullCmd + "```\n" + parameterizedString(stri18n(userLang, 'poll_edit_success'), {
            poll_id: editPollData._id.toString(),
          });
          if (editResult.droppedCount > 0) {
            successText += "\n" + parameterizedString(stri18n(userLang, 'poll_edit_warn_votes'), {
              dropped_count: editResult.droppedCount,
            });
          }
          let mRequestBody = {
            token: context.botToken,
            channel: channel,
            user: userId,
            text: successText,
          };
          await postChat(body.response_url, 'ephemeral', mRequestBody);
          return;

        } else if (cmdLower === 'export' || cmdLower.startsWith('export ')) {
          // /poll export POLL_ID — owner-only CSV export. Both the menu
          // action and this CLI form go through buildPollCsv + sendCsvExport.
          cmdBody = cmdBody.substring(6).trim();

          if (cmdBody === '') {
            const usage = `\`/${slackCommand} export POLL_ID\``;
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: "```" + fullCmd + "```\n" + stri18n(userLang, 'poll_export_usage') + "\n" + usage,
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }

          let exportPollData = null;
          try {
            exportPollData = await pollCol.findOne({ _id: new ObjectId(cmdBody) });
          } catch (e) { /* falls through */ }

          if (!exportPollData) {
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: "```" + fullCmd + "```\n" + stri18n(userLang, 'poll_export_not_found'),
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }

          if (exportPollData.user_id !== userId) {
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: "```" + fullCmd + "```\n" + stri18n(userLang, 'poll_export_no_permission'),
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }

          const exportVoteData = await findVoteDataForPoll(exportPollData);
          await sendCsvExport(channel, userId, context, client, exportPollData, exportVoteData, userLang, body.response_url);
          return;

        } else if (cmdLower === 'test' || cmdLower.startsWith('test ')) {
          //test function (debug) - installer only, replies ephemerally.
          //NEVER log the Bolt context here: it contains the bot token.
          try {
            cmdBody = cmdBody.substring(4).trim();
            const teamId = getTeamOrEnterpriseId(context);
            logger.debug("TeamID:" + teamId);

            let testConfigUser = null;
            const testTeam = await getTeamInfo(teamId);
            if (testTeam?.user?.id) testConfigUser = testTeam.user.id;
            if (userId !== testConfigUser) {
              await notifyUser(body, context, stri18n(userLang, 'err_only_installer'), userLang);
              return;
            }

            const testDate = new Date();
            const testDateStr = testDate.toString();
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: `UserID ${userId} Date ${testDateStr}\n` +
                  (await getAndlocalizeTimeStamp(context.botToken, userId, testDate))
              ,
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          } catch (e) {
            logger.debug("Error: Failed to get user timezone");
            logger.debug(e.toString() + "\n" + e.stack);
            return;
          }

        } else if (cmdLower.startsWith('limit')) {
          fetchArgs = true;
          cmdBody = cmdBody.substring(5).trim();
          isLimited = true;
          const limitToken = cmdBody.indexOf(' ') === -1 ? cmdBody : cmdBody.substring(0, cmdBody.indexOf(' '));
          if (/^\d+$/.test(limitToken)) {
            limit = parseInt(limitToken, 10);
            cmdBody = cmdBody.substring(limitToken.length).trim();
            if (limit < 1) {
              // 'limit 0' would create a poll nobody can vote on - reject.
              await postChat(body.response_url, 'ephemeral', {
                token: context.botToken,
                channel: channel,
                user: userId,
                text: "```" + fullCmd + "```\n" + parameterizedString(stri18n(userLang, 'err_para_invalid'), {
                  parameter: "limit",
                  value: String(limit),
                  error_msg: "limit must be 1 or more"
                })
              });
              return;
            }
          } else if (limitToken !== "" && !limitToken.startsWith(standardQuote)
              && !['anonymous', 'hidden', 'add-choice', 'lang', 'on', 'end'].includes(limitToken.toLowerCase())) {
            // Non-numeric value used to be silently swallowed (limit fell
            // back to 1 without telling the user). A known FLAG word after a
            // bare `limit` is legal though - createCmdFromInfos historically
            // emitted `limit hidden ...` / `limit lang xx ...` and those
            // stored cmd strings must keep re-running (limit defaults to 1,
            // the next loop iteration consumes the flag).
            await postChat(body.response_url, 'ephemeral', {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: "```" + fullCmd + "```\n" + parameterizedString(stri18n(userLang, 'err_para_invalid'), {
                parameter: "limit",
                value: limitToken,
                error_msg: "expected a number of 1 or more"
              })
            });
            return;
          }
        } else if (cmdLower.startsWith('on')) {
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
        } else if (cmdLower.startsWith('end')) {
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
        else if (cmdLower.startsWith('lang')) {
          fetchArgs = true;
          cmdBody = cmdBody.substring(4).trim();
          const inputLang = cmdBody.indexOf(' ') === -1 ? cmdBody : cmdBody.substring(0, cmdBody.indexOf(' '));
          if (langList.hasOwnProperty(inputLang)) {
            userLang = inputLang;
            cmdBody = cmdBody.substring(inputLang.length).trim();
          } else {
            // Unknown code: reject with the valid codes instead of silently
            // falling back to the default language.
            await postChat(body.response_url, 'ephemeral', {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: "```" + fullCmd + "```\n" + parameterizedString(stri18n(userLang, 'err_lang_invalid'), {
                value: inputLang,
                langs: Object.keys(langList).join('/')
              })
            });
            return;
          }
        } else if (cmdLower.startsWith('hidden')) {
          fetchArgs = true;
          cmdBody = cmdBody.substring(6).trim();
          isHidden = true;
        } else if (cmdLower.startsWith('add-choice')) {
          fetchArgs = true;
          cmdBody = cmdBody.substring(10).trim();
          isAllowUserAddChoice = true;
        } else if (cmdLower.startsWith('config')) {
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
          for (const eachOverrideable of validTeamOverrideConfigInt) {
            validWritePara += `\n/${slackCommand} config write ${eachOverrideable} [number]`;
          }
          validWritePara += `\n/${slackCommand} config write app_user_notification_method [both/modal/text]`;

          validWritePara += '\n' + parameterizedString(stri18n(userLang, 'info_need_help'), {
            email: helpEmail,
            link: helpLink
          });
          //validWritePara += `\n${helpEmail}\n<${helpLink}|`+stri18n(userLang,'info_need_help')+`>`;
          //let teamOrEntId = getTeamOrEnterpriseId(context);
          const teamFilter = {
            $or: [
              {'team.id': teamOrEntId},
              {'enterprise.id': teamOrEntId},
            ]
          };
          let team = await orgCol.findOne(teamFilter);
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
            await notifyUser(body, context, stri18n(userLang, 'err_only_installer'), userLang);
            return;
          }

          if (cmdBody.startsWith("read") || cmdBody.startsWith("list")) {

            // Render every known key with its EFFECTIVE value and source so
            // an installer can see resolved settings without reading code.
            const overrides = team?.openPollConfig ?? {};
            const defaults = serverDefaultsForConfig();
            const lines = [];
            for (const key of Object.keys(defaults)) {
              const hasOverride = Object.prototype.hasOwnProperty.call(overrides, key);
              const effective = hasOverride ? overrides[key] : defaults[key];
              lines.push(`${hasOverride ? '*' : ' '} ${key} = ${effective}${hasOverride ? '  (team override)' : ''}`);
            }
            const configTxt = "Effective config for this team (`*` = team override, others = server default):\n```" +
                lines.join('\n') + "```\n" +
                `Change: \`/${slackCommand} config write [key] [value]\` - Revert: \`/${slackCommand} config reset [key|all]\``;

            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              //blocks: blocks,
              text: `${configTxt}`,
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          } else if (cmdBody.startsWith("reset")) {
            cmdBody = cmdBody.substring(5).trim();
            const resetKey = cmdBody.indexOf(' ') === -1 ? cmdBody : cmdBody.substring(0, cmdBody.indexOf(' '));
            const resettableKeys = [...validTeamOverrideConfigTF, ...validTeamOverrideConfigInt, 'app_lang', 'display_poller_name', 'app_user_notification_method'];
            let resetTxt;
            if (resetKey === 'all') {
              await orgCol.updateOne(teamFilter, { $unset: { openPollConfig: "" } });
              resetTxt = `All team overrides removed - every setting now follows the server default.`;
            } else if (resettableKeys.includes(resetKey)) {
              await orgCol.updateOne(teamFilter, { $unset: { [`openPollConfig.${resetKey}`]: "" } });
              resetTxt = `[${resetKey}] override removed - effective value is now [${serverDefaultsForConfig()[resetKey]}] (server default).`;
            } else {
              resetTxt = `Usage:\n/${slackCommand} config reset [key]\n/${slackCommand} config reset all`;
            }
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: resetTxt,
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          } else if (cmdBody.startsWith("write")) {
            cmdBody = cmdBody.substring(5).trim();

            // Whole remainder counts as the key when no value follows, so the
            // error can name what the user actually typed (was '[]' before).
            let inputPara = cmdBody.indexOf(' ') === -1 ? cmdBody : cmdBody.substring(0, cmdBody.indexOf(' '));
            let isWriteValid = false;

            if (validTeamOverrideConfigTF.includes(inputPara)) {
              cmdBody = cmdBody.substring(inputPara.length).trim();
              isWriteValid = true;
            }

            if (validTeamOverrideConfigInt.includes(inputPara)) {
              cmdBody = cmdBody.substring(inputPara.length).trim();
              isWriteValid = true;
            }

            if (inputPara === "app_lang") {
              cmdBody = cmdBody.substring(8).trim();
              isWriteValid = true;
            }

            if (inputPara === "app_user_notification_method") {
              cmdBody = cmdBody.substring(inputPara.length).trim();
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
              } else if (inputPara === "display_poller_name") {
                // Only tag/none are implemented in the render switch -
                // name/real_name used to be accepted and silently ignored.
                switch (inputVal) {
                  case "tag":
                  case "none":
                    break;
                  default:
                    let mRequestBody = {
                      token: context.botToken,
                      channel: channel,
                      user: userId,
                      //blocks: blocks,
                      text: `Usage: display_poller_name [tag/none]`,
                    };
                    await postChat(body.response_url, 'ephemeral', mRequestBody);
                    return;
                }
              } else if (inputPara === "app_user_notification_method") {
                // String enum: both (modal + ephemeral) / modal / text. Invalid rejected.
                switch (inputVal) {
                  case "both":
                  case "modal":
                  case "text":
                    break;
                  default:
                    let mRequestBody = {
                      token: context.botToken,
                      channel: channel,
                      user: userId,
                      text: `Usage: app_user_notification_method [both/modal/text]`,
                    };
                    await postChat(body.response_url, 'ephemeral', mRequestBody);
                    return;
                }
              }
              else if (validTeamOverrideConfigInt.includes(inputPara)) {
                const parsed = parseInt(inputVal, 10);
                if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== inputVal.trim()) {
                  let mRequestBody = {
                    token: context.botToken,
                    channel: channel,
                    user: userId,
                    text: `Usage: ${inputPara} [non-negative integer, 0 = no limit]`,
                  };
                  await postChat(body.response_url, 'ephemeral', mRequestBody);
                  return;
                }
                inputVal = parsed;
              }
              else {
                // Strict whole-token boolean (true/yes/1, false/no/0, any
                // case). 'True' used to be rejected while 'truefoo' was
                // silently accepted as true.
                const parsedBool = parseBooleanToken(cmdBody);
                if (parsedBool === undefined) {
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
                inputVal = parsedBool;
              }
              try {
                // Field-scoped atomic $set: a whole-document replaceOne here
                // could clobber a concurrent OAuth re-install of this team.
                await orgCol.updateOne(
                    teamFilter,
                    { $set: { 'openPollConfig.isset': true, ['openPollConfig.' + inputPara]: inputVal } }
                );
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
                  `\n/${slackCommand} config reset [key/all]` +
                  `\n${validWritePara}`
              ,
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
            return;
          }

        } else if (cmdLower.startsWith('user_config')) {
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

              try {
                // Atomic: stamp the reset flag and drop the config overrides
                // without replacing the whole document (a replaceOne raced
                // against the welcome-flag writer).
                await userCol.updateOne({
                      team_id: teamOrEntId,
                      user_id: userId,
                    },
                    {
                      $set: { flag: { reset_ts: new Date() } },
                      $unset: { config: "" },
                    },
                    {
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

            // Whole remainder counts as the key when no value follows (the
            // error used to render as '[]').
            let inputPara = cmdBody.indexOf(' ') === -1 ? cmdBody : cmdBody.substring(0, cmdBody.indexOf(' '));
            let isWriteValid = false;

            if (validUserOverrideConfigTF.includes(inputPara)) {
              cmdBody = cmdBody.substring(inputPara.length).trim();
              isWriteValid = true;
            }

            if (isWriteValid) {
              let inputVal = cmdBody.trim();

              // Strict whole-token boolean - same vocabulary as team config.
              const parsedBool = parseBooleanToken(cmdBody);
              if (parsedBool === undefined) {
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
              inputVal = parsedBool;

              try {
                // Field-scoped atomic $set - a whole-document replaceOne here
                // could clobber the concurrently-written welcome flag.
                await userCol.updateOne(
                    {
                      team_id: teamOrEntId,
                      user_id: userId,
                    },
                    { $set: { 'config.isset': true, ['config.' + inputPara]: inputVal } },
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
                    `\n/${slackCommand} user_config reset true`,
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

        // Anything left after removing the quoted segments is unparsed text.
        // A known flag word there means the user put options AFTER the
        // question - reject loudly instead of silently ignoring them (a
        // dropped `anonymous` is a privacy problem). 'on'/'end' are excluded:
        // too common as plain English words to flag safely.
        const residue = cmdBody.replace(regexp, ' ');
        const misplacedFlagWords = ['anonymous', 'hidden', 'limit', 'add-choice', 'lang'];
        const misplacedFlag = residue.split(/\s+/).find(w => misplacedFlagWords.includes(w.toLowerCase()));
        if (misplacedFlag !== undefined) {
          let mRequestBody = {
            token: context.botToken,
            channel: channel,
            user: userId,
            text: "```" + fullCmd + "```\n" + parameterizedString(stri18n(userLang, 'err_flag_after_question'), {
              flag: misplacedFlag,
              slack_command: slackCommand
            })
          };
          await postChat(body.response_url, 'ephemeral', mRequestBody);
          return;
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
          logger.warn(`Not able to DM user: ${e.message}`);
        }
        return;
      }

      // Times typed without a UTC offset are interpreted in the user's Slack
      // timezone (legacy behavior was server-local time). Fetched once.
      let cmdUserTz = null;
      if (endDateTime !== null || postDateTime !== null) {
        cmdUserTz = await getUserTz(context.botToken, userId);
      }

      let endTs = null;
      if(endDateTime !== null) {
        endTs = parseISOInUserTz(endDateTime, cmdUserTz);
        if (endTs <= new Date()) {
          // A past auto-close time would post the poll and instantly close it
          // within the next cron minute (the modal already rejects this).
          let mRequestBody = {
            token: context.botToken,
            channel: channel,
            user: userId,
            text: "```" + fullCmd + "```\n" + stri18n(userLang, 'err_close_before_post')
          };
          await postChat(body.response_url, 'ephemeral', mRequestBody);
          return;
        }
      }

      let postTsParsed = null;
      if (postDateTime !== null) {
        postTsParsed = parseISOInUserTz(postDateTime, cmdUserTz);
        if (postTsParsed <= new Date()) {
          let mRequestBody = {
            token: context.botToken,
            channel: channel,
            user: userId,
            text: "```" + fullCmd + "```\n" + parameterizedString(stri18n(userLang, 'err_time_in_past'), { value: postDateTime })
          };
          await postChat(body.response_url, 'ephemeral', mRequestBody);
          return;
        }
        if (endTs !== null && postTsParsed >= endTs) {
          // 'on' must come before 'end'.
          let mRequestBody = {
            token: context.botToken,
            channel: channel,
            user: userId,
            text: "```" + fullCmd + "```\n" + stri18n(userLang, 'err_close_before_post')
          };
          await postChat(body.response_url, 'ephemeral', mRequestBody);
          return;
        }
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
          }
        }
      }

      const pollView = (await createPollView(teamOrEntId, channel, teamConfig, question, options, isAnonymous, isLimited, limit, isHidden, isAllowUserAddChoice, isMenuAtTheEnd, isCompactUI, isShowDivider, isShowHelpLink, isShowCommandInfo, isTrueAnonymous, isShowNumberInChoice, isShowNumberInChoiceBtn, endTs, userLang, userId, fullCmd, "cmd", null, null,false,null));
      const blocks = pollView?.blocks;
      const pollID = pollView?.poll_id;
      if (null === pollView || null === blocks) {
        // Branch the most common beginner mistakes into specific, actionable
        // errors instead of the generic err_invalid_command.
        let failText;
        if (question === null && options.length === 0) {
          failText = parameterizedString(stri18n(userLang, 'err_question_not_quoted'), {slack_command: slackCommand});
        } else if (options.length === 0) {
          failText = parameterizedString(stri18n(userLang, 'err_no_choices'), {slack_command: slackCommand});
        } else {
          failText = stri18n(userLang, 'err_invalid_command');
        }
        let mRequestBody = {
          token: context.botToken,
          channel: channel,
          user: userId,
          //blocks: blocks,
          text: `\`${fullCmd}\`\n` + failText
        };
        await postChat(body.response_url, 'ephemeral', mRequestBody);
        return;
      }

      if (blocks.length > 50) {
        // Slack hard-rejects chat messages with more than 50 blocks - reject
        // with advice instead of a cryptic post failure (verbose team configs
        // can hit this within the configured choice cap).
        let mRequestBody = {
          token: context.botToken,
          channel: channel,
          user: userId,
          text: "```" + fullCmd + "```\n" + parameterizedString(stri18n(userLang, 'err_too_many_blocks'), { count: blocks.length }),
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
            logger.debug(postRes);
            let mRequestBody = {
              token: context.botToken,
              channel: channel,
              user: userId,
              text: `Error while create poll: \`${fullCmd}\` \nERROR:${postRes.message}`
            };
            await postChat(body.response_url, 'ephemeral', mRequestBody);
          } catch (e) {
            //not able to dm user
            logger.warn(`Not able to DM user: ${e.message}`);
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
          const schTs = postTsParsed ?? new Date(postDateTime);

          // The poll record we just created is a TEMPLATE (a recipe for the
          // future post), not a posted poll. Clear schedule_end_active so the
          // close cron doesn't try to close a phantom at end-time. The actual
          // run record - created when the schedule fires - inherits
          // schedule_end_ts via createPollView and gets its own
          // schedule_end_active=true once posted.
          if (endDateTime !== null) {
            await pollCol.updateOne(
                { _id: new ObjectId(pollID) },
                { $set: { schedule_end_active: false } }
            );
          }

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
    // Best-effort user feedback - the command was acked, so without this the
    // user sees nothing at all when e.g. Mongo blips mid-command.
    try {
      await postChat(body?.response_url, 'ephemeral', {
        token: context?.botToken,
        channel: body?.channel_id,
        user: body?.user_id,
        text: stri18n(gAppLang, 'err_process_command'),
      });
    } catch (e2) { /* nothing more we can do */ }
  }
}

// Shared apply-edit pipeline used by both the CLI subcommand and the
// modal/GUI view submission. Caller is responsible for pre-flight checks
// (ownership, well-formed inputs, etc.) — this function only performs the
// DB update + view rebuild + chat.update under the per-message mutex.
//
// Returns: { ok: boolean, droppedCount: number, error: string|null }
async function applyPollEdit({ pollData, newQuestion, newOptions, editorUserId, targetChannel, targetTs, responseUrl }) {
  if (!pollData || !pollData.team) {
    return { ok: false, droppedCount: 0, error: 'not_posted' };
  }
  // Caller-provided target wins over DB-stored values. Live menu clicks give
  // us body.message.ts/channel.id directly — same source-of-truth pattern as
  // closePoll/deletePoll/btn_vote. Polls posted via response_url have ts:null
  // in the DB (response_url doesn't return one) but the click on the live
  // message reveals it.
  const channel = targetChannel || pollData.channel;
  const ts = targetTs || pollData.ts;
  if (!ts || !channel) {
    return { ok: false, droppedCount: 0, error: 'not_posted' };
  }
  if (!newQuestion || !Array.isArray(newOptions) || newOptions.length === 0) {
    return { ok: false, droppedCount: 0, error: 'no_question_or_options' };
  }

  // droppedCount is computed inside the mutex once we read votesCol —
  // that's the only place we can tell which positions actually had votes.
  let droppedCount = 0;

  const mutexKey = `${pollData.team}/${channel}/${ts}`;
  if (!mutexes.hasOwnProperty(mutexKey)) {
    mutexes[mutexKey] = new Mutex();
  }
  let release = null;
  let countTry = 0;
  do {
    ++countTry;
    try {
      release = await mutexes[mutexKey].acquire();
    } catch (e) {
      logger.info(`[Edit][Try #${countTry}] Error while attempt to acquire mutex lock.`, e);
    }
  } while (!release && countTry < 3);

  if (!release) return { ok: false, droppedCount, error: 'mutex' };

  try {
    const teamInfo = await getTeamInfo(pollData.team);
    const editBotToken = teamInfo?.bot?.token;
    if (!editBotToken) return { ok: false, droppedCount, error: 'no_bot_token' };

    // Auto-heal: if the live click revealed a ts/channel that the DB lacks
    // or disagrees with, persist them on the same write. Future CLI edits
    // (which can only consult pollData.ts) then work without a menu trip.
    const setOps = {
      question: newQuestion,
      options: newOptions,
      edited_ts: new Date(),
      edited_by: editorUserId,
    };
    if (ts !== pollData.ts) setOps.ts = ts;
    if (channel !== pollData.channel) setOps.channel = channel;
    await pollCol.updateOne(
        { _id: pollData._id },
        { $set: setOps }
    );

    const editTeamConfig = await getTeamOverride(pollData.team);
    const editUserLang = pollData.para?.user_lang || gAppLang;

    // Same value MUST flow through createPollView (block builder) and
    // updateVoteBlock (vote re-applier) for the structurally-significant
    // settings — see resolveFromPara module-level comment.
    const editIsMenuAtTheEnd = resolveFromPara(pollData, editTeamConfig, 'menu_at_the_end', gIsMenuAtTheEnd);
    const editIsCompactUI = resolveFromPara(pollData, editTeamConfig, 'compact_ui', gIsCompactUI);

    const pollView = (await createPollView(
        pollData.team, channel, editTeamConfig,
        newQuestion, newOptions,
        pollData.para?.anonymous ?? false,
        pollData.para?.limited,
        pollData.para?.limit,
        pollData.para?.hidden,
        pollData.para?.user_add_choice,
        editIsMenuAtTheEnd,
        editIsCompactUI,
        pollData.para?.show_divider,
        pollData.para?.show_help_link,
        pollData.para?.show_command_info,
        pollData.para?.true_anonymous,
        pollData.para?.add_number_emoji_to_choice,
        pollData.para?.add_number_emoji_to_choice_btn,
        pollData.schedule_end_ts,
        editUserLang,
        pollData.user_id,
        pollData.cmd, "edit", null, null,
        true, pollData._id
    ));

    let blocks = pollView?.blocks;
    if (!pollView || !blocks) return { ok: false, droppedCount, error: 'view_build_failed' };

    const isHidden = await getInfos(
        'hidden', blocks,
        { team: pollData.team, channel: channel, ts: ts },
    );

    // Re-key the vote map across the edit. Text-matching first means
    // votes follow an option no matter where it lands in the new order
    // (and a removed option's votes are dropped, not silently inherited
    // by whatever ends up at that index). The optional positional pass
    // preserves votes through pure renames per the team's policy.
    const voteData = await votesCol.findOne({ channel: channel, ts: ts });
    const oldPoll = voteData?.votes ?? {};
    const keepVotesOnRename = isEditKeepVotes(editTeamConfig);
    const remap = rebuildVoteMap(pollData.options, newOptions, oldPoll, keepVotesOnRename);
    droppedCount = remap.droppedCount;

    if (voteData) {
      // Persist the rebuilt map so future vote clicks (which use position
      // index) read the correct per-option voters.
      await votesCol.updateOne(
          { channel: channel, ts: ts },
          { $set: { votes: remap.newPoll } }
      );
    }

    blocks = await updateVoteBlock(
        pollData.team, channel, ts,
        blocks, remap.newPoll, editUserLang, isHidden, editIsCompactUI, editIsMenuAtTheEnd
    );

    const updateBody = {
      token: editBotToken,
      channel: channel,
      ts: ts,
      blocks: blocks,
      text: `Poll : ${newQuestion}`,
    };
    // Prefer the menu click's response_url for the chat.update — same
    // pattern closePoll/deletePoll use, and works regardless of bot
    // membership in the channel. Falls back to chat.update via the SDK
    // when no response_url is available (e.g., the CLI edit path).
    const postRes = await postChat(responseUrl || "", 'update', updateBody);
    if (postRes.status === false) {
      logger.warn(`[Edit] Failed to update poll ID:${pollData._id} in CH:${pollData.channel}: ${postRes.message}`);
      return { ok: false, droppedCount, error: postRes.message || 'chat_update_failed' };
    }

    logger.verbose(`[Edit] Poll ID:${pollData._id} edited by ${editorUserId}`);
    return { ok: true, droppedCount, error: null };
  } catch (e) {
    logger.error(`[Edit] Unexpected error editing poll ID:${pollData?._id}`);
    logger.error(e.toString() + "\n" + e.stack);
    return { ok: false, droppedCount, error: 'exception' };
  } finally {
    release();
  }
}

// RFC 4180 CSV field quoting: wrap with double-quotes if the value contains
// a comma, quote, or newline; double internal double-quotes.
function csvField(s) {
  s = String(s ?? '');
  // Formula-injection hardening: spreadsheet apps execute cells that start
  // with = + - @ (or tab/CR). Prefix a single quote so they import as text.
  if (/^[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Build a CSV string for a poll's metadata + summary + (if non-anonymous)
// per-vote rows. Single source of truth for the export format used by both
// the CLI subcommand and the menu action. nameMap (Map<userId, name>) is
// optional — if provided, "Name" column / metadata name rows are filled in;
// otherwise they show empty.
function buildPollCsv(pollData, voteData, nameMap) {
  const isAnonymous = !!(pollData?.para?.anonymous);
  const isTrueAnonymous = !!(pollData?.para?.true_anonymous);
  // Hide identities only when the in-app "see all voters" menu would also
  // refuse — i.e. anonymous + true_anonymous together. Plain anonymous polls
  // still let the creator see voters in the menu, so the export matches.
  const hideIdentities = isAnonymous && isTrueAnonymous;
  const opts = pollData?.options || [];
  const votes = voteData?.votes || {};
  const rows = [];
  const realOf = (uid) => (uid && nameMap && nameMap.get(uid)?.realName) || '';
  const displayOf = (uid) => (uid && nameMap && nameMap.get(uid)?.displayName) || '';

  rows.push('Poll ID,' + csvField(pollData?._id?.toString() || ''));
  rows.push('Question,' + csvField(pollData?.question || ''));
  rows.push('Created by,' + csvField(pollData?.user_id || ''));
  const creatorReal = realOf(pollData?.user_id);
  if (creatorReal) rows.push('Created by Real Name,' + csvField(creatorReal));
  const creatorDisplay = displayOf(pollData?.user_id);
  if (creatorDisplay) rows.push('Created by Display Name,' + csvField(creatorDisplay));
  if (pollData?.created_ts) {
    rows.push('Created at,' + csvField(new Date(pollData.created_ts).toISOString()));
  }
  if (pollData?.edited_ts) {
    rows.push('Last edited,' + csvField(new Date(pollData.edited_ts).toISOString()));
    rows.push('Edited by,' + csvField(pollData.edited_by || ''));
    const editorReal = realOf(pollData?.edited_by);
    if (editorReal) rows.push('Edited by Real Name,' + csvField(editorReal));
    const editorDisplay = displayOf(pollData?.edited_by);
    if (editorDisplay) rows.push('Edited by Display Name,' + csvField(editorDisplay));
  }
  rows.push('Anonymous,' + (isAnonymous ? 'true' : 'false'));
  if (isAnonymous) rows.push('True Anonymous,' + (isTrueAnonymous ? 'true' : 'false'));
  rows.push('');

  rows.push('Option,Vote count');
  for (let i = 0; i < opts.length; i++) {
    const voters = votes[String(i)] || [];
    rows.push(csvField(opts[i]) + ',' + String(voters.length));
  }
  rows.push('');

  // Per-voter detail. Always emitted so analysts can see the cross-tab
  // (which voter chose what). When hideIdentities is on, real Slack IDs
  // and names are replaced with USER-1, USER-2, … assigned in the order
  // each unique voter is first encountered (option index, then voter
  // position) so the labels are deterministic for a given snapshot.
  rows.push('User ID,Real Name,Display Name,Option');
  const labelMap = new Map();
  let nextLabel = 1;
  const labelOf = (uid) => {
    if (!labelMap.has(uid)) labelMap.set(uid, 'USER-' + nextLabel++);
    return labelMap.get(uid);
  };
  for (let i = 0; i < opts.length; i++) {
    const voters = votes[String(i)] || [];
    for (const voterId of voters) {
      if (hideIdentities) {
        rows.push(csvField(labelOf(voterId)) + ',,,' + csvField(opts[i]));
      } else {
        rows.push(
          csvField(voterId) + ',' +
          csvField(realOf(voterId)) + ',' +
          csvField(displayOf(voterId)) + ',' +
          csvField(opts[i])
        );
      }
    }
  }

  return rows.join('\n');
}

// Resolve display names for a Set/array of Slack user IDs via users.info.
// Returns Map<uid, {realName, displayName}>. Capped at `max` lookups to
// keep export latency bounded; beyond the cap the CSV simply leaves both
// name columns blank. Per-user failures (deleted user, scope hiccup, rate
// limit) leave that entry blank rather than aborting the whole export.
async function fetchVoterNames(client, botToken, userIds, max = 100) {
  const out = new Map();
  let n = 0;
  for (const uid of userIds) {
    if (!uid) continue;
    if (++n > max) break;
    try {
      const r = await client.users.info({ token: botToken, user: uid });
      const p = r?.user?.profile || {};
      out.set(uid, {
        realName: p.real_name || r?.user?.name || '',
        displayName: p.display_name || '',
      });
    } catch (e) {
      out.set(uid, { realName: '', displayName: '' });
    }
  }
  return out;
}

// Render the CSV inside an ephemeral message visible only to the requester.
// Slack message text caps at 40k chars; we keep a safe budget for the
// markdown fence + truncation notice. Larger polls get truncated rather
// than failing — file-upload delivery would need files:write scope which
// this app doesn't request.
// TODO(WIP): switch to files.uploadV2 once files:write scope is added —
// removes the 30k truncation and delivers a real .csv attachment.
//
// channel + user are passed in explicitly because slash-command body uses
// flat `body.channel_id`/`body.user_id` while action body uses nested
// `body.channel.id`/`body.user.id` — the helper can't safely do that
// resolution itself. Caller knows which shape it has.
const POLL_EXPORT_MAX_CHARS = 30000;
async function sendCsvExport(channel, user, context, client, pollData, voteData, userLang, responseUrl) {
  // Collect unique user IDs to look up: creator, editor (if any), and
  // every voter — except in true-anonymous mode where the per-voter
  // section uses USER-N labels and never needs real names.
  const isAnonymous = !!(pollData?.para?.anonymous);
  const isTrueAnonymous = !!(pollData?.para?.true_anonymous);
  const hideIdentities = isAnonymous && isTrueAnonymous;
  const ids = new Set();
  if (pollData?.user_id) ids.add(pollData.user_id);
  if (pollData?.edited_by) ids.add(pollData.edited_by);
  if (!hideIdentities) {
    const votes = voteData?.votes || {};
    for (const k of Object.keys(votes)) {
      for (const uid of (votes[k] || [])) ids.add(uid);
    }
  }
  let nameMap = null;
  if (client && context?.botToken && ids.size > 0) {
    try {
      nameMap = await fetchVoterNames(client, context.botToken, Array.from(ids));
    } catch (e) {
      logger.debug('[Export] name lookup failed: ' + (e?.message || e));
    }
  }

  const csv = buildPollCsv(pollData, voteData, nameMap);
  // A ``` inside the CSV (reachable via rich-text code blocks in question /
  // choices) would terminate the fence and garble the whole message. Break
  // every backtick PAIR with a zero-width space - visually identical, and
  // no run of any length can leave three adjacent backticks standing.
  const csvSafe = csv.replaceAll('``', '`​`');
  let payload;
  if (csvSafe.length > POLL_EXPORT_MAX_CHARS) {
    payload = '```' + csvSafe.substring(0, POLL_EXPORT_MAX_CHARS) + '\n' + stri18n(userLang, 'poll_export_truncated_marker') + '```\n' +
      parameterizedString(stri18n(userLang, 'poll_export_truncated'), { max: POLL_EXPORT_MAX_CHARS });
  } else {
    payload = '```' + csvSafe + '```';
  }
  const header = parameterizedString(stri18n(userLang, 'poll_export_header'), {
    poll_id: pollData?._id?.toString() || '',
  });
  await postChat(responseUrl || '', 'ephemeral', {
    token: context.botToken,
    channel: channel,
    user: user,
    text: header + '\n' + payload,
  });
}

// Look up vote data for a poll. Tries the indexed (channel, ts) filter
// first; falls back to a poll_id scan if pollData.ts is null (response_url
// poll that hasn't been auto-healed yet). poll_id is stored as a string
// in votesCol because it comes from JSON-parsed button values.
async function findVoteDataForPoll(pollData) {
  if (!pollData) return null;
  if (pollData.channel && pollData.ts) {
    const v = await votesCol.findOne({ channel: pollData.channel, ts: pollData.ts });
    if (v) return v;
  }
  if (pollData._id) {
    return await votesCol.findOne({ poll_id: pollData._id.toString() });
  }
  return null;
}

// Menu / action-button entry point for CSV export. Owner-only, same shape
// as deletePoll/closePoll. Uses body.message.ts/channel.id from the live
// click for both ownership locator and pollData auto-heal — see CLAUDE.md
// "Live click body is source of truth" rule.
async function exportPoll(body, client, context, value) {
  if (!body || !body.user || !body.user.id) return;

  const teamConfig = await getTeamOverride(getTeamOrEnterpriseId(body));
  let appLang = gAppLang;
  if (teamConfig.hasOwnProperty('app_lang')) appLang = teamConfig.app_lang;
  const userLang = value?.user_lang || appLang;

  const ephemeralReject = makeEphemeralReject(body, context, userLang);

  let pollData = null;
  try {
    pollData = await pollCol.findOne({ _id: new ObjectId(value.p_id) });
  } catch (e) { /* falls through */ }

  if (!pollData) { await ephemeralReject('poll_export_not_found'); return; }
  if (pollData.user_id !== body.user.id) { await ephemeralReject('poll_export_no_permission'); return; }

  // Auto-heal pollData.ts/channel from the live click. Future CLI exports
  // on this poll then have the right channel/ts for vote lookup.
  const liveTs = body?.message?.ts || null;
  const liveChannel = body?.channel?.id || null;
  if (liveTs && liveChannel && (pollData.ts !== liveTs || pollData.channel !== liveChannel)) {
    pollCol.updateOne(
      { _id: pollData._id },
      { $set: { ts: liveTs, channel: liveChannel } }
    ).catch(e => logger.debug('[Export][Heal] auto-heal failed: ' + (e?.message || e)));
    pollData.ts = liveTs;
    pollData.channel = liveChannel;
  }

  const voteData = await findVoteDataForPoll(pollData);
  await sendCsvExport(body?.channel?.id, body?.user?.id, context, client, pollData, voteData, userLang, body?.response_url || null);
}

// Menu entry point for "View on dashboard". The shared static_select option is
// visible to every channel member (Slack can't show a menu option to only some
// viewers — same constraint as CSV export), but only the poll CREATOR or the
// workspace INSTALLER gets a working link: anyone else is rejected and no token
// is minted. The link carries a short-lived HMAC token so the dashboard can open
// the poll under that user's permission-scoped viewer (never the admin view).
async function dashboardLinkAction(body, client, context, value) {
  if (!body || !body.user || !body.user.id) return;

  const teamId = getTeamOrEnterpriseId(body);
  const teamConfig = await getTeamOverride(teamId);
  let appLang = gAppLang;
  if (teamConfig.hasOwnProperty('app_lang')) appLang = teamConfig.app_lang;
  const userLang = value?.user_lang || appLang;
  const ephemeralReject = makeEphemeralReject(body, context, userLang);

  if (!gDashboardUrl || !gDashboardLinkSecret) { await ephemeralReject('dashboard_link_not_configured'); return; }

  let pollData = null;
  try {
    pollData = await pollCol.findOne({ _id: new ObjectId(value.p_id) });
  } catch (e) { /* falls through */ }
  if (!pollData) { await ephemeralReject('poll_export_not_found'); return; }

  // Gate: poll creator OR workspace installer (same identity facts as export +
  // the /poll config installer gate).
  const isCreator = pollData.user_id === body.user.id;
  let isInstaller = false;
  try {
    const tInfo = await getTeamInfo(teamId);
    isInstaller = !!(tInfo && tInfo.user && tInfo.user.id === body.user.id);
  } catch (e) { /* not installer */ }
  if (!isCreator && !isInstaller) { await ephemeralReject('dashboard_link_no_permission'); return; }

  const token = mintDashboardToken(pollData._id, body.user.id, teamId);
  const url = gDashboardUrl.replace(/\/+$/, '') + '/#/h/' + token;

  // Open a MODAL (popup) with the link button instead of posting an ephemeral
  // message — a modal adds NOTHING to the channel, keeping it clean. Every check
  // above is a fast local DB read, so we are within Slack's ~3s trigger_id window
  // for views.open. If it ever fails (e.g. an expired trigger), fall back to the
  // ephemeral link so the user still gets it.
  const dashTitle = stri18n(userLang, 'menu_view_on_dashboard');
  const linkButton = {
    type: 'button',
    text: { type: 'plain_text', text: dashTitle },
    style: 'primary',
    url,
    action_id: 'ignore_me',
  };
  try {
    await client.views.open({
      token: context.botToken,
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        // Modal title is capped at 24 chars by Slack — slice for long languages.
        title: { type: 'plain_text', text: dashTitle.length > 24 ? dashTitle.slice(0, 24) : dashTitle },
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: stri18n(userLang, 'dashboard_link_open') } },
          { type: 'actions', elements: [linkButton] },
        ],
      },
    });
  } catch (e) {
    logger.warn('dashboardLinkAction: views.open failed, falling back to ephemeral: ' + (e?.data?.error || e?.message || e));
    await postChat(body.response_url, 'ephemeral', {
      token: context.botToken,
      channel: body.channel?.id,
      user: body.user.id,
      text: stri18n(userLang, 'dashboard_link_open'),
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: stri18n(userLang, 'dashboard_link_open') },
        accessory: linkButton,
      }],
    });
  }
}

const createModalBlockInput = (userLang, isRichText, initialMrkdwn)  => {
    // rich_text_input branch: emit a rich_text editor. Optionally pre-fill via
    // initial_value (used by the edit modal in PR-C). rich_text_input does not
    // support a placeholder field.
    if (isRichText) {
      const block = {
        type: 'input',
        element: {
          type: 'rich_text_input',
        },
        label: {
          type: 'plain_text',
          text: ' ',
        },
      };
      if (typeof initialMrkdwn === 'string' && initialMrkdwn.length > 0) {
        block.element.initial_value = mrkdwnToRichText(initialMrkdwn);
      }
      return block;
    }
    // Default: plain_text_input — original behavior, also the kill-switch path
    // when enable_rich_text_input=false.
    const block = {
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
    };
    if (typeof initialMrkdwn === 'string' && initialMrkdwn.length > 0) {
      block.element.initial_value = initialMrkdwn;
    }
    return block;
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
  try {
    logger.info('Connecting to database server...');
    await mClient.connect();
    logger.info('Connected successfully to server');
  } catch (e) {
    logger.error('Failed to connect to MongoDB');
    logger.error(e.toString() + "\n" + e.stack);
    process.exit(1);
  }

  logger.info('Start database migration.');
  await migrations.init();
  await migrations.migrate();
  logger.info('End database migration.')

  logger.info('Check create DB index if not exist...');
  await createDBIndex();

  await app.start(process.env.PORT || port);

  logger.info('Bolt app is running!');

  logger.info('Check and start cron jobs.');
  // Verify every stored cron_string still parses under the current
  // cron-parser version before the minute scheduler starts firing.
  await auditSchedules({ scheduleCol, logger });
  // Schedule the task checker to run every minute
  cron.schedule('* * * * *', checkAndExecuteTasks, { noOverlap: true });
  // Cleanup every day
  cron.schedule('0 22 * * *', autoCleanupTask);

  // Start the task checker immediately (awaited so the startup run can never
  // overlap the first cron tick).
  await checkAndExecuteTasks();
  autoCleanupTask();

})();

app.action('btn_add_choice', async ({ action, ack, body, client, context }) => {
  // Ack first — Slack's 3-second clock starts the moment the event arrives.
  // Any I/O below runs after the ack so a slow Mongo or Slack call can't
  // trigger an ack timeout.
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
    logger.warn('btn_add_choice: missing required body fields');
    return;
  }

  // Read user_lang and the rich-text-input flag from the modal's private_metadata
  // — both are set when the modal is opened and preserved across updates so we
  // don't round-trip Mongo on every click. is_rich_text_input keeps a freshly-
  // added choice block consistent with the modal's existing inputs.
  let appLang = gAppLang;
  let isRichTextInput = gIsRichTextInput;
  try {
    const pm = JSON.parse(body.view.private_metadata);
    if (pm.user_lang) appLang = pm.user_lang;
    if (typeof pm.is_rich_text_input === 'boolean') isRichTextInput = pm.is_rich_text_input;
  } catch (e) { /* fall through to gAppLang / gIsRichTextInput */ }

  let blocks = body.view.blocks;
  const hash = body.view.hash;

  // Same caps as edit_add_choice: stop at the configured choice limit (the
  // submit handler would reject the extra rows anyway) and never cross
  // Slack's 100-block view ceiling - views.update would 400 silently and
  // the button would just appear dead.
  const choiceRows = blocks.filter(b => b.block_id?.startsWith('choice_') && !b.block_id.endsWith('_del')).length;
  if (choiceRows >= gSlackLimitChoices || blocks.length + 2 > SLACK_MODAL_MAX_BLOCKS) {
    if (blocks.some(b => b.block_id === 'btn_add_choice_warn')) return; // already warned
    if (blocks.length + 1 > SLACK_MODAL_MAX_BLOCKS) return; // even the warning wouldn't fit
    const warnText = choiceRows >= gSlackLimitChoices
        ? parameterizedString(stri18n(appLang, 'err_slack_limit_choices_max'), { slack_limit_choices: gSlackLimitChoices })
        : parameterizedString(stri18n(appLang, 'modal_edit_poll_max_blocks'), { max: SLACK_MODAL_MAX_BLOCKS });
    const warnBlocks = blocks.slice(0, blocks.length - 1).concat([{
      type: 'context',
      block_id: 'btn_add_choice_warn',
      elements: [{ type: 'mrkdwn', text: warnText }],
    }]).concat(blocks.slice(-1));
    try {
      await client.views.update({
        token: context.botToken,
        hash: hash,
        view_id: body.view.id,
        view: {
          type: body.view.type,
          private_metadata: body.view.private_metadata,
          callback_id: 'modal_poll_submit',
          title: body.view.title,
          submit: body.view.submit,
          close: body.view.close,
          blocks: warnBlocks,
          external_id: body.view.id,
        },
      });
    } catch (e) {
      logger.debug('btn_add_choice warn views.update failed:', e?.data?.error || e?.message || e);
    }
    return;
  }

  // Back under the caps: clear any stale warning from an earlier overflow.
  blocks = blocks.filter(b => b.block_id !== 'btn_add_choice_warn');

  let beginBlocks = blocks.slice(0, blocks.length - 1);
  let endBlocks = blocks.slice(-1);

  let tempModalBlockInput = JSON.parse(JSON.stringify(createModalBlockInput(appLang, isRichTextInput)));
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
    await client.views.update({
      token: context.botToken,
      hash: hash,
      view: view,
      view_id: body.view.id,
    });
  } catch (e) {
    // We already acked. The view simply doesn't update — most commonly a
    // hash_mismatch from rapid successive clicks racing the previous update.
    logger.debug('btn_add_choice views.update failed (user may click too fast):', e?.data?.error || e?.message || e);
  }
});
app.action('btn_del_choice', async ({ action, ack, body, client, context }) => {
  // Ack first — see btn_add_choice above for the rationale.
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
    logger.warn('btn_del_choice: missing required body fields');
    return;
  }

  // appLang isn't used here — we only filter blocks — but kept for symmetry
  // with btn_add_choice in case a future logger.* line wants the user lang.
  let blocks = body.view.blocks;
  const hash = body.view.hash;

  logger.debug("DEL:"+action.value);

  // Filter out the block that has a block_id starting with action.value.
  // Also clear the cap warning (if present) - deleting a row puts the modal
  // back under the limit, so the warning would otherwise be stale forever.
  blocks = blocks.filter(block => {
    if (block.block_id === 'btn_add_choice_warn') return false;
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
    await client.views.update({
      token: context.botToken,
      hash: hash,
      view: view,
      view_id: body.view.id,
    });
  } catch (e) {
    // We already acked. Most likely cause is hash_mismatch from rapid clicks.
    logger.debug('btn_del_choice views.update failed (user may click too fast):', e?.data?.error || e?.message || e);
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

    // Auto-heal pollData.ts/channel from the live click. Polls posted via
    // response_url have ts:null in pollCol because the response_url POST
    // doesn't return a message ts; the click on the live message gives us
    // the real one. Same source-of-truth pattern as closePoll. Fire-and-
    // forget so we don't slow down voting; the next vote retries if needed.
    if (poll_id && message?.ts && channel) {
      try {
        const pollOid = new ObjectId(poll_id);
        pollCol.updateOne(
          { _id: pollOid, $or: [{ ts: null }, { ts: '' }, { ts: { $ne: message.ts } }] },
          { $set: { ts: message.ts, channel: channel } }
        ).catch(e => logger.debug('[Vote][Heal] pollCol.ts auto-heal failed: ' + (e?.message || e)));
      } catch (e) { /* invalid ObjectId — ignore */ }
    }

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
          await notifyUser(body, context, stri18n(userLang, 'err_change_vote_poll_closed'), userLang);
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

        // limit > 0 (not just truthy): legacy polls stored with limit 0 or
        // negative must not brick voting or silently mean "unlimited".
        if (value.limited && value.limit > 0) {
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
            await notifyUser(body, context, parameterizedString(stri18n(userLang, 'err_vote_over_limit'), {limit: value.limit}), userLang);
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
          },
          // Per-vote timestamp trail. ADDITIVE and backward-compatible: the
          // authoritative `votes` map above is unchanged, so all existing app
          // code, old vote documents, and downstream readers keep working — old
          // polls simply have no `vote_events` (treat absent as "no timing
          // known"). No migration needed; new votes start appending events on
          // upgrade. One event per toggle so true vote-time analytics become
          // possible (the votes map alone carries no timestamps):
          //   u = voter id, o = option id, t = when (Date), a = '+' cast / '-' retract.
          $push: { vote_events: { u: user_id, o: value.id, t: new Date(), a: voteType } },
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
          // Anonymous votes show no name in the poll, so this is the voter's ONLY feedback
          // that their (un)vote registered — surface it as a modal popup when enabled
          // (right after the vote action, so a trigger_id is in hand), ephemeral otherwise.
          let mesStr = parameterizedString(stri18n(userLang, 'info_anonymous_vote'), {choice: ""});
          if (removeVote) mesStr = parameterizedString(stri18n(userLang, 'info_anonymous_unvote'), {choice: ""});
          await notifyUser(body, context, mesStr, userLang);
        }

      } catch (e) {
        logger.error(e);
        await notifyUser(body, context, stri18n(userLang, 'err_vote_exception'), userLang);
      } finally {
        release();
      }
    } else {
      await notifyUser(body, context, stri18n(userLang, 'err_vote_exception'), userLang);
    }
  } catch (e) {
    logger.error(`UNEXPECTED ERROR in btn_vote :` + e.message);
    logger.error(e.toString() + "\n" + e.stack);
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
      await notifyUser(body, context, stri18n(userLang, 'err_change_vote_poll_closed'), userLang);
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
                    await notifyUser(body, context, parameterizedString(stri18n(userLang, 'err_duplicate_add_choice'), {text: value}), userLang);
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
            logger.warn(`Not able to DM user: ${e.message}`);
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

        if (blocks.length + 1 > 50) {
          // +1 for the re-added add-choice section below. Slack rejects
          // messages over 50 blocks - stop cleanly instead of corrupting
          // the post with a failed update.
          let mRequestBody = {
            token: context.botToken,
            channel: body.channel.id,
            user: body.user.id,
            text: parameterizedString(stri18n(userLang, 'err_too_many_blocks'), { count: blocks.length + 1 }),
          };
          await postChat(body.response_url, 'ephemeral', mRequestBody);
          return;
        }

        let mRequestBody2 = {
          token: context.botToken,
          channel: channel,
          ts: message.ts,
          blocks: blocks,
          text: message.text
        };
        const firstUpdateRes = await postChat(body.response_url, 'update', mRequestBody2);

        //re-add add-choice section
        blocks.splice(newChoiceIndex + 1 + divSpace, 0, tempAddBlock);

        mRequestBody2 = {
          token: context.botToken,
          channel: channel,
          ts: message.ts,
          blocks: blocks,
          text: message.text
        };
        const secondUpdateRes = await postChat(body.response_url, 'update', mRequestBody2);

        if (firstUpdateRes?.status === false && secondUpdateRes?.status !== false) {
          // First render failed but the second (which sends the FULL final
          // blocks) healed it - the message is correct, just log it.
          logger.warn(`add_choice_after_post: first update failed but second healed it (CH:${channel} ts:${message.ts}): ${firstUpdateRes?.message ?? ''}`);
        }
        if (secondUpdateRes?.status === false) {
          // The FINAL render failed - do NOT persist the option, or the DB
          // and the visible poll would disagree (and a later rebuild would
          // resurrect a choice nobody can see today).
          logger.warn(`add_choice_after_post: message update failed (CH:${channel} ts:${message.ts}): ${firstUpdateRes?.message ?? ''} ${secondUpdateRes?.message ?? ''}`);
          await notifyUser(body, context, stri18n(userLang, 'err_add_choice_exception'), userLang);
          return;
        }

        //update polldata (awaited - a dropped write would silently lose the
        //choice from the DB while it shows on the live message)
        if (poll_id != null) {
          await pollCol.updateOne(
              {_id: new ObjectId(poll_id)},
              {$push: {options: value}}
          );
        }

      } catch (e) {
        logger.error(e);
        await notifyUser(body, context, stri18n(userLang, 'err_add_choice_exception'), userLang);
      } finally {
        release();
      }
    }

    return;
  } catch (e) {
    logger.error(`UNEXPECTED ERROR in add_choice_after_post :` + e.message);
    logger.error(e.toString() + "\n" + e.stack);
  }

});

app.shortcut('open_modal_new', async ({ shortcut, ack, context, client }) => {
  try {
    await ack();
    createModal(context, client, shortcut.trigger_id);
  } catch (e) {
    logger.error(`UNEXPECTED ERROR in open_modal_new :` + e.message);
    logger.error(e.toString() + "\n" + e.stack);
  }
});

async function createModal(context, client, trigger_id,response_url,channel,existingViewId) {
  try {
    const teamConfig = await getTeamOverride(getTeamOrEnterpriseId(context));
    let appLang= gAppLang;
    if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;
    // Resolve rich-text-input mode for this team. Default false. Per-team
    // override flips it on. The flag is then stamped into private_metadata so
    // every subsequent modal action (btn_add_choice, modal_select_when, etc.)
    // can read the same value without re-fetching team config.
    let isRichTextInput = gIsRichTextInput;
    if (teamConfig.hasOwnProperty("enable_rich_text_input")) isRichTextInput = teamConfig.enable_rich_text_input;
    let tempModalBlockInput = JSON.parse(JSON.stringify(createModalBlockInput(appLang, isRichTextInput)));
    tempModalBlockInput.block_id = 'choice_0';

    let tempModalBlockInput2 = JSON.parse(JSON.stringify(createModalBlockInput(appLang, isRichTextInput)));
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
      is_rich_text_input: isRichTextInput,
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

      const cmdOnlyView = {
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
      };
      const result = existingViewId
        ? await client.views.update({ token: context.botToken, view_id: existingViewId, view: cmdOnlyView })
        : await client.views.open({ token: context.botToken, trigger_id: trigger_id, view: cmdOnlyView });
      return;

    }

    let blocks = [
      {
        // Poll-type selector (default single). Switching to "Multi-question form"
        // swaps to the multi-question builder (handled by app.action('mq_poll_type')).
        // It's a SECTION accessory (not an input), so the legacy submit never sees it.
        type: 'section',
        block_id: 'mq_poll_type_blk',
        text: { type: 'mrkdwn', text: `*${stri18n(appLang, 'mq_poll_type')}*` },
        accessory: {
          type: 'static_select',
          action_id: 'mq_poll_type',
          // Reuse the translated multi-question keys (present in all 11 langs).
          initial_option: { text: { type: 'plain_text', text: stri18n(appLang, 'mq_type_single') }, value: 'single' },
          options: [
            { text: { type: 'plain_text', text: stri18n(appLang, 'mq_type_single') }, value: 'single' },
            { text: { type: 'plain_text', text: stri18n(appLang, 'mq_type_multi') }, value: 'multi' },
          ],
          // Warn before switching — swapping the modal clears whatever was entered.
          // If the user denies, Slack reverts the dropdown and nothing is lost.
          confirm: {
            title: { type: 'plain_text', text: stri18n(appLang, 'mq_switch_title') },
            text: { type: 'mrkdwn', text: stri18n(appLang, 'mq_switch_text') },
            confirm: { type: 'plain_text', text: stri18n(appLang, 'mq_switch_ok') },
            deny: { type: 'plain_text', text: stri18n(appLang, 'mq_switch_deny') },
          },
        },
      },
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
          // Input (not actions) so submit errors can anchor to 'channel'
          // right next to the selector; dispatch_action keeps the
          // modal_poll_channel action firing on selection as before.
          type: 'input',
          dispatch_action: true,
          // optional: Slack would otherwise hard-require a fresh selection at
          // submit even when the channel was already captured into
          // private_metadata; our own err_channel_missing check covers the
          // genuinely-missing case.
          optional: true,
          block_id: 'channel',
          label: {
            type: 'plain_text',
            text: stri18n(appLang,'modal_ch_select'),
          },
          element: {
            type: 'conversations_select',
            filter: {
              include: ['private','public']
            },
            action_id: 'modal_poll_channel',
            // Pre-select the channel the command ran in (when known) so it's the
            // default and survives a poll-type swap; also makes selected_conversation
            // non-null at submit so it doesn't clobber private_metadata.channel.
            ...(channel ? { initial_conversation: channel } : {}),
            placeholder: {
              type: 'plain_text',
              text: stri18n(appLang,'modal_ch_select'),
            },
          },
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
    // Auto-close options. Submit handler reads block_id='poll_end' as a static
    // select with values 'never' / 'schedule'; the matching 'poll_end_ts'
    // datetimepicker is inserted dynamically by modal_select_poll_end below.
    const closeNeverBlock = {
      "text": {
        "type": "plain_text",
        "text": stri18n(appLang,'task_scheduled_close_never'),
        "emoji": true
      },
      "value": "never"
    };
    const closeScheduleBlock = {
      "text": {
        "type": "plain_text",
        "text": stri18n(appLang,'task_scheduled_close_at'),
        "emoji": true
      },
      "value": "schedule"
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
        "type": "input",
        "dispatch_action": true,
        "element": {
          "type": "static_select",
          "action_id": "modal_select_poll_end",
          "options": [
            closeNeverBlock, closeScheduleBlock
          ],
          "initial_option": closeNeverBlock,
        },
        "label": {
          "type": "plain_text",
          "text": stri18n(appLang,'task_scheduled_close_when'),
          "emoji": true
        },
        "block_id": 'poll_end',
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
        // The element type flips with the rich-text-input flag. rich_text_input
        // doesn't accept a placeholder; plain_text_input keeps the original hint.
        element: isRichTextInput
          ? { type: 'rich_text_input' }
          : {
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
    const viewPayload = {
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
    };
    // existingViewId set ⇒ we're swapping an open modal back to single-question:
    // update in place (reliable) instead of opening a new modal.
    const result = existingViewId
      ? await client.views.update({ token: context.botToken, view_id: existingViewId, view: viewPayload })
      : await client.views.open({ token: context.botToken, trigger_id: trigger_id, view: viewPayload });
  } catch (error) {
    logger.error(error);
  }
}

app.action('modal_select_when', async ({ action, ack, body, client, context }) => {
  try {
    await ack();

    //console.log(action);
    //console.log(body);
    if (!action?.selected_option?.value) {
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
  }
});

// Toggle poll_end_ts datetimepicker right after the poll_end static select
// based on the user's choice (never / schedule). Mirrors the modal_select_when
// pattern above, but isolated to the poll_end -> poll_end_ts pair.
app.action('modal_select_poll_end', async ({ action, ack, body, client, context }) => {
  try {
    await ack();

    if (
        !action
        || !action.selected_option?.value
    ) {
      return;
    }

    const isSchedule = (action.selected_option.value === 'schedule');
    const teamConfig = await getTeamOverride(getTeamOrEnterpriseId(body));
    let appLang = gAppLang;
    if (teamConfig.hasOwnProperty('app_lang')) appLang = teamConfig.app_lang;

    let blocks = body.view.blocks;
    let blockPointer = 0;
    for (const i in blocks) {
      const b = blocks[i];
      if (b?.block_id === 'poll_end') {
        const nextIndex = blockPointer + 1;
        const nextIsPicker = blocks[nextIndex]?.block_id === 'poll_end_ts';
        if (isSchedule) {
          if (!nextIsPicker) {
            const dateTimeInput = {
              "type": "input",
              "block_id": 'poll_end_ts',
              "element": {
                "type": "datetimepicker",
              },
              "label": {
                "type": "plain_text",
                "text": stri18n(appLang, 'task_scheduled_close_on'),
                "emoji": true
              }
            };
            const beginBlocks = blocks.slice(0, blockPointer + 1);
            const endBlocks = blocks.slice(blockPointer + 1);
            blocks = beginBlocks.concat([dateTimeInput], endBlocks);
          }
        } else {
          if (nextIsPicker) {
            const beginBlocks = blocks.slice(0, blockPointer + 1);
            const endBlocks = blocks.slice(blockPointer + 2);
            blocks = beginBlocks.concat(endBlocks);
          }
        }
        break;
      }
      blockPointer++;
    }

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
      await client.views.update({
        token: context.botToken,
        hash: body.view.hash,
        view: view,
        view_id: body.view.id,
      });
    } catch (e) {
      logger.debug("Error on modal_select_poll_end (maybe user click too fast)");
    }
  } catch (e) {
    logger.error(`UNEXPECTED ERROR in modal_select_poll_end :` + e.message);
    logger.error(e.toString() + "\n" + e.stack);
  }
});

app.action('modal_poll_channel', async ({ action, ack, body, client, context }) => {
  try {
    await ack();

    if (!action || (!action.selected_channel && !action.selected_conversation)) {
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

    // Same readInputAsMrkdwn at module scope auto-discriminates plain_text_input
    // (option.value) and rich_text_input (option.rich_text_value). Flag is in
    // private_metadata.is_rich_text_input but the reader doesn't need it — the
    // input element decides which field is populated.
    const optionBlockIds = [];
    if (state.values) {
      for (const optionName in state.values) {
        const option = state.values[optionName][Object.keys(state.values[optionName])[0]];
        if ('question' === optionName) {
          // Trim to match edit_poll_submit - rich-text inputs make trailing
          // newlines easy to produce accidentally.
          question = (readInputAsMrkdwn(option) ?? '').trim();
        } else if ('user_lang' === optionName) {
          if (langList.hasOwnProperty(option.selected_option.value)) {
            userLang = option.selected_option.value;
          }
        } else if ('limit' === optionName) {
          limit = parseInt(option.value, 10);
        } else if (optionName.startsWith('choice_')) {
          const choiceVal = (readInputAsMrkdwn(option) ?? '').trim();
          if (choiceVal !== '') {
            options.push(choiceVal);
            optionBlockIds.push(optionName);
          }
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
      // Anchor to poll_end_ts only when that block actually exists in the
      // view - otherwise Slack silently drops the error and the modal looks
      // stuck (the picker block appears asynchronously after re-select).
      const endErrTarget = view.blocks?.some(b => b.block_id === 'poll_end_ts') ? 'poll_end_ts' : 'poll_end';
      let ackErr = {
        response_action: 'errors',
        errors: {},
      };
      // The re-select hint must name the AUTO-CLOSE dropdown's option label
      // (task_scheduled_close_at), not the Post-on one - they only happen to
      // both read "Schedule" in English.
      ackErr.errors[endErrTarget] = parameterizedString(stri18n(appLang, 'task_scheduled_time_missing'),{task_scheduled_later:stri18n(appLang, 'task_scheduled_close_at')});
      await ack(ackErr);
      return;
    }

    // Duplicate choices would render as indistinguishable vote buttons -
    // reject with the error anchored to the duplicated row.
    const seenChoices = new Set();
    for (let ci = 0; ci < options.length; ci++) {
      if (seenChoices.has(options[ci])) {
        let ackErr = { response_action: 'errors', errors: {} };
        ackErr.errors[optionBlockIds[ci]] = stri18n(appLang, 'err_duplicate_choice');
        await ack(ackErr);
        return;
      }
      seenChoices.add(options[ci]);
    }

    // 0/negative limits either brick voting or silently mean "unlimited"
    // while the header claims a limit - clamp to a sane floor.
    if (isNaN(limit) || limit < 1) limit = 1;
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
          channel: stri18n(appLang, 'err_channel_missing'),
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

      // Reject a past post time (60s grace for "post right now" picks) - it
      // would fire within the next cron minute while the confirmation claims
      // it was scheduled for the chosen past date.
      if (schTs.getTime() < Date.now() - 60 * 1000) {
        const whenErrTarget = view.blocks?.some(b => b.block_id === 'task_when_ts') ? 'task_when_ts' : 'task_when';
        let ackErr = { response_action: 'errors', errors: {} };
        ackErr.errors[whenErrTarget] = parameterizedString(stri18n(appLang, 'err_time_in_past'), { value: schTs.toISOString() });
        await ack(ackErr);
        return;
      }
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

    // Auto-close time must be in the future AND after the post time. This
    // catches user mistakes (picked yesterday, picked before "Post on") that
    // would otherwise produce a useless / immediately-firing close.
    if (endTs !== null) {
      const nowDate = new Date();
      if (endTs <= nowDate || (schTs !== null && endTs <= schTs)) {
        await ack({
          response_action: 'errors',
          errors: {
            poll_end_ts: stri18n(appLang, 'err_close_before_post'),
          },
        });
        return;
      }
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

    let cmd_via;
    if (response_url !== undefined && response_url !== "") cmd_via = "modal_auto"
    else cmd_via = "modal_manual";

    let isUserAllowDM = isAppAllowDM;

    if (options.length > gSlackLimitChoices) {

      let ackErr = {
        response_action: 'errors',
        errors: {
        },
      };
      ackErr.errors[elementToAlert] = parameterizedString(stri18n(appLang, 'err_slack_limit_choices_max'), {slack_limit_choices: gSlackLimitChoices});
      await ack(ackErr);

      const uConfigReject = await getUserConfig(teamOrEntId,userId);
      if(uConfigReject?.config?.hasOwnProperty('user_allow_dm')) {
        isUserAllowDM = uConfigReject.config.user_allow_dm;
      }
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
          logger.warn(`Not able to DM user: ${e.message}`);
        }
      }

      return;
    }

    // All validations passed - close the modal NOW. The Mongo + Slack I/O
    // below can exceed Slack's 3-second view_submission window; a late ack
    // shows the user "We had some trouble connecting" while the poll WAS
    // posted, and resubmitting then creates a duplicate.
    await ack();
    isAck = true;

    let uConfig = await getUserConfig(teamOrEntId,userId);
    if(uConfig?.config?.hasOwnProperty('user_allow_dm')) {
      isUserAllowDM = uConfig.config.user_allow_dm;
    }

    const pollView = await createPollView(teamOrEntId, channel, teamConfig, question, options, isAnonymous, isLimited, limit, isHidden, isAllowUserAddChoice, isMenuAtTheEnd, isCompactUI, isShowDivider, isShowHelpLink, isShowCommandInfo, isTrueAnonymous, isShowNumberInChoice, isShowNumberInChoiceBtn, endTs, userLang, userId, cmd, cmd_via, null, null,false,null);
    const blocks = pollView?.blocks;
    const pollID = pollView?.poll_id;

    if (null == pollView || null == blocks) {
      // Post-ack: the modal is already closed, so failures report via
      // ephemeral instead of response_action errors.
      let mRequestBody = {
        token: context.botToken,
        channel: channel,
        user: userId,
        text: stri18n(appLang, 'err_process_command'),
      };
      await postChat(response_url, 'ephemeral', mRequestBody);
      return;
    }

    if (blocks.length > 50) {
      // Slack hard-rejects chat messages with more than 50 blocks. Reject
      // with advice instead of letting the post fail with a cryptic error.
      let mRequestBody = {
        token: context.botToken,
        channel: channel,
        user: userId,
        text: parameterizedString(stri18n(appLang, 'err_too_many_blocks'), { count: blocks.length }),
      };
      await postChat(response_url, 'ephemeral', mRequestBody);
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
        const failText = parameterizedString(stri18n(appLang, 'err_poll_create_failed'), { error: postRes.message ?? '' });
        let mRequestBody = {
          token: context.botToken,
          channel: channel,
          user: userId,
          text: failText,
        };
        await postChat(response_url, 'ephemeral', mRequestBody);

        if(isUserAllowDM) {
          try {
            // url "" forces the Web API path so this is a real DM (the old
            // response_url variant posted into the channel instead).
            let dmRequestBody = {
              token: context.botToken,
              channel: userId,
              text: `\`\`\`${cmd}\`\`\`\n` + failText
            };
            await postChat("", 'post', dmRequestBody);
          } catch (e) {
            //not able to dm user
            logger.warn(`Not able to DM user: ${e.message}`);
            logger.debug(postRes);
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

        // Same template-record fix as the cmd handler: this poll record is a
        // recipe, not a posted poll. Clear schedule_end_active so the close
        // cron doesn't try to close a phantom. The run record - created when
        // the schedule fires - inherits schedule_end_ts and sets its own
        // schedule_end_active=true once posted.
        if (endTs !== null) {
          await pollCol.updateOne(
              { _id: new ObjectId(pollID) },
              { $set: { schedule_end_active: false } }
          );
        }

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
        // Already acked - report via ephemeral only.
        logger.error(`[Schedule] New task create from UI (PollID:${pollID}) ERROR`);
        logger.error(e);
        let mRequestBody = {
          token: context.botToken,
          channel: channel,
          user: userId,
          text: stri18n(appLang, 'err_schedule_create_failed')
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
  }
});

app.view('modal_delete_confirm', async ({ ack, body, view, context }) => {
  try {
    await ack();
    const privateMetadata = JSON.parse(view.private_metadata);
    await deletePollConfirm(body, context, privateMetadata);
  } catch (e) {
    logger.error(`UNEXPECTED ERROR in modal_delete_confirm :` + e.message);
    logger.error(e.toString() + "\n" + e.stack);
  }
});
function createCmdFromInfos(question, options, isAnonymous, isLimited, limit, isHidden, isAllowUserAddChoice, userLang, postDateTime, endisoStr) {
  let cmd = `/${slackCommand}`;
  if (isAnonymous) {
    cmd += ` anonymous`
  }
  if (isLimited) {
    // Always emit the number: a bare `limit` followed by another flag word
    // is ambiguous to read and relies on parser fall-through.
    cmd += ` limit ${limit > 1 ? limit : 1}`
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

async function createPollView(teamOrEntId,channel, teamConfig, question, options, isAnonymous, isLimited, limit, isHidden, isAllowUserAddChoice, isMenuAtTheEnd, isCompactUI, isShowDivider, isShowHelpLink, isShowCommandInfo, isTrueAnonymous, isShowNumberInChoice, isShowNumberInChoiceBtn, endDateTime, userLang, userId, cmd,cmd_via,cmd_via_ref,cmd_via_note,is_update,exist_poll_id) {
  if (
    !question
    || !options
    || 0 === options.length
  ) {
    return null;
  }

  if(teamConfig == null) teamConfig = await getTeamOverride(teamOrEntId);

  let displayPollerName = gDisplayPollerName;
  if (teamConfig.hasOwnProperty("display_poller_name")) displayPollerName = teamConfig.display_poller_name;


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
      }, ...(isPollEditEnabled(teamConfig) ? [{
        text: {
          type: 'plain_text',
          text: stri18n(userLang, 'menu_edit_poll'),
        },
        value: JSON.stringify({action: 'btn_edit', p_id: pollID, user: userId, user_lang: userLang}),
      }] : []), ...(isShowCsvExport(teamConfig) ? [{
        text: {
          type: 'plain_text',
          text: stri18n(userLang, 'menu_export_csv'),
        },
        value: JSON.stringify({action: 'btn_export', p_id: pollID, user: userId, user_lang: userLang}),
      }] : []), ...(isShowDashboardLink(teamConfig) ? [{
        text: {
          type: 'plain_text',
          text: stri18n(userLang, 'menu_view_on_dashboard'),
        },
        value: JSON.stringify({action: 'btn_dashboard', p_id: pollID, user: userId, user_lang: userLang}),
      }] : [])
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
        placeholder: { type: 'plain_text', text: stri18n(userLang, 'info_menu_placeholder') },
        action_id: 'static_select_menu',
        option_groups: staticSelectElements,
      },
    });
  }

  let info_by = "";
  switch (displayPollerName)
  {
    case "tag":
      info_by = parameterizedString(stri18n(userLang,'info_by'),{user_id:userId})
          break;
    case "none":
      info_by = "";
      break;
    default:
        //not impliment

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
  if(info_by!=="")
  {
    elements.push({
      type: 'mrkdwn',
      text: info_by
    });
  }
  if(elements.length>0)
  {
    blocks.push({
      type: 'context',
      elements: elements,
    });
  }
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
  else if ('btn_edit' === value.action)
    editPollOpenModal(body, client, context, value);
  else if ('btn_export' === value.action)
    exportPoll(body, client, context, value);
  else if ('btn_dashboard' === value.action)
    dashboardLinkAction(body, client, context, value);
}

// Build a single option-input row for the edit modal: an input element
// pre-filled with `value`, paired with a 🗑 delete button accessory in a
// section block. Each row has a unique block_id so views.update can append
// or remove rows without colliding with the existing ones.
//
// Element type flips with the per-team enable_rich_text_input flag (PR-C):
// rich_text_input pre-filled via mrkdwnToRichText (so old polls' stored
// mrkdwn renders correctly in the editor) when on; plain_text_input
// pre-filled with the raw string when off (kill-switch path).
function buildEditOptionRow(userLang, optionValue, isRichText) {
  const blockId = 'edit_choice_' + uuidv4();
  let element;
  if (isRichText) {
    element = {
      type: 'rich_text_input',
      action_id: 'edit_choice_input',
    };
    if (typeof optionValue === 'string' && optionValue.length > 0) {
      element.initial_value = mrkdwnToRichText(optionValue);
    }
  } else {
    element = {
      type: 'plain_text_input',
      action_id: 'edit_choice_input',
      initial_value: optionValue ?? '',
      placeholder: { type: 'plain_text', text: stri18n(userLang, 'modal_input_choice') },
    };
  }
  const inputBlock = {
    type: 'input',
    block_id: blockId,
    element,
    label: { type: 'plain_text', text: ' ' },
    optional: true,
  };
  const deleteBlock = {
    type: 'section',
    block_id: blockId + '_del',
    text: { type: 'mrkdwn', text: ' ' },
    accessory: {
      type: 'button',
      action_id: 'edit_del_choice',
      value: blockId,
      text: { type: 'plain_text', text: '🗑', emoji: true },
    },
  };
  return [inputBlock, deleteBlock];
}

async function editPollOpenModal(body, client, context, value) {
  if (!body || !body.user || !body.user.id || !body.trigger_id) return;

  // Re-check ownership against the DB rather than trusting the value blob.
  // The static_select is rendered for every viewer, so a non-owner can click
  // it; we must reject before opening the modal.
  let pollData = null;
  try {
    pollData = await pollCol.findOne({ _id: new ObjectId(value.p_id) });
  } catch (e) { /* falls through */ }

  const teamConfig = await getTeamOverride(getTeamOrEnterpriseId(body));
  let appLang = gAppLang;
  if (teamConfig.hasOwnProperty('app_lang')) appLang = teamConfig.app_lang;
  const userLang = value.user_lang || appLang;
  // Resolve rich-text-input mode for the edit modal — same flag, same chain
  // (server default -> team override) as createModal in PR-B.
  let isRichTextInput = gIsRichTextInput;
  if (teamConfig.hasOwnProperty('enable_rich_text_input')) isRichTextInput = teamConfig.enable_rich_text_input;

  const ephemeralReject = makeEphemeralReject(body, context, userLang);

  if (!isPollEditEnabled(teamConfig)) { await ephemeralReject('poll_edit_disabled'); return; }
  if (!pollData) { await ephemeralReject('poll_edit_not_found'); return; }
  if (pollData.user_id !== body.user.id) { await ephemeralReject('err_action_other'); return; }

  // Source of truth for the actual Slack message: the live menu click. Same
  // pattern closePoll/deletePoll/btn_vote use, so this works for any poll
  // regardless of how it was created (cmd, modal, or scheduled). Polls
  // posted via response_url have ts:null in pollCol because response_url
  // doesn't return a message ts — but the click on the live message gives
  // us the real one.
  const liveTs = body?.message?.ts || null;
  const liveChannel = body?.channel?.id || null;
  const targetTs = liveTs || pollData.ts;
  const targetChannel = liveChannel || pollData.channel;
  if (!targetTs || !targetChannel || !pollData.team) { await ephemeralReject('poll_edit_not_posted'); return; }

  // Auto-heal pollData.ts/channel from the live click so future CLI edits
  // (which can only consult pollData) work without going through the menu.
  // Best-effort fire-and-forget — a missed heal at this stage will be
  // re-attempted on the next interaction or persisted by applyPollEdit on
  // submit.
  if (liveTs && liveChannel && (pollData.ts !== liveTs || pollData.channel !== liveChannel)) {
    pollCol.updateOne(
      { _id: pollData._id },
      { $set: { ts: liveTs, channel: liveChannel } }
    ).catch(e => logger.debug('[Edit][Heal] pollCol.ts auto-heal failed: ' + (e?.message || e)));
    pollData.ts = liveTs;
    pollData.channel = liveChannel;
  }

  // Guard the initial-open path against the same Slack 100-block ceiling.
  // Layout is 5 fixed blocks + 2 per option + 1 trailing actions block, so
  // N options fit when 6 + 2N <= 100 -> N <= 47. Past that, views.open
  // would 400 silently. Only reachable if a self-host operator raised
  // gSlackLimitChoices above this ceiling AND the poll actually has that
  // many options.
  const fixedBlocks = 6; // intro section + divider + question input + divider + choices header + trailing actions
  const maxOptionsInModal = Math.floor((SLACK_MODAL_MAX_BLOCKS - fixedBlocks) / 2);
  const optionCount = (pollData.options || []).length;
  if (optionCount > maxOptionsInModal) {
    if (body.channel?.id) {
      await postChat('', 'ephemeral', {
        token: context.botToken,
        channel: body.channel.id,
        user: body.user.id,
        text: parameterizedString(stri18n(userLang, 'poll_edit_too_many_options'), {
          count: optionCount,
          max: maxOptionsInModal,
          slack_command: slackCommand,
        }),
      });
    }
    return;
  }
  {
    const win = isWithinEditWindow(pollData, teamConfig);
    if (!win.ok) {
      if (body.channel?.id) {
        await postChat('', 'ephemeral', {
          token: context.botToken,
          channel: body.channel.id,
          user: body.user.id,
          text: parameterizedString(stri18n(userLang, 'poll_edit_too_old'), { minutes: win.maxMins }),
        });
      }
      return;
    }
  }

  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: stri18n(userLang, 'modal_edit_poll_intro') },
    },
    { type: 'divider' },
    {
      type: 'input',
      block_id: 'edit_question',
      label: { type: 'plain_text', text: stri18n(userLang, 'modal_input_question_text') },
      element: isRichTextInput
        ? (() => {
            const el = {
              type: 'rich_text_input',
              action_id: 'edit_question_input',
            };
            if (typeof pollData.question === 'string' && pollData.question.length > 0) {
              el.initial_value = mrkdwnToRichText(pollData.question);
            }
            return el;
          })()
        : {
            type: 'plain_text_input',
            action_id: 'edit_question_input',
            initial_value: pollData.question ?? '',
            placeholder: { type: 'plain_text', text: stri18n(userLang, 'modal_input_question_hint') },
          },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: stri18n(userLang, 'modal_input_choice_text') },
    },
  ];

  for (const opt of (pollData.options || [])) {
    for (const b of buildEditOptionRow(userLang, opt, isRichTextInput)) blocks.push(b);
  }

  // Trailing "Add option" actions block — keep it last so the dynamic
  // add handler can simply splice new rows in just before it.
  blocks.push({
    type: 'actions',
    block_id: 'edit_add_choice_actions',
    elements: [{
      type: 'button',
      action_id: 'edit_add_choice',
      text: { type: 'plain_text', text: stri18n(userLang, 'modal_input_choice_add'), emoji: true },
    }],
  });

  const privateMetadata = {
    poll_id: pollData._id.toString(),
    user_lang: userLang,
    // Forward the live click's target so applyPollEdit on submit doesn't have
    // to re-derive it from pollData (which would be missing ts for response_url
    // polls). response_url is the menu click's URL, valid 30 min from this
    // click — well within the modal-fill-and-submit window.
    channel: targetChannel,
    ts: targetTs,
    response_url: body?.response_url || null,
    // Stamp the flag so edit_add_choice keeps dynamic-add rows consistent
    // with the surrounding inputs and the submit handler can treat the value
    // shape correctly even if the team config flips mid-modal.
    is_rich_text_input: isRichTextInput,
  };

  try {
    await client.views.open({
      token: context.botToken,
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'edit_poll_submit',
        private_metadata: JSON.stringify(privateMetadata),
        title: { type: 'plain_text', text: stri18n(userLang, 'modal_edit_poll_title') },
        submit: { type: 'plain_text', text: stri18n(userLang, 'modal_edit_poll_submit') },
        close: { type: 'plain_text', text: stri18n(userLang, 'btn_cancel') },
        blocks: blocks,
      },
    });
  } catch (e) {
    logger.warn('[Edit] views.open failed: ' + (e?.data?.error || e?.message || e));
  }
}

// Dynamic add: append one fresh empty option row just before the trailing
// "Add option" actions block. Mirrors the create-modal btn_add_choice flow.
// Slack hard limit: a single view may contain at most 100 blocks. Each
// option row is 2 blocks (input + 🗑 section), so without a guard a user
// could click "Add option" enough times to silently overflow this limit
// — views.update would 400 and the click would appear to do nothing.
const SLACK_MODAL_MAX_BLOCKS = 100;

app.action('edit_add_choice', async ({ ack, body, client, context }) => {
  await ack();
  if (!body || !body.view || !body.view.blocks || !body.view.id || !body.view.hash) return;

  let userLang = gAppLang;
  let isRichTextInput = gIsRichTextInput;
  try {
    const pm = JSON.parse(body.view.private_metadata || '{}');
    if (pm.user_lang) userLang = pm.user_lang;
    if (typeof pm.is_rich_text_input === 'boolean') isRichTextInput = pm.is_rich_text_input;
  } catch (e) { /* fall through */ }

  const currentBlocks = body.view.blocks.slice();

  // If we're already at the limit, swap the trailing actions block in place
  // (so we don't add 2 more). If we're at limit-1 (an odd block count would
  // be unusual but defensively handled), inject a one-line warning context
  // block in place of the new row. Either way we surface the cap visibly
  // instead of letting views.update 400 silently.
  // +2 because each row adds 2 blocks. +1 if there's no warning block yet
  // and we'd want to add one.
  const wouldExceed = currentBlocks.length + 2 > SLACK_MODAL_MAX_BLOCKS;
  if (wouldExceed) {
    // Insert a one-shot warning context just above the trailing actions
    // block so the user understands why "Add option" stopped working. The
    // block_id keeps it idempotent (we don't add more than one warning).
    const hasWarning = currentBlocks.some(b => b.block_id === 'edit_add_choice_warn');
    if (hasWarning) return; // already warned, nothing more to do
    const insertAt = currentBlocks.findIndex(b => b.block_id === 'edit_add_choice_actions');
    const warningBlock = {
      type: 'context',
      block_id: 'edit_add_choice_warn',
      elements: [{
        type: 'mrkdwn',
        text: parameterizedString(stri18n(userLang, 'modal_edit_poll_max_blocks'), { max: SLACK_MODAL_MAX_BLOCKS }),
      }],
    };
    if (insertAt === -1) currentBlocks.push(warningBlock);
    else currentBlocks.splice(insertAt, 0, warningBlock);
    try {
      await client.views.update({
        token: context.botToken,
        hash: body.view.hash,
        view_id: body.view.id,
        view: {
          type: body.view.type,
          callback_id: 'edit_poll_submit',
          private_metadata: body.view.private_metadata,
          title: body.view.title,
          submit: body.view.submit,
          close: body.view.close,
          blocks: currentBlocks,
          external_id: body.view.id,
        },
      });
    } catch (e) {
      logger.debug('edit_add_choice limit-warn views.update failed: ' + (e?.data?.error || e?.message || e));
    }
    return;
  }

  const blocks = currentBlocks;
  const insertAt = blocks.findIndex(b => b.block_id === 'edit_add_choice_actions');
  const newRow = buildEditOptionRow(userLang, '', isRichTextInput);
  if (insertAt === -1) {
    for (const b of newRow) blocks.push(b);
  } else {
    blocks.splice(insertAt, 0, ...newRow);
  }

  try {
    await client.views.update({
      token: context.botToken,
      hash: body.view.hash,
      view_id: body.view.id,
      view: {
        type: body.view.type,
        callback_id: 'edit_poll_submit',
        private_metadata: body.view.private_metadata,
        title: body.view.title,
        submit: body.view.submit,
        close: body.view.close,
        blocks: blocks,
        external_id: body.view.id,
      },
    });
  } catch (e) {
    logger.debug('edit_add_choice views.update failed: ' + (e?.data?.error || e?.message || e));
  }
});

// Dynamic remove: drop the input block whose id matches action.value, plus
// its paired _del section block.
app.action('edit_del_choice', async ({ ack, action, body, client, context }) => {
  await ack();
  if (!body || !body.view || !body.view.blocks || !body.view.id || !body.view.hash) return;

  const targetId = action?.value;
  if (!targetId) return;

  const blocks = body.view.blocks.filter(b => {
    if (!b.block_id) return true;
    // Deleting a row brings the modal back under the cap, so drop the stale
    // max-blocks warning too (same lifecycle as btn_del_choice).
    if (b.block_id === 'edit_add_choice_warn') return false;
    return b.block_id !== targetId && b.block_id !== targetId + '_del';
  });

  try {
    await client.views.update({
      token: context.botToken,
      hash: body.view.hash,
      view_id: body.view.id,
      view: {
        type: body.view.type,
        callback_id: 'edit_poll_submit',
        private_metadata: body.view.private_metadata,
        title: body.view.title,
        submit: body.view.submit,
        close: body.view.close,
        blocks: blocks,
        external_id: body.view.id,
      },
    });
  } catch (e) {
    logger.debug('edit_del_choice views.update failed: ' + (e?.data?.error || e?.message || e));
  }
});

// Final modal submit: collect the question and any non-empty option
// values (preserving block order so options stay in the user's chosen
// sequence), validate, then delegate to applyPollEdit.
app.view('edit_poll_submit', async ({ ack, body, view, context }) => {
  if (!view || !view.state || !view.private_metadata || !body?.user?.id) {
    await ack();
    return;
  }

  let pollIdRaw = null;
  let userLang = gAppLang;
  let pmChannel = null;
  let pmTs = null;
  let pmResponseUrl = null;
  try {
    const pm = JSON.parse(view.private_metadata);
    pollIdRaw = pm.poll_id;
    if (pm.user_lang) userLang = pm.user_lang;
    pmChannel = pm.channel || null;
    pmTs = pm.ts || null;
    pmResponseUrl = pm.response_url || null;
  } catch (e) { /* fall through */ }

  let newQuestion = null;
  const newOptions = [];
  for (const blockId of Object.keys(view.state.values)) {
    const inner = view.state.values[blockId];
    const firstActionId = Object.keys(inner)[0];
    // readInputAsMrkdwn auto-discriminates between plain_text_input (option.value)
    // and rich_text_input (option.rich_text_value -> richTextToMrkdwn). Same
    // helper used by modal_poll_submit; stays correct regardless of which
    // element type the modal rendered.
    const v = readInputAsMrkdwn(inner[firstActionId]);
    if (blockId === 'edit_question') {
      newQuestion = (v || '').trim();
    } else if (blockId.startsWith('edit_choice_') && !blockId.endsWith('_del')) {
      const trimmed = (v || '').trim();
      if (trimmed !== '') newOptions.push(trimmed);
    }
  }

  if (!newQuestion) {
    await ack({
      response_action: 'errors',
      errors: { edit_question: stri18n(userLang, 'poll_edit_no_question') },
    });
    return;
  }
  if (newOptions.length === 0) {
    // No specific block to attach the error to once all option rows are
    // empty/removed — fall back to the question field so the user sees it.
    await ack({
      response_action: 'errors',
      errors: { edit_question: stri18n(userLang, 'poll_edit_no_question') },
    });
    return;
  }
  if (newOptions.length > gSlackLimitChoices) {
    await ack({
      response_action: 'errors',
      errors: { edit_question: parameterizedString(stri18n(userLang, 'err_slack_limit_choices_max'), { slack_limit_choices: gSlackLimitChoices }) },
    });
    return;
  }

  let pollData = null;
  try {
    pollData = await pollCol.findOne({ _id: new ObjectId(pollIdRaw) });
  } catch (e) { /* fall through */ }

  if (!pollData) {
    await ack({ response_action: 'errors', errors: { edit_question: stri18n(userLang, 'poll_edit_not_found') } });
    return;
  }
  if (pollData.user_id !== body.user.id) {
    await ack({ response_action: 'errors', errors: { edit_question: stri18n(userLang, 'err_action_other') } });
    return;
  }

  // Re-check the kill-switch and time window at submit time too — the modal
  // may have been opened minutes ago, the installer may have flipped the
  // kill-switch, or the poll may have aged out of the edit window between
  // open and submit.
  const submitTeamConfig = await getTeamOverride(pollData.team);
  if (!isPollEditEnabled(submitTeamConfig)) {
    await ack({ response_action: 'errors', errors: { edit_question: stri18n(userLang, 'poll_edit_disabled') } });
    return;
  }
  {
    const win = isWithinEditWindow(pollData, submitTeamConfig);
    if (!win.ok) {
      await ack({
        response_action: 'errors',
        errors: { edit_question: parameterizedString(stri18n(userLang, 'poll_edit_too_old'), { minutes: win.maxMins }) },
      });
      return;
    }
  }

  await ack();

  const editResult = await applyPollEdit({
    pollData: pollData,
    newQuestion: newQuestion,
    newOptions: newOptions,
    editorUserId: body.user.id,
    targetChannel: pmChannel,
    targetTs: pmTs,
    responseUrl: pmResponseUrl,
  });

  // Result feedback. Failures go as an ephemeral in the poll's channel (not
  // DM-gated - the editor must know the edit didn't land); the success note
  // is a DM and honors the app_allow_dm / user_allow_dm opt-outs.
  try {
    if (!editResult.ok) {
      // Human-readable failure only - raw internal error tokens go to the
      // log, not to the user.
      logger.warn('[Edit] applyPollEdit failed: ' + (editResult.error ?? 'unknown'));
      const noticeRes = await postChat(pmResponseUrl ?? '', 'ephemeral', {
        token: context.botToken,
        channel: pmChannel,
        user: body.user.id,
        text: stri18n(userLang, 'poll_edit_failed'),
      });
      if (noticeRes?.status === false && pmChannel) {
        // The expired/failed response_url may be the very reason the edit
        // failed - retry once via the Web API with a fresh body (postChat
        // mutates the request body on the response_url path).
        await postChat('', 'ephemeral', {
          token: context.botToken,
          channel: pmChannel,
          user: body.user.id,
          text: stri18n(userLang, 'poll_edit_failed'),
        });
      }
    } else {
      const teamInfo = await getTeamInfo(pollData.team);
      const dmToken = teamInfo?.bot?.token;
      const teamConfigDm = await getTeamOverride(pollData.team);
      let isAppAllowDM = gAppAllowDM;
      if (teamConfigDm?.hasOwnProperty('app_allow_dm')) isAppAllowDM = teamConfigDm.app_allow_dm;
      let isUserAllowDM = isAppAllowDM;
      const uConfigDm = await getUserConfig(pollData.team, body.user.id);
      if (uConfigDm?.config?.hasOwnProperty('user_allow_dm')) {
        isUserAllowDM = uConfigDm.config.user_allow_dm;
      }
      if (dmToken && isUserAllowDM) {
        let text = parameterizedString(stri18n(userLang, 'poll_edit_success'), { poll_id: pollData._id.toString() });
        if (editResult.droppedCount > 0) {
          text += "\n" + parameterizedString(stri18n(userLang, 'poll_edit_warn_votes'), { dropped_count: editResult.droppedCount });
        }
        await postChat('', 'post', { token: dmToken, channel: body.user.id, text: text });
      }
    }
  } catch (e) {
    logger.debug('[Edit] post-submit notification failed: ' + (e?.message || e));
  }
});

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

// Owner-gate / precondition rejection helper for button-click handlers.
// Goes through the click's response_url so the reply still arrives when the
// bot is not a member of the channel (Web API postEphemeral would fail).
const makeEphemeralReject = (body, context, userLang) => async (msgKey) => {
  if (!body.channel?.id && !body.response_url && !body.trigger_id) return;
  // Routes through notifyUser → modal/text per app_user_notification_method (both default).
  await notifyUser(body, context, stri18n(userLang, msgKey), userLang);
};

// Open a modal; on failure (content too large, expired trigger_id, ...) tell
// the user via an ephemeral instead of failing silently. The poll-menu modals
// (Command info / My votes / All user votes) funnel through here.
async function openModalOrWarn(client, context, body, view, userLang) {
  try {
    await client.views.open({
      token: context.botToken,
      trigger_id: body.trigger_id,
      view: view,
    });
  } catch (e) {
    logger.error(`views.open failed: ${e?.data?.error || e?.message || e}`);
    try {
      await postChat(body.response_url, 'ephemeral', {
        token: context.botToken,
        channel: body.channel?.id,
        user: body.user?.id,
        text: stri18n(userLang ?? gAppLang, 'err_modal_open_failed'),
      });
    } catch (e2) {
      logger.warn(`Not able to send modal-failure ephemeral: ${e2.message}`);
    }
  }
}

// Show a system/error NOTICE to the acting user, per app_user_notification_method
// (server default 'both', workspace-overridable; invalid → 'both'):
//   both  → a MODAL popup (when a fresh trigger_id is in hand) AND the ephemeral text,
//           so a missed ephemeral is still surfaced;
//   modal → modal only, but FALL BACK to the ephemeral when no trigger / views.open fails
//           (expired/used trigger, content too big) so there's never a silent drop;
//   text  → the ephemeral only (original behavior).
// A modal can only be shown right after a user interaction (a live, single-use trigger_id);
// for unattended/async calls (no trigger) this always degrades to the ephemeral.
// `text` is already localized. Use for user-facing notices (NOT DMs / recovery msgs).
async function notifyUser(body, context, text, userLang) {
  const lang = userLang || gAppLang;
  let method = gAppUserNotificationMethod;
  try {
    const tc = await getTeamOverride(getTeamOrEnterpriseId(body));
    if (tc && tc.hasOwnProperty('app_user_notification_method')) method = normNotifyMethod(tc.app_user_notification_method);
  } catch (e) { /* use server default */ }
  let modalShown = false;
  if ((method === 'both' || method === 'modal') && body && body.trigger_id) {
    try {
      await app.client.views.open({
        token: context.botToken,
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: stri18n(lang, 'info_notice_title').slice(0, 24) },
          close: { type: 'plain_text', text: stri18n(lang, 'btn_close').slice(0, 24) },
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: truncateForSection(text) } }],
        },
      });
      modalShown = true;
    } catch (e) { modalShown = false; }
  }
  // Ephemeral when the method includes text ('both'/'text'), OR as a fallback when a modal
  // was wanted ('modal') but couldn't be shown (no trigger / views.open failed).
  if (method === 'both' || method === 'text' || !modalShown) {
    try {
      await postChat(body && body.response_url ? body.response_url : '', 'ephemeral', {
        token: context.botToken, channel: body && body.channel ? body.channel.id : undefined,
        user: body && body.user ? body.user.id : undefined, text,
      });
    } catch (e2) { logger.warn(`notifyUser ephemeral fallback failed: ${e2.message}`); }
  }
}

// Slack caps a section block's text at 3000 chars; keep a margin.
function truncateForSection(text, max = 2900) {
  if (typeof text !== 'string' || text.length <= max) return text;
  return text.slice(0, max) + ' …';
}

async function commandInfo(body, client, context, value) {
  const teamConfig = await getTeamOverride(getTeamOrEnterpriseId(context));
  let appLang= gAppLang;
  if(teamConfig.hasOwnProperty("app_lang")) appLang = teamConfig.app_lang;

  const pollData = await pollCol.findOne({ _id: new ObjectId(value.p_id) });
  let pollCmd = "NOTFOUND";
  let poll_id = value.p_id.toString();
  if(poll_id.length === 0) poll_id = "N/A";
  let createdVia = "NOTFOUND";
  if (pollData) {
    if(pollData.hasOwnProperty("cmd")) {
      if(pollData.cmd.trim().length > 0) {
        pollCmd = pollData.cmd;
      }
    }
    createdVia = pollData.cmd_via ?? "N/A";
    if(pollData.cmd_via_ref!=null) createdVia += "\n" + parameterizedString(stri18n(appLang, 'info_source_id_label'), {value: pollData.cmd_via_ref})
    if(pollData.cmd_via_note!=null) createdVia += "\n" + parameterizedString(stri18n(appLang, 'info_note_label'), {value: pollData.cmd_via_note})
    if(pollData.cmd_via_ref!=null) createdVia += "\n"+parameterizedString(stri18n(appLang,'task_usage_stop_poll'),{slack_command:slackCommand, poll_id: pollData.cmd_via_ref } );
  }
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
        text: truncateForSection(pollCmd)
      },
    },
    {
      type: 'divider',
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: parameterizedString(stri18n(appLang, 'info_poll_id_label'), {value: poll_id})
      },
    },
    {
      type: 'divider',
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncateForSection(parameterizedString(stri18n(appLang, 'info_created_via_label'), {value: createdVia}))
      },
    }
  ];

  await openModalOrWarn(client, context, body, {
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
  }, appLang);

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

  await openModalOrWarn(client, context, body, {
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
  }, userLang);
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
    await notifyUser(body, context, stri18n(appLang, 'err_see_all_vote_other'), appLang);
    return;
  }

  if(value.hasOwnProperty('anonymous') && value.hasOwnProperty('true_anonymous'))
  {
    if(value.anonymous===true&&value.true_anonymous===true) {
      await notifyUser(body, context, stri18n(appLang, 'err_see_all_vote_true_anonymous'), appLang);
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
      // A context element's mrkdwn caps at 3000 chars (~190-200 voters of
      // <@U...> mentions) - truncate with a "+N more" tail instead of
      // letting views.open reject the whole modal.
      let votersText = stri18n(userLang,'info_no_vote');
      if (voters.length) {
        votersText = '';
        let shown = 0;
        for (const el of voters) {
          const mention = (shown === 0 ? '' : ', ') + `<@${el}>`;
          if (votersText.length + mention.length > 2900) break;
          votersText += mention;
          shown++;
        }
        if (shown < voters.length) votersText += ` +${voters.length - shown}`;
      }
      votes.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: votersText,
        }],
      });
    }
  }

  await openModalOrWarn(client, context, body, {
    type: 'modal',
    title: {
      type: 'plain_text',
      // Slack rejects view titles > 24 chars (ru/es translations overflowed -> the
      // whole "See all votes" modal failed to open). Backstop for every language.
      text: stri18n(userLang,'info_all_user_vote').slice(0, 24),
    },
    close: {
      type: 'plain_text',
      text: stri18n(userLang,'info_close'),
    },
    blocks: votes,
  }, userLang);
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
    await notifyUser(body, context, stri18n(appLang, 'err_reveal_other'), appLang);
    return;
  }

  if (!value.hasOwnProperty('revealed')) {
    logger.info('Missing `revealed` information on poll');
    await notifyUser(body, context, stri18n(appLang, 'err_poll_unconsistent_exception'), appLang);
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
              newVoters += parameterizedString(stri18n(userLang, vLength === 1 ? 'info_vote_count_one' : 'info_vote_count_many'), { count: vLength });
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

      // Guard: minimal-UI team configs can render a poll with NO context
      // block at all - findIndex then returns -1 and blocks[-1] throws,
      // breaking the action entirely. Skip the badge refresh in that case.
      const infosIndex = blocks.findIndex(el => el.type === 'context' && el.elements)
      if (infosIndex !== -1) {
        blocks[infosIndex].elements = await buildInfosBlocks(
          blocks,
          {
            team: message.team,
            channel,
            ts: message.ts,
          },
          userLang
        );
      }

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
      await notifyUser(body, context, (isHidden ? stri18n(userLang,'err_poll_hide_exception'): stri18n(userLang,'err_poll_reveal_exception')), userLang);
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
      await notifyUser(body, context, stri18n(appLang, 'err_delete_other'), appLang);
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
    logger.error(`deletePoll views.open failed: ${error?.stack || error}`);
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
  const delRes = await postChat(value.response_url,'delete',mRequestBody);

  if (delRes?.status === false) {
    // The Slack message is still live - do NOT wipe the DB rows, or every
    // button on the surviving message stops resolving. Tell the user; the
    // failed/expired response_url may be the very thing that broke the
    // delete, so fall back to the Web API with a fresh body if it fails too.
    const failNoticeRes = await postChat(value.response_url, 'ephemeral', {
      token: context.botToken,
      channel: value.channel.id,
      user: body.user.id,
      text: stri18n(appLang, 'err_delete_failed'),
    });
    if (failNoticeRes?.status === false) {
      await postChat('', 'ephemeral', {
        token: context.botToken,
        channel: value.channel.id,
        user: body.user.id,
        text: stri18n(appLang, 'err_delete_failed'),
      });
    }
    return;
  }

  if(gIsDeleteDataOnRequest) {
    if(value.hasOwnProperty('p_id')) {
      //delete from database (awaited so failures surface in the caller's
      //try/catch instead of dying as unhandled rejections)
      await pollCol.deleteOne(
          { _id: new ObjectId(value.p_id) }
      );
      await votesCol.deleteOne(
          { channel: value.channel.id, ts: value.message.ts }
      );
      await closedCol.deleteOne(
          { channel: value.channel.id, ts: value.message.ts }
      );
      await hiddenCol.deleteOne(
          { channel: value.channel.id, ts: value.message.ts }
      );
      await scheduleCol.deleteMany(
          { poll_id: new ObjectId(value.p_id) }
      );
    }
  }

}

async function closePollById(poll_id) {
  let menuAtIndex = 0;
  let pollData = null;

  // Best-effort DM to the poll creator when an auto-close fails.
  // Silently no-ops if we lack the bare minimum (team + user_id + bot token)
  // or if the user opted out of DMs. Never throws — DM failure must not
  // mask the underlying close failure in the logs.
  // reason is an i18n KEY (+ optional vars) so the whole DM - template AND
  // reason - renders in the poll's language, not hardcoded English.
  const sendCloseFailedDM = async (reasonKey, reasonVars = {}) => {
    try {
      if (!pollData?.team || !pollData?.user_id) return;
      const teamInfo = await getTeamInfo(pollData.team);
      const dmToken = teamInfo?.bot?.token;
      if (!dmToken) return;

      // Resolve DM permission: server default -> team override -> user override.
      // Same resolution order as the schedule task path (~line 477) and the
      // modal_poll_submit path (~line 5001).
      const teamConfig = await getTeamOverride(pollData.team);
      let isAppAllowDM = gAppAllowDM;
      if (teamConfig?.hasOwnProperty('app_allow_dm')) isAppAllowDM = teamConfig.app_allow_dm;
      let isUserAllowDM = isAppAllowDM;
      const uConfig = await getUserConfig(pollData.team, pollData.user_id);
      if (uConfig?.config?.hasOwnProperty('user_allow_dm')) {
        isUserAllowDM = uConfig.config.user_allow_dm;
      }
      if (!isUserAllowDM) return;

      // Per-poll lang resolution: pollData.para.user_lang -> teamConfig.app_lang -> gAppLang.
      // Matches the closer's main success path (~line 7368) so a Thai-language poll
      // delivers its failure DM in Thai instead of the server-default English.
      const userLang = (pollData.para?.user_lang) || teamConfig?.app_lang || gAppLang;
      const text = parameterizedString(stri18n(userLang, 'info_schedule_close_failed'), {
        question: pollData.question || '(no question)',
        poll_id: String(pollData._id || poll_id),
        reason: parameterizedString(stri18n(userLang, reasonKey), reasonVars),
      });
      await postChat("", 'post', {
        token: dmToken,
        channel: pollData.user_id,
        text: text,
      });
    } catch (e) {
      logger.warn(`[Schedule_close] Failed to DM poller for poll_id ${poll_id}: ${e?.message || e}`);
    }
  };

  try {
    pollData = await pollCol.findOne({_id: new ObjectId(poll_id)});
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
      if (!pollData.team || !pollData.channel || !pollData.user_id || !pollData.ts) {
        const issues = ['team','channel','user_id','ts']
            .map(f => !pollData.hasOwnProperty(f) ? `${f}=<missing>` : !pollData[f] ? `${f}=<null/empty>` : null)
            .filter(Boolean)
            .join(', ') || 'unknown';
        logger.warn(`Cannot close poll_id ${poll_id} on closePollById due to incomplete data: ${issues}`);
        await pollCol.updateOne(
            {_id: pollData._id},
            {$set: {schedule_end_active: false}}
        );
        if (issues === 'ts=<null/empty>') {
          await sendCloseFailedDM('close_fail_reason_no_interaction');
        } else {
          await sendCloseFailedDM('close_fail_reason_bad_record', { issues });
        }
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

      // Resolve once via the module-level helper; same value flows into both
      // createPollView (below) and updateVoteBlock (later) so the two cannot
      // disagree on layout. See resolveFromPara comment.
      const isMenuAtTheEnd = resolveFromPara(pollData, teamConfig, 'menu_at_the_end', gIsMenuAtTheEnd);
      const isCompactUI = resolveFromPara(pollData, teamConfig, 'compact_ui', gIsCompactUI);


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
            await sendCloseFailedDM('close_fail_reason_no_token');
            return false;
          }

          const pollView = (await createPollView(pollData.team, pollData.channel, teamConfig, pollData.question, pollData.options, pollData.para?.anonymous ?? false, pollData.para?.limited, pollData.para?.limit, pollData.para?.hidden, pollData.para?.user_add_choice,
              isMenuAtTheEnd, isCompactUI, pollData.para?.show_divider, pollData.para?.show_help_link, pollData.para?.show_command_info, pollData.para?.true_anonymous, pollData.para?.add_number_emoji_to_choice, pollData.para?.add_number_emoji_to_choice_btn, pollData.schedule_end_ts, pollData.para?.user_lang, pollData.user_id, pollData.cmd, pollData.cmd_via, pollData.cmd_via_ref, pollData.cmd_via_note,
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
            await sendCloseFailedDM('close_fail_reason_render');
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
            await sendCloseFailedDM('close_fail_reason_update');
            //continue;
          }

        } catch (e) {
          logger.warn(`Cannot close poll_id ${poll_id}  `);
          logger.warn(e);
          logger.warn(e.toString() + "\n" + e.stack);
          await sendCloseFailedDM('close_fail_reason_unexpected');
          return false;
        } finally {
          release();
        }
      }//end on release

    } else {
      const issues = ['team','channel','user_id','ts']
          .map(f => !pollData.hasOwnProperty(f) ? `${f}=<missing>` : !pollData[f] ? `${f}=<null/empty>` : null)
          .filter(Boolean)
          .join(', ') || 'unknown';
      logger.warn(`Cannot close poll_id ${poll_id} on closePollById due to incomplete data: ${issues}`);
      await pollCol.updateOne(
          {_id: pollData._id},
          {$set: {schedule_end_active: false}}
      );
      if (issues === 'ts=<missing>' || issues === 'ts=<null/empty>') {
        await sendCloseFailedDM('close_fail_reason_no_interaction');
      } else {
        await sendCloseFailedDM('close_fail_reason_bad_record', { issues });
      }
    }
  } catch (e) {
    logger.error(`UNEXPECTED ERROR in closePollById`);
    logger.error(e);
    logger.error(e.toString() + "\n" + e.stack);
    await sendCloseFailedDM('close_fail_reason_unexpected');
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
    await notifyUser(body, context, stri18n(appLang, 'err_close_other'), appLang);
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
            channel,
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

      // Guard: see closePoll - a poll can legitimately have no context block
      // under minimal-UI team configs; blocks[-1] would throw.
      const infosIndex =
        blocks.findIndex(el => el.type === 'context' && el.elements);
      if (infosIndex !== -1) {
        blocks[infosIndex].elements = await buildInfosBlocks(
          blocks,
          {
            team: message.team,
            channel,
            ts: message.ts,
          },
          userLang
        );
      }

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
        // Internal failure - NOT an ownership problem; err_close_other here
        // used to gaslight the actual owner.
        text: stri18n(userLang,'err_close_exception'),
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
      // Mutex acquisition failed - an internal error, not an ownership one.
      text: stri18n(userLang,'err_close_exception'),
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
  // Carry over the trailing addon element (info_addon / poller name) when a
  // context block exists - guarded so a missing block can't blocks[-1]-throw.
  if (infosIndex !== -1 && blocks[infosIndex].elements.length > 0) {
    infosBlocks.push(blocks[infosIndex].elements.pop());
  }
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
        // Cap the @mention list so the rendered text can't exceed Slack's 3000-char
        // section/context limit. Without this, a popular non-anonymous option (~185+
        // voters) freezes the poll: the vote is persisted to Mongo BEFORE chat.update,
        // so once over the cap the message stops re-rendering while votes keep saving.
        // Mirrors the usersVotes "+N" truncation; vCount stays the true total. Reserve
        // headroom (2700) for the count string + the option text prepended in compact UI.
        newVoters = '';
        const vCount = poll[val.id].length;
        if (!val.anonymous) {
          let shown = 0;
          for (const voter of poll[val.id]) {
            const mention = `<@${voter}> `;
            if (newVoters.length + mention.length > 2700) break;
            newVoters += mention;
            shown++;
          }
          if (shown < vCount) newVoters += `+${vCount - shown} `;
        }
        newVoters += parameterizedString(stri18n(userLang, vCount === 1 ? 'info_vote_count_one' : 'info_vote_count_many'), { count: vCount });
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

  // Guard: see closePoll - minimal-UI configs can render no context block.
  const infosIndex = blocks.findIndex(el => el.type === 'context' && el.elements)
  if (infosIndex !== -1) {
    blocks[infosIndex].elements = await buildInfosBlocks(
        blocks,
        {
          team: team,
          channel,
          ts: ts,
        },
        userLang
    );
  }
  blocks[menuAtIndex].accessory.option_groups[0].options =
      await buildMenu(blocks, {
        team: team,
        channel,
        ts: ts,
      }, userLang, isMenuAtTheEnd);

  return blocks;
}

// Parse an ISO-8601 string. When it carries no UTC offset, interpret it in
// the user's Slack timezone (the legacy behavior - server-local time -
// surprised users whenever the server ran in a different zone).
function parseISOInUserTz(isoText, userTz) {
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})\s*$/i.test(isoText);
  if (!hasOffset && userTz) {
    const m = moment.tz(isoText, userTz);
    if (m.isValid()) return m.toDate();
  }
  return new Date(isoText);
}

// Resolve a user's Slack IANA timezone via users.info; null when unavailable.
async function getUserTz(botToken, userId) {
  if (botToken == null || botToken === "" || userId == null || userId === "") return null;
  try {
    const userInfo = await app.client.users.info({
      token: botToken,
      user: userId
    });
    //`Your time zone is: ${userInfo?.user?.tz} (${userInfo?.user?.tz_label}, Offset: ${userInfo?.user?.tz_offset} seconds)`
    return userInfo?.user?.tz ?? null;
  } catch (e) {
    return null;
  }
}

async function getAndlocalizeTimeStamp(botToken, userId, mongoDateObject) {
  //const timeFormat = 'ddd MMM DD YYYY HH:mm:ss [GMT]ZZ';
  //const iso8601Format = 'YYYY-MM-DDTHH:mm:ssZ'; // ISO 8601 format
  const timeFormat = gAppDatetimeFormat;
  const tz = await getUserTz(botToken, userId);
  if (tz == null) return moment(mongoDateObject).format(timeFormat);
  return localizeTimeStamp(tz, mongoDateObject);
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