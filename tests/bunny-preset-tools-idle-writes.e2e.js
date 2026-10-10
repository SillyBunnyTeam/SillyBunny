/* eslint-env browser */
import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';

test.describe('keyboard interactables', () => {
    // ... rest of file

import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';

// BunnyPresetTools re-syncs its panels and the animated background layer every second.
test.describe('BunnyPresetTools idle sync', () => {
    test.beforeEach(async ({ page }) => {
        let settingsVersion = Date.now();
        await page.route('**/api/settings/save', route => route.fulfill({ status: 200, json: { version: ++settingsVersion } }));
        await page.route('https://example.invalid/**', route => route.abort());
        await testSetup.awaitST({ page });
    });

    test('writes nothing to the page while idle', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            await sleep(2500);

            const watched = ['bpt-settings', 'bpt-animated-bg-panel', 'bpt-animated-bg-layer'].map(id => document.getElementById(id));
            const records = [];
            const observer = new MutationObserver(list => records.push(...list));
            observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
            for (const element of watched.filter(Boolean)) {
                observer.observe(element, { attributes: true, childList: true, subtree: true });
            }
            await sleep(3500);
            observer.disconnect();

            return {
                present: watched.map(element => Boolean(element)),
                records: records.map(record => `${record.type} ${record.attributeName ?? ''} ${record.target.id || record.target.className}`.trim()),
            };
        });

        expect(result.present).toEqual([true, true, true]);
        expect(result.records).toEqual([]);
    });

    test('keeps saved source cards between ticks and still applies and removes them', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            const context = window.SillyTavern.getContext();
            const { background_settings: backgroundSettings } = await import('/scripts/backgrounds.js');
            const { chat_metadata: chatMetadata } = await import('/script.js');
            const settingsKey = 'BunnyPresetTools';
            const originalSettings = context.extensionSettings[settingsKey];
            const original = {
                sources: originalSettings.savedAnimatedSources,
                enabled: originalSettings.enableAnimatedBackgrounds,
                backgroundName: backgroundSettings.name,
                backgroundUrl: backgroundSettings.url,
                bgImage: document.getElementById('bg1').style.backgroundImage,
                lockedBackground: chatMetadata.custom_background,
            };
            const container = document.getElementById('bpt-animated-bg-sources');
            const layer = document.getElementById('bpt-animated-bg-layer');
            const cards = () => [...container.querySelectorAll('.bpt-animated-source-card')];
            const sourceA = 'https://example.invalid/bpt-a.mp4';
            const sourceB = 'https://example.invalid/bpt-b.webm';
            const out = {};

            try {
                // Applying a source writes the chat's locked background when one is set.
                delete chatMetadata.custom_background;
                originalSettings.enableAnimatedBackgrounds = true;
                originalSettings.savedAnimatedSources = [sourceA, sourceB];
                await sleep(1500);
                const rendered = cards();
                out.renderedCount = rendered.length;
                await sleep(2500);
                const afterTicks = cards();
                out.sameCardsAfterTicks = afterTicks.length === rendered.length && afterTicks.every((card, index) => card === rendered[index]);

                rendered[0].querySelector('.bpt-animated-source-main').click();
                await sleep(500);
                out.applied = {
                    videoSrc: layer.querySelector('video')?.getAttribute('src') ?? null,
                    bodyClass: document.body.classList.contains('bpt-animated-bg-active'),
                    activeCards: cards().filter(card => card.classList.contains('is-active')).map(card => card.textContent.trim()),
                };

                const enabled = document.getElementById('bpt-animated-bg-enabled');
                enabled.checked = false;
                enabled.dispatchEvent(new Event('change', { bubbles: true }));
                await sleep(500);
                out.disabled = {
                    layerChildren: layer.childElementCount,
                    bodyClass: document.body.classList.contains('bpt-animated-bg-active'),
                };

                cards()[1].querySelector('.menu_button').click();
                await sleep(200);
                out.afterRemove = { cards: cards().length, sources: [...context.extensionSettings[settingsKey].savedAnimatedSources] };

                const replacement = { ...context.extensionSettings[settingsKey] };
                context.extensionSettings[settingsKey] = replacement;
                await sleep(1500);
                cards()[0].querySelector('.menu_button').click();
                await sleep(200);
                out.afterReplacedSettingsRemove = { cards: cards().length, sources: [...replacement.savedAnimatedSources] };
            } finally {
                context.extensionSettings[settingsKey] = originalSettings;
                originalSettings.savedAnimatedSources = original.sources;
                originalSettings.enableAnimatedBackgrounds = original.enabled;
                backgroundSettings.name = original.backgroundName;
                backgroundSettings.url = original.backgroundUrl;
                document.getElementById('bg1').style.backgroundImage = original.bgImage;
                if (original.lockedBackground !== undefined) {
                    chatMetadata.custom_background = original.lockedBackground;
                }
                document.getElementById('bpt-animated-bg-enabled').checked = original.enabled;
            }

            return out;
        });

        expect(result.renderedCount).toBe(2);
        expect(result.sameCardsAfterTicks).toBe(true);
        expect(result.applied.videoSrc).toBe('https://example.invalid/bpt-a.mp4');
        expect(result.applied.bodyClass).toBe(true);
        expect(result.applied.activeCards).toEqual(['bpt-a.mp4']);
        expect(result.disabled).toEqual({ layerChildren: 0, bodyClass: false });
        expect(result.afterRemove).toEqual({ cards: 1, sources: ['https://example.invalid/bpt-a.mp4'] });
        expect(result.afterReplacedSettingsRemove.sources).toEqual([]);
        expect(result.afterReplacedSettingsRemove.cards).toBe(0);
    });

    test('keeps unsaved divider patterns and still shows saved changes', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            const context = window.SillyTavern.getContext();
            const settings = context.extensionSettings.BunnyPresetTools;
            const originalPattern = settings.dividerRegexPattern;
            const input = document.getElementById('bpt-divider-patterns');
            const out = {};

            try {
                input.value = 'typed, not saved';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                await sleep(2500);
                out.unsaved = input.value;

                input.value = '  ^##  ';
                document.getElementById('bpt-save-divider-patterns').click();
                out.saved = { setting: settings.dividerRegexPattern, field: input.value };

                settings.dividerRegexPattern = 'changed elsewhere';
                await sleep(1500);
                out.external = input.value;
            } finally {
                settings.dividerRegexPattern = originalPattern;
                await sleep(1500);
            }

            out.restored = input.value === originalPattern;
            return out;
        });

        expect(result.unsaved).toBe('typed, not saved');
        expect(result.saved).toEqual({ setting: '^##', field: '^##' });
        expect(result.external).toBe('changed elsewhere');
        expect(result.restored).toBe(true);
    });
});
