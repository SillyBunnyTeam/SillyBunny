/* global document, HTMLElement, WheelEvent */
import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';

test.describe('favorites hotswap scrolling', () => {
    test.beforeEach(async ({ page }) => {
        await openQuietChatForSmoke(page, { selectCharacter: false });
    });

    test('scrolls vertical wheel input sideways without cancelling browser zoom gestures', async ({ page }) => {
        const result = await page.evaluate(() => {
            const hotswapBar = document.querySelector('#HotSwapWrapper .hotswap');

            if (!(hotswapBar instanceof HTMLElement)) {
                return null;
            }

            Object.defineProperties(hotswapBar, {
                clientWidth: { configurable: true, value: 100 },
                scrollWidth: { configurable: true, value: 200 },
            });

            let scrollLeft = null;
            Object.defineProperty(hotswapBar, 'scrollTo', {
                configurable: true,
                value: options => {
                    scrollLeft = options.left;
                },
            });

            const dispatchWheel = options => {
                const event = new WheelEvent('wheel', {
                    bubbles: true,
                    cancelable: true,
                    deltaY: 80,
                    ...options,
                });
                hotswapBar.dispatchEvent(event);

                return event.defaultPrevented;
            };

            return {
                ctrlWheelPrevented: dispatchWheel({ ctrlKey: true }),
                metaWheelPrevented: dispatchWheel({ metaKey: true }),
                verticalWheelPrevented: dispatchWheel({}),
                scrollLeft,
            };
        });

        expect(result).toEqual({
            ctrlWheelPrevented: false,
            metaWheelPrevented: false,
            verticalWheelPrevented: true,
            scrollLeft: 80,
        });
    });
});
