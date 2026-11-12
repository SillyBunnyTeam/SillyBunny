import { describe, expect, test } from '@jest/globals';
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

const createHarness = ({ books = createBooks() } = {}) => createScanHarness({ books });

const CHAT = ['Aster: Good evening.', 'Roleplay User: We watched the moon and drank tea.'];

describe('World Info scan of the active chat', () => {
    test('keeps the Roleplay scan output, side effects and events', async () => {
        const context = createHarness();
        context.WorldInfoBuffer.externalActivations.set('Aster Book.4', { ...createBooks()['Aster Book'].entries[4], world: 'Aster Book' });

        const result = await context.checkWorldInfo([...CHAT].reverse(), 4000, false, context.defaultGlobalScanData);

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
        expect(context.setExtensionPrompt).toHaveBeenCalledWith('note', 'Tea before the note.\nRoleplay note mentions a star.\nTea after the note.', 1, 4, true, 0);
        expect(context.WorldInfoBuffer.externalActivations.size).toBe(0);
        expect(Object.keys(context.chat_metadata.timedWorldInfo.sticky)).toEqual(['Aster Book.5']);
        expect(context.eventSource.emit.mock.calls.map(([name]) => name)).toEqual([event_types.WORLDINFO_ENTRIES_LOADED, event_types.WORLDINFO_SCAN_DONE]);
        expect(context.loadWorldInfo.mock.calls.map(([name]) => name).sort()).toEqual(['Aster Book', 'Aster Extra', 'Chat Book', 'Global Book', 'Persona Book', 'Shared Book']);
    });

    test('scans entries keyed on the user name at their depth', async () => {
        const context = createHarness();

        const result = await context.checkWorldInfo(['Aster: Hello, Roleplay User.'], 4000, true, context.defaultGlobalScanData);

        expect(result.WIDepthEntries).toEqual([{ depth: 2, entries: ['Keyed on the user name.'], role: 1 }]);
        expect(context.chat_metadata.timedWorldInfo).toEqual({ sticky: {}, cooldown: {} });
    });
});

const BRAM_TARGET = Object.freeze({ characterId: 1, chatWorld: 'Bram Override', personaWorld: 'Bram Persona', userName: 'Conversation User' });

describe('World Info scan of a scan target', () => {
    test('reads the target character, global, override and persona books with the target names', async () => {
        const context = createHarness();

        const result = await context.checkWorldInfo(['Conversation User: The moon over tea, Bram.'], 4000, true, context.defaultGlobalScanData, BRAM_TARGET);

        expect(context.loadWorldInfo.mock.calls.map(([name]) => name).sort()).toEqual(['Bram Book', 'Bram Override', 'Bram Persona', 'Global Book', 'Shared Book']);
        expect(result.worldInfoBefore.split('\n')).toEqual(['Conversation persona lore.', 'Only for Bram.', 'Bram constant for Bram and Conversation User.']);
        expect(result.worldInfoAfter.split('\n')).toEqual(['Override tea lore.', 'Keyed on the character name.', 'Bram sees the moon.']);
        expect(result.EMEntries).toEqual([{ position: 0, content: 'Shared example.' }]);
        expect(result.ANBeforeEntries).toEqual([]);
        expect(context.getRegexedString).toHaveBeenCalledWith('Bram sees the moon.', 5, expect.objectContaining({ characterOverride: 'Bram' }));
    });

    test('leaves the active chat prompts, timed effects, forced activations and listeners alone', async () => {
        const books = createBooks();
        books['Bram Book'].entries[2].sticky = 3;
        const context = createHarness({ books });
        const forcedEntry = { ...books['Global Book'].entries[2], world: 'Global Book' };
        context.WorldInfoBuffer.externalActivations.set('Global Book.2', forcedEntry);
        context.chat_metadata.timedWorldInfo = { sticky: {}, cooldown: {} };

        const result = await context.checkWorldInfo(['Conversation User: The moon is out.'], 4000, false, context.defaultGlobalScanData, BRAM_TARGET);

        expect(result.worldInfoAfter).toContain('Bram sees the moon.');
        expect(result.worldInfoBefore).not.toContain('Global star lore.');
        expect(context.setExtensionPrompt).not.toHaveBeenCalled();
        expect(context.eventSource.emit).not.toHaveBeenCalled();
        expect([...context.WorldInfoBuffer.externalActivations.values()]).toEqual([forcedEntry]);
        expect(context.chat_metadata.timedWorldInfo).toEqual({ sticky: {}, cooldown: {} });
    });

    test('stops adding entries at the World Info budget', async () => {
        const context = createHarness({
            books: {
                'Bram Book': {
                    entries: {
                        1: entry(1, { constant: true, order: 30, content: 'Low priority lore.' }),
                        2: entry(2, { constant: true, order: 90, content: 'High priority lore.' }),
                    },
                },
            },
        });
        context.selected_world_info = [];

        // 25% of 20 tokens leaves 5 tokens, and the harness counts one token per word.
        const result = await context.checkWorldInfo([], 20, true, context.defaultGlobalScanData, { characterId: 1, userName: 'Conversation User' });

        expect(result.worldInfoBefore).toBe('High priority lore.');
    });

    test('returns no entries when the target has no books', async () => {
        const context = createHarness();
        context.characters.push({ name: 'Cora', avatar: 'cora.png', data: { extensions: {} } });
        context.selected_world_info = [];

        const result = await context.checkWorldInfo(['Conversation User: The moon and tea.'], 4000, true, context.defaultGlobalScanData, { characterId: 2, userName: 'Conversation User' });

        expect(result).toEqual({ worldInfoBefore: '', worldInfoAfter: '', WIDepthEntries: [], EMEntries: [], ANBeforeEntries: [], ANAfterEntries: [], outletEntries: {}, allActivatedEntries: new Set() });
        expect(context.loadWorldInfo).not.toHaveBeenCalled();
    });

    test('scans a linked book once when it is also the target override', async () => {
        const context = createHarness();
        context.selected_world_info = [];

        const result = await context.checkWorldInfo(['Conversation User: The moon.'], 4000, true, context.defaultGlobalScanData, { ...BRAM_TARGET, chatWorld: 'Bram Book', personaWorld: '' });

        expect(context.loadWorldInfo.mock.calls.map(([name]) => name)).toEqual(['Bram Book']);
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
    function createLexiconHarness({ linked = true } = {}) {
        const context = createHarness({ books: { 'SillyBunny Lexicon': lexicon } });
        const extensions = linked ? { world: 'SillyBunny Lexicon' } : {};
        context.characters.push({ name: 'Assistant Reisen', avatar: 'default_AssistantReisen.png', data: { extensions } });
        context.characters.push({ name: 'Assistant Tewi', avatar: 'default_AssistantTewi.png', data: { extensions } });
        context.selected_world_info = [];
        context.world_info = { charLore: [] };
        return context;
    }

    const scan = (context, message, speaker = target) => context.checkWorldInfo([`Conversation User: ${message}`], 100000, true, context.defaultGlobalScanData, speaker);
    const linesOf = result => result.worldInfoBefore.split('\n');

    test('always gives the overview and nothing else to a message that no entry is keyed on', async () => {
        const context = createLexiconHarness();

        const result = await scan(context, 'Good morning!');

        expect(context.loadWorldInfo.mock.calls.map(([name]) => name)).toEqual(['SillyBunny Lexicon']);
        expect(result.worldInfoBefore).toBe(overview.content);
        expect(result.worldInfoAfter).toBe('');
    });

    test('brings in the entry that a question is keyed on, next to the overview', async () => {
        const context = createLexiconHarness();

        const result = await scan(context, 'Where can I change the temperature?');

        expect(result.worldInfoBefore.split('\n')).toEqual(expect.arrayContaining([overview.content, entries.find(candidate => candidate.comment.startsWith('A13 ')).content]));
        expect(result.worldInfoAfter).toBe('');
    });

    test('reaches every keyword entry by its own first key, and puts it where Conversation reads', async () => {
        const context = createLexiconHarness();
        const missed = [];

        for (const candidate of entries.filter(entry => !entry.constant)) {
            // An entry that leaves the first speaker's card out is asked by the other one.
            const excludesFirst = candidate.characterFilter?.isExclude && candidate.characterFilter.names?.includes('default_AssistantReisen');
            const result = await scan(context, `Tell me about ${candidate.key[0]}`, excludesFirst ? targetOf(OTHER_ASSISTANT_ID) : target);
            const reachable = result.worldInfoBefore.split('\n').includes(candidate.content);
            const elsewhere = [result.worldInfoAfter, ...result.EMEntries.map(slot => slot.content), ...result.ANBeforeEntries, ...result.ANAfterEntries, ...result.WIDepthEntries.flatMap(slot => slot.entries)];
            if (!reachable || elsewhere.some(text => text !== '')) {
                missed.push(candidate.comment);
            }
        }

        expect(missed).toEqual([]);
    });

    test('gives each assistant the entry about the other one when she is named, and leaves out the entry about herself', async () => {
        const context = createLexiconHarness();
        const reisen = entries.find(candidate => candidate.comment.startsWith('A78 ')).content;
        const tewi = entries.find(candidate => candidate.comment.startsWith('A79 ')).content;

        const askedReisen = linesOf(await scan(context, 'Reisen, is Tewi helping you today?', targetOf(ASSISTANT_ID)));
        const askedTewi = linesOf(await scan(context, 'Tewi, is Reisen helping you today?', targetOf(OTHER_ASSISTANT_ID)));

        expect([askedReisen.includes(tewi), askedReisen.includes(reisen)]).toEqual([true, false]);
        expect([askedTewi.includes(reisen), askedTewi.includes(tewi)]).toEqual([true, false]);
    });

    test('gives a speaker whose card does not link the lexicon nothing from it', async () => {
        const context = createLexiconHarness({ linked: false });

        const result = await scan(context, 'Where can I change the temperature?');

        expect(context.loadWorldInfo).not.toHaveBeenCalled();
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
    ];

    /** Roleplay scans the greeting that the card opens the chat with, so a scan of a new chat includes it. */
    const greetingLine = `Assistant Reisen: ${card.data.first_mes.replace(/{{user}}/gi, 'Roleplay User').replace(/{{char}}/gi, 'Assistant Reisen')}`;

    /** The assistant's card is the active character and links the Lexicon, with the World Info settings a new install ships. */
    function createShippedHarness({ recursive = shipped.world_info_recursive } = {}) {
        const context = createHarness({ books: { 'SillyBunny Lexicon': lexicon } });
        context.characters.push({ name: 'Assistant Reisen', avatar: 'default_AssistantReisen.png', data: { extensions: { world: 'SillyBunny Lexicon' } } });
        Object.assign(context, {
            this_chid: ASSISTANT_ID,
            name2: 'Assistant Reisen',
            selected_world_info: [],
            world_info: { charLore: [] },
            chat_metadata: {},
            extensionPrompts: { note: { value: '', scan: true } },
            world_info_depth: shipped.world_info_depth,
            world_info_budget: shipped.world_info_budget,
            world_info_budget_cap: shipped.world_info_budget_cap,
            world_info_recursive: recursive,
            world_info_case_sensitive: shipped.world_info_case_sensitive,
            world_info_match_whole_words: shipped.world_info_match_whole_words,
            world_info_character_strategy: shipped.world_info_character_strategy,
            // Five characters to a token is the rate at which a scan of a new chat with Assistant Reisen holds the same six entries as the app.
            getTokenCountAsync: async text => Math.ceil(String(text).length / 5),
        });
        return context;
    }

    /** @returns {Promise<string[]>} Inventory ids of the entries that the scan activated. */
    async function activated(context, lines, maxContext) {
        const result = await context.checkWorldInfo(lines, maxContext, true, context.defaultGlobalScanData);
        const ids = Object.fromEntries(Object.entries(UID).map(([id, uid]) => [uid, id]));
        return [...result.allActivatedEntries.values()].map(entry => ids[entry.uid]);
    }

    describe.each(QUESTIONS)('the question %j', (question, answer) => {
        const lines = [`Roleplay User: ${question}`];

        test(`is keyed on ${answer}, whatever other entries bring in`, async () => {
            const context = createShippedHarness({ recursive: false });

            expect(await activated(context, lines, UNLIMITED)).toContain(answer);
        });

        test(`gets ${answer} inside the budget of a new chat once other entries recurse`, async () => {
            const context = createShippedHarness();

            expect(shipped.world_info_recursive).toBe(true);
            expect(await activated(context, lines, PROMPT_ROOM)).toContain(answer);
        });
    });

    describe('the entry about SillyBunny against SillyTavern', () => {
        const [connectQuestion] = QUESTIONS[0];

        test.each([PROMPT_ROOM, UNLIMITED])('is not brought in by the text of another entry when a new chat asks about connecting a model (room %i)', async (maxContext) => {
            const context = createShippedHarness();

            const ids = await activated(context, [greetingLine, `Roleplay User: ${connectQuestion}`].reverse(), maxContext);

            expect(ids).toContain('A28');
            expect(ids).not.toContain('A76');
        });

        test('still answers a user who asks about the difference', async () => {
            const context = createShippedHarness();

            expect(await activated(context, ['Roleplay User: What is SillyBunny vs SillyTavern?'], PROMPT_ROOM)).toContain('A76');
        });
    });

    describe('the entries about the assistants', () => {
        test('add only the entry asked about to the budget of a new chat, and none of the entries that their own text names', async () => {
            const baseline = await activated(createShippedHarness(), ['Roleplay User: Good morning!'], PROMPT_ROOM);

            const ids = await activated(createShippedHarness(), ['Roleplay User: Where is Tewi today?'], PROMPT_ROOM);

            expect(ids.filter(id => !baseline.includes(id))).toEqual(['A79']);
        });

        test('are not brought in by the text of another entry that names both assistants', async () => {
            const context = createShippedHarness();

            const ids = await activated(context, ['Roleplay User: How do I choose a third assistant?'], UNLIMITED);

            expect(ids).toContain('A77');
            expect(ids.filter(id => ['A78', 'A79'].includes(id))).toEqual([]);
        });
    });
});
