import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rgbOf } from '../lib/card-entry.js';
import { mastersOf, outputsOf, picturesOf, validateManifest } from '../lib/manifest.js';
import { fakeSha, sampleManifest } from '../test-support/manifests.js';

const CARD_FILE = 'default/content/default_AssistantTest.png';

/** A card entry that passes: a 6x9 crop of the master shipped at scale 4, with its text read from the card file it ships. */
function cardEntry(extra = {}) {
    return {
        type: 'card',
        key: null,
        master: 'test/card-test.png',
        crop: [1, -1, 6, 9],
        grid: [6, 9],
        gradient: { top: '#f5e9ff', bottom: '#d9c2f0' },
        text: CARD_FILE,
        world: 'Test World',
        outputs: [{ path: CARD_FILE, encoding: 'png-card', scale: 4, sha256: fakeSha('d') }],
        ...extra,
    };
}

const withCard = (asset) => {
    const manifest = sampleManifest();
    manifest.assets['card-test'] = asset;
    return manifest;
};
const messages = (manifest) => validateManifest(manifest).map(({ message }) => message);

test('a card entry takes the sprite master, its crop at the grid, the gradient, the text source, the world and one card file', () => {
    const asset = cardEntry();

    assert.deepEqual(validateManifest(withCard(asset)), []);
    assert.deepEqual(mastersOf(asset), ['test/card-test.png']);
    assert.deepEqual(outputsOf(asset).map(({ path }) => path), [CARD_FILE]);
    assert.deepEqual(picturesOf(asset).map(({ role, master }) => [role, master]), [['base', 'test/card-test.png']]);
});

test('each fault of a card entry is named', () => {
    const output = cardEntry().outputs[0];
    const cases = [
        [{ key: 'home' }, 'key must be null'],
        [{ size: [768, 1152] }, 'unknown key "size"'],
        [{ master: '../card.png' }, 'must be a path inside assets-src/art/master'],
        [{ crop: [1, -1, 6] }, 'crop must be [left, top, width, height]'],
        [{ crop: [1, -1.5, 6, 9] }, 'crop must be [left, top, width, height]'],
        [{ crop: [1, -1, 0, 9] }, 'crop must be [left, top, width, height]'],
        [{ crop: [1, -1, 6, 8] }, 'The crop is 6x8, but the grid is 6x9'],
        [{ grid: [6] }, 'grid must be'],
        [{ gradient: { top: '#F5E9FF', bottom: '#d9c2f0' } }, 'gradient must be'],
        [{ gradient: { top: '#f5e9ff' } }, 'gradient must be'],
        [{ gradient: { top: '#f5e9ff', bottom: '#d9c2f0', middle: '#ffffff' } }, 'gradient must be'],
        [{ text: 'default/content/Assistant Test.json' }, 'text must be the path of the card file'],
        [{ text: '../outside.png' }, 'text must be the path of the card file'],
        [{ world: '' }, 'world must name'],
        [{ outputs: [output, { ...output, path: 'default/content/other.png' }] }, 'exactly one file'],
        [{ outputs: [{ ...output, encoding: 'png' }] }, 'exactly one file'],
        [{ outputs: [{ ...output, path: 'default/content/Test/card.png' }] }, 'exactly one file'],
        [{ outputs: [{ ...output, path: 'public/img/sillybunny/card.png' }] }, 'exactly one file'],
        [{ outputs: [{ ...output, scale: 1.5 }] }, 'must be a whole number of 1 or more'],
        [{ outputs: [{ ...output, sha256: 'abc' }] }, '64 lowercase hex'],
    ];
    for (const [change, expected] of cases) {
        const found = messages(withCard(cardEntry(change)));
        assert.ok(found.some((message) => message.includes(expected)), `${JSON.stringify(change)}: ${found.join(' | ')}`);
    }
});

test('a card ships a file that no other asset ships', () => {
    const manifest = withCard(cardEntry({ outputs: [{ path: 'default/content/default_AssistantTest.png', encoding: 'png-card', scale: 4, sha256: fakeSha('d') }] }));
    manifest.assets['card-other'] = cardEntry({ master: 'test/card-other.png' });

    assert.ok(messages(manifest).some((message) => message.includes('is also an output of card-test')));
});

test('a gradient colour is read as its three channels', () => {
    assert.deepEqual(rgbOf('#f5e9ff'), [0xf5, 0xe9, 0xff]);
    assert.deepEqual(rgbOf('#000a10'), [0, 10, 16]);
});
