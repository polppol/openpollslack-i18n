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
  // Code is mutually exclusive — Slack's parser doesn't apply other styles
  // inside a code span, so we wrap and stop.
  if (style.code) return '`' + text + '`';
  let out = text;
  if (style.italic) out = '_' + out + '_';
  if (style.strike) out = '~' + out + '~';
  if (style.bold) out = '*' + out + '*';
  return out;
}

function leafToMrkdwn(el) {
  if (!el || typeof el.type !== 'string') return '';
  switch (el.type) {
    case 'text':
      return styleWrap(escapeForMrkdwn(el.text || ''), el.style);
    case 'emoji':
      return ':' + (el.name || '') + ':';
    case 'link':
      if (el.text && el.text.length > 0) return '<' + (el.url || '') + '|' + el.text + '>';
      return '<' + (el.url || '') + '>';
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
const EMOJI_RE = /^:([a-z0-9_+-]+):/i;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

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
    if (pipe > 0) return { type: 'link', url, text: content.substring(pipe + 1) };
    return { type: 'link', url };
  }
  return null;
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

    // 2. Emoji shortcode :name:
    if (ch === ':') {
      const m = EMOJI_RE.exec(text.substring(i));
      if (m) {
        flushPlain();
        tokens.push({ type: 'emoji', name: m[1] });
        i += m[0].length;
        continue;
      }
    }

    // 3. Code span (highest precedence among inline styles) — `code`
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
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
      if (ch === delim) {
        const end = text.indexOf(delim, i + 1);
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
