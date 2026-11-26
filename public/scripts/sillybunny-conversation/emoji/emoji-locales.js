/**
 * Which emoji tables exist, and which one an interface language reads. The browser code and the script that writes the
 * tables (`scripts/emoji/build-emoji-data.js`) both import this, so the files that are written are the files that can be asked for.
 */

/** The emojibase locales that an interface language of `public/locales/lang.json` maps to, plus English. */
export const EMOJI_LOCALES = Object.freeze(['en', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pt', 'ru', 'th', 'uk', 'vi', 'zh', 'zh-hant']);

const TRADITIONAL_PARTS = Object.freeze(['hant', 'tw', 'hk', 'mo']);

/**
 * The table for a language tag as `getCurrentLocale()` or `navigator.language` gives it (`de-de`, `pt-BR`, `zh-hk`).
 * Arabic and Icelandic have no emojibase locale and read English, as does any tag that is not known.
 * @param {string|undefined|null} tag
 * @returns {string} One of `EMOJI_LOCALES`.
 */
export function pickEmojiLocale(tag) {
    const [language, ...parts] = String(tag ?? '').toLowerCase().replace(/_/g, '-').split('-');
    if (language === 'zh') {
        return parts.some(part => TRADITIONAL_PARTS.includes(part)) ? 'zh-hant' : 'zh';
    }
    return EMOJI_LOCALES.includes(language) ? language : 'en';
}
