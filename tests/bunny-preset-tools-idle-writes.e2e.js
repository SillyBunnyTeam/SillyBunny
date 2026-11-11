import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';

// BunnyPresetTools re-syncs its panels and the animated background layer every second. The tests run a fake clock
// between their steps, so the sync ticks without waiting for real seconds.
test.describe('BunnyPresetTools idle sync', () => {
    test.beforeEach(async ({ page }) => {
        let settingsVersion = Date.now();
        await page.route('**/api/settings/save', route => route.fulfill({ status: 200, json: { version: ++settingsVersion } }));
        await page.route('https://example.invalid/**', route => route.abort());
        // Installed before the boot, so that the sync interval uses the fake timers. Time still flows during the boot.
        await page.clock.install();
        await testSetup.awaitST({ page });
    });

    test('writes nothing to the page while idle', async ({ page }) => {
        await page.clock.runFor(2500);
        await page.evaluate(() => {
            const watched = ['bpt-settings', 'bpt-animated-bg-panel', 'bpt-animated-bg-layer'].map(id => document.getElementById(id));
            const describe = record => `${record.type} ${record.attributeName ?? ''} ${record.target.id || record.target.className}`.trim();
            const records = [];
            const observer = new MutationObserver(list => records.push(...list.map(describe)));
            observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
            for (const element of watched.filter(Boolean)) {
                observer.observe(element, { attributes: true, childList: true, subtree: true });
            }
            window.bptIdleWatch = { observer, describe, records, present: watched.map(element => Boolean(element)) };
        });
        await page.clock.runFor(3500);
        const result = await page.evaluate(() => {
            const { observer, describe, records, present } = window.bptIdleWatch;
            records.push(...observer.takeRecords().map(describe));
            observer.disconnect();
            return { present, records };
        });

        expect(result.present).toEqual([true, true, true]);
        expect(result.records).toEqual([]);
    });

    test('keeps saved source cards between ticks and still applies and removes them', async ({ page }) => {
        await page.evaluate(async () => {
            const context = window.SillyTavern.getContext();
            const { background_settings: backgroundSettings } = await import('/scripts/backgrounds.js');
            const { chat_metadata: chatMetadata } = await import('/script.js');
            const originalSettings = context.extensionSettings.BunnyPresetTools;
            const container = document.getElementById('bpt-animated-bg-sources');
            window.bptSources = {
                context,
                backgroundSettings,
                chatMetadata,
                originalSettings,
                original: {
                    sources: originalSettings.savedAnimatedSources,
                    enabled: originalSettings.enableAnimatedBackgrounds,
                    backgroundName: backgroundSettings.name,
                    backgroundUrl: backgroundSettings.url,
                    bgImage: document.getElementById('bg1').style.backgroundImage,
                    lockedBackground: chatMetadata.custom_background,
                },
                layer: document.getElementById('bpt-animated-bg-layer'),
                cards: () => [...container.querySelectorAll('.bpt-animated-source-card')],
                out: {},
            };

            // Applying a source writes the chat's locked background when one is set.
            delete chatMetadata.custom_background;
            originalSettings.enableAnimatedBackgrounds = true;
            originalSettings.savedAnimatedSources = ['https://example.invalid/bpt-a.mp4', 'https://example.invalid/bpt-b.webm'];
        });

        try {
            await page.clock.runFor(1500);
            await page.evaluate(() => {
                const state = window.bptSources;
                state.rendered = state.cards();
                state.out.renderedCount = state.rendered.length;
            });

            await page.clock.runFor(2500);
            await page.evaluate(() => {
                const state = window.bptSources;
                const afterTicks = state.cards();
                state.out.sameCardsAfterTicks = afterTicks.length === state.rendered.length && afterTicks.every((card, index) => card === state.rendered[index]);
                state.rendered[0].querySelector('.bpt-animated-source-main').click();
            });

            await page.clock.runFor(500);
            await page.evaluate(() => {
                const state = window.bptSources;
                state.out.applied = {
                    videoSrc: state.layer.querySelector('video')?.getAttribute('src') ?? null,
                    bodyClass: document.body.classList.contains('bpt-animated-bg-active'),
                    activeCards: state.cards().filter(card => card.classList.contains('is-active')).map(card => card.textContent.trim()),
                };
                const enabled = document.getElementById('bpt-animated-bg-enabled');
                enabled.checked = false;
                enabled.dispatchEvent(new Event('change', { bubbles: true }));
            });

            await page.clock.runFor(500);
            await page.evaluate(() => {
                const state = window.bptSources;
                state.out.disabled = {
                    layerChildren: state.layer.childElementCount,
                    bodyClass: document.body.classList.contains('bpt-animated-bg-active'),
                };
                state.cards()[1].querySelector('.menu_button').click();
            });

            await page.clock.runFor(200);
            await page.evaluate(() => {
                const state = window.bptSources;
                state.out.afterRemove = { cards: state.cards().length, sources: [...state.context.extensionSettings.BunnyPresetTools.savedAnimatedSources] };
                state.replacement = { ...state.context.extensionSettings.BunnyPresetTools };
                state.context.extensionSettings.BunnyPresetTools = state.replacement;
            });

            await page.clock.runFor(1500);
            await page.evaluate(() => window.bptSources.cards()[0].querySelector('.menu_button').click());

            await page.clock.runFor(200);
            await page.evaluate(() => {
                const state = window.bptSources;
                state.out.afterReplacedSettingsRemove = { cards: state.cards().length, sources: [...state.replacement.savedAnimatedSources] };
            });
        } finally {
            await page.evaluate(() => {
                const { context, backgroundSettings, chatMetadata, originalSettings, original } = window.bptSources;
                context.extensionSettings.BunnyPresetTools = originalSettings;
                originalSettings.savedAnimatedSources = original.sources;
                originalSettings.enableAnimatedBackgrounds = original.enabled;
                backgroundSettings.name = original.backgroundName;
                backgroundSettings.url = original.backgroundUrl;
                document.getElementById('bg1').style.backgroundImage = original.bgImage;
                if (original.lockedBackground !== undefined) {
                    chatMetadata.custom_background = original.lockedBackground;
                }
                document.getElementById('bpt-animated-bg-enabled').checked = original.enabled;
            });
        }

        const result = await page.evaluate(() => window.bptSources.out);
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
        await page.evaluate(() => {
            const settings = window.SillyTavern.getContext().extensionSettings.BunnyPresetTools;
            const input = document.getElementById('bpt-divider-patterns');
            window.bptDivider = { settings, input, originalPattern: settings.dividerRegexPattern, out: {} };
            input.value = 'typed, not saved';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });

        try {
            await page.clock.runFor(2500);
            await page.evaluate(() => {
                const state = window.bptDivider;
                state.out.unsaved = state.input.value;
                state.input.value = '  ^##  ';
                document.getElementById('bpt-save-divider-patterns').click();
                state.out.saved = { setting: state.settings.dividerRegexPattern, field: state.input.value };
                state.settings.dividerRegexPattern = 'changed elsewhere';
            });

            await page.clock.runFor(1500);
            await page.evaluate(() => {
                const state = window.bptDivider;
                state.out.external = state.input.value;
            });
        } finally {
            await page.evaluate(() => {
                const state = window.bptDivider;
                state.settings.dividerRegexPattern = state.originalPattern;
            });
            await page.clock.runFor(1500);
        }

        const result = await page.evaluate(() => {
            const state = window.bptDivider;
            state.out.restored = state.input.value === state.originalPattern;
            return state.out;
        });
        expect(result.unsaved).toBe('typed, not saved');
        expect(result.saved).toEqual({ setting: '^##', field: '^##' });
        expect(result.external).toBe('changed elsewhere');
        expect(result.restored).toBe(true);
    });
});
