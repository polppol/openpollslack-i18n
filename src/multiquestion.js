'use strict';

/*
 * multiquestion.js — multi-question polls ("forms"): one poll that asks several
 * questions of mixed type (choice / yes-no / text / number / date / time /
 * datetime / email / url) in a single Slack message.
 *
 * DESIGN: additive and fully backward-compatible. Single-question polls (the core
 * feature) NEVER touch this module — none of their functions are modified. A poll
 * is "multi-question" iff its poll_data carries a non-empty `questions` array; all
 * interactions use dedicated `mq_*` action/callback ids handled here, so the
 * single-question code path is left exactly as-is.
 *
 * STORAGE (poll_data, additive): questions:[{id,type,text,options?,multi?,
 * user_add_choice?,required?,min?,max?}] plus a compat mirror of question #1 into
 * the standard `question`/`options` fields so other readers degrade instead of break.
 * (votes doc): votes:{ "<qid>":{ "<optIdx>":[userId] } } and answers:{ "<qid>":
 * { "<userId>": value } } — distinct from the single-question flat votes map. No migration.
 *
 * SECURITY: this is a PUBLIC repo. This module embeds and logs NO real workspace
 * ids, user ids, tokens, hostnames, or any other live data — only generic code.
 */

const { ObjectId } = require('mongodb');
const { stri18n, parameterizedString, slackNumToEmoji } = require('./i18n');

let _db = null;
let _opts = {};
/** Wire up the Mongo handle + options (called once from index.js after connect).
 *  opts.resolveTeamDefaults(teamId) -> { app_lang, true_anonymous } lets forms
 *  honor each team's config defaults, the same way the single-question modal does. */
function init(db, opts) { _db = db; _opts = opts || {}; }
async function teamDefaults(teamId) {
  try { if (_opts.resolveTeamDefaults) return (await _opts.resolveTeamDefaults(teamId)) || {}; } catch (e) { /* use built-in defaults */ }
  return {};
}
const pollCol = () => _db.collection('poll_data');
const votesCol = () => _db.collection('votes');

const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 10;
const MAX_TEXT_LEN = 2000;
const INPUT_TYPES = ['text', 'number', 'date', 'time', 'datetime', 'email', 'url'];
const CHOICE_TYPES = ['choice', 'yesno'];
const ALL_TYPES = [...CHOICE_TYPES, ...INPUT_TYPES];

function isMulti(pollData) {
  return !!(pollData && Array.isArray(pollData.questions) && pollData.questions.length > 0);
}
function isChoice(type) { return CHOICE_TYPES.includes(type); }
function isInput(type) { return INPUT_TYPES.includes(type); }

// ───────────────────────── DSL PARSER (pure, testable) ──────────────────────
//
// The create modal collects the form as one text field. Grammar (one item/line):
//   Q: <question text> [<type> <flag> ...]   -> a question; type defaults to
//                                               "choice" if options follow, else "text"
//   - <option>  (or "* <option>")            -> an option for the preceding choice
// Recognised types: choice yesno text number date time datetime email url
// Recognised flags: multi (multi-select), add (user can add choices), required
//
// Example:
//   Q: Do you want to order food? [yesno]
//   Q: Which food? [choice multi add]
//   - Apple
//   - Orange
//   Q: Any comment? [text]
//   Q: How many? [number]
//   Q: Preferred day? [date]
function parseForm(text, lang) {
  const L = lang || 'en';
  const t = (k, p) => (p ? parameterizedString(stri18n(L, k), p) : stri18n(L, k));
  const errors = [];
  const questions = [];
  const lines = String(text || '').split(/\r?\n/);
  let cur = null;
  const pushCur = () => {
    if (!cur) return;
    if (cur.type === 'yesno') cur.options = ['Yes', 'No'];
    if (isChoice(cur.type) && (!cur.options || cur.options.length < 2) && cur.type !== 'yesno') {
      // a choice needs ≥2 options — surfaced here and blocked at submit (handleCreateSubmit)
      errors.push(t('mq_err_choice_2opts', { q: cur.text.slice(0, 40) }));
    }
    questions.push(cur);
    cur = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const qm = line.match(/^(?:Q[:.)]|\d+[.)])\s*(.+)$/i); // "Q:", "Q.", "Q)", "1.", "1)"
    const om = line.match(/^[-*]\s*(.+)$/);
    if (qm) {
      pushCur();
      let qtext = qm[1].trim();
      let type = null; const flags = {};
      const tag = qtext.match(/\[([^\]]*)\]\s*$/);
      if (tag) {
        qtext = qtext.slice(0, tag.index).trim();
        for (const tok of tag[1].trim().toLowerCase().split(/\s+/).filter(Boolean)) {
          if (ALL_TYPES.includes(tok)) type = tok;
          else if (tok === 'multi') flags.multi = true;
          else if (tok === 'add') flags.user_add_choice = true;
          else if (tok === 'required') flags.required = true;
        }
      }
      cur = { text: qtext.slice(0, 300), type: type, options: [], ...flags };
    } else if (om && cur) {
      if (cur.options.length < MAX_OPTIONS) cur.options.push(om[1].trim().slice(0, 150));
    } else if (om && !cur) {
      errors.push(t('mq_err_orphan_option', { opt: line.slice(0, 30) }));
    } else if (cur) {
      // continuation line for the current question text
      cur.text = (cur.text + ' ' + line).slice(0, 300);
    } else {
      errors.push(t('mq_err_unrecognised', { line: line.slice(0, 30) }));
    }
  }
  pushCur();
  // finalise types + ids; cap count
  const out = [];
  questions.slice(0, MAX_QUESTIONS).forEach((q, i) => {
    let type = q.type;
    if (!type) type = (q.options && q.options.length >= 2) ? 'choice' : 'text';
    const item = { id: `q${i + 1}`, type, text: q.text || `Question ${i + 1}` };
    if (isChoice(type)) {
      item.options = q.type === 'yesno' ? ['Yes', 'No'] : (q.options || []).slice(0, MAX_OPTIONS);
      item.multi = type === 'yesno' ? false : !!q.multi; // yes/no is always single-select
      if (q.user_add_choice) item.user_add_choice = true;
    }
    if (q.required) item.required = true;
    out.push(item);
  });
  if (questions.length > MAX_QUESTIONS) errors.push(t('mq_err_max_questions', { max: MAX_QUESTIONS }));
  if (!out.length) errors.push(t('mq_err_no_questions'));
  return { questions: out, errors };
}

// ───────────────────────── vote / answer logic (pure) ───────────────────────

/** Toggle a voter on a nested votes map. Returns '+', '-' (or 'limit' is N/A here). */
function applyVote(votesMap, qid, oid, userId, multi) {
  if (!votesMap[qid]) votesMap[qid] = {};
  const q = votesMap[qid];
  const key = String(oid);
  if (!Array.isArray(q[key])) q[key] = [];
  const had = q[key].includes(userId);
  if (had) {
    q[key] = q[key].filter((u) => u !== userId);
    return '-';
  }
  // single-select: clear the voter from the question's other options first
  if (!multi) {
    for (const k of Object.keys(q)) q[k] = (q[k] || []).filter((u) => u !== userId);
  }
  q[key].push(userId);
  return '+';
}

/** Set/clear a free-input answer. Empty value clears it. Returns 'set'|'clear'. */
function applyAnswer(answers, qid, userId, value) {
  if (!answers[qid]) answers[qid] = {};
  const v = (value == null) ? '' : String(value);
  if (v.trim() === '') { delete answers[qid][userId]; return 'clear'; }
  answers[qid][userId] = v.slice(0, MAX_TEXT_LEN);
  return 'set';
}

/** Human display for a stored input answer, by question type. */
function formatAnswer(type, value) {
  if (value == null || value === '') return '';
  if (type === 'datetime') {
    const n = Number(value);
    if (Number.isFinite(n)) return `<!date^${n}^{date_short} {time}|${n}>`; // Slack date formatting
  }
  return String(value);
}

// ───────────────────────── Slack block rendering (pure) ─────────────────────

function divider() { return { type: 'divider' }; }
function sectionMd(text) { return { type: 'section', text: { type: 'mrkdwn', text } }; }
function contextMd(text) { return { type: 'context', elements: [{ type: 'mrkdwn', text }] }; }

// Cap how many voter mentions we render per option so a popular non-anonymous
// option can't push a section past Slack's 3000-char limit (which would make the
// whole chat.update fail on the next interaction). Excess are summarized.
const MAX_VOTER_MENTIONS = 40;

function votersText(voters, anonymous, hidden, userLang) {
  if (hidden) return stri18n(userLang, 'info_wait_reveal');
  const n = (voters || []).length;
  if (n === 0) return stri18n(userLang, 'info_no_vote');
  let s = '';
  if (!anonymous) {
    const shown = voters.slice(0, MAX_VOTER_MENTIONS).map((u) => `<@${u}>`).join(' ');
    const extra = n - Math.min(n, MAX_VOTER_MENTIONS);
    s += shown + (extra > 0 ? ` ${parameterizedString(stri18n(userLang, 'mq_more'), { count: extra })}` : '') + '  ';
  }
  s += parameterizedString(stri18n(userLang, n === 1 ? 'info_vote_count_one' : 'info_vote_count_many'), { count: n });
  return s;
}

/**
 * Build the full Slack message blocks for a multi-question poll.
 * pollData: the poll document (must have questions[]). votesDoc: the votes doc
 * ({votes, answers}) or null. opts: { userLang, isClosed }.
 */
function buildBlocks(pollData, votesDoc, opts = {}) {
  const userLang = opts.userLang || (pollData.para && pollData.para.user_lang) || 'en';
  const anonymous = !!(pollData.para && pollData.para.anonymous);
  // `hidden` (immutable) = this poll supports hide/reveal; `revealed` (live) =
  // results currently shown. Effective hidden = hidden && !revealed && !closed.
  // (Kept separate so reveal/hide is a true two-way toggle.)
  const revealed = !!(pollData.para && pollData.para.revealed);
  const hidden = !!(pollData.para && pollData.para.hidden) && !revealed && !opts.isClosed;
  const votes = (votesDoc && votesDoc.votes) || {};
  const answers = (votesDoc && votesDoc.answers) || {};
  const pollId = String(pollData._id);
  const blocks = [];

  blocks.push({ type: 'header', text: { type: 'plain_text', text: trimText(pollData.question || 'Poll', 150), emoji: true } });
  const sub = [];
  if (pollData.user_id && (pollData.para && pollData.para.display_poller_name !== false)) sub.push(`${stri18n(userLang, 'mq_created_by')} <@${pollData.user_id}>`);
  const nq = pollData.questions.length;
  sub.push(parameterizedString(stri18n(userLang, nq === 1 ? 'mq_n_questions_one' : 'mq_n_questions_many'), { count: nq }));
  if (opts.isClosed) sub.push(`:lock: ${stri18n(userLang, 'info_poll_closed')}`);
  blocks.push(contextMd(sub.join('  ·  ')));
  blocks.push(divider());

  pollData.questions.forEach((q, qi) => {
    blocks.push(sectionMd(`*${qi + 1}. ${trimText(q.text, 300)}*`));
    if (isChoice(q.type)) {
      const qVotes = votes[q.id] || {};
      (q.options || []).forEach((opt, oi) => {
        const voters = qVotes[String(oi)] || [];
        const btnVal = { poll_id: pollId, qid: q.id, oid: oi, multi: !!q.multi, user_lang: userLang };
        // Compact: voters/count on the SAME section as the option (1 block/option)
        // to stay within Slack's 50-block-per-message limit.
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `${slackNumToEmoji(oi + 1, userLang)} ${trimText(opt, 150)}\n${votersText(voters, anonymous, hidden, userLang)}` },
          accessory: opts.isClosed ? undefined : {
            type: 'button', action_id: 'mq_vote',
            text: { type: 'plain_text', emoji: true, text: stri18n(userLang, 'btn_vote') },
            value: JSON.stringify(btnVal),
          },
        });
      });
      if (q.user_add_choice && !opts.isClosed) {
        blocks.push({
          type: 'actions',
          elements: [{
            type: 'button', action_id: 'mq_addchoice',
            text: { type: 'plain_text', emoji: true, text: '➕ ' + stri18n(userLang, 'btn_add_choice') },
            value: JSON.stringify({ poll_id: pollId, qid: q.id, user_lang: userLang }),
          }],
        });
      }
    } else {
      // input question: an Answer button + a summary line
      const qa = answers[q.id] || {};
      const answeredBy = Object.keys(qa);
      let summary;
      if (hidden) summary = stri18n(userLang, 'info_wait_reveal');
      else if (answeredBy.length === 0) summary = stri18n(userLang, 'info_no_vote');
      else if (anonymous) summary = parameterizedString(stri18n(userLang, 'mq_answered'), { count: answeredBy.length });
      else {
        // Cap rendered answers so a popular question can't push the section past
        // Slack's 3000-char limit (which would make chat.update fail).
        const shown = answeredBy.slice(0, MAX_VOTER_MENTIONS).map((u) => `<@${u}>: ${trimText(formatAnswer(q.type, qa[u]), 80)}`).join('\n');
        const extra = answeredBy.length - Math.min(answeredBy.length, MAX_VOTER_MENTIONS);
        summary = shown + (extra > 0 ? `\n${parameterizedString(stri18n(userLang, 'mq_more'), { count: extra })}` : '');
      }
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: summary || ' ' },
        accessory: opts.isClosed ? undefined : {
          type: 'button', action_id: 'mq_answer',
          text: { type: 'plain_text', emoji: true, text: '✏️ ' + stri18n(userLang, 'btn_answer') },
          value: JSON.stringify({ poll_id: pollId, qid: q.id, type: q.type, text: q.text, user_lang: userLang }),
        },
      });
    }
    blocks.push(divider());
  });

  // menu (reveal/hide + close) — own action ids, handled in this module.
  const menu = [];
  if (pollData.para && pollData.para.hidden && !opts.isClosed) {
    menu.push({ type: 'button', action_id: 'mq_reveal', text: { type: 'plain_text', emoji: true, text: hidden ? (stri18n(userLang, 'menu_reveal_vote') || 'Reveal') : (stri18n(userLang, 'menu_hide_vote') || 'Hide') }, value: JSON.stringify({ poll_id: pollId, reveal: hidden ? 1 : 0 }) });
  }
  if (!opts.isClosed) {
    menu.push({ type: 'button', style: 'danger', action_id: 'mq_close', text: { type: 'plain_text', emoji: true, text: stri18n(userLang, 'menu_close_poll') || 'Close' }, value: JSON.stringify({ poll_id: pollId }) });
  }
  if (menu.length) blocks.push({ type: 'actions', elements: menu });
  blocks.push(contextMd(`poll_id: ${pollId}`));
  return blocks;
}

function trimText(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ───────────────────────── create modal + submit ────────────────────────────

// All user-facing strings come from the language files (stri18n), same as the
// single-question flow, so the form is fully translatable. `lang` = the team's
// resolved language; `initialForm` pre-fills the Questions box (command preview /
// error-recovery so a user's work is never lost).
function buildCreateModalView(channelId, responseUrl, lang, initialForm) {
  const L = lang || 'en';
  const t = (k) => stri18n(L, k);
  const opt = (val, key) => ({ text: { type: 'plain_text', text: trimText(t(key), 75) }, value: val });
  return {
    type: 'modal',
    callback_id: 'mq_create_submit',
    // channel/response_url/lang kept in private_metadata so the poll-type selector
    // can preserve them when swapping back to the single-question modal.
    private_metadata: JSON.stringify({ channel: channelId || null, response_url: responseUrl || '', user_lang: L }),
    title: { type: 'plain_text', text: trimText(t('mq_modal_title'), 24) },
    submit: { type: 'plain_text', text: trimText(t('btn_create'), 24) },
    close: { type: 'plain_text', text: trimText(t('btn_cancel'), 24) },
    blocks: [
      { // Poll-type selector (this modal = multi). Switching to "Single question"
        // re-opens the single-question modal (app.action('mq_poll_type')).
        type: 'section', block_id: 'mq_poll_type_blk', text: { type: 'mrkdwn', text: `*${t('mq_poll_type')}*` },
        accessory: { type: 'static_select', action_id: 'mq_poll_type',
          initial_option: opt('multi', 'mq_type_multi'),
          options: [opt('single', 'mq_type_single'), opt('multi', 'mq_type_multi')],
          // Warn before switching — swapping the modal clears the form. Deny = no change.
          confirm: {
            title: { type: 'plain_text', text: trimText(t('mq_switch_title'), 100) },
            text: { type: 'mrkdwn', text: trimText(t('mq_switch_text'), 300) },
            confirm: { type: 'plain_text', text: trimText(t('mq_switch_ok'), 30) },
            deny: { type: 'plain_text', text: trimText(t('mq_switch_deny'), 30) },
          } } },
      { type: 'input', block_id: 'mq_title', label: { type: 'plain_text', text: trimText(t('mq_field_title'), 2000) },
        element: { type: 'plain_text_input', action_id: 'v', max_length: 150, placeholder: { type: 'plain_text', text: trimText(t('mq_field_title_ph'), 150) } } },
      { type: 'input', block_id: 'mq_form', label: { type: 'plain_text', text: trimText(t('mq_field_questions'), 2000) },
        element: { type: 'plain_text_input', action_id: 'v', multiline: true, max_length: 3000, ...(initialForm ? { initial_value: String(initialForm).slice(0, 3000) } : {}), placeholder: { type: 'plain_text', text: trimText(t('mq_field_questions_ph'), 150) } } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${t('mq_field_questions_hint')}  📖 <https://github.com/polppol/openpollslack-i18n/blob/main/README.md#multi-question-polls-forms|${t('mq_howto')} ↗>` }] },
      { type: 'input', block_id: 'mq_channel', label: { type: 'plain_text', text: trimText(t('mq_field_channel'), 2000) },
        element: { type: 'conversations_select', action_id: 'v', default_to_current_conversation: true, ...(channelId ? { initial_conversation: channelId } : {}) } },
      { type: 'input', block_id: 'mq_settings', optional: true, label: { type: 'plain_text', text: trimText(t('mq_field_settings'), 2000) },
        element: { type: 'checkboxes', action_id: 'v', options: [
          { text: { type: 'mrkdwn', text: t('mq_opt_anonymous') }, value: 'anonymous' },
          { text: { type: 'mrkdwn', text: t('mq_opt_hidden') }, value: 'hidden' },
        ] } },
    ],
  };
}

/** Parse the create modal submission → { title, channel, questions, errors, para }. */
function parseCreateSubmit(view, lang) {
  const v = view.state.values;
  const title = (v.mq_title && v.mq_title.v && v.mq_title.v.value || '').trim();
  const formText = (v.mq_form && v.mq_form.v && v.mq_form.v.value) || '';
  const channel = (v.mq_channel && v.mq_channel.v && v.mq_channel.v.selected_conversation) || null;
  const settings = ((v.mq_settings && v.mq_settings.v && v.mq_settings.v.selected_options) || []).map((o) => o.value);
  const { questions, errors } = parseForm(formText, lang);
  return {
    title: title || (questions[0] && questions[0].text) || 'Poll',
    channel,
    questions,
    errors,
    para: { anonymous: settings.includes('anonymous'), hidden: settings.includes('hidden') },
  };
}

// ───────────────────────── answer modal ─────────────────────────────────────

function answerElement(type, qmin, qmax) {
  const a = { action_id: 'v' };
  switch (type) {
    case 'number': return { type: 'number_input', is_decimal_allowed: true, ...a, ...(qmin != null ? { min_value: String(qmin) } : {}), ...(qmax != null ? { max_value: String(qmax) } : {}) };
    case 'date': return { type: 'datepicker', ...a };
    case 'time': return { type: 'timepicker', ...a };
    case 'datetime': return { type: 'datetimepicker', ...a };
    case 'email': return { type: 'email_text_input', ...a };
    case 'url': return { type: 'url_text_input', ...a };
    case 'text':
    default: return { type: 'plain_text_input', multiline: true, max_length: MAX_TEXT_LEN, ...a };
  }
}

function buildAnswerModalView(pollId, qid, type, qText, current, channel, ts, lang) {
  const L = lang || 'en';
  const el = answerElement(type);
  if (current != null && current !== '') {
    if (type === 'datetime') { const n = Number(current); if (Number.isFinite(n)) el.initial_date_time = n; } // NaN would be an invalid block
    else if (type === 'date') el.initial_date = current;
    else if (type === 'time') el.initial_time = current;
    else el.initial_value = String(current);
  }
  return {
    type: 'modal',
    callback_id: 'mq_answer_submit',
    private_metadata: JSON.stringify({ poll_id: pollId, qid, type, channel, ts, user_lang: L }),
    title: { type: 'plain_text', text: trimText(stri18n(L, 'mq_answer_title'), 24) },
    submit: { type: 'plain_text', text: trimText(stri18n(L, 'mq_answer_save'), 24) },
    close: { type: 'plain_text', text: trimText(stri18n(L, 'btn_cancel'), 24) },
    blocks: [
      { type: 'input', block_id: 'mq_ans', optional: true, label: { type: 'plain_text', text: trimText(qText || stri18n(L, 'btn_answer'), 150) }, element: el },
    ],
  };
}

function readAnswerValue(view) {
  const el = view.state.values.mq_ans && view.state.values.mq_ans.v;
  if (!el) return '';
  if (el.selected_date_time != null) return String(el.selected_date_time);
  if (el.selected_date != null) return el.selected_date;
  if (el.selected_time != null) return el.selected_time;
  return el.value != null ? el.value : '';
}

// ───────────────────────── Slack-facing operations ──────────────────────────

async function loadPoll(pollId) {
  try { return await pollCol().findOne({ _id: new ObjectId(String(pollId)) }); } catch (e) { return null; }
}
async function loadVotes(pollId, channel, ts) {
  let d = null;
  if (channel && ts) d = await votesCol().findOne({ channel, ts });
  if (!d && pollId) d = await votesCol().findOne({ poll_id: String(pollId) });
  return d;
}

/** Is this poll message closed? (authoritative: the `closed` collection.) */
async function isPollClosed(channel, ts) {
  try { const d = await _db.collection('closed').findOne({ channel, ts }); return !!(d && d.closed); } catch (e) { return false; }
}

/** Re-render the poll message from current DB state (after a vote/answer/menu).
 *  Closed-state is read from the DB so a stale/racing click can never un-close. */
async function rebuildMessage(client, token, pollData, channel, ts) {
  const votesDoc = await loadVotes(pollData._id, channel, ts);
  const isClosed = await isPollClosed(channel, ts);
  const blocks = buildBlocks(pollData, votesDoc, { userLang: pollData.para && pollData.para.user_lang, isClosed });
  await client.chat.update({ token, channel, ts, text: trimText(pollData.question || 'Poll', 150), blocks });
}

// Estimated message block count (Slack hard-limits a message to 50 blocks).
function estimateBlocks(questions) {
  let n = 5; // header + sub-context + lead divider + menu + poll_id context
  for (const q of (questions || [])) {
    if (isChoice(q.type)) n += 1 + ((q.options && q.options.length) || 0) + (q.user_add_choice ? 1 : 0) + 1;
    else n += 3; // header + answer section + divider
  }
  return n;
}
const MAX_BLOCKS = 48;

/** Open the create modal (entry point: `/poll multi`). Resolves the team language
 *  (reusing the same resolver as the single-question flow) so the modal is localized.
 *  initialForm pre-fills the Questions box (command preview / error recovery). */
async function openCreateModal(client, triggerId, channelId, responseUrl, teamId, initialForm) {
  const defs = await teamDefaults(teamId);
  await client.views.open({ trigger_id: triggerId, view: buildCreateModalView(channelId, responseUrl || '', defs.app_lang || 'en', initialForm) });
}

/** Handle create-modal submit: build poll_data, post the message, store ts. */
async function handleCreateSubmit({ ack, body, view, client, context }) {
  const teamOrEnt = (body.team && body.team.id) || (body.enterprise && body.enterprise.id) || (view.team_id);
  // Resolve team config FIRST so error messages + the poll render in the team
  // language, same as the single-question flow.
  const defs = await teamDefaults(teamOrEnt);
  const lang = defs.app_lang || 'en';
  const t = (k, p) => (p ? parameterizedString(stri18n(lang, k), p) : stri18n(lang, k));
  const parsed = parseCreateSubmit(view, lang);
  if (!parsed.questions.length) {
    await ack({ response_action: 'errors', errors: { mq_form: parsed.errors[0] || t('mq_err_need_question') } });
    return;
  }
  // Surface ALL parse problems before the irreversible ack (otherwise a form with
  // e.g. a 1-option choice or a stray line would post broken with no feedback).
  if (parsed.errors && parsed.errors.length) {
    await ack({ response_action: 'errors', errors: { mq_form: parsed.errors.join(' • ').slice(0, 2000) } });
    return;
  }
  if (!parsed.channel) { await ack({ response_action: 'errors', errors: { mq_channel: t('mq_err_pick_channel') } }); return; }
  if (estimateBlocks(parsed.questions) > MAX_BLOCKS) {
    await ack({ response_action: 'errors', errors: { mq_form: t('mq_err_too_big', { max: MAX_BLOCKS }) } });
    return;
  }
  await ack();
  const token = context.botToken;
  const userId = body.user.id;
  const trueAnon = !!(parsed.para.anonymous && defs.true_anonymous);
  const q1 = parsed.questions[0];
  const pollData = {
    team: teamOrEnt,
    channel: parsed.channel,
    ts: null,
    created_ts: new Date(),
    user_id: userId,
    cmd_via: 'mq_modal',
    question: parsed.title,                                   // compat mirror
    options: isChoice(q1.type) ? (q1.options || []) : [],    // compat mirror
    questions: parsed.questions,
    // Stamp config onto the poll so later config changes never alter/break it —
    // the renderer reads ONLY para (same approach as single-question polls).
    para: {
      user_lang: lang,
      anonymous: parsed.para.anonymous,
      true_anonymous: trueAnon,
      hidden: parsed.para.hidden,
      menu_at_the_end: !!defs.menu_at_the_end,
      show_command_info: !!defs.show_command_info,
      display_poller_name: defs.display_poller_name !== false,
      form_version: 2,
    },
  };
  const res = await pollCol().insertOne(pollData);
  pollData._id = res.insertedId;
  const blocks = buildBlocks(pollData, null, { userLang: lang });
  let posted = null;
  try { posted = await client.chat.postMessage({ token, channel: parsed.channel, text: trimText(parsed.title, 150), blocks }); }
  catch (e) {
    // Can't show a modal error after ack — DM the creator + roll back the orphan poll.
    try { await client.chat.postMessage({ token, channel: userId, text: t('mq_post_failed') }); } catch (_) { /* noop */ }
    await pollCol().deleteOne({ _id: pollData._id });
    return;
  }
  if (posted && posted.ts) {
    await pollCol().updateOne({ _id: pollData._id }, { $set: { ts: posted.ts, channel: posted.channel || parsed.channel } });
    await votesCol().insertOne({ team: teamOrEnt, channel: posted.channel || parsed.channel, ts: posted.ts, poll_id: String(pollData._id), votes: {}, answers: {} });
  }
}

/** Handle a vote on a multi-question option (action_id mq_vote). */
async function handleVote({ ack, body, action, client, context }) {
  await ack();
  const token = context.botToken;
  const value = JSON.parse(action.value);
  const userId = body.user.id;
  const channel = body.channel.id;
  const ts = body.message.ts;
  const pollData = await loadPoll(value.poll_id);
  if (!pollData) return;
  if (await isPollClosed(channel, ts)) { await rebuildMessage(client, token, pollData, channel, ts); return; } // closed: re-render, no write
  // Atomic, concurrency-safe toggle: target only this question/option path so two
  // people voting at once never clobber each other's writes (the old whole-`votes`
  // $set lost concurrent updates). $addToSet/$pull are idempotent per path.
  const qid = value.qid; const oid = value.oid;
  const base = `votes.${qid}.${oid}`;
  const probe = await votesCol().findOne({ channel, ts }, { projection: { [base]: 1 } });
  const had = !!(probe && probe.votes && probe.votes[qid] && Array.isArray(probe.votes[qid][oid]) && probe.votes[qid][oid].includes(userId));
  const ev = { u: userId, q: qid, o: oid, t: new Date(), a: had ? '-' : '+' };
  const update = { $push: { vote_events: ev }, $setOnInsert: { team: pollData.team, poll_id: String(value.poll_id) } };
  if (had) {
    update.$pull = { [base]: userId }; // toggle off
  } else {
    update.$addToSet = { [base]: userId }; // toggle on
    if (!value.multi) {
      // single-select: remove this voter from the question's OTHER options
      const q = (pollData.questions || []).find((x) => x.id === qid);
      const n = (q && Array.isArray(q.options)) ? q.options.length : 0;
      const pull = {};
      for (let i = 0; i < n; i++) if (i !== oid) pull[`votes.${qid}.${i}`] = userId;
      if (Object.keys(pull).length) update.$pull = pull;
    }
  }
  await votesCol().updateOne({ channel, ts }, update, { upsert: true });
  await rebuildMessage(client, token, pollData, channel, ts);
}

/** Open the typed answer modal (action_id mq_answer). */
async function handleAnswerOpen({ ack, body, action, client, context }) {
  await ack();
  const value = JSON.parse(action.value);
  const channel = body.channel.id;
  const ts = body.message.ts;
  const userId = body.user.id;
  const vdoc = await loadVotes(value.poll_id, channel, ts);
  const current = vdoc && vdoc.answers && vdoc.answers[value.qid] && vdoc.answers[value.qid][userId];
  await client.views.open({ trigger_id: body.trigger_id, view: buildAnswerModalView(value.poll_id, value.qid, value.type, value.text, current, channel, ts, value.user_lang) });
}

/** Save a typed answer (callback_id mq_answer_submit). */
async function handleAnswerSubmit({ ack, body, view, client, context }) {
  await ack();
  const meta = JSON.parse(view.private_metadata || '{}');
  const token = context.botToken;
  if (await isPollClosed(meta.channel, meta.ts)) return; // poll closed -> ignore the answer
  const userId = body.user.id;
  const val = readAnswerValue(view);
  const pollData = await loadPoll(meta.poll_id);
  // Atomic per-user write: only this question/user path, so concurrent answers
  // from other users are never clobbered (the old whole-`answers` $set lost them).
  const path = `answers.${meta.qid}.${userId}`;
  if (val == null || String(val).trim() === '') {
    await votesCol().updateOne({ channel: meta.channel, ts: meta.ts }, { $unset: { [path]: '' } });
  } else {
    await votesCol().updateOne(
      { channel: meta.channel, ts: meta.ts },
      { $set: { [path]: String(val).slice(0, MAX_TEXT_LEN) }, $setOnInsert: { team: pollData && pollData.team, poll_id: String(meta.poll_id) } },
      { upsert: true },
    );
  }
  if (pollData) await rebuildMessage(client, token, pollData, meta.channel, meta.ts);
}

/** Reveal/hide a hidden multi-question poll (action_id mq_reveal). */
async function handleReveal({ ack, body, action, client, context }) {
  await ack();
  const token = context.botToken;
  const value = JSON.parse(action.value);
  const pollData = await loadPoll(value.poll_id);
  if (!pollData) return;
  // Flip the LIVE reveal state (para.revealed), not the immutable hide setting.
  const newRevealed = (value.reveal === 1); // reveal=1 -> show results; 0 -> hide again
  await pollCol().updateOne({ _id: pollData._id }, { $set: { 'para.revealed': newRevealed } });
  pollData.para = { ...pollData.para, revealed: newRevealed };
  await rebuildMessage(client, token, pollData, body.channel.id, body.message.ts);
}

/** Close a multi-question poll (action_id mq_close). */
async function handleClose({ ack, body, action, client, context }) {
  await ack();
  const token = context.botToken;
  const value = JSON.parse(action.value);
  const pollData = await loadPoll(value.poll_id);
  if (!pollData) return;
  try { await _db.collection('closed').updateOne({ channel: body.channel.id, ts: body.message.ts }, { $setOnInsert: { team: pollData.team }, $set: { closed: true } }, { upsert: true }); } catch (e) { /* best-effort */ }
  await rebuildMessage(client, token, pollData, body.channel.id, body.message.ts); // reads closed=true just set
}

/** Per-question "add choice" (action_id mq_addchoice) → small modal. */
async function handleAddChoiceOpen({ ack, body, action, client }) {
  await ack();
  const value = JSON.parse(action.value);
  const L = value.user_lang || 'en';
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal', callback_id: 'mq_addchoice_submit',
      private_metadata: JSON.stringify({ poll_id: value.poll_id, qid: value.qid, channel: body.channel.id, ts: body.message.ts, user_lang: L }),
      title: { type: 'plain_text', text: trimText(stri18n(L, 'mq_add_choice_title'), 24) }, submit: { type: 'plain_text', text: trimText(stri18n(L, 'mq_add_choice_submit'), 24) }, close: { type: 'plain_text', text: trimText(stri18n(L, 'btn_cancel'), 24) },
      blocks: [{ type: 'input', block_id: 'mq_newopt', label: { type: 'plain_text', text: trimText(stri18n(L, 'mq_new_choice'), 2000) }, element: { type: 'plain_text_input', action_id: 'v', max_length: 150 } }],
    },
  });
}

async function handleAddChoiceSubmit({ ack, body, view, client, context }) {
  const meta = JSON.parse(view.private_metadata || '{}');
  const text = ((view.state.values.mq_newopt && view.state.values.mq_newopt.v && view.state.values.mq_newopt.v.value) || '').trim();
  if (!text) { await ack({ response_action: 'errors', errors: { mq_newopt: stri18n(meta.user_lang || 'en', 'mq_err_enter_choice') } }); return; }
  await ack();
  const pollData = await loadPoll(meta.poll_id);
  if (!pollData || !isMulti(pollData)) return;
  if (await isPollClosed(meta.channel, meta.ts)) return;
  const q = pollData.questions.find((x) => x.id === meta.qid);
  if (!q || !isChoice(q.type)) return;
  if ((q.options || []).length >= MAX_OPTIONS) return;
  const opt = text.slice(0, 150);
  // budget check on the would-be shape (advisory; atomic op below is the real write)
  const wouldBe = pollData.questions.map((x) => (x.id === meta.qid ? { ...x, options: [...(x.options || []), opt] } : x));
  if (estimateBlocks(wouldBe) > MAX_BLOCKS) return; // would exceed Slack's block limit
  // Atomic: push only into THIS question's options (arrayFilters) so concurrent
  // edits don't clobber the whole questions[] array. Mirror Q1 to legacy `options`.
  const update = { $push: { 'questions.$[q].options': opt } };
  if (pollData.questions[0] && pollData.questions[0].id === meta.qid) update.$push.options = opt;
  await pollCol().updateOne({ _id: pollData._id }, update, { arrayFilters: [{ 'q.id': meta.qid }] });
  q.options = [...(q.options || []), opt]; // reflect for the immediate re-render
  if (pollData.questions[0] && pollData.questions[0].id === meta.qid) pollData.options = [...(pollData.options || []), opt];
  await rebuildMessage(client, context.botToken, pollData, meta.channel, meta.ts);
}

/** Register all mq_* handlers on the Bolt app. Call once from index.js. */
function register(app) {
  app.action('mq_vote', wrap(handleVote, 'mq_vote'));
  app.action('mq_answer', wrap(handleAnswerOpen, 'mq_answer'));
  app.action('mq_reveal', wrap(handleReveal, 'mq_reveal'));
  app.action('mq_close', wrap(handleClose, 'mq_close'));
  app.action('mq_addchoice', wrap(handleAddChoiceOpen, 'mq_addchoice'));
  app.view('mq_create_submit', wrap(handleCreateSubmit, 'mq_create_submit'));
  app.view('mq_answer_submit', wrap(handleAnswerSubmit, 'mq_answer_submit'));
  app.view('mq_addchoice_submit', wrap(handleAddChoiceSubmit, 'mq_addchoice_submit'));
}

// Wrap a handler so an exception never crashes Bolt; ack on error to avoid a hang.
// Logs only a generic message (no ids/data — public repo).
function wrap(fn, name) {
  return async (args) => {
    try { await fn(args); }
    catch (e) {
      try { if (args.ack) await args.ack(); } catch (_) { /* already acked */ }
      // eslint-disable-next-line no-console
      console.error(`[multiquestion] ${name} failed: ${e && e.message}`);
    }
  };
}

module.exports = {
  init, register, isMulti, openCreateModal,
  // exported for unit tests:
  parseForm, applyVote, applyAnswer, formatAnswer, buildBlocks, parseCreateSubmit,
  buildCreateModalView, buildAnswerModalView, answerElement, readAnswerValue, estimateBlocks,
  MAX_QUESTIONS, MAX_OPTIONS, MAX_BLOCKS, ALL_TYPES,
};
