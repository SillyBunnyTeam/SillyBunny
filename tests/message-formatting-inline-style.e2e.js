/* global document, getComputedStyle */
import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';

test.describe('message formatting inline styles', () => {
    test('preserves safe inline CSS effects and strips dangerous CSS from rendered message spans', async ({ page }) => {
        // messageFormatting needs the markdown converter, which startup creates after the document loads.
        await testSetup.awaitST({ page });

        const result = await page.evaluate(async () => {
            const mod = await import('/script.js');
            const html = mod.messageFormatting(
                [
                    '<span id="scale-stretch" style="display:inline-block;transform:scaleX(1.2);transform-origin:left center;opacity:0.7;text-shadow:2px 2px red;background:url(javascript:alert(1));">scaled</span>',
                    '<span id="font-stretch" style="display:inline-block;font-stretch:expanded;opacity:0.7;text-shadow:2px 2px red;background:url(javascript:alert(1));">stretched</span>',
                ].join(' '),
                'Bob',
                false,
                false,
                123,
                {},
                false,
            );

            const host = document.createElement('div');
            host.style.position = 'fixed';
            host.style.left = '0';
            host.style.top = '0';
            host.innerHTML = html;
            document.body.appendChild(host);
            const scaleStretch = host.querySelector('#scale-stretch');
            const fontStretch = host.querySelector('#font-stretch');
            const scaleStyle = scaleStretch?.getAttribute('style') ?? '';
            const fontStretchStyle = fontStretch?.getAttribute('style') ?? '';
            const scaleComputed = scaleStretch ? getComputedStyle(scaleStretch) : null;
            const fontStretchComputed = fontStretch ? getComputedStyle(fontStretch) : null;

            return {
                html,
                scaleStyle,
                scaleDisplay: scaleComputed?.display ?? null,
                scaleTransform: scaleComputed?.transform ?? null,
                scaleOpacity: scaleComputed?.opacity ?? null,
                scaleTextShadow: scaleComputed?.textShadow ?? null,
                scaleBackgroundImage: scaleComputed?.backgroundImage ?? null,
                fontStretchStyle,
                fontStretchDisplay: fontStretchComputed?.display ?? null,
                fontStretchValue: fontStretchComputed?.fontStretch ?? null,
                fontStretchOpacity: fontStretchComputed?.opacity ?? null,
                fontStretchTextShadow: fontStretchComputed?.textShadow ?? null,
                fontStretchBackgroundImage: fontStretchComputed?.backgroundImage ?? null,
            };
        });

        expect(result.html).toContain('style="');
        expect(result.scaleStyle).toContain('display:inline-block');
        expect(result.scaleStyle).toContain('transform:scaleX(1.2)');
        expect(result.scaleStyle).toContain('transform-origin:left center');
        expect(result.scaleStyle).toContain('opacity:0.7');
        expect(result.scaleStyle).toContain('text-shadow:2px 2px red');
        expect(result.scaleDisplay).toBe('inline-block');
        expect(result.scaleTransform).not.toBe('none');
        expect(result.scaleOpacity).toBe('0.7');
        expect(result.scaleTextShadow).not.toBe('none');
        expect(result.scaleBackgroundImage).toBe('none');

        expect(result.fontStretchStyle).toContain('display:inline-block');
        expect(result.fontStretchStyle).toContain('font-stretch:expanded');
        expect(result.fontStretchStyle).toContain('opacity:0.7');
        expect(result.fontStretchStyle).toContain('text-shadow:2px 2px red');
        expect(result.fontStretchDisplay).toBe('inline-block');
        expect(result.fontStretchValue).toBe('125%');
        expect(result.fontStretchOpacity).toBe('0.7');
        expect(result.fontStretchTextShadow).not.toBe('none');
        expect(result.fontStretchBackgroundImage).toBe('none');
    });
});
