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
const { stri18n, parameterizedString, slackNumToEmoji, langList } = require('./i18n');

let _db = null;
let _opts = {};
/** Wire up the Mongo handle + options (called once from index.js after connect).
 *  opts.resolveTeamDefaults(teamId) -> { app_lang, true_anonymous } lets forms
 *  honor each team's config defaults, the same way the single-question modal does. */
function init(db, opts) {
  _db = db; _opts = opts || {};
  // Visual-builder drafts are transient + GC themselves via a TTL index (24h) so
  // abandoned builds never accumulate. Best-effort (a missing index just means no auto-GC).
  try { _db.collection('mq_drafts').createIndex({ created_at: 1 }, { expireAfterSeconds: 86400 }).catch(() => {}); } catch (e) { /* noop */ }
}
async function teamDefaults(teamId) {
  try { if (_opts.resolveTeamDefaults) return (await _opts.resolveTeamDefaults(teamId)) || {}; } catch (e) { /* use built-in defaults */ }
  return {};
}
const pollCol = () => _db.collection('poll_data');
const votesCol = () => _db.collection('votes');

// ── Visual-builder draft store (server-side build state; private_metadata's 3000-char
// cap can't hold a form). A draft holds the in-progress form; only its _id rides in
// the modal's private_metadata. Deleted on create/cancel; TTL-GC'd if abandoned. ──
const draftCol = () => _db.collection('mq_drafts');
async function createDraft(d) {
  const doc = {
    team: d.team, user_id: d.user_id, channel: d.channel || null, response_url: d.response_url || '',
    root_view_id: null, mode: d.mode || 'visual', title: d.title || '',
    settings: { anonymous: !!(d.settings && d.settings.anonymous), hidden: !!(d.settings && d.settings.hidden), user_lang: (d.settings && d.settings.user_lang) || d.lang || 'en' },
    questions: Array.isArray(d.questions) ? d.questions : [],
    created_at: new Date(), updated_at: new Date(),
  };
  const r = await draftCol().insertOne(doc); doc._id = r.insertedId; return doc;
}
async function loadDraft(id) { try { return await draftCol().findOne({ _id: new ObjectId(String(id)) }); } catch (e) { return null; } }
async function patchDraft(id, patch) { try { await draftCol().updateOne({ _id: new ObjectId(String(id)) }, { $set: { ...patch, updated_at: new Date() } }); } catch (e) { /* noop */ } }
async function deleteDraft(id) { try { await draftCol().deleteOne({ _id: new ObjectId(String(id)) }); } catch (e) { /* noop */ } }

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
    if (cur.type === 'yesno') cur.options = [t('mq_yes'), t('mq_no')];
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
      item.options = q.type === 'yesno' ? [t('mq_yes'), t('mq_no')] : (q.options || []).slice(0, MAX_OPTIONS);
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
// Slack caps a section's text at 3000 chars — trim with a margin (parity with the
// single-question poll's truncateForSection).
function sectionMd(text) { return { type: 'section', text: { type: 'mrkdwn', text: trimText(text, 2990) } }; }
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
  const _pp = pollData.para || {};
  // Effective "votes hidden right now". Single-question lets ANY poll hide/reveal votes
  // anytime, so the multi must too: a live `para.hide_active` flag drives it (set by the
  // menu toggle). Backward-compat for polls created before this: fall back to the old
  // (created-hidden && !revealed) model when hide_active was never set.
  const hidden = (_pp.hide_active !== undefined ? !!_pp.hide_active : (!!_pp.hidden && !revealed)) && !opts.isClosed;
  const votes = (votesDoc && votesDoc.votes) || {};
  const answers = (votesDoc && votesDoc.answers) || {};
  const pollId = String(pollData._id);
  const para = pollData.para || {};
  const blocks = [];

  // Management menu — a RIGHT-ALIGNED section accessory with option_groups (Poll
  // actions / User actions), mirroring the single-question poll. Command Info + See
  // your votes are ALWAYS available (User actions); mutating actions (reveal/close/
  // reopen/delete) are creator-guarded in handleMenu.
  const mtext = (k) => ({ type: 'plain_text', emoji: true, text: trimText(stri18n(userLang, k), 75) });
  const mopt = (k, val) => ({ text: mtext(k), value: JSON.stringify(val) });
  const pollActions = [];
  // Hide/reveal is ALWAYS available (any poll, like single) — toggles para.hide_active.
  pollActions.push(mopt(hidden ? 'menu_reveal_vote' : 'menu_hide_vote', { a: 'reveal', poll_id: pollId, reveal: hidden ? 1 : 0 }));
  if (!(anonymous && para.true_anonymous)) pollActions.push(mopt('menu_all_user_vote', { a: 'allvotes', poll_id: pollId }));
  pollActions.push(mopt(opts.isClosed ? 'menu_reopen_poll' : 'menu_close_poll', { a: opts.isClosed ? 'reopen' : 'close', poll_id: pollId }));
  // Delete is destructive — guard with a native confirm dialog (mirrors the single-poll
  // delete-confirm; handleMenu also re-checks creator ownership). Reuses single's keys.
  pollActions.push({ ...mopt('menu_delete_poll', { a: 'delete', poll_id: pollId }), confirm: {
    title: { type: 'plain_text', text: trimText(stri18n(userLang, 'menu_are_you_sure'), 100) },
    text: { type: 'mrkdwn', text: trimText(stri18n(userLang, 'task_delete_refer_warn'), 300) },
    confirm: { type: 'plain_text', text: trimText(stri18n(userLang, 'menu_delete_poll'), 30) },
    deny: { type: 'plain_text', text: trimText(stri18n(userLang, 'btn_cancel'), 30) },
  } });
  if (para.show_dashboard_link) pollActions.push(mopt('menu_view_on_dashboard', { a: 'dashboard', poll_id: pollId }));
  const userActions = [mopt('menu_user_self_vote', { a: 'myvotes', poll_id: pollId }), mopt('menu_command_info', { a: 'cmdinfo', poll_id: pollId })];
  const menuAccessory = {
    type: 'static_select', action_id: 'mq_menu',
    placeholder: { type: 'plain_text', emoji: true, text: trimText(stri18n(userLang, 'info_menu_placeholder'), 150) },
    option_groups: [
      { label: { type: 'plain_text', text: trimText(stri18n(userLang, 'menu_poll_action'), 75) }, options: pollActions },
      { label: { type: 'plain_text', text: trimText(stri18n(userLang, 'menu_user_action'), 75) }, options: userActions },
    ],
  };

  // Title as a section with the menu accessory on the right (unless menu_at_the_end),
  // exactly like the single-question poll.
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${trimText(pollData.question || 'Poll', 150)}*` }, ...(para.menu_at_the_end ? {} : { accessory: menuAccessory }) });

  // Flags + creator + question-count context, mirroring the single-question poll
  // (same i18n keys; creator shown per display_poller_name "tag"/"none", not a bool).
  const els = [];
  if (anonymous) els.push({ type: 'mrkdwn', text: stri18n(userLang, 'info_anonymous') });
  if (hidden) els.push({ type: 'mrkdwn', text: stri18n(userLang, 'info_hidden') }); // reflect the live hidden state (hide_active toggle)
  const showPoller = (para.display_poller_name === 'tag' || para.display_poller_name === true);
  if (pollData.user_id && showPoller) els.push({ type: 'mrkdwn', text: parameterizedString(stri18n(userLang, 'info_by'), { user_id: pollData.user_id }) });
  const nq = pollData.questions.length;
  els.push({ type: 'mrkdwn', text: parameterizedString(stri18n(userLang, nq === 1 ? 'mq_n_questions_one' : 'mq_n_questions_many'), { count: nq }) });
  if (opts.isClosed) els.push({ type: 'mrkdwn', text: stri18n(userLang, 'info_closed') }); // reuse single's closed badge (":x: Closed")
  blocks.push({ type: 'context', elements: els });

  // Mobile "View Full Message" hint (info_addon — per-language, empty in en) + the
  // anonymous notice, same as the single-question poll.
  let addInfo = stri18n(userLang, 'info_addon');
  if (anonymous && !para.true_anonymous) { if (addInfo) addInfo += '\n'; addInfo += stri18n(userLang, 'info_anonymous_notice'); }
  if (addInfo) blocks.push(contextMd(addInfo));
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
        // Cap rendered answers (long free text) so the section can't exceed Slack's
        // 3000-char limit. A dedicated, smaller cap than option-voter @mentions: each
        // answer line is ~80+ chars, so 25 × ~95 ≈ 2375 stays comfortably under.
        const ANS_CAP = 25;
        const shown = answeredBy.slice(0, ANS_CAP).map((u) => `<@${u}>: ${trimText(formatAnswer(q.type, qa[u]), 80)}`).join('\n');
        const extra = answeredBy.length - Math.min(answeredBy.length, ANS_CAP);
        summary = shown + (extra > 0 ? `\n${parameterizedString(stri18n(userLang, 'mq_more'), { count: extra })}` : '');
      }
      blocks.push({
        type: 'section',
        // Hard backstop: section text must be <=3000 or chat.update rejects (freezes the poll).
        text: { type: 'mrkdwn', text: trimText(summary || ' ', 2990) },
        accessory: opts.isClosed ? undefined : {
          type: 'button', action_id: 'mq_answer',
          text: { type: 'plain_text', emoji: true, text: '✏️ ' + stri18n(userLang, 'btn_answer') },
          value: JSON.stringify({ poll_id: pollId, qid: q.id, type: q.type, text: q.text, user_lang: userLang }),
        },
      });
    }
    blocks.push(divider());
  });

  // Visible command-source line when show_command_info is on — same as the single-question
  // poll (the menu also always has a "Command Info" option for the full ephemeral detail).
  if (para.show_command_info && pollData.cmd) blocks.push(contextMd(trimText(stri18n(userLang, 'info_command_source') + ' ' + pollData.cmd, 2900)));

  // When menu_at_the_end, the menu lives on a trailing section accessory (the title
  // section above carries no accessory in that case) — same as the single-question poll.
  if (para.menu_at_the_end) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: ' ' }, accessory: menuAccessory });
  return blocks;
}

function trimText(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// Multi-question is BETA — append a literal " (BETA)" marker (same in every language)
// to the create-modal title, keeping it within Slack's 24-char title cap.
function betaTitle(s) { const b = ' (BETA)'; const full = String(s == null ? '' : s) + b; return full.length <= 24 ? full : trimText(s, 24 - b.length) + b; }

// ───────────────────────── create modal + submit ────────────────────────────

// All user-facing strings come from the language files (stri18n), same as the
// single-question flow, so the form is fully translatable. `lang` = the team's
// resolved language; `initialForm` pre-fills the Questions box (command preview /
// error-recovery so a user's work is never lost).
function buildCreateModalView(channelId, responseUrl, lang, initialForm, langSelectable, useResponseUrl) {
  const L = lang || 'en';
  const t = (k) => stri18n(L, k);
  const opt = (val, key) => ({ text: { type: 'plain_text', text: trimText(t(key), 75) }, value: val });
  return {
    type: 'modal',
    callback_id: 'mq_create_submit',
    // channel/response_url/lang/lang_selectable kept in private_metadata so the
    // poll-type selector can preserve them when swapping back to single-question.
    private_metadata: JSON.stringify({ channel: channelId || null, response_url: responseUrl || '', user_lang: L, lang_selectable: !!langSelectable }),
    title: { type: 'plain_text', text: betaTitle(t('mq_modal_title')) },
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
      // Channel section — mirrors the single-question poll exactly (same i18n keys):
      // in response_url mode the poll auto-posts to the command's channel (no selector,
      // no bot membership needed); otherwise a channel picker + the bot-invite warning.
      { type: 'section', text: { type: 'mrkdwn', text: t('modal_ch_manual_select') } },
      ...((useResponseUrl && responseUrl) ? [
        { type: 'context', elements: [{ type: 'mrkdwn', text: t('modal_ch_response_url_auto') }] },
      ] : [
        { type: 'input', block_id: 'mq_channel', optional: true, label: { type: 'plain_text', text: trimText(t('modal_ch_select'), 2000) },
          element: { type: 'conversations_select', action_id: 'v', filter: { include: ['private', 'public'] }, default_to_current_conversation: true, ...(channelId ? { initial_conversation: channelId } : {}) } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: useResponseUrl ? parameterizedString(t('modal_ch_warn_with_response_url'), { slack_command: _opts.slackCommand || 'poll', bot_name: _opts.botName || 'Open Poll Plus' }) : t('modal_ch_warn') }] },
      ]),
      // Per-poll language selector (single-question parity) — only when the team
      // allows it (app_lang_user_selectable). Options come from the loaded languages.
      ...((langSelectable && Object.keys(langList).length) ? [{
        type: 'input', block_id: 'mq_lang', optional: true,
        label: { type: 'plain_text', text: trimText(t('info_lang_select_label'), 2000) },
        element: {
          type: 'static_select', action_id: 'v',
          placeholder: { type: 'plain_text', text: trimText(t('info_lang_select_hint'), 150) },
          ...(langList[L] ? { initial_option: { text: { type: 'plain_text', text: trimText(langList[L] || L, 75) }, value: L } } : {}),
          options: Object.keys(langList).map((k) => ({ text: { type: 'plain_text', text: trimText(langList[k] || k, 75) }, value: k })),
        },
      }] : []),
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
  const selLang = (v.mq_lang && v.mq_lang.v && v.mq_lang.v.selected_option && v.mq_lang.v.selected_option.value) || null;
  const { questions, errors } = parseForm(formText, lang);
  return {
    title: title || (questions[0] && questions[0].text) || 'Poll',
    channel,
    questions,
    errors,
    lang: (selLang && langList[selLang]) ? selLang : null, // per-poll language override
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

function buildAnswerModalView(pollId, qid, type, qText, current, channel, ts, lang, responseUrl) {
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
    // response_url carried so the channel message can be updated after submit even when
    // the bot isn't a member (modal submits have no response_url of their own).
    private_metadata: JSON.stringify({ poll_id: pollId, qid, type, channel, ts, user_lang: L, response_url: responseUrl || '' }),
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

// True when the app is configured to post via response_url (reusing the single-question
// poll's posting) AND a usable response_url is in hand — lets forms reach a channel the
// bot isn't a member of, exactly like the single-question poll.
function canUseResponseUrl(responseUrl) { return !!(_opts.isUseResponseUrl && _opts.postChat && responseUrl); }

/** Re-render the poll message from current DB state (after a vote/answer/menu).
 *  Closed-state is read from the DB so a stale/racing click can never un-close.
 *  When response_url posting is on, updates go through the interaction's response_url
 *  (no bot membership needed); otherwise via the bot Web API (chat.update). */
async function rebuildMessage(client, token, pollData, channel, ts, responseUrl) {
  const votesDoc = await loadVotes(pollData._id, channel, ts);
  const isClosed = await isPollClosed(channel, ts);
  const blocks = buildBlocks(pollData, votesDoc, { userLang: pollData.para && pollData.para.user_lang, isClosed });
  const text = trimText(pollData.question || 'Poll', 150);
  if (canUseResponseUrl(responseUrl)) await _opts.postChat(responseUrl, 'update', { token, channel, ts, blocks, text });
  else await client.chat.update({ token, channel, ts, text, blocks });
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
async function openCreateModal(client, triggerId, channelId, responseUrl, teamId, initialForm, userId) {
  // Now opens the VISUAL builder (default). The DSL textarea lives on as "Advanced" mode.
  await openBuilder({ client, triggerId, channel: channelId, responseUrl, teamId, userId: userId || null, initialForm });
}

// Rebuild the single-line `/<cmd> multi …` command that recreates this form — used
// for the command-info context block AND the error-recovery DM. Lines are joined
// by " | " so it pastes back as one slash command.
function formToLines(questions) {
  const lines = [];
  for (const q of (questions || [])) {
    const flags = [];
    if (q.multi) flags.push('multi');
    if (q.user_add_choice) flags.push('add');
    if (q.required) flags.push('required');
    lines.push(`Q: ${q.text} [${[q.type, ...flags].join(' ')}]`);
    if (isChoice(q.type) && q.type !== 'yesno') for (const o of (q.options || [])) lines.push(`- ${o}`);
  }
  return lines;
}
// One-line command form (` | `-separated) vs multiline modal form (`\n`-separated,
// what parseForm reads). Same content, different separator.
function formToCommandDSL(questions) { return formToLines(questions).join(' | '); }
function formToModalDSL(questions) { return formToLines(questions).join('\n'); }
function commandString(questions, para) {
  const cmd = _opts.slackCommand || 'poll';
  const kws = [];
  if (para && para.anonymous) kws.push('anonymous');
  if (para && para.hidden) kws.push('hidden');
  return `/${cmd} multi ${kws.length ? kws.join(' ') + ' ' : ''}${formToCommandDSL(questions)}`;
}

// Shared create+post for BOTH the modal submit and the command path. Stamps config
// onto para (config-safe), stores the recreate-command on pollData.cmd, posts the
// message, records the ts, and on a post failure DMs the creator the recovery command
// so their work is never lost. Returns { ok }.
async function createAndPost(client, token, { teamOrEnt, userId, channel, title, questions, paraIn, lang, responseUrl }) {
  const q1 = questions[0];
  const para = {
    user_lang: lang,
    anonymous: !!paraIn.anonymous,
    true_anonymous: !!paraIn.true_anonymous,
    hidden: !!paraIn.hidden,
    menu_at_the_end: !!paraIn.menu_at_the_end,
    show_command_info: !!paraIn.show_command_info,
    show_dashboard_link: !!paraIn.show_dashboard_link,
    display_poller_name: paraIn.display_poller_name, // raw "tag"/"none" — single-poll semantics
    form_version: 2,
  };
  const cmd = commandString(questions, para);
  const pollData = {
    team: teamOrEnt, channel, ts: null, created_ts: new Date(), user_id: userId,
    cmd, cmd_via: 'mq_modal',
    question: title,                                     // compat mirror
    options: isChoice(q1.type) ? (q1.options || []) : [], // compat mirror
    questions, para,
  };
  const res = await pollCol().insertOne(pollData);
  pollData._id = res.insertedId;
  const blocks = buildBlocks(pollData, null, { userLang: lang });
  const text = trimText(title, 150);
  // Can't post (e.g. bot not in channel) — DM the creator the recreate command +
  // roll back the orphan poll, so nothing they typed is lost.
  const recoveryFail = async () => {
    const dm = `${stri18n(lang, 'mq_post_failed')}\n${stri18n(lang, 'mq_recover_dm')}\n\`\`\`${cmd}\`\`\``;
    try { await client.chat.postMessage({ token, channel: userId, text: dm }); } catch (_) { /* noop */ }
    await pollCol().deleteOne({ _id: pollData._id });
    return { ok: false };
  };
  if (canUseResponseUrl(responseUrl)) {
    // Reuse the single-question poll's response_url posting: posts to the command's
    // channel WITHOUT the bot needing to be a member. No ts is returned — poll_data.ts
    // stays null and the votes doc is created lazily on the first interaction (by poll_id,
    // keyed by the real (channel,ts) from the interaction body) — same model as single.
    let r = null;
    try { r = await _opts.postChat(responseUrl, 'post', { token, channel, blocks, text }); } catch (e) { r = null; }
    if (!r || r.status === false) return recoveryFail();
  } else {
    let posted = null;
    try { posted = await client.chat.postMessage({ token, channel, text, blocks }); }
    catch (e) { return recoveryFail(); }
    if (posted && posted.ts) {
      await pollCol().updateOne({ _id: pollData._id }, { $set: { ts: posted.ts, channel: posted.channel || channel } });
      await votesCol().insertOne({ team: teamOrEnt, channel: posted.channel || channel, ts: posted.ts, poll_id: String(pollData._id), votes: {}, answers: {} });
    }
  }
  return { ok: true };
}

/** Create a form directly from a slash command: `/<cmd> multi [anonymous] [hidden] Q: … | …`.
 *  Returns { ok, formText, errors } — on parse error the caller opens the builder
 *  pre-filled with formText so the user's typing is never lost. */
async function createFromCommand({ client, token, teamId, userId, channel, dsl, responseUrl }) {
  const defs = await teamDefaults(teamId);
  const lang = defs.app_lang || 'en';
  let text = String(dsl || '').trim();
  const paraIn = { anonymous: false, hidden: false };
  const kw = text.match(/^((?:anonymous|hidden)\b\s+)+/i);
  if (kw) { const s = kw[0].toLowerCase(); if (s.includes('anonymous')) paraIn.anonymous = true; if (s.includes('hidden')) paraIn.hidden = true; text = text.slice(kw[0].length); }
  const formText = text.replace(/\s+\|\s+/g, '\n');
  const { questions, errors } = parseForm(formText, lang);
  if (!questions.length || (errors && errors.length)) return { ok: false, formText, errors };
  if (estimateBlocks(questions) > MAX_BLOCKS) return { ok: false, formText, errors: [parameterizedString(stri18n(lang, 'mq_err_too_big'), { max: MAX_BLOCKS })] };
  if (!channel) return { ok: false, formText, errors: [stri18n(lang, 'mq_err_pick_channel')] };
  paraIn.true_anonymous = !!(paraIn.anonymous && defs.true_anonymous);
  paraIn.menu_at_the_end = defs.menu_at_the_end;
  paraIn.show_command_info = defs.show_command_info;
  paraIn.show_dashboard_link = defs.show_dashboard_link;
  paraIn.display_poller_name = defs.display_poller_name;
  const r = await createAndPost(client, token, { teamOrEnt: teamId, userId, channel, title: questions[0].text, questions, paraIn, lang, responseUrl });
  return { ok: r.ok, formText };
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
  // In response_url mode the modal has NO channel selector (posts to the command's
  // channel, carried in private_metadata) — fall back to pm.channel. Same as single.
  let pm = {}; try { pm = JSON.parse(view.private_metadata || '{}'); } catch (e) { pm = {}; }
  const responseUrl = pm.response_url || '';
  const channel = parsed.channel || pm.channel || null;
  if (!channel) { await ack({ response_action: 'errors', errors: { mq_channel: t('mq_err_pick_channel') } }); return; }
  if (estimateBlocks(parsed.questions) > MAX_BLOCKS) {
    await ack({ response_action: 'errors', errors: { mq_form: t('mq_err_too_big', { max: MAX_BLOCKS }) } });
    return;
  }
  await ack();
  const token = context.botToken;
  const userId = body.user.id;
  const trueAnon = !!(parsed.para.anonymous && defs.true_anonymous);
  const pollLang = parsed.lang || lang; // per-poll language selector overrides the team default
  // Delegate to the shared create+post (same path the command uses).
  await createAndPost(client, token, {
    teamOrEnt, userId, channel, title: parsed.title, questions: parsed.questions,
    paraIn: {
      anonymous: parsed.para.anonymous, true_anonymous: trueAnon, hidden: parsed.para.hidden,
      menu_at_the_end: defs.menu_at_the_end, show_command_info: defs.show_command_info,
      show_dashboard_link: defs.show_dashboard_link, display_poller_name: defs.display_poller_name,
    },
    lang: pollLang, responseUrl,
  });
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
  if (await isPollClosed(channel, ts)) { await rebuildMessage(client, token, pollData, channel, ts, body.response_url); return; } // closed: re-render, no write
  // Serialize the probe+upsert per message (same mutex single's btn_vote uses) so the
  // lazy votes-doc create (response_url mode) can't duplicate under concurrent first votes.
  const release = _opts.lock ? await _opts.lock(`${pollData.team}/${channel}/${ts}`) : null;
  try {
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
  } finally { if (release) release(); }
  await rebuildMessage(client, token, pollData, channel, ts, body.response_url);
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
  await client.views.open({ trigger_id: body.trigger_id, view: buildAnswerModalView(value.poll_id, value.qid, value.type, value.text, current, channel, ts, value.user_lang, body.response_url) });
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
  // Wrapped in the per-message mutex so the lazy votes-doc create (response_url mode)
  // can't duplicate under concurrent first-answers — same as handleVote.
  const path = `answers.${meta.qid}.${userId}`;
  const release = _opts.lock ? await _opts.lock(`${(pollData && pollData.team)}/${meta.channel}/${meta.ts}`) : null;
  try {
    if (val == null || String(val).trim() === '') {
      await votesCol().updateOne({ channel: meta.channel, ts: meta.ts }, { $unset: { [path]: '' } });
    } else {
      await votesCol().updateOne(
        { channel: meta.channel, ts: meta.ts },
        { $set: { [path]: String(val).slice(0, MAX_TEXT_LEN) }, $setOnInsert: { team: pollData && pollData.team, poll_id: String(meta.poll_id) } },
        { upsert: true },
      );
    }
  } finally { if (release) release(); }
  if (pollData) await rebuildMessage(client, token, pollData, meta.channel, meta.ts, meta.response_url);
}

// Shared menu actions — used by mq_menu (new polls) AND the legacy mq_reveal/mq_close
// buttons that already-posted polls still carry.
async function doReveal(client, token, pollData, channel, ts, reveal, responseUrl) {
  // Live hide toggle (any poll, like single): reveal=1 → show (hide_active=false);
  // reveal=0 → hide (hide_active=true). Keeps para.revealed in sync for back-compat reads.
  const hideActive = (reveal === 0);
  await pollCol().updateOne({ _id: pollData._id }, { $set: { 'para.hide_active': hideActive, 'para.revealed': !hideActive } });
  pollData.para = { ...pollData.para, hide_active: hideActive, revealed: !hideActive };
  await rebuildMessage(client, token, pollData, channel, ts, responseUrl);
}
async function doSetClosed(client, token, pollData, channel, ts, closed, responseUrl) {
  try {
    if (closed) await _db.collection('closed').updateOne({ channel, ts }, { $setOnInsert: { team: pollData.team }, $set: { closed: true } }, { upsert: true });
    else await _db.collection('closed').deleteOne({ channel, ts });
  } catch (e) { /* best-effort */ }
  await rebuildMessage(client, token, pollData, channel, ts, responseUrl);
}
async function doDelete(client, token, pollData, channel, ts, responseUrl, userId) {
  // Mirror the single-question poll's delete (deletePollConfirm): delete the MESSAGE
  // FIRST; if that fails, do NOT wipe the DB (or the surviving message's buttons stop
  // resolving) — tell the user via an ephemeral. Only when the message is gone do we
  // delete the DB rows, and only if the workspace's delete_data_on_poll_delete is on.
  let ok = true;
  if (canUseResponseUrl(responseUrl)) {
    let r = null; try { r = await _opts.postChat(responseUrl, 'delete', { token, channel, ts }); } catch (e) { r = null; }
    ok = !!(r && r.status !== false);
  } else {
    try { await client.chat.delete({ token, channel, ts }); } catch (e) { ok = false; }
  }
  if (!ok) {
    const lang = (pollData.para && pollData.para.user_lang) || 'en';
    try { await client.chat.postEphemeral({ token, channel, user: userId, text: stri18n(lang, 'err_delete_failed') }); } catch (e) { /* noop */ }
    return;
  }
  let delData = false;
  try { const defs = await teamDefaults(pollData.team); delData = !!defs.delete_data_on_poll_delete; } catch (e) { /* keep data when unsure */ }
  if (delData) {
    try { await pollCol().deleteOne({ _id: pollData._id }); } catch (e) { /* noop */ }
    try { await votesCol().deleteMany({ channel, ts }); } catch (e) { /* noop */ }
    try { await votesCol().deleteMany({ poll_id: String(pollData._id) }); } catch (e) { /* noop */ } // response_url mode: votes doc keyed by poll_id
    try { await _db.collection('closed').deleteMany({ channel, ts }); } catch (e) { /* noop */ }
    try { await _db.collection('hidden').deleteMany({ channel, ts }); } catch (e) { /* noop */ }
  }
}

/** Legacy reveal button (mq_reveal) on already-posted polls. */
async function handleReveal({ ack, body, action, client, context }) {
  await ack();
  const value = JSON.parse(action.value);
  const pollData = await loadPoll(value.poll_id);
  if (!pollData) return;
  await doReveal(client, context.botToken, pollData, body.channel.id, body.message.ts, value.reveal, body.response_url);
}

/** Legacy close button (mq_close) on already-posted polls. */
async function handleClose({ ack, body, action, client, context }) {
  await ack();
  const value = JSON.parse(action.value);
  const pollData = await loadPoll(value.poll_id);
  if (!pollData) return;
  await doSetClosed(client, context.botToken, pollData, body.channel.id, body.message.ts, true, body.response_url);
}

// Open a MODAL for the menu info actions (Command Info / See your votes / See users
// votes), exactly like the single-question poll — not an ephemeral message. Falls back
// to an ephemeral if views.open fails (expired trigger_id / content too large).
async function openInfoModal(client, token, body, titleKey, blocks, lang) {
  const view = {
    type: 'modal',
    title: { type: 'plain_text', text: trimText(stri18n(lang, titleKey), 24) },
    close: { type: 'plain_text', text: trimText(stri18n(lang, 'btn_close'), 24) },
    blocks: blocks.slice(0, 100),
  };
  try { await client.views.open({ token, trigger_id: body.trigger_id, view }); }
  catch (e) { try { await client.chat.postEphemeral({ token, channel: body.channel.id, user: body.user.id, text: stri18n(lang, 'err_modal_open_failed') }); } catch (_) { /* noop */ } }
}

// Command Info — modal with poll id + recreate command + created-via (single-poll parity).
async function sendCommandInfo(client, token, body, pollData, lang) {
  const blocks = [sectionMd(parameterizedString(stri18n(lang, 'info_poll_id_label'), { value: String(pollData._id) }))];
  if (pollData.cmd_via) blocks.push(sectionMd(parameterizedString(stri18n(lang, 'info_created_via_label'), { value: pollData.cmd_via })));
  if (pollData.cmd) blocks.push(divider(), sectionMd('```' + trimText(pollData.cmd, 2900) + '```'));
  await openInfoModal(client, token, body, 'menu_command_info', blocks, lang);
}
// "See your votes" — modal with a per-question summary of THIS user's choices/answers.
async function sendMyVotes(client, token, body, pollData, ts, lang) {
  const userId = body.user.id;
  const vdoc = await loadVotes(pollData._id, body.channel.id, ts);
  const votes = (vdoc && vdoc.votes) || {}; const answers = (vdoc && vdoc.answers) || {};
  const blocks = [];
  for (const q of (pollData.questions || [])) {
    let val = '—';
    if (isChoice(q.type)) {
      const qv = votes[q.id] || {}; const chosen = [];
      (q.options || []).forEach((opt, oi) => { if ((qv[String(oi)] || []).includes(userId)) chosen.push(opt); });
      if (chosen.length) val = chosen.join(', ');
    } else {
      const ans = (answers[q.id] || {})[userId];
      if (ans != null && ans !== '') val = formatAnswer(q.type, ans);
    }
    blocks.push(sectionMd(`*${trimText(q.text, 150)}*\n${val}`));
  }
  if (!blocks.length) blocks.push(sectionMd('—'));
  await openInfoModal(client, token, body, 'menu_user_self_vote', blocks, lang);
}
// "See users votes" — modal with a per-question voter breakdown. Anonymity mirrors the
// single poll: blocked for true-anonymous (ephemeral reject); anonymous = creator-only
// (a missing creator blocks everyone); public is visible to anyone.
async function sendAllVotes(client, token, body, pollData, ts, lang) {
  const userId = body.user.id; const para = pollData.para || {};
  const reject = async (k) => { try { if (_opts.notify) await _opts.notify(body, token, stri18n(lang, k), lang); else await client.chat.postEphemeral({ token, channel: body.channel.id, user: userId, text: stri18n(lang, k) }); } catch (e) { /* noop */ } };
  // CREATOR-ONLY, always — exactly like the single-question poll's usersVotes
  // (index.js usersVotes: body.user.id !== value.user → reject). This also prevents a
  // non-creator from seeing hidden/un-revealed voters or free-text answers early.
  if (!pollData.user_id || userId !== pollData.user_id) return reject('err_see_all_vote_other');
  if (para.anonymous && para.true_anonymous) return reject('err_see_all_vote_true_anonymous');
  const vdoc = await loadVotes(pollData._id, body.channel.id, ts);
  const votes = (vdoc && vdoc.votes) || {}; const answers = (vdoc && vdoc.answers) || {};
  const blocks = [];
  for (const q of (pollData.questions || [])) {
    const lines = [];
    if (isChoice(q.type)) {
      const qv = votes[q.id] || {};
      (q.options || []).forEach((opt, oi) => {
        const voters = qv[String(oi)] || [];
        lines.push(`${slackNumToEmoji(oi + 1, lang)} ${opt}: ${voters.length ? voters.slice(0, MAX_VOTER_MENTIONS).map((u) => `<@${u}>`).join(' ') + (voters.length > MAX_VOTER_MENTIONS ? ` ${parameterizedString(stri18n(lang, 'mq_more'), { count: voters.length - MAX_VOTER_MENTIONS })}` : '') : '—'}`);
      });
    } else {
      const qa = answers[q.id] || {}; const ks = Object.keys(qa);
      if (!ks.length) lines.push('—');
      else ks.slice(0, MAX_VOTER_MENTIONS).forEach((u) => lines.push(`<@${u}>: ${formatAnswer(q.type, qa[u])}`));
    }
    blocks.push(sectionMd(`*${trimText(q.text, 150)}*\n${lines.join('\n')}`));
  }
  if (!blocks.length) blocks.push(sectionMd('—'));
  await openInfoModal(client, token, body, 'menu_all_user_vote', blocks, lang);
}

/** Management menu dispatcher (mq_menu). Mutating actions (reveal/close/reopen/delete)
 *  are creator-only; see-votes / dashboard / command-info are open to anyone (anonymity
 *  enforced inside), mirroring the single-question poll. */
async function handleMenu({ ack, body, action, client, context }) {
  await ack();
  const token = context.botToken;
  const value = JSON.parse(action.selected_option.value);
  const a = value.a;
  const pollData = await loadPoll(value.poll_id);
  if (!pollData) return;
  const channel = body.channel.id; const ts = body.message.ts;
  const lang = (pollData.para && pollData.para.user_lang) || 'en';
  const ownerOnly = (a === 'reveal' || a === 'close' || a === 'reopen' || a === 'delete');
  if (ownerOnly && pollData.user_id && body.user.id !== pollData.user_id) {
    try { if (_opts.notify) await _opts.notify(body, token, stri18n(lang, 'err_action_other'), lang); else await client.chat.postEphemeral({ token, channel, user: body.user.id, text: stri18n(lang, 'err_action_other') }); } catch (e) { /* noop */ }
    return;
  }
  if (a === 'reveal') await doReveal(client, token, pollData, channel, ts, value.reveal, body.response_url);
  else if (a === 'close') await doSetClosed(client, token, pollData, channel, ts, true, body.response_url);
  else if (a === 'reopen') await doSetClosed(client, token, pollData, channel, ts, false, body.response_url);
  else if (a === 'delete') await doDelete(client, token, pollData, channel, ts, body.response_url, body.user.id);
  else if (a === 'cmdinfo') await sendCommandInfo(client, token, body, pollData, lang);
  else if (a === 'myvotes') await sendMyVotes(client, token, body, pollData, ts, lang);
  else if (a === 'allvotes') await sendAllVotes(client, token, body, pollData, ts, lang);
  else if (a === 'dashboard' && _opts.dashboardLinkAction) await _opts.dashboardLinkAction(body, client, context, { poll_id: value.poll_id, p_id: value.poll_id, user: body.user.id, user_lang: lang });
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
      private_metadata: JSON.stringify({ poll_id: value.poll_id, qid: value.qid, channel: body.channel.id, ts: body.message.ts, user_lang: L, response_url: body.response_url || '' }),
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
  await rebuildMessage(client, context.botToken, pollData, meta.channel, meta.ts, meta.response_url);
}

// ═══════════════════════ Visual (point-and-click) builder ════════════════════
// Root modal (re-rendered via views.update) lists the questions; a pushed per-question
// sub-modal edits one. State is an mq_drafts doc — only draft_id is in private_metadata
// (3000-char cap can't hold a form). "Advanced" mode = the same DSL textarea as before.
// Reuses parseForm (DSL→questions), formToCommandDSL (questions→DSL), createAndPost.

const TYPE_EMOJI = { choice: ':radio_button:', yesno: ':white_check_mark:', text: ':pencil:', number: ':1234:', date: ':calendar:', time: ':clock3:', datetime: ':date:', email: ':email:', url: ':link:' };
function typeLabel(lang, type) { return stri18n(lang, 'mq_qtype_' + type); }

// Capture whatever is currently in the root modal's inputs into the draft, so any
// button/select action (which re-renders) never loses in-flight typing. In advanced
// mode the DSL textarea is parsed into questions (bidirectional Visual⇄Advanced sync).
async function syncRootState(view, draft) {
  const v = (view && view.state && view.state.values) || {};
  const patch = {};
  if (v.mq_b_title && v.mq_b_title.v) patch.title = (v.mq_b_title.v.value || '').trim();
  if (v.mq_b_settings && v.mq_b_settings.v) { const sel = (v.mq_b_settings.v.selected_options || []).map((o) => o.value); patch['settings.anonymous'] = sel.includes('anonymous'); patch['settings.hidden'] = sel.includes('hidden'); }
  if (v.mq_channel && v.mq_channel.v && v.mq_channel.v.selected_conversation) patch.channel = v.mq_channel.v.selected_conversation;
  if (v.mq_lang && v.mq_lang.v && v.mq_lang.v.selected_option) patch['settings.user_lang'] = v.mq_lang.v.selected_option.value;
  if (draft.mode === 'advanced' && v.mq_form && v.mq_form.v) {
    const lang = (draft.settings && draft.settings.user_lang) || 'en';
    patch.questions = parseForm(v.mq_form.v.value || '', lang).questions; // keep structured truth current
  }
  await patchDraft(draft._id, patch);
  // reflect locally so the immediate re-render uses fresh values
  if ('title' in patch) draft.title = patch.title;
  if ('settings.anonymous' in patch) draft.settings.anonymous = patch['settings.anonymous'];
  if ('settings.hidden' in patch) draft.settings.hidden = patch['settings.hidden'];
  if ('channel' in patch) draft.channel = patch.channel;
  if ('settings.user_lang' in patch) draft.settings.user_lang = patch['settings.user_lang'];
  if ('questions' in patch) draft.questions = patch.questions;
}

function buildInitialSettings(draft, lang) {
  const t = (k) => stri18n(lang, k);
  const sel = [];
  if (draft.settings && draft.settings.anonymous) sel.push({ text: { type: 'mrkdwn', text: t('mq_opt_anonymous') }, value: 'anonymous' });
  if (draft.settings && draft.settings.hidden) sel.push({ text: { type: 'mrkdwn', text: t('mq_opt_hidden') }, value: 'hidden' });
  return sel.length ? { initial_options: sel } : {};
}

/** The root builder modal, rendered from the draft. */
function buildBuilderView(draft, useResponseUrl, langSelectable) {
  const lang = (draft.settings && draft.settings.user_lang) || 'en';
  const t = (k) => stri18n(lang, k);
  const blocks = [];
  // Mode toggle (Visual ⇄ Advanced) — section accessory static_select, like the poll-type selector.
  const modeOpt = (val, key) => ({ text: { type: 'plain_text', text: trimText(t(key), 75) }, value: val });
  blocks.push({ type: 'section', block_id: 'mq_b_mode_blk', text: { type: 'mrkdwn', text: `*${t('mq_b_mode_label')}*` },
    accessory: { type: 'static_select', action_id: 'mq_b_mode',
      initial_option: draft.mode === 'advanced' ? modeOpt('advanced', 'mq_b_mode_advanced') : modeOpt('visual', 'mq_b_mode_visual'),
      options: [modeOpt('visual', 'mq_b_mode_visual'), modeOpt('advanced', 'mq_b_mode_advanced')],
      confirm: { title: { type: 'plain_text', text: trimText(t('mq_switch_title'), 100) }, text: { type: 'mrkdwn', text: trimText(t('mq_b_mode_switch'), 300) }, confirm: { type: 'plain_text', text: trimText(t('mq_switch_ok'), 30) }, deny: { type: 'plain_text', text: trimText(t('mq_switch_deny'), 30) } } } });
  // Title
  blocks.push({ type: 'input', block_id: 'mq_b_title', optional: true, label: { type: 'plain_text', text: trimText(t('mq_field_title'), 2000) },
    element: { type: 'plain_text_input', action_id: 'v', max_length: 150, ...(draft.title ? { initial_value: draft.title } : {}), placeholder: { type: 'plain_text', text: trimText(t('mq_field_title_ph'), 150) } } });

  if (draft.mode === 'advanced') {
    blocks.push({ type: 'input', block_id: 'mq_form', optional: true, label: { type: 'plain_text', text: trimText(t('mq_field_questions'), 2000) },
      element: { type: 'plain_text_input', action_id: 'v', multiline: true, max_length: 3000, ...((draft.questions && draft.questions.length) ? { initial_value: String(formToModalDSL(draft.questions)).slice(0, 3000) } : {}), placeholder: { type: 'plain_text', text: trimText(t('mq_field_questions_ph'), 150) } } });
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${t('mq_field_questions_hint')}  📖 <https://github.com/polppol/openpollslack-i18n/blob/main/README.md#multi-question-polls-forms|${t('mq_howto')} ↗>` }] });
  } else {
    blocks.push(divider());
    const qs = draft.questions || [];
    if (!qs.length) blocks.push(contextMd(t('mq_b_no_questions')));
    qs.forEach((q, i) => {
      const opts = [{ text: { type: 'plain_text', emoji: true, text: trimText('✏️ ' + t('mq_b_q_edit'), 75) }, value: `edit:${i}` }];
      if (i > 0) opts.push({ text: { type: 'plain_text', emoji: true, text: trimText('⬆️ ' + t('mq_b_q_up'), 75) }, value: `up:${i}` });
      if (i < qs.length - 1) opts.push({ text: { type: 'plain_text', emoji: true, text: trimText('⬇️ ' + t('mq_b_q_down'), 75) }, value: `down:${i}` });
      opts.push({ text: { type: 'plain_text', emoji: true, text: trimText('🗑️ ' + t('mq_b_q_remove'), 75) }, value: `del:${i}` });
      const sub = isChoice(q.type) && q.type !== 'yesno' ? ` · ${(q.options || []).length} ${t('mq_b_options')}` : '';
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${i + 1}.* ${TYPE_EMOJI[q.type] || ''} ${trimText(q.text || '', 140)}\n_${typeLabel(lang, q.type)}${sub}_` },
        accessory: { type: 'overflow', action_id: 'mq_b_qmenu', options: opts } });
    });
    if (qs.length < MAX_QUESTIONS) blocks.push({ type: 'actions', elements: [{ type: 'button', action_id: 'mq_b_add_q', style: 'primary', text: { type: 'plain_text', emoji: true, text: trimText('➕ ' + t('mq_b_add_q'), 75) } }] });
    else blocks.push(contextMd(parameterizedString(t('mq_err_max_questions'), { max: MAX_QUESTIONS })));
    blocks.push(divider());
  }

  // Settings (anonymous/hidden)
  blocks.push({ type: 'input', block_id: 'mq_b_settings', optional: true, label: { type: 'plain_text', text: trimText(t('mq_field_settings'), 2000) },
    element: { type: 'checkboxes', action_id: 'v', options: [{ text: { type: 'mrkdwn', text: t('mq_opt_anonymous') }, value: 'anonymous' }, { text: { type: 'mrkdwn', text: t('mq_opt_hidden') }, value: 'hidden' }], ...buildInitialSettings(draft, lang) } });

  // Channel + language — same logic/keys as the create modal.
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: t('modal_ch_manual_select') } });
  if (useResponseUrl && draft.response_url) {
    blocks.push(contextMd(t('modal_ch_response_url_auto')));
  } else {
    blocks.push({ type: 'input', block_id: 'mq_channel', optional: true, label: { type: 'plain_text', text: trimText(t('modal_ch_select'), 2000) },
      element: { type: 'conversations_select', action_id: 'v', filter: { include: ['private', 'public'] }, default_to_current_conversation: true, ...(draft.channel ? { initial_conversation: draft.channel } : {}) } });
    blocks.push(contextMd(useResponseUrl ? parameterizedString(t('modal_ch_warn_with_response_url'), { slack_command: _opts.slackCommand || 'poll', bot_name: _opts.botName || 'Open Poll Plus' }) : t('modal_ch_warn')));
  }
  if (langSelectable && Object.keys(langList).length) {
    blocks.push({ type: 'input', block_id: 'mq_lang', optional: true, label: { type: 'plain_text', text: trimText(t('info_lang_select_label'), 2000) },
      element: { type: 'static_select', action_id: 'v', placeholder: { type: 'plain_text', text: trimText(t('info_lang_select_hint'), 150) },
        ...(langList[lang] ? { initial_option: { text: { type: 'plain_text', text: trimText(langList[lang] || lang, 75) }, value: lang } } : {}),
        options: Object.keys(langList).map((k) => ({ text: { type: 'plain_text', text: trimText(langList[k] || k, 75) }, value: k })) } });
  }

  return { type: 'modal', callback_id: 'mq_build_submit', private_metadata: JSON.stringify({ draft_id: String(draft._id) }),
    title: { type: 'plain_text', text: betaTitle(t('mq_modal_title')) }, submit: { type: 'plain_text', text: trimText(t('btn_create'), 24) }, close: { type: 'plain_text', text: trimText(t('btn_cancel'), 24) }, blocks };
}

/** Per-question sub-modal (views.push). Type-aware; options as a multiline box (v1). */
function buildQuestionView(ctx, q) {
  const lang = ctx.lang || 'en';
  const t = (k) => stri18n(lang, k);
  q = q || { type: 'choice', text: '', options: [], multi: false, required: false, user_add_choice: false };
  const blocks = [];
  const tOpt = (type) => ({ text: { type: 'plain_text', emoji: true, text: trimText(typeLabel(lang, type), 75) }, value: type });
  blocks.push({ type: 'section', block_id: 'mq_q_type_blk', text: { type: 'mrkdwn', text: `*${t('mq_b_q_type_label')}*` },
    accessory: { type: 'static_select', action_id: 'mq_q_type', initial_option: tOpt(q.type), options: ALL_TYPES.map(tOpt) } });
  blocks.push({ type: 'input', block_id: 'mq_q_text', label: { type: 'plain_text', text: trimText(t('mq_b_q_text_label'), 2000) },
    element: { type: 'plain_text_input', action_id: 'v', max_length: 300, ...(q.text ? { initial_value: q.text } : {}), placeholder: { type: 'plain_text', text: trimText(t('mq_b_q_text_ph'), 150) } } });
  // One input ROW per option + an "Add option" button (the GUI alternative to a textarea).
  // optRows (carried in private_metadata) is how many rows to render; "Add option" bumps it.
  // Removing = clear a row (empty rows are dropped on the next render / on save).
  let optRows = 0;
  if (q.type === 'choice') {
    // Seed from the live options, else from a stash kept across a type swap-away (so
    // choice→text→choice doesn't lose typed options — the rows aren't rendered while
    // a non-choice type is selected, so the values must survive in private_metadata).
    const seed = (q.options && q.options.length) ? q.options : (ctx.optsStash || []);
    optRows = Math.min(MAX_OPTIONS, Math.max(2, ctx.optRows || seed.length || 2));
    blocks.push(contextMd(`*${t('mq_b_q_options_label')}*`));
    for (let i = 0; i < optRows; i++) {
      blocks.push({ type: 'input', block_id: `mq_q_opt_${i}`, optional: true, label: { type: 'plain_text', text: `${i + 1}.` },
        element: { type: 'plain_text_input', action_id: 'v', max_length: 150, ...(seed[i] ? { initial_value: seed[i] } : {}), placeholder: { type: 'plain_text', text: trimText(t('mq_b_q_options_ph'), 150) } } });
    }
    if (optRows < MAX_OPTIONS) blocks.push({ type: 'actions', elements: [{ type: 'button', action_id: 'mq_q_add_opt', text: { type: 'plain_text', emoji: true, text: trimText('➕ ' + t('mq_b_add_option'), 75) } }] });
    blocks.push(contextMd(t('mq_b_q_options_hint')));
  } else if (q.type === 'yesno') {
    blocks.push(contextMd(`${t('mq_b_q_yesno_hint')} — *${t('mq_yes')}* / *${t('mq_no')}*`));
  }
  const flagOpts = [];
  if (q.type === 'choice') { flagOpts.push({ text: { type: 'mrkdwn', text: t('mq_b_opt_multi') }, value: 'multi' }); flagOpts.push({ text: { type: 'mrkdwn', text: t('mq_b_opt_addown') }, value: 'addown' }); }
  flagOpts.push({ text: { type: 'mrkdwn', text: t('mq_b_opt_required') }, value: 'required' });
  const flagSel = [];
  if (q.type === 'choice' && q.multi) flagSel.push(flagOpts.find((o) => o.value === 'multi'));
  if (q.type === 'choice' && q.user_add_choice) flagSel.push(flagOpts.find((o) => o.value === 'addown'));
  if (q.required) flagSel.push(flagOpts.find((o) => o.value === 'required'));
  blocks.push({ type: 'input', block_id: 'mq_q_flags', optional: true, label: { type: 'plain_text', text: trimText(t('mq_b_q_flags_label'), 2000) },
    element: { type: 'checkboxes', action_id: 'v', options: flagOpts, ...(flagSel.filter(Boolean).length ? { initial_options: flagSel.filter(Boolean) } : {}) } });

  const pm = { draft_id: ctx.draft_id, root_view_id: ctx.root_view_id, qIndex: ctx.qIndex, lang: ctx.lang, optRows };
  if (ctx.optsStash && ctx.optsStash.length) pm.optsStash = ctx.optsStash; // carry typed options across a type swap-away
  return { type: 'modal', callback_id: 'mq_q_submit', private_metadata: JSON.stringify(pm),
    title: { type: 'plain_text', text: trimText(t('mq_b_q_title'), 24) }, submit: { type: 'plain_text', text: trimText(t('mq_b_q_save'), 24) }, close: { type: 'plain_text', text: trimText(t('btn_cancel'), 24) }, blocks };
}

/** Read a question object out of the sub-modal's current state. */
function readQuestionFromView(view) {
  const v = (view.state && view.state.values) || {};
  const type = (v.mq_q_type && v.mq_q_type.v && v.mq_q_type.v.selected_option && v.mq_q_type.v.selected_option.value) || 'choice';
  const text = ((v.mq_q_text && v.mq_q_text.v && v.mq_q_text.v.value) || '').trim();
  // Collect option ROWS (mq_q_opt_0..N) in order, dropping blanks (clear-to-remove).
  let options = [];
  for (let i = 0; i < MAX_OPTIONS; i++) {
    const cell = v[`mq_q_opt_${i}`];
    const val = (cell && cell.v && cell.v.value || '').trim();
    if (val) options.push(val.slice(0, 150));
  }
  const flags = ((v.mq_q_flags && v.mq_q_flags.v && v.mq_q_flags.v.selected_options) || []).map((o) => o.value);
  const q = { type, text };
  if (type === 'choice') { q.options = options; q.multi = flags.includes('multi'); if (flags.includes('addown')) q.user_add_choice = true; }
  else if (type === 'yesno') { q.multi = false; }
  if (flags.includes('required')) q.required = true;
  return q;
}

async function builderRenderOpts(draft) {
  let defs = {}; try { defs = await teamDefaults(draft.team); } catch (e) { defs = {}; }
  return { useResponseUrl: !!_opts.isUseResponseUrl, langSelectable: !!defs.app_lang_user_selectable };
}

/** Entry: create a draft + open (trigger_id) or update (view_id) the builder. */
async function openBuilder({ client, triggerId, viewId, channel, responseUrl, teamId, userId, initialForm }) {
  const defs = await teamDefaults(teamId);
  const lang = defs.app_lang || 'en';
  let questions = [];
  if (initialForm) { try { questions = parseForm(String(initialForm), lang).questions; } catch (e) { questions = []; } }
  const draft = await createDraft({ team: teamId, user_id: userId || null, channel, response_url: responseUrl, mode: 'visual', lang, settings: { user_lang: lang }, questions });
  const ro = await builderRenderOpts(draft);
  const view = buildBuilderView(draft, ro.useResponseUrl, ro.langSelectable);
  let vid = viewId || null;
  if (viewId) { try { await client.views.update({ view_id: viewId, view }); } catch (e) { try { const r = await client.views.open({ trigger_id: triggerId, view }); vid = r && r.view && r.view.id; } catch (_) { /* noop */ } } }
  else { const r = await client.views.open({ trigger_id: triggerId, view }); vid = r && r.view && r.view.id; }
  if (vid) await patchDraft(draft._id, { root_view_id: vid });
}

// Re-render the root builder modal from the current draft (after an action).
// Surface the Slack API error detail (e.data.error + which field, when present) for the
// builder's otherwise-swallowed views.open/update/push calls — invalid-view rejections are
// invisible in the journal otherwise (the handler acked, so nothing else logs).
function logBuilderErr(where, e) {
  const d = e && e.data;
  const detail = d ? `${d.error}${d.response_metadata && d.response_metadata.messages ? ' :: ' + d.response_metadata.messages.join(' | ') : ''}` : (e && e.message);
  console.error(`[mq builder] ${where} failed: ${detail}`);
}

async function rerenderBuilder(client, token, draft, viewId) {
  const ro = await builderRenderOpts(draft);
  try { await client.views.update({ token, view_id: viewId, view: buildBuilderView(draft, ro.useResponseUrl, ro.langSelectable) }); } catch (e) { logBuilderErr('rerenderBuilder views.update', e); }
}

async function handleBuilderMode({ ack, body, action, client, context }) {
  await ack();
  let pm = {}; try { pm = JSON.parse((body.view && body.view.private_metadata) || '{}'); } catch (e) { /* noop */ }
  const draft = await loadDraft(pm.draft_id); if (!draft) return;
  if (draft.user_id && body.user.id !== draft.user_id) return;
  await syncRootState(body.view, draft); // parses DSL→questions if leaving advanced
  draft.mode = (action.selected_option && action.selected_option.value) || 'visual';
  await patchDraft(draft._id, { mode: draft.mode });
  await rerenderBuilder(client, context.botToken, draft, body.view.id);
}

async function handleAddQuestion({ ack, body, client, context }) {
  await ack();
  let pm = {}; try { pm = JSON.parse((body.view && body.view.private_metadata) || '{}'); } catch (e) { /* noop */ }
  const draft = await loadDraft(pm.draft_id); if (!draft) return;
  if (draft.user_id && body.user.id !== draft.user_id) return;
  await syncRootState(body.view, draft);
  if ((draft.questions || []).length >= MAX_QUESTIONS) return;
  const lang = (draft.settings && draft.settings.user_lang) || 'en';
  const ctx = { draft_id: String(draft._id), root_view_id: body.view.id, qIndex: -1, lang };
  try { await client.views.push({ token: context.botToken, trigger_id: body.trigger_id, view: buildQuestionView(ctx, null) }); } catch (e) { logBuilderErr('handleAddQuestion views.push', e); }
}

async function handleQMenu({ ack, body, action, client, context }) {
  await ack();
  let pm = {}; try { pm = JSON.parse((body.view && body.view.private_metadata) || '{}'); } catch (e) { /* noop */ }
  const draft = await loadDraft(pm.draft_id); if (!draft) return;
  if (draft.user_id && body.user.id !== draft.user_id) return;
  await syncRootState(body.view, draft);
  const parts = String((action.selected_option && action.selected_option.value) || '').split(':');
  const a = parts[0]; const i = parseInt(parts[1], 10);
  const qs = draft.questions || [];
  if (a === 'edit') {
    const lang = (draft.settings && draft.settings.user_lang) || 'en';
    const ctx = { draft_id: String(draft._id), root_view_id: body.view.id, qIndex: i, lang };
    try { await client.views.push({ token: context.botToken, trigger_id: body.trigger_id, view: buildQuestionView(ctx, qs[i]) }); } catch (e) { logBuilderErr('handleQMenu edit views.push', e); }
    return;
  }
  if (a === 'del') qs.splice(i, 1);
  else if (a === 'up' && i > 0) { const x = qs[i - 1]; qs[i - 1] = qs[i]; qs[i] = x; }
  else if (a === 'down' && i < qs.length - 1) { const x = qs[i + 1]; qs[i + 1] = qs[i]; qs[i] = x; }
  await patchDraft(draft._id, { questions: qs }); draft.questions = qs;
  await rerenderBuilder(client, context.botToken, draft, body.view.id);
}

async function handleQType({ ack, body, action, client, context }) {
  await ack();
  let ctx = {}; try { ctx = JSON.parse((body.view && body.view.private_metadata) || '{}'); } catch (e) { /* noop */ }
  const q = readQuestionFromView(body.view); // preserve current entries
  // Stash any typed option rows so swapping type away and back doesn't lose them
  // (option rows aren't rendered for non-choice types). readQuestionFromView already
  // gives q.options when leaving choice; fall back to it. ctx.optsStash carries across.
  const vs = (body.view.state && body.view.state.values) || {};
  const stash = [];
  for (let i = 0; i < MAX_OPTIONS; i++) { const c = vs[`mq_q_opt_${i}`]; const val = ((c && c.v && c.v.value) || '').trim(); if (val) stash.push(val.slice(0, 150)); }
  if (stash.length) ctx.optsStash = stash;
  else if (q.options && q.options.length) ctx.optsStash = q.options.slice();
  q.type = (action.selected_option && action.selected_option.value) || q.type;
  if (q.type === 'choice' && (!q.options || !q.options.length) && ctx.optsStash && ctx.optsStash.length) q.options = ctx.optsStash.slice();
  try { await client.views.update({ token: context.botToken, view_id: body.view.id, view: buildQuestionView(ctx, q) }); } catch (e) { logBuilderErr('handleQType views.update', e); }
}

// "Add option" — render one more option row (capturing what's already typed).
async function handleQAddOpt({ ack, body, client, context }) {
  await ack();
  let ctx = {}; try { ctx = JSON.parse((body.view && body.view.private_metadata) || '{}'); } catch (e) { /* noop */ }
  const q = readQuestionFromView(body.view);
  const cur = Math.max(ctx.optRows || 0, (q.options || []).length, 2);
  ctx.optRows = Math.min(MAX_OPTIONS, cur + 1);
  try { await client.views.update({ token: context.botToken, view_id: body.view.id, view: buildQuestionView(ctx, q) }); } catch (e) { logBuilderErr('handleQAddOpt views.update', e); }
}

async function handleQuestionSubmit({ ack, body, view, client, context }) {
  let ctx = {}; try { ctx = JSON.parse(view.private_metadata || '{}'); } catch (e) { /* noop */ }
  const lang = ctx.lang || 'en';
  const q = readQuestionFromView(view);
  if (q.type === 'yesno') { q.options = [stri18n(lang, 'mq_yes'), stri18n(lang, 'mq_no')]; q.multi = false; } // keep the draft consistent (ids normalized at final submit)
  if (!q.text) { await ack({ response_action: 'errors', errors: { mq_q_text: stri18n(lang, 'mq_b_err_need_text') } }); return; }
  if (q.type === 'choice' && (!q.options || q.options.length < 2)) { await ack({ response_action: 'errors', errors: { mq_q_opt_0: stri18n(lang, 'mq_b_err_2opts') } }); return; } // mq_q_opt_0 is always rendered (optRows>=2)
  await ack(); // pops the sub-modal back to the root
  const draft = await loadDraft(ctx.draft_id); if (!draft) return;
  const qs = draft.questions || [];
  if (ctx.qIndex >= 0 && ctx.qIndex < qs.length) qs[ctx.qIndex] = q;
  else if (qs.length < MAX_QUESTIONS) qs.push(q);
  await patchDraft(draft._id, { questions: qs }); draft.questions = qs;
  if (ctx.root_view_id) await rerenderBuilder(client, context.botToken, draft, ctx.root_view_id);
}

/** Final submit (mq_build_submit) — works in BOTH visual and advanced mode. */
async function handleBuilderSubmit({ ack, body, view, client, context }) {
  let pm = {}; try { pm = JSON.parse(view.private_metadata || '{}'); } catch (e) { /* noop */ }
  const draft = await loadDraft(pm.draft_id);
  const teamId = (body.team && body.team.id) || (body.enterprise && body.enterprise.id) || (view.team_id) || (draft && draft.team);
  const defs = await teamDefaults(teamId);
  const lang = (draft && draft.settings && draft.settings.user_lang) || defs.app_lang || 'en';
  const t = (k, p) => (p ? parameterizedString(stri18n(lang, k), p) : stri18n(lang, k));
  if (!draft) { await ack({ response_action: 'errors', errors: { mq_b_title: t('mq_b_err_expired') } }); return; }
  await syncRootState(view, draft);
  // Advanced mode: surface DSL parse errors (visual questions were validated per-sub-modal).
  if (draft.mode === 'advanced') {
    const dsl = (view.state.values.mq_form && view.state.values.mq_form.v && view.state.values.mq_form.v.value) || '';
    const parsed = parseForm(dsl, lang);
    if (!parsed.questions.length) { await ack({ response_action: 'errors', errors: { mq_form: t('mq_err_need_question') } }); return; }
    if (parsed.errors && parsed.errors.length) { await ack({ response_action: 'errors', errors: { mq_form: parsed.errors.join(' • ').slice(0, 2000) } }); return; }
    draft.questions = parsed.questions;
  }
  const questions = draft.questions || [];
  // Normalize at the single convergence point (poll is brand-new, no votes yet):
  // (1) positional ids — the VISUAL builder leaves them undefined; without an id
  //     buildBlocks emits qid:undefined and every question collides on votes.undefined.*
  //     (parseForm/advanced already yields q1..qN, so this is idempotent).
  // (2) yes/no options in the poll language — the visual builder leaves them empty,
  //     which would post a yes/no question with no vote buttons.
  questions.forEach((q, i) => {
    q.id = 'q' + (i + 1);
    if (q.type === 'yesno') { q.options = [t('mq_yes'), t('mq_no')]; q.multi = false; }
  });
  const errTarget = draft.mode === 'advanced' ? 'mq_form' : 'mq_b_title';
  if (!questions.length) { await ack({ response_action: 'errors', errors: { [errTarget]: t('mq_err_need_question') } }); return; }
  for (const q of questions) { if (q.type === 'choice' && (!q.options || q.options.length < 2)) { await ack({ response_action: 'errors', errors: { [errTarget]: t('mq_err_choice_2opts', { q: (q.text || '').slice(0, 40) }) } }); return; } }
  if (estimateBlocks(questions) > MAX_BLOCKS) { await ack({ response_action: 'errors', errors: { [errTarget]: t('mq_err_too_big', { max: MAX_BLOCKS }) } }); return; }
  const channel = draft.channel; const responseUrl = draft.response_url || '';
  if (!channel && !(_opts.isUseResponseUrl && responseUrl)) { await ack({ response_action: 'errors', errors: { mq_channel: t('mq_err_pick_channel') } }); return; }
  await ack(); // close the modal
  const userId = body.user.id;
  const trueAnon = !!(draft.settings.anonymous && defs.true_anonymous);
  await createAndPost(client, context.botToken, {
    teamOrEnt: teamId, userId, channel, title: draft.title || (questions[0] && questions[0].text) || 'Poll', questions,
    paraIn: { anonymous: !!draft.settings.anonymous, true_anonymous: trueAnon, hidden: !!draft.settings.hidden, menu_at_the_end: defs.menu_at_the_end, show_command_info: defs.show_command_info, show_dashboard_link: defs.show_dashboard_link, display_poller_name: defs.display_poller_name },
    lang, responseUrl,
  });
  await deleteDraft(draft._id);
}

/** Register all mq_* handlers on the Bolt app. Call once from index.js. */
function register(app) {
  app.action('mq_vote', wrap(handleVote, 'mq_vote'));
  app.action('mq_answer', wrap(handleAnswerOpen, 'mq_answer'));
  app.action('mq_menu', wrap(handleMenu, 'mq_menu'));
  app.action('mq_reveal', wrap(handleReveal, 'mq_reveal')); // legacy (already-posted polls)
  app.action('mq_close', wrap(handleClose, 'mq_close'));    // legacy (already-posted polls)
  app.action('mq_addchoice', wrap(handleAddChoiceOpen, 'mq_addchoice'));
  app.view('mq_create_submit', wrap(handleCreateSubmit, 'mq_create_submit')); // legacy DSL modal (kept for stale views)
  app.view('mq_answer_submit', wrap(handleAnswerSubmit, 'mq_answer_submit'));
  app.view('mq_addchoice_submit', wrap(handleAddChoiceSubmit, 'mq_addchoice_submit'));
  // Visual builder
  app.action('mq_b_mode', wrap(handleBuilderMode, 'mq_b_mode'));
  app.action('mq_b_add_q', wrap(handleAddQuestion, 'mq_b_add_q'));
  app.action('mq_b_qmenu', wrap(handleQMenu, 'mq_b_qmenu'));
  app.action('mq_q_type', wrap(handleQType, 'mq_q_type'));
  app.action('mq_q_add_opt', wrap(handleQAddOpt, 'mq_q_add_opt'));
  app.view('mq_q_submit', wrap(handleQuestionSubmit, 'mq_q_submit'));
  app.view('mq_build_submit', wrap(handleBuilderSubmit, 'mq_build_submit'));
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
  init, register, isMulti, openCreateModal, openBuilder, createFromCommand, formToCommandDSL,
  buildBuilderView, buildQuestionView, readQuestionFromView, // exported for structural tests
  // exported for unit tests:
  parseForm, applyVote, applyAnswer, formatAnswer, buildBlocks, parseCreateSubmit,
  buildCreateModalView, buildAnswerModalView, answerElement, readAnswerValue, estimateBlocks,
  MAX_QUESTIONS, MAX_OPTIONS, MAX_BLOCKS, ALL_TYPES,
};
