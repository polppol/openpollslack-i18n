const fs = require('node:fs');
const { globSync } = require('glob');

// Module-scoped state. Both objects are exported by reference, so the index.js
// import binding sees mutations made by loadLanguages() below.
const langDict = {};
const langList = {};

function parameterizedString(str, varArray) {
  if (str === undefined) str = `MissingStr ${str}`;
  let outputStr = str;
  for (let key in varArray) {
    if (varArray.hasOwnProperty(key)) {
      outputStr = outputStr.replaceAll('{{' + key + '}}', varArray[key]);
    }
  }
  return outputStr;
}

function stri18n(lang, key) {
  if (langDict.hasOwnProperty(lang)) {
    if (langDict[lang].hasOwnProperty(key)) {
      return langDict[lang][key];
    }
  }
  // fallback to en if not exist
  if (langDict['en'] && langDict['en'].hasOwnProperty(key)) {
    return langDict['en'][key];
  } else {
    return `MissingStr ${key}`;
  }
}

function slackNumToEmoji(seq, userLang) {
  let outText = '[' + seq + ']';
  if (langDict.hasOwnProperty(userLang)) {
    if (langDict[userLang].hasOwnProperty('emoji_' + seq)) {
      outText = langDict[userLang]['emoji_' + seq];
    }
  }
  return outText;
}

/**
 * Load every `language/*.json` file into langDict + langList.
 * Throws if `en.json` or `<defaultLang>.json` are missing — those are
 * required for the bot to start safely (silent fallback to a missing
 * baseline would surface as `MissingStr ...` strings everywhere).
 *
 * @param {object} logger      winston-style logger (info / error)
 * @param {string} defaultLang the configured `app_lang`, used for the
 *                             "language file present?" guard
 * @param {string} [langGlob]  override the glob pattern (used in tests)
 * @returns {number} number of language files loaded
 */
function loadLanguages(logger, defaultLang, langGlob = './language/*.json') {
  let langCount = 0;

  globSync(langGlob).forEach(function (file) {
    const dash = file.split(/[\\/]+/);
    const dot = dash[dash.length - 1].split('.');
    if (dot.length === 2) {
      const lang = dot[0];
      logger.info('Lang file [' + lang + ']: ' + file);
      const fileData = fs.readFileSync(file);
      langDict[lang] = JSON.parse(fileData.toString());
      if (langDict[lang].hasOwnProperty('info_lang_name')) {
        langList[lang] = langDict[lang]['info_lang_name'];
      } else {
        langList[lang] = lang;
      }
      langCount++;
    }
  });

  logger.info('Lang Count: ' + langCount);
  logger.info('Selected Lang: ' + defaultLang);

  if (!langDict.hasOwnProperty('en')) {
    logger.error('language/en.json NOT FOUND!');
    throw new Error('language/en.json NOT FOUND!');
  }
  if (!langDict.hasOwnProperty(defaultLang)) {
    logger.error(`language/${defaultLang}.json NOT FOUND!`);
    throw new Error(`language/${defaultLang}.json NOT FOUND!`);
  }

  return langCount;
}

module.exports = {
  langDict,
  langList,
  parameterizedString,
  stri18n,
  slackNumToEmoji,
  loadLanguages,
};
