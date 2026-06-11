// Converters between Slack's rich_text block (returned by rich_text_input
// elements) and the project's mrkdwn-string storage. Two directions:
//
//   richTextToMrkdwn(rt)  — used at modal-submit time. Walks a rich_text block
//                           and emits a mrkdwn string equivalent (the same shape
//                           we already store in pollCol.question / options[]).
//
//   mrkdwnToRichText(s)   — used at edit-modal pre-fill. Best-effort tokenizer
//                           that reconstructs a rich_text block from a stored
//                           mrkdwn string so the rich_text_input editor opens
//                           with the right formatting recovered.
//
// Storage shape stays a string in both directions, so:
//   - DB schema is unchanged.
//   - Old polls (created via CLI or via the plain_text_input modal) read and
//     render identically.
//   - The flag `enable_rich_text_input` decides ONLY which input element the
//     modal renders; the storage and read paths are flag-agnostic.
//
// Pure helpers — no side effects, no external deps.

// ─────────────────────────────────────────────────────────────────
// Forward: rich_text → mrkdwn
// ─────────────────────────────────────────────────────────────────

function escapeForMrkdwn(text) {
  // Slack's mrkdwn renderer treats < > & specially (link syntax + HTML entity).
  // Other delimiters (* _ ~ `) are positional; not escaped here so user-typed
  // `*foo*` keeps rendering bold (matches the existing CLI flow's behavior).
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function styleWrap(text, style) {
  if (!style) return text;
  // Slack mrkdwn markers don't span newlines — a styled element whose text
  // contains \n must be wrapped per line, or the delimiters render literally.
  if (text.includes('\n')) {
    return text.split('\n').map((line) => styleWrap(line, style)).join('\n');
  }
  // Empty lines get no markers (a bare `**` / '``' would render literally).
  if (text.length === 0) return text;
  // Code is mutually exclusive — Slack's parser doesn't apply other styles
  // inside a code span, so we wrap and stop.
  if (style.code) return '`' + text + '`';
  let out = text;
  if (style.italic) out = '_' + out + '_';
  if (style.strike) out = '~' + out + '~';
  if (style.bold) out = '*' + out + '*';
  return out;
}

function escapeLinkUrl(url) {
  // Inside a <url|text> token, `>` terminates the token and `|` splits url
  // from label — percent-encode them (plus `<` for symmetry). Percent-encoding
  // is lossless for URLs, so the link stays clickable and round-trips as-is.
  return url
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/\|/g, '%7C');
}

function leafToMrkdwn(el) {
  if (!el || typeof el.type !== 'string') return '';
  switch (el.type) {
    case 'text':
      return styleWrap(escapeForMrkdwn(el.text || ''), el.style);
    case 'emoji':
      return ':' + (el.name || '') + ':';
    case 'link':
      // Label is entity-escaped (a raw `>` would terminate the token early);
      // parseAngleBracket mirrors with unescapeFromMrkdwn so edits round-trip.
      if (el.text && el.text.length > 0) {
        return '<' + escapeLinkUrl(el.url || '') + '|' + escapeForMrkdwn(el.text) + '>';
      }
      return '<' + escapeLinkUrl(el.url || '') + '>';
    case 'user':
      return '<@' + (el.user_id || '') + '>';
    case 'channel':
      return '<#' + (el.channel_id || '') + '>';
    case 'usergroup':
      return '<!subteam^' + (el.usergroup_id || '') + '>';
    case 'team':
      return '<!team^' + (el.team_id || '') + '>';
    case 'broadcast':
      return '<!' + (el.range || 'here') + '>';
    case 'color':
      // No mrkdwn equivalent — emit the hex value as plain text.
      return el.value || '';
    case 'date':
      return '<!date^' + (el.timestamp || '') + '^' + (el.format || '') + '|' + (el.fallback || '') + '>';
    default:
      return '';
  }
}

function sectionToMrkdwn(section) {
  if (!Array.isArray(section?.elements)) return '';
  return section.elements.map(leafToMrkdwn).join('');
}

function listToMrkdwn(list) {
  if (!Array.isArray(list?.elements)) return '';
  const ordered = list.style === 'ordered';
  return list.elements
    .map((section, i) => (ordered ? `${i + 1}. ` : '• ') + sectionToMrkdwn(section))
    .join('\n');
}

function quoteToMrkdwn(quote) {
  if (!Array.isArray(quote?.elements)) return '';
  const inner = quote.elements.map(leafToMrkdwn).join('');
  return inner.split('\n').map((l) => '> ' + l).join('\n');
}

function preformattedToMrkdwn(pre) {
  if (!Array.isArray(pre?.elements)) return '';
  return '```\n' + pre.elements.map(leafToMrkdwn).join('') + '\n```';
}

function richTextToMrkdwn(rt) {
  if (!rt || rt.type !== 'rich_text' || !Array.isArray(rt.elements)) return '';
  return rt.elements
    .map((el) => {
      switch (el?.type) {
        case 'rich_text_section': return sectionToMrkdwn(el);
        case 'rich_text_list': return listToMrkdwn(el);
        case 'rich_text_quote': return quoteToMrkdwn(el);
        case 'rich_text_preformatted': return preformattedToMrkdwn(el);
        default: return '';
      }
    })
    .join('\n');
}

// ─────────────────────────────────────────────────────────────────
// Reverse: mrkdwn → rich_text
// Best-effort tokenizer. Recognizes: links, mentions, broadcasts,
// emoji shortcodes, and inline bold/italic/strike/code spans. Unknown
// patterns fall back to plain text — round-trip stays safe.
// ─────────────────────────────────────────────────────────────────

const ANGLE_RE = /^<([^>]+)>/;
const EMOJI_RE = /^:([a-z0-9_+-]+):/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
// Letters, digits, and combining marks (Thai vowels/tone marks, decomposed
// accents) all count as word chars — a delimiter glued to any of them is
// mid-word and stays plain.
const WORD_CHAR_RE = /[\p{L}\p{N}\p{M}]/u;

function unescapeFromMrkdwn(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseAngleBracket(content) {
  // <@U12345>             — user mention
  // <#C12345>             — channel mention
  // <#C12345|name>        — channel mention with display name (name discarded; Slack re-renders)
  // <!subteam^S123>       — usergroup
  // <!subteam^S123|name>  — usergroup with display name
  // <!here|...>           — broadcast (here / channel / everyone)
  // <URL>                 — link
  // <URL|text>            — link with text
  // <other>               — NOT a recognized pattern → return null so caller treats as plain text
  if (content.startsWith('@')) {
    return { type: 'user', user_id: content.substring(1) };
  }
  if (content.startsWith('#')) {
    const pipe = content.indexOf('|');
    return {
      type: 'channel',
      channel_id: pipe > 0 ? content.substring(1, pipe) : content.substring(1),
    };
  }
  if (content.startsWith('!subteam^')) {
    const idPart = content.substring(9);
    const pipe = idPart.indexOf('|');
    return {
      type: 'usergroup',
      usergroup_id: pipe > 0 ? idPart.substring(0, pipe) : idPart,
    };
  }
  // <!here>, <!channel>, <!everyone>, with optional |fallback
  if (content.startsWith('!')) {
    const range = content.substring(1).split('|')[0];
    if (range === 'here' || range === 'channel' || range === 'everyone') {
      return { type: 'broadcast', range };
    }
    return null; // unsupported (e.g., !date — fall back to plain text)
  }
  // Plain link: must look URL-ish (scheme:...) so we don't mis-parse `<test>`.
  const pipe = content.indexOf('|');
  const url = pipe > 0 ? content.substring(0, pipe) : content;
  if (URL_SCHEME_RE.test(url)) {
    // Label was entity-escaped by leafToMrkdwn — unescape so the editor shows
    // the literal text and the next forward pass re-escapes identically.
    if (pipe > 0) return { type: 'link', url, text: unescapeFromMrkdwn(content.substring(pipe + 1)) };
    return { type: 'link', url };
  }
  return null;
}

// Word-boundary rules, mirroring Slack's renderer CONSERVATIVELY: when
// ambiguous, leave text plain — a missed style just shows markers literally
// (harmless), a phantom style mis-renders the edit-modal pre-fill (e.g.
// snake_case_name showing "case" italicized, or 12:30:45 sprouting an emoji).
const isWordChar = (ch) => WORD_CHAR_RE.test(ch);
const isWhitespaceChar = (ch) => /\s/.test(ch);

// An opening delimiter only counts at start-of-line or after a non-word char
// (whitespace/punctuation), and must be immediately followed by non-whitespace.
function isOpeningDelim(text, i) {
  if (i > 0 && isWordChar(text[i - 1])) return false;
  return i + 1 < text.length && !isWhitespaceChar(text[i + 1]);
}

// The matching closing delimiter must be immediately preceded by
// non-whitespace and followed by end-of-line or a non-word char. Scans past
// invalid candidates (e.g. the mid-word `_` in `_foo_bar_`); returns -1 when
// no valid closer exists so the caller falls through to plain text.
function findClosingDelim(text, delim, i) {
  for (let j = i + 2; j < text.length; j++) {
    if (text[j] !== delim) continue;
    if (isWhitespaceChar(text[j - 1])) continue;
    if (j + 1 < text.length && isWordChar(text[j + 1])) continue;
    return j;
  }
  return -1;
}

function tokenizeInline(text, baseStyle) {
  const tokens = [];
  let i = 0;
  let plain = '';

  const flushPlain = () => {
    if (plain.length === 0) return;
    const t = { type: 'text', text: unescapeFromMrkdwn(plain) };
    if (baseStyle) t.style = { ...baseStyle };
    tokens.push(t);
    plain = '';
  };

  while (i < text.length) {
    const ch = text[i];

    // 1. Angle bracket — <@U…>, <#C…>, <!…>, <URL>, <URL|text>
    if (ch === '<') {
      const m = ANGLE_RE.exec(text.substring(i));
      if (m) {
        const tok = parseAngleBracket(m[1]);
        if (tok) {
          flushPlain();
          tokens.push(tok);
          i += m[0].length;
          continue;
        }
        // tok null → fall through to plain-char path so the literal `<` stays.
      }
    }

    // 2. Emoji shortcode :name: — only at a word boundary, so timestamps like
    //    12:30:45 don't sprout phantom emoji.
    if (ch === ':' && (i === 0 || !isWordChar(text[i - 1]))) {
      const m = EMOJI_RE.exec(text.substring(i));
      if (m) {
        flushPlain();
        tokens.push({ type: 'emoji', name: m[1] });
        i += m[0].length;
        continue;
      }
    }

    // 3. Code span (highest precedence among inline styles) — `code`
    if (ch === '`' && isOpeningDelim(text, i)) {
      const end = findClosingDelim(text, '`', i);
      if (end > i) {
        flushPlain();
        const inner = text.substring(i + 1, end);
        tokens.push({
          type: 'text',
          text: unescapeFromMrkdwn(inner),
          style: { ...(baseStyle || {}), code: true },
        });
        i = end + 1;
        continue;
      }
    }

    // 4. Bold / italic / strike — paired delimiters with recursive inner tokenization
    let matched = false;
    const pairs = [['*', 'bold'], ['_', 'italic'], ['~', 'strike']];
    for (const [delim, key] of pairs) {
      if (ch === delim && isOpeningDelim(text, i)) {
        const end = findClosingDelim(text, delim, i);
        if (end > i) {
          flushPlain();
          const inner = text.substring(i + 1, end);
          const innerStyle = { ...(baseStyle || {}), [key]: true };
          // Recurse so nested formatting (e.g., *_bolditalic_*) works.
          tokens.push(...tokenizeInline(inner, innerStyle));
          i = end + 1;
          matched = true;
          break;
        }
      }
    }
    if (matched) continue;

    // 5. Plain char — accumulate.
    plain += ch;
    i++;
  }

  flushPlain();
  return tokens;
}

function mrkdwnToRichText(s) {
  // Empty / non-string input → an empty rich_text block. Slack accepts this as
  // a valid initial_value (renders as an empty editor).
  if (typeof s !== 'string' || s.length === 0) {
    return { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [] }] };
  }
  const lines = s.split('\n');
  // Slack renders newlines inside a rich_text_section as explicit `\n` text
  // elements between adjacent inline elements, NOT as separate sections.
  const flat = [];
  for (let li = 0; li < lines.length; li++) {
    flat.push(...tokenizeInline(lines[li]));
    if (li < lines.length - 1) flat.push({ type: 'text', text: '\n' });
  }
  return { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: flat }] };
}

// Auto-discriminate a Slack input element's submitted value as a mrkdwn string.
// rich_text_input populates option.rich_text_value (a rich_text block);
// plain_text_input populates option.value (a string). The same reader works for
// both modal submits regardless of which element was rendered — used at both
// modal_poll_submit and edit_poll_submit so the kill-switch flag (when off) just
// falls through to option.value, byte-for-byte legacy behavior.
function readInputAsMrkdwn(option) {
  if (option && option.rich_text_value) return richTextToMrkdwn(option.rich_text_value);
  return option?.value;
}

module.exports = {
  richTextToMrkdwn,
  mrkdwnToRichText,
  escapeForMrkdwn,
  readInputAsMrkdwn,
};
