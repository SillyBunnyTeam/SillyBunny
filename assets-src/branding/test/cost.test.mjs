import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../scripts/lib/config.mjs';
import { assertWithinCap, estimateBatch } from '../scripts/lib/cost.mjs';

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'config.json');
const config = parseConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')));

test('the shipped config loads, locks Sunburst and has a positive dollar cap', () => {
    assert.equal(config.lockedModel, 'gpt-image-2.5-sunburst-h');
    assert.ok(config.costCapUsd > 0, 'the owner sets the cap, so only its presence is checked');
    assert.deepEqual(Object.keys(config.models).sort(), [
        'gemini-3-pro-image-preview', 'gemini-nano-banana-2.1', 'gpt-image-2.5-flare-h', 'gpt-image-2.5-sunburst-h',
    ]);
});

test('per-image models cost count times 0.20', () => {
    const batch = estimateBatch(config, { model: 'gpt-image-2.5-sunburst-h', n: 4, size: '1024x1536', promptChars: 900, refCount: 0 });
    assert.equal(batch.totalUsd, 0.8);
    assert.equal(batch.perImageUsd, 0.2);
    assert.equal(batch.isEstimate, false);
});

test('the per-request Pro model applies the 1.6 group multiplier', () => {
    const batch = estimateBatch(config, { model: 'gemini-3-pro-image-preview', n: 2, size: '2K', promptChars: 900, refCount: 3 });
    assert.equal(batch.perImageUsd, 0.35);
    assert.equal(batch.totalUsd, 0.7);
});

test('the token-billed model is an estimate built from size, prompt, reference and thinking tokens', () => {
    // 600 chars / 4 = 150 text tokens; 5 refs * 1120 = 5600; output = 2840 + 1291 = 4131 tokens
    // (5750 * 1.5 + 4131 * 30) / 1e6 * 1.6
    const batch = estimateBatch(config, { model: 'gemini-nano-banana-2.1', n: 1, size: '2K', promptChars: 600, refCount: 5 });
    assert.equal(batch.isEstimate, true);
    assert.equal(batch.totalUsd, 0.212088);
});

test('the token-billed estimates agree with the measured charges within a few percent', () => {
    const oneK = estimateBatch(config, { model: 'gemini-nano-banana-2.1', n: 1, size: '1K', promptChars: 600, refCount: 0 });
    const twoK = estimateBatch(config, { model: 'gemini-nano-banana-2.1', n: 1, size: '2K', promptChars: 600, refCount: 0 });
    assert.ok(Math.abs(oneK.perImageUsd - 0.1038) / 0.1038 < 0.03, `1K ${oneK.perImageUsd}`);
    assert.ok(Math.abs(twoK.perImageUsd - 0.2003) / 0.2003 < 0.03, `2K ${twoK.perImageUsd}`);
});

test('thinking tokens raise the estimate above the image-token-only figure', () => {
    const withThoughts = estimateBatch(config, { model: 'gemini-nano-banana-2.1', n: 1, size: '1K', promptChars: 0, refCount: 0 });
    const imageOnly = (1346 * 30 / 1e6) * 1.6;
    assert.ok(withThoughts.perImageUsd > imageOnly * 1.5);
});

test('an unknown model or an unpriced size fails loudly', () => {
    assert.throws(() => estimateBatch(config, { model: 'nope', n: 1, size: '1K', promptChars: 1, refCount: 0 }), /nope/);
    assert.throws(() => estimateBatch(config, { model: 'gemini-nano-banana-2.1', n: 1, size: '8K', promptChars: 1, refCount: 0 }), /8K/);
});

test('the cap allows a total that lands exactly on it and refuses anything above', () => {
    const cap = config.costCapUsd;
    assert.doesNotThrow(() => assertWithinCap(config, { runningUsd: cap - 0.8, batchUsd: 0.8 }));
    assert.throws(() => assertWithinCap(config, { runningUsd: cap - 0.8, batchUsd: 0.9 }), /costCapUsd/);
});

test('config parsing rejects a bad cap, an unknown provider and a locked model that is not priced', () => {
    const base = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    assert.throws(() => parseConfig({ ...base, costCapUsd: -1 }), /costCapUsd/);
    assert.throws(() => parseConfig({ ...base, lockedModel: 'ghost' }), /lockedModel/);
    const noThoughts = structuredClone(base);
    delete noThoughts.models['gemini-nano-banana-2.1'].billing.outputTokensBySize['1K'].thoughts;
    assert.throws(() => parseConfig(noThoughts), /thoughts/);
    const wrongProvider = structuredClone(base);
    wrongProvider.models['gpt-image-2.5-flare-h'].provider = 'mystery';
    assert.throws(() => parseConfig(wrongProvider), /provider/);
});
