import { jest, describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { EventEmitter } from 'node:events';

const source = readFileSync(new URL('../../public/script.js', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
function declaration(name) {
    const node = ast.body.map(node => node.declaration ?? node).find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
    return source.slice(node.start, node.end);
}
function harness({ actualFileImport = false, generating = false } = {}) {
    const characters = [];
    const selectImportedChar = jest.fn(async () => true);
    const importCharactersTags = jest.fn(async ids => {
        for (const avatar of ids) characters.push({ avatar, name: `Name ${avatar}` });
    });
    const importCharacter = jest.fn(async file => {
        if (file.name === 'bad.json') throw new Error('Server says invalid card');
        return `${file.name.split('.')[0]}.png`;
    });
    const eventSource = new EventEmitter();
    const event_types = { WORLDINFO_UPDATED: 'worldinfo_updated' };
    const importWorldInfo = jest.fn(async () => {
        eventSource.emit(event_types.WORLDINFO_UPDATED, 'Unrelated book', {}, { replaced: true });
        return { ok: true, name: 'Canonical book', error: null };
    });
    const fetch = jest.fn();
    const toastr = { warning: jest.fn(), error: jest.fn(), success: jest.fn() };
    const t = (parts, ...values) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), '');
    const deps = {
        characters, selectImportedChar, importCharactersTags, importCharacter, eventSource, event_types,
        importWorldInfo, fetch, toastr, t, isValidUrl: value => value.startsWith('https://'),
        getRequestHeaders: () => ({}), File, FormData, is_group_generating: generating, is_send_press: false,
        name1: 'User', $: () => ({ val: () => ({ trigger() {} }) }), console: { error() {}, debug() {}, log() {} },
    };
    if (actualFileImport) delete deps.importCharacter;
    const code = [actualFileImport ? declaration('importCharacter') : '', declaration('runCharacterImport'), declaration('processDroppedFiles')].join('\n');
    const api = new Function(...Object.keys(deps), `${code}\nreturn { runCharacterImport, processDroppedFiles };`)(...Object.values(deps));
    return { ...deps, ...api };
}
const file = (name, type = 'application/json') => new File(['{}'], name, { type });

describe('result-bearing import operation', () => {
    test('keeps ordered partial results, imports tags once and selects only the last success', async () => {
        const app = harness();
        const results = await app.runCharacterImport({ files: [file('first.json'), file('bad.json'), file('last.json')] });
        expect(results.map(item => item.ok)).toEqual([true, false, true]);
        expect(results[1].error).toBe('Server says invalid card');
        expect(results[2].name).toBe('Name last.png');
        expect(app.importCharactersTags).toHaveBeenCalledWith(['first.png', 'last.png']);
        expect(app.selectImportedChar).toHaveBeenCalledWith('last.png');
    });
    test('stay never selects, including URL characters', async () => {
        const app = harness();
        app.fetch.mockResolvedValue(new Response('{}', { headers: { 'X-Custom-Content-Type': 'character', 'Content-Disposition': 'attachment; filename="url.json"', 'Content-Type': 'application/json' } }));
        const items = await app.runCharacterImport({ urls: ['https://example.invalid/card'], policy: 'stay' });
        expect(items[0]).toMatchObject({ kind: 'character', id: 'url.png', ok: true });
        expect(app.selectImportedChar).not.toHaveBeenCalled();
    });
    test('URL lorebooks reuse upstream import and return its canonical committed name', async () => {
        const app = harness();
        app.fetch.mockResolvedValue(new Response('{}', { headers: { 'X-Custom-Content-Type': 'lorebook', 'Content-Disposition': 'attachment; filename*=UTF-8\'\'Book%20name.json' } }));
        expect(await app.runCharacterImport({ urls: ['lorebooks/example/book'], policy: 'stay' })).toEqual([
            { kind: 'lorebook', id: 'Canonical book', name: 'Canonical book', ok: true, error: null },
        ]);
        expect(app.fetch).toHaveBeenCalledWith('/api/content/importUUID', expect.anything());
        expect(app.importWorldInfo.mock.calls[0][0].name).toBe('Book name.json');
        expect(app.importWorldInfo.mock.calls[0][1]).toEqual({ returnResult: true });
        expect(app.eventSource.listenerCount('worldinfo_updated')).toBe(0);
    });
    test('external server errors survive and do not stop the next URL', async () => {
        const app = harness();
        app.fetch.mockResolvedValueOnce(new Response('Private card', { status: 403 })).mockResolvedValueOnce(new Response('Unavailable', { status: 404 }));
        const items = await app.runCharacterImport({ urls: ['one', 'two'] });
        expect(items.map(item => item.error)).toEqual(['Private card', 'Unavailable']);
    });
    test('unrelated WI updates cannot turn a failed lorebook import into success', async () => {
        const app = harness();
        app.fetch.mockResolvedValue(new Response('{}', { headers: { 'X-Custom-Content-Type': 'lorebook', 'Content-Disposition': 'attachment; filename="book.json"' } }));
        app.importWorldInfo.mockImplementation(async () => {
            app.eventSource.emit('worldinfo_updated', 'Other book', {}, { replaced: true });
            return { ok: false, name: null, error: 'Lorebook rejected by server' };
        });
        expect((await app.runCharacterImport({ urls: ['lorebooks/example/book'], policy: 'stay' }))[0]).toMatchObject({
            ok: false, id: null, error: 'Lorebook rejected by server',
        });
    });
    test('generation preconditions reject legacy imports but become a stay result row', async () => {
        const app = harness({ actualFileImport: true, generating: true });
        await expect(app.processDroppedFiles([file('card.json')])).rejects.toThrow('Cannot import character while generating');
        expect((await app.runCharacterImport({ files: [file('card.json')], policy: 'stay' }))[0]).toMatchObject({ ok: false, error: 'Cannot import character while generating' });
        expect(app.fetch).not.toHaveBeenCalled();
    });
    test('generation-active Assets installation reports failure instead of success', async () => {
        const app = harness({ actualFileImport: true, generating: true });
        const assetsSource = readFileSync(new URL('../../public/scripts/extensions/assets/index.js', import.meta.url), 'utf8');
        const installSource = assetsSource.match(/^async function installAsset\([\s\S]*?^}/m)[0];
        const download = jest.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
        const installAsset = new Function('fetch', 'getRequestHeaders', 'processDroppedFiles', 'File', 'console', 'DEBUG_PREFIX', `${installSource}\nreturn installAsset;`)(download, app.getRequestHeaders, app.processDroppedFiles, File, app.console, 'QA');
        expect(await installAsset('https://example.invalid/card', 'character', 'card.json')).toBe(false);
        expect(app.fetch).not.toHaveBeenCalled();
    });
    test('generation-active file replacement never runs postReplace after its rejected import', async () => {
        const app = harness({ actualFileImport: true, generating: true });
        const start = source.indexOf('const uploadReplacementCard = async (e) => {');
        const replacementSource = source.slice(start, source.indexOf('$(\'#character_replace_file\')', start));
        const postReplace = jest.fn();
        const replace = new Function('characters', 'this_chid', 'processDroppedFiles', 'postReplace', 'toastr', `${replacementSource}\nreturn uploadReplacementCard;`)([{ avatar: 'current.png' }], 0, app.processDroppedFiles, postReplace, app.toastr);
        await replace({ target: { files: [file('card.json')] } });
        expect(postReplace).not.toHaveBeenCalled();
        expect(app.toastr.error).toHaveBeenCalledWith('Failed to replace the character card.', 'Something went wrong');
    });
    test('generation-active URL replacement propagates the abort and never runs postReplace', async () => {
        const app = harness({ actualFileImport: true, generating: true });
        const utils = readFileSync(new URL('../../public/scripts/utils.js', import.meta.url), 'utf8');
        const externalSource = utils.match(/^export (async function importFromExternalUrl\([\s\S]*?^})/m)[1];
        const externalDeps = {
            ...app, fetch: jest.fn(async () => new Response('{}', { headers: { 'X-Custom-Content-Type': 'character', 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="card.json"' } })),
        };
        const importFromExternalUrl = new Function(...Object.keys(externalDeps), `${externalSource}\nreturn importFromExternalUrl;`)(...Object.values(externalDeps));
        const start = source.indexOf('await importFromExternalUrl(onlineUrl, { preserveFileName:');
        const replacement = source.slice(start, source.indexOf('await postReplace();', start) + 'await postReplace();'.length);
        const postReplace = jest.fn();
        const replace = new Function('onlineUrl', 'characters', 'this_chid', 'importFromExternalUrl', 'postReplace', `return (async () => { ${replacement} })();`);
        await expect(replace('https://example.invalid/card', [{ avatar: 'current.png' }], 0, importFromExternalUrl, postReplace)).rejects.toThrow('Cannot import character while generating');
        expect(postReplace).not.toHaveBeenCalled();
        expect(app.fetch).not.toHaveBeenCalled();
    });
    test('legacy drops preserve the MIME gate, filename map, void return and select-last', async () => {
        const app = harness();
        const card = file('ok.json');
        const data = new Map([[card, 'replace.png']]);
        expect(await app.processDroppedFiles([file('ignored.json', ''), card], data)).toBeUndefined();
        expect(app.importCharacter).toHaveBeenCalledTimes(1);
        expect(app.importCharacter).toHaveBeenCalledWith(card, { preserveFileName: 'replace.png', throwOnError: true });
        expect(app.selectImportedChar).toHaveBeenCalledWith('ok.png');
    });
    test('picker accepts a supported extension with no MIME; invalid policies fail before imports', async () => {
        const app = harness();
        expect((await app.runCharacterImport({ files: [file('plain.json', '')], policy: 'stay' }))[0].ok).toBe(true);
        await expect(app.runCharacterImport({ policy: 'invalid' })).rejects.toThrow('Unknown import policy');
    });
    test('real character transport preserves JSON and plain text server errors', async () => {
        const app = harness({ actualFileImport: true });
        app.fetch.mockResolvedValueOnce(new Response('{"error":"Rejected card"}', { status: 400 }))
            .mockResolvedValueOnce(new Response('Bad PNG', { status: 422 }));
        const items = await app.runCharacterImport({ files: [file('bad.json'), file('bad.png', 'image/png')] });
        expect(items.map(item => item.error)).toEqual(['Rejected card', 'Bad PNG']);
    });
    test('other callers and hidden picker retain their upstream selection contract', () => {
        const utils = readFileSync(new URL('../../public/scripts/utils.js', import.meta.url), 'utf8');
        const welcome = readFileSync(new URL('../../public/scripts/welcome-screen.js', import.meta.url), 'utf8');
        const assets = readFileSync(new URL('../../public/scripts/extensions/assets/index.js', import.meta.url), 'utf8');
        expect(utils).toContain('await processDroppedFiles([file], extraData)');
        expect(welcome).toContain('document.getElementById(\'character_import_button\')');
        expect(assets).toContain('await processDroppedFiles([file], fileNameMap)');
        expect(source).toContain('await runCharacterImport({ files: e.target.files, policy: \'select-last\' })');
        expect(source).toContain('await processDroppedFiles(files);');
    });
});
