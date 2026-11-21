/* eslint-disable jest/no-standalone-expect -- the Brotli cases are chosen by an aliased test function. */
import zlib from 'node:zlib';
import { describe, expect, jest, test } from '@jest/globals';
import { buildFontTables, buildSfnt, buildWoff, buildWoff2, fvarTable, withSignature } from '../helpers/font-fixtures.js';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
}));

const fonts = await import('../../public/scripts/sillybunny-fonts.js');

const bytes = buffer => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
const FILE = '/user/files/sb-font-0123456789ab.woff2';
const entry = (overrides = {}) => ({ id: 'abc', family: 'Test Face', file: FILE, weight: 400, style: 'normal', format: 'woff2', ...overrides });

describe('family names and CSS', () => {
    test('a name loses controls, bidi marks and repeated spaces, and is cut to 64 characters', () => {
        expect(fonts.sanitizeFamilyName('  My\u0000 ‮Font\n\tName  ')).toBe('My Font Name');
        expect(fonts.sanitizeFamilyName('x'.repeat(100))).toHaveLength(64);
        expect(fonts.sanitizeFamilyName('\u0001\u0002')).toBe('');
        expect(fonts.sanitizeFamilyName(null)).toBe('');
    });

    test('a CSS string writes quotes, backslashes, braces, semicolons and angle brackets as escapes', () => {
        const literal = fonts.cssString('Evil\'};</style><b>\\');
        expect(literal).toMatch(/^'[^']*'$/);
        expect(literal).not.toMatch(/[};<>\\](?![0-9a-f])/);
        expect(literal).toContain('\\27 ');
        expect(literal).toContain('\\5c ');
        expect(fonts.cssString('Public Sans')).toBe('\'Public Sans\'');
    });

    test('a hostile family cannot end its string or open a rule in the face rules or the stack', () => {
        const hostile = 'a\'); } body { display: none } /*';
        const rules = fonts.buildFontFaceRules([entry({ family: hostile })]);
        expect(rules.match(/@font-face/g)).toHaveLength(1);
        expect(rules).not.toContain('display: none');
        expect(rules.split('{')).toHaveLength(2);
        expect(fonts.buildFontStack(hostile)).not.toMatch(/\) *\}|display: none/);
        expect(fonts.buildFontStack('Inter')).toBe('\'Inter\', \'Adwaita Sans\', system-ui, sans-serif');
    });

    test('a face rule names its url, format, weight, style and swap', () => {
        const [rule] = fonts.buildFontFaceRules([entry({ weight: '100 900', style: 'italic' })]).split('\n');
        expect(rule).toBe('@font-face{font-family:\'Test Face\';src:url(\'\\2f user\\2f files\\2f sb-font-0123456789ab.woff2\') format(\'woff2\');font-weight:100 900;font-style:italic;font-display:swap}');
    });
});

describe('the saved list', () => {
    test('weights are one number from 1 to 1000 or an ordered range', () => {
        expect(fonts.normalizeWeight(400)).toBe(400);
        expect(fonts.normalizeWeight('700')).toBe(700);
        expect(fonts.normalizeWeight('100 900')).toBe('100 900');
        for (const bad of [0, 1001, 1.5, '900 100', '100  900', '100 900 1', 'bold', null, undefined, NaN]) expect(fonts.normalizeWeight(bad)).toBeNull();
    });

    test('anything that is not a list of well-formed entries is dropped', () => {
        expect(fonts.normalizeFonts(undefined)).toEqual([]);
        expect(fonts.normalizeFonts({})).toEqual([]);
        expect(fonts.normalizeFonts([null, 3, 'x', [], entry()])).toEqual([entry()]);
        const bad = [
            entry({ id: '' }), entry({ id: 'a b' }), entry({ file: '../../etc/passwd' }), entry({ file: '/user/files/other.woff2' }),
            entry({ file: '/user/images/sb-font-0123456789ab.woff2' }), entry({ file: '/user/files/sb-font-0123456789ab.exe' }),
            entry({ file: '/user/files/sb-font-0123456789ab.woff2?x' }), entry({ file: '/user/files/../sb-font-0123456789ab.woff2' }),
            entry({ weight: 'bold' }), entry({ style: 'oblique' }), entry({ family: '\u0000' }), entry({ family: undefined }),
        ];
        expect(fonts.normalizeFonts(bad)).toEqual([]);
    });

    test('the format follows the file extension, not the saved format', () => {
        expect(fonts.normalizeFonts([entry({ file: '/user/files/sb-font-0123456789ab.ttf', format: 'woff2' })])[0].format).toBe('truetype');
    });

    test('a duplicate id or file is dropped, a name is sanitised and the list is capped at 20', () => {
        expect(fonts.normalizeFonts([entry(), entry(), entry({ id: 'other' })])).toHaveLength(1);
        expect(fonts.normalizeFonts([entry({ family: ' A\u0000  B ' })])[0].family).toBe('A B');
        const many = Array.from({ length: 30 }, (_, index) => entry({ id: `id${index}`, file: `/user/files/sb-font-${String(index).padStart(12, '0')}.woff2` }));
        expect(fonts.normalizeFonts(many)).toHaveLength(20);
    });

    test('a normalised list is a fixed point', () => {
        const once = fonts.normalizeFonts([entry({ file: 'user/files/sb-font-0123456789ab.woff2' })]);
        expect(fonts.normalizeFonts(once)).toEqual(once);
    });

    test('families are listed once each, in order', () => {
        expect(fonts.listImportedFamilies([entry({ family: 'Zed' }), entry({ id: 'b', family: 'Alpha' }), entry({ id: 'c', family: 'Zed' })])).toEqual(['Alpha', 'Zed']);
    });
});

describe('resolving the saved choice', () => {
    const imported = [entry({ family: 'Mine' })];

    test('an imported family wins, then a preset by its exact name, then the Google path', () => {
        expect(fonts.resolveFont('Mine', imported)).toEqual({ kind: 'imported', name: 'Mine' });
        expect(fonts.resolveFont('Inter', imported)).toMatchObject({ kind: 'preset', name: 'Inter', preset: { directory: 'Inter' } });
        expect(fonts.resolveFont('Inter', [entry({ family: 'Inter' })]).kind).toBe('imported');
        expect(fonts.resolveFont('Lobster', imported)).toEqual({ kind: 'google', name: 'Lobster' });
        expect(fonts.resolveFont('', imported)).toEqual({ kind: 'none', name: '' });
        expect(fonts.resolveFont('  ', imported).kind).toBe('none');
    });

    test('a name that differs from a preset only by case or spacing is not a preset until it is rewritten', () => {
        expect(fonts.resolveFont('inter', [])).toEqual({ kind: 'google', name: 'inter' });
    });

    test('the near-preset rewrite compares case and spacing only, imported families first', () => {
        expect(fonts.canonicalFontName('inter', [])).toBe('Inter');
        expect(fonts.canonicalFontName('  public   SANS ', [])).toBe('Public Sans');
        expect(fonts.canonicalFontName('source serif 4', [])).toBe('Source Serif 4');
        expect(fonts.canonicalFontName('jetbrains mono', [])).toBe('JetBrains Mono');
        expect(fonts.canonicalFontName('mine', imported)).toBe('Mine');
        expect(fonts.canonicalFontName('Inter', [entry({ family: 'INTER' })])).toBe('Inter');
        expect(fonts.canonicalFontName('PublicSans', [])).toBe('PublicSans');
        expect(fonts.canonicalFontName('Lobster', [])).toBe('Lobster');
        expect(fonts.canonicalFontName(' Lobster ', [])).toBe('Lobster');
        expect(fonts.canonicalFontName('', imported)).toBe('');
        expect(fonts.canonicalFontName(undefined, imported)).toBe('');
    });

    test('each preset names a stylesheet folder under webfonts', () => {
        expect(fonts.FONT_PRESETS.map(preset => preset.directory)).toEqual(['Inter', 'JetBrainsMono', 'Roboto', 'PublicSans', 'SourceSerif4']);
        expect(fonts.buildPresetHref(fonts.FONT_PRESETS[1])).toBe(`webfonts/JetBrainsMono/stylesheet.css?v=${fonts.PRESET_STYLESHEET_KEY}`);
    });

    test('the legacy href is the Google stylesheet of the name', () => {
        expect(fonts.buildGoogleFontHref('Open  Sans')).toBe('https://fonts.googleapis.com/css2?family=Open%20Sans:wght@400;500;600;700&display=swap');
        expect(fonts.buildGoogleFontHref('')).toBe('');
    });
});

describe('checking a file before it is read or sent', () => {
    const check = (name, data, size = data?.length ?? 0) => fonts.validateFontFile({ name, size }, data);

    test('the extension must be one of the four', () => {
        for (const name of ['a.exe', 'a.ttc', 'a.otc', 'a.svg', 'a', 'a.woff2.exe', '.woff2x']) {
            expect(check(name, bytes(withSignature('wOF2')))).toEqual({ ok: false, reason: 'extension' });
        }
        expect(check('A.WOFF2', bytes(withSignature('wOF2')))).toMatchObject({ ok: true, extension: 'woff2', format: 'woff2' });
    });

    test('the first four bytes must name the container that the extension names', () => {
        expect(check('a.woff', bytes(withSignature('wOFF')))).toMatchObject({ ok: true, format: 'woff' });
        expect(check('a.ttf', bytes(Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(60)])))).toMatchObject({ ok: true, format: 'truetype' });
        expect(check('a.ttf', bytes(withSignature('true')))).toMatchObject({ ok: true, format: 'truetype' });
        expect(check('a.otf', bytes(withSignature('OTTO')))).toMatchObject({ ok: true, format: 'opentype' });
        expect(check('a.woff2', bytes(withSignature('wOFF')))).toEqual({ ok: false, reason: 'mismatch' });
        expect(check('a.otf', bytes(withSignature('true')))).toEqual({ ok: false, reason: 'mismatch' });
        expect(check('a.ttf', bytes(withSignature('<svg')))).toEqual({ ok: false, reason: 'signature' });
        expect(check('a.ttf', bytes(withSignature('MZ', 64)))).toEqual({ ok: false, reason: 'signature' });
    });

    test('a collection is refused, whatever its extension', () => {
        expect(check('a.ttf', bytes(withSignature('ttcf')))).toEqual({ ok: false, reason: 'collection' });
        expect(check('a.otf', bytes(withSignature('ttcf')))).toEqual({ ok: false, reason: 'collection' });
    });

    test('an empty file and a file over 5 MB are refused', () => {
        expect(check('a.ttf', new Uint8Array(0), 0)).toEqual({ ok: false, reason: 'empty' });
        expect(check('a.woff2', bytes(withSignature('wOF2')), fonts.MAX_FONT_BYTES + 1)).toEqual({ ok: false, reason: 'size' });
        expect(check('a.woff2', bytes(withSignature('wOF2', fonts.MAX_FONT_BYTES + 1)))).toEqual({ ok: false, reason: 'size' });
        expect(check('a.woff2', bytes(withSignature('wOF2', fonts.MAX_FONT_BYTES)))).toMatchObject({ ok: true });
    });
});

describe('the table reader', () => {
    const read = buffer => fonts.readFontMetadata(bytes(buffer));

    test('a static TrueType file gives its family, weight and style', async () => {
        expect(await read(buildFontTables({ family: 'Test Face', weight: 700, italic: true, subfamily: 'Bold Italic' }).build())).toEqual({ family: 'Test Face', weight: 700, style: 'italic' });
        expect(await read(buildFontTables({ family: 'Plain', weight: 300 }).build())).toEqual({ family: 'Plain', weight: 300, style: 'normal' });
    });

    test('name ID 16 wins over ID 1', async () => {
        const font = buildFontTables({ family: 'Inter', typographic: true, legacyFamily: 'Inter Light', subfamily: 'Light', weight: 300 });
        expect(await read(font.build())).toMatchObject({ family: 'Inter', weight: 300 });
    });

    test('a Macintosh-only name table is read', async () => {
        expect(await read(buildFontTables({ family: 'Mac Face', platform: 1 }).build())).toMatchObject({ family: 'Mac Face' });
    });

    test('a variable font gives its weight axis as a range', async () => {
        expect(await read(buildFontTables({ family: 'Var', fvar: fvarTable(100, 900) }).build())).toMatchObject({ family: 'Var', weight: '100 900' });
        expect(await read(buildFontTables({ family: 'Flat', weight: 500, fvar: fvarTable(400, 400) }).build())).toMatchObject({ weight: 500 });
    });

    test('without an OS/2 table the head table gives the style and the weight is 400', async () => {
        expect(await read(buildFontTables({ family: 'Old', italic: true, omitOs2: true }).build())).toEqual({ family: 'Old', weight: 400, style: 'italic' });
    });

    test('an unreadable family gives null: no name table, a collection, noise, a short file', async () => {
        expect(await read(buildFontTables({ omitName: true }).build())).toBeNull();
        expect(await read(Buffer.from('not a font at all'))).toBeNull();
        expect(await read(Buffer.alloc(0))).toBeNull();
        expect(await read(buildFontTables().build().subarray(0, 20))).toBeNull();
        expect(await read(buildSfnt(buildFontTables().tables, Buffer.from('ttcf')))).toBeNull();
    });

    test('a table whose offset or length leaves the file gives null, not an exception', async () => {
        const file = buildFontTables().build();
        const broken = Buffer.from(file);
        for (let index = 0; index < broken.readUInt16BE(4); index++) {
            const record = 12 + index * 16;
            if (broken.toString('latin1', record, record + 4) === 'name') broken.writeUInt32BE(0xfffffff0, record + 8);
        }
        expect(await read(broken)).toBeNull();
        const huge = Buffer.from(file);
        for (let index = 0; index < huge.readUInt16BE(4); index++) {
            const record = 12 + index * 16;
            if (huge.toString('latin1', record, record + 4) === 'name') huge.writeUInt32BE(0x7fffffff, record + 12);
        }
        expect(await read(huge)).toBeNull();
        const count = Buffer.from(file);
        count.writeUInt16BE(60000, 4);
        expect(await read(count)).toBeNull();
    });

    test('a name record that points outside the table is skipped', async () => {
        const font = buildFontTables({ family: 'Ok' });
        const name = Buffer.from(font.tables.get('name'));
        for (let index = 0; index < name.readUInt16BE(2); index++) name.writeUInt16BE(0xfff0, 6 + index * 12 + 10);
        font.tables.set('name', name);
        expect(await read(font.build())).toBeNull();
    });

    test('a WOFF file is read through its inflated tables', async () => {
        const font = buildFontTables({ family: 'Wrapped', weight: 600, italic: true, subfamily: 'SemiBold Italic' });
        expect(await read(buildWoff(font.tables))).toEqual({ family: 'Wrapped', weight: 600, style: 'italic' });
    });

    /** How many inflate streams the reader opens for a file. */
    async function countInflations(buffer) {
        const Original = global.DecompressionStream;
        let opened = 0;
        global.DecompressionStream = class extends Original {
            constructor(...args) {
                super(...args);
                opened++;
            }
        };
        try {
            await read(buffer);
        } finally {
            global.DecompressionStream = Original;
        }
        return opened;
    }

    test('a WOFF table that declares more than 1 MB is refused before it is inflated', async () => {
        const font = buildFontTables({ family: 'Bomb' });
        const bomb = buildWoff(font.tables, { originalLengthOverride: { name: 50 * 1024 * 1024 } });
        expect(await read(bomb)).toBeNull();
        // The name table sorts after OS/2 and head, so an honest file opens three streams and the bomb stops at its own.
        expect(await countInflations(buildWoff(font.tables))).toBe(3);
        expect(await countInflations(bomb)).toBe(2);
    });

    test('a WOFF table that inflates past its declared size, or short of it, gives null', async () => {
        const font = buildFontTables({ family: 'Liar' });
        const nameLength = font.tables.get('name').length;
        expect(await read(buildWoff(font.tables, { originalLengthOverride: { name: nameLength - 5 } }))).toBeNull();
        expect(await read(buildWoff(font.tables, { originalLengthOverride: { name: nameLength + 5 } }))).toBeNull();
    });

    const whereBrotli = fonts.canReadWoff2() ? test : test.skip;
    const whereNoBrotli = fonts.canReadWoff2() ? test.skip : test;

    whereBrotli('WOFF2 is read where this runtime can inflate Brotli', async () => {
        expect(await read(buildWoff2(buildFontTables({ family: 'Two', weight: 800 }).tables))).toEqual({ family: 'Two', weight: 800, style: 'normal' });
    });

    whereNoBrotli('WOFF2 gives null where this runtime cannot inflate Brotli', async () => {
        expect(await read(buildWoff2(buildFontTables({ family: 'Two' }).tables))).toBeNull();
    });

    whereBrotli('a WOFF2 file with a cut stream, or a stream that is not the size its directory says, gives null', async () => {
        const tables = buildFontTables({ family: 'Two' }).tables;
        const wrapped = buildWoff2(tables);
        expect(await read(wrapped.subarray(0, wrapped.length - 6))).toBeNull();
        const wrongSize = Buffer.from(wrapped);
        wrongSize.writeUInt32BE(wrongSize.readUInt32BE(20) + 100, 20);
        expect(await read(wrongSize)).toBeNull();
        const short = buildWoff2(tables);
        const stream = zlib.brotliCompressSync(Buffer.from('too short'));
        expect(await read(Buffer.concat([short.subarray(0, short.length - (short.readUInt32BE(20))), stream]))).toBeNull();
    });

    test('the WOFF2 tag table has the 63 entries of the specification', () => {
        expect(fonts.WOFF2_KNOWN_TAGS).toHaveLength(63);
        expect(fonts.WOFF2_KNOWN_TAGS[0]).toBe('cmap');
        expect(fonts.WOFF2_KNOWN_TAGS[5]).toBe('name');
        expect(fonts.WOFF2_KNOWN_TAGS[6]).toBe('OS/2');
        expect(fonts.WOFF2_KNOWN_TAGS[47]).toBe('fvar');
        expect(fonts.WOFF2_KNOWN_TAGS[62]).toBe('Sill');
    });
});

describe('a guess from the file name', () => {
    test.each([
        ['Inter-BoldItalic.woff2', { family: 'Inter', weight: 700, style: 'italic' }],
        ['Inter-Regular.ttf', { family: 'Inter', weight: 400, style: 'normal' }],
        ['Roboto-ExtraLight.ttf', { family: 'Roboto', weight: 200, style: 'normal' }],
        ['Lato_SemiBold-Italic.otf', { family: 'Lato', weight: 600, style: 'italic' }],
        ['Foo[wght].woff2', { family: 'Foo', weight: 400, style: 'normal' }],
        ['InterVariable.woff2', { family: 'Inter', weight: '100 900', style: 'normal' }],
        ['JetBrainsMono-Italic[wght].woff2', { family: 'JetBrainsMono', weight: 400, style: 'italic' }],
        ['NoStyle.woff', { family: 'NoStyle', weight: 400, style: 'normal' }],
    ])('%s', (name, expected) => {
        expect(fonts.guessFromFileName(name)).toEqual(expected);
    });
});
