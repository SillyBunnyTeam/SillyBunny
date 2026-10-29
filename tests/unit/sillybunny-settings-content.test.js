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

    test('places Export right after Import & Restore with Download Backup then Settings Snapshots', () => {
        const split = splitAuthoredSettings();
        expect(split.missing).toEqual([]);

        const sections = [...split.dataSecurity.children];
        const exportCategory = split.dataSecurity.querySelector('[data-sb-category="export"]');
        expect(sections.indexOf(exportCategory)).toBe(sections.indexOf(split.dataSecurity.querySelector('#SillyTavernImportSection')) + 1);
        const rows = [...exportCategory.querySelector(':scope > .sb-settings-category-body').children];
        expect(rows.map(row => row.id)).toEqual(['user_backup_controls', 'settings_snapshots_controls']);
    });

    test('Export marks its description as a copy placeholder', () => {
        const exportCategory = splitAuthoredSettings().dataSecurity.querySelector('[data-sb-category="export"]');
        expect(exportCategory.querySelector('.sb-settings-category-title').dataset.i18n).toBe('Export');
        const description = exportCategory.querySelector('.sb-settings-category-heading > small');
        expect(description.textContent).toBe('TODO(copy)');
        expect(description.dataset.sbCopyPlaceholder).toBe('true');
        expect(description.dataset.i18n).toBeUndefined();
    });

    test.each([
        ['user_backup_controls', 'user_backup_button', 'Download Backup', 'Download a complete backup of your user data.'],
        ['settings_snapshots_controls', 'settings_snapshots_button', 'Settings Snapshots', 'Manage your settings snapshots.'],
    ])('Export row %s reuses the upstream strings', (rowId, buttonId, label, subtitle) => {
        const row = splitAuthoredSettings().dataSecurity.querySelector(`[data-sb-category="export"] #${rowId}`);
        expect(row.querySelector('.ds-row-label').dataset.i18n).toBe(label);
        expect(row.querySelector('.ds-row-subtitle').dataset.i18n).toBe(subtitle);
        const button = row.querySelector(`.ds-row-suffix > button#${buttonId}`);
        expect(button.type).toBe('button');
        expect(button.dataset.i18n).toBe(label);
        expect(button.textContent).toBe(label);
    });
});

describe('Account popup', () => {
    test('leaves Settings Snapshots and Download Backup to Data & Security', () => {
        const templateHtml = readFileSync(path.join(repoRoot, 'public', 'scripts', 'templates', 'userProfile.html'), 'utf8');
        const template = new DOMParser().parseFromString(templateHtml, 'text/html');
        expect(template.querySelector('.userSettingsSnapshotsButton')).toBeNull();
        expect(template.querySelector('.userBackupButton')).toBeNull();

        // With accounts off, Change Password hides, and an Account Actions heading over nothing would remain.
        const accountActions = template.querySelector('h3[data-i18n="Account Actions"]').parentElement;
        expect(accountActions.hasAttribute('data-require-accounts')).toBe(true);
        expect(accountActions.querySelector('.userChangePasswordButton')).not.toBeNull();
    });
});
