import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

import { event_types } from '../public/scripts/events.js';
import { read as readCardMetadata } from '../src/character-card-parser.js';
import { createHarness as createScanHarness } from './util/world-info-harness.js';

function entry(uid, fields) {
    return { uid, key: [], keysecondary: [], content: '', position: 0, order: 100, ...fields };
}

function createBooks() {
    return {
        'Aster Book': {
            entries: {
                1: entry(1, { key: ['moon'], content: 'Aster sees the moon with {{user}}.' }),
                2: entry(2, { constant: true, position: 1, order: 90, content: 'Aster constant for {{char}}.' }),
                3: entry(3, { key: ['{{user}}'], position: 4, depth: 2, role: 1, content: 'Keyed on the user name.' }),
                4: entry(4, { key: ['never said'], content: 'Forced by an extension.' }),
                5: entry(5, { key: ['moon'], sticky: 2, position: 1, order: 80, content: 'Sticky moon lore.' }),
            },
        },
        'Aster Extra': {
            entries: {
                1: entry(1, { key: ['tea'], position: 2, content: 'Tea before the note.' }),
                2: entry(2, { key: ['tea'], position: 3, content: 'Tea after the note.' }),
            },
        },
        'Shared Book': {
            entries: {
                1: entry(1, { constant: true, position: 5, content: 'Shared example.' }),
            },
        },
        'Global Book': {
            entries: {
                1: entry(1, { key: ['moon'], characterFilter: { names: ['bram'], tags: [], isExclude: false }, content: 'Only for Bram.' }),
                2: entry(2, { key: ['star'], content: 'Global star lore.' }),
                3: entry(3, { key: ['moon'], characterFilter: { names: [], tags: ['tag-bram'], isExclude: true }, content: 'Hidden from Bram by tag.' }),
                4: entry(4, { key: ['{{char}}'], position: 1, order: 50, content: 'Keyed on the character name.' }),
            },
        },
        'Chat Book': {
            entries: {
                1: entry(1, { key: ['moon'], position: 1, order: 70, content: 'Chat moon lore.' }),
            },
        },
        'Persona Book': {
            entries: {
                1: entry(1, { constant: true, order: 60, content: 'Roleplay persona lore.' }),
            },
        },
        'Bram Book': {
            entries: {
                1: entry(1, { constant: true, content: 'Bram constant for {{char}} and {{user}}.' }),
                2: entry(2, { key: ['moon'], position: 1, content: 'Bram sees the moon.' }),
            },
        },
        'Bram Override': {
            entries: {
                1: entry(1, { key: ['tea'], position: 1, order: 40, content: 'Override tea lore.' }),
            },
        },
        'Bram Persona': {
            entries: {
                1: entry(1, { constant: true, order: 30, content: 'Conversation persona lore.' }),
            },
        },
    };
}

const createHarness = (options = {}) => createScanHarness({ books: createBooks(), ...options });

const CHAT = ['Aster: Good evening.', 'Roleplay User: We watched the moon and drank tea.'];

beforeEach(() => {
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('World Info scan of the active chat', () => {
    test('keeps the Roleplay scan output, side effects and events', async () => {
        const harness = await createHarness({ fresh: true });
        await harness.forceActivate([{ ...createBooks()['Aster Book'].entries[4], world: 'Aster Book' }]);

        const result = await harness.checkWorldInfo([...CHAT].reverse(), 4000, false, harness.defaultGlobalScanData);

        expect(result.worldInfoBefore).toBe([
            'Roleplay persona lore.',
            'Hidden from Bram by tag.',
            'Global star lore.',
            'Aster sees the moon with Roleplay User.',
            'Forced by an extension.',
        ].join('\n'));
        expect(result.worldInfoAfter).toBe([
            'Keyed on the character name.',
            'Chat moon lore.',
            'Sticky moon lore.',
            'Aster constant for Aster.',
        ].join('\n'));
        expect(result.EMEntries).toEqual([{ position: 0, content: 'Shared example.' }]);
        expect(result.WIDepthEntries).toEqual([{ depth: 2, entries: ['Keyed on the user name.'], role: 1 }]);
        expect(result.ANBeforeEntries).toEqual(['Tea before the note.']);
        expect(result.ANAfterEntries).toEqual(['Tea after the note.']);
        expect(harness.mocks.setExtensionPrompt).toHaveBeenCalledWith('note', 'Tea before the note.\nRoleplay note mentions a star.\nTea after the note.', 1, 4, true, 0);
        expect(Object.keys(harness.state.chat_metadata.timedWorldInfo.sticky)).toEqual(['Aster Book.5']);
        expect(harness.mocks.eventSource.emit.mock.calls.map(([name]) => name)).toEqual([event_types.WORLDINFO_ENTRIES_LOADED, event_types.WORLDINFO_SCAN_DONE]);
        expect([...harness.loadedBooks].sort()).toEqual(['Aster Book', 'Aster Extra', 'Chat Book', 'Global Book', 'Persona Book', 'Shared Book']);

        // Confirm external activation was consumed by the scan and does not fire again.
        const followUp = await harness.checkWorldInfo(['Aster: Quiet evening.'], 4000, true, harness.defaultGlobalScanData);
        expect(followUp.worldInfoBefore).not.toContain('Forced by an extension.');
    });

    test('scans entries keyed on the user name at their depth', async () => {
        const harness = await createHarness();

        const result = await harness.checkWorldInfo(['Aster: Hello, Roleplay User.'], 4000, true, harness.defaultGlobalScanData);

        expect(result.WIDepthEntries).toEqual([{ depth: 2, entries: ['Keyed on the user name.'], role: 1 }]);
        expect(harness.state.chat_metadata.timedWorldInfo).toEqual({ sticky: {}, cooldown: {} });
    });
});

const BRAM_TARGET = Object.freeze({ characterId: 1, chatWorld: 'Bram Override', personaWorld: 'Bram Persona', userName: 'Conversation User' });

describe('World Info scan of a scan target', () => {
    test('reads the target character, global, override and persona books with the target names', async () => {
        const harness = await createHarness();

        const result = await harness.checkWorldInfo(['Conversation User: The moon over tea, Bram.'], 4000, true, harness.defaultGlobalScanData, BRAM_TARGET);

        expect([...harness.loadedBooks].sort()).toEqual(['Bram Book', 'Bram Override', 'Bram Persona', 'Global Book', 'Shared Book']);
        expect(result.worldInfoBefore.split('\n')).toEqual(['Conversation persona lore.', 'Only for Bram.', 'Bram constant for Bram and Conversation User.']);
        expect(result.worldInfoAfter.split('\n')).toEqual(['Override tea lore.', 'Keyed on the character name.', 'Bram sees the moon.']);
        expect(result.EMEntries).toEqual([{ position: 0, content: 'Shared example.' }]);
        expect(result.ANBeforeEntries).toEqual([]);
        expect(harness.mocks.getRegexedString).toHaveBeenCalledWith('Bram sees the moon.', 5, expect.objectContaining({ characterOverride: 'Bram' }));
    });

    test('leaves the active chat prompts, timed effects, forced activations and listeners alone', async () => {
        const books = createBooks();
        books['Bram Book'].entries[2].sticky = 3;
        const harness = await createHarness({ books, fresh: true });
        const forcedEntry = { ...books['Global Book'].entries[2], world: 'Global Book' };
        await harness.forceActivate([forcedEntry]);
        harness.state.chat_metadata.timedWorldInfo = { sticky: {}, cooldown: {} };

        const result = await harness.checkWorldInfo(['Conversation User: The moon is out.'], 4000, false, harness.defaultGlobalScanData, BRAM_TARGET);

        expect(result.worldInfoAfter).toContain('Bram sees the moon.');
        expect(result.worldInfoBefore).not.toContain('Global star lore.');
        expect(harness.mocks.setExtensionPrompt).not.toHaveBeenCalled();
        expect(harness.mocks.eventSource.emit).not.toHaveBeenCalled();
        expect(harness.state.chat_metadata.timedWorldInfo).toEqual({ sticky: {}, cooldown: {} });

        // Forced activation must still be queued for the active chat scan.
        const activeResult = await harness.checkWorldInfo(['Aster: Quiet.'], 4000, false, harness.defaultGlobalScanData);
        expect(activeResult.worldInfoBefore).toContain('Global star lore.');
    });

    test('stops adding entries at the World Info budget', async () => {
        const harness = await createHarness({
            books: {
                'Bram Book': {
                    entries: {
                        1: entry(1, { constant: true, order: 30, content: 'Low priority lore.' }),
                        2: entry(2, { constant: true, order: 90, content: 'High priority lore.' }),
                    },
                },
            },
            selectedWorldInfo: [],
        });

        // 25% of 20 tokens leaves 5 tokens, and the harness counts one token per word.
        const result = await harness.checkWorldInfo([], 20, true, harness.defaultGlobalScanData, { characterId: 1, userName: 'Conversation User' });

        expect(result.worldInfoBefore).toBe('High priority lore.');
    });

    test('returns no entries when the target has no books', async () => {
        const harness = await createHarness({ selectedWorldInfo: [] });
        harness.state.characters.push({ name: 'Cora', avatar: 'cora.png', data: { extensions: {} } });

        const result = await harness.checkWorldInfo(['Conversation User: The moon and tea.'], 4000, true, harness.defaultGlobalScanData, { characterId: 2, userName: 'Conversation User' });

        expect(result).toEqual({ worldInfoBefore: '', worldInfoAfter: '', WIDepthEntries: [], EMEntries: [], ANBeforeEntries: [], ANAfterEntries: [], outletEntries: {}, allActivatedEntries: new Set() });
        expect(harness.loadedBooks).toEqual([]);
    });

    test('scans a linked book once when it is also the target override', async () => {
        const harness = await createHarness({ selectedWorldInfo: [] });

        const result = await harness.checkWorldInfo(['Conversation User: The moon.'], 4000, true, harness.defaultGlobalScanData, { ...BRAM_TARGET, chatWorld: 'Bram Book', personaWorld: '' });

        expect(harness.loadedBooks).toEqual(['Bram Book']);
        expect(result.worldInfoBefore).toBe('Bram constant for Bram and Conversation User.');
        expect(result.worldInfoAfter).toBe('Bram sees the moon.');
    });
});

describe('the SillyBunny Lexicon through a scan target', () => {
    const lexicon = JSON.parse(readFileSync(new URL('../default/content/SillyBunny Lexicon.json', import.meta.url), 'utf8'));
    const entries = Object.values(lexicon.entries);
    const overview = entries.find(candidate => candidate.constant);
    const ASSISTANT_ID = 2;
    const OTHER_ASSISTANT_ID = 3;
    const targetOf = characterId => Object.freeze({ characterId, chatWorld: '', personaWorld: '', userName: 'Conversation User' });
    const target = targetOf(ASSISTANT_ID);

    /** Two speakers whose cards link the lexicon, scanned with no other book in play. */
    async function createLexiconHarness({ linked = true } = {}) {
        const harness = await createHarness({
            books: { 'SillyBunny Lexicon': lexicon },
            selectedWorldInfo: [],
            charLore: [],
        });
        const extensions = linked ? { world: 'SillyBunny Lexicon' } : {};
        harness.state.characters.push({ name: 'Assistant Reisen', avatar: 'default_AssistantReisen.png', data: { extensions } });
        harness.state.characters.push({ name: 'Assistant Tewi', avatar: 'default_AssistantTewi.png', data: { extensions } });
        return harness;
    }

    const scan = (harness, message, speaker = target) => harness.checkWorldInfo([`Conversation User: ${message}`], 100000, true, harness.defaultGlobalScanData, speaker);
    const linesOf = result => result.worldInfoBefore.split('\n');

    test('always gives the overview and nothing else to a message that no entry is keyed on', async () => {
        const harness = await createLexiconHarness();

        const result = await scan(harness, 'Good morning!');

        expect(harness.loadedBooks).toEqual(['SillyBunny Lexicon']);
        expect(result.worldInfoBefore).toBe(overview.content);
        expect(result.worldInfoAfter).toBe('');
    });

    test('brings in the entry that a question is keyed on, next to the overview', async () => {
        const harness = await createLexiconHarness();

        const result = await scan(harness, 'Where can I change the temperature?');

        expect(result.worldInfoBefore.split('\n')).toEqual(expect.arrayContaining([overview.content, entries.find(candidate => candidate.comment.startsWith('A13 ')).content]));
        expect(result.worldInfoAfter).toBe('');
    });

    test('reaches every keyword entry by its own first key, and puts it where Conversation reads', async () => {
        const harness = await createLexiconHarness();
        const missed = [];

        for (const candidate of entries.filter(entry => !entry.constant)) {
            // An entry that leaves the first speaker's card out is asked by the other one.
            const excludesFirst = candidate.characterFilter?.isExclude && candidate.characterFilter.names?.includes('default_AssistantReisen');
            const result = await scan(harness, `Tell me about ${candidate.key[0]}`, excludesFirst ? targetOf(OTHER_ASSISTANT_ID) : target);
            const reachable = result.worldInfoBefore.split('\n').includes(candidate.content);
            const elsewhere = [result.worldInfoAfter, ...result.EMEntries.map(slot => slot.content), ...result.ANBeforeEntries, ...result.ANAfterEntries, ...result.WIDepthEntries.flatMap(slot => slot.entries)];
            if (!reachable || elsewhere.some(text => text !== '')) {
                missed.push(candidate.comment);
            }
        }

        expect(missed).toEqual([]);
    });

    test('gives each assistant the entry about the other one when she is named, and leaves out the entry about herself', async () => {
        const harness = await createLexiconHarness();
        const reisen = entries.find(candidate => candidate.comment.startsWith('A78 ')).content;
        const tewi = entries.find(candidate => candidate.comment.startsWith('A79 ')).content;

        const askedReisen = linesOf(await scan(harness, 'Reisen, is Tewi helping you today?', targetOf(ASSISTANT_ID)));
        const askedTewi = linesOf(await scan(harness, 'Tewi, is Reisen helping you today?', targetOf(OTHER_ASSISTANT_ID)));

        expect([askedReisen.includes(tewi), askedReisen.includes(reisen)]).toEqual([true, false]);
        expect([askedTewi.includes(reisen), askedTewi.includes(tewi)]).toEqual([true, false]);
    });

    test('gives a speaker whose card does not link the lexicon nothing from it', async () => {
        const harness = await createLexiconHarness({ linked: false });

        const result = await scan(harness, 'Where can I change the temperature?');

        expect(harness.loadedBooks).toEqual([]);
        expect(result.worldInfoBefore).toBe('');
    });
});

describe('the SillyBunny Lexicon under the shipped World Info settings', () => {
    const lexicon = JSON.parse(readFileSync(new URL('../default/content/SillyBunny Lexicon.json', import.meta.url), 'utf8'));
    const shipped = JSON.parse(readFileSync(new URL('../default/content/settings.json', import.meta.url), 'utf8')).world_info_settings;
    const preset = JSON.parse(readFileSync(new URL('../default/content/presets/openai/Default.json', import.meta.url), 'utf8'));
    const card = JSON.parse(readCardMetadata(readFileSync(new URL('../default/content/default_AssistantReisen.png', import.meta.url))));

    /** The prompt room that a new Chat Completion chat has once the reply room is taken out of the context size. */
    const PROMPT_ROOM = preset.openai_max_context - preset.openai_max_tokens;
    /** Far more than the budget needs, so that nothing is cut for lack of room. */
    const UNLIMITED = 1_000_000;
    const ASSISTANT_ID = 2;
    const UID = Object.fromEntries(Object.values(lexicon.entries).map(entry => [/^A\d+/.exec(entry.comment)[0], entry.uid]));

    /** Questions a new user asks, each with the entry that answers it. */
    const QUESTIONS = [
        ['How do I connect a model?', 'A28'],
        ['What\'s the difference between Roleplay and Conversation mode?', 'A43'],
        ['My replies keep getting cut off halfway. What can I do?', 'A71'],
        ['How do I back up my chats and characters?', 'A64'],
        ['What\'s a lorebook, and where do I edit one?', 'A10'],
        ['How do I delete a group conversation?', 'A50'],
        ['How do I stop my characters from messaging me first?', 'A87'],
        ['How do I move a conversation to my favorites?', 'A84'],
        ['How do I put a conversation in a folder?', 'A92'],
        ['Why does the New Group list only show 50 characters?', 'A54'],
        ['How do I insert an emoji in Conversation mode?', 'A90'],
        ['How can I see who reacted to my message?', 'A91'],
        ['Can I stop characters reacting to my messages?', 'A91'],
        ['Can I use my phone\'s own emoji instead of the ones Conversation draws?', 'A89'],
    ];

    /** Roleplay scans the greeting that the card opens the chat with, so a scan of a new chat includes it. */
    const greetingLine = `Assistant Reisen: ${card.data.first_mes.replace(/{{user}}/gi, 'Roleplay User').replace(/{{char}}/gi, 'Assistant Reisen')}`;

    /** The assistant's card is the active character and links the Lexicon, with the World Info settings a new install ships. */
    async function createShippedHarness({ recursive = shipped.world_info_recursive } = {}) {
        const harness = await createHarness({
            books: { 'SillyBunny Lexicon': lexicon },
            selectedWorldInfo: [],
            charLore: [],
            state: {
                this_chid: ASSISTANT_ID,
                name2: 'Assistant Reisen',
                chat_metadata: {},
                power_user: {},
                extensionPrompts: { note: { value: '', scan: true } },
            },
            settings: {
                world_info_depth: shipped.world_info_depth,
                world_info_budget: shipped.world_info_budget,
                world_info_budget_cap: shipped.world_info_budget_cap,
                world_info_recursive: recursive,
                world_info_case_sensitive: shipped.world_info_case_sensitive,
                world_info_match_whole_words: shipped.world_info_match_whole_words,
                world_info_character_strategy: shipped.world_info_character_strategy,
            },
            // Five characters to a token is the rate at which a scan of a new chat with Assistant Reisen holds the same six entries as the app.
            getTokenCountAsync: async text => Math.ceil(String(text).length / 5),
        });
        harness.state.characters.push({ name: 'Assistant Reisen', avatar: 'default_AssistantReisen.png', data: { extensions: { world: 'SillyBunny Lexicon' } } });
        return harness;
    }

    /** @returns {Promise<string[]>} Inventory ids of the entries that the scan activated. */
    async function activated(harness, lines, maxContext) {
        const result = await harness.checkWorldInfo(lines, maxContext, true, harness.defaultGlobalScanData);
        const ids = Object.fromEntries(Object.entries(UID).map(([id, uid]) => [uid, id]));
        return [...result.allActivatedEntries.values()].map(entry => ids[entry.uid]);
    }

    describe.each(QUESTIONS)('the question %j', (question, answer) => {
        const lines = [`Roleplay User: ${question}`];

        test(`is keyed on ${answer}, whatever other entries bring in`, async () => {
            const harness = await createShippedHarness({ recursive: false });

            expect(await activated(harness, lines, UNLIMITED)).toContain(answer);
        });

        test(`gets ${answer} inside the budget of a new chat once other entries recurse`, async () => {
            const harness = await createShippedHarness();

            expect(shipped.world_info_recursive).toBe(true);
            expect(await activated(harness, lines, PROMPT_ROOM)).toContain(answer);
        });
    });

    describe('the entry about SillyBunny against SillyTavern', () => {
        const [connectQuestion] = QUESTIONS[0];

        test.each([PROMPT_ROOM, UNLIMITED])('is not brought in by the text of another entry when a new chat asks about connecting a model (room %i)', async (maxContext) => {
            const harness = await createShippedHarness();

            const ids = await activated(harness, [greetingLine, `Roleplay User: ${connectQuestion}`].reverse(), maxContext);

            expect(ids).toContain('A28');
            expect(ids).not.toContain('A76');
        });

        test('still answers a user who asks about the difference', async () => {
            const harness = await createShippedHarness();

            expect(await activated(harness, ['Roleplay User: What is SillyBunny vs SillyTavern?'], PROMPT_ROOM)).toContain('A76');
        });
    });

    describe('the entries about the assistants', () => {
        test('add only the entry asked about to the budget of a new chat, and none of the entries that their own text names', async () => {
            const baseline = await activated(await createShippedHarness(), ['Roleplay User: Good morning!'], PROMPT_ROOM);

            const ids = await activated(await createShippedHarness(), ['Roleplay User: Where is Tewi today?'], PROMPT_ROOM);

            expect(ids.filter(id => !baseline.includes(id))).toEqual(['A79']);
        });

        test('are not brought in by the text of another entry that names both assistants', async () => {
            const harness = await createShippedHarness();

            const ids = await activated(harness, ['Roleplay User: How do I choose a third assistant?'], UNLIMITED);

            expect(ids).toContain('A77');
            expect(ids.filter(id => ['A78', 'A79'].includes(id))).toEqual([]);
        });
    });
});
