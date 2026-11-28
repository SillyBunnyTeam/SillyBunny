/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions and shipped JSON checks. */
import { beforeEach, describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { THEME_TEXT_REVISION } from '../public/scripts/sillybunny-theme-revisions.js';
import { importPowerUserModule } from './util/power-user-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...parts) => JSON.parse(readFileSync(path.join(repoRoot, ...parts), 'utf8'));

const libadwaitaDark = readJson('default', 'content', 'themes', 'Libadwaita Dark.json');
const libadwaitaLight = readJson('default', 'content', 'themes', 'Libadwaita Light.json');

const { powerUser, mocks } = await importPowerUserModule();
const initialDefaults = structuredClone(powerUser.power_user);

function createLoadData() {
    return {
        themes: [libadwaitaDark, libadwaitaLight],
        context: [],
        instruct: [],
        sysprompt: [],
        reasoning: [],
    };
}

describe('libadwaita default theme motion', () => {
    let osReducedMotion = false;

    beforeEach(() => {
        osReducedMotion = false;
        window.matchMedia = query => ({
            matches: query.includes('prefers-reduced-motion') ? osReducedMotion : false,
            addEventListener: () => {},
            removeEventListener: () => {},
        });
        Object.assign(powerUser.power_user, structuredClone(initialDefaults));
        mocks.script.saveSettingsDebounced.mockClear();
    });

    test('ships motion enabled in the default settings and both libadwaita themes', () => {
        expect(readJson('default', 'content', 'settings.json').power_user.reduced_motion).toBe(false);
        expect(libadwaitaDark.reduced_motion).toBe(false);
        expect(libadwaitaLight.reduced_motion).toBe(false);
    });

    test('ships the bundled Libadwaita text colours in the default settings', () => {
        const defaults = readJson('default', 'content', 'settings.json').power_user;

        for (const key of ['main_text_color', 'italics_text_color', 'underline_text_color', 'quote_text_color']) {
            expect(defaults[key]).toBe(libadwaitaDark[key]);
        }
    });

    test('seeds the text revision marker, because the default palette is already the revised one', () => {
        const defaults = readJson('default', 'content', 'settings.json').power_user;

        expect(defaults.sb_theme_text_revision).toBe(THEME_TEXT_REVISION);
    });

    test('enables motion when migrating the legacy Dark V 1.0 default to Libadwaita Dark', async () => {
        await powerUser.loadPowerUserSettings(
            {
                power_user: {
                    theme: 'Dark V 1.0',
                    reduced_motion: true,
                    sb_theme_text_revision: THEME_TEXT_REVISION,
                },
            },
            createLoadData(),
        );

        expect(powerUser.power_user.theme).toBe('Libadwaita Dark');
        expect(powerUser.power_user.reduced_motion).toBe(false);
        expect(mocks.script.saveSettingsDebounced).toHaveBeenCalled();
    });

    test('still lets the OS reduced-motion preference override the setting', async () => {
        osReducedMotion = true;

        await powerUser.loadPowerUserSettings(
            {
                power_user: {
                    theme: 'Libadwaita Dark',
                    reduced_motion: false,
                    sb_theme_text_revision: THEME_TEXT_REVISION,
                },
            },
            createLoadData(),
        );

        expect(powerUser.power_user.reduced_motion).toBe(true);
    });
});
