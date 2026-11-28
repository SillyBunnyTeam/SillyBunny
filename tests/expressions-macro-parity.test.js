/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { loadExpressionsModule } from './util/expressions-module-harness.js';

let activeHarness = null;

async function drainMacrotasks(rounds = 4) {
    for (let i = 0; i < rounds; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

/**
 * Loads the real Expressions module, runs `init()`, and seeds its classifier
 * cache and sprite cache through the real HTTP endpoints that `init()` and
 * `moduleWorker()` call.
 */
async function createMacroRuntime(experimental, {
    expressionsList = ['joy', 'sadness'],
    custom = [],
    sprites = [{ label: 'joy', path: '/characters/Bunny/joy.png' }],
    populateSpriteCache = true,
} = {}) {
    const fetchMock = jest.fn(async url => {
        if (String(url).includes('/api/extra/classify/labels')) {
            return {
                ok: true,
                json: async () => ({ labels: expressionsList }),
            };
        }
        if (String(url).includes('/api/sprites/get')) {
            return {
                ok: true,
                json: async () => sprites,
            };
        }
        return { ok: false, json: async () => ({}) };
    });

    activeHarness = await loadExpressionsModule({
        experimentalMacroEngine: experimental,
        fetch: fetchMock,
        characters: [{ name: 'Bunny', avatar: 'Bunny.png' }],
        // When populateSpriteCache is false, leave no character selected during
        // init so moduleWorker skips sprite fetching and spriteCache stays empty.
        this_chid: populateSpriteCache ? 0 : undefined,
        chat: populateSpriteCache ? [{ name: 'Bunny', is_user: false, mes: 'Hi!' }] : [],
        expressionsSettings: {
            api: 0, // EXPRESSION_API.local so /api/extra/classify/labels populates expressionsList
            custom: [...custom],
            fallback_expression: 'joy',
        },
    });

    await activeHarness.expressionsModule.init();
    await drainMacrotasks();

    // Restore active character after init when testing an unpopulated spriteCache.
    if (!populateSpriteCache) {
        activeHarness.state.this_chid = 0;
    }

    return {
        availableExpressions: (experimental ? activeHarness.modernMacros : activeHarness.legacyMacros).get('availableExpressions'),
        availableSprites: activeHarness.legacyMacros.get('availableSprites'),
    };
}

afterEach(() => {
    activeHarness?.cleanup();
    activeHarness = null;
});

describe.each([['legacy', false], ['experimental', true]])('%s expression macros', (_name, experimental) => {
    test('returns all cached and custom labels while availableSprites stays filtered', async () => {
        const macros = await createMacroRuntime(experimental, { custom: ['smirk', 'joy', 'smirk'] });

        expect(macros.availableExpressions()).toBe('joy, sadness, smirk');
        expect(macros.availableSprites()).toBe('joy');
    });

    for (const expressionsList of [null, []]) {
        test(`returns no expression labels for an empty cache (${JSON.stringify(expressionsList)})`, async () => {
            const macros = await createMacroRuntime(experimental, { expressionsList });

            expect(macros.availableExpressions()).toBe('');
            expect(macros.availableSprites().split(', ')).toContain('joy');
            expect(macros.availableSprites().split(', ')).toContain('neutral');
        });
    }

    test('returns custom labels when the cached classifier list is empty', async () => {
        const macros = await createMacroRuntime(experimental, { expressionsList: [], custom: ['smirk', 'smirk'] });

        expect(macros.availableExpressions()).toBe('smirk');
        expect(macros.availableSprites()).toBe('smirk');
    });

    test('keeps availableSprites fallback when spriteCache has no entry for the folder', async () => {
        const macros = await createMacroRuntime(experimental, { populateSpriteCache: false });

        expect(macros.availableExpressions()).toBe('joy, sadness');
        expect(macros.availableSprites()).toBe('joy, sadness');
    });

    test('keeps availableSprites fallback when spriteCache has no matching sprites', async () => {
        const macros = await createMacroRuntime(experimental, { sprites: [] });

        expect(macros.availableExpressions()).toBe('joy, sadness');
        expect(macros.availableSprites()).toBe('joy, sadness');
    });
});
