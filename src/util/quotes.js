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

function getSupportDoubleQuoteToStr() {
  return acceptedQuotes.map(item => `\`${item}\``).join(' ');
}

module.exports = { acceptedQuotes, standardQuote, getSupportDoubleQuoteToStr };
