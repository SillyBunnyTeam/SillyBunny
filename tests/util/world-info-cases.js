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
    return testCase.steps ?? [{ chat: testCase.chat, expected: testCase.expected, loops: testCase.loops, ordered: testCase.ordered }];
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

const RECURSIVE = { world_info_recursive: true };

const CHAIN = [
    entry(1, { key: ['moon'], content: 'river' }),
    entry(2, { key: ['river'], content: 'bridge' }),
    entry(3, { key: ['bridge'], content: 'castle' }),
    entry(4, { key: ['castle'], content: 'tower' }),
];
const chain = length => CHAIN.slice(0, length);

const DELAY_LEVELS = [
    entry(1, { key: ['moon'], content: 'river' }),
    entry(2, { key: ['moon'], delayUntilRecursion: 2 }),
    entry(3, { key: ['moon'], delayUntilRecursion: 1 }),
];

export const RECURSION_CASES = toCases([
    { name: 'ignores the text of an activated entry when recursion is off', entries: chain(2), chat: ['The moon.'], expected: [1], loops: 1 },
    { name: 'searches the text of an activated entry when recursion is on', entries: chain(2), chat: ['The moon.'], settings: RECURSIVE, expected: [1, 2], loops: 3 },
    { name: 'follows a chain of entries until nothing new activates', entries: chain(4), chat: ['The moon.'], settings: RECURSIVE, expected: [1, 2, 3, 4], loops: 5 },
    { name: 'stays inactive when no activated entry mentions its key', entries: [CHAIN[0], entry(2, { key: ['sea'] })], chat: ['The moon.'], settings: RECURSIVE, expected: [1], loops: 2 },
    {
        name: 'keeps an entry with exclude recursion out of recursive scans',
        entries: [CHAIN[0], entry(2, { key: ['river'], excludeRecursion: true })],
        chat: ['The moon.'],
        settings: RECURSIVE,
        expected: [1],
        loops: 2,
    },
    {
        name: 'still activates an entry with exclude recursion from the chat text',
        entries: [CHAIN[0], entry(2, { key: ['river'], excludeRecursion: true })],
        chat: ['The moon by the river.'],
        settings: RECURSIVE,
        expected: [1, 2],
        loops: 2,
    },
    {
        name: 'does not search the text of an entry with prevent recursion',
        entries: [entry(1, { key: ['moon'], content: 'river', preventRecursion: true }), CHAIN[1]],
        chat: ['The moon.'],
        settings: RECURSIVE,
        expected: [1],
        loops: 1,
    },
    {
        name: 'lets recursion activate an entry that prevents recursion',
        entries: [CHAIN[0], entry(2, { key: ['river'], content: 'bridge', preventRecursion: true }), CHAIN[2]],
        chat: ['The moon.'],
        settings: RECURSIVE,
        expected: [1, 2],
        loops: 2,
    },
    {
        name: 'holds back an entry that waits for recursion until a recursive scan',
        entries: [entry(1, { key: ['moon'], delayUntilRecursion: true }), entry(2, { key: ['moon'], content: 'river' })],
        chat: ['The moon.'],
        settings: RECURSIVE,
        expected: [2, 1],
        ordered: true,
        loops: 3,
    },
    {
        name: 'never activates an entry that waits for recursion when recursion is off',
        entries: [entry(1, { key: ['moon'], delayUntilRecursion: true }), entry(2, { key: ['moon'], content: 'river' })],
        chat: ['The moon.'],
        expected: [2],
        loops: 1,
    },
    {
        name: 'never activates an entry that waits for recursion when no entry starts a recursive scan',
        entries: [entry(1, { key: ['moon'], delayUntilRecursion: true })],
        chat: ['The moon.'],
        settings: RECURSIVE,
        expected: [],
        loops: 1,
    },
    {
        name: 'activates delayed entries one recursion level at a time',
        entries: DELAY_LEVELS,
        chat: ['The moon.'],
        settings: RECURSIVE,
        expected: [1, 3, 2],
        ordered: true,
        loops: 5,
    },
    {
        name: 'treats a delay until recursion of true as level one',
        entries: [DELAY_LEVELS[0], DELAY_LEVELS[1], entry(3, { key: ['moon'], delayUntilRecursion: true })],
        chat: ['The moon.'],
        settings: RECURSIVE,
        expected: [1, 3, 2],
        ordered: true,
        loops: 5,
    },
    {
        name: 'activates delayed entries of the same level in one recursive scan',
        entries: [DELAY_LEVELS[0], entry(2, { key: ['moon'], delayUntilRecursion: true }), DELAY_LEVELS[2]],
        chat: ['The moon.'],
        settings: RECURSIVE,
        expected: [1, 2, 3],
        loops: 3,
    },
    {
        name: 'stops before a higher recursion level when the step cap is reached',
        entries: DELAY_LEVELS,
        chat: ['The moon.'],
        settings: { ...RECURSIVE, world_info_max_recursion_steps: 3 },
        expected: [1, 3],
        ordered: true,
        loops: 3,
    },
    { name: 'follows the whole chain when the step cap is zero', entries: chain(4), chat: ['The moon.'], settings: { ...RECURSIVE, world_info_max_recursion_steps: 0 }, expected: [1, 2, 3, 4], loops: 5 },
    { name: 'counts the first scan as a recursion step', entries: chain(4), chat: ['The moon.'], settings: { ...RECURSIVE, world_info_max_recursion_steps: 1 }, expected: [1], loops: 1 },
    { name: 'stops a chain after the second step when the step cap is two', entries: chain(4), chat: ['The moon.'], settings: { ...RECURSIVE, world_info_max_recursion_steps: 2 }, expected: [1, 2], loops: 2 },
    { name: 'stops a chain after the third step when the step cap is three', entries: chain(4), chat: ['The moon.'], settings: { ...RECURSIVE, world_info_max_recursion_steps: 3 }, expected: [1, 2, 3], loops: 3 },
    { name: 'finishes a chain that fits exactly in the step cap', entries: chain(4), chat: ['The moon.'], settings: { ...RECURSIVE, world_info_max_recursion_steps: 4 }, expected: [1, 2, 3, 4], loops: 4 },
    { name: 'finishes a chain and ends before a higher step cap', entries: chain(4), chat: ['The moon.'], settings: { ...RECURSIVE, world_info_max_recursion_steps: 9 }, expected: [1, 2, 3, 4], loops: 5 },
]);

const DEEP_CHAT = ['one', 'two', 'three', 'The moon.', 'five', 'six'];
const MOON = [entry(1, { key: ['moon'] })];

export const MIN_ACTIVATION_CASES = toCases([
    { name: 'does not look past the depth setting without a minimum', entries: MOON, chat: DEEP_CHAT, settings: { world_info_min_activations: 0 }, expected: [], loops: 1 },
    { name: 'grows the scan depth until the minimum is reached', entries: MOON, chat: DEEP_CHAT, settings: { world_info_min_activations: 1 }, expected: [1], loops: 3 },
    { name: 'stops growing at the maximum depth', entries: MOON, chat: DEEP_CHAT, settings: { world_info_min_activations: 1, world_info_min_activations_depth_max: 3 }, expected: [], loops: 2 },
    { name: 'finds an entry at the maximum depth', entries: MOON, chat: DEEP_CHAT, settings: { world_info_min_activations: 1, world_info_min_activations_depth_max: 4 }, expected: [1], loops: 3 },
    { name: 'ignores a maximum depth that is deeper than the entry', entries: MOON, chat: DEEP_CHAT, settings: { world_info_min_activations: 1, world_info_min_activations_depth_max: 10 }, expected: [1], loops: 3 },
    { name: 'keeps growing while the minimum is still not reached', entries: MOON, chat: DEEP_CHAT, settings: { world_info_min_activations: 2 }, expected: [1], loops: 5 },
    { name: 'stops at the end of the chat when nothing is found', entries: MOON, chat: ['one', 'two', 'three', 'four', 'five', 'six'], settings: { world_info_min_activations: 1 }, expected: [], loops: 5 },
    {
        name: 'does not grow the scan when the minimum is already met',
        entries: [MOON[0], entry(2, { constant: true })],
        chat: DEEP_CHAT,
        settings: { world_info_min_activations: 1 },
        expected: [2],
        loops: 1,
    },
    {
        name: 'counts a constant entry toward the minimum and grows the scan for the rest',
        entries: [MOON[0], entry(2, { constant: true })],
        chat: DEEP_CHAT,
        settings: { world_info_min_activations: 2 },
        expected: [1, 2],
        loops: 3,
    },
    {
        name: 'keeps the scan depth of an entry when the minimum grows the global depth',
        entries: [entry(1, { key: ['moon'], scanDepth: 2 })],
        chat: DEEP_CHAT,
        settings: { world_info_min_activations: 1 },
        expected: [],
        loops: 5,
    },
    {
        name: 'keeps the text of activated entries out of deeper minimum scans',
        entries: [entry(1, { key: ['moon'], content: 'river' }), entry(2, { key: ['river'], excludeRecursion: true })],
        chat: ['The moon.', 'two', 'three'],
        settings: { ...RECURSIVE, world_info_min_activations: 2 },
        expected: [1],
        loops: 4,
    },
    {
        name: 'follows a deeper scan with a recursive scan while the minimum is not reached',
        entries: [
            entry(1, { key: ['one'], content: 'river' }),
            entry(2, { key: ['river'], content: 'bridge' }),
            entry(3, { key: ['moon'] }),
        ],
        chat: DEEP_CHAT,
        settings: { ...RECURSIVE, world_info_min_activations: 3 },
        expected: [1, 2, 3],
        loops: 7,
    },
]);

const grouped = (uid, fields = {}) => entry(uid, { key: ['moon'], group: 'g', ...fields });
const WEIGHTED = [grouped(1, { groupWeight: 100 }), grouped(2, { groupWeight: 300 })];
const SCORED = [grouped(1), grouped(2, { key: ['moon', 'star'] })];
const OVERLAPPING = [grouped(1, { group: 'a,b' }), grouped(2, { group: 'a' }), grouped(3, { group: 'b' })];
const SCORING_ON = { world_info_use_group_scoring: true };

export const INCLUSION_GROUP_CASES = toCases([
    { name: 'keeps the only entry of a group without a roll', entries: [grouped(1)], chat: ['The moon.'], expected: [1] },
    { name: 'picks the first entry when the roll is at the start of the weights', entries: WEIGHTED, chat: ['The moon.'], random: 0, expected: [1] },
    { name: 'picks the first entry when the roll lands on the edge of its weight', entries: WEIGHTED, chat: ['The moon.'], random: 0.25, expected: [1] },
    { name: 'picks the second entry when the roll passes the weight of the first', entries: WEIGHTED, chat: ['The moon.'], random: 0.26, expected: [2] },
    { name: 'picks the last entry when the roll is at the end of the weights', entries: WEIGHTED, chat: ['The moon.'], random: 0.99, expected: [2] },
    { name: 'counts an omitted weight as the default weight', entries: [grouped(1, { groupWeight: undefined }), grouped(2)], chat: ['The moon.'], random: 0.5, expected: [1] },
    {
        name: 'picks the prioritized entry over an entry with a heavier weight',
        entries: [grouped(1, { groupWeight: 1000 }), grouped(2, { groupOverride: true, groupWeight: 1, order: 10 })],
        chat: ['The moon.'],
        expected: [2],
    },
    {
        name: 'picks the prioritized entry with the highest order',
        entries: [grouped(1, { groupOverride: true, order: 10 }), grouped(2, { groupOverride: true, order: 50 }), grouped(3, { order: 90 })],
        chat: ['The moon.'],
        expected: [2],
    },
    { name: 'rolls between entries that match different numbers of keys when group scoring is off', entries: SCORED, chat: ['A moon and a star.'], random: 0, expected: [1] },
    { name: 'picks the entry that matches the most keys when group scoring is on', entries: SCORED, chat: ['A moon and a star.'], settings: SCORING_ON, expected: [2] },
    {
        name: 'turns group scoring on for entries that ask for it',
        entries: [grouped(1, { useGroupScoring: true }), grouped(2, { key: ['moon', 'star'], useGroupScoring: true })],
        chat: ['A moon and a star.'],
        expected: [2],
    },
    {
        name: 'keeps an entry that did not ask for group scoring next to one that did',
        entries: [grouped(1), grouped(2, { key: ['moon', 'star'], useGroupScoring: true })],
        chat: ['A moon and a star.'],
        random: 0,
        expected: [1],
    },
    {
        name: 'keeps a lower scoring entry that opts out of group scoring',
        entries: [grouped(1, { useGroupScoring: false }), grouped(2, { key: ['moon', 'star'] })],
        chat: ['A moon and a star.'],
        settings: SCORING_ON,
        random: 0,
        expected: [1],
    },
    { name: 'rolls the weights when group scores tie', entries: [grouped(1), grouped(2)], chat: ['The moon.'], settings: SCORING_ON, random: 0.99, expected: [2] },
    {
        name: 'adds matching secondary keys to the score of an AND_ANY entry',
        entries: [grouped(1, { keysecondary: ['tea'], selectiveLogic: WORLD_INFO_LOGIC.AND_ANY }), grouped(2)],
        chat: ['The moon and tea.'],
        settings: SCORING_ON,
        random: 0.99,
        expected: [1],
    },
    {
        name: 'does not add absent secondary keys to the score of a NOT_ANY entry',
        entries: [grouped(1, { keysecondary: ['rain'], selectiveLogic: WORLD_INFO_LOGIC.NOT_ANY }), grouped(2)],
        chat: ['The moon.'],
        settings: SCORING_ON,
        random: 0.99,
        expected: [2],
    },
    { name: 'lets an entry in two groups win both groups with a low roll', entries: OVERLAPPING, chat: ['The moon.'], random: 0, expected: [1] },
    { name: 'frees the other group when an entry in two groups loses one group', entries: OVERLAPPING, chat: ['The moon.'], random: 0.99, expected: [2, 3] },
    {
        name: 'removes an entry of a group that already activated in an earlier scan',
        entries: [entry(1, { key: ['moon'], content: 'river' }), grouped(2), grouped(3, { key: ['river'] })],
        chat: ['The moon.'],
        settings: RECURSIVE,
        expected: [1, 2],
    },
    {
        name: 'activates an entry of another group in a later scan',
        entries: [entry(1, { key: ['moon'], content: 'river' }), grouped(2), grouped(3, { key: ['river'], group: 'h' })],
        chat: ['The moon.'],
        settings: RECURSIVE,
        expected: [1, 2, 3],
    },
    {
        name: 'rolls a group with a weighted pick and a prioritized pick in one scan',
        entries: [
            grouped(1, { group: 'a', groupWeight: 100 }),
            grouped(2, { group: 'a', groupWeight: 300 }),
            grouped(3, { group: 'b', groupOverride: true, order: 10 }),
            grouped(4, { group: 'b', order: 20 }),
        ],
        chat: ['The moon.'],
        random: 0.9,
        expected: [2, 3],
        crossCheck: true,
    },
]);

const ONLY_FIRST = [['The moon.'], ['Quiet.', 'The moon.'], ['Quiet.', 'Quiet.', 'The moon.']];
const EVERY_STEP = [
    ['The moon.'],
    ['The moon.', 'Filler.'],
    ['The moon.', 'Filler.', 'Filler.'],
    ['The moon.', 'Filler.', 'Filler.', 'Filler.'],
    ['The moon.', 'Filler.', 'Filler.', 'Filler.', 'Filler.'],
];
const timeline = (chats, outcomes) => chats.map((chat, index) => ({ chat, expected: outcomes[index] }));
const NEWEST_ONLY = { world_info_depth: 1 };

export const TIMED_EFFECT_CASES = toCases([
    { name: 'keeps a sticky entry active for its sticky duration', entries: [entry(1, { key: ['moon'], sticky: 2 })], settings: NEWEST_ONLY, steps: timeline(ONLY_FIRST, [[1], [1], []]) },
    { name: 'drops an entry without sticky when its key leaves the scan', entries: [entry(1, { key: ['moon'] })], settings: NEWEST_ONLY, steps: timeline(ONLY_FIRST, [[1], [], []]) },
    { name: 'holds an entry back for its cooldown duration', entries: [entry(1, { key: ['moon'], cooldown: 2 })], steps: timeline(EVERY_STEP.slice(0, 3), [[1], [], [1]]) },
    { name: 'activates an entry without cooldown on every scan', entries: [entry(1, { key: ['moon'] })], steps: timeline(EVERY_STEP.slice(0, 3), [[1], [1], [1]]) },
    { name: 'holds an entry back until the chat is long enough for its delay', entries: [entry(1, { key: ['moon'], delay: 3 })], steps: timeline(EVERY_STEP.slice(0, 3), [[], [], [1]]) },
    { name: 'starts the cooldown of a sticky entry when its sticky ends', entries: [entry(1, { key: ['moon'], sticky: 1, cooldown: 2 })], steps: timeline(EVERY_STEP.slice(0, 4), [[1], [], [], [1]]) },
    { name: 'keeps an entry sticky while its first cooldown window is still open', entries: [entry(1, { key: ['moon'], sticky: 2, cooldown: 2 })], steps: timeline(EVERY_STEP, [[1], [1], [], [], [1]]) },
    {
        name: 'keeps a sticky entry over a prioritized entry of its group',
        entries: [grouped(1, { sticky: 2 }), grouped(2, { key: ['sun'], groupOverride: true })],
        settings: NEWEST_ONLY,
        steps: [
            { chat: ['The moon.'], expected: [1] },
            { chat: ['The sun.', 'The moon.'], expected: [1] },
            { chat: ['The sun.', 'Quiet.', 'The moon.'], expected: [2] },
        ],
    },
    {
        name: 'lets another entry of a group win while an entry is on cooldown',
        entries: [grouped(1, { cooldown: 2 }), grouped(2)],
        random: 0,
        steps: timeline(EVERY_STEP.slice(0, 3), [[1], [2], [1]]),
    },
    {
        name: 'lets another entry of a group win until an entry has passed its delay',
        entries: [grouped(1, { delay: 2 }), grouped(2)],
        random: 0,
        steps: timeline(EVERY_STEP.slice(0, 2), [[2], [1]]),
    },
    {
        name: 'carries a sticky entry and a rolled probability through three scans',
        entries: [entry(1, { key: ['moon'], sticky: 2, probability: 50 })],
        settings: NEWEST_ONLY,
        steps: [
            { chat: ['The moon.'], random: 0.1, expected: [1] },
            { chat: ['Quiet.', 'The moon.'], random: 0.9, expected: [1] },
            { chat: ['Quiet.', 'Quiet.', 'The moon.'], random: 0.9, expected: [] },
        ],
        crossCheck: true,
    },
]);
