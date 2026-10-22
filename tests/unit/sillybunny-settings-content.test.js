/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SB_DATA_SECURITY_CONTAINER_ID, splitUserSettingsContent } from '../../public/scripts/sillybunny-settings-content.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

/** Moves the authored settings block into a column the way the right shell does, then splits it. */
function splitAuthoredSettings() {
    const page = new DOMParser().parseFromString(indexHtml, 'text/html');
    const block = document.adoptNode(page.getElementById('user-settings-block'));
    const originalContent = document.createElement('div');
    originalContent.append(...block.childNodes);
    return splitUserSettingsContent(originalContent);
}

describe('Data & Security settings split', () => {
    let previousCSS;
    beforeAll(() => {
        previousCSS = globalThis.CSS;
        // jsdom does not supply `CSS.escape`. The split escapes only plain section ids, so a pass-through is enough.
        globalThis.CSS = { ...previousCSS, escape: value => String(value) };
    });
    afterAll(() => {
        globalThis.CSS = previousCSS;
    });

    test('places Usage Stats in General between Account and Version', () => {
        const split = splitAuthoredSettings();
        expect(split.missing).toEqual([]);
        expect(split.dataSecurity.id).toBe(SB_DATA_SECURITY_CONTAINER_ID);

        const general = split.dataSecurity.querySelector('[data-sb-category="general"] > .sb-settings-category-body');
        const rows = [...general.children];
        const position = element => rows.indexOf(element);
        const usageStats = split.dataSecurity.querySelector('#user_stats_controls');
        expect(position(usageStats)).toBe(position(split.dataSecurity.querySelector('#account_controls')) + 1);
        expect(position(split.dataSecurity.querySelector('#version_display').closest('.ds-row'))).toBe(position(usageStats) + 1);
    });

    test('Usage Stats keeps the upstream button class and translated label', () => {
        const usageStats = splitAuthoredSettings().dataSecurity.querySelector('#user_stats_controls');
        expect(usageStats.querySelector('.ds-row-label').dataset.i18n).toBe('Usage Stats');
        const button = usageStats.querySelector('.ds-row-suffix > button.user_stats_button');
        expect(button.type).toBe('button');
        expect(button.dataset.i18n).toBe('Usage Stats');
        expect(button.textContent).toBe('Usage Stats');
    });
});
