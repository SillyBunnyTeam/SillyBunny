import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const checkWorldInfo = jest.fn();
const getMaxPromptTokens = jest.fn(responseLength => 8000 - (responseLength ?? 1000));
const characters = [
    { name: 'Tewi', avatar: 'tewi.png' },
    {
        name: 'Reisen',
        avatar: 'reisen.png',
        description: 'Lunar rabbit.',
        personality: 'Earnest.',
        scenario: 'Eientei clinic.',
        data: { creator_notes: 'Creator notes.', extensions: { depth_prompt: { prompt: 'Depth note.' } } },
    },
];

await jest.unstable_mockModule('../public/script.js', () => ({
    characters,
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    getMaxPromptTokens,
}));
await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: { persona_descriptions: { 'persona-a.png': { description: 'Persona A description.', lorebook: 'Persona Book' } } },
}));
await jest.unstable_mockModule('../public/scripts/world-info.js', () => ({ checkWorldInfo, world_info_include_names: true }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({
    getConversationPersonaName: (personaId, fallback) => personaId === 'persona-a.png' ? 'Moon Fan' : fallback,
}));

const { buildConversationWorldInfoScanChat, getConversationWorldInfo } = await import('../public/scripts/sillybunny-conversation/world-info.js');

const EMPTY = { before: '', after: '', authorsNoteBefore: '', authorsNoteAfter: '', depth: [] };
const SCAN_RESULT = {
    worldInfoBefore: 'Before lore.',
    worldInfoAfter: 'After lore.',
    ANBeforeEntries: ['Note top one.', 'Note top two.'],
    ANAfterEntries: ['Note bottom.'],
    WIDepthEntries: [
        { depth: 0, role: 1, entries: ['User depth one.', 'User depth two.'] },
        { depth: 4, role: 2, entries: ['Assistant depth.'] },
        { depth: 2, role: 0, entries: ['System depth.'] },
    ],
    EMEntries: [{ position: 0, content: 'Example lore.' }],
    outletEntries: { outlet: ['Outlet lore.'] },
};

describe('Conversation World Info scan', () => {
    beforeEach(() => {
        checkWorldInfo.mockReset().mockResolvedValue(SCAN_RESULT);
        getMaxPromptTokens.mockClear();
    });

    test('scans the transcript messages newest first, with or without speaker names', () => {
        const messages = Array.from({ length: 40 }, (_, index) => ({ name: index % 2 ? 'Reisen' : 'Moon Fan', mes: `message ${index}` }));
        messages.push({ name: 'Moon Fan', mes: '   ' }, { name: '', mes: 'unnamed' });

        const lines = buildConversationWorldInfoScanChat(messages);

        expect(lines).toHaveLength(31);
        expect(lines.slice(0, 3)).toEqual(['unnamed', 'Reisen: message 39', 'Moon Fan: message 38']);
        expect(lines.at(-1)).toBe('Moon Fan: message 10');
        expect(buildConversationWorldInfoScanChat([{ name: 'Reisen', mes: 'Hi' }], false)).toEqual(['Hi']);
    });

    test('scans the speaker with the thread override, the persona book and the persona name', async () => {
        const messages = [{ name: 'Moon Fan', mes: 'Tell me about the lexicon.' }];

        await getConversationWorldInfo(messages, { lorebook_override: 'Override Book' }, { avatar: 'reisen.png', personaId: 'persona-a.png', responseLength: 300, trigger: 'regenerate' });

        expect(getMaxPromptTokens).toHaveBeenCalledWith(300);
        expect(checkWorldInfo).toHaveBeenCalledWith(['Moon Fan: Tell me about the lexicon.'], 7700, true, {
            personaDescription: 'Persona A description.',
            characterDescription: 'Lunar rabbit.',
            characterPersonality: 'Earnest.',
            characterDepthPrompt: 'Depth note.',
            scenario: 'Eientei clinic.',
            creatorNotes: 'Creator notes.',
            trigger: 'regenerate',
        }, {
            characterId: 1,
            chatWorld: 'Override Book',
            personaWorld: 'Persona Book',
            userName: 'Moon Fan',
        });
    });

    test('scans without an override or persona book when none is set', async () => {
        await getConversationWorldInfo([], {}, { avatar: 'tewi.png', personaId: 'persona-b.png' });

        expect(getMaxPromptTokens).toHaveBeenCalledWith(null);
        expect(checkWorldInfo.mock.calls[0][3]).toMatchObject({ characterDescription: '', personaDescription: '', trigger: 'normal' });
        expect(checkWorldInfo.mock.calls[0][4]).toEqual({ characterId: 0, chatWorld: '', personaWorld: '', userName: 'User' });
    });

    test('returns the entries for each Conversation prompt slot', async () => {
        const worldInfo = await getConversationWorldInfo([], {}, { avatar: 'reisen.png', personaId: 'persona-a.png' });

        expect(worldInfo).toEqual({
            before: 'Before lore.',
            after: 'After lore.',
            authorsNoteBefore: 'Note top one.\nNote top two.',
            authorsNoteAfter: 'Note bottom.',
            depth: [
                { depth: 0, role: 'user', content: 'User depth one.\nUser depth two.' },
                { depth: 4, role: 'assistant', content: 'Assistant depth.' },
                { depth: 2, role: 'system', content: 'System depth.' },
            ],
        });
    });

    test('does not scan when the switch is off or the character is gone', async () => {
        await expect(getConversationWorldInfo([], { lorebooks_enabled: false }, { avatar: 'reisen.png' })).resolves.toEqual(EMPTY);
        await expect(getConversationWorldInfo([], { lorebooks_enabled: true }, { avatar: 'deleted.png' })).resolves.toEqual(EMPTY);
        expect(checkWorldInfo).not.toHaveBeenCalled();
    });

    test('returns no entries when the scan fails', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        checkWorldInfo.mockRejectedValueOnce(new Error('book failed to load'));

        await expect(getConversationWorldInfo([], {}, { avatar: 'reisen.png', personaId: 'persona-a.png' })).resolves.toEqual(EMPTY);
        expect(warn).toHaveBeenCalledWith('Conversation Mode: World Info scan failed', expect.any(Error));
        warn.mockRestore();
    });
});
