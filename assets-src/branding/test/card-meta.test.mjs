import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { differences, embedCard, loadAppCardParser, prepareCard, verifyCard } from '../scripts/lib/card-meta.mjs';
import { fixtureCard } from '../test-support/card-fixture.mjs';

const WORLD = 'SillyBunny Lexicon';
const png = () => sharp({ create: { width: 24, height: 36, channels: 3, background: { r: 200, g: 180, b: 240 } } }).png().toBuffer();

test('the build sets world and drops the embedded character book, and no other field of the card changes', () => {
    const source = fixtureCard({ book: true });
    const before = JSON.stringify(source);
    const { card, edits } = prepareCard(source, WORLD);
    assert.equal(JSON.stringify(source), before, 'the source object is not changed');
    assert.equal(card.data.extensions.world, WORLD);
    assert.equal('character_book' in card.data, false);
    assert.deepEqual(edits.map(({ path, change }) => [path, change]), [['data.extensions.world', 'set'], ['data.character_book', 'removed']]);
    assert.deepEqual(edits[0], { path: 'data.extensions.world', change: 'set', from: '', to: WORLD });
    assert.deepEqual(differences(source, card).map(({ path }) => path).sort(), ['data.character_book.entries.0.content', 'data.character_book.entries.0.enabled', 'data.character_book.entries.0.extensions', 'data.character_book.entries.0.insertion_order', 'data.character_book.entries.0.keys.0', 'data.character_book.extensions', 'data.character_book.name', 'data.extensions.world']);
    const untouched = (text) => JSON.stringify(text);
    assert.equal(untouched(card.data.description), untouched(source.data.description), 'the CRLF text is byte for byte the same');
});

test('a card that already has the world and no book is left as it is, and the world may be missing altogether', () => {
    const source = fixtureCard({ world: WORLD });
    const { card, edits } = prepareCard(source, WORLD);
    assert.deepEqual(edits, []);
    assert.deepEqual(card, source);
    const bare = fixtureCard();
    delete bare.data.extensions;
    const prepared = prepareCard(bare, WORLD);
    assert.equal(prepared.card.data.extensions.world, WORLD);
    assert.deepEqual(prepared.edits[0], { path: 'data.extensions.world', change: 'set', from: undefined, to: WORLD });
});

test('a file that is not a V3 card, or has no name, is refused', () => {
    assert.throws(() => prepareCard({ ...fixtureCard(), spec: 'chara_card_v2' }, WORLD), /not a V3 card: spec must be "chara_card_v3"/);
    assert.throws(() => prepareCard({ ...fixtureCard(), spec_version: '2.0' }, WORLD), /spec_version "3.0", got "chara_card_v3" and "2.0"/);
    assert.throws(() => prepareCard([], WORLD), /not a V3 card/);
    assert.throws(() => prepareCard({ ...fixtureCard(), data: { ...fixtureCard().data, name: '' } }, WORLD), /no data\.name/);
    assert.throws(() => prepareCard({ ...fixtureCard(), data: { ...fixtureCard().data, extensions: [] } }, WORLD), /data\.extensions .* must be an object/);
});

test('the card is written by the app\'s own writer: a chara chunk (V2) and a ccv3 chunk (V3), and the app\'s parser reads it back', async () => {
    const { card } = prepareCard(fixtureCard({ book: true }), WORLD);
    const image = await png();
    const built = await embedCard(image, card);
    const app = await loadAppCardParser();
    assert.ok(built.equals(app.write(image, JSON.stringify(card))), 'the same bytes as the app\'s writer gives');
    const keywords = app.extract(new Uint8Array(built)).filter(({ name }) => name === 'tEXt').map(({ data }) => app.decodeText(data).keyword);
    assert.deepEqual(keywords, ['chara', 'ccv3'], 'the order the app writes them in');
    const names = app.extract(new Uint8Array(built)).map(({ name }) => name);
    assert.equal(names.at(-1), 'IEND');
    assert.ok(names.indexOf('tEXt') > names.lastIndexOf('IDAT'), 'the text chunks come after the image data');
    const read = JSON.parse(app.read(built));
    assert.equal(read.spec, 'chara_card_v3');
    assert.equal(read.data.name, 'Fixture Bun');
    assert.equal((await sharp(built).metadata()).hasAlpha, false, 'the picture itself is untouched');
});

test('read back, every field is the card\'s own in both chunks, with world set and no character book', async () => {
    const source = fixtureCard({ book: true });
    const { card } = prepareCard(source, WORLD);
    const built = await embedCard(await png(), card);
    const result = await verifyCard(built, card, WORLD);
    assert.deepEqual(result.chunks, ['chara', 'ccv3']);
    assert.ok(result.fields >= 25);
    assert.deepEqual(differences(card, result.v3), []);
    assert.equal(result.v2.spec, 'chara_card_v2');
    assert.equal(result.v2.spec_version, '2.0');
    assert.deepEqual(differences({ ...card, spec: 'chara_card_v2', spec_version: '2.0' }, result.v2), []);
    // The user's fields: every one of the source's, byte for byte, except the two the build edits.
    const edited = differences(source, result.v3).map(({ path }) => path).filter((path) => !path.startsWith('data.character_book'));
    assert.deepEqual(edited, ['data.extensions.world']);
    for (const field of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'tags', 'creatorcomment', 'talkativeness', 'fav', 'create_date']) {
        assert.equal(JSON.stringify(result.v3[field]), JSON.stringify(source[field]), `root ${field}`);
    }
    for (const field of Object.keys(source.data).filter((key) => !['extensions', 'character_book'].includes(key))) {
        assert.equal(JSON.stringify(result.v3.data[field]), JSON.stringify(source.data[field]), `data.${field}`);
        assert.equal(JSON.stringify(result.v2.data[field]), JSON.stringify(source.data[field]), `v2 data.${field}`);
    }
    assert.equal(JSON.stringify(result.v3.data.extensions.depth_prompt), JSON.stringify(source.data.extensions.depth_prompt));
});

test('a card that does not read back as the one it was made from is refused, with every difference named', async () => {
    const { card } = prepareCard(fixtureCard(), WORLD);
    const built = await embedCard(await png(), card);
    const changed = structuredClone(card);
    changed.data.description += ' (edited)';
    changed.data.extensions.world = 'Other';
    await assert.rejects(verifyCard(built, changed, WORLD), (error) => /ccv3 chunk: data\.description is .* expected .*\(edited\)/.test(error.message) && /chara chunk: data\.description/.test(error.message) && /data\.extensions\.world is "SillyBunny Lexicon", expected "Other"/.test(error.message));
    const withBook = structuredClone(card);
    withBook.data.character_book = { entries: [] };
    const bookBuilt = await embedCard(await png(), withBook);
    await assert.rejects(verifyCard(bookBuilt, card, WORLD), /data\.character_book is present/);
    const logged = [];
    const original = console.error;
    console.error = (...message) => logged.push(message.join(' '));
    try {
        await assert.rejects(verifyCard(await png(), card, WORLD), /No PNG metadata/);
    } finally {
        console.error = original;
    }
    assert.deepEqual(logged, ['PNG metadata does not contain any text chunks.'], 'the app\'s reader logs this itself; the test keeps it off the output');
});

test('differences compares the JSON of the values, so equal empty lists match and a changed list does not', () => {
    assert.deepEqual(differences({ a: [], b: { c: 1 } }, { a: [], b: { c: 1 } }), []);
    assert.deepEqual(differences({ a: [1, 2] }, { a: [1, 3] }), [{ path: 'a.1', expected: 2, actual: 3 }]);
    assert.deepEqual(differences({ a: 1 }, { a: 1, b: 2 }), [{ path: 'b', expected: undefined, actual: 2 }]);
    assert.deepEqual(differences({ a: '' }, { a: [] }).length, 1);
});
