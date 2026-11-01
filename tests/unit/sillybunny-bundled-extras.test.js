/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure data. */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import {
    BUNDLED_EXTRAS,
    BUNDLED_EXTRA_GROUP_IDS,
    BUNDLED_EXTRA_KINDS,
    getBundledExtraSlot,
    getExtensionFolderName,
    groupBundledExtras,
} from '../../public/scripts/sillybunny-bundled-extras.js';
import { BUNDLED_THEMES } from '../../src/sillybunny-bundled-themes.js';

const namesOf = group => group.items.map(item => item.name);

describe('Bundled Extras data', () => {
    test('groups the items as first-party extensions, third-party extensions, themes and presets, in that order', () => {
        const groups = groupBundledExtras();

        expect(groups.map(group => group.id)).toEqual([...BUNDLED_EXTRA_GROUP_IDS]);
        expect(BUNDLED_EXTRA_GROUP_IDS).toEqual(['first-party-extensions', 'third-party-extensions', 'themes', 'presets']);
    });

    test('lists no assistant, and has no group, kind or item for one', () => {
        expect(BUNDLED_EXTRAS.filter(item => item.kind === 'assistant' || item.group === 'assistants')).toEqual([]);
        expect(BUNDLED_EXTRAS.map(item => item.name)).not.toContain('Nahida');
        expect(BUNDLED_EXTRA_KINDS).not.toContain('assistant');
        expect(BUNDLED_EXTRA_GROUP_IDS).not.toContain('assistants');
    });

    test('lists the first-party extensions', () => {
        const [firstParty] = groupBundledExtras();

        expect(namesOf(firstParty)).toEqual([
            'Alternate Descriptions',
            'Bot Searcher',
            'CSS Snippets',
            'Deep Swipe',
            'Macro Enhanced',
            'Prompt Tags',
            'Prompting Lab',
            'Regex Agent Themes',
            'Time Machine',
            'World Info Lab',
        ]);
    });

    test('lists the third-party extensions, the themes and the presets', () => {
        const [, thirdParty, themes, presets] = groupBundledExtras();

        expect(namesOf(thirdParty)).toEqual(['Dialogue Colors', 'Summary Sharder', 'Group Utilities', 'LALib']);
        expect(namesOf(themes)).toEqual(['Moonlit Echoes', 'Terminal UI']);
        expect(namesOf(presets)).toEqual(['Geechan - Universal Roleplay (v5.2)', 'TLD Card Conversion Preset']);
    });

    test('marks every item with a kind that fits its group', () => {
        const kindsByGroup = Object.fromEntries(groupBundledExtras().map(group => [group.id, new Set(group.items.map(item => item.kind))]));

        expect(kindsByGroup['first-party-extensions']).toEqual(new Set(['extension']));
        expect(kindsByGroup['third-party-extensions']).toEqual(new Set(['extension']));
        expect(kindsByGroup.themes).toEqual(new Set(['theme-extension']));
        expect([...BUNDLED_EXTRA_KINDS]).toEqual(['extension', 'theme-extension', 'theme-css', 'preset']);
        expect(kindsByGroup.presets).toEqual(new Set(['preset']));
    });

    test('gives every item a unique id that builds a copy slot name', () => {
        const ids = BUNDLED_EXTRAS.map(item => item.id);

        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) {
            expect(getBundledExtraSlot(id)).toMatch(/^BE-ITEM(?:-[A-Z0-9]+)+$/);
        }
        expect(getBundledExtraSlot('world-info-lab')).toBe('BE-ITEM-WORLD-INFO-LAB');
    });

    test('keeps only https source pages, and every extension has one', () => {
        const withoutPage = BUNDLED_EXTRAS.filter(item => item.url === null).map(item => item.name);
        const notHttps = BUNDLED_EXTRAS.filter(item => item.url !== null && !item.url.startsWith('https://')).map(item => item.name);

        expect(notHttps).toEqual([]);
        expect(BUNDLED_EXTRAS.filter(item => item.kind !== 'preset' && withoutPage.includes(item.name))).toEqual([]);
    });

    test('points first-party items at the SillyBunnyTeam repositories', () => {
        const firstParty = groupBundledExtras().find(group => group.id === 'first-party-extensions');

        for (const item of firstParty.items) {
            expect(item.url).toMatch(/^https:\/\/github\.com\/SillyBunnyTeam\/SillyBunny-[A-Za-z-]+$/);
        }
    });

    test('rejects an item in a group that does not exist', () => {
        expect(() => groupBundledExtras([{ id: 'x', name: 'X', group: 'unknown', kind: 'extension', url: null }])).toThrow(/unknown group/i);
    });

    test('leaves out Pura\'s Director Preset, which is no longer supported', () => {
        const everything = JSON.stringify(BUNDLED_EXTRAS).toLowerCase();

        expect(everything).not.toContain('pura');
        expect(everything).not.toContain('director');
    });
});

describe('Bundled Extras items that install', () => {
    const indexOfBundledContent = JSON.parse(readFileSync(new URL('../../default/content/index.json', import.meta.url), 'utf8'));
    const bundledOpenAiPresets = indexOfBundledContent
        .filter(entry => entry.type === 'openai_preset')
        .map(entry => entry.filename.replace(/^presets\/openai\//, '').replace(/\.json$/, ''));

    test('names, for each preset, a preset that ships in default/content, which is the file the restore flow gives back', () => {
        const presets = BUNDLED_EXTRAS.filter(item => item.kind === 'preset');

        expect(presets).toHaveLength(2);
        for (const preset of presets) {
            expect(bundledOpenAiPresets).toContain(preset.presetName);
        }
    });

    test('names a preset only on a preset', () => {
        expect(BUNDLED_EXTRAS.filter(item => 'presetName' in item).every(item => item.kind === 'preset')).toBe(true);
    });

    test.each([
        ['https://github.com/SillyBunnyTeam/SillyBunny-Deep-Swipe', 'SillyBunny-Deep-Swipe'],
        ['https://github.com/LenAnderson/SillyTavern-LALib', 'SillyTavern-LALib'],
        ['https://github.com/aracnai/SB-GroupUtilities.git', 'SB-GroupUtilities'],
    ])('reads the folder the server installs %s into: %s', (url, folder) => {
        expect(getExtensionFolderName({ kind: 'extension', url })).toBe(folder);
    });

    test('gives every extension and theme extension a folder of its own', () => {
        const folders = BUNDLED_EXTRAS
            .filter(item => item.kind === 'extension' || item.kind === 'theme-extension')
            .map(getExtensionFolderName);

        expect(folders.length).toBeGreaterThanOrEqual(16);
        expect(new Set(folders).size).toBe(folders.length);
        for (const folder of folders) {
            expect(folder).toMatch(/^[A-Za-z0-9._-]+$/);
        }
    });

    test('refuses to read a folder from an item that is not an extension', () => {
        expect(() => getExtensionFolderName({ kind: 'preset', url: 'https://rentry.org/geechan' })).toThrow(/not an extension/i);
    });

    test('lists a third-party CSS theme exactly when the server allowlist can install it', () => {
        const listed = BUNDLED_EXTRAS.filter(item => item.kind === 'theme-css').map(item => item.id).sort();

        expect(listed).toEqual(Object.keys(BUNDLED_THEMES).sort());
    });

    test('keeps a third-party CSS theme in the Themes group, with the name its file carries', () => {
        for (const item of BUNDLED_EXTRAS.filter(candidate => candidate.kind === 'theme-css')) {
            expect(item.group).toBe('themes');
            expect(typeof item.themeName).toBe('string');
            expect(item.themeName).not.toBe('');
        }
    });
});
