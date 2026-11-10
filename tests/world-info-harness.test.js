import { describe, expect, test } from '@jest/globals';
import vm from 'node:vm';

import { WORLD_INFO_LOGIC } from './util/world-info-cases.js';
import {
    PRODUCT_CONSTANTS,
    SCAN_CLASSES,
    SCAN_FUNCTIONS,
    buildScanSource,
    classSource,
    constantSource,
    createHarness,
    functionSource,
    readProductConstants,
    worldInfoSource,
} from './util/world-info-harness.js';

const DECLARATIONS = [
    ...SCAN_CLASSES.map(name => ({ name, kind: 'class', extract: classSource })),
    ...SCAN_FUNCTIONS.map(name => ({ name, kind: 'function', extract: functionSource })),
];

const isCompleteScript = text => {
    try {
        return Boolean(new vm.Script(text));
    } catch {
        return false;
    }
};

describe('World Info harness extraction', () => {
    test('extracts every scan declaration as a complete script', () => {
        const incomplete = DECLARATIONS.filter(({ name, extract }) => !isCompleteScript(extract(name))).map(({ name }) => name);

        expect(incomplete).toEqual([]);
    });

    test.each(DECLARATIONS)('names $kind $name in the error when it is renamed', ({ name, kind }) => {
        const renamed = worldInfoSource.replace(new RegExp(`\\b${kind} ${name}\\b`), `${kind} ${name}Renamed`);

        expect(renamed).not.toBe(worldInfoSource);
        expect(() => buildScanSource(renamed)).toThrow(`no declaration named "${name}"`);
    });

    test.each(DECLARATIONS)('names $kind $name in the error when it is removed', ({ name, extract }) => {
        const removed = worldInfoSource.replace(extract(name, worldInfoSource), '');

        expect(removed).not.toBe(worldInfoSource);
        expect(() => buildScanSource(removed)).toThrow(`no declaration named "${name}"`);
    });

    test.each(PRODUCT_CONSTANTS)('names constant %s in the error when it is renamed', name => {
        const renamed = worldInfoSource.replace(new RegExp(`\\b(const|let) ${name}\\b`), `$1 ${name}Renamed`);

        expect(renamed).not.toBe(worldInfoSource);
        expect(() => readProductConstants([name], renamed)).toThrow(`no constant named "${name}"`);
    });
});

describe('World Info harness constants', () => {
    test.each(PRODUCT_CONSTANTS)('keeps %s equal to the declaration in world-info.js', name => {
        const provided = JSON.parse(JSON.stringify(createHarness()[name]));

        expect(provided).toEqual(readProductConstants([name])[name]);
    });

    test('keeps the logic values of the case tables equal to world_info_logic', () => {
        expect(WORLD_INFO_LOGIC).toEqual(readProductConstants(['world_info_logic']).world_info_logic);
    });

    test('keeps the entry order comparison the harness expects', () => {
        expect(constantSource('sortFn')).toBe('const sortFn = (a, b) => b.order - a.order;');
    });
});
