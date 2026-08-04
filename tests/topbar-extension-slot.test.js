import { describe, expect, test } from '@jest/globals';
import {
    isNativeTopbarDrawerId,
    resolveCharacterBadgeMirrorPlan,
    resolveTopbarAdoptionPlan,
    resolveTopbarNodeAdoption,
    TOPBAR_ADOPTION_SKIP_REASON,
    TOPBAR_NATIVE_DRAWER_IDS,
} from '../public/scripts/topbar-extension-slot/index.js';

function describeNode(overrides = {}) {
    return {
        isElement: true,
        id: '',
        tagName: 'DIV',
        classNames: [],
        adoptAttribute: null,
        isSillyBunnyOwned: false,
        ...overrides,
    };
}

describe('topbar extension adoption rules', () => {
    test('covers every native top-bar drawer', () => {
        expect(TOPBAR_NATIVE_DRAWER_IDS).toHaveLength(9);

        for (const id of TOPBAR_NATIVE_DRAWER_IDS) {
            expect(isNativeTopbarDrawerId(id)).toBe(true);
            expect(resolveTopbarNodeAdoption(describeNode({ id, classNames: ['drawer'] }))).toEqual({
                shouldAdopt: false,
                reason: TOPBAR_ADOPTION_SKIP_REASON.NATIVE_DRAWER,
            });
        }
    });

    test('adopts an id that merely resembles a native drawer', () => {
        expect(isNativeTopbarDrawerId('ai-config-button-2')).toBe(false);
        expect(resolveTopbarNodeAdoption(describeNode({ id: 'ai-config-button-2' })).shouldAdopt).toBe(true);
    });

    test('adopts the CharacterLibrary standalone button', () => {
        const verdict = resolveTopbarNodeAdoption(describeNode({ id: 'st-gallery-btn', classNames: ['drawer'] }));

        expect(verdict).toEqual({ shouldAdopt: true, reason: '' });
    });

    test('adopts an extension that uses an sb- id prefix', () => {
        // The previous filter keyed on the id prefix, so any extension picking one was treated as
        // SillyBunny's own markup and left to stretch across the bar.
        const verdict = resolveTopbarNodeAdoption(describeNode({ id: 'sb-third-party-button' }));

        expect(verdict.shouldAdopt).toBe(true);
    });

    test('skips SillyBunny-owned elements regardless of id', () => {
        const verdict = resolveTopbarNodeAdoption(describeNode({ id: 'anything', isSillyBunnyOwned: true }));

        expect(verdict).toEqual({
            shouldAdopt: false,
            reason: TOPBAR_ADOPTION_SKIP_REASON.SILLYBUNNY_OWNED,
        });
    });

    test('skips non-element nodes', () => {
        expect(resolveTopbarNodeAdoption(describeNode({ isElement: false })).reason)
            .toBe(TOPBAR_ADOPTION_SKIP_REASON.NOT_ELEMENT);
    });

    test('skips excluded tags and panel classes', () => {
        expect(resolveTopbarNodeAdoption(describeNode({ tagName: 'SCRIPT' })).reason)
            .toBe(TOPBAR_ADOPTION_SKIP_REASON.EXCLUDED_TAG);
        expect(resolveTopbarNodeAdoption(describeNode({ classNames: ['drawer-content', 'openDrawer'] })).reason)
            .toBe(TOPBAR_ADOPTION_SKIP_REASON.EXCLUDED_CLASS);
        expect(resolveTopbarNodeAdoption(describeNode({ classNames: 'popup wide' })).reason)
            .toBe(TOPBAR_ADOPTION_SKIP_REASON.EXCLUDED_CLASS);
    });

    test('honours the documented opt-out and opt-in attribute', () => {
        expect(resolveTopbarNodeAdoption(describeNode({ id: 'st-gallery-btn', adoptAttribute: 'false' })).reason)
            .toBe(TOPBAR_ADOPTION_SKIP_REASON.OPTED_OUT);
        expect(resolveTopbarNodeAdoption(describeNode({ classNames: ['popup'], adoptAttribute: 'true' })).shouldAdopt)
            .toBe(true);
    });

    test('an opt-in attribute cannot claim a native drawer or our own element', () => {
        expect(resolveTopbarNodeAdoption(describeNode({ id: 'rightNavHolder', adoptAttribute: 'true' })).shouldAdopt)
            .toBe(false);
        expect(resolveTopbarNodeAdoption(describeNode({ isSillyBunnyOwned: true, adoptAttribute: 'true' })).shouldAdopt)
            .toBe(false);
    });
});

describe('topbar adoption plan', () => {
    test('adopts foreign nodes and reports why the rest were skipped', () => {
        const plan = resolveTopbarAdoptionPlan({
            nodes: [
                describeNode({ key: 'id:rightNavHolder', id: 'rightNavHolder' }),
                describeNode({ key: 'id:st-gallery-btn', id: 'st-gallery-btn', classNames: ['drawer'] }),
                describeNode({ key: 'id:sb-topbar-stack', id: 'sb-topbar-stack', isSillyBunnyOwned: true }),
            ],
            slotChildKeys: [],
        });

        expect(plan.adoptKeys).toEqual(['id:st-gallery-btn']);
        expect(plan.skipped).toEqual([
            { key: 'id:rightNavHolder', reason: TOPBAR_ADOPTION_SKIP_REASON.NATIVE_DRAWER },
            { key: 'id:sb-topbar-stack', reason: TOPBAR_ADOPTION_SKIP_REASON.SILLYBUNNY_OWNED },
        ]);
    });

    test('is idempotent: replaying a pass adopts nothing new', () => {
        const nodes = [
            describeNode({ key: 'id:st-gallery-btn', id: 'st-gallery-btn', classNames: ['drawer'] }),
            describeNode({ key: 'id:other-ext-btn', id: 'other-ext-btn' }),
        ];

        const first = resolveTopbarAdoptionPlan({ nodes, slotChildKeys: [] });
        expect(first.adoptKeys).toEqual(['id:st-gallery-btn', 'id:other-ext-btn']);

        const second = resolveTopbarAdoptionPlan({ nodes, slotChildKeys: first.adoptKeys });
        expect(second.adoptKeys).toEqual([]);
    });

    test('does not adopt the same key twice within one pass', () => {
        const duplicate = describeNode({ key: 'id:st-gallery-btn', id: 'st-gallery-btn' });
        const plan = resolveTopbarAdoptionPlan({ nodes: [duplicate, duplicate], slotChildKeys: [] });

        expect(plan.adoptKeys).toEqual(['id:st-gallery-btn']);
    });
});

describe('character badge mirror plan', () => {
    function badge(key, className, overrides = {}) {
        return describeNode({ key, signature: `I:${className}`, tagName: 'I', classNames: [className], ...overrides });
    }

    test('moves an extension badge onto the proxy button', () => {
        const plan = resolveCharacterBadgeMirrorPlan({
            iconBadges: [badge('badge:0', 'charlib-chevron-badge')],
            hostBadges: [],
        });

        expect(plan).toEqual({ moveKeys: ['badge:0'], removeKeys: [] });
    });

    test('replaces a previously mirrored badge instead of stacking duplicates', () => {
        const plan = resolveCharacterBadgeMirrorPlan({
            iconBadges: [badge('badge:0', 'charlib-chevron-badge')],
            hostBadges: [badge('badge:host-0', 'charlib-chevron-badge')],
        });

        expect(plan.moveKeys).toEqual(['badge:0']);
        expect(plan.removeKeys).toEqual(['badge:host-0']);
    });

    test('keeps badges with different signatures side by side', () => {
        const plan = resolveCharacterBadgeMirrorPlan({
            iconBadges: [badge('badge:0', 'charlib-chevron-badge'), badge('badge:1', 'other-badge')],
            hostBadges: [],
        });

        expect(plan.moveKeys).toEqual(['badge:0', 'badge:1']);
        expect(plan.removeKeys).toEqual([]);
    });

    test('ignores children that are not adoptable', () => {
        const plan = resolveCharacterBadgeMirrorPlan({
            iconBadges: [badge('badge:0', 'charlib-chevron-badge', { tagName: 'SCRIPT' })],
            hostBadges: [],
        });

        expect(plan.moveKeys).toEqual([]);
    });
});
