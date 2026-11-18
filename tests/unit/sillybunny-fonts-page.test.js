/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { TextDecoder } from 'node:util';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { buildFontTables } from '../helpers/font-fixtures.js';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
}));

const alertResponse = jest.fn();
const openedDialogs = [];
const stubRow = () => ({ row: document.createElement('div'), control: document.createElement('input'), getValue: () => '' });
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/dialog.js', () => ({
    openAlert: (...args) => alertResponse(...args),
    openDialog: options => {
        openedDialogs.push(options);
        return { closed: Promise.resolve({ response: 'cancel' }), setResponseEnabled: jest.fn() };
    },
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/rows.js', () => ({
    createEntryRow: jest.fn(stubRow),
    createPrefGroup: jest.fn(() => ({ section: document.createElement('section') })),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/select-row.js', () => ({ createSelectRow: jest.fn(stubRow) }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/toggle-row.js', () => ({ createToggleRow: jest.fn(stubRow) }));

// jsdom has no TextDecoder; a browser does.
global.TextDecoder = TextDecoder;

const fonts = await import('../../public/scripts/sillybunny-fonts.js');

const FILE = '/user/files/sb-font-0123456789ab.woff2';
const entry = (overrides = {}) => ({ id: 'abc', family: 'Test Face', file: FILE, weight: 400, style: 'normal', format: 'woff2', ...overrides });

function makeHost(initial = []) {
    let list = initial;
    let choice = '';
    const host = {
        getFonts: () => list,
        setFonts: next => { list = next; },
        getChoice: () => choice,
        setChoice: name => { choice = name; },
        save: jest.fn(),
        apply: jest.fn(),
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        uuid: (() => { let count = 0; return () => `0000000${++count}-aaaa-bbbb-cccc-dddddddddddd`; })(),
    };
    return host;
}

const fileOf = (buffer, name) => new File([buffer], name);
let uploads;
let deletes;

beforeEach(() => {
    alertResponse.mockReset();
    openedDialogs.length = 0;
    document.head.replaceChildren();
    document.documentElement.removeAttribute('style');
    global.toastr = { error: jest.fn(), success: jest.fn() };
    uploads = [];
    deletes = [];
    global.FontFace = class {
        constructor(family, source, descriptors) {
            this.args = [family, source, descriptors];
        }

        load() {
            return global.fontFaceResult === 'reject' ? Promise.reject(new Error('rejected')) : Promise.resolve(this);
        }
    };
    global.fontFaceResult = 'ok';
    global.fetch = jest.fn(async (url, init) => {
        const body = JSON.parse(init.body);
        if (url === '/api/files/upload') {
            uploads.push(body);
            return { ok: true, status: 200, json: async () => ({ path: `/user/files/${body.name}` }), text: async () => '' };
        }
        deletes.push(body);
        return { ok: global.deleteStatus !== 500, status: global.deleteStatus ?? 200, text: async () => '' };
    });
    global.deleteStatus = 200;
    // jsdom has no File.arrayBuffer
    if (!File.prototype.arrayBuffer) {
        File.prototype.arrayBuffer = function () { return new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsArrayBuffer(this); }); };
    }
});

afterEach(() => {
    delete global.fontFaceResult;
    delete global.deleteStatus;
});

describe('applying a choice', () => {
    const apply = (name, list = [], themeFont = '') => fonts.applyFontChoice(name, { fonts: list, themeFont });
    const rootFont = () => document.documentElement.style.getPropertyValue('--mainFontFamily');

    test('default changes nothing on a page that has no font: no link, no style, no variable', () => {
        expect(apply('').kind).toBe('none');
        expect(document.head.children).toHaveLength(0);
        expect(rootFont()).toBe('');
    });

    test('default gives the theme font back, or removes the variable', () => {
        apply('Inter');
        expect(rootFont()).toContain('Inter');
        apply('', [], '\'Theme Sans\', serif');
        expect(rootFont()).toBe('\'Theme Sans\', serif');
        apply('Inter');
        apply('');
        expect(rootFont()).toBe('');
    });

    test('a preset links its own stylesheet, removes the Google link and makes no Google request', () => {
        apply('Lobster');
        expect(document.getElementById('google-font-style').href).toContain('fonts.googleapis.com');
        apply('Roboto');
        expect(document.getElementById('google-font-style')).toBeNull();
        const link = document.getElementById('sb-preset-font-style');
        expect(link.getAttribute('href')).toBe(`webfonts/Roboto/stylesheet.css?v=${fonts.PRESET_STYLESHEET_KEY}`);
        expect(link.rel).toBe('stylesheet');
        expect(rootFont()).toBe('\'Roboto\', \'Adwaita Sans\', system-ui, sans-serif');
        expect(document.head.innerHTML).not.toContain('googleapis');
    });

    test('changing preset reuses one link', () => {
        apply('Inter');
        apply('Public Sans');
        expect(document.querySelectorAll('#sb-preset-font-style')).toHaveLength(1);
        expect(document.getElementById('sb-preset-font-style').getAttribute('href')).toContain('PublicSans');
    });

    test('an imported family writes one style element and no link', () => {
        apply('Test Face', [entry()]);
        expect(document.querySelectorAll('#sb-imported-fonts')).toHaveLength(1);
        expect(document.getElementById('sb-imported-fonts').textContent).toContain('font-family:\'Test Face\'');
        expect(document.getElementById('google-font-style')).toBeNull();
        expect(document.getElementById('sb-preset-font-style')).toBeNull();
        expect(rootFont()).toBe('\'Test Face\', \'Adwaita Sans\', system-ui, sans-serif');
    });

    test('an imported family that is also a preset name wins, with no preset link', () => {
        apply('Inter', [entry({ family: 'Inter' })]);
        expect(document.getElementById('sb-preset-font-style')).toBeNull();
        expect(document.getElementById('sb-imported-fonts')).not.toBeNull();
    });

    test('a legacy name still loads from Google, with a stack that falls back to Adwaita Sans', () => {
        const resolved = apply('Lobster Two');
        expect(resolved.kind).toBe('google');
        expect(document.getElementById('google-font-style').getAttribute('href')).toBe(fonts.buildGoogleFontHref('Lobster Two'));
        expect(rootFont()).toBe('\'Lobster Two\', \'Adwaita Sans\', system-ui, sans-serif');
    });

    test('removing the last imported font removes the style element', () => {
        apply('Test Face', [entry()]);
        apply('', []);
        expect(document.getElementById('sb-imported-fonts')).toBeNull();
    });

    test('a hostile legacy name cannot leave the CSS string it is written in', () => {
        const hostile = 'x\'; --mainFontFamily: red; \'';
        apply(hostile);
        expect(rootFont()).toBe(`${fonts.cssString(hostile)}, 'Adwaita Sans', system-ui, sans-serif`);
        expect(rootFont().split(',')[0]).not.toMatch(/[;]/);
    });
});

describe('the select', () => {
    const select = () => {
        const node = document.createElement('select');
        document.body.replaceChildren(node);
        return node;
    };
    const groups = node => [...node.children].map(child => (child.tagName === 'OPTGROUP' ? [child.label, [...child.children].map(option => option.value)] : child.value));

    test('default data lists Default and the five presets', () => {
        const node = select();
        fonts.syncFontSelect(node, { fonts: [], choice: '' });
        expect(groups(node)).toEqual(['', ['Presets', ['Inter', 'JetBrains Mono', 'Roboto', 'Public Sans', 'Source Serif 4']]]);
        expect(node.value).toBe('');
        expect(node.dataset.sbFontSource).toBe('none');
    });

    test('imported families are grouped and sorted, and the selected option is marked as imported', () => {
        const node = select();
        fonts.syncFontSelect(node, { fonts: [entry({ family: 'Zed' }), entry({ id: 'b', family: 'Alpha', file: '/user/files/sb-font-ffffffffffff.woff2' })], choice: 'Alpha' });
        expect(groups(node).slice(2)).toEqual([['Imported', ['Alpha', 'Zed']]]);
        expect(node.value).toBe('Alpha');
        expect(node.selectedOptions[0].dataset.sbFontKind).toBe('imported');
    });

    test('a legacy name is listed under Google Fonts only while it is the choice', () => {
        const node = select();
        fonts.syncFontSelect(node, { fonts: [], choice: 'Lobster' });
        expect(groups(node).at(-1)).toEqual(['Google Fonts', ['Lobster']]);
        expect(node.value).toBe('Lobster');
        expect(node.dataset.sbFontSource).toBe('google');
        fonts.syncFontSelect(node, { fonts: [], choice: 'Inter' });
        expect(node.querySelector('optgroup[label="Google Fonts"]')).toBeNull();
        expect(node.value).toBe('Inter');
        fonts.syncFontSelect(node, { fonts: [], choice: 'Lobster' });
        fonts.syncFontSelect(node, { fonts: [], choice: '' });
        expect([...node.options].some(option => option.value === 'Lobster')).toBe(false);
    });

    test('an unchanged list does not rebuild the options', () => {
        const node = select();
        fonts.syncFontSelect(node, { fonts: [], choice: '' });
        const first = node.firstElementChild;
        fonts.syncFontSelect(node, { fonts: [], choice: 'Inter' });
        expect(node.firstElementChild).toBe(first);
    });
});

describe('importing files', () => {
    const font = (options, name) => fileOf(buildFontTables(options).build(), name);

    test('a readable file is checked, accepted by the browser, uploaded under a generated name and saved once', async () => {
        const host = makeHost();
        const added = await fonts.importFontFiles([font({ family: 'Made Up', weight: 700, italic: true }, 'whatever it is called.ttf')], host);
        expect(added).toHaveLength(1);
        expect(uploads).toHaveLength(1);
        expect(uploads[0].name).toMatch(/^sb-font-[0-9a-f]{12}\.ttf$/);
        expect(uploads[0].name).not.toContain('whatever');
        expect(Buffer.from(uploads[0].data, 'base64').subarray(0, 4)).toEqual(Buffer.from([0, 1, 0, 0]));
        expect(host.getFonts()).toEqual([expect.objectContaining({ family: 'Made Up', weight: 700, style: 'italic', format: 'truetype', file: `/user/files/${uploads[0].name}` })]);
        expect(host.save).toHaveBeenCalledTimes(1);
        expect(host.apply).toHaveBeenCalledTimes(1);
        expect(global.toastr.success).toHaveBeenCalledWith('Font imported', 'Made Up');
    });

    test('a file that fails the checks is named in one error and is never uploaded', async () => {
        const host = makeHost();
        const files = [fileOf(Buffer.from('MZ not a font'), 'virus.exe'), fileOf(Buffer.from('<svg></svg>'), 'fake.woff2'), fileOf(Buffer.from('ttcf....'), 'collection.ttf')];
        expect(await fonts.importFontFiles(files, host)).toEqual([]);
        expect(uploads).toHaveLength(0);
        expect(global.toastr.error.mock.calls.map(call => call[1])).toEqual(['virus.exe', 'fake.woff2', 'collection.ttf']);
        expect(host.save).not.toHaveBeenCalled();
        expect(host.getFonts()).toEqual([]);
    });

    test('a file over 5 MB is refused without reading its content', async () => {
        const host = makeHost();
        const big = fileOf(Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(fonts.MAX_FONT_BYTES)]), 'big.ttf');
        await fonts.importFontFiles([big], host);
        expect(uploads).toHaveLength(0);
        expect(global.toastr.error).toHaveBeenCalledWith('TODO(copy)', 'big.ttf');
    });

    test('a font that the browser refuses is not uploaded', async () => {
        global.fontFaceResult = 'reject';
        const host = makeHost();
        await fonts.importFontFiles([font({ family: 'Broken' }, 'broken.ttf')], host);
        expect(uploads).toHaveLength(0);
        expect(host.save).not.toHaveBeenCalled();
    });

    test('the family given to the browser is a quoted, escaped string', async () => {
        const seen = [];
        const original = global.FontFace;
        global.FontFace = class extends original {
            constructor(...args) {
                super(...args);
                seen.push(args[0]);
            }
        };
        await fonts.importFontFiles([font({ family: 'Tom\'s Face' }, 'a.ttf')], makeHost());
        expect(seen).toEqual(['\'Tom\\27 s Face\'']);
    });

    test('a failed upload leaves the list as it was', async () => {
        global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'no', json: async () => ({}) }));
        const host = makeHost();
        await fonts.importFontFiles([font({ family: 'Nope' }, 'a.ttf')], host);
        expect(host.getFonts()).toEqual([]);
        expect(host.save).not.toHaveBeenCalled();
        expect(global.toastr.error).toHaveBeenCalledWith('TODO(copy)', 'a.ttf');
    });

    test('an upload path that is not a font path is discarded and its file deleted', async () => {
        global.fetch = jest.fn(async (url, init) => {
            if (url === '/api/files/delete') deletes.push(JSON.parse(init.body));
            return { ok: true, status: 200, json: async () => ({ path: '/user/files/elsewhere.txt' }), text: async () => '' };
        });
        const host = makeHost();
        await fonts.importFontFiles([font({ family: 'Odd' }, 'a.ttf')], host);
        expect(host.getFonts()).toEqual([]);
        expect(deletes).toEqual([]);
    });

    test('more than 20 files in one list are refused at once', async () => {
        const host = makeHost();
        const files = Array.from({ length: 21 }, (_, index) => font({ family: `F${index}` }, `f${index}.ttf`));
        expect(await fonts.importFontFiles(files, host)).toEqual([]);
        expect(uploads).toHaveLength(0);
        expect(global.toastr.error).toHaveBeenCalledWith('TODO(copy)');
    });

    test('the limit counts the files that are saved already', async () => {
        const saved = Array.from({ length: 20 }, (_, index) => entry({ id: `id${index}`, family: `Fam ${index}`, file: `/user/files/sb-font-${String(index).padStart(12, '0')}.woff2` }));
        const host = makeHost(saved);
        expect(await fonts.importFontFiles([font({ family: 'One More' }, 'a.ttf')], host)).toEqual([]);
        expect(uploads).toHaveLength(0);
    });

    test('the same family, weight and style replaces the older file, which is deleted after the save', async () => {
        const host = makeHost([entry({ family: 'Dup', file: '/user/files/sb-font-aaaaaaaaaaaa.ttf' })]);
        await fonts.importFontFiles([font({ family: 'Dup' }, 'again.ttf')], host);
        expect(host.getFonts()).toHaveLength(1);
        expect(host.getFonts()[0].file).not.toContain('aaaaaaaaaaaa');
        expect(deletes).toEqual([{ path: '/user/files/sb-font-aaaaaaaaaaaa.ttf' }]);
    });

    test('a readable file never opens the naming dialog', async () => {
        await fonts.importFontFiles([font({ family: 'Named' }, 'a.ttf')], makeHost());
        expect(openedDialogs).toHaveLength(0);
    });

    test('a file whose family cannot be read opens the naming dialog, and a cancel skips the file', async () => {
        const host = makeHost();
        await fonts.importFontFiles([font({ omitName: true }, 'Nameless-Bold.ttf')], host);
        expect(openedDialogs).toHaveLength(1);
        expect(openedDialogs[0].subtitle).toBe('Nameless-Bold.ttf');
        expect(openedDialogs[0].responses.affirmative.id).toBe('import');
        expect(uploads).toHaveLength(0);
        expect(host.save).not.toHaveBeenCalled();
    });
});

describe('deleting', () => {
    test('only a path from a normalised entry is sent', async () => {
        const host = makeHost();
        for (const file of ['../../config.yaml', '/user/files/../../config.yaml', '/user/files/other.woff2', '/user/images/sb-font-0123456789ab.woff2', '', undefined]) {
            expect(await fonts.deleteFontFile(host, { file })).toBe(false);
        }
        expect(deletes).toEqual([]);
        expect(await fonts.deleteFontFile(host, { file: FILE })).toBe(true);
        expect(deletes).toEqual([{ path: FILE }]);
    });

    test('a missing file counts as deleted, any other failure does not', async () => {
        const host = makeHost();
        global.deleteStatus = 404;
        expect(await fonts.deleteFontFile(host, { file: FILE })).toBe(true);
        global.deleteStatus = 500;
        expect(await fonts.deleteFontFile(host, { file: FILE })).toBe(false);
    });

    test('removing a font asks first, saves the list, applies Default when it was in use, then deletes the files', async () => {
        const host = makeHost([entry(), entry({ id: 'two', weight: 700, file: '/user/files/sb-font-bbbbbbbbbbbb.woff2' }), entry({ id: 'other', family: 'Other', file: '/user/files/sb-font-cccccccccccc.woff2' })]);
        host.setChoice('Test Face');
        alertResponse.mockResolvedValueOnce('delete');
        expect(await fonts.removeFontFamily('Test Face', host)).toBe(true);
        expect(alertResponse.mock.calls[0][0].responses.map(response => response.id)).toEqual(['cancel', 'delete']);
        expect(alertResponse.mock.calls[0][0].responses[1].appearance).toBe('destructive');
        expect(alertResponse.mock.calls[0][0].defaultResponse).toBeUndefined();
        expect(host.getFonts().map(font => font.family)).toEqual(['Other']);
        expect(host.getChoice()).toBe('');
        expect(host.save).toHaveBeenCalledTimes(1);
        expect(deletes.map(body => body.path).sort()).toEqual([FILE, '/user/files/sb-font-bbbbbbbbbbbb.woff2']);
    });

    test('cancelling the confirmation changes and deletes nothing', async () => {
        const host = makeHost([entry()]);
        host.setChoice('Test Face');
        alertResponse.mockResolvedValueOnce('cancel');
        expect(await fonts.removeFontFamily('Test Face', host)).toBe(false);
        expect(host.getFonts()).toHaveLength(1);
        expect(host.getChoice()).toBe('Test Face');
        expect(deletes).toEqual([]);
        expect(host.save).not.toHaveBeenCalled();
    });

    test('a failed delete keeps the list change and says so', async () => {
        const host = makeHost([entry()]);
        global.deleteStatus = 500;
        alertResponse.mockResolvedValueOnce('delete');
        await fonts.removeFontFamily('Test Face', host);
        expect(host.getFonts()).toEqual([]);
        expect(global.toastr.error).toHaveBeenCalledWith('Font not removed', 'Test Face');
    });

    test('a family that is not in the list asks nothing', async () => {
        expect(await fonts.removeFontFamily('Nobody', makeHost([entry()]))).toBe(false);
        expect(alertResponse).not.toHaveBeenCalled();
    });
});
