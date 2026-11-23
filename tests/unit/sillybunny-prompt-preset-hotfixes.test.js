/**
 * @jest-environment jsdom
 */

import fs from 'node:fs';
import path from 'node:path';
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const REPO_ROOT = path.resolve(process.cwd(), '..');

function readRepoFile(relativePath) {
    return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

describe('Slice 1D: preset autosave non-edit key filtering and baseline caching', () => {
    let eventHandlers;
    let docListeners;
    let addEventListenerSpy;
    let getChatCompletionPresetMock;
    let initializePresetAutosave;
    let originalFetch;

    beforeEach(async () => {
        jest.resetModules();
        jest.useFakeTimers();
        document.body.innerHTML = `
            <div data-sb-panel="editor">
                <textarea id="prompt_input"></textarea>
            </div>
        `;
        eventHandlers = new Map();
        docListeners = new Map();
        const originalAdd = document.addEventListener.bind(document);
        addEventListenerSpy = jest.spyOn(document, 'addEventListener').mockImplementation((type, handler, options) => {
            const list = docListeners.get(type) ?? [];
            list.push(handler);
            docListeners.set(type, list);
            return originalAdd(type, handler, options);
        });
        getChatCompletionPresetMock = jest.fn(() => ({ temperature: 1, prompts: [{ identifier: 'main', content: 'hello' }] }));
        global.$ = jest.fn(() => ({ on: jest.fn(), val: jest.fn(), prop: jest.fn(), attr: jest.fn() }));
        originalFetch = global.fetch;
        global.fetch = jest.fn(async () => ({ ok: true, json: async () => [] }));

        jest.unstable_mockModule('../../public/script.js', () => ({
            eventSource: {
                on: (type, handler) => {
                    const list = eventHandlers.get(type) ?? [];
                    list.push(handler);
                    eventHandlers.set(type, list);
                },
            },
            event_types: {
                OAI_PRESET_CHANGED_BEFORE: 'OAI_PRESET_CHANGED_BEFORE',
                CONNECTION_PROFILE_LOADED: 'CONNECTION_PROFILE_LOADED',
                PRESET_CHANGED: 'PRESET_CHANGED',
            },
            getRequestHeaders: () => ({}),
            main_api: 'openai',
            refreshCsrfToken: jest.fn(async () => {}),
            saveSettingsDebounced: jest.fn(),
        }));
        jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: s => String(s) }));
        jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
            getChatCompletionPreset: getChatCompletionPresetMock,
            oai_settings: { preset_settings_openai: 'MyCustomPreset' },
            openai_setting_names: { MyCustomPreset: 0 },
            openai_settings: [{ temperature: 1 }],
        }));
        jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
            power_user: { sb_preset_autosave: true, instruct: { enabled: false } },
        }));
        jest.unstable_mockModule('../../public/scripts/preset-manager.js', () => ({
            getPresetManager: (kind) => ({
                getSelectedPreset: () => 'MyCustomPreset',
                getSelectedPresetName: () => (kind === 'openai' ? 'MyCustomPreset' : ''),
                getPresetSettings: () => ({}),
                isDefaultPreset: () => false,
                savePreset: jest.fn(async () => {}),
            }),
            refreshPresetDirtyGuards: jest.fn(),
        }));

        ({ initializePresetAutosave } = await import('../../public/scripts/sillybunny-preset-autosave.js'));
        initializePresetAutosave();
        await Promise.resolve();
    });

    afterEach(() => {
        jest.useRealTimers();
        addEventListenerSpy.mockRestore();
        global.fetch = originalFetch;
        delete global.$;
    });

    function dispatchTrustedKey(target, key) {
        const fakeEvent = { type: 'keydown', key, isTrusted: true, target };
        for (const handler of docListeners.get('keydown') ?? []) {
            handler(fakeEvent);
        }
    }

    test('ignores navigation and modifier keys without reading preset payloads', () => {
        const textarea = document.getElementById('prompt_input');
        for (const key of ['Tab', 'Shift', 'Control', 'Alt', 'ArrowDown', 'Escape', 'F5']) {
            dispatchTrustedKey(textarea, key);
        }
        expect(getChatCompletionPresetMock).not.toHaveBeenCalled();
    });

    test('reuses cached preset baseline across flushes and clears it on preset switches', () => {
        const textarea = document.getElementById('prompt_input');

        dispatchTrustedKey(textarea, 'a');
        expect(getChatCompletionPresetMock).toHaveBeenCalledTimes(1);

        // Flush compares payload once and updates the cached baseline.
        jest.advanceTimersByTime(1100);
        expect(getChatCompletionPresetMock).toHaveBeenCalledTimes(2);

        // Next edit reuses cached baseline instead of serializing again on keydown.
        dispatchTrustedKey(textarea, 'b');
        expect(getChatCompletionPresetMock).toHaveBeenCalledTimes(2);

        // Preset switch invalidates cached baseline.
        for (const handler of eventHandlers.get('OAI_PRESET_CHANGED_BEFORE') ?? []) {
            handler({ presetNameBefore: 'MyCustomPreset' });
        }
        expect(getChatCompletionPresetMock).toHaveBeenCalledTimes(3);

        dispatchTrustedKey(textarea, 'c');
        expect(getChatCompletionPresetMock).toHaveBeenCalledTimes(4);
    });
});

describe('Slice 1D: PromptManager deferred hidden renders and owned-tab DOM skip', () => {
    let PromptManager;
    let renderTemplateAsyncMock;
    let sortableMock;
    let originalMatchMedia;

    beforeEach(async () => {
        jest.resetModules();
        originalMatchMedia = window.matchMedia;
        window.matchMedia = jest.fn(() => ({
            matches: false,
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
        }));
        renderTemplateAsyncMock = jest.fn(async (name) => {
            if (name === 'promptManagerHeader') {
                return '<div id="completion_prompt_manager_drag_lock"></div><ul id="completion_prompt_manager_list"></ul><div class="completion_prompt_manager_footer_slot"></div>';
            }
            return '<div class="completion_prompt_manager_footer"><select id="completion_prompt_manager_footer_append_prompt"></select><button class="menu_button"></button><button class="caution"></button><button id="prompt-manager-import"></button><button id="prompt-manager-export"></button><button class="menu_button"></button></div>';
        });
        sortableMock = jest.fn();
        global.$ = jest.fn(() => ({
            sortable: sortableMock,
            on: jest.fn(),
            off: jest.fn(),
            val: jest.fn(),
            prop: jest.fn(),
            find: jest.fn(() => ({ length: 0 })),
        }));

        jest.unstable_mockModule('../../public/lib.js', () => ({
            DOMPurify: { sanitize: s => s },
        }));
        jest.unstable_mockModule('../../public/script.js', () => ({
            event_types: { CHAT_COMPLETION_PROMPT_READY: 'CHAT_COMPLETION_PROMPT_READY' },
            eventSource: { on: jest.fn(), emit: jest.fn() },
            is_send_press: false,
            main_api: 'openai',
            saveSettingsDebounced: jest.fn(),
            substituteParams: s => s,
        }));
        jest.unstable_mockModule('../../public/scripts/group-chats.js', () => ({ is_group_generating: false }));
        jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
            getCurrentOpenAIPresetPromptOrder: () => [],
            Message: class {},
            TokenHandler: class {},
        }));
        jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
            power_user: { prompt_manager_drag_locked: false },
        }));
        jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
            debounce: fn => fn,
            waitUntilCondition: async () => {},
            escapeHtml: s => String(s),
            uuidv4: () => 'uuid-1',
        }));
        jest.unstable_mockModule('../../public/scripts/constants.js', () => ({
            debounce_timeout: { quick: 0, relaxed: 0 },
        }));
        jest.unstable_mockModule('../../public/scripts/templates.js', () => ({
            renderTemplateAsync: renderTemplateAsyncMock,
        }));
        jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
            Popup: class {},
            POPUP_RESULT: { AFFIRMATIVE: 1 },
        }));
        jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: s => String(s) }));
        jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => ({ isMobile: () => false }));
        jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({
            accountStorage: { getItem: () => null, setItem: () => {} },
        }));
        jest.unstable_mockModule('../../public/scripts/prompt-token-counts.js', () => ({
            createCommentOnlyContentCheck: () => () => false,
            getPromptDisplayTokenCounts: () => new Map(),
            getPromptSourceTokenCounts: async () => new Map(),
            getRuntimePreparedPromptContent: () => '',
            mergePromptTokenCounts: () => new Map(),
        }));
        jest.unstable_mockModule('../../public/scripts/prompt-manager-marker-preview.js', () => ({
            getRenderedMarkerPrompt: () => '',
        }));
        jest.unstable_mockModule('../../public/scripts/prompt-manager-order.js', () => ({
            reorderPromptOrder: order => order,
        }));
        jest.unstable_mockModule('../../public/scripts/prompt-variable-cleanup.js', () => ({
            clearPromptSetVariables: () => {},
        }));
        jest.unstable_mockModule('../../public/scripts/in-chat-agent-inspection.js', () => ({
            RUNTIME_AGENTS_IDENTIFIER: 'runtimeAgents',
            resolveInChatAgentTokenUsage: () => 0,
        }));

        ({ PromptManager } = await import('../../public/scripts/PromptManager.js'));
    });

    afterEach(() => {
        window.matchMedia = originalMatchMedia;
        delete document.documentElement.dataset.sbSettingsOpen;
        delete global.$;
    });

    test('defers dry-run renders while the prompt surface is hidden and flushes when editor activates', async () => {
        document.body.innerHTML = `
            <div id="sb-settings-page" hidden>
                <div class="sb-shell-panel" data-sb-panel="editor">
                    <div class="sb-prompt-owned">
                        <div id="completion_prompt_manager"></div>
                    </div>
                </div>
            </div>
        `;
        const pm = new PromptManager();
        pm.configuration = {
            prefix: 'completion_',
            promptOrder: { strategy: 'global' },
            sortableDelay: 30,
        };
        pm.serviceSettings = { prompts: [{ identifier: 'main', name: 'Main', content: 'hi' }], prompt_order: [] };
        pm.containerElement = document.getElementById('completion_prompt_manager');
        pm.activeCharacter = { id: 1 };
        pm.tryGenerate = jest.fn(async () => {});
        pm.populateSourcePromptTokenCounts = jest.fn(async () => {});
        pm.getDisplayTokenUsage = () => 0;
        pm.getInChatAgentTokenUsage = () => 0;
        pm.bindDrawerPersistence = jest.fn();
        pm.bindDragLockButton = jest.fn();
        pm.restorePopupToOrigin = jest.fn();

        pm.render(true);
        await Promise.resolve();
        await Promise.resolve();

        expect(pm.pendingDeferredRender).toEqual({ afterTryGenerate: true });
        expect(pm.tryGenerate).not.toHaveBeenCalled();

        // Simulate openSettingsPage firing sb:shell-tab-activated before removing page.hidden.
        document.querySelector('.sb-shell-panel').classList.add('sb-shell-panel-active');
        document.dispatchEvent(new CustomEvent('sb:shell-tab-activated', { detail: { tabId: 'editor' } }));
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(pm.pendingDeferredRender).toBeNull();
        expect(pm.tryGenerate).toHaveBeenCalledTimes(1);
        expect(sortableMock).not.toHaveBeenCalled();
        expect(pm.listElement).not.toBeNull();
        expect(pm.listElement.children.length).toBe(0);

        // Second render on owned surface skips rebuilding header/footer templates.
        renderTemplateAsyncMock.mockClear();
        const secondResult = await pm.renderPromptManager(pm.renderRequestId);
        expect(secondResult).toBe(true);
        expect(renderTemplateAsyncMock).not.toHaveBeenCalled();

        // Owned tab skips hidden list items and sortable bindings.
        const listResult = await pm.renderPromptManagerListItems(pm.renderRequestId);
        expect(listResult).toBe(true);
        expect(pm.listElement.children.length).toBe(0);
        pm.makeDraggable();
        expect(sortableMock).not.toHaveBeenCalled();
    });

    test('reuses a single bound handler for injection position changes', () => {
        const pm = new PromptManager();
        expect(typeof pm.boundHandleInjectionPositionChange).toBe('function');

        const source = readRepoFile('public/scripts/PromptManager.js');
        expect(source).toContain('injectionPositionField.removeEventListener(\'change\', this.boundHandleInjectionPositionChange);');
        expect(source).toContain('injectionPositionField.addEventListener(\'change\', this.boundHandleInjectionPositionChange);');
    });
});

describe('Slice 1D: prompt editor indexing and OpenAI preset save batching', () => {
    test('sillybunny-prompt-editor indexes prompts and order without full-body JSON.stringify keys', () => {
        const source = readRepoFile('public/scripts/sillybunny-prompt-editor.js');
        expect(source).toContain('if (contentCounts.size > 2048)');
        expect(source).toContain('function ensureStateIndex()');
        expect(source).toContain('promptsById = new Map(');
        expect(source).toContain('orderedIdSet = new Set(');
        expect(source).toContain('promptManager?.flushDeferredRender?.({ force: true });');
        expect(source).not.toContain('JSON.stringify([state.scope, state.prompts');
        expect(source).not.toContain('JSON.stringify([prompt,');
    });

    test('openai.js indexes settingsToUpdate and suppresses intermediate debounced saves during preset switches', () => {
        const source = readRepoFile('public/scripts/openai.js');
        expect(source).toContain('const settingsToUpdateByKey = new Map(Object.values(settingsToUpdate).map(entry => [entry[1], entry]));');
        expect(source).toContain('let isApplyingOpenAiPreset = false;');
        expect(source).toContain('function scheduleOpenAiSettingsSave()');
        expect(source).toContain('isApplyingOpenAiPreset = true;');
        expect(source).toContain('isApplyingOpenAiPreset = false;');
        expect(source).toContain('cancelDebounce(saveSettingsDebounced);');
    });
});
