export const WORLD_INFO_LOGIC = Object.freeze({ AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 });

export const BASELINE_SETTINGS = Object.freeze({
    world_info_depth: 2,
    world_info_min_activations: 0,
    world_info_min_activations_depth_max: 0,
    world_info_budget: 25,
    world_info_budget_cap: 0,
    world_info_recursive: false,
    world_info_max_recursion_steps: 0,
    world_info_overflow_alert: false,
    world_info_case_sensitive: false,
    world_info_match_whole_words: false,
    world_info_use_group_scoring: false,
    world_info_character_strategy: 1,
});

export function entry(uid, fields = {}) {
    return {
        uid,
        key: [],
        keysecondary: [],
        content: '',
        constant: false,
        selective: true,
        selectiveLogic: WORLD_INFO_LOGIC.AND_ANY,
        order: 100,
        position: 0,
        disable: false,
        ignoreBudget: false,
        excludeRecursion: false,
        preventRecursion: false,
        matchPersonaDescription: false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: true,
        depth: 4,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        sticky: null,
        cooldown: null,
        delay: null,
        triggers: [],
        ...fields,
    };
}

export function getSteps(testCase) {
    return testCase.steps ?? [{ chat: testCase.chat, expected: testCase.expected, loops: testCase.loops }];
}

function keyCase({ name, key = ['moon'], secondary = [], logic = 'AND_ANY', selective = true, caseSensitive = null, wholeWords = null, scanDepth = null, chat, settings = {}, activates, ...rest }) {
    return {
        name,
        entries: [entry(1, { key, keysecondary: secondary, selective, selectiveLogic: WORLD_INFO_LOGIC[logic], caseSensitive, matchWholeWords: wholeWords, scanDepth })],
        chat,
        settings,
        expected: activates ? [1] : [],
        ...rest,
    };
}

const toCases = rows => rows.map(row => row.entries ? row : keyCase(row));

export const PRIMARY_KEY_CASES = toCases([
    { name: 'activates when the primary key is in the scanned text', key: ['moon'], chat: ['The moon is up.'], activates: true },
    { name: 'activates when any one of several primary keys is present', key: ['sun', 'moon'], chat: ['The moon is up.'], activates: true },
    { name: 'activates on a key found in an older scanned message', key: ['moon'], chat: ['Hello.', 'The moon is up.'], activates: true },
    { name: 'activates on a key inside a longer word when whole words are off', key: ['moon'], chat: ['Moonlight everywhere.'], activates: true },
    { name: 'stays inactive when no primary key is present', key: ['sun', 'star'], chat: ['The moon is up.'], activates: false },
    { name: 'ignores blank primary keys', key: ['  '], chat: ['The moon is up.'], activates: false },
    { name: 'stays inactive without any primary key', key: [], chat: ['The moon is up.'], activates: false },
]);

const TEA_AND_CAKE = { key: ['moon'], secondary: ['tea', 'cake'] };

export const SELECTIVE_LOGIC_CASES = toCases([
    { name: 'AND_ANY activates when one of several secondary keys is present', ...TEA_AND_CAKE, logic: 'AND_ANY', chat: ['The moon and a cake.'], activates: true },
    { name: 'AND_ANY stays inactive when no secondary key is present', ...TEA_AND_CAKE, logic: 'AND_ANY', chat: ['The moon alone.'], activates: false },
    { name: 'AND_ANY stays inactive without the primary key', ...TEA_AND_CAKE, logic: 'AND_ANY', chat: ['Tea and cake.'], activates: false },
    { name: 'NOT_ALL activates when one secondary key is missing', ...TEA_AND_CAKE, logic: 'NOT_ALL', chat: ['The moon with tea.'], activates: true },
    { name: 'NOT_ALL activates when no secondary key is present', ...TEA_AND_CAKE, logic: 'NOT_ALL', chat: ['The moon alone.'], activates: true },
    { name: 'NOT_ALL stays inactive when every secondary key is present', ...TEA_AND_CAKE, logic: 'NOT_ALL', chat: ['The moon with tea and cake.'], activates: false },
    { name: 'NOT_ANY activates when no secondary key is present', ...TEA_AND_CAKE, logic: 'NOT_ANY', chat: ['The moon alone.'], activates: true },
    { name: 'NOT_ANY stays inactive when one secondary key is present', ...TEA_AND_CAKE, logic: 'NOT_ANY', chat: ['The moon with tea.'], activates: false },
    { name: 'NOT_ANY stays inactive without the primary key', ...TEA_AND_CAKE, logic: 'NOT_ANY', chat: ['A quiet night.'], activates: false },
    { name: 'AND_ALL activates when every secondary key is present', ...TEA_AND_CAKE, logic: 'AND_ALL', chat: ['The moon with tea and cake.'], activates: true },
    { name: 'AND_ALL stays inactive when one secondary key is missing', ...TEA_AND_CAKE, logic: 'AND_ALL', chat: ['The moon with tea.'], activates: false },
    { name: 'treats an unset logic as AND_ANY and activates on one secondary key', ...TEA_AND_CAKE, logic: null, chat: ['The moon and a cake.'], activates: true },
    { name: 'treats an unset logic as AND_ANY and stays inactive without a secondary key', ...TEA_AND_CAKE, logic: null, chat: ['The moon alone.'], activates: false },
    { name: 'ignores secondary keys when the entry is not selective', ...TEA_AND_CAKE, logic: 'AND_ALL', selective: false, chat: ['The moon alone.'], activates: true },
    { name: 'activates on the primary key alone when a selective entry has no secondary keys', key: ['moon'], logic: 'NOT_ALL', chat: ['The moon alone.'], activates: true },
    { name: 'ignores blank secondary keys', key: ['moon'], secondary: ['  ', ''], logic: 'NOT_ANY', chat: ['The moon alone.'], activates: true },
    { name: 'matches a regular expression in a secondary key', key: ['moon'], secondary: ['/te+a/'], logic: 'AND_ALL', chat: ['The moon and teeea.'], activates: true },
    { name: 'stays inactive when a regular expression secondary key finds nothing', key: ['moon'], secondary: ['/te+a/'], logic: 'AND_ALL', chat: ['The moon and ta.'], activates: false },
    {
        name: 'applies all four logic modes to the same keys in one scan',
        entries: [
            entry(1, { key: ['moon'], keysecondary: ['tea', 'cake'], selectiveLogic: WORLD_INFO_LOGIC.AND_ANY }),
            entry(2, { key: ['moon'], keysecondary: ['tea', 'cake'], selectiveLogic: WORLD_INFO_LOGIC.NOT_ALL }),
            entry(3, { key: ['moon'], keysecondary: ['tea', 'cake'], selectiveLogic: WORLD_INFO_LOGIC.NOT_ANY }),
            entry(4, { key: ['moon'], keysecondary: ['tea', 'cake'], selectiveLogic: WORLD_INFO_LOGIC.AND_ALL }),
        ],
        chat: ['The moon with tea.'],
        settings: {},
        expected: [1, 2],
        crossCheck: true,
    },
]);

export const CASE_SENSITIVITY_CASES = toCases([
    { name: 'ignores case by default', key: ['Moon'], chat: ['the moon rises'], activates: true },
    { name: 'misses a different case when the global setting is on', key: ['Moon'], chat: ['the moon rises'], settings: { world_info_case_sensitive: true }, activates: false },
    { name: 'matches the same case when the global setting is on', key: ['Moon'], chat: ['the Moon rises'], settings: { world_info_case_sensitive: true }, activates: true },
    { name: 'misses a different case when the entry turns case sensitivity on', key: ['Moon'], caseSensitive: true, chat: ['the moon rises'], activates: false },
    { name: 'matches the same case when the entry turns case sensitivity on', key: ['Moon'], caseSensitive: true, chat: ['the Moon rises'], activates: true },
    { name: 'lets an entry turn case sensitivity off over the global setting', key: ['Moon'], caseSensitive: false, chat: ['the moon rises'], settings: { world_info_case_sensitive: true }, activates: true },
    { name: 'applies the entry setting to secondary keys', key: ['moon'], secondary: ['Tea'], caseSensitive: true, chat: ['the moon and tea'], activates: false },
    { name: 'matches secondary keys of the same case', key: ['moon'], secondary: ['Tea'], caseSensitive: true, chat: ['the moon and Tea'], activates: true },
    { name: 'misses non-Latin letters of a different case when the entry is case sensitive', key: ['Кот'], caseSensitive: true, chat: ['кот спит'], activates: false },
    { name: 'ignores the case of non-Latin letters by default', key: ['Кот'], chat: ['кот спит'], activates: true },
]);

const WHOLE_WORDS = { key: ['cat'], settings: { world_info_match_whole_words: true } };

export const WHOLE_WORD_CASES = toCases([
    { name: 'matches a whole word before a period', ...WHOLE_WORDS, chat: ['A cat.'], activates: true },
    { name: 'matches a whole word in parentheses', ...WHOLE_WORDS, chat: ['A (cat) sat.'], activates: true },
    { name: 'matches a whole word in quotation marks', ...WHOLE_WORDS, chat: ['A "cat" sat.'], activates: true },
    { name: 'matches a whole word before an exclamation mark', ...WHOLE_WORDS, chat: ['Look, a cat!'], activates: true },
    { name: 'matches a whole word before a hyphen', ...WHOLE_WORDS, chat: ['A cat-like grace.'], activates: true },
    { name: 'matches a whole word before an apostrophe', ...WHOLE_WORDS, chat: ['The cat\'s tail.'], activates: true },
    { name: 'matches a whole word that is the entire message', ...WHOLE_WORDS, chat: ['cat'], activates: true },
    { name: 'does not match inside a longer word', ...WHOLE_WORDS, chat: ['A category.'], activates: false },
    { name: 'does not match at the end of a longer word', ...WHOLE_WORDS, chat: ['A bobcat.'], activates: false },
    { name: 'does not match next to an underscore', ...WHOLE_WORDS, chat: ['A cat_food.'], activates: false },
    { name: 'does not match next to a digit', ...WHOLE_WORDS, chat: ['A cat2.'], activates: false },
    { name: 'matches inside a longer word when whole words are off', key: ['cat'], chat: ['A category.'], activates: true },
    { name: 'lets an entry turn whole words on over the global setting', key: ['cat'], wholeWords: true, chat: ['A category.'], activates: false },
    { name: 'lets an entry turn whole words off over the global setting', ...WHOLE_WORDS, wholeWords: false, chat: ['A category.'], activates: true },
    { name: 'applies whole words to secondary keys', key: ['moon'], secondary: ['tea'], wholeWords: true, chat: ['The moon and steam.'], activates: false },
    { name: 'matches a secondary key as a whole word', key: ['moon'], secondary: ['tea'], wholeWords: true, chat: ['The moon and tea.'], activates: true },
    { name: 'matches regular expression characters in a key as text', key: ['a.c'], wholeWords: true, chat: ['An a.c here.'], activates: true },
    { name: 'does not read regular expression characters in a key as a pattern', key: ['a.c'], wholeWords: true, chat: ['An abc here.'], activates: false },
    { name: 'matches a key that ends in symbols', key: ['c++'], wholeWords: true, chat: ['I like c++ a lot.'], activates: true },
    { name: 'matches a multi-word key as a phrase', key: ['moon rise'], wholeWords: true, chat: ['The moon rise was late.'], activates: true },
    { name: 'matches a multi-word key without word boundaries', key: ['moon rise'], wholeWords: true, chat: ['The moon rises early.'], activates: true },
    { name: 'does not match a multi-word key split by punctuation', key: ['moon rise'], wholeWords: true, chat: ['The moon, rise.'], activates: false },
    { name: 'does not match a multi-word key split by extra spaces', key: ['moon rise'], wholeWords: true, chat: ['The moon  rise.'], activates: false },
    { name: 'does not match the words of a multi-word key in another order', key: ['moon rise'], wholeWords: true, chat: ['Rise of the moon.'], activates: false },
    // Only ASCII letters, digits and the underscore count as word characters.
    { name: 'matches a Cyrillic word before punctuation', key: ['кот'], wholeWords: true, chat: ['Кот спит.'], activates: true },
    { name: 'matches a Cyrillic word inside guillemets', key: ['кот'], wholeWords: true, chat: ['«Кот», сказал он.'], activates: true },
    { name: 'matches a Chinese word inside unsegmented text', key: ['猫'], wholeWords: true, chat: ['那只黑猫在睡觉'], activates: true },
    { name: 'does not match a Cyrillic word next to a digit', key: ['кот'], wholeWords: true, chat: ['кот1'], activates: false },
    { name: 'does not match a Cyrillic word next to an underscore', key: ['кот'], wholeWords: true, chat: ['кот_дом'], activates: false },
    {
        name: 'applies whole words to punctuation and longer words in one scan',
        entries: [
            entry(1, { key: ['cat'] }),
            entry(2, { key: ['ate'] }),
        ],
        chat: ['A cat. Concatenate.'],
        settings: { world_info_match_whole_words: true },
        expected: [1],
        crossCheck: true,
    },
]);

export const REGEX_CASES = toCases([
    { name: 'matches a pattern with a character class and a repeat', key: ['/m[o0]{2}n/'], chat: ['The m00n rises.'], activates: true },
    { name: 'stays inactive when the pattern does not match', key: ['/m[o0]{2}n/'], chat: ['The mn rises.'], activates: false },
    { name: 'matches the case of the text exactly without the i flag', key: ['/MOON/'], chat: ['The moon rises.'], activates: false },
    { name: 'ignores the case of the text with the i flag', key: ['/MOON/i'], chat: ['The moon rises.'], activates: true },
    { name: 'ignores the entry case setting because the flags decide', key: ['/moon/i'], caseSensitive: true, chat: ['The Moon rises.'], activates: true },
    { name: 'ignores the global case setting because the flags decide', key: ['/moon/'], chat: ['The Moon rises.'], activates: false },
    { name: 'ignores the whole word setting and matches inside a longer word', key: ['/moon/'], wholeWords: true, chat: ['Moonlight and moonbeams.'], activates: true },
    { name: 'matches across a line break only with the s flag', key: ['/moon.rises/s'], chat: ['moon\nrises'], activates: true },
    { name: 'does not match across a line break without the s flag', key: ['/moon.rises/'], chat: ['moon\nrises'], activates: false },
    { name: 'matches with the g flag', key: ['/moon/g'], chat: ['The moon rises.'], activates: true },
    { name: 'matches a Unicode property with the u flag', key: ['/\\p{Script=Cyrillic}+/u'], chat: ['Кот спит.'], activates: true },
    { name: 'keeps a non-Latin word whole with lookarounds and the u flag', key: ['/(?<![\\p{L}\\p{N}_])кот(?![\\p{L}\\p{N}_])/iu'], chat: ['Кот спит.'], activates: true },
    { name: 'rejects a longer non-Latin word with lookarounds and the u flag', key: ['/(?<![\\p{L}\\p{N}_])кот(?![\\p{L}\\p{N}_])/iu'], chat: ['Скотина спит.'], activates: false },
    { name: 'matches an escaped slash inside a pattern', key: ['/a\\/b/'], chat: ['The a/b ratio.'], activates: true },
    { name: 'matches an invalid pattern as plain text', key: ['/(unclosed/'], chat: ['A note: /(unclosed/ here.'], activates: true },
    { name: 'does not treat an invalid pattern as a pattern', key: ['/(unclosed/'], chat: ['A note: unclosed here.'], activates: false },
    { name: 'matches a key with an unknown flag as plain text', key: ['/moon/x'], chat: ['A note: /moon/x here.'], activates: true },
    { name: 'does not treat a key with an unknown flag as a pattern', key: ['/moon/x'], chat: ['The moon rises.'], activates: false },
    { name: 'matches a key with an unescaped slash inside as plain text', key: ['/a/b/'], chat: ['A note: /a/b/ here.'], activates: true },
    { name: 'does not treat a key with an unescaped slash inside as a pattern', key: ['/a/b/'], chat: ['The a/b ratio.'], activates: false },
    {
        name: 'honors the i flag and the lack of it in one scan',
        entries: [
            entry(1, { key: ['/MOON/i'] }),
            entry(2, { key: ['/MOON/'] }),
            entry(3, { key: ['/(unclosed/'] }),
        ],
        chat: ['The moon is out.'],
        settings: {},
        expected: [1],
        crossCheck: true,
    },
]);

export const SCAN_DEPTH_CASES = toCases([
    { name: 'scans only the newest messages up to the depth setting', key: ['moon'], chat: ['one', 'two', 'The moon.'], settings: { world_info_depth: 2 }, activates: false },
    { name: 'scans a message at the depth setting', key: ['moon'], chat: ['one', 'The moon.', 'three'], settings: { world_info_depth: 2 }, activates: true },
    { name: 'scans only the newest message at a depth of one', key: ['moon'], chat: ['The moon.', 'Something else.'], settings: { world_info_depth: 1 }, activates: true },
    { name: 'misses the second newest message at a depth of one', key: ['moon'], chat: ['Something else.', 'The moon.'], settings: { world_info_depth: 1 }, activates: false },
    { name: 'lets an entry scan deeper than the depth setting', key: ['moon'], scanDepth: 3, chat: ['one', 'two', 'The moon.'], settings: { world_info_depth: 1 }, activates: true },
    { name: 'lets an entry scan less than the depth setting', key: ['moon'], scanDepth: 1, chat: ['one', 'The moon.'], settings: { world_info_depth: 3 }, activates: false },
    { name: 'scans no messages at an entry scan depth of zero', key: ['moon'], scanDepth: 0, chat: ['The moon.'], settings: { world_info_depth: 3 }, activates: false },
]);
