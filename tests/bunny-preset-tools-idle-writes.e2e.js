import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';

// BunnyPresetTools re-syncs its panels and the animated background layer when the app reports that settings changed.
// Nothing polls, so a step that changes the settings object from the page reports it like the app does after a save.
// The fake clock runs the extension's own timers between the steps without waiting for real time.
const reportSettingsChanged = page => page.evaluate(async () => {
    const { eventSource, eventTypes } = window.SillyTavern.getContext();
    await eventSource.emit(eventTypes.SETTINGS_UPDATED);
    await new Promise(resolve => queueMicrotask(resolve));
});

test.describe('BunnyPresetTools idle sync', () => {
    test.beforeEach(async ({ page }) => {
        let settingsVersion = Date.now();
        await page.route('**/api/settings/save', route => route.fulfill({ status: 200, json: { version: ++settingsVersion } }));
        await page.route('https://example.invalid/**', route => route.abort());
        // Installed before the boot, so that the extension's timers use the fake clock. Time still flows during the boot.
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
        const idle = await page.evaluate(() => {
            const { observer, describe, records } = window.bptIdleWatch;
            records.push(...observer.takeRecords().map(describe));
            observer.disconnect();
            return records;
        });

        // A settings report also makes other modules rewrite classes on <body>, so this half watches the extension's
        // own nodes and the class calls that the extension makes on <body>, and a sync that changed nothing must write none.
        await page.evaluate(() => {
            const { describe, records } = window.bptIdleWatch;
            const observer = new MutationObserver(list => records.push(...list.map(describe)));
            for (const id of ['bpt-settings', 'bpt-animated-bg-panel', 'bpt-animated-bg-layer']) {
                observer.observe(document.getElementById(id), { attributes: true, childList: true, subtree: true });
            }
            const bodyObserver = new MutationObserver(() => {});
            bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
            const bodyClasses = document.body.classList;
            for (const method of ['add', 'remove', 'toggle', 'replace']) {
                const original = DOMTokenList.prototype[method];
                bodyClasses[method] = function (...args) {
                    bodyObserver.takeRecords();
                    const result = original.apply(this, args);
                    if (String(args[0]).startsWith('bpt-') && bodyObserver.takeRecords().length) {
                        records.push(`class write ${method} ${args[0]}`);
                    }
                    return result;
                };
            }
            window.bptIdleWatch.syncObserver = observer;
        });
        for (let sync = 0; sync < 3; sync++) {
            await reportSettingsChanged(page);
            await page.clock.runFor(1200);
        }
        const result = await page.evaluate(() => {
            const { syncObserver, describe, records, present } = window.bptIdleWatch;
            records.push(...syncObserver.takeRecords().map(describe));
            syncObserver.disconnect();
            return { present, records };
        });

        expect(result.present).toEqual([true, true, true]);
        expect(idle).toEqual([]);
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
            await reportSettingsChanged(page);
            await page.clock.runFor(1500);
            await page.evaluate(() => {
                const state = window.bptSources;
                state.rendered = state.cards();
                state.out.renderedCount = state.rendered.length;
            });

            for (let sync = 0; sync < 2; sync++) {
                await reportSettingsChanged(page);
                await page.clock.runFor(1200);
            }
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

            await reportSettingsChanged(page);
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
            for (let sync = 0; sync < 2; sync++) {
                await reportSettingsChanged(page);
                await page.clock.runFor(1200);
            }
            await page.evaluate(() => {
                const state = window.bptDivider;
                state.out.unsaved = state.input.value;
                state.input.value = '  ^##  ';
                document.getElementById('bpt-save-divider-patterns').click();
                state.out.saved = { setting: state.settings.dividerRegexPattern, field: state.input.value };
                state.settings.dividerRegexPattern = 'changed elsewhere';
            });

            await reportSettingsChanged(page);
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
            await reportSettingsChanged(page);
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
