/* eslint-disable playwright/no-standalone-expect -- Jest contracts for the settings that a first run seeds. */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const runFirstRunWelcome = jest.fn();
const decide = jest.fn();
jest.unstable_mockModule('../../public/scripts/sillybunny-welcome.js', () => ({ runFirstRunWelcome }));
jest.unstable_mockModule('../../public/scripts/sillybunny-home/welcome-boot.js', () => ({ getWelcomeStartup: () => ({ decide }) }));
const { seedQuickImageGenFirstRun, showFirstRunWelcome } = await import('../../public/scripts/sillybunny-first-run-defaults.js');

const SEEDED = { setupWizardSeen: true, starterPresetsSeeded: false };

describe('seedQuickImageGenFirstRun', () => {
    test.each([
        ['no extension settings at all', undefined],
        ['extension settings without the key', { disabledExtensions: [] }],
        ['an empty object', { 'quick-image-gen': {} }],
        ['a null value', { 'quick-image-gen': null }],
    ])('seeds the wizard as seen and the starter presets as not yet seeded for %s', (_label, input) => {
        const seeded = seedQuickImageGenFirstRun(input);

        expect(seeded['quick-image-gen']).toStrictEqual(SEEDED);
    });

    test('names starterPresetsSeeded explicitly, because an undefined value would make the extension skip its starter presets', () => {
        const seeded = seedQuickImageGenFirstRun({});

        expect(Object.hasOwn(seeded['quick-image-gen'], 'starterPresetsSeeded')).toBe(true);
        expect(seeded['quick-image-gen'].starterPresetsSeeded).toBe(false);
    });

    test('keeps the other extension settings', () => {
        const input = { disabledExtensions: ['a'], note: { allowWIScan: true } };

        const seeded = seedQuickImageGenFirstRun(input);

        expect(seeded.disabledExtensions).toStrictEqual(['a']);
        expect(seeded.note).toStrictEqual({ allowWIScan: true });
    });

    test.each([
        ['an existing install that saw the wizard', { setupWizardSeen: true, starterPresetsSeeded: true, steps: 30 }],
        ['an existing install that never saw the wizard', { setupWizardSeen: false }],
        ['settings of only one other key', { model: 'x' }],
    ])('leaves %s untouched', (_label, saved) => {
        const input = { 'quick-image-gen': saved };

        const seeded = seedQuickImageGenFirstRun(input);

        expect(seeded['quick-image-gen']).toStrictEqual(saved);
    });

    test('does not change what it was given', () => {
        const input = { 'quick-image-gen': {} };

        seedQuickImageGenFirstRun(input);

        expect(input).toStrictEqual({ 'quick-image-gen': {} });
    });
});

describe('showFirstRunWelcome', () => {
    beforeEach(() => {
        runFirstRunWelcome.mockReset();
        decide.mockReset().mockReturnValue({ open: true, reason: 'first-run' });
    });

    test('decides the first run before it loads the dialog, then runs the dialog for the avatar of the persona', async () => {
        runFirstRunWelcome.mockResolvedValue(undefined);

        const handled = await showFirstRunWelcome('user-default.png');

        expect(decide).toHaveBeenCalledWith({ firstRun: true });
        expect(runFirstRunWelcome).toHaveBeenCalledWith('user-default.png');
        expect(decide.mock.invocationCallOrder[0]).toBeLessThan(runFirstRunWelcome.mock.invocationCallOrder[0]);
        expect(handled).toBe(true);
    });

    test('shows no dialog for an account that was just imported, and the popup of upstream stays closed', async () => {
        decide.mockReturnValue({ open: false, reason: 'import' });

        const handled = await showFirstRunWelcome('user-default.png');

        expect(runFirstRunWelcome).not.toHaveBeenCalled();
        expect(handled).toBe(true);
    });

    test('lets a failure after the dialog has opened through, so that the popup of upstream is not stacked on it', async () => {
        const error = new Error('The dialog broke.');
        runFirstRunWelcome.mockRejectedValue(error);

        await expect(showFirstRunWelcome('user-default.png')).rejects.toBe(error);
    });
});
