import { readFileSync } from 'node:fs';
import { describe, expect, jest, test } from '@jest/globals';

const { EMOJI_LOCALES, pickEmojiLocale } = await import('../public/scripts/sillybunny-conversation/emoji/emoji-locales.js');
const { DATA_VERSION, createEmojiTableLoader } = await import('../public/scripts/sillybunny-conversation/emoji/emoji-table.js');

const langs = JSON.parse(readFileSync(new URL('../public/locales/lang.json', import.meta.url), 'utf8'));

describe('pickEmojiLocale', () => {
    test('maps every language that the interface ships to a table, or to English where emojibase has none', () => {
        const picked = Object.fromEntries(langs.map(({ lang }) => [lang, pickEmojiLocale(lang)]));
        expect(picked).toEqual({
            'ar-sa': 'en',
            'zh-cn': 'zh',
            'zh-tw': 'zh-hant',
            'nl-nl': 'nl',
            'de-de': 'de',
            'fr-fr': 'fr',
            'is-is': 'en',
            'it-it': 'it',
            'ja-jp': 'ja',
            'ko-kr': 'ko',
            'pt-pt': 'pt',
            'ru-ru': 'ru',
            'es-es': 'es',
            'uk-ua': 'uk',
            'vi-vn': 'vi',
            'th-th': 'th',
        });
        expect(pickEmojiLocale('en')).toBe('en');
    });

    test('takes the language of a browser tag, and the traditional script for Taiwan, Hong Kong and Macau', () => {
        expect(pickEmojiLocale('pt-br')).toBe('pt');
        expect(pickEmojiLocale('en-gb')).toBe('en');
        expect(pickEmojiLocale('de-at')).toBe('de');
        expect(pickEmojiLocale('zh-hk')).toBe('zh-hant');
        expect(pickEmojiLocale('zh-mo')).toBe('zh-hant');
        expect(pickEmojiLocale('zh-hant-tw')).toBe('zh-hant');
        expect(pickEmojiLocale('zh-sg')).toBe('zh');
        expect(pickEmojiLocale('zh')).toBe('zh');
    });

    test('is not case sensitive, and falls back to English for anything unknown or empty', () => {
        expect(pickEmojiLocale('DE-DE')).toBe('de');
        expect(pickEmojiLocale('xx-yy')).toBe('en');
        expect(pickEmojiLocale('')).toBe('en');
        expect(pickEmojiLocale(undefined)).toBe('en');
    });

    test('only ever answers a locale that has a table', () => {
        for (const tag of ['ar', 'is', 'sv', 'pl', 'es-mx', 'ms']) {
            expect(EMOJI_LOCALES).toContain(pickEmojiLocale(tag));
        }
    });
});

const tableJson = locale => ({
    v: 1,
    emojibase: '18.0.0',
    locale,
    groups: ['one'],
    tones: ['a', 'b', 'c', 'd', 'e'],
    rows: [['😀', locale === 'en' ? 'grinning face' : 'grinsendes Gesicht', 'smile', 0, 1]],
});

describe('the table loader', () => {
    test('fetches the table of the interface language once, with the version in the address', async () => {
        const fetchJson = jest.fn(async url => tableJson(/emoji-(.+)\.json/.exec(url)[1]));
        const loader = createEmojiTableLoader({ fetchJson, getLocale: () => 'de-de' });

        const [first, second] = await Promise.all([loader.load(), loader.load()]);

        expect(first).toBe(second);
        expect(first.locale).toBe('de');
        expect(first.rows[0][1]).toBe('grinsendes Gesicht');
        expect(fetchJson).toHaveBeenCalledTimes(1);
        expect(fetchJson.mock.calls[0][0]).toMatch(/\/data\/emoji-de\.json\?v=/);
        expect(fetchJson.mock.calls[0][0]).toContain(`v=${DATA_VERSION}`);
    });

    test('does not remember a failed fetch', async () => {
        const fetchJson = jest.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockImplementation(async () => tableJson('en'));
        const loader = createEmojiTableLoader({ fetchJson, getLocale: () => 'en' });

        await expect(loader.load()).rejects.toThrow('offline');
        await expect(loader.load()).resolves.toMatchObject({ locale: 'en' });
        expect(fetchJson).toHaveBeenCalledTimes(2);
    });

    test('refuses a file that is not a table of this format', async () => {
        const loader = createEmojiTableLoader({ fetchJson: async () => ({ v: 2, rows: [] }), getLocale: () => 'en' });
        await expect(loader.load()).rejects.toThrow(/table/i);
    });

    test('loads English on demand, and is the same table when the language is English', async () => {
        const fetchJson = jest.fn(async url => tableJson(/emoji-(.+)\.json/.exec(url)[1]));
        const german = createEmojiTableLoader({ fetchJson, getLocale: () => 'de' });
        await german.load();
        expect(fetchJson).toHaveBeenCalledTimes(1);
        const english = await german.loadEnglish();
        expect(english.locale).toBe('en');
        expect(fetchJson).toHaveBeenCalledTimes(2);

        const plain = createEmojiTableLoader({ fetchJson: async () => tableJson('en'), getLocale: () => 'en' });
        expect(await plain.loadEnglish()).toBe(await plain.load());
    });

    test('builds the search index once, when it is first asked for', async () => {
        const loader = createEmojiTableLoader({ fetchJson: async () => tableJson('en'), getLocale: () => 'en' });
        const table = await loader.load();
        expect(table.getIndex()).toBe(table.getIndex());
        expect(table.getIndex()[0].name).toBe('grinning face');
    });
});
