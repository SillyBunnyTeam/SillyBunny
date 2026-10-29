/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure data. */
import { describe, expect, test } from '@jest/globals';
import {
    BUNDLED_EXTRAS,
    BUNDLED_EXTRA_GROUP_IDS,
    getBundledExtraSlot,
    groupBundledExtras,
} from '../../public/scripts/sillybunny-bundled-extras.js';

const namesOf = group => group.items.map(item => item.name);

describe('Bundled Extras data', () => {
    test('groups the items as first-party extensions, third-party extensions, themes and presets, in that order', () => {
        const groups = groupBundledExtras();

        expect(groups.map(group => group.id)).toEqual([...BUNDLED_EXTRA_GROUP_IDS]);
        expect(BUNDLED_EXTRA_GROUP_IDS).toEqual(['first-party-extensions', 'third-party-extensions', 'themes', 'presets']);
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
        const [firstParty] = groupBundledExtras();

        for (const item of firstParty.items) {
            expect(item.url).toMatch(/^https:\/\/github\.com\/SillyBunnyTeam\/SillyBunny-[A-Za-z-]+$/);
        }
    });

    test('rejects an item in a group that does not exist', () => {
        expect(() => groupBundledExtras([{ id: 'x', name: 'X', group: 'unknown', kind: 'extension', url: null }])).toThrow(/unknown group/i);
    });
});
