import assert from 'node:assert/strict';
import sharp from 'sharp';
import { test } from 'node:test';
import { resolveBackground } from '../scripts/lib/background.mjs';
import { pngHasAlpha } from '../scripts/lib/images.mjs';

const TRANSPARENT = 'fully transparent';
const GREEN = 'flat pure green #00FF00';

test('a transparent background in the prompt makes OpenAI ask for a transparent PNG, and any other text asks for nothing', () => {
    assert.equal(resolveBackground({ provider: 'openai', promptBackground: TRANSPARENT }), 'transparent');
    assert.equal(resolveBackground({ provider: 'openai', promptBackground: GREEN }), undefined);
    assert.equal(resolveBackground({ provider: 'openai' }), undefined);
    assert.equal(resolveBackground({ requested: 'auto', provider: 'openai', promptBackground: TRANSPARENT }), 'transparent');
});

test('an explicit --background must agree with what the prompt says', () => {
    assert.equal(resolveBackground({ requested: 'transparent', provider: 'openai', promptBackground: TRANSPARENT }), 'transparent');
    assert.equal(resolveBackground({ requested: 'transparent', provider: 'openai' }), 'transparent', 'a template with no background wording just obeys the flag');
    assert.equal(resolveBackground({ requested: 'opaque', provider: 'openai', promptBackground: GREEN }), 'opaque');
    assert.throws(() => resolveBackground({ requested: 'transparent', provider: 'openai', promptBackground: GREEN }), /prompt asks for "flat pure green #00FF00"/);
    assert.throws(() => resolveBackground({ requested: 'opaque', provider: 'openai', promptBackground: TRANSPARENT }), /prompt asks for a transparent background/);
});

test('Gemini cannot make a transparent picture, so the run stops and names the green-key fallback', () => {
    for (const config of [{ promptBackground: TRANSPARENT }, { requested: 'transparent' }]) {
        assert.throws(() => resolveBackground({ provider: 'gemini', ...config }), /Gemini has no transparent output.*--vars background="flat pure green #00FF00".*key-bg/s);
    }
    assert.equal(resolveBackground({ provider: 'gemini', promptBackground: GREEN }), undefined);
});

const rgba = (channels, extra = {}) => sharp({ create: { width: 2, height: 2, channels, background: channels === 4 ? { r: 1, g: 2, b: 3, alpha: 0.5 } : { r: 1, g: 2, b: 3 }, ...extra } });

test('a PNG with an alpha channel, grey-alpha or a transparent palette entry has transparency; an RGB PNG, JPEG and junk do not', async () => {
    assert.equal(pngHasAlpha(await rgba(4).png().toBuffer()), true);
    assert.equal(pngHasAlpha(await rgba(3).png().toBuffer()), false);
    assert.equal(pngHasAlpha(await rgba(3).greyscale().png().toBuffer()), false);
    assert.equal(pngHasAlpha(await rgba(4).greyscale().png().toBuffer()), true);
    assert.equal(pngHasAlpha(await rgba(4).png({ palette: true }).toBuffer()), true);
    assert.equal(pngHasAlpha(await rgba(3).png({ palette: true }).toBuffer()), false);
    assert.equal(pngHasAlpha(await rgba(3).jpeg().toBuffer()), false);
    assert.equal(pngHasAlpha(Buffer.from('not an image')), false);
});
