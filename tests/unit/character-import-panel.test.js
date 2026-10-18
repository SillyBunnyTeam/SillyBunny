/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest DOM assertions. */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const runCharacterImport = jest.fn();
const selectCharacterById = jest.fn();
const characters = [{ avatar: 'card.png', name: 'Card' }];
await jest.unstable_mockModule('../../public/script.js', () => ({ characters, default_avatar: 'img/ai4.png', runCharacterImport, selectCharacterById, getThumbnailUrl: (_type, id) => `/thumbnail?file=${id}` }));
const extensionNames = ['assets'];
const extension_settings = { disabledExtensions: [] };
await jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({ extensionNames, extension_settings }));
const emit = jest.fn();
await jest.unstable_mockModule('../../public/scripts/events.js', () => ({ eventSource: { emit }, event_types: { OPEN_CHARACTER_LIBRARY: 'library' } }));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: (parts, ...values) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), '') }));
const providerMarkup = '<div class="sources_list"><span>Supported sources:</span><ul><li><span>Chub</span><br>Example</li></ul></div>';
const renderTemplateAsync = jest.fn(async () => providerMarkup);
await jest.unstable_mockModule('../../public/scripts/templates.js', () => ({ renderTemplateAsync }));
const navigate = jest.fn();
const register = jest.fn();
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/object-navigation.js', () => ({ objectNavigation: { navigate, register } }));
const confirmActiveEditorLeave = jest.fn(async () => true);
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/navigation.js', () => ({ confirmActiveEditorLeave }));
const { mountCharacterImport, loadCharacterImportStyles } = await import('../../public/scripts/sillybunny-character-import.js');
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let host;
beforeEach(() => {
    jest.clearAllMocks();
    extension_settings.disabledExtensions.length = 0;
    document.body.innerHTML = '<div id="sb_character_import_panel"><div id="sb_character_import_loading"></div><div id="sb_character_import_content" hidden></div></div>';
    host = document.getElementById('sb_character_import_panel');
    runCharacterImport.mockResolvedValue([]);
    globalThis.requestAnimationFrame = callback => { callback(); };
});
const character = { kind: 'character', id: 'card.png', name: 'Card', ok: true, error: null };

describe('Import tab', () => {
    test('ready waits for provider labels before revealing content', async () => {
        let finish;
        renderTemplateAsync.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const controller = mountCharacterImport(host);
        expect(host.querySelector('#sb_character_import_content').hidden).toBe(true);
        expect(host.dataset.mounted).toBeUndefined();
        await tick();
        expect(host.querySelector('#sb_character_import_content').hidden).toBe(true);
        finish(providerMarkup);
        await controller.ready;
        expect(host.querySelector('#sb_character_import_content').hidden).toBe(false);
        expect(host.querySelector('.sb-import-source-botbooru')).not.toBeNull();
        expect(host.dataset.mounted).toBe('true');
    });

    test('failed readiness releases the mount and removes old host drop listeners before retry', async () => {
        renderTemplateAsync.mockRejectedValueOnce(new Error('Provider labels unavailable'));
        const failed = mountCharacterImport(host);
        await expect(failed.ready).rejects.toThrow('Provider labels unavailable');
        expect(host.querySelector('#sb_character_import_content').hidden).toBe(true);
        const retry = mountCharacterImport(host);
        expect(retry).not.toBe(failed);
        await retry.ready;
        const drop = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File(['{}'], 'retry.json')] } });
        host.dispatchEvent(drop);
        await tick();
        expect(runCharacterImport).toHaveBeenCalledTimes(1);
    });

    test('shows loading, then partial results safely, and always uses stay', async () => {
        let finish;
        runCharacterImport.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        const controller = mountCharacterImport(host);
        expect(host.querySelector('#sb_character_import_results').hidden).toBe(true);
        const running = controller.run({ files: [] });
        expect(host.querySelector('#sb_character_import_results').dataset.state).toBe('loading');
        expect(host.querySelector('#sb_character_import_content').getAttribute('aria-busy')).toBe('true');
        expect(host.querySelector('#sb_character_import_file_action').disabled).toBe(true);
        finish([character, { kind: 'character', name: '<bad>', ok: false, error: '<script>server error</script>' }]);
        await running;
        expect(runCharacterImport).toHaveBeenCalledWith({ files: [], policy: 'stay' });
        expect(host.querySelector('#sb_character_import_results').dataset.state).toBe('partial');
        expect(host.querySelectorAll('[data-import-status]')).toHaveLength(2);
        expect(host.querySelector('script')).toBeNull();
        expect(host.textContent).toContain('<script>server error</script>');
        expect(host.querySelector('#sb_character_import_file_action').disabled).toBe(false);
    });
    test('Chat selects without opening the editor; Edit records Import as the Back destination', async () => {
        runCharacterImport.mockResolvedValue([character]);
        await mountCharacterImport(host).run({});
        const actions = host.querySelectorAll('.ds-entity-row button');
        actions[0].click();
        await tick();
        expect(selectCharacterById).toHaveBeenCalledWith(0, { switchMenu: false });
        actions[1].click();
        await tick();
        expect(navigate).toHaveBeenCalledWith({ kind: 'character-editor', id: 'card.png', via: 'import' }, { from: { kind: 'import' } });
        expect(register).toHaveBeenCalledWith('import', expect.objectContaining({ open: expect.any(Function) }));
    });
    test('lorebooks route to World Info and never offer character actions', async () => {
        runCharacterImport.mockResolvedValue([{ kind: 'lorebook', id: 'Book', name: 'Book', ok: true }]);
        await mountCharacterImport(host).run({});
        const actions = host.querySelectorAll('.ds-entity-row button');
        expect(actions).toHaveLength(1);
        actions[0].click();
        await tick();
        expect(navigate).toHaveBeenCalledWith({ kind: 'world-info', id: 'Book', via: 'import' }, { from: { kind: 'import' } });
    });
    test('the library row requires Assets enabled and uses its existing hook', () => {
        const controller = mountCharacterImport(host);
        const library = host.querySelector('#sb_character_import_library');
        expect(library.hidden).toBe(false);
        expect(library.textContent).toBe('Browse Characters');
        library.querySelector('button').click();
        expect(emit).toHaveBeenCalledWith('library', false);
        extension_settings.disabledExtensions.push('assets');
        controller.refreshLibrary();
        expect(library.hidden).toBe(true);
    });
    test('headings are outside preference boxes, Botbooru has marked placeholder copy, and avatars fall back once', async () => {
        runCharacterImport.mockResolvedValue([character]);
        await mountCharacterImport(host).run({});
        await tick();
        expect(host.querySelector('.ds-pref-group h3')).toBeNull();
        expect(host.querySelectorAll('.sb-import-section > header > h3')).toHaveLength(3);
        expect(host.querySelector('.sb-import-source-botbooru').textContent).toBe('BotBooru');
        const img = host.querySelector('.ds-entity-row img');
        expect(img.getAttribute('src')).toBe('/thumbnail?file=card.png');
        img.dispatchEvent(new Event('error'));
        expect(img.getAttribute('src')).toBe('img/ai4.png');
        img.src = 'last-attempt.png';
        img.dispatchEvent(new Event('error'));
        expect(img.getAttribute('src')).toBe('last-attempt.png');
        for (const action of host.querySelectorAll('.sb-import-result-action')) {
            expect(action.title).toBe(action.getAttribute('aria-label'));
            expect(action.querySelector('i').getAttribute('aria-hidden')).toBe('true');
        }
    });
    test('origin restores the shell scroller after reveal, never the legacy inner container', async () => {
        const shellScroller = document.createElement('div');
        shellScroller.className = 'sb-shell-panel-scroller';
        const legacyScroller = document.createElement('div');
        legacyScroller.className = 'scrollableInner';
        document.body.append(shellScroller);
        shellScroller.append(legacyScroller);
        legacyScroller.append(host);
        mountCharacterImport(host);
        const destination = register.mock.calls[0][1];
        shellScroller.scrollTop = 250;
        legacyScroller.scrollTop = 7;
        expect(destination.captureState()).toEqual({ scrollTop: 250 });
        globalThis.SillyBunnyShell = { openTab: jest.fn(async () => { shellScroller.scrollTop = 0; }) };
        expect(await destination.open({}, { restore: { scrollTop: 250 }, isCurrent: () => true })).toBe(true);
        expect(shellScroller.scrollTop).toBe(250);
        expect(legacyScroller.scrollTop).toBe(7);
        delete globalThis.SillyBunnyShell;
    });
    test('scoped drops run once, stop propagation and ignore reentrant imports', async () => {
        const controller = mountCharacterImport(host);
        const bodyDrop = jest.fn();
        document.body.addEventListener('drop', bodyDrop, { once: true });
        const drop = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File(['{}'], 'test.json')] } });
        host.querySelector('#sb_character_import_drop').dispatchEvent(drop);
        await controller.run({ urls: ['ignored'] });
        await tick();
        expect(bodyDrop).not.toHaveBeenCalled();
        document.body.removeEventListener('drop', bodyDrop);
        expect(runCharacterImport).toHaveBeenCalledTimes(1);
    });
    test('URL lines are trimmed and loading errors restore controls', async () => {
        mountCharacterImport(host);
        runCharacterImport.mockRejectedValue(new Error('Offline'));
        host.querySelector('textarea').value = '\n first \n\nsecond\n';
        host.querySelector('#sb_character_import_url_action').click();
        await tick();
        expect(runCharacterImport).toHaveBeenCalledWith({ urls: ['first', 'second'], policy: 'stay' });
        expect(host.querySelector('#sb_character_import_results').dataset.state).toBe('error');
        expect(host.textContent).toContain('Offline');
        expect(host.querySelector('#sb_character_import_url_action').disabled).toBe(false);
    });
    test('failed deferred styles are removed so the next opening can retry', async () => {
        globalThis.SillyBunnyAssets = { loadStylesheetAsync: jest.fn((_href, { id }) => {
            const link = document.createElement('link');
            link.id = id;
            document.head.append(link);
            return Promise.reject(new Error('CSS offline'));
        }) };
        await expect(loadCharacterImportStyles([{ href: 'import.css', id: 'import-css' }])).rejects.toThrow('CSS offline');
        expect(document.getElementById('import-css')).toBeNull();
        delete globalThis.SillyBunnyAssets;
    });
});
