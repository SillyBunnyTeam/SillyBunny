import { describe, expect, jest, test } from '@jest/globals';

async function importStore() {
    jest.resetModules();
    const extensionSettings = {};
    const saveSettingsDebounced = jest.fn();

    await jest.unstable_mockModule('../../public/script.js', () => ({
        getRequestHeaders: jest.fn(() => ({})),
        saveSettingsDebounced,
    }));
    await jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
        extension_settings: extensionSettings,
        getContext: jest.fn(() => ({ groupId: null })),
    }));
    await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
        regexFromString: jest.fn(value => new RegExp(String(value ?? ''))),
        uuidv4: jest.fn(() => 'test-uuid'),
    }));

    const store = await import('../../public/scripts/extensions/in-chat-agents/agent-store.js');
    return { store, extensionSettings, saveSettingsDebounced };
}

/** The settings as the server stores them: one JSON text. */
const throughTheServer = extensionSettings => JSON.parse(JSON.stringify(extensionSettings));

describe('patchAgentsExecutionMode setting', () => {
    test('a new install runs patch agents in sequence, and the append agents keep their own default', async () => {
        const { store } = await importStore();

        expect(store.getGlobalSettings().patchAgentsExecutionMode).toBe('sequential');
        expect(store.getGlobalSettings().appendAgentsExecutionMode).toBe('parallel');
    });

    test('saved settings from before the key existed give sequential and keep every other saved value', async () => {
        const { store } = await importStore();

        store.setGlobalSettings({ enabled: true, appendAgentsExecutionMode: 'parallel', companionExecutionMode: 'sequential', separateRecentChats: true });

        expect(store.getGlobalSettings()).toMatchObject({
            patchAgentsExecutionMode: 'sequential',
            appendAgentsExecutionMode: 'parallel',
            companionExecutionMode: 'sequential',
            separateRecentChats: true,
        });
    });

    test.each([[null], [undefined], [true], ['Parallel'], ['legacy']])('a saved value of %p means sequential', async value => {
        const { store } = await importStore();

        store.setGlobalSettings({ patchAgentsExecutionMode: value });

        expect(store.getGlobalSettings().patchAgentsExecutionMode).toBe('sequential');
    });

    test('Parallel survives a settings save and load, and Sequential after it', async () => {
        const first = await importStore();
        first.store.setGlobalSettings({ patchAgentsExecutionMode: 'parallel' });
        first.store.persistAgentGlobalSettings();
        expect(first.saveSettingsDebounced).toHaveBeenCalled();
        const saved = throughTheServer(first.extensionSettings);
        expect(saved.inChatAgents.globalSettings.patchAgentsExecutionMode).toBe('parallel');

        const reloaded = await importStore();
        reloaded.store.setGlobalSettings(saved.inChatAgents.globalSettings);
        expect(reloaded.store.getGlobalSettings().patchAgentsExecutionMode).toBe('parallel');

        reloaded.store.setGlobalSettings({ patchAgentsExecutionMode: 'sequential' });
        reloaded.store.persistAgentGlobalSettings();
        const second = await importStore();
        second.store.setGlobalSettings(throughTheServer(reloaded.extensionSettings).inChatAgents.globalSettings);
        expect(second.store.getGlobalSettings().patchAgentsExecutionMode).toBe('sequential');
    });

    test('changing it leaves Append Agents Execution alone, and the other way round', async () => {
        const { store } = await importStore();

        store.setGlobalSettings({ patchAgentsExecutionMode: 'parallel' });
        expect(store.getGlobalSettings().appendAgentsExecutionMode).toBe('parallel');
        store.setGlobalSettings({ appendAgentsExecutionMode: 'sequential' });
        expect(store.getGlobalSettings().patchAgentsExecutionMode).toBe('parallel');
        store.setGlobalSettings({ patchAgentsExecutionMode: 'sequential' });
        expect(store.getGlobalSettings().appendAgentsExecutionMode).toBe('sequential');
    });
});
