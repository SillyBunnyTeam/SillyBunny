import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../src/util.js', () => ({
    color: { yellow: text => text },
    getConfigValue: jest.fn((_, fallback) => fallback),
    isValidUrl: jest.fn(() => true),
}));

const { isBundledThirdPartyExtension, rejectBundledThirdPartyExtension } = await import('../src/endpoints/extensions.js');

describe('bundled third-party extensions', () => {
    test('classifies tracked bundled third-party extensions as bundled', () => {
        expect(isBundledThirdPartyExtension('BunnyPresetTools')).toBe(true);
        expect(isBundledThirdPartyExtension('ChatCompletionTabs')).toBe(true);
        expect(isBundledThirdPartyExtension('chatcompletiontabs')).toBe(true);
        expect(isBundledThirdPartyExtension('third-party/ChatCompletionTabs')).toBe(true);
        expect(isBundledThirdPartyExtension('CommunityExtension')).toBe(false);
    });

    test('rejects updater mutations for bundled third-party extensions', () => {
        const response = {
            status: jest.fn(() => response),
            send: jest.fn(),
        };

        expect(rejectBundledThirdPartyExtension('ChatCompletionTabs', response, 'deleted')).toBe(true);
        expect(response.status).toHaveBeenCalledWith(400);
        expect(response.send).toHaveBeenCalledWith(expect.stringContaining('ChatCompletionTabs is bundled with SillyBunny'));
    });

    test('rejects case-variant updater mutations for bundled third-party extensions', () => {
        const response = {
            status: jest.fn(() => response),
            send: jest.fn(),
        };

        expect(rejectBundledThirdPartyExtension('chatcompletiontabs', response, 'deleted')).toBe(true);
        expect(response.status).toHaveBeenCalledWith(400);
        expect(response.send).toHaveBeenCalledWith(expect.stringContaining('chatcompletiontabs is bundled with SillyBunny'));
    });
});
