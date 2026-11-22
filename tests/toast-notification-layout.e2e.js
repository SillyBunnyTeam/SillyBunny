import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { selectSampleCharacter } from './chat-scroll-regression-helpers.js';
import { waitForAppReady } from './helpers/app-ready.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { NOTIFICATION_FORM_SELECTOR, TOAST_FORM_SELECTOR } from './helpers/toasts.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/toast-forms-fixture.js', import.meta.url));
const STAY = { timeOut: 0, extendedTimeOut: 0 };
const HTML = { ...STAY, escapeHtml: false };
const EASE_OUT_QUAD = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)';
const EASE_OUT_BACK = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

test.use({ contextOptions: { reducedMotion: 'no-preference' } });

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    await page.goto('/');
    await waitForAppReady(page);
    await showToasts(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => window.toastr.clear());
    await page.addScriptTag({ content: await readFile(FIXTURE, 'utf8') });
});

const notificationBoxes = page => page.locator(NOTIFICATION_FORM_SELECTOR);

/** Waits until no notification is moving, so that a box that is read is the one it rests at. */
const settled = page => expect.poll(() => page.evaluate(() => [...document.querySelectorAll('#toast-container > .toast')]
    .reduce((count, node) => count + node.getAnimations().filter(animation => animation.playState !== 'finished').length, 0))).toBe(0);

const boxOf = locator => locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
});

/** Shows a notification that stays and waits until it has come in. */
async function show(page, kind, message, title, options = STAY) {
    await page.evaluate(([toastKind, text, heading, toastOptions]) => window.toastr[toastKind](text, heading, toastOptions), [kind, message, title, options]);
    await settled(page);
    return notificationBoxes(page).filter({ hasText: title }).first();
}

const setPosition = (page, position) => page.evaluate(async (value) => (await import('/scripts/sillybunny-toast-motion.js')).setNotificationPosition(value), position);

test.describe('the card', () => {
    test('has Shell\'s metrics: 34em wide, 15px radius, 6px of padding around a 6px content box, a 4px margin, the popover ink and shadow, no border', async ({ page }) => {
        const card = await show(page, 'error', 'The provider refused the request.', 'Provider error');
        const look = await card.evaluate((node) => {
            const style = getComputedStyle(node);
            const px = value => Number.parseFloat(value);
            return {
                width: node.getBoundingClientRect().width,
                em: px(style.fontSize),
                radius: px(style.borderTopLeftRadius),
                padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(px),
                margin: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft].map(px),
                border: style.borderTopWidth,
                shadow: style.boxShadow,
                image: style.backgroundImage,
                background: style.backgroundColor,
                ink: style.color,
                popoverInk: getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBodyColor').trim(),
            };
        });
        expect(look.width).toBeCloseTo(34 * look.em, 0);
        expect(look.radius).toBe(15);
        expect(look.padding, 'the card\'s 6px, and 6px more at the top and the bottom, which the content box adds').toEqual([12, 6, 12, 6]);
        expect(look.margin).toEqual([4, 4, 4, 4]);
        expect(look.border).toBe('0px');
        expect(look.shadow).not.toBe('none');
        expect(look.image, 'no PNG icon of toastr\'s').toBe('none');
        expect(look.background, 'opaque: no alpha').toMatch(/^(rgb\([^/]*\)|color\(srgb [^/]*\))$/);
    });

    test('is opaque under a translucent theme, and the popover layer in both tones', async ({ page }) => {
        const card = await show(page, 'info', 'Body', 'Title');
        const colours = await page.evaluate(() => {
            const root = document.documentElement;
            const node = document.querySelector('#toast-container > .sb-form-notification');
            root.style.setProperty('--SmartThemeBlurTintColor', 'rgba(20, 20, 20, 0.2)');
            root.style.setProperty('--SmartThemeChatTintColor', 'rgba(250, 250, 250, 0.2)');
            const translucent = getComputedStyle(node).backgroundColor;
            root.style.removeProperty('--SmartThemeBlurTintColor');
            root.style.removeProperty('--SmartThemeChatTintColor');
            return { translucent };
        });
        expect(colours.translucent, 'opaque: no alpha').toMatch(/^(rgb\([^/]*\)|color\(srgb [^/]*\))$/);
        await expect(card).toBeVisible();
    });

    test('lays out the title bold in the ink and the body regular, 4px apart, with the full text and no header row', async ({ page }) => {
        const card = await show(page, 'info', 'The body of the message. It has a second sentence that keeps going.', 'The title');
        const layout = await card.evaluate((node) => {
            const title = node.querySelector('.toast-title');
            const message = node.querySelector('.toast-message');
            const box = element => element.getBoundingClientRect();
            return {
                titleWeight: getComputedStyle(title).fontWeight,
                bodyWeight: getComputedStyle(message).fontWeight,
                titleColour: getComputedStyle(title).color,
                ink: getComputedStyle(node).color,
                gap: box(message).top - box(title).bottom,
                textLeft: box(title).left + Number.parseFloat(getComputedStyle(title).paddingLeft) - box(node).left,
                header: node.querySelector('.sb-n-header, header') !== null,
            };
        });
        expect(Number(layout.titleWeight)).toBeGreaterThanOrEqual(700);
        expect(Number(layout.bodyWeight)).toBe(400);
        expect(layout.titleColour, 'the title is the ink, not the status colour').toBe(layout.ink);
        expect(layout.gap).toBeCloseTo(4, 0);
        expect(layout.textLeft, 'an info message has no icon: 6px of card padding and 6px of content padding').toBeCloseTo(12, 0);
        expect(layout.header).toBe(false);
    });

    test('shows the status icon of an error, a warning and a success at the start, and none for info', async ({ page }) => {
        for (const kind of ['error', 'warning', 'success']) {
            const card = await show(page, kind, `A ${kind} message`, `A ${kind}`);
            const icon = await card.evaluate((node) => {
                const before = getComputedStyle(node, '::before');
                const title = node.querySelector('.toast-title');
                return {
                    content: before.content,
                    width: Number.parseFloat(before.width),
                    height: Number.parseFloat(before.height),
                    radius: before.borderTopLeftRadius,
                    fill: before.backgroundColor,
                    glyph: before.color,
                    size: before.fontSize,
                    font: before.fontFamily,
                    ink: getComputedStyle(node).color,
                    textLeft: title.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(title).paddingLeft) - node.getBoundingClientRect().left,
                    image: getComputedStyle(node).backgroundImage,
                };
            });
            expect(icon.content, `${kind} has a glyph`).not.toBe('none');
            expect(icon.font).toContain('Font Awesome');
            expect([icon.width, icon.height]).toEqual([48, 48]);
            expect(icon.radius).toBe('50%');
            expect(icon.size).toBe('16px');
            expect(icon.glyph, 'the status colour, not the ink').not.toBe(icon.ink);
            expect(icon.fill, 'the ink at 7%').toMatch(/rgba\(.*, 0\.07\d*\)|color\(srgb .* \/ 0\.07\d*\)/);
            expect(icon.textLeft, '12px, the 48px icon and 6px before the text').toBeCloseTo(66, 0);
            expect(icon.image).toBe('none');
            await page.evaluate(() => window.toastr.clear());
            await expect(notificationBoxes(page)).toHaveCount(0, { timeout: 3000 });
        }
        const info = await show(page, 'info', 'Nothing to report', 'Info');
        expect(await info.evaluate(node => getComputedStyle(node, '::before').content)).toBe('none');
        expect(await info.evaluate(node => getComputedStyle(node).backgroundImage), 'info draws no PNG either').toBe('none');
    });

    test('puts the icon at the top at the start, 12px from the card\'s edges, and keeps it there when the text is tall', async ({ page }) => {
        const long = 'A message that is long. '.repeat(14);
        const card = await show(page, 'error', long, 'Tall');
        const box = await boxOf(card);
        const height = await card.evaluate(node => node.getBoundingClientRect().height);
        expect(height, 'tall').toBeGreaterThan(150);
        const icon = await card.evaluate((node) => {
            const point = node.getBoundingClientRect();
            const hit = document.elementsFromPoint(point.left + 12 + 24, point.top + 12 + 24);
            return { onCard: hit.includes(node), below: document.elementsFromPoint(point.left + 12 + 24, point.top + 12 + 48 + 40).includes(node) };
        });
        expect(icon.onCard).toBe(true);
        expect(box.top).toBeGreaterThan(0);
    });

    test('is 72px high when the text is shorter than the icon: the 48px icon with 12px above and below', async ({ page }) => {
        const card = await show(page, 'error', '', 'Only a title');
        expect(await card.evaluate(node => node.getBoundingClientRect().height)).toBeCloseTo(72, 0);
    });
});

test.describe('Dismiss', () => {
    test('is named Dismiss, ends the first row, and is as tall as one line so it adds no height', async ({ page }) => {
        const card = await show(page, 'info', 'Message', 'Title');
        const close = card.getByRole('button', { name: 'Dismiss', exact: true });
        await expect(close).toHaveCount(1);
        await expect(close).toHaveAttribute('title', 'Dismiss');
        const geometry = await card.evaluate((node) => {
            const button = node.querySelector('.toast-close-button').getBoundingClientRect();
            const title = node.querySelector('.toast-title');
            const range = document.createRange();
            range.selectNodeContents(title);
            const line = range.getBoundingClientRect();
            const box = node.getBoundingClientRect();
            return {
                right: box.right - button.right,
                top: button.top - box.top,
                centre: (button.top + button.bottom) / 2 - (line.top + line.bottom) / 2,
                size: [button.width, button.height],
                height: box.height,
                lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight),
            };
        });
        expect(geometry.size).toEqual([34, 34]);
        expect(geometry.right, '6px of padding and 6px of margin').toBeCloseTo(12, 0);
        expect(Math.abs(geometry.centre), 'it shares the centre of the first line').toBeLessThan(2);
        expect(geometry.height, 'title, 4px, body, and 12px above and below').toBeCloseTo(12 + 2 * geometry.lineHeight + 4 + 12, 0);
    });

    test('dismisses on a click, and for /echo awaitDismissal without a timeout an error stays until it does', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { executeSlashCommandsWithOptions } = await import('/scripts/slash-commands.js');
            let resolved = false;
            const pending = executeSlashCommandsWithOptions('/echo severity=error title=Failed awaitDismissal=true A message that waits', { handleParserErrors: false }).then(() => {
                resolved = true;
            });
            window.__echoPending = pending;
            await new Promise(resolve => setTimeout(resolve, 5600));
            return { stillThere: document.querySelectorAll('#toast-container > .sb-form-notification').length, resolved };
        });
        expect(result.stillThere, 'an error without a timeout stays past 5 seconds').toBe(1);
        expect(result.resolved).toBe(false);
        await notificationBoxes(page).getByRole('button', { name: 'Dismiss', exact: true }).click();
        await page.evaluate(() => window.__echoPending);
        await expect(notificationBoxes(page)).toHaveCount(0, { timeout: 3000 });
    });
});

test.describe('a click on the card', () => {
    test('runs onclick and dismisses, and without onclick or tapToDismiss: false does nothing', async ({ page }) => {
        await page.evaluate(() => {
            window.__clicks = 0;
            window.toastr.info('With a click action', 'Action', { timeOut: 0, extendedTimeOut: 0, onclick: () => { window.__clicks += 1; } });
        });
        const withAction = notificationBoxes(page).filter({ hasText: 'Action' });
        await settled(page);
        await withAction.locator('.toast-message').click();
        await expect(withAction).toHaveCount(0, { timeout: 3000 });
        expect(await page.evaluate(() => window.__clicks)).toBe(1);

        await page.evaluate(() => window.toastr.info('Does not close', 'Inert', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false }));
        const inert = notificationBoxes(page).filter({ hasText: 'Inert' });
        await settled(page);
        await inert.locator('.toast-message').click();
        await page.waitForTimeout(700);
        await expect(inert).toBeVisible();
        expect(await inert.evaluate(node => ({ title: node.getAttribute('title'), classes: node.className }))).toMatchObject({ title: null });
    });

    test('with tapToDismiss: false and an onclick, runs it and dismisses', async ({ page }) => {
        await page.evaluate(() => {
            window.__clicks = 0;
            window.toastr.info('Open it', 'Open', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, onclick: () => { window.__clicks += 1; } });
        });
        const card = notificationBoxes(page).filter({ hasText: 'Open' });
        await settled(page);
        await card.click({ position: { x: 100, y: 10 } });
        await expect(card).toHaveCount(0, { timeout: 3000 });
        expect(await page.evaluate(() => window.__clicks)).toBe(1);
    });

    test('shows the tap hint only where a click dismisses, and the pointer cursor with it', async ({ page }) => {
        await show(page, 'info', 'Dismisses', 'Plain');
        await page.evaluate(() => window.toastr.info('Stays', 'Stays', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false }));
        const hints = await page.evaluate(() => [...document.querySelectorAll('#toast-container > .sb-form-notification')].map(node => ({
            text: node.querySelector('.toast-title').textContent,
            title: node.getAttribute('title'),
            cursor: getComputedStyle(node).cursor,
        })));
        expect(hints.find(entry => entry.text === 'Plain')).toMatchObject({ cursor: 'pointer' });
        expect(hints.find(entry => entry.text === 'Plain').title).toBeTruthy();
        expect(hints.find(entry => entry.text === 'Stays')).toMatchObject({ title: null, cursor: 'default' });
    });

    test('is not a click on a link, which opens as a link does and leaves the notification', async ({ page }) => {
        await page.evaluate(() => {
            window.__link = 0;
            window.toastr.error('Read <a href="#docs" id="doc-link">the docs</a>', 'With a link', { timeOut: 0, extendedTimeOut: 0, escapeHtml: false });
            document.getElementById('doc-link').addEventListener('click', () => { window.__link += 1; });
        });
        const card = notificationBoxes(page).filter({ hasText: 'With a link' });
        await settled(page);
        await card.locator('#doc-link').click();
        await page.waitForTimeout(500);
        await expect(card).toBeVisible();
        expect(await page.evaluate(() => window.__link)).toBe(1);
        const colours = await card.evaluate((node) => {
            const link = getComputedStyle(node.querySelector('#doc-link'));
            return { link: link.color, ink: getComputedStyle(node).color, accent: getComputedStyle(document.documentElement).getPropertyValue('--sb-accent').trim(), underline: link.textDecorationLine };
        });
        expect(colours.link, 'the normal link colour, not the ink and not the overlay\'s').not.toBe(colours.ink);
        expect(colours.underline).toBe('underline');
    });

    test('is not a click when the user selects the text of an error to copy it', async ({ page }) => {
        const card = await show(page, 'error', 'Copy this error message', 'Selectable');
        const text = card.locator('.toast-message');
        const box = await text.boundingBox();
        await page.mouse.move(box.x + 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 5 });
        await page.mouse.up();
        expect(await page.evaluate(() => window.getSelection().toString())).not.toBe('');
        await page.waitForTimeout(600);
        await expect(card).toBeVisible();
    });
});

test.describe('the button row', () => {
    /** @param {number} count */
    function buttons(count, tag = 'button') {
        return Array.from({ length: count }, (_, index) => `<${tag} type="button" class="menu_button" id="b${index + 1}">Button ${index + 1}</${tag}>`).join('');
    }

    async function layout(page, count, wrapper = 'div') {
        await page.evaluate(([markup, htmlOptions]) => window.toastr.warning(markup, 'Buttons', htmlOptions), [`<${wrapper}>Choose what to do.</${wrapper}><${wrapper}>${buttons(count)}</${wrapper}>`, HTML]);
        await settled(page);
        const card = notificationBoxes(page).filter({ hasText: 'Buttons' });
        return card.evaluate((node) => {
            const cardBox = node.getBoundingClientRect();
            return [...node.querySelectorAll('.toast-message button')].map((button) => {
                const box = button.getBoundingClientRect();
                const style = getComputedStyle(button);
                return {
                    left: box.left - cardBox.left,
                    right: cardBox.right - box.right,
                    top: box.top,
                    width: box.width,
                    height: box.height,
                    weight: style.fontWeight,
                    padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].join(' '),
                    radius: style.borderTopLeftRadius,
                    fill: style.backgroundColor,
                    parentClass: button.parentElement.className,
                };
            });
        });
    }

    for (const [count, rows] of [[1, [1]], [2, [2]], [3, [3]], [4, [3, 1]], [5, [3, 2]]]) {
        test(`${count} button${count === 1 ? '' : 's'}: rows of ${rows.join(' and ')}, equal widths in each row, bold, 6px 12px, the Control radius`, async ({ page }) => {
            const boxes = await layout(page, count);
            expect(boxes).toHaveLength(count);
            const tops = [...new Set(boxes.map(box => Math.round(box.top)))];
            expect(tops, 'one top per row').toHaveLength(rows.length);
            let index = 0;
            for (const size of rows) {
                const row = boxes.slice(index, index + size);
                index += size;
                expect(new Set(row.map(box => Math.round(box.top))).size, 'a row shares one top').toBe(1);
                const widths = row.map(box => box.width);
                expect(Math.max(...widths) - Math.min(...widths), 'equal widths in a row').toBeLessThan(1.5);
            }
            for (const box of boxes) {
                expect(Number(box.weight)).toBeGreaterThanOrEqual(700);
                expect(box.padding).toBe('6px 12px 6px 12px');
                expect(box.radius).toBe('9px');
                expect(box.fill).toMatch(/rgba\(.*, 0\.1\d*\)|color\(srgb .* \/ 0\.1\d*\)/);
                expect(box.height).toBeCloseTo(32, 0);
            }
            expect(boxes[0].left, 'the row spans the card: 6px of padding and 4px of the row\'s own').toBeCloseTo(10, 0);
            expect(boxes[0].right, 'a row of one fills to the other edge').toBeGreaterThan(0);
            if (rows[0] > 1) {
                expect(boxes[1].left - boxes[0].left - boxes[0].width, '6px between buttons').toBeCloseTo(6, 0);
            }
            if (rows.length > 1) {
                expect(boxes[rows[0]].top - boxes[0].top - boxes[0].height, '6px between rows').toBeCloseTo(6, 0);
            }
        });
    }

    test('takes any element that the classifier counts as a button: a div.menu_button and a role="button" too', async ({ page }) => {
        await page.evaluate(htmlOptions => window.toastr.error('<div>Text</div><div><div class="menu_button" id="d1">One</div><span role="button" id="d2">Two</span></div>', 'Divs', htmlOptions), HTML);
        await settled(page);
        const card = notificationBoxes(page).filter({ hasText: 'Divs' });
        const [one, two] = await Promise.all(['#d1', '#d2'].map(selector => card.locator(selector).evaluate(node => ({ weight: getComputedStyle(node).fontWeight, top: node.getBoundingClientRect().top, row: node.parentElement.className }))));
        expect(one.row).toBe('sb-toast-actions');
        expect(two.row).toBe('sb-toast-actions');
        expect(Number(one.weight)).toBeGreaterThanOrEqual(700);
        expect(one.top).toBeCloseTo(two.top, 0);
    });

    test('keeps handlers working: one bound on a button, and one that an ancestor inside the message delegates', async ({ page }) => {
        await page.evaluate(() => {
            window.__calls = [];
            const body = document.createElement('div');
            body.append('Choose ');
            for (const name of ['first', 'second']) {
                const button = document.createElement('button');
                button.type = 'button';
                button.id = `h-${name}`;
                button.textContent = name;
                button.addEventListener('click', () => window.__calls.push(`direct-${name}`));
                body.append(button);
            }
            window.jQuery(body).on('click', 'button', function () { window.__calls.push(`delegated-${this.id}`); });
            window.toastr.error(body, 'Handlers', { timeOut: 0, extendedTimeOut: 0, escapeHtml: false });
        });
        const card = notificationBoxes(page).filter({ hasText: 'Handlers' });
        await settled(page);
        await card.locator('#h-first').click();
        await card.locator('#h-second').click();
        expect(await page.evaluate(() => window.__calls)).toEqual(['direct-first', 'delegated-h-first', 'direct-second', 'delegated-h-second']);
        await expect(card, 'a press on a button is not a click on the card').toBeVisible();
    });

    test('a bundled call site: the draft recovery message keeps its two buttons working, and a wrapper that holds only the row adds no gap', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { showDraftRecoveryToast } = await import('/scripts/sillybunny-editor/chrome.js');
            const calls = [];
            showDraftRecoveryToast({ ts: Date.now() - 5 * 60 * 1000 }, { restore: () => calls.push('restore'), discard: () => calls.push('discard') });
            window.__draftCalls = calls;
        });
        expect(result).toBeUndefined();
        const card = notificationBoxes(page).filter({ hasText: 'Unsaved changes' });
        await settled(page);
        const gap = await card.evaluate((node) => {
            const wrapper = node.querySelector('.sb-draft-toast__actions');
            const row = wrapper.querySelector('.sb-toast-actions');
            return { wrapperMargin: getComputedStyle(wrapper).marginTop, wrapperPadding: getComputedStyle(wrapper).paddingTop, same: wrapper.getBoundingClientRect().height === row.getBoundingClientRect().height + 6 - 6 };
        });
        expect(gap.wrapperMargin).toBe('0px');
        await card.locator('#sb_draft_restore_btn').click();
        await expect(card).toHaveCount(0, { timeout: 3000 });
        expect(await page.evaluate(() => window.__draftCalls)).toEqual(['restore']);
    });
});

test.describe('on a coarse pointer', () => {
    test.use({ hasTouch: true, isMobile: true });

    test('a button and Dismiss have a 44px target, the fill stays 32px, and the card is not taller for it', async ({ page }) => {
        test.skip(!await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'this engine does not report a coarse pointer for an emulated touch screen');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(htmlOptions => window.toastr.warning('<div>Text</div><div><button type="button" class="menu_button" id="t1">One</button><button type="button" class="menu_button" id="t2">Two</button></div>', 'Touch', htmlOptions), HTML);
        await settled(page);
        const card = notificationBoxes(page).filter({ hasText: 'Touch' });
        for (const control of [card.locator('#t1'), card.getByRole('button', { name: 'Dismiss', exact: true })]) {
            const hit = await control.evaluate((node) => {
                const box = node.getBoundingClientRect();
                const at = (x, y) => document.elementFromPoint(x, y);
                const inside = element => element === node || node.contains(element);
                const style = getComputedStyle(node);
                const border = Number.parseFloat(style.borderTopWidth);
                return {
                    top: inside(at(box.left + box.width / 2, box.top + box.height / 2 - 20)),
                    bottom: inside(at(box.left + box.width / 2, box.top + box.height / 2 + 20)),
                    height: box.height,
                    visibleHeight: node.matches('.toast-close-button') ? 34 : box.height - 2 * border,
                };
            });
            expect(hit).toMatchObject({ top: true, bottom: true });
            expect(hit.visibleHeight, 'the fill and the ring stay 32px (34px for Dismiss)').toBeGreaterThanOrEqual(32);
        }
        expect(await card.locator('#t1').evaluate(node => node.getBoundingClientRect().height), 'the target is at least 44px').toBeGreaterThanOrEqual(44);
    });
});

test.describe('text that changes after the notification shows', () => {
    test('reflows inside the card: the card grows, keeps its width, and the text stays between the icon and Dismiss', async ({ page }) => {
        const card = await show(page, 'info', 'Working', 'Progress');
        const before = await boxOf(card);
        await page.evaluate(() => {
            document.querySelector('#toast-container > .sb-form-notification .toast-message').textContent = 'A progress line that is much longer than before, so it has to wrap inside the card instead of widening it or running past the edge. '.repeat(3);
        });
        const after = await boxOf(card);
        expect(after.width).toBeCloseTo(before.width, 0);
        expect(after.height).toBeGreaterThan(before.height + 40);
        const text = await card.evaluate((node) => {
            const message = node.querySelector('.toast-message');
            const range = document.createRange();
            range.selectNodeContents(message);
            const rects = [...range.getClientRects()];
            const close = node.querySelector('.toast-close-button').getBoundingClientRect();
            return { right: Math.max(...rects.map(rect => rect.right)), closeLeft: close.left, cardRight: node.getBoundingClientRect().right };
        });
        expect(text.right).toBeLessThanOrEqual(text.closeLeft);
        expect(text.right).toBeLessThanOrEqual(text.cardRight);
    });
});

test.describe('the motion', () => {
    test('comes in over 200ms: a fade with ease-out-quad, and at the same time a slide from one height above and a scale from 0.9 with ease-out-back', async ({ page }) => {
        const result = await page.evaluate(() => {
            const element = window.toastr.error('Coming in', 'Motion', { timeOut: 0, extendedTimeOut: 0 })[0];
            const animations = element.getAnimations().map(animation => ({
                keyframes: animation.effect.getKeyframes().map(({ opacity, transform }) => ({ opacity, transform })),
                duration: animation.effect.getTiming().duration,
                easing: animation.effect.getTiming().easing,
            }));
            return { animations, height: element.offsetHeight };
        });
        const fade = result.animations.find(animation => animation.keyframes.some(frame => frame.opacity === '0'));
        const slide = result.animations.find(animation => animation.keyframes.some(frame => frame.transform));
        expect(fade.keyframes.map(frame => frame.opacity)).toEqual(['0', '1']);
        expect(fade.duration).toBe(200);
        expect(fade.easing).toBe(EASE_OUT_QUAD);
        expect(slide.duration).toBe(200);
        expect(slide.easing).toBe(EASE_OUT_BACK);
        expect(slide.keyframes[0].transform).toBe(`translateY(${-result.height}px) scale(0.9)`);
        expect(slide.keyframes[1].transform).toBe('none');
    });

    test('at a bottom position comes up from one height below', async ({ page }) => {
        await setPosition(page, 'toast-bottom-center');
        const result = await page.evaluate(() => {
            const element = window.toastr.error('Coming up', 'Motion', { timeOut: 0, extendedTimeOut: 0 })[0];
            const slide = element.getAnimations().find(animation => animation.effect.getKeyframes().some(frame => frame.transform));
            return { transform: slide.effect.getKeyframes()[0].transform, height: element.offsetHeight };
        });
        expect(result.transform).toBe(`translateY(${result.height}px) scale(0.9)`);
        await setPosition(page, 'toast-top-center');
    });

    for (const [position, sign] of [['toast-top-center', -1], ['toast-bottom-center', 1]]) {
        test(`leaves over 200ms with a fade and a slide back by its own height, both ease-out-back, and no scale, at ${position}`, async ({ page }) => {
            await setPosition(page, position);
            const card = await show(page, 'info', 'Going', 'Leaving');
            const result = await page.evaluate(() => {
                const element = document.querySelector('#toast-container > .sb-form-notification');
                const height = element.offsetHeight;
                window.toastr.clear(window.jQuery(element));
                return {
                    height,
                    animations: element.getAnimations().map(animation => ({
                        keyframes: animation.effect.getKeyframes().map(({ opacity, transform }) => ({ opacity, transform })),
                        duration: animation.effect.getTiming().duration,
                        easing: animation.effect.getTiming().easing,
                    })),
                };
            });
            expect(result.animations).toHaveLength(2);
            const fade = result.animations.find(animation => animation.keyframes.some(frame => frame.opacity === '0'));
            const slide = result.animations.find(animation => animation.keyframes.some(frame => frame.transform));
            expect([fade.duration, slide.duration]).toEqual([200, 200]);
            expect([fade.easing, slide.easing]).toEqual([EASE_OUT_BACK, EASE_OUT_BACK]);
            expect(slide.keyframes.at(-1).transform).toBe(`translateY(${sign * result.height}px)`);
            expect(slide.keyframes.some(frame => frame.transform?.includes('scale')), 'no scale').toBe(false);
            await expect(card).toHaveCount(0, { timeout: 3000 });
            await setPosition(page, 'toast-top-center');
        });
    }

    test('is a fade of at most 200ms under reduced motion, in and out', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const entering = await page.evaluate(() => {
            const element = window.toastr.info('Fading', 'Fade', { timeOut: 0, extendedTimeOut: 0 })[0];
            return element.getAnimations().map(animation => ({
                keyframes: animation.effect.getKeyframes().map(({ opacity, transform }) => ({ opacity, transform })),
                duration: animation.effect.getTiming().duration,
            }));
        });
        expect(entering).toHaveLength(1);
        expect(entering[0].keyframes.map(frame => frame.opacity)).toEqual(['0', '1']);
        expect(entering[0].keyframes.every(frame => frame.transform === undefined)).toBe(true);
        expect(entering[0].duration).toBeLessThanOrEqual(200);
        const leaving = await page.evaluate(() => {
            const element = document.querySelector('#toast-container > .sb-form-notification');
            window.toastr.clear(window.jQuery(element));
            return element.getAnimations().map(animation => ({ keyframes: animation.effect.getKeyframes().map(({ opacity, transform }) => ({ opacity, transform })), duration: animation.effect.getTiming().duration }));
        });
        expect(leaving).toHaveLength(1);
        expect(leaving[0].keyframes.every(frame => frame.transform === undefined)).toBe(true);
        expect(leaving[0].duration).toBeLessThanOrEqual(200);
    });

    test('the others move to their new places over 200ms with ease-out-quad, with position only, when one comes and when one goes', async ({ page }) => {
        const first = await show(page, 'info', 'First', 'First');
        const firstTop = (await boxOf(first)).top;
        const result = await page.evaluate(() => {
            const firstElement = document.querySelector('#toast-container > .sb-form-notification');
            window.toastr.error('Second', 'Second', { timeOut: 0, extendedTimeOut: 0 });
            return firstElement.getAnimations().map(animation => ({
                properties: [...new Set(animation.effect.getKeyframes().flatMap(frame => Object.keys(frame)))].filter(name => !['offset', 'computedOffset', 'easing', 'composite'].includes(name)),
                duration: animation.effect.getTiming().duration,
                easing: animation.effect.getTiming().easing,
                translate: animation.effect.getKeyframes().map(frame => frame.translate),
            }));
        });
        expect(result, 'one animation on the notification that was already there').toHaveLength(1);
        expect(result[0].properties).toEqual(['translate']);
        expect(result[0].duration).toBe(200);
        expect(result[0].easing).toBe(EASE_OUT_QUAD);
        expect(result[0].translate[0], 'it starts at its old place, above where the new one pushes it').toMatch(/^0px -?\d/);
        await settled(page);
        expect((await boxOf(first)).top, 'it rests lower than before').toBeGreaterThan(firstTop + 40);

        const afterGoing = await page.evaluate(() => {
            const second = [...document.querySelectorAll('#toast-container > .sb-form-notification')].find(node => node.textContent.includes('Second'));
            const firstElement = [...document.querySelectorAll('#toast-container > .sb-form-notification')].find(node => node.textContent.includes('First'));
            window.toastr.clear(window.jQuery(second));
            return {
                pinned: second.style.position,
                moving: firstElement.getAnimations().filter(animation => animation.effect.getKeyframes().some(frame => frame.translate !== undefined)).length,
            };
        });
        expect(afterGoing.pinned, 'the one that goes is taken out of the flow at its place').toBe('absolute');
        expect(afterGoing.moving, 'the one behind it closes the gap').toBe(1);
    });

    test('three show at once, a fourth waits and shows when one is dismissed, newest nearest the edge', async ({ page }) => {
        await page.evaluate(() => {
            for (const name of ['One', 'Two', 'Three', 'Four']) window.toastr.info(`${name} text`, name, { timeOut: 60000, extendedTimeOut: 60000 });
        });
        await settled(page);
        const visible = notificationBoxes(page).filter({ has: page.locator(':scope') });
        const tops = await page.evaluate(() => [...document.querySelectorAll('#toast-container > .sb-form-notification')].filter(node => node.style.display !== 'none').map(node => ({ title: node.querySelector('.toast-title').textContent, top: node.getBoundingClientRect().top })));
        expect(tops.map(entry => entry.title), 'three on screen, the newest first at a top position').toEqual(['Three', 'Two', 'One']);
        expect(tops.map(entry => entry.top)).toEqual([...tops.map(entry => entry.top)].sort((a, b) => a - b));
        await notificationBoxes(page).filter({ hasText: 'Three text' }).getByRole('button', { name: 'Dismiss', exact: true }).click();
        await expect(page.locator('#toast-container > .sb-form-notification:visible', { hasText: 'Four text' })).toBeVisible({ timeout: 3000 });
        await expect(visible.first()).toBeVisible();
    });
});

test.describe('where it sits', () => {
    test('at a top position, 4px under the top bar', async ({ page }) => {
        const card = await show(page, 'info', 'At the top', 'Top');
        const { top, bar } = await card.evaluate(node => ({ top: node.getBoundingClientRect().top, bar: Number.parseFloat(getComputedStyle(node.parentElement).marginTop) }));
        expect(top - bar).toBeCloseTo(4, 0);
    });

    test('at the corners, 4px from the window\'s side', async ({ page }) => {
        for (const [position, side] of [['toast-top-left', 'left'], ['toast-top-right', 'right'], ['toast-bottom-left', 'left'], ['toast-bottom-right', 'right']]) {
            await setPosition(page, position);
            await page.evaluate(() => window.toastr.clear());
            const card = await show(page, 'info', `At ${position}`, 'Corner');
            const box = await boxOf(card);
            expect(side === 'left' ? box.left : 1440 - box.right, position).toBeCloseTo(4, 0);
            await page.evaluate(() => window.toastr.clear());
            await expect(notificationBoxes(page)).toHaveCount(0, { timeout: 3000 });
        }
        await setPosition(page, 'toast-top-center');
    });

    test('at a bottom position on Home, 4px above the window edge', async ({ page }) => {
        await setPosition(page, 'toast-bottom-center');
        const card = await show(page, 'info', 'At the bottom', 'Bottom');
        expect(900 - (await boxOf(card)).bottom).toBeCloseTo(4, 0);
        await setPosition(page, 'toast-top-center');
    });

    test('at a bottom position in a chat, 4px above the composer, and it follows the page back to Home', async ({ page }) => {
        await selectSampleCharacter(page);
        await expect(page.locator('#form_sheld')).toBeVisible();
        await setPosition(page, 'toast-bottom-center');
        const card = await show(page, 'info', 'Above the composer', 'Composer');
        const composer = await boxOf(page.locator('#form_sheld'));
        await expect.poll(async () => composer.top - (await boxOf(card)).bottom).toBeCloseTo(4, 0);
        await page.locator('#sb-home-toggle').click();
        await expect(page.locator('#form_sheld')).toBeHidden();
        await expect.poll(async () => 900 - (await boxOf(card)).bottom).toBeCloseTo(4, 0);
        await setPosition(page, 'toast-top-center');
    });

    test('puts the newest nearest the edge it sits at, at a bottom position too', async ({ page }) => {
        await setPosition(page, 'toast-bottom-center');
        await show(page, 'info', 'Older', 'Older');
        await show(page, 'info', 'Newer', 'Newer');
        const tops = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#toast-container > .sb-form-notification')].map(node => [node.querySelector('.toast-title').textContent, node.getBoundingClientRect().top])));
        expect(tops.Newer, 'the newer one is lower, nearer the bottom edge').toBeGreaterThan(tops.Older);
        await setPosition(page, 'toast-top-center');
    });

    test('at the same bottom position as the toasts, sits beyond the toast with its 4px margin', async ({ page }) => {
        await page.evaluate(async () => {
            const motion = await import('/scripts/sillybunny-toast-motion.js');
            motion.setToastPosition('toast-bottom-center');
            motion.setNotificationPosition('toast-bottom-center');
        });
        const card = await show(page, 'warning', 'Beyond', 'Beyond');
        await page.evaluate(() => window.toastr.success('A toast', '', { timeOut: 0, extendedTimeOut: 0 }));
        const toast = page.locator(TOAST_FORM_SELECTOR);
        await expect(toast).toBeVisible();
        await settled(page);
        // The notification moves over 300ms when the stack offset changes, so the gap is read until it rests at the toast's 12px margin and the notification's 4px.
        await expect.poll(async () => (await boxOf(toast)).top - (await boxOf(card)).bottom).toBeCloseTo(16, 0);
        await page.evaluate(async () => {
            const motion = await import('/scripts/sillybunny-toast-motion.js');
            motion.setToastPosition('toast-bottom-center');
            motion.setNotificationPosition('toast-top-center');
        });
    });
});

test.describe('while a dialog opens and closes', () => {
    /**
     * Samples the notification's box on every frame from before a dialog opens until it has closed, and returns the frames in
     * which it is drawn. The dialog's open and close animation transforms its box, and a fixed element inside a transformed
     * ancestor is placed against that ancestor, which would move the notification.
     */
    async function sample(page, open, close) {
        return page.evaluate(async ([openSource, closeSource]) => {
            const node = document.querySelector('#toast-container > .sb-form-notification');
            const read = () => {
                const box = node.getBoundingClientRect();
                const style = getComputedStyle(node);
                const hidden = style.visibility === 'hidden' || getComputedStyle(node.parentElement).visibility === 'hidden';
                return { top: Math.round(box.top * 10) / 10, left: Math.round(box.left * 10) / 10, width: Math.round(box.width * 10) / 10, hidden };
            };
            const frames = [read()];
            let running = true;
            const loop = () => {
                frames.push(read());
                if (running) requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);
            // eslint-disable-next-line no-new-func
            await new Function(`return (async () => { ${openSource} })()`)();
            await new Promise(resolve => setTimeout(resolve, 900));
            // eslint-disable-next-line no-new-func
            await new Function(`return (async () => { ${closeSource} })()`)();
            await new Promise(resolve => setTimeout(resolve, 900));
            running = false;
            return frames;
        }, [open, close]);
    }

    const HOSTS = [
        {
            name: 'a Popup',
            open: 'const { Popup, POPUP_TYPE } = await import("/scripts/popup.js"); window.__popup = new Popup("<h3>A Popup</h3><p>Text</p>", POPUP_TYPE.TEXT, ""); void window.__popup.show();',
            close: 'await window.__popup.completeCancelled();',
        },
        {
            name: 'a frame of the shared dialog',
            open: 'await window.__toastForms.openFrame();',
            close: 'await window.__toastForms.closeFrame();',
        },
    ];

    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        for (const host of HOSTS) {
            test(`does not move in the window while ${host.name} opens and closes, at ${viewport.width}px`, async ({ page }) => {
                await page.setViewportSize(viewport);
                await show(page, 'warning', 'Stays where it is', 'Dialog');
                const frames = await sample(page, host.open, host.close);
                const drawn = frames.filter(frame => !frame.hidden);
                expect(drawn.length, 'the notification is drawn in most frames').toBeGreaterThan(frames.length / 2);
                const { top, left, width } = frames[0];
                for (const frame of drawn) {
                    expect(Math.abs(frame.top - top), `top at ${frame.top} against ${top}`).toBeLessThan(1);
                    expect(Math.abs(frame.left - left)).toBeLessThan(1);
                    expect(Math.abs(frame.width - width)).toBeLessThan(1);
                }
            });
        }
    }
});
