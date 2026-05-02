// Round-trip + targeted tests for src/util/richtext.js. There is no test
// framework in this project — run directly: `node scripts/test-richtext.js`.
// Exits non-zero on failure so it's wired into CI later if we add one.

const { richTextToMrkdwn, mrkdwnToRichText } = require('../src/util/richtext');

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

// ─── Summary ─────────────────────────────────────────────────────
console.log('\n' + (fail === 0 ? `All ${pass} tests passed.` : `${pass} passed, ${fail} FAILED`));
process.exit(fail === 0 ? 0 : 1);
