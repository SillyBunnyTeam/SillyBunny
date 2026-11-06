import { readdirSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, jest, test } from '@jest/globals';

function readPublic(relativePath) {
    return readFileSync(new URL(`../../public/${relativePath}`, import.meta.url), 'utf8');
}

function extractFunction(source, name) {
    const declaration = new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
    if (!declaration) throw new Error(`Unable to find ${name}`);
    const asyncStart = declaration[0].indexOf('async function');
    const start = declaration.index + (asyncStart >= 0 ? asyncStart : declaration[0].lastIndexOf('function'));
    const nextDeclaration = /\n\s*(?:async\s+)?function\s+\w+\s*\(/g;
    nextDeclaration.lastIndex = start + declaration[0].length;
    const next = nextDeclaration.exec(source);
    const candidate = source.slice(start, next?.index ?? source.length);
    return candidate.slice(0, candidate.lastIndexOf('}') + 1);
}

function loadFunction(source, name, dependencies) {
    return runInNewContext(`(${extractFunction(source, name)})`, dependencies);
}

function strings(strings, ...values) {
    return strings.reduce((result, part, index) => result + part + (values[index] ?? ''), '');
}

function translate(_ctx, text, replacements = {}) {
    return Object.entries(replacements).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, String(value)), text);
}

const openaiSource = readPublic('scripts/openai.js');
const serverToolsSource = readPublic('scripts/sillybunny-server-tools.js');
const tabsSource = readPublic('scripts/sillybunny-tabs.js');
const archiveUiDirectory = 'scripts/extensions/sillybunny-chats-archive/src/ui';
const archiveSource = [
    readPublic(`${archiveUiDirectory}.js`),
    readPublic(`${archiveUiDirectory}-navigation.js`),
    ...readdirSync(new URL(`../../public/${archiveUiDirectory}/`, import.meta.url))
        .filter(file => file.endsWith('.js'))
        .sort()
        .map(file => readPublic(`${archiveUiDirectory}/${file}`)),
].join('\n').replace(/^import [^;]*;$/gm, '').replace(/^export /gm, '');
const vectorSource = readPublic('scripts/extensions/vectors/index.js');

test('OpenAI server config reload awaits the destructive Alert response before loading', async () => {
    const start = openaiSource.indexOf('document.getElementById(\'sb-chat-completion-config-reload\')');
    const arrowStart = openaiSource.indexOf('async () => {', start);
    const nextHandler = openaiSource.indexOf('\n    document.getElementById(\'sb-chat-completion-config-save\')', arrowStart);
    const handlerSource = openaiSource.slice(arrowStart, nextHandler);
    const handlerEnd = handlerSource.lastIndexOf('});');
    const openAlert = jest.fn().mockResolvedValue('cancel');
    const loadServerChatCompletionConfig = jest.fn();
    const handler = runInNewContext(`(${handlerSource.slice(0, handlerEnd + 1)})`, {
        serverChatCompletionConfigState: { loaded: true },
        updateServerChatCompletionConfigDirtyState: jest.fn(() => true),
        openAlert,
        t: strings,
        loadServerChatCompletionConfig,
    });
    await handler();
    expect(loadServerChatCompletionConfig).not.toHaveBeenCalled();
    expect(openAlert).toHaveBeenLastCalledWith(expect.objectContaining({
        heading: 'Discard your unsaved server config edits and reload from config.yaml?',
        responses: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'discard', label: 'Discard', appearance: 'destructive' },
        ],
    }));

    openAlert.mockResolvedValueOnce('discard');
    await handler();
    expect(loadServerChatCompletionConfig).toHaveBeenCalledWith({ force: true });
});

test('server admin reload and thumbnail cache actions wait for Alert responses', async () => {
    const state = { busy: false, restarting: false };
    const refs = {};
    const refreshServerAdminPanel = jest.fn();
    const openAlert = jest.fn().mockResolvedValue('cancel');
    const reload = loadFunction(serverToolsSource, 'handleServerAdminReloadConfig', {
        getServerAdminRefs: () => refs,
        updateServerConfigDirtyState: jest.fn(() => true),
        openAlert,
        t: strings,
        refreshServerAdminPanel,
    });

    await reload();
    expect(openAlert).toHaveBeenLastCalledWith(expect.objectContaining({
        heading: 'Discard your unsaved config edits and reload config.yaml from disk?',
        responses: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'discard', label: 'Discard', appearance: 'destructive' },
        ],
    }));
    expect(refreshServerAdminPanel).not.toHaveBeenCalled();

    openAlert.mockResolvedValueOnce('discard');
    await reload();
    expect(refreshServerAdminPanel).toHaveBeenCalledWith({ includeConfig: true, forceConfig: true });

    const requestServerAdmin = jest.fn(async endpoint => endpoint.endsWith('/get') ? {} : { message: 'cleared' });
    const thumbnailClear = loadFunction(serverToolsSource, 'handleServerThumbnailClearCache', {
        getServerAdminState: () => state,
        getServerAdminRefs: () => refs,
        openAlert,
        t: strings,
        updateServerAdminInteractivity: jest.fn(),
        setServerAdminMessage: jest.fn(),
        requestServerAdmin,
        toastr: { success: jest.fn(), error: jest.fn() },
        renderServerAdminConfig: jest.fn(),
    });
    openAlert.mockResolvedValueOnce('cancel');
    await thumbnailClear();
    expect(requestServerAdmin).not.toHaveBeenCalled();
    openAlert.mockResolvedValueOnce('clear');
    await thumbnailClear();
    expect(requestServerAdmin).toHaveBeenCalledWith('/api/server-admin/thumbnails/clear-cache');
    expect(openAlert).toHaveBeenLastCalledWith(expect.objectContaining({
        heading: 'Clear cached thumbnails for this user?',
        body: 'They will be rebuilt as images are loaded.',
        defaultResponse: 'clear',
    }));
});

test('server branch switching resets the select on Cancel and runs only after confirmation', async () => {
    const currentBranch = 'staging';
    const select = { value: 'release' };
    const state = {
        busy: false,
        restarting: false,
        lastStatusData: { repository: { branch: currentBranch, hasLocalChanges: true, changedFiles: [{ path: 'config.yaml' }] } },
    };
    const requestServerAdmin = jest.fn().mockResolvedValue({ message: 'switched' });
    const openAlert = jest.fn().mockResolvedValue('cancel');
    const switchBranch = loadFunction(serverToolsSource, 'handleServerAdminBranchSwitch', {
        getServerAdminState: () => state,
        getServerAdminRefs: () => ({}),
        updateServerAdminInteractivity: jest.fn(),
        setServerAdminMessage: jest.fn(),
        openAlert,
        t: strings,
        requestServerAdmin,
        waitForServerReturn: jest.fn().mockResolvedValue(true),
        toastr: { info: jest.fn(), warning: jest.fn() },
        AbortController,
        setTimeout: () => 1,
        clearTimeout: jest.fn(),
    });

    await switchBranch(select);
    expect(select.value).toBe(currentBranch);
    expect(requestServerAdmin).not.toHaveBeenCalled();
    expect(openAlert).toHaveBeenLastCalledWith(expect.objectContaining({
        heading: 'You have local changes.',
        body: expect.stringContaining('auto-stash your changes and switch to "release"?'),
        defaultResponse: null,
    }));

    select.value = 'release';
    openAlert.mockResolvedValueOnce('switch');
    await switchBranch(select);
    expect(requestServerAdmin).toHaveBeenCalledWith('/api/server-admin/switch-branch', {
        branch: 'release',
        autoStash: true,
    }, expect.objectContaining({ signal: expect.anything() }));
});

test('cookie and cache confirmation resolves only from the shared alert response', async () => {
    const openAlert = jest.fn().mockResolvedValue('cancel');
    const confirm = loadFunction(tabsSource, 'confirmClearCookiesAndCache', {
        openAlert,
        t: strings,
    });
    await expect(confirm()).resolves.toBe(false);
    expect(openAlert).toHaveBeenLastCalledWith(expect.objectContaining({
        heading: 'Clear cookies & cache?',
        body: 'This removes browser cache, service worker data, temporary session data, and IndexedDB cache stores for SillyBunny, then reloads the page. Saved settings and account data stay intact. Clearing browser cookies may require you to sign in again.',
    }));
    openAlert.mockResolvedValueOnce('clear');
    await expect(confirm()).resolves.toBe(true);
});

function importerDependencies({ response, refs, state, requestUserPrivateAction }) {
    return {
        getImporterRefs: () => refs,
        getImporterState: () => state,
        openAlert: jest.fn().mockResolvedValue(response),
        t: strings,
        setServerAdminMessage: jest.fn(),
        toastr: { success: jest.fn(), warning: jest.fn(), error: jest.fn() },
        setSillyTavernImportBusy: jest.fn(),
        renderSillyTavernExtensionSyncReport: jest.fn(),
        requestUserPrivateAction,
        wait: jest.fn(async () => {}),
        location: { reload: jest.fn() },
        logSillyTavernExtensionSyncReport: jest.fn(),
        console: { error: jest.fn(), groupCollapsed: jest.fn(), table: jest.fn(), groupEnd: jest.fn() },
        FormData: class {
            append() {}
        },
        File: class TestFile {},
        HTMLInputElement: Object,
    };
}

test('folder import cancellation prevents the request and confirmation runs it', async () => {
    const refs = { pathInput: { value: '/tmp/source' }, note: {} };
    const requestUserPrivateAction = jest.fn().mockResolvedValue({ message: 'done' });
    const dependencies = importerDependencies({ response: 'cancel', refs, state: { busy: false }, requestUserPrivateAction });
    const importFolder = loadFunction(tabsSource, 'handleSillyTavernFolderImport', dependencies);

    await importFolder();
    expect(requestUserPrivateAction).not.toHaveBeenCalled();
    expect(dependencies.openAlert).toHaveBeenLastCalledWith(expect.objectContaining({
        heading: 'Import data from this folder into the current SillyBunny account?',
        body: expect.stringContaining('/tmp/source'),
        responses: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'import', label: 'Import', appearance: 'destructive' },
        ],
    }));

    dependencies.openAlert.mockResolvedValueOnce('import');
    await importFolder();
    expect(requestUserPrivateAction).toHaveBeenCalledWith('/api/users/import-sillytavern/folder', { body: { sourcePath: '/tmp/source' } });
});

test('extension sync cancellation prevents the request and confirmation runs it', async () => {
    const refs = { pathInput: { value: '/tmp/source' }, note: {} };
    const requestUserPrivateAction = jest.fn().mockResolvedValue({ warningCount: 0, failedCount: 0, gitMetadataSkippedCount: 0 });
    const dependencies = importerDependencies({ response: 'cancel', refs, state: { busy: false }, requestUserPrivateAction });
    const syncExtensions = loadFunction(tabsSource, 'handleSillyTavernExtensionSync', dependencies);

    await syncExtensions();
    expect(requestUserPrivateAction).not.toHaveBeenCalled();
    expect(dependencies.openAlert).toHaveBeenLastCalledWith(expect.objectContaining({
        heading: 'Sync third-party extensions from this SillyTavern folder into the current SillyBunny account?',
        responses: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'sync', label: 'Yes', appearance: 'destructive' },
        ],
    }));

    dependencies.openAlert.mockResolvedValueOnce('sync');
    await syncExtensions();
    expect(requestUserPrivateAction).toHaveBeenCalledWith('/api/users/import-sillytavern/extensions', { body: { sourcePath: '/tmp/source' } });
});

test('ZIP import cancellation clears the file selection and confirmation sends the file', async () => {
    const file = new (class TestFile { constructor() { this.name = 'backup.zip'; } })();
    const refs = { note: {}, zipFileInput: { value: 'backup.zip' } };
    const requestUserPrivateAction = jest.fn().mockResolvedValue({ message: 'done' });
    const dependencies = importerDependencies({ response: 'cancel', refs, state: { busy: false }, requestUserPrivateAction });
    dependencies.File = file.constructor;
    const importZip = loadFunction(tabsSource, 'handleSillyTavernZipImport', dependencies);

    await importZip(file);
    expect(refs.zipFileInput.value).toBe('');
    expect(requestUserPrivateAction).not.toHaveBeenCalled();

    dependencies.openAlert.mockResolvedValueOnce('import');
    await importZip(file);
    expect(requestUserPrivateAction).toHaveBeenCalledWith('/api/users/import-sillytavern/zip', expect.objectContaining({ useFormData: true }));
    expect(refs.zipFileInput.value).toBe('');
});

test('Chat Archive saved-view deletion awaits confirmation before committing', async () => {
    const item = { id: 'view-1', name: 'Saved' };
    const state = { organization: { views: [item] }, selectedViewId: item.id };
    const commitOrganizationChange = jest.fn();
    const openAlert = jest.fn().mockResolvedValue('cancel');
    const deleteNamedItem = loadFunction(archiveSource, 'deleteNamedItem', {
        normalizeOrganization: organization => organization,
        namedItemHasReferences: jest.fn(() => false),
        commitOrganizationChange,
        openAlert,
        tr: translate,
    });
    const ctx = { translate: text => text };

    await deleteNamedItem(ctx, state, {}, 'views', item);
    expect(commitOrganizationChange).not.toHaveBeenCalled();
    expect(openAlert).toHaveBeenLastCalledWith(expect.objectContaining({
        heading: 'Delete saved view Saved?',
        responses: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'delete', label: 'Delete', appearance: 'destructive' },
        ],
    }));

    openAlert.mockResolvedValueOnce('delete');
    await deleteNamedItem(ctx, state, {}, 'views', item);
    expect(state.organization.views).toEqual([]);
    expect(commitOrganizationChange).toHaveBeenCalledTimes(1);
});

test('Chat Archive organization replacement does not mutate on Cancel and commits after confirmation', async () => {
    const imported = { folders: [], collections: [], views: [], chats: {}, lastView: null };
    const file = { size: 10, text: async () => '{}' };
    const state = { organization: { folders: [{ id: 'old' }] }, organizationLoadAbort: { abort: jest.fn() } };
    const ui = { backup: { fileInput: { files: [file], value: 'backup.json' }, status: { textContent: '', dataset: {} } } };
    const dependencies = {
        MAX_ORGANIZATION_IMPORT_BYTES: 100,
        parseOrganization: jest.fn(() => imported),
        openAlert: jest.fn().mockResolvedValue('cancel'),
        tr: translate,
        preserveArchiveFocus: (_ui, update) => update(),
        refreshOrganizationUI: jest.fn(),
        applySavedView: jest.fn(),
        refreshOpenOrganizer: jest.fn(),
        markOrganizationDirty: jest.fn(),
        console: { warn: jest.fn() },
    };
    const importOrganization = loadFunction(archiveSource, 'importOrganization', dependencies);
    const ctx = { translate: text => text };

    await importOrganization(ctx, state, ui);
    expect(state.organization.folders).toEqual([{ id: 'old' }]);
    expect(state.organizationLoadAbort.abort).not.toHaveBeenCalled();
    expect(ui.backup.status.textContent).toBe('');

    dependencies.openAlert.mockResolvedValueOnce('replace');
    await importOrganization(ctx, state, ui);
    expect(state.organization).toBe(imported);
    expect(state.organizationLoadAbort).toBeNull();
    expect(dependencies.refreshOrganizationUI).toHaveBeenCalledTimes(1);
    expect(dependencies.markOrganizationDirty).toHaveBeenCalledTimes(1);
});

test('vector index purge awaits the destructive Alert response', async () => {
    const marker = vectorSource.indexOf('registerDebugFunction(\'purge-everything\'');
    const arrowStart = vectorSource.indexOf('async () => {', marker);
    const arrowEnd = vectorSource.indexOf('\n    });', arrowStart);
    const callbackSource = `${vectorSource.slice(arrowStart, arrowEnd).trim()}}`;
    const openAlert = jest.fn().mockResolvedValue('cancel');
    const purgeAllVectorIndexes = jest.fn();
    const purge = runInNewContext(`(${callbackSource})`, { openAlert, purgeAllVectorIndexes, t: strings });

    await purge();
    expect(purgeAllVectorIndexes).not.toHaveBeenCalled();
    expect(openAlert).toHaveBeenLastCalledWith(expect.objectContaining({
        heading: 'Are you sure?',
        responses: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'purge', label: 'Yes', appearance: 'destructive' },
        ],
    }));

    openAlert.mockResolvedValueOnce('purge');
    await purge();
    expect(purgeAllVectorIndexes).toHaveBeenCalledTimes(1);
});
