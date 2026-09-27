/* global globalThis */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

function makeNode(id) {
    return {
        id,
        parentElement: null,
        children: [],
        get firstElementChild() {
            return this.children[0] ?? null;
        },
        contains(node) {
            return this.children.some(child => child === node || child.contains(node));
        },
        insertBefore(node, reference) {
            node.parentElement?.children.splice(node.parentElement.children.indexOf(node), 1);
            const index = reference ? this.children.indexOf(reference) : this.children.length;
            this.children.splice(index, 0, node);
            node.parentElement = this;
        },
        insertAdjacentElement(position, node) {
            if (position !== 'afterend') throw new Error(`Unsupported position: ${position}`);
            const siblings = this.parentElement.children;
            this.parentElement.insertBefore(node, siblings[siblings.indexOf(this) + 1] ?? null);
        },
        append(...nodes) {
            for (const node of nodes) this.insertBefore(node, null);
        },
        set innerHTML(value) {
            if (value !== '') throw new Error('Only clearing is supported');
            for (const child of this.children) child.parentElement = null;
            this.children = [];
        },
    };
}

function createFakeDocument(root, descendants) {
    const nodes = [root, ...descendants];
    return {
        getElementById: id => nodes.find(node => node.id === id && (node === root || root.contains(node))) ?? null,
        createElement: () => {
            const node = makeNode('');
            nodes.push(node);
            return node;
        },
    };
}

describe('Guided Generations settings migration', () => {
    let extensionSettings;
    let saveSettingsDebounced;

    beforeEach(async () => {
        jest.resetModules();

        extensionSettings = {};
        saveSettingsDebounced = jest.fn();

        await jest.unstable_mockModule('../public/script.js', () => ({
            saveSettingsDebounced,
            eventSource: { on: jest.fn() },
            event_types: {},
        }));
        await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
            extensionNames: [],
            extension_settings: extensionSettings,
            renderExtensionTemplateAsync: jest.fn(async () => ''),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/guided-generations/scripts/shared.js', () => ({
            extensionName: 'guided-generations',
            flushActiveGuides: jest.fn(async () => []),
            getActiveGuides: jest.fn(() => []),
            getPresetsForApiType: jest.fn(async () => []),
            getProfileApiType: jest.fn(async () => ''),
            getProfileList: jest.fn(async () => []),
            resolveStoredProfile: jest.fn(() => null),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/guided-generations/scripts/guidedCorrection.js', () => ({
            guidedCorrection: jest.fn(),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/guided-generations/scripts/guidedImpersonate.js', () => ({
            guidedImpersonate: jest.fn(),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/guided-generations/scripts/guidedResponse.js', () => ({
            guidedResponse: jest.fn(),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/guided-generations/scripts/guidedSwipe.js', () => ({
            guidedSwipe: jest.fn(),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/guided-generations/scripts/legacyForkWarning.js', () => ({
            markOldExtensionWarningDismissed: jest.fn(),
            shouldWarnOldExtensionDeprecated: jest.fn(() => false),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/guided-generations/scripts/simpleSend.js', () => ({
            simpleSend: jest.fn(),
        }));
    });

    test('removes legacy GGSystemPrompt values migrated into native settings', async () => {
        extensionSettings['GuidedGenerations-Extension'] = {
            promptGuidedResponse: 'GGSystemPrompt',
            promptGuidedSwipe: 'GGSytemPrompt',
            promptGuidedCorrection: 'custom correction: {{input}}',
            promptImpersonate1st: 'GGSytemPrompt',
            presetImpersonate1st: 'GGSytemPrompt',
        };

        const { defaultSettings, loadSettings } = await import('../public/scripts/extensions/guided-generations/index.js');

        loadSettings();

        expect(extensionSettings['guided-generations']).toMatchObject({
            _migrated: true,
            promptGuidedResponse: defaultSettings.promptGuidedResponse,
            promptGuidedSwipe: defaultSettings.promptGuidedSwipe,
            promptGuidedCorrection: 'custom correction: {{input}}',
            promptImpersonate1st: defaultSettings.promptImpersonate1st,
            presetImpersonate1st: '',
        });
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('cleans stale legacy preset references after the migration marker already exists', async () => {
        extensionSettings['guided-generations'] = {
            _migrated: true,
            promptGuidedResponse: 'keep this custom prompt: {{input}}',
            presetImpersonate1st: 'GGSystemPrompt',
            presetGuidedSwipe: 'GGSytemPrompt',
        };

        const { loadSettings } = await import('../public/scripts/extensions/guided-generations/index.js');

        loadSettings();

        expect(extensionSettings['guided-generations'].promptGuidedResponse).toBe('keep this custom prompt: {{input}}');
        expect(extensionSettings['guided-generations'].presetImpersonate1st).toBe('');
        expect(extensionSettings['guided-generations'].presetGuidedSwipe).toBeUndefined();
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('keeps valid custom presets and prompts unchanged', async () => {
        extensionSettings['guided-generations'] = {
            promptGuidedResponse: 'use my custom guide: {{input}}',
            presetImpersonate1st: 'My Custom Preset',
        };

        const { loadSettings } = await import('../public/scripts/extensions/guided-generations/index.js');

        loadSettings();

        expect(extensionSettings['guided-generations'].promptGuidedResponse).toBe('use my custom guide: {{input}}');
        expect(extensionSettings['guided-generations'].presetImpersonate1st).toBe('My Custom Preset');
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });

    test('adds an empty helper prefill setting by default without forcing a save', async () => {
        const { loadSettings } = await import('../public/scripts/extensions/guided-generations/index.js');

        loadSettings();

        expect(extensionSettings['guided-generations'].helperPrefillMessages).toBe('');
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });

    test('shows the action bar by default and preserves an explicit hidden preference', async () => {
        extensionSettings['guided-generations'] = {
            showActionButtonContainer: false,
        };

        const { defaultSettings, loadSettings } = await import('../public/scripts/extensions/guided-generations/index.js');

        loadSettings();

        expect(defaultSettings.showActionButtonContainer).toBe(true);
        expect(extensionSettings['guided-generations'].showActionButtonContainer).toBe(false);
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });

    test('starting hidden hides integrated Quick Replies and respects disabling integration', async () => {
        const sendForm = makeNode('send_form');
        const nonQrFormItems = makeNode('nonQRFormItems');
        const qrBar = makeNode('qr--bar');
        sendForm.append(qrBar, nonQrFormItems);
        globalThis.document = createFakeDocument(sendForm, [nonQrFormItems, qrBar]);
        extensionSettings['guided-generations'] = {
            showActionButtonContainer: false,
            integrateQrBar: true,
        };

        try {
            const { loadSettings, updateExtensionButtons } = await import('../public/scripts/extensions/guided-generations/index.js');
            loadSettings();
            updateExtensionButtons();

            const container = document.getElementById('gg-action-button-container');
            expect(container.hidden).toBe(true);
            expect(document.getElementById('qr--bar')).toBe(qrBar);
            expect(container.contains(qrBar)).toBe(true);

            extensionSettings['guided-generations'].integrateQrBar = false;
            updateExtensionButtons();

            expect(container.hidden).toBe(true);
            expect(qrBar.parentElement).toBe(sendForm);
        } finally {
            delete globalThis.document;
        }
    });
});
