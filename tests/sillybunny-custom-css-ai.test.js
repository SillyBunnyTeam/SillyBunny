import { describe, expect, jest, test } from '@jest/globals';

async function importHelper({ resolvedProfileId = 'profile-1', profileResponse = { content: '.profile { color: red; }' }, fallbackResponse = '.fallback { color: blue; }', sendRequestImpl = null } = {}) {
    jest.resetModules();

    const sendRequest = sendRequestImpl ?? jest.fn(async () => profileResponse);
    const generateRaw = jest.fn(async () => fallbackResponse);
    const resolveConnectionProfile = jest.fn(profileId => String(profileId || resolvedProfileId).trim());
    const extractProfileResponseText = jest.fn(response => String(response?.content ?? response ?? ''));

    await jest.unstable_mockModule('../public/script.js', () => ({ generateRaw }));
    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({ resolveConnectionProfile }));
    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/profile-utils.js', () => ({
        getConnectionManagerRequestService: jest.fn(() => ({ sendRequest })),
    }));
    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/llm-utils.js', () => ({ extractProfileResponseText }));

    const helper = await import('../public/scripts/sillybunny-custom-css-ai.js');
    return { helper, sendRequest, generateRaw, resolveConnectionProfile, extractProfileResponseText };
}

describe('SillyBunny Custom CSS AI helper', () => {
    test('preserves the shared abort-like error export', async () => {
        const { helper } = await importHelper();

        expect(helper.isAbortLikeError(new Error('request cancelled'))).toBe(true);
        expect(helper.isAbortLikeError(new Error('request failed'))).toBe(false);
    });

    test('normalizes fenced CSS and style tags', async () => {
        const { helper } = await importHelper();

        expect(helper.normalizeGeneratedCustomCss('```css\n<style>\n.mes { border-radius: 12px; }\n</style>\n```'))
            .toBe('.mes { border-radius: 12px; }');
    });

    test('builds messages with request, current CSS, and theme variables', async () => {
        const { helper } = await importHelper();
        const messages = helper.buildCustomCssAIMessages({
            instruction: 'Make chat bubbles softer.',
            currentCss: '.mes { padding: 1rem; }',
            paletteSnapshot: '--SmartThemeBodyColor: white;',
        });

        expect(messages).toHaveLength(2);
        expect(messages[0].role).toBe('system');
        expect(messages[0].content).toContain('Output ONLY raw CSS');
        expect(messages[1].content).toContain('Make chat bubbles softer.');
        expect(messages[1].content).toContain('.mes { padding: 1rem; }');
        expect(messages[1].content).toContain('--SmartThemeBodyColor: white;');
    });

    test('uses the resolved connection profile before falling back', async () => {
        const { helper, sendRequest, generateRaw } = await importHelper({
            profileResponse: { content: '```css\n.profile { color: red; }\n```' },
        });

        const css = await helper.generateCustomCssWithAI({
            instruction: 'Use red accents.',
            currentCss: '',
            profileId: 'profile-2',
            paletteSnapshot: '',
        });

        expect(css).toBe('.profile { color: red; }');
        expect(sendRequest).toHaveBeenCalledWith(
            'profile-2',
            expect.any(Array),
            helper.CUSTOM_CSS_AI_MAX_TOKENS,
            expect.objectContaining({ extractData: true, includePreset: true, includeInstruct: true, stream: false }),
        );
        expect(generateRaw).not.toHaveBeenCalled();
    });

    test('falls back to the main model when the profile request fails', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { helper, sendRequest, generateRaw } = await importHelper({
            sendRequestImpl: jest.fn(async () => { throw new Error('profile failed'); }),
            fallbackResponse: '```css\n.fallback { color: blue; }\n```',
        });

        const css = await helper.generateCustomCssWithAI({
            instruction: 'Use blue accents.',
            currentCss: '',
            paletteSnapshot: '',
        });

        expect(css).toBe('.fallback { color: blue; }');
        expect(sendRequest).toHaveBeenCalledTimes(1);
        expect(generateRaw).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.any(Array), trimNames: false, cacheScope: 'auxiliary' }));
        warnSpy.mockRestore();
    });
});
