import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCard, cardOnGrid, cardPicture, differences, embedCard, gradientRow, loadAppCardParser, prepareCard, sameCardText, stampCardVersion, verifyCard } from '../lib/card.js';
import { decode, encode } from '../lib/codec.js';
import { isOpaque, samePixels, upscaleNearest } from '../lib/raster.js';
import { fixtureCard } from '../test-support/cards.js';
import { paint, pixelAt } from '../test-support/pictures.js';

const WORLD = 'SillyBunny Lexicon';
const FIGURE = [200, 120, 220, 255];

/** A native card master: a backdrop of two colours on the art grid, and a figure cut at the bottom edge, as at the waist. */
const nativeMaster = () => paint(8, 12, (x, y) => (x >= 2 && x < 6 && y >= 4 ? FIGURE : y < 6 ? [0xf5, 0xe9, 0xff, 255] : [0xd9, 0xc2, 0xf0, 255]));
const plainPng = () => encode(paint(4, 6, () => [200, 180, 240, 255], 3), 'png');

test('a card picture is its native master with every pixel drawn as scale by scale, stored as 8-bit RGB with no palette', async () => {
    const png = await cardPicture(nativeMaster(), 3);

    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]], [24, 36, 8, 2], 'width, height, bit depth and colour type 2 (RGB)');
    const decoded = await decode(png);
    assert.equal(decoded.channels, 3);
    assert.equal(samePixels(decoded, upscaleNearest(nativeMaster(), 3)), true, 'it decodes to exactly the enlarged master');
});

test('a card master with a transparent pixel, and a scale that is not a whole number of 1 or more, are refused', async () => {
    const holed = paint(8, 12, (x, y) => (x === 0 && y === 0 ? [0, 0, 0, 0] : FIGURE));

    await assert.rejects(cardPicture(holed, 3), { code: 'master-not-opaque' });
    for (const scale of [0, 1.5, -2]) {
        await assert.rejects(cardPicture(nativeMaster(), scale), { code: 'scale-invalid' }, String(scale));
    }
});

test('the build sets world and drops the embedded character book, and no other field of the card changes', () => {
    const source = fixtureCard({ book: true });
    const before = JSON.stringify(source);

    const { card, edits } = prepareCard(source, WORLD);

    assert.equal(JSON.stringify(source), before, 'the source object is not changed');
    assert.equal(card.data.extensions.world, WORLD);
    assert.equal('character_book' in card.data, false);
    assert.deepEqual(edits.map(({ path, change }) => [path, change]), [['data.extensions.world', 'set'], ['data.character_book', 'removed']]);
    assert.deepEqual(edits[0], { path: 'data.extensions.world', change: 'set', from: '', to: WORLD });
    assert.deepEqual(differences(source, card).map(({ path }) => path).sort(), [
        'data.character_book.entries.0.content', 'data.character_book.entries.0.enabled', 'data.character_book.entries.0.extensions', 'data.character_book.entries.0.insertion_order',
        'data.character_book.entries.0.keys.0', 'data.character_book.extensions', 'data.character_book.name', 'data.extensions.world',
    ]);
    assert.equal(JSON.stringify(card.data.description), JSON.stringify(source.data.description), 'the CRLF text is the same, byte for byte');
});

test('a card that already has the world and no book is left as it is, and the world may be missing altogether', () => {
    const source = fixtureCard({ world: WORLD });
    const { card, edits } = prepareCard(source, WORLD);
    assert.deepEqual([edits, card], [[], source]);

    const bare = fixtureCard();
    delete bare.data.extensions;
    const prepared = prepareCard(bare, WORLD);
    assert.equal(prepared.card.data.extensions.world, WORLD);
    assert.deepEqual(prepared.edits[0], { path: 'data.extensions.world', change: 'set', from: undefined, to: WORLD });
});

test('a file that is not a V3 card, or has no name, is refused', () => {
    const refused = (source, pattern) => assert.throws(() => prepareCard(source, WORLD), (error) => error.code === 'card-invalid' && pattern.test(error.message));

    refused({ ...fixtureCard(), spec: 'chara_card_v2' }, /not a V3 card: spec must be "chara_card_v3"/);
    refused({ ...fixtureCard(), spec_version: '2.0' }, /spec_version "3.0", got "chara_card_v3" and "2.0"/);
    refused([], /not a V3 card/);
    refused({ ...fixtureCard(), data: { ...fixtureCard().data, name: '' } }, /no data\.name/);
    refused({ ...fixtureCard(), data: { ...fixtureCard().data, extensions: [] } }, /data\.extensions .* must be an object/);
});

test('the card is written by the app\'s own writer: a chara chunk (V2) and a ccv3 chunk (V3) after the image data, which the app reads back', async () => {
    const { card } = prepareCard(fixtureCard({ book: true }), WORLD);
    const image = await plainPng();

    const built = await embedCard(image, card);

    const app = await loadAppCardParser();
    assert.ok(built.equals(app.write(image, JSON.stringify(card))), 'the same bytes as the app\'s writer gives');
    const chunks = app.extract(new Uint8Array(built));
    assert.deepEqual(chunks.filter(({ name }) => name === 'tEXt').map(({ data }) => app.decodeText(data).keyword), ['chara', 'ccv3'], 'in the order the app writes them');
    const names = chunks.map(({ name }) => name);
    assert.equal(names.at(-1), 'IEND');
    assert.ok(names.indexOf('tEXt') > names.lastIndexOf('IDAT'), 'the text chunks come after the image data');
    const read = JSON.parse(app.read(built));
    assert.deepEqual([read.spec, read.data.name], ['chara_card_v3', 'Fixture Bun']);
    assert.equal(samePixels(await decode(built), await decode(image)), true, 'the picture itself is untouched');
});

test('read back, every field is the card\'s own in both chunks, with world set and no character book', async () => {
    const source = fixtureCard({ book: true });
    const { card } = prepareCard(source, WORLD);

    const result = await verifyCard(await embedCard(await plainPng(), card), card, WORLD);

    assert.deepEqual(result.chunks, ['chara', 'ccv3']);
    assert.ok(result.fields >= 25);
    assert.deepEqual(differences(card, result.v3), []);
    assert.deepEqual([result.v2.spec, result.v2.spec_version], ['chara_card_v2', '2.0']);
    assert.deepEqual(differences({ ...card, spec: 'chara_card_v2', spec_version: '2.0' }, result.v2), []);
    assert.deepEqual(differences(source, result.v3).map(({ path }) => path).filter((path) => !path.startsWith('data.character_book')), ['data.extensions.world']);
    for (const field of Object.keys(source.data).filter((key) => !['extensions', 'character_book'].includes(key))) {
        assert.equal(JSON.stringify(result.v3.data[field]), JSON.stringify(source.data[field]), `data.${field}`);
        assert.equal(JSON.stringify(result.v2.data[field]), JSON.stringify(source.data[field]), `v2 data.${field}`);
    }
});

test('a card that does not read back as the one it was made from is refused, with every difference named', async () => {
    const { card } = prepareCard(fixtureCard(), WORLD);
    const built = await embedCard(await plainPng(), card);
    const changed = structuredClone(card);
    changed.data.description += ' (edited)';
    changed.data.extensions.world = 'Other';

    await assert.rejects(verifyCard(built, changed, WORLD), (error) => error.code === 'card-readback'
        && /ccv3 chunk: data\.description is .* expected .*\(edited\)/.test(error.message)
        && /chara chunk: data\.description/.test(error.message)
        && /data\.extensions\.world is "SillyBunny Lexicon", expected "Other"/.test(error.message));

    const withBook = structuredClone(card);
    withBook.data.character_book = { entries: [] };
    await assert.rejects(verifyCard(await embedCard(await plainPng(), withBook), card, WORLD), /data\.character_book is present/);

    const logged = [];
    const original = console.error;
    console.error = (...message) => logged.push(message.join(' '));
    try {
        await assert.rejects(verifyCard(await plainPng(), card, WORLD), /the text chunks are \[\][\s\S]*No PNG metadata/);
    } finally {
        console.error = original;
    }
    assert.deepEqual(logged, ['PNG metadata does not contain any text chunks.'], 'the app\'s reader logs this itself; the test keeps it off the output');
});

test('a card built from a native master reads back in the app field for field, with only world changed from the file', async () => {
    const source = fixtureCard({ book: true });

    const built = await buildCard({ master: nativeMaster(), scale: 3, source, world: WORLD });

    assert.deepEqual([built.chunks, built.edits.map(({ path }) => path)], [['chara', 'ccv3'], ['data.extensions.world', 'data.character_book']]);
    const { read } = await loadAppCardParser();
    const parsed = JSON.parse(read(built.png));
    assert.deepEqual(differences(source, parsed).map(({ path }) => path).filter((path) => !path.startsWith('data.character_book')), ['data.extensions.world']);
    assert.equal('character_book' in parsed.data, false);
    assert.equal(samePixels(await decode(built.png), upscaleNearest(nativeMaster(), 3)), true, 'the text chunks leave the picture as drawn');
});

test('a card file without the root fields the app mirrors from data is refused, because the app adds them and the card would not read back as the file', async () => {
    const { spec, spec_version: version, data } = fixtureCard({ name: 'Fixture Reisen' });

    await assert.rejects(buildCard({ master: nativeMaster(), scale: 3, source: { spec, spec_version: version, data }, world: WORLD }), (error) => error.code === 'card-readback'
        && /ccv3 chunk: name is "Fixture Reisen", expected undefined/.test(error.message));
});

test('building the same inputs again gives the same bytes', async () => {
    const input = { master: nativeMaster(), scale: 3, source: fixtureCard(), world: WORLD };

    const [one, two] = [await buildCard(input), await buildCard(input)];

    assert.ok(one.png.equals(two.png));
});

test('the gradient runs from its top colour on the first row to its bottom colour on the last, each channel rounded half up', () => {
    const gradient = { top: '#000010', bottom: '#ff0000' };

    assert.deepEqual([0, 1, 2].map((row) => gradientRow(gradient, row, 3)), [[0, 0, 16], [128, 0, 8], [255, 0, 0]]);
    assert.deepEqual(gradientRow(gradient, 0, 1), [0, 0, 16], 'a grid of one row is the top colour');
    assert.deepEqual(gradientRow({ top: '#f5e9ff', bottom: '#d9c2f0' }, 143, 288), [0xe7, 0xd6, 0xf8]);
});

test('the card on its grid is the crop of the sprite over the gradient, which shows wherever the crop reaches past the sprite', () => {
    const sprite = paint(4, 5, (x, y) => (x >= 1 && x < 3 && y >= 1 ? FIGURE : [0, 0, 0, 0]));
    const gradient = { top: '#000000', bottom: '#0000ff' };

    const card = cardOnGrid(sprite, { crop: [-1, -1, 4, 6], gradient });

    assert.deepEqual([card.width, card.height, card.channels, isOpaque(card)], [4, 6, 3, true]);
    for (let y = 0; y < 6; y++) {
        for (let x = 0; x < 4; x++) {
            const inFigure = x - 1 >= 1 && x - 1 < 3 && y - 1 >= 1;
            assert.deepEqual(pixelAt(card, x, y), inFigure ? FIGURE : [...gradientRow(gradient, y, 6), 255], `${x},${y}`);
        }
    }
});

test('a crop that cuts off the top of the figure, or whose last row misses the figure, is refused', () => {
    const sprite = paint(4, 5, (x, y) => (x >= 1 && x < 3 && y >= 1 ? FIGURE : [0, 0, 0, 0]));
    const gradient = { top: '#000000', bottom: '#0000ff' };

    assert.throws(() => cardOnGrid(sprite, { crop: [0, 2, 4, 3], gradient }, 'card-test'), (error) => error.code === 'card-cut-top' && error.details.asset === 'card-test' && /starts at row 1 of the master, above the crop's first row 2/.test(error.message));
    assert.throws(() => cardOnGrid(sprite, { crop: [0, 0, 4, 6], gradient }), (error) => error.code === 'card-waist' && /row 5 of the master, does not cut the figure, which ends at row 4/.test(error.message));
    assert.throws(() => cardOnGrid(sprite, { crop: [3, 0, 4, 5], gradient }), { code: 'card-waist' }, 'a crop beside the figure');
    assert.throws(() => cardOnGrid(paint(4, 5, () => [0, 0, 0, 0]), { crop: [0, 0, 4, 5], gradient }), { code: 'card-figure' });
});

test('a new version is written into a card\'s character_version by the app\'s writer, in the form the card had, and no other field or pixel changes', async () => {
    const { card } = prepareCard(fixtureCard(), WORLD);
    const png = await embedCard(await plainPng(), card);

    const stamped = await stampCardVersion(png, 2);

    const { read } = await loadAppCardParser();
    assert.deepEqual(differences(card, JSON.parse(read(stamped))), [{ path: 'data.character_version', expected: '1.0', actual: '2.0' }]);
    assert.deepEqual((await verifyCard(stamped, { ...card, data: { ...card.data, character_version: '2.0' } }, WORLD)).chunks, ['chara', 'ccv3'], 'both chunks carry it');
    assert.equal(samePixels(await decode(stamped), await decode(png)), true);
    const plain = await embedCard(await plainPng(), { ...card, data: { ...card.data, character_version: '1' } });
    assert.equal(JSON.parse(read(await stampCardVersion(plain, 3))).data.character_version, '3');
    await assert.rejects(quietly(() => stampCardVersion(Buffer.from('not a card'), 2)), { code: 'card-text-invalid' });
});

/** Runs `action` with the app's reader free to log, as it does for a picture that holds no card, without printing it. */
async function quietly(action) {
    const original = console.error;
    console.error = () => {};
    try {
        return await action();
    } finally {
        console.error = original;
    }
}

test('two card files carry the same card text only when their text chunks are equal, whatever their pictures', async () => {
    const { card } = prepareCard(fixtureCard(), WORLD);
    const one = await embedCard(await plainPng(), card);
    const other = await embedCard(await encode(paint(4, 6, () => [1, 2, 3, 255], 3), 'png'), card);
    const edited = await embedCard(await plainPng(), { ...card, data: { ...card.data, description: 'Another description.' } });

    assert.equal(await sameCardText(one, other), true, 'another picture with the same text');
    assert.equal(await sameCardText(one, edited), false);
    assert.equal(await sameCardText(one, await plainPng()), false, 'a picture with no text');
});

test('differences compares the JSON of the values, so equal empty lists match and a changed list does not', () => {
    assert.deepEqual(differences({ a: [], b: { c: 1 } }, { a: [], b: { c: 1 } }), []);
    assert.deepEqual(differences({ a: [1, 2] }, { a: [1, 3] }), [{ path: 'a.1', expected: 2, actual: 3 }]);
    assert.deepEqual(differences({ a: 1 }, { a: 1, b: 2 }), [{ path: 'b', expected: undefined, actual: 2 }]);
    assert.equal(differences({ a: '' }, { a: [] }).length, 1);
});
