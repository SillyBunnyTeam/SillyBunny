import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, test } from '@jest/globals';

const source = readFileSync(new URL('../public/scripts/extensions/expressions/index.js', import.meta.url), 'utf8');
const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .map(node => node.declaration ?? node);
const init = declarations.find(node => node.id?.name === 'init');
const registrationStart = init.body.body.findIndex(node => node.declarations?.some(declaration => declaration.id.name === 'getAvailableExpressionsList'));
if (registrationStart < 0) throw new Error('Missing expression macro registrations');
const registrationSource = init.body.body.slice(registrationStart).map(node => source.slice(node.start, node.end)).join('\n');

function createMacroRuntime(experimental, { expressionsList = ['joy', 'sadness'], custom = [], spriteCache = { Bunny: [{ label: 'joy', files: ['joy.png'] }] } } = {}) {
    const legacy = new Map();
    const modern = new Map();
    const runtime = vm.createContext({
        expressionsList,
        extension_settings: { expressions: { custom } },
        spriteCache,
        selected_group: null,
        power_user: { experimental_macro_engine: experimental },
        getSpriteFolderName: () => 'Bunny',
        getCurrentFallbackExpression: () => 'joy',
        onlyUnique: (value, index, values) => values.indexOf(value) === index,
        t: strings => strings.join(''),
        MacrosParser: { registerMacro: (name, handler) => legacy.set(name, handler) },
        macros: {
            register: (name, definition) => modern.set(name, definition.handler),
            category: { MISC: 'misc' },
            valueType: { STRING: 'string' },
        },
    });
    for (const name of ['DEFAULT_EXPRESSIONS', 'getCachedExpressions']) {
        const node = declarations.find(node => node.id?.name === name || node.declarations?.some(declaration => declaration.id.name === name));
        vm.runInContext(source.slice(node.start, node.end), runtime);
    }
    vm.runInContext(registrationSource, runtime);
    return {
        availableExpressions: (experimental ? modern : legacy).get('availableExpressions'),
        availableSprites: legacy.get('availableSprites'),
    };
}

describe.each([['legacy', false], ['experimental', true]])('%s expression macros', (_name, experimental) => {
    test('returns all cached and custom labels while availableSprites stays filtered', () => {
        const macros = createMacroRuntime(experimental, { custom: ['smirk', 'joy', 'smirk'] });

        expect(macros.availableExpressions()).toBe('joy, sadness, smirk');
        expect(macros.availableSprites()).toBe('joy');
    });

    for (const expressionsList of [null, []]) {
        test(`returns no expression labels for an empty cache (${JSON.stringify(expressionsList)})`, () => {
            const macros = createMacroRuntime(experimental, { expressionsList });

            expect(macros.availableExpressions()).toBe('');
            expect(macros.availableSprites().split(', ')).toContain('joy');
            expect(macros.availableSprites().split(', ')).toContain('neutral');
        });
    }

    test('returns custom labels when the cached classifier list is empty', () => {
        const macros = createMacroRuntime(experimental, { expressionsList: [], custom: ['smirk', 'smirk'] });

        expect(macros.availableExpressions()).toBe('smirk');
        expect(macros.availableSprites()).toBe('smirk');
    });

    for (const spriteCache of [{}, { Bunny: [] }]) {
        test(`keeps availableSprites fallback when no sprite matches (${JSON.stringify(spriteCache)})`, () => {
            const macros = createMacroRuntime(experimental, { spriteCache });

            expect(macros.availableExpressions()).toBe('joy, sadness');
            expect(macros.availableSprites()).toBe('joy, sadness');
        });
    }
});
