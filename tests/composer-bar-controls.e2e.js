import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';

const IPHONE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const CONTROL_RADIUS = '9px';

/**
 * Shows the real speaker bar from index.html with chips built like group-chats.js builds them.
 * @param {import('@playwright/test').Page} page
 * @param {{ typing?: string }} [options]
 */
async function showGroupBar(page, { typing = '' } = {}) {
    await page.evaluate(({ pixel, typingText }) => {
        const bar = document.getElementById('group_speaker_controls');
        const list = bar.querySelector('.group_speaker_list');
        list.replaceChildren(...['Alice Longname', 'Bob', 'Carol Third'].map((name, index) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `group_speaker_avatar${index === 1 ? ' selected' : ''}`;
            chip.setAttribute('aria-pressed', String(index === 1));
            const image = document.createElement('img');
            image.alt = '';
            image.src = pixel;
            const label = document.createElement('span');
            label.textContent = name;
            chip.append(image, label);
            return chip;
        }));
        const indicator = document.getElementById('group_typing_indicator');
        indicator.textContent = typingText;
        indicator.classList.toggle('displayNone', !typingText);
        bar.classList.toggle('is-typing', Boolean(typingText));
        bar.classList.remove('displayNone');
    }, { pixel: PIXEL, typingText: typing });
    await waitForAnimationFrames(page, 3);
}

/**
 * Fills the page's own Quick Reply bar with buttons built like the extension builds them, and opens the phone's
 * extension tray, where that bar lives, the way a user does.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} labels
 */
async function showQuickReplies(page, labels) {
    await page.evaluate(items => {
        let bar = document.getElementById('qr--bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'qr--bar';
            document.getElementById('send_form').prepend(bar);
        }
        let row = bar.querySelector(':scope > .qr--buttons');
        if (!row) {
            row = document.createElement('div');
            row.className = 'qr--buttons';
            bar.append(row);
        }
        row.replaceChildren(...items.map(label => {
            const button = document.createElement('div');
            button.className = 'qr--button menu_button interactable';
            button.tabIndex = 0;
            button.textContent = label;
            return button;
        }));
    }, labels);
    const trayToggle = page.locator('.sb-bottom-chat-tray-toggle');
    if (await trayToggle.isVisible() && await trayToggle.getAttribute('aria-expanded') !== 'true') {
        await trayToggle.click();
    }
    await waitForAnimationFrames(page, 3);
}

function measureGroupBar(page) {
    return page.evaluate(() => {
        const box = element => {
            const rect = element.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
        };
        const bar = document.getElementById('group_speaker_controls');
        const list = bar.querySelector('.group_speaker_list');
        const chips = [...list.querySelectorAll('.group_speaker_avatar')];
        const buttons = ['group_add_greeting', 'group_speaker_now', 'group_speaker_hide'].map(id => document.getElementById(id));
        const indicator = document.getElementById('group_typing_indicator');
        return {
            bar: box(bar),
            list: box(list),
            listOverflow: list.scrollWidth - list.clientWidth,
            chips: chips.map(chip => ({
                ...box(chip),
                visibility: getComputedStyle(chip).visibility,
                radius: getComputedStyle(chip).borderTopLeftRadius,
                labelShown: getComputedStyle(chip.querySelector('span')).display !== 'none',
                pressed: chip.getAttribute('aria-pressed'),
                selected: chip.classList.contains('selected'),
            })),
            buttons: buttons.map(button => ({
                ...box(button),
                radius: getComputedStyle(button).borderTopLeftRadius,
                labelShown: getComputedStyle(button.querySelector('span')).display !== 'none',
            })),
            indicator: box(indicator),
            indicatorVisible: getComputedStyle(indicator).display !== 'none',
            listVisibility: getComputedStyle(list).visibility,
        };
    });
}

test.describe('composer, bottom bar and speaker controls on a desktop window', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('speaker chips wrap instead of clipping, keep the pointer floor and the control radius', async ({ page }) => {
        await openQuietChatForSmoke(page);
        await showGroupBar(page);

        const bar = await measureGroupBar(page);

        // The chips share the row with the buttons and none of them is cut off by the list (F-087).
        expect(bar.listOverflow).toBeLessThanOrEqual(1);
        for (const chip of bar.chips) {
            expect(chip.right).toBeLessThanOrEqual(bar.list.right + 0.5);
            expect(chip.width).toBeGreaterThan(30);
            expect(chip.height).toBeGreaterThanOrEqual(32);
            expect(chip.radius).toBe(CONTROL_RADIUS);
            expect(chip.pressed).toBe(String(chip.selected));
        }
        for (const button of bar.buttons) {
            expect(button.height).toBeGreaterThanOrEqual(32);
            expect(button.radius).toBe(CONTROL_RADIUS);
        }
    });

    test('the bar drops the button labels, then the chip names, as its own width shrinks', async ({ page }) => {
        await openQuietChatForSmoke(page);
        await showGroupBar(page);

        for (const [width, buttonLabels, chipNames] of [[1100, true, true], [700, false, true], [440, false, false]]) {
            await page.locator('#group_speaker_controls').evaluate((element, value) => { element.style.width = `${value}px`; }, width);
            await waitForAnimationFrames(page, 2);
            const bar = await measureGroupBar(page);

            expect(bar.buttons.every(button => button.labelShown === buttonLabels), `button labels at ${width}px`).toBe(true);
            expect(bar.chips.every(chip => chip.labelShown === chipNames), `chip names at ${width}px`).toBe(true);
            expect(bar.listOverflow).toBeLessThanOrEqual(1);
        }
    });

    test('Quick Reply buttons are raised buttons at the control radius, one line each', async ({ page }) => {
        await openQuietChatForSmoke(page);
        await showQuickReplies(page, ['Continue', 'A label long enough to need more than one line on its own']);

        const raised = await page.evaluate(() => {
            const probe = document.createElement('div');
            probe.style.background = 'var(--sb-raised-bg)';
            document.body.append(probe);
            const color = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return color;
        });
        const button = page.locator('#qr--bar .qr--button').first();
        const read = () => button.evaluate(element => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return { background: style.backgroundColor, radius: style.borderTopLeftRadius, whiteSpace: style.whiteSpace, height: rect.height, barOpacity: getComputedStyle(element.closest('#qr--bar')).opacity };
        });

        const resting = await read();
        expect(resting.background).toBe(raised);
        expect(resting.radius).toBe(CONTROL_RADIUS);
        expect(resting.whiteSpace).toBe('nowrap');
        expect(resting.height).toBeGreaterThanOrEqual(32);
        expect(resting.height).toBeLessThanOrEqual(44);
        expect(resting.barOpacity).toBe('1');

        const long = await page.locator('#qr--bar .qr--button').nth(1).evaluate(element => ({ height: element.getBoundingClientRect().height, clipped: element.scrollWidth > element.clientWidth }));
        expect(long.height).toBeLessThanOrEqual(44);
        expect(long.clipped).toBe(true);

        await button.hover();
        await waitForAnimationFrames(page, 2);
        expect((await read()).background).not.toBe(raised);
    });

    test('composer buttons share the control radius; send keeps its circle', async ({ page }) => {
        await openQuietChatForSmoke(page);

        const radii = await page.evaluate(() => {
            const radius = selector => {
                const element = document.querySelector(selector);
                return element && element.getBoundingClientRect().width > 0 ? getComputedStyle(element).borderTopLeftRadius : null;
            };
            return {
                options: radius('#options_button'),
                send: radius('#send_but'),
            };
        });

        expect(radii.options).toBe(CONTROL_RADIUS);
        expect(['50%', '999px']).toContain(radii.send);
    });
});

test.describe('composer, bottom bar and speaker controls on a phone', () => {
    test.use({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE_USER_AGENT,
    });

    test('the text area takes the whole first row and the rails share the row under it (F-090)', async ({ page }) => {
        await openQuietChatForSmoke(page);
        await page.evaluate(() => document.getElementById('send_but')?.classList.remove('displayNone'));
        await waitForAnimationFrames(page, 2);

        const layout = await page.evaluate(() => {
            const rect = id => document.getElementById(id).getBoundingClientRect();
            const field = rect('send_textarea');
            const left = rect('leftSendForm');
            const right = rect('rightSendForm');
            const form = rect('nonQRFormItems');
            return { fieldWidth: field.width, formWidth: form.width, fieldBottom: field.bottom, railsTop: Math.min(left.top, right.top), leftRight: left.right, rightLeft: right.left };
        });

        // The row has the form's padding either side; the field fills the rest, where it was about 170px wide beside the two rails.
        expect(layout.fieldWidth).toBeGreaterThanOrEqual(layout.formWidth - 16);
        expect(layout.fieldWidth).toBeGreaterThanOrEqual(340);
        expect(layout.railsTop).toBeGreaterThanOrEqual(layout.fieldBottom);
        expect(layout.leftRight).toBeLessThanOrEqual(layout.rightLeft + 1);
    });

    test('the typing line sits above the chips and the chips stay in view (F-088)', async ({ page }) => {
        await openQuietChatForSmoke(page);
        await showGroupBar(page, { typing: 'Alice Longname is typing...' });

        const bar = await measureGroupBar(page);

        expect(bar.indicatorVisible).toBe(true);
        expect(bar.listVisibility).toBe('visible');
        expect(bar.indicator.bottom).toBeLessThanOrEqual(bar.chips[0].top + 1);
        for (const chip of bar.chips) {
            expect(chip.visibility).toBe('visible');
            expect(chip.width).toBeGreaterThanOrEqual(44);
            expect(chip.height).toBeGreaterThanOrEqual(44);
            expect(chip.radius).toBe(CONTROL_RADIUS);
        }
        for (const button of bar.buttons) {
            expect(button.width).toBeGreaterThanOrEqual(44);
            expect(button.height).toBeGreaterThanOrEqual(44);
            expect(button.radius).toBe(CONTROL_RADIUS);
        }
    });

    test('Quick Reply buttons scroll in one row on a touch screen', async ({ page }) => {
        await openQuietChatForSmoke(page);
        await showQuickReplies(page, ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'].map(label => `${label} reply`));

        const readRow = () => page.evaluate(() => {
            const buttons = [...document.querySelectorAll('#qr--bar .qr--button')];
            const row = document.querySelector('#qr--bar > .qr--buttons');
            return {
                tops: new Set(buttons.map(button => Math.round(button.getBoundingClientRect().top))).size,
                minHeight: Math.min(...buttons.map(button => button.getBoundingClientRect().height)),
                scrolls: row.scrollWidth > row.clientWidth,
            };
        });

        // The tray opens with a short animation that scales its content; measure once it has settled.
        await expect.poll(async () => (await readRow()).minHeight).toBeGreaterThanOrEqual(44);
        const row = await readRow();

        expect(row.tops).toBe(1);
        expect(row.scrolls).toBe(true);

        // A tap leaves :hover on the button. Upstream paints that with #4d4d4d, which hides dark text on a light theme, so a touch screen keeps the resting fill.
        const first = page.locator('#qr--bar .qr--button').first();
        const resting = await first.evaluate(element => getComputedStyle(element).backgroundColor);
        await first.hover();
        await waitForAnimationFrames(page, 3);
        expect(await first.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(resting);
        expect(resting).not.toBe('rgb(77, 77, 77)');
    });
});

test.describe('composer and speaker controls on a phone held sideways', () => {
    test.use({
        viewport: { width: 844, height: 390 },
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE_USER_AGENT,
    });

    test('the chat keeps room to read with the speaker bar shown', async ({ page }) => {
        await openQuietChatForSmoke(page);
        await waitForAnimationFrames(page, 2);

        const withComposer = await page.locator('#chat').evaluate(element => element.clientHeight);
        await showGroupBar(page);
        const withGroupBar = await page.locator('#chat').evaluate(element => element.clientHeight);

        // The desktop stack of bottom bar, speaker bar and tray left no height here; the bottom bar folds into its chip row instead.
        await expect(page.locator('html')).toHaveAttribute('data-sb-mobile-ui-mode', 'mobile');
        expect(withComposer).toBeGreaterThanOrEqual(120);
        expect(withGroupBar).toBeGreaterThanOrEqual(100);
    });
});
