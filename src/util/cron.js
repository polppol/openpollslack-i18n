const { CronExpressionParser } = require('cron-parser');
const cronstrue = require('cronstrue');

const CRONSTRUE_OPTIONS = { use24HourTimeFormat: true };

// Single source of truth for cron string parsing.
// Returns Date of next run, or null if the expression is invalid.
//
// Defensive shim: cron-parser v5 is stricter about whitespace than v4 was,
// so a stored expression like "  0  8 * * 1-5  " (extra spaces from copy/paste,
// or padding accidentally introduced by a prior tool) used to work and now
// fails. We retry once with normalised whitespace before declaring invalid.
function parseNextRun(cronString, timeZone) {
  if (cronString === null || cronString === undefined || cronString === '') return null;
  const tz = timeZone || 'UTC';
  const options = { tz };
  try {
    return CronExpressionParser.parse(cronString, options).next().toDate();
  } catch (e) {
    const normalised = String(cronString).trim().replace(/\s+/g, ' ');
    if (normalised !== cronString) {
      try {
        return CronExpressionParser.parse(normalised, options).next().toDate();
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

// Returns the human-readable cron description, or "" if the expression
// cannot be humanised. Centralises the cronstrue option so callers can't
// drift from the agreed 24h format.
function humanizeCron(cronString) {
  if (!cronString) return '';
  try {
    return cronstrue.toString(cronString, CRONSTRUE_OPTIONS);
  } catch (e) {
    return '';
  }
}

// Startup self-check: scan every enabled schedule that carries a cron_string
// and log any expression that no longer parses under the current cron-parser
// version. Catches breakage from dependency upgrades (issue #37) before the
// minute-tick scheduler trips over them in production.
async function auditSchedules({ scheduleCol, logger }) {
  if (!scheduleCol) return { scanned: 0, invalid: 0 };
  let scanned = 0;
  let invalid = 0;
  try {
    const cursor = scheduleCol.find({
      is_enable: true,
      cron_string: { $nin: [null, ''] },
    });
    for await (const task of cursor) {
      scanned += 1;
      if (parseNextRun(task.cron_string, null) === null) {
        invalid += 1;
        logger?.warn?.(
          `[Schedule][Audit] poll_id=${task.poll_id} has invalid cron_string '${task.cron_string}' under current cron-parser version`
        );
      }
    }
    if (invalid > 0) {
      logger?.warn?.(`[Schedule][Audit] ${invalid} of ${scanned} active cron schedule(s) failed validation`);
    } else {
      logger?.info?.(`[Schedule][Audit] ${scanned} active cron schedule(s) validated.`);
    }
  } catch (e) {
    logger?.error?.(`[Schedule][Audit] failed: ${e.toString()}`);
  }
  return { scanned, invalid };
}

module.exports = { parseNextRun, humanizeCron, auditSchedules };
