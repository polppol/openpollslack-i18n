// Round-trip + targeted tests for src/util/richtext.js. There is no test
// framework in this project — run directly: `node scripts/test-richtext.js`.
// Exits non-zero on failure so it's wired into CI later if we add one.

const { richTextToMrkdwn, mrkdwnToRichText, readInputAsMrkdwn } = require('../src/util/richtext');

let pass = 0;
let fail = 0;

function test(name, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name);
    console.log('      expected:', JSON.stringify(expected));
    console.log('      actual:  ', JSON.stringify(actual));
  }
}

// ─── Forward: rich_text → mrkdwn ─────────────────────────────────
console.log('richTextToMrkdwn:');

test('empty rich_text', '', richTextToMrkdwn({ type: 'rich_text', elements: [] }));

test('null input', '', richTextToMrkdwn(null));
test('wrong type', '', richTextToMrkdwn({ type: 'section' }));

test(
  'plain text',
  'hello',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'hello' }] }],
  })
);

test(
  'bold',
  '*hello*',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'hello', style: { bold: true } }] }],
  })
);

test(
  'italic',
  '_hello_',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'hello', style: { italic: true } }] }],
  })
);

test(
  'strike',
  '~hello~',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'hello', style: { strike: true } }] }],
  })
);

test(
  'code',
  '`hello`',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'hello', style: { code: true } }] }],
  })
);

test(
  'bold + italic (nested as *_text_*)',
  '*_hello_*',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'hello', style: { bold: true, italic: true } }] }],
  })
);

test(
  'code wins over other styles (mutual exclusion)',
  '`hello`',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'hello', style: { code: true, bold: true } }] }],
  })
);

test(
  'emoji',
  ':smile:',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'emoji', name: 'smile' }] }],
  })
);

test(
  'user mention',
  '<@U12345>',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'user', user_id: 'U12345' }] }],
  })
);

test(
  'channel mention',
  '<#C12345>',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'channel', channel_id: 'C12345' }] }],
  })
);

test(
  'broadcast here',
  '<!here>',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'broadcast', range: 'here' }] }],
  })
);

test(
  'link with text',
  '<https://example.com|click>',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url: 'https://example.com', text: 'click' }] }],
  })
);

test(
  'link without text',
  '<https://example.com>',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url: 'https://example.com' }] }],
  })
);

test(
  'escapes < > & in plain text',
  '&lt;test&gt; &amp;more',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: '<test> &more' }] }],
  })
);

// C44 — mrkdwn style markers don't span newlines: a styled element whose text
// contains \n must be wrapped per line (empty lines get no markers).
test(
  'bold spanning newline wraps each line (C44)',
  '*line1*\n*line2*',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'line1\nline2', style: { bold: true } }] }],
  })
);

test(
  'italic spanning newline wraps each line (C44)',
  '_line1_\n_line2_',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'line1\nline2', style: { italic: true } }] }],
  })
);

test(
  'strike spanning newline wraps each line (C44)',
  '~line1~\n~line2~',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'line1\nline2', style: { strike: true } }] }],
  })
);

test(
  'code spanning newline wraps each line (C44)',
  '`line1`\n`line2`',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'line1\nline2', style: { code: true } }] }],
  })
);

test(
  'bold with empty middle line gets no markers on the empty line (C44)',
  '*a*\n\n*b*',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'a\n\nb', style: { bold: true } }] }],
  })
);

// C45 — link display text is entity-escaped; URL must not contain raw | or >.
test(
  'link text with > and & is entity-escaped (C45)',
  '<https://example.com|a &gt; b &amp; c>',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url: 'https://example.com', text: 'a > b & c' }] }],
  })
);

test(
  'link text with < is entity-escaped (C45)',
  '<https://example.com|&lt;tag&gt;>',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url: 'https://example.com', text: '<tag>' }] }],
  })
);

test(
  'link text with | is safe (label starts after the FIRST pipe) (C45)',
  '<https://example.com|a|b>',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url: 'https://example.com', text: 'a|b' }] }],
  })
);

test(
  'link URL with | is percent-encoded (C45)',
  '<https://example.com/a%7Cb|click>',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url: 'https://example.com/a|b', text: 'click' }] }],
  })
);

test(
  'link URL with > is percent-encoded (C45)',
  '<https://example.com/a%3Eb>',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url: 'https://example.com/a>b' }] }],
  })
);

test(
  'bullet list',
  '• first\n• second',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_list',
        style: 'bullet',
        elements: [
          { type: 'rich_text_section', elements: [{ type: 'text', text: 'first' }] },
          { type: 'rich_text_section', elements: [{ type: 'text', text: 'second' }] },
        ],
      },
    ],
  })
);

test(
  'ordered list',
  '1. first\n2. second',
  richTextToMrkdwn({
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_list',
        style: 'ordered',
        elements: [
          { type: 'rich_text_section', elements: [{ type: 'text', text: 'first' }] },
          { type: 'rich_text_section', elements: [{ type: 'text', text: 'second' }] },
        ],
      },
    ],
  })
);

// ─── Reverse: mrkdwn → rich_text ────────────────────────────────
console.log('\nmrkdwnToRichText:');

test('empty string', { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [] }] }, mrkdwnToRichText(''));
test('null input', { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [] }] }, mrkdwnToRichText(null));

test(
  'plain hello',
  { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'hello' }] }] },
  mrkdwnToRichText('hello')
);

test(
  'bold hello',
  {
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'hello', style: { bold: true } }] }],
  },
  mrkdwnToRichText('*hello*')
);

test(
  ':smile: emoji',
  {
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'emoji', name: 'smile' }] }],
  },
  mrkdwnToRichText(':smile:')
);

test(
  'user mention',
  {
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'user', user_id: 'U12345' }] }],
  },
  mrkdwnToRichText('<@U12345>')
);

test(
  'literal <test> stays plain (no scheme = not a link)',
  {
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: '<test>' }] }],
  },
  mrkdwnToRichText('<test>')
);

test(
  'link with scheme',
  {
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url: 'https://example.com' }] }],
  },
  mrkdwnToRichText('<https://example.com>')
);

test(
  '&lt; entity unescapes',
  {
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: '<' }] }],
  },
  mrkdwnToRichText('&lt;')
);

test(
  'link text entity-unescapes (mirror of C45 forward escaping)',
  {
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url: 'https://example.com', text: 'a > b' }] }],
  },
  mrkdwnToRichText('<https://example.com|a &gt; b>')
);

// C16 — word-boundary rules: mid-word _ * ~ ` and : must NOT produce phantom
// styles/emoji in the edit-modal pre-fill. Ambiguous → plain.
const plainOnly = (text) => ({
  type: 'rich_text',
  elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }],
});

test('snake_case_name stays plain (C16)', plainOnly('snake_case_name'), mrkdwnToRichText('snake_case_name'));
test('file_name_v2 stays plain (C16)', plainOnly('file_name_v2'), mrkdwnToRichText('file_name_v2'));
test('5*3*2 stays plain (C16)', plainOnly('5*3*2'), mrkdwnToRichText('5*3*2'));
test('12:30:45 stays plain (C16)', plainOnly('12:30:45'), mrkdwnToRichText('12:30:45'));
test('mid-word backtick a`b`c stays plain (C16)', plainOnly('a`b`c'), mrkdwnToRichText('a`b`c'));
// Thai combining vowel mark (ี) before the delimiter is still mid-word.
test('delimiter glued to Thai text stays plain (C16)', plainOnly('สวัสดี*ครับ*'), mrkdwnToRichText('สวัสดี*ครับ*'));
test('mid-word strike a~b~c stays plain (C16)', plainOnly('a~b~c'), mrkdwnToRichText('a~b~c'));
test('opening delimiter followed by whitespace stays plain (C16)', plainOnly('* not bold *x'), mrkdwnToRichText('* not bold *x'));

test(
  '*real bold* still converts (C16)',
  {
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'real bold', style: { bold: true } }] }],
  },
  mrkdwnToRichText('*real bold*')
);

test(
  '_real italic_ still converts (C16)',
  {
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'real italic', style: { italic: true } }] }],
  },
  mrkdwnToRichText('_real italic_')
);

test(
  '~real strike~ still converts (C16)',
  {
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'real strike', style: { strike: true } }] }],
  },
  mrkdwnToRichText('~real strike~')
);

test(
  ':smile: still converts at word boundary (C16)',
  {
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'emoji', name: 'smile' }] }],
  },
  mrkdwnToRichText(':smile:')
);

test(
  'styled word mid-sentence still converts (C16)',
  {
    type: 'rich_text',
    elements: [{
      type: 'rich_text_section',
      elements: [
        { type: 'text', text: 'the ' },
        { type: 'text', text: 'price', style: { bold: true } },
        { type: 'text', text: ' is right' },
      ],
    }],
  },
  mrkdwnToRichText('the *price* is right')
);

// ─── Stable round-trip (canonical mrkdwn in → rich_text → same mrkdwn out) ──
console.log('\nStable round-trip (canonical mrkdwn → rich_text → same mrkdwn):');
const stableCases = [
  'hello world',
  '*bold*',
  '_italic_',
  '~strike~',
  '`code`',
  ':smile:',
  '<@U12345>',
  '<#C12345>',
  '<!subteam^S12345>',
  '<!here>',
  '<!channel>',
  '<!everyone>',
  '<https://example.com>',
  '<https://example.com|click here>',
  'hello <@U123> :wave: welcome!',
  '*hello* and _italic_',
  'multi\nline\ntext',
  '&lt;literal brackets&gt;',
  // C16 — boundary-rule plains must round-trip byte-for-byte
  'snake_case_name',
  'file_name_v2',
  '5*3*2',
  '12:30:45',
  'vote_for_app_name',
  // C44 — per-line styled output must round-trip
  '*line1*\n*line2*',
  '`line1`\n`line2`',
  // C45 — escaped link label must round-trip
  '<https://example.com|a &gt; b &amp; c>',
];
for (const c of stableCases) {
  const rt = mrkdwnToRichText(c);
  const back = richTextToMrkdwn(rt);
  test(`stable: "${c}"`, c, back);
}

// ─── Idempotent normalization (one round-trip rewrites, second is stable) ──
console.log('\nIdempotent normalization (forward(reverse(x)) is stable on second pass):');
const normalizeCases = [
  ['<test>', '&lt;test&gt;'],     // literal angle bracket → entity-escaped
  ['a & b', 'a &amp; b'],         // ampersand → entity
  ['a > b', 'a &gt; b'],          // bare > → entity
  ['*hello* and *world*', '*hello* and *world*'], // multiple bold spans stable
];
for (const [input, expectedAfterNormalize] of normalizeCases) {
  const once = richTextToMrkdwn(mrkdwnToRichText(input));
  test(`normalize "${input}" → "${expectedAfterNormalize}"`, expectedAfterNormalize, once);
  const twice = richTextToMrkdwn(mrkdwnToRichText(once));
  test(`stable after normalize: "${input}"`, once, twice);
}

// ─── Kill-switch behavior — readInputAsMrkdwn ────────────────────
// When enable_rich_text_input is false, the modal renders plain_text_input.
// Submitted state has option.value (string) and NO option.rich_text_value.
// The reader must return the raw string — byte-for-byte the legacy shape.
//
// When the flag is true, the modal renders rich_text_input. Submitted state has
// option.rich_text_value (a rich_text block) and NO option.value. The reader
// must run it through richTextToMrkdwn to produce the same string-typed value
// the rest of the pipeline expects.
console.log('\nKill-switch (readInputAsMrkdwn auto-discriminator):');

test(
  'flag=false path: option.value passes through untouched',
  'Hello *world*',
  readInputAsMrkdwn({ value: 'Hello *world*' })
);

test(
  'flag=false path: empty string returns empty',
  '',
  readInputAsMrkdwn({ value: '' })
);

test(
  'flag=false path: undefined option safely returns undefined (no throw)',
  undefined,
  readInputAsMrkdwn(undefined)
);

test(
  'flag=true path: rich_text_value goes through converter',
  'Hello *world*',
  readInputAsMrkdwn({
    rich_text_value: {
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world', style: { bold: true } },
        ],
      }],
    },
  })
);

test(
  'flag=true path: empty rich_text returns empty string',
  '',
  readInputAsMrkdwn({
    rich_text_value: { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [] }] },
  })
);

test(
  'BOTH present (rare race): rich_text_value wins (modal flipped to rich during open)',
  'rich-wins',
  readInputAsMrkdwn({
    value: 'plain-loses',
    rich_text_value: {
      type: 'rich_text',
      elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'rich-wins' }] }],
    },
  })
);

// ─── Summary ─────────────────────────────────────────────────────
console.log('\n' + (fail === 0 ? `All ${pass} tests passed.` : `${pass} passed, ${fail} FAILED`));
process.exit(fail === 0 ? 0 : 1);
