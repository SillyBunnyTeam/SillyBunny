import { describe, expect, test } from '@jest/globals';
import { createResponseLengthOverrides } from '../public/scripts/generation-response-length-overrides.js';

function makeSettings(values = { amount_gen: 512, openai_max_tokens: 300 }) {
    const settings = { ...values };
    const writes = [];
    const overrides = createResponseLengthOverrides({
        read: setting => settings[setting],
        write: (setting, length) => {
            settings[setting] = length;
            writes.push([setting, length]);
        },
    });
    return { settings, writes, overrides };
}

const ORDERS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

describe('response length overrides', () => {
    test('one override sets the length and puts the preset back', () => {
        const { settings, overrides } = makeSettings();
        expect(overrides.isActive()).toBe(false);
        const override = overrides.add('amount_gen', 16000);
        expect(settings).toEqual({ amount_gen: 16000, openai_max_tokens: 300 });
        expect(overrides.isActive()).toBe(true);
        expect(overrides.remove(override)).toBe(true);
        expect(settings).toEqual({ amount_gen: 512, openai_max_tokens: 300 });
        expect(overrides.isActive()).toBe(false);
    });

    test.each(ORDERS)('three overrides removed in the order %i, %i, %i leave the preset', (...order) => {
        const { settings, overrides } = makeSettings();
        const lengths = [100, 200, 300];
        const added = lengths.map(length => overrides.add('amount_gen', length));
        const inForce = [0, 1, 2];
        for (const index of order) {
            expect(overrides.remove(added[index])).toBe(true);
            inForce.splice(inForce.indexOf(index), 1);
            // The setting holds the length of the newest override that is still in force.
            expect(settings.amount_gen).toBe(inForce.length ? lengths[inForce.at(-1)] : 512);
        }
        expect(settings).toEqual({ amount_gen: 512, openai_max_tokens: 300 });
        expect(overrides.isActive()).toBe(false);
    });

    test('an override that is no longer in force changes nothing', () => {
        const { settings, writes, overrides } = makeSettings();
        const first = overrides.add('amount_gen', 100);
        const second = overrides.add('amount_gen', 200);
        overrides.remove(first);
        const count = writes.length;
        expect(overrides.remove(first)).toBe(false);
        expect(writes).toHaveLength(count);
        expect(settings.amount_gen).toBe(200);
        overrides.remove(second);
        expect(settings.amount_gen).toBe(512);
    });

    test('the settings do not share a saved length', () => {
        const { settings, overrides } = makeSettings();
        const chat = overrides.add('openai_max_tokens', 100);
        const text = overrides.add('amount_gen', 200);
        overrides.remove(chat);
        expect(settings).toEqual({ amount_gen: 200, openai_max_tokens: 300 });
        overrides.remove(text);
        expect(settings).toEqual({ amount_gen: 512, openai_max_tokens: 300 });
    });

    test('removeAll puts every preset back, and a later removal changes nothing', () => {
        const { settings, overrides } = makeSettings();
        const added = [overrides.add('amount_gen', 100), overrides.add('openai_max_tokens', 200), overrides.add('amount_gen', 300)];
        overrides.removeAll();
        expect(settings).toEqual({ amount_gen: 512, openai_max_tokens: 300 });
        expect(overrides.isActive()).toBe(false);
        for (const override of added) expect(overrides.remove(override)).toBe(false);
        expect(settings).toEqual({ amount_gen: 512, openai_max_tokens: 300 });
    });

    test('one event removes only the newest hooked override of its setting', () => {
        const { settings, overrides } = makeSettings();
        const outer = overrides.add('openai_max_tokens', 100);
        const inner = overrides.add('openai_max_tokens', 200);
        const unhooked = overrides.add('openai_max_tokens', 400);
        const text = overrides.add('amount_gen', 16000);
        for (const override of [outer, inner, text]) overrides.hook(override);

        expect(overrides.removeNewestHooked('openai_max_tokens')).toBe(true);
        expect(overrides.remove(inner)).toBe(false);
        expect(settings).toEqual({ amount_gen: 16000, openai_max_tokens: 400 });

        overrides.remove(unhooked);
        expect(settings.openai_max_tokens).toBe(100);

        expect(overrides.removeNewestHooked('openai_max_tokens')).toBe(true);
        expect(overrides.remove(outer)).toBe(false);
        expect(settings).toEqual({ amount_gen: 16000, openai_max_tokens: 300 });

        expect(overrides.removeNewestHooked('openai_max_tokens')).toBe(false);
        expect(overrides.removeNewestHooked('amount_gen')).toBe(true);
        expect(settings).toEqual({ amount_gen: 512, openai_max_tokens: 300 });
        expect(overrides.isActive()).toBe(false);
    });
});
