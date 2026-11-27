/** @jest-environment jsdom */
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => ({
    getParsedUA: () => ({ os: { name: 'iOS' } }),
    isMobile: () => true,
}));
await jest.unstable_mockModule('../../public/scripts/mobile-send-button.js', () => ({
    isIOSWebKitPlatform: () => true,
    isLegacyIOSWebKitPlatform: () => false,
}));

beforeAll(async () => {
    const { applyBrowserFixes } = await import('../../public/scripts/browser-fixes.js');
    applyBrowserFixes();
});

beforeEach(async () => {
    // The previous pin releases the root on the next frame, and a second pin waits for that.
    await new Promise(resolve => setTimeout(resolve, 60));
    document.documentElement.style.position = '';
    document.body.innerHTML = '<input id="field" type="text">';
});

describe('the orientation change on modern iOS WebKit', () => {
    test('pins the root to the new layout viewport while no field has the focus', () => {
        window.dispatchEvent(new Event('orientationchange'));

        expect(document.documentElement.style.position).toBe('fixed');
    });

    test('pins the root to the new layout viewport while a field has the focus', () => {
        document.getElementById('field').focus();
        expect(document.activeElement).toBe(document.getElementById('field'));

        window.dispatchEvent(new Event('orientationchange'));

        expect(document.documentElement.style.position).toBe('fixed');
    });
});
