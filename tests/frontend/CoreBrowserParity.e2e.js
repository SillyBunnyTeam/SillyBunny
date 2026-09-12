import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test.describe('Core browser parity', () => {
    test.beforeEach(testSetup.awaitST);

    test('formats through all extension stages before sanitizing the result', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { extension_settings, getContext } = await import('./scripts/extensions.js');
            const { power_user } = await import('./scripts/power-user.js');
            const { regex_placement } = await import('./scripts/extensions/regex/engine.js');
            const formatter = getContext().messageFormatter;
            const messageId = 7654321;
            const seen = [];
            const originalRegex = extension_settings.regex;
            const originalDisabled = extension_settings.disabledExtensions;
            const originalEncodeTags = power_user.encode_tags;

            try {
                power_user.encode_tags = false;
                extension_settings.disabledExtensions = originalDisabled.filter(name => name !== 'regex');
                extension_settings.regex = [{
                    id: 'parity-formatter',
                    scriptName: 'Parity formatter',
                    findRegex: '/regex-seed/g',
                    replaceString: '**formatted**',
                    trimStrings: [],
                    placement: [regex_placement.AI_OUTPUT],
                    markdownOnly: true,
                    substituteRegex: 0,
                }];

                for (const stage of Object.values(formatter.stage)) {
                    formatter.addHook((text, context) => {
                        if (context.messageId !== messageId) return text;
                        seen.push({
                            stage: context.stage,
                            text,
                            characterName: context.characterName,
                            legacyName: context.ch_name,
                            frozen: Object.isFrozen(context),
                        });
                        if (stage === formatter.stage.BEFORE_REGEX) return text.replace('format-seed', 'regex-seed');
                        if (stage === formatter.stage.AFTER_MARKDOWN) {
                            return text + '<span id="parity-style" style="display:inline-block;transform:scaleX(1.2)" onmouseover="alert(1)">safe</span><img src="x" onerror="alert(1)">';
                        }
                        return text;
                    }, { stage });
                }

                const html = formatter.format('format-seed', 'Parity character', false, false, messageId);
                const host = document.createElement('div');
                host.innerHTML = html;
                return {
                    seen,
                    strongText: host.querySelector('strong')?.textContent,
                    hasUnsafeAttributes: Boolean(host.querySelector('[onerror], [onmouseover], script')),
                    inlineStyle: host.querySelector('#parity-style')?.getAttribute('style'),
                };
            } finally {
                extension_settings.regex = originalRegex;
                extension_settings.disabledExtensions = originalDisabled;
                power_user.encode_tags = originalEncodeTags;
            }
        });

        expect(result.seen.map(item => item.stage)).toEqual(['beforeRegex', 'afterRegex', 'afterMarkdown']);
        expect(result.seen[0].text).toBe('format-seed');
        expect(result.seen[1].text).toBe('**formatted**');
        expect(result.seen[2].text).toContain('<strong>formatted</strong>');
        expect(result.seen.every(item => item.characterName === 'Parity character' && item.legacyName === 'Parity character' && item.frozen)).toBe(true);
        expect(result.strongText).toBe('formatted');
        expect(result.hasUnsafeAttributes).toBe(false);
        expect(result.inlineStyle).toContain('transform:scaleX(1.2)');
    });

    test('reads and writes indexed local and global variables without changing their serialized format', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { MacroEngine } = await import('./scripts/macros/engine/MacroEngine.js');
            const { MacroEnvBuilder } = await import('./scripts/macros/engine/MacroEnvBuilder.js');
            const { getContext } = await import('./scripts/extensions.js');
            const context = getContext();
            const names = { localArray: 'parityLocalArray', localObject: 'parityLocalObject', globalArray: 'parityGlobalArray', globalObject: 'parityGlobalObject' };
            const input = [
                '{{setvarindex::parityLocalArray::0::alpha}}{{setvarkey::parityLocalArray::1::beta}}',
                '{{setvarkey::parityLocalObject::label::gamma}}',
                '{{setglobalvarindex::parityGlobalArray::0::delta}}',
                '{{setglobalvarkey::parityGlobalObject::label::epsilon}}',
                '{{getvarindex::parityLocalArray::0}}|{{getvarkey::parityLocalArray::1}}|{{getvarkey::parityLocalObject::label}}|',
                '{{getglobalvarindex::parityGlobalArray::0}}|{{getglobalvarkey::parityGlobalObject::label}}',
            ].join('');

            context.variables.local.del(names.localArray);
            context.variables.local.del(names.localObject);
            context.variables.global.del(names.globalArray);
            context.variables.global.del(names.globalObject);
            try {
                const output = MacroEngine.evaluate(input, MacroEnvBuilder.buildFromRawEnv({ content: input }));
                return {
                    output,
                    localArray: context.variables.local.get(names.localArray),
                    localObject: context.variables.local.get(names.localObject),
                    globalArray: context.variables.global.get(names.globalArray),
                    globalObject: context.variables.global.get(names.globalObject),
                    valueType: context.macros.valueType.STRING,
                };
            } finally {
                context.variables.local.del(names.localArray);
                context.variables.local.del(names.localObject);
                context.variables.global.del(names.globalArray);
                context.variables.global.del(names.globalObject);
            }
        });

        expect(result.output).toBe('alpha|beta|gamma|delta|epsilon');
        expect(JSON.parse(result.localArray)).toEqual(['alpha', 'beta']);
        expect(JSON.parse(result.localObject)).toEqual({ label: 'gamma' });
        expect(JSON.parse(result.globalArray)).toEqual(['delta']);
        expect(JSON.parse(result.globalObject)).toEqual({ label: 'epsilon' });
        expect(result.valueType).toBe('string');
    });

    test('preserves literal pipe arguments while removing comment bodies', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { MacroEngine } = await import('./scripts/macros/engine/MacroEngine.js');
            const { MacroEnvBuilder } = await import('./scripts/macros/engine/MacroEnvBuilder.js');
            const input = 'A{{// [KEY|value] }}{{reverse::a|b}}B{{//}}hidden | {{reverse::text}}{{///}}C';
            return MacroEngine.evaluate(input, MacroEnvBuilder.buildFromRawEnv({ content: input }));
        });

        expect(result).toBe('Ab|aBC');
    });

    test('keeps a newer information block after an earlier hide animation finishes', async ({ page }) => {
        const results = await page.evaluate(async () => {
            const { setInfoBlock, clearInfoBlock } = await import('./scripts/utils.js');
            const script = await import('./script.js');
            const duration = script.animation_duration;
            const fxOff = window.$.fx.off;
            const element = document.createElement('div');
            document.body.appendChild(element);
            try {
                script.setAnimationDuration(125);
                window.$.fx.off = false;
                const results = [];
                for (const animate of [false, true]) {
                    setInfoBlock(element, 'old warning', 'warning', { animate: false });
                    clearInfoBlock(element);
                    setInfoBlock(element, 'new warning', 'warning', { animate });
                    await new Promise(resolve => window.$(element).promise().done(resolve));
                    results.push({ text: element.textContent, className: element.className, visible: element.getBoundingClientRect().height > 0 });
                }
                return results;
            } finally {
                window.$.fx.off = fxOff;
                script.setAnimationDuration(duration);
                element.remove();
            }
        });

        expect(results).toEqual([
            { text: 'new warning', className: 'info-block warning', visible: true },
            { text: 'new warning', className: 'info-block warning', visible: true },
        ]);
    });

    test('waits for the complete preset event chain before follow-up work', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { getPresetManager } = await import('./scripts/preset-manager.js');
            const { eventSource, event_types } = await import('./script.js');
            const manager = getPresetManager('openai');
            let release;
            let entered;
            let resolved = false;
            const gate = new Promise(resolve => { release = resolve; });
            const didEnter = new Promise(resolve => { entered = resolve; });
            const listener = async ({ apiId }) => {
                if (apiId !== 'openai') return;
                entered();
                await gate;
            };

            const application = manager.selectPreset(manager.getSelectedPreset()).then(() => { resolved = true; });
            // Register after selectPreset's listener so the existing PRESET_CHANGED
            // notification alone cannot prove that the remaining handlers finished.
            eventSource.on(event_types.PRESET_CHANGED, listener);
            try {
                await didEnter;
                await Promise.resolve();
                await Promise.resolve();
                const resolvedBeforeEventFinished = resolved;
                release();
                await application;
                return { resolvedBeforeEventFinished, resolved };
            } finally {
                release();
                eventSource.removeListener(event_types.PRESET_CHANGED, listener);
            }
        });

        expect(result.resolvedBeforeEventFinished).toBe(false);
        expect(result.resolved).toBe(true);
    });
});
