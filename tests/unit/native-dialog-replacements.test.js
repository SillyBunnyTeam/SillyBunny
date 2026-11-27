/** @jest-environment jsdom */
/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';

import { DEFAULT_TABS_DOM, importTabsModule } from '../util/tabs-harness.js';

const pub = rel => fileURLToPath(new URL(`../../public/${rel}`, import.meta.url));
const strings = (parts, ...values) => parts.reduce((result, part, index) => result + part + (values[index] ?? ''), '');

const activeCleanups = [];

afterEach(() => {
    while (activeCleanups.length) activeCleanups.pop()();
    document.body.replaceChildren();
    jest.restoreAllMocks();
});

async function flushAsync(ms = 25) {
    await new Promise(resolve => setTimeout(resolve, ms));
    await Promise.resolve();
}

function attachFakeFile(input, file) {
    Object.defineProperty(input, 'files', {
        configurable: true,
        value: [file],
    });
}

describe('native dialog replacements execute through real modules and shared Alert dialogs', () => {
    test('server admin reload, thumbnail cache clear, and branch switch wait for Alert responses', async () => {
        const jsonResponse = (data, status = 200) => ({
            ok: status >= 200 && status < 300,
            status,
            text: async () => JSON.stringify(data),
            json: async () => data,
        });
        const openAlert = jest.fn().mockResolvedValue('cancel');
        const serverRequests = [];
        const origFetch = globalThis.fetch;
        const mockFetch = jest.fn(async (url, options = {}) => {
            const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
            serverRequests.push({ url, body, signal: options.signal });
            if (url === '/api/server-admin/status') {
                return jsonResponse({
                    runtime: 'node',
                    installType: 'git',
                    configPath: 'config.yaml',
                    version: { pkgVersion: '1.0.0', gitBranch: 'staging' },
                    repository: {
                        supported: true,
                        isRepo: true,
                        branch: 'staging',
                        displayBranch: 'staging',
                        hasLocalChanges: true,
                        changedFiles: [{ path: 'config.yaml' }],
                    },
                });
            }
            if (url === '/api/server-admin/branches') {
                return jsonResponse({ branches: ['staging', 'release'] });
            }
            if (url === '/api/server-admin/config/get') {
                return jsonResponse({ path: 'config.yaml', content: 'port: 8000\n', lastModifiedMs: 1 });
            }
            if (url === '/api/server-admin/config/thumbnail-settings/get') {
                return jsonResponse({
                    enabled: true,
                    format: 'png',
                    quality: 100,
                    dimensions: { bg: [240, 135], avatar: [864, 1280], persona: [864, 1280] },
                    mobile: { enabled: false, format: 'jpg', quality: 85, dimensions: { bg: [120, 68], avatar: [300, 444], persona: [300, 444] } },
                    lastModifiedMs: 1,
                });
            }
            if (url === '/api/server-admin/thumbnails/clear-cache') {
                return jsonResponse({ message: 'cleared' });
            }
            if (url === '/api/server-admin/switch-branch') {
                return jsonResponse({ message: 'switched' });
            }
            return jsonResponse({});
        });
        globalThis.fetch = mockFetch;
        window.fetch = mockFetch;
        activeCleanups.push(() => {
            globalThis.fetch = origFetch;
            window.fetch = origFetch;
        });

        window.toastr = { info: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() };
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
        activeCleanups.push(() => consoleError.mockRestore());

        jest.resetModules();
        await jest.unstable_mockModule(pub('lib.js'), () => ({
            yaml: {
                parse: () => ({}),
                parseDocument: () => ({ errors: [], get: () => false }),
            },
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/dialog.js'), () => ({ openAlert }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/list-shell.js'), () => ({ loadListEditorStyles: jest.fn(async () => {}) }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/picker.js'), () => ({ closePicker: jest.fn(), isPickerOpen: () => false, openPicker: jest.fn() }));
        await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({ t: strings, translate: text => text }));

        const { createServerTools } = await import('../../public/scripts/sillybunny-server-tools.js');
        const tools = createServerTools({
            createElement(tag, { className = '', id = '', text = '', attrs = {} } = {}) {
                const el = document.createElement(tag);
                if (className) el.className = className;
                if (id) el.id = id;
                if (text) el.textContent = text;
                for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
                return el;
            },
            createShellPanel({ id }) {
                const panel = document.createElement('section');
                panel.id = `sb-panel-${id}`;
                const scroller = document.createElement('div');
                panel.appendChild(scroller);
                return { panel, scroller };
            },
            hasServerReturnedAfterRestart: () => true,
            isShellOpen: () => true,
            isShellTabOpen: () => true,
            setButtonDisabled: (btn, disabled) => {
                if (btn instanceof HTMLButtonElement) btn.disabled = Boolean(disabled);
                else btn?.setDisabled?.(Boolean(disabled));
            },
            setServerAdminMessage: (el, text) => { if (el) el.textContent = text; },
            setServerAdminPill: (el, text) => { if (el) el.textContent = text; },
            wait: async () => {},
            waitForAuthorizedRequestHeaders: async () => ({ 'Content-Type': 'application/json' }),
        });

        const serverPanel = tools.buildServerAdminPanel();
        document.body.appendChild(serverPanel.panel);
        serverPanel.onActivate();
        await flushAsync(40);

        const findButtonByLabel = (root, label) => [...root.querySelectorAll('button')]
            .find(button => button.textContent.trim() === label) ?? null;
        const editor = serverPanel.panel.querySelector('textarea.sb-server-config-editor');
        const reloadBtn = findButtonByLabel(serverPanel.panel, 'Reload File');
        const thumbClearBtn = findButtonByLabel(serverPanel.panel, 'Clear Cache Only');
        const branchSelect = serverPanel.panel.querySelector('#sb-branch-select');

        expect(editor).not.toBeNull();
        expect(reloadBtn).not.toBeNull();
        expect(thumbClearBtn).not.toBeNull();
        expect(branchSelect).not.toBeNull();

        // 1. Dirty config reload waits for destructive Alert confirmation.
        editor.value = 'port: 9000\n';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        serverRequests.length = 0;

        openAlert.mockResolvedValueOnce('cancel');
        reloadBtn.click();
        await flushAsync();
        expect(openAlert).toHaveBeenLastCalledWith(expect.objectContaining({
            heading: 'Discard your unsaved config edits and reload config.yaml from disk?',
            responses: [
                { id: 'cancel', label: 'Cancel' },
                { id: 'discard', label: 'Discard', appearance: 'destructive' },
            ],
        }));
        expect(serverRequests.some(req => req.url === '/api/server-admin/config/get')).toBe(false);

        openAlert.mockResolvedValueOnce('discard');
        reloadBtn.click();
        await flushAsync();
        expect(serverRequests.some(req => req.url === '/api/server-admin/config/get')).toBe(true);
        expect(editor.value).toBe('port: 8000\n');

        // 2. Thumbnail cache clear waits for Alert confirmation.
        serverRequests.length = 0;
        openAlert.mockResolvedValueOnce('cancel');
        thumbClearBtn.click();
        await flushAsync();
        expect(serverRequests.some(req => req.url === '/api/server-admin/thumbnails/clear-cache')).toBe(false);

        openAlert.mockResolvedValueOnce('clear');
        thumbClearBtn.click();
        await flushAsync();
        expect(serverRequests.some(req => req.url === '/api/server-admin/thumbnails/clear-cache')).toBe(true);
        expect(openAlert).toHaveBeenLastCalledWith(expect.objectContaining({
            heading: 'Clear cached thumbnails for this user?',
            body: 'They will be rebuilt as images are loaded',
            responses: [
                { id: 'cancel', label: 'Cancel' },
                { id: 'clear', label: 'Clear Cache', appearance: 'suggested' },
            ],
            defaultResponse: 'clear',
        }));

        // 3. Branch switch resets select on Cancel and calls switch-branch with autoStash on Switch.
        serverRequests.length = 0;
        openAlert.mockResolvedValueOnce('cancel');
        branchSelect.value = 'release';
        branchSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await flushAsync();
        expect(branchSelect.value).toBe('staging');
        expect(serverRequests.some(req => req.url === '/api/server-admin/switch-branch')).toBe(false);
        expect(openAlert).toHaveBeenLastCalledWith(expect.objectContaining({
            heading: 'You have local changes',
            body: expect.stringContaining('auto-stash your changes and switch to "release"?'),
            defaultResponse: null,
        }));

        openAlert.mockResolvedValueOnce('switch');
        branchSelect.value = 'release';
        branchSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await flushAsync();
        expect(serverRequests).toContainEqual(expect.objectContaining({
            url: '/api/server-admin/switch-branch',
            body: { branch: 'release', autoStash: true },
            signal: expect.any(AbortSignal),
        }));
    });

    test('cookie/cache clear and SillyTavern folder, extension sync, and ZIP import flows gate requests behind shared Alerts', async () => {
        const jsonResponse = (data, status = 200) => ({
            ok: status >= 200 && status < 300,
            status,
            text: async () => JSON.stringify(data),
            json: async () => data,
        });
        const openAlert = jest.fn().mockResolvedValue('cancel');
        const clearFrontendCache = jest.fn(async () => true);
        const requests = [];
        const origFetch = globalThis.fetch;
        const mockFetch = jest.fn(async (url, options = {}) => {
            requests.push({ url, options });
            if (url === '/api/users/import-sillytavern/extensions') {
                return jsonResponse({ warningCount: 0, failedCount: 0, gitMetadataSkippedCount: 0, message: 'synced' });
            }
            if (url === '/api/users/import-sillytavern/folder' || url === '/api/users/import-sillytavern/zip') {
                return jsonResponse({ error: 'stopped-after-post' }, 400);
            }
            return jsonResponse({ success: true, expirationAttempts: 0 });
        });
        globalThis.fetch = mockFetch;
        window.fetch = mockFetch;
        activeCleanups.push(() => {
            globalThis.fetch = origFetch;
            window.fetch = origFetch;
        });

        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
        const consoleInfo = jest.spyOn(console, 'info').mockImplementation(() => {});
        activeCleanups.push(() => {
            consoleError.mockRestore();
            consoleInfo.mockRestore();
        });

        window.SillyBunnyClearFrontendCache = clearFrontendCache;
        activeCleanups.push(() => { delete window.SillyBunnyClearFrontendCache; });

        const loaded = await importTabsModule({
            keepReal: ['scripts/sillybunny-data-security.js'],
            context: {
                getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-token' }),
            },
            dom: DEFAULT_TABS_DOM.replace(
                '<div id="user-settings-utility-actions"></div>',
                '<div id="user-settings-utility-actions"><button id="clear_cookies_cache_button" type="button">Clear Cookies &amp; Cache</button></div>',
            ),
            mocks: {
                'scripts/csrf-token-refresh.js': {
                    fetchWithCsrfRetry: jest.fn(async (url, initOrFn) => mockFetch(url, typeof initOrFn === 'function' ? await initOrFn() : initOrFn)),
                },
                'scripts/sillybunny-editor/dialog.js': base => ({ ...base, openAlert }),
                'scripts/sillybunny-server-tools.js': {
                    createServerTools: jest.fn(() => ({
                        buildServerAdminPanel: jest.fn(async () => {
                            const panel = document.createElement('section');
                            const searchRoot = document.createElement('div');
                            panel.appendChild(searchRoot);
                            return { id: 'server', panel, button: null, searchRoot, onActivate: jest.fn() };
                        }),
                        buildConsoleLogsPanel: jest.fn(async () => ({
                            id: 'console-logs',
                            panel: document.createElement('section'),
                            button: null,
                            searchRoot: document.createElement('div'),
                        })),
                    })),
                },
            },
        });
        activeCleanups.push(() => loaded.cleanup());

        // Open Settings -> Data & Security tab so buildImportGroup + bindClearCookiesAndCacheButton run.
        loaded.shell.openTab('right', 'data-security');
        await loaded.flush();
        await flushAsync(40);

        // 1. Cookie & cache confirmation button.
        const clearCookiesBtn = document.getElementById('clear_cookies_cache_button');
        expect(clearCookiesBtn).not.toBeNull();

        openAlert.mockResolvedValueOnce('cancel');
        clearCookiesBtn.click();
        await flushAsync();
        expect(clearFrontendCache).not.toHaveBeenCalled();
        expect(openAlert).toHaveBeenLastCalledWith(expect.objectContaining({
            heading: 'Clear Cookies & Cache?',
            body: 'This removes browser cache, service worker data, temporary session data, and IndexedDB cache stores for SillyBunny, then reloads the page. Saved settings and account data stay intact. Clearing browser cookies may require you to sign in again.',
        }));

        const origSetTimeout = window.setTimeout;
        const timeoutSpy = jest.spyOn(window, 'setTimeout').mockImplementation((fn, delay, ...args) => (
            delay >= 500 ? 1 : origSetTimeout.call(window, fn, delay, ...args)
        ));
        openAlert.mockResolvedValueOnce('clear');
        clearCookiesBtn.click();
        await flushAsync();
        timeoutSpy.mockRestore();
        expect(clearFrontendCache).toHaveBeenCalledWith({ skipConfirmation: true });
        expect(requests.some(req => req.url === '/api/cookies/clear')).toBe(true);

        // 2. SillyTavern folder import.
        const findButtonByLabel = (root, label) => [...root.querySelectorAll('button')]
            .find(button => button.textContent.trim() === label) ?? null;
        const pathInput = document.getElementById('sb-import-path-input');
        const folderBtn = findButtonByLabel(document, 'Import Folder');
        const syncBtn = findButtonByLabel(document, 'Sync Extensions');
        const zipFileInput = document.getElementById('sb-import-zip-input');
        expect(pathInput).not.toBeNull();
        expect(folderBtn).not.toBeNull();
        expect(syncBtn).not.toBeNull();
        expect(zipFileInput).not.toBeNull();

        pathInput.value = '/tmp/source';
        requests.length = 0;

        openAlert.mockResolvedValueOnce('cancel');
        folderBtn.click();
        await flushAsync();
        expect(requests).toEqual([]);
        expect(openAlert).toHaveBeenLastCalledWith(expect.objectContaining({
            heading: 'Import data from this folder into the current SillyBunny account?',
            body: expect.stringContaining('/tmp/source'),
            responses: [
                { id: 'cancel', label: 'Cancel' },
                { id: 'import', label: 'Import', appearance: 'destructive' },
            ],
        }));

        openAlert.mockResolvedValueOnce('import');
        folderBtn.click();
        await flushAsync();
        expect(requests).toContainEqual(expect.objectContaining({
            url: '/api/users/import-sillytavern/folder',
            options: expect.objectContaining({ body: JSON.stringify({ sourcePath: '/tmp/source' }) }),
        }));

        // 3. SillyTavern extension sync.
        requests.length = 0;
        openAlert.mockResolvedValueOnce('cancel');
        syncBtn.click();
        await flushAsync();
        expect(requests).toEqual([]);
        expect(openAlert).toHaveBeenLastCalledWith(expect.objectContaining({
            heading: 'Sync third-party extensions from this SillyTavern folder into the current SillyBunny account?',
            responses: [
                { id: 'cancel', label: 'Cancel' },
                { id: 'sync', label: 'Sync', appearance: 'destructive' },
            ],
        }));

        openAlert.mockResolvedValueOnce('sync');
        syncBtn.click();
        await flushAsync();
        expect(requests).toContainEqual(expect.objectContaining({
            url: '/api/users/import-sillytavern/extensions',
            options: expect.objectContaining({ body: JSON.stringify({ sourcePath: '/tmp/source' }) }),
        }));

        // 4. SillyTavern ZIP import.
        requests.length = 0;
        const zipFile = new File(['zip-bytes'], 'backup.zip', { type: 'application/zip' });
        attachFakeFile(zipFileInput, zipFile);

        openAlert.mockResolvedValueOnce('cancel');
        zipFileInput.dispatchEvent(new Event('change', { bubbles: true }));
        await flushAsync();
        expect(zipFileInput.value).toBe('');
        expect(requests).toEqual([]);

        attachFakeFile(zipFileInput, zipFile);
        openAlert.mockResolvedValueOnce('import');
        zipFileInput.dispatchEvent(new Event('change', { bubbles: true }));
        await flushAsync();
        const zipCall = requests.find(req => req.url === '/api/users/import-sillytavern/zip');
        expect(zipCall).toBeDefined();
        expect(zipCall.options.body).toBeInstanceOf(FormData);
        expect(zipFileInput.value).toBe('');
    });

    test('Chat Archive saved-view deletion and organization import await destructive Alerts before mutating', async () => {
        const openAlert = jest.fn().mockResolvedValue('cancel');
        const commitOrganizationChange = jest.fn();
        const refreshOrganizationUI = jest.fn();
        const applySavedView = jest.fn();
        const refreshOpenOrganizer = jest.fn();
        const markOrganizationDirty = jest.fn();

        jest.resetModules();
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/dialog.js'), () => ({ openAlert }));
        await jest.unstable_mockModule(pub('scripts/extensions/sillybunny-chats-archive/src/ui/organization.js'), () => ({
            commitOrganizationChange,
            loadOrganization: jest.fn(),
            refreshOrganizationUI,
        }));
        await jest.unstable_mockModule(pub('scripts/extensions/sillybunny-chats-archive/src/ui/saved-views.js'), () => ({
            applySavedView,
            currentSavedView: jest.fn(() => ({})),
        }));
        await jest.unstable_mockModule(pub('scripts/extensions/sillybunny-chats-archive/src/ui/chat-organizer.js'), () => ({
            refreshOpenOrganizer,
        }));
        await jest.unstable_mockModule(pub('scripts/extensions/sillybunny-chats-archive/src/ui/organization-save.js'), () => ({
            markOrganizationDirty,
            requestOrganizationSave: jest.fn(),
            setOrganizationControlsEnabled: jest.fn(),
        }));

        const { buildOrganizationContent, renderNamedManager } = await import(
            '../../public/scripts/extensions/sillybunny-chats-archive/src/ui/organization-manager.js'
        );

        const ctx = { translate: text => text };
        const viewItem = { id: 'view-1', name: 'Saved', view: {} };
        const state = {
            organization: {
                version: 1,
                folders: [{ id: 'old', name: 'Old Folder' }],
                collections: [],
                views: [viewItem],
                chats: {},
                lastView: null,
            },
            selectedViewId: viewItem.id,
            organizationWritable: true,
            organizationLoadAbort: { abort: jest.fn() },
        };
        const ui = {
            root: document.createElement('div'),
            list: document.createElement('div'),
        };

        buildOrganizationContent(ctx, state, ui);
        ui.root.append(ui.list, ui.organizationContent);
        document.body.appendChild(ui.root);
        renderNamedManager(ctx, state, ui, 'views', ui.managers.views);

        // 1. Saved-view delete button awaits destructive Alert confirmation.
        const deleteBtn = ui.organizationContent.querySelector('button[aria-label="Delete Saved"]');
        expect(deleteBtn).not.toBeNull();

        openAlert.mockResolvedValueOnce('cancel');
        deleteBtn.click();
        await flushAsync();
        expect(commitOrganizationChange).not.toHaveBeenCalled();
        expect(state.organization.views).toHaveLength(1);
        expect(openAlert).toHaveBeenLastCalledWith(expect.objectContaining({
            heading: 'Delete saved view Saved?',
            responses: [
                { id: 'cancel', label: 'Cancel' },
                { id: 'delete', label: 'Delete', appearance: 'destructive' },
            ],
        }));

        openAlert.mockResolvedValueOnce('delete');
        deleteBtn.click();
        await flushAsync();
        expect(state.organization.views).toEqual([]);
        expect(state.selectedViewId).toBeNull();
        expect(commitOrganizationChange).toHaveBeenCalledTimes(1);

        // 2. Organization JSON import awaits destructive Alert before replacing state.
        const backupJson = JSON.stringify({
            version: 1,
            folders: [],
            collections: [],
            views: [],
            chats: {},
            lastView: null,
        });
        const fakeFile = { size: backupJson.length, text: async () => backupJson };
        attachFakeFile(ui.backup.fileInput, fakeFile);

        openAlert.mockResolvedValueOnce('cancel');
        ui.backup.fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        await flushAsync();
        expect(state.organization.folders).toEqual([{ id: 'old', name: 'Old Folder' }]);
        expect(state.organizationLoadAbort.abort).not.toHaveBeenCalled();
        expect(ui.backup.status.textContent).toBe('');

        attachFakeFile(ui.backup.fileInput, fakeFile);
        openAlert.mockResolvedValueOnce('replace');
        ui.backup.fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        await flushAsync();
        expect(state.organization.folders).toEqual([]);
        expect(state.organizationLoadAbort).toBeNull();
        expect(refreshOrganizationUI).toHaveBeenCalledTimes(1);
        expect(markOrganizationDirty).toHaveBeenCalledTimes(1);
    });

    test('vector index purge-everything debug function awaits the destructive Alert response', async () => {
        const openAlert = jest.fn().mockResolvedValue('cancel');
        const debugFunctions = new Map();
        const origFetch = globalThis.fetch;
        const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({}) }));
        globalThis.fetch = fetchMock;
        window.fetch = fetchMock;
        activeCleanups.push(() => {
            globalThis.fetch = origFetch;
            window.fetch = origFetch;
        });

        window.toastr = { info: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() };
        const fakeJQuery = jest.fn(() => {
            const chain = new Proxy({ 0: undefined, length: 0 }, {
                get(target, prop) {
                    if (prop in target) return target[prop];
                    if (prop === 'get') return () => undefined;
                    if (prop === 'then') return undefined;
                    return () => chain;
                },
            });
            return chain;
        });
        window.$ = fakeJQuery;
        window.jQuery = fakeJQuery;
        globalThis.$ = fakeJQuery;
        globalThis.jQuery = fakeJQuery;

        jest.resetModules();
        const { EventEmitter } = await import('../../public/lib/eventemitter.js');
        const { event_types } = await import('../../public/scripts/events.js');
        await jest.unstable_mockModule(pub('script.js'), () => ({
            eventSource: new EventEmitter(),
            event_types,
            extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
            extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            getCurrentChatId: () => 'chat-1',
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            is_send_press: false,
            saveSettingsDebounced: jest.fn(),
            setExtensionPrompt: jest.fn(),
            substituteParams: v => v,
            generateRaw: jest.fn(async () => ''),
            substituteParamsExtended: v => v,
        }));
        await jest.unstable_mockModule(pub('scripts/extensions.js'), () => ({
            ModuleWorkerWrapper: class { constructor(fn) { this.fn = fn; } update() {} },
            extension_settings: { vectors: {} },
            getContext: () => ({ chat: [] }),
            modules: [],
            renderExtensionTemplateAsync: jest.fn(async () => ''),
            doExtrasFetch: jest.fn(),
            getApiUrl: jest.fn(() => ''),
            openThirdPartyExtensionMenu: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/power-user.js'), () => ({
            collapseNewlines: v => v,
            registerDebugFunction: jest.fn((id, _name, _desc, fn) => {
                debugFunctions.set(id, fn);
            }),
        }));
        await jest.unstable_mockModule(pub('scripts/secrets.js'), () => ({ SECRET_KEYS: {}, secret_state: {} }));
        await jest.unstable_mockModule(pub('scripts/chats.js'), () => ({
            getDataBankAttachments: () => [],
            getDataBankAttachmentsForSource: () => [],
            getFileAttachment: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/utils.js'), () => ({
            debounce: fn => fn,
            getStringHash: () => 1,
            waitUntilCondition: jest.fn(async () => {}),
            onlyUnique: (v, i, a) => a.indexOf(v) === i,
            splitRecursive: v => [v],
            trimToStartSentence: v => v,
            trimToEndSentence: v => v,
            escapeHtml: v => String(v ?? ''),
            isTrueBoolean: v => Boolean(v),
        }));
        await jest.unstable_mockModule(pub('scripts/constants.js'), () => ({ debounce_timeout: { relaxed: 0 } }));
        await jest.unstable_mockModule(pub('scripts/world-info.js'), () => ({ getSortedEntries: jest.fn(async () => []) }));
        await jest.unstable_mockModule(pub('scripts/textgen-settings.js'), () => ({
            textgen_types: { OLLAMA: 'ollama', LLAMACPP: 'llamacpp', VLLM: 'vllm' },
            textgenerationwebui_settings: { server_urls: {} },
        }));
        await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandParser.js'), () => ({
            SlashCommandParser: { addCommandObject: jest.fn() },
        }));
        await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommand.js'), () => ({
            SlashCommand: { fromProps: props => props },
        }));
        class MockSlashArg {
            static fromProps(props) { return props; }
        }
        await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandArgument.js'), () => ({
            ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean', LIST: 'list' },
            SlashCommandArgument: MockSlashArg,
            SlashCommandNamedArgument: MockSlashArg,
        }));
        await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandEnumValue.js'), () => ({
            SlashCommandEnumValue: class {},
            enumTypes: {},
        }));
        await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandCommonEnumsProvider.js'), () => ({
            commonEnumProviders: { boolean: () => () => [] },
        }));
        await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandReturnHelper.js'), () => ({
            slashCommandReturnHelper: { doReturn: v => v, enumList: () => [] },
        }));
        await jest.unstable_mockModule(pub('scripts/extensions/shared.js'), () => ({
            generateWebLlmChatPrompt: jest.fn(),
            isWebLlmSupported: () => false,
        }));
        await jest.unstable_mockModule(pub('scripts/extensions/vectors/webllm.js'), () => ({
            WebLlmVectorProvider: class {},
        }));
        await jest.unstable_mockModule(pub('scripts/reasoning.js'), () => ({ removeReasoningFromString: v => v }));
        await jest.unstable_mockModule(pub('scripts/openai.js'), () => ({ oai_settings: {} }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-temporary-chat-state.js'), () => ({ isTemporaryChat: () => false }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/dialog.js'), () => ({ openAlert }));
        await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({ t: strings }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/adapters/utility-dialogs.js'), () => ({ adoptPositionRadios: jest.fn() }));

        const vectors = await import('../../public/scripts/extensions/vectors/index.js');
        await vectors.init();

        const purge = debugFunctions.get('purge-everything');
        expect(typeof purge).toBe('function');

        openAlert.mockResolvedValueOnce('cancel');
        await purge();
        expect(fetchMock).not.toHaveBeenCalledWith('/api/vector/purge-all', expect.anything());
        expect(openAlert).toHaveBeenLastCalledWith(expect.objectContaining({
            heading: 'Are you sure?',
            responses: [
                { id: 'cancel', label: 'Cancel' },
                { id: 'purge', label: 'Purge Vectors', appearance: 'destructive' },
            ],
        }));

        openAlert.mockResolvedValueOnce('purge');
        await purge();
        expect(fetchMock).toHaveBeenCalledWith('/api/vector/purge-all', expect.objectContaining({ method: 'POST' }));
    });
});
