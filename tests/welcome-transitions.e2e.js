import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchBodyOrSkip } from './helpers/route-fetch.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'no-preference' } });
test.describe.configure({ timeout: 120_000 });

const HOST = 'dialog.sb-dialog-host:not([closing])';
const TOLERANCE = 1;

const VIEWPORTS = [
    { name: 'dialog 1440x900', options: { viewport: { width: 1440, height: 900 } } },
    { name: 'sheet 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];

/** The saved Reduced Motion setting would turn the slide off, so the settings the page loads say it is off. */
async function useMotion(page) {
    await page.route('**/api/settings/get', async (route) => {
        const fetched = await fetchBodyOrSkip(route, response => response.json());
        if (!fetched) return;
        const { response, body: data } = fetched;
        const settings = JSON.parse(data.settings);
        settings.power_user.reduced_motion = false;
        return route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
    });
}

/**
 * Installs `window.__transition(trigger)`. It runs `trigger`, freezes every finite animation inside the dialog
 * host in the same task, then steps their clock and samples the layout at each step. Stepping makes the result
 * independent of how fast the machine paints.
 */
async function installTransitionProbe(page) {
    await page.evaluate(() => {
        const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const sample = () => {
            const host = document.querySelector('dialog.sb-dialog-host:not([closing])');
            const surface = host.querySelector('.sb-dialog');
            const surfaceBox = surface.getBoundingClientRect();
            return {
                surface: surfaceBox.height,
                pages: [...host.querySelectorAll('.sb-dialog__page')].filter(page => !page.hidden).map((page) => {
                    const box = page.getBoundingClientRect();
                    return {
                        title: page.querySelector('.sb-dialog__title').textContent,
                        role: page.classList.contains('is-underlay') || page.classList.contains('is-leaving') ? 'outgoing' : 'incoming',
                        height: box.height,
                        visibleHeight: Math.max(0, Math.min(box.bottom, surfaceBox.bottom) - Math.max(box.top, surfaceBox.top)),
                        left: box.left - surfaceBox.left,
                    };
                }),
            };
        };
        const hostAnimations = () => document.getAnimations().filter(animation => animation.effect?.target?.closest?.('dialog.sb-dialog-host')
            && Number.isFinite(animation.effect.getComputedTiming().endTime));
        const endOf = animations => Math.max(0, ...animations.map(animation => animation.effect.getComputedTiming().endTime));
        // Callers fill a pushed page after push() returns, and the dialog reads the page's height once that code has run.
        const afterCaller = () => Promise.resolve();
        const step = async (animations, end, steps, record) => {
            for (let index = 0; index <= steps; index++) {
                animations.forEach((animation) => { animation.currentTime = (end * index) / steps; });
                await settle();
                record(sample());
            }
        };
        const pinnedNodes = nodes => nodes.filter(node => node.style.height !== '' || node.style.flexShrink !== '').length;
        window.__transition = async (trigger) => {
            const before = sample();
            trigger();
            await afterCaller();
            const animations = hostAnimations();
            animations.forEach(animation => animation.pause());
            const targets = animations.map(animation => animation.effect.target)
                .filter(target => target.matches('dialog.sb-dialog-host, .sb-dialog, .sb-dialog-scrim'))
                .map(target => target.className);
            const end = endOf(animations);
            const frames = [];
            await step(animations, end, 12, frame => frames.push(frame));
            animations.forEach(animation => animation.finish());
            await settle();
            await settle();
            return { before, frames, after: sample(), targets, end };
        };
        window.__interrupted = async (first, second) => {
            const before = sample();
            first();
            await afterCaller();
            const firstAnimations = hostAnimations();
            firstAnimations.forEach(animation => animation.pause());
            const firstEnd = endOf(firstAnimations);
            firstAnimations.forEach((animation) => { animation.currentTime = firstEnd * 0.4; });
            await settle();
            const middle = sample();
            second();
            await afterCaller();
            const secondAnimations = hostAnimations().filter(animation => !firstAnimations.includes(animation));
            secondAnimations.forEach(animation => animation.pause());
            const frames = [];
            await step(secondAnimations, endOf(secondAnimations), 12, frame => frames.push(frame));
            [...firstAnimations, ...secondAnimations].forEach(animation => animation.finish());
            await settle();
            await settle();
            return { before, middle, frames, after: sample() };
        };
        window.__stopped = async (trigger, how) => {
            const host = document.querySelector('dialog.sb-dialog-host:not([closing])');
            const nodes = [...host.querySelectorAll('.sb-dialog__page, .sb-dialog__pages')];
            trigger();
            await afterCaller();
            const nodesDuring = [...host.querySelectorAll('.sb-dialog__page, .sb-dialog__pages')];
            const animations = hostAnimations();
            animations.forEach(animation => animation.pause());
            const end = endOf(animations);
            animations.forEach((animation) => { animation.currentTime = end * 0.4; });
            await settle();
            const pinnedDuring = pinnedNodes(nodesDuring);
            if (how === 'cancel') animations.forEach(animation => animation.cancel());
            else window.__chain.forceClose();
            await settle();
            await new Promise(resolve => setTimeout(resolve, 900));
            return { pinnedDuring, pinnedAfter: pinnedNodes([...new Set([...nodes, ...nodesDuring])]), attached: nodesDuring.some(node => node.isConnected) };
        };
    });
}

/** Presses a response by clicking it, or by focusing it and pressing Enter. */
async function runTransition(page, selector, { keyboard }) {
    const css = `${HOST} .sb-dialog__page:not([hidden]):not(.is-underlay):not(.is-leaving) ${selector}`;
    if (!keyboard) {
        return page.evaluate(query => window.__transition(() => document.querySelector(query).click()), css);
    }
    await page.locator(css).focus();
    await page.keyboard.press('Shift');
    return page.evaluate(() => window.__transition(() => document.activeElement.click()));
}

function expectSteadyTransition({ before, frames, after, targets }, { rtl = false } = {}) {
    const from = before.surface;
    const to = after.surface;
    const low = Math.min(from, to) - TOLERANCE;
    const high = Math.max(from, to) + TOLERANCE;
    const outgoingHeight = before.pages[0].height;
    const incomingHeight = after.pages[0].height;

    expect(before.pages).toHaveLength(1);
    expect(after.pages).toHaveLength(1);

    expect(Math.abs(frames[0].surface - from), `the frame at the start of the slide is ${frames[0].surface}px high, and the dialog was ${from}px high`).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(frames.at(-1).surface - to), `the last frame is ${frames.at(-1).surface}px high, and the dialog rests at ${to}px`).toBeLessThanOrEqual(TOLERANCE);

    const heights = frames.map(frame => frame.surface);
    for (const height of heights) {
        expect(height, `heights: ${heights.join(', ')}`).toBeGreaterThanOrEqual(low);
        expect(height, `heights: ${heights.join(', ')}`).toBeLessThanOrEqual(high);
    }
    const direction = Math.sign(to - from);
    for (let index = 1; index < heights.length; index++) {
        expect((heights[index] - heights[index - 1]) * direction, `heights: ${heights.join(', ')}`).toBeGreaterThanOrEqual(-TOLERANCE);
    }

    for (const [index, frame] of frames.entries()) {
        const outgoing = frame.pages.filter(page => page.role === 'outgoing');
        const incoming = frame.pages.filter(page => page.role === 'incoming');
        expect(outgoing, `frame ${index} has one outgoing page`).toHaveLength(1);
        expect(incoming, `frame ${index} has one incoming page`).toHaveLength(1);
        expect(Math.abs(outgoing[0].height - outgoingHeight), `frame ${index}: the outgoing page is ${outgoing[0].height}px, and it was ${outgoingHeight}px`).toBeLessThanOrEqual(TOLERANCE);
        expect(Math.abs(incoming[0].height - incomingHeight), `frame ${index}: the incoming page is ${incoming[0].height}px, and it rests at ${incomingHeight}px`).toBeLessThanOrEqual(TOLERANCE);
        expect(Math.max(...frame.pages.map(page => page.visibleHeight)), `frame ${index} shows a page`).toBeGreaterThan(0);
    }

    const farthest = frames.flatMap(frame => frame.pages).reduce((far, candidate) => (Math.abs(candidate.left) > Math.abs(far.left) ? candidate : far));
    expect(Math.sign(farthest.left), `the page that travels is ${farthest.left}px from its place at the farthest`).toBe(rtl ? -1 : 1);
    expect(Math.abs(frames.at(-1).pages.find(page => page.role === 'incoming').left), 'the last frame has the incoming page in place').toBeLessThanOrEqual(2);

    expect(targets, 'a page change does not animate the dialog surface, the host or the backdrop').toEqual([]);
}

const IDLE_ANIMATIONS = () => document.getAnimations().filter(animation => animation.effect?.target?.closest?.('dialog.sb-dialog-host')
    && Number.isFinite(animation.effect.getComputedTiming().endTime)).length;
const NEXT = `${HOST} .sb-dialog__page:not([hidden]):not(.is-underlay):not(.is-leaving) .sb-dialog__affirmative`;
const PINNED = `${HOST} .sb-dialog__page[style*="height"], ${HOST} .sb-dialog__pages[style*="height"], ${HOST} .sb-dialog__page[style*="flex-shrink"]`;

async function openWelcome(page) {
    await protectMaintainerServer(page);
    await installFixtureChats(page);
    await useMotion(page);
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await page.locator('#chat > .welcomePanel .sbHomeMenuButton').click();
    await page.getByRole('menuitem', { name: 'Show Welcome', exact: true }).click();
    await expect(page.locator(HOST)).toBeVisible();
    await expect(page.locator(`${HOST} .sb-dialog__title`)).toHaveText('Welcome');
    await expect.poll(() => page.evaluate(IDLE_ANIMATIONS)).toBe(0);
    await installTransitionProbe(page);
}

/** Opens a plain dialog whose root page is 160px high; `window.__block(n)` makes content of any height. */
async function openChain(page) {
    await protectMaintainerServer(page);
    await installFixtureChats(page);
    await useMotion(page);
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await page.evaluate(async () => {
        const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
        const block = (height) => {
            const node = document.createElement('div');
            node.style.height = `${height}px`;
            return node;
        };
        window.__chain = openDialog({ tier: 'dialog', title: 'Root', content: block(160) });
        window.__block = block;
    });
    await expect(page.locator(`${HOST} .sb-dialog__title`)).toHaveText('Root');
    await expect.poll(() => page.evaluate(IDLE_ANIMATIONS)).toBe(0);
    await installTransitionProbe(page);
}

for (const { name, options } of VIEWPORTS) {
    test.describe(`Welcome page transitions at ${name}`, () => {
        test.use(options);

        for (const keyboard of [false, true]) {
            test(`${keyboard ? 'keyboard' : 'pointer'}: Next, Next, Back, Back keep the dialog and both pages steady`, async ({ page }) => {
                await openWelcome(page);

                for (const [label, selector] of [
                    ['Welcome to Your Persona', '.sb-dialog__affirmative'],
                    ['Your Persona to What\u2019s Next', '.sb-dialog__affirmative'],
                    ['What\u2019s Next back to Your Persona', '.sb-dialog__cancel'],
                    ['Your Persona back to Welcome', '.sb-dialog__cancel'],
                ]) {
                    const result = await test.step(label, () => runTransition(page, selector, { keyboard }));
                    expect.soft(result.end, `${label} animates`).toBeGreaterThan(0);
                    await test.step(`${label}: heights`, () => expectSteadyTransition(result));
                    await expect(page.locator(PINNED), `${label} leaves no pinned height`).toHaveCount(0);
                }
            });
        }

        test('a second Next pressed while the first slide runs keeps the older page at its height', async ({ page }) => {
            await openWelcome(page);

            const result = await page.evaluate(selector => window.__interrupted(
                () => document.querySelector(selector).click(),
                () => document.querySelector(selector).click(),
            ), NEXT);

            const welcomeHeight = result.before.pages[0].height;
            expect(Math.abs(result.frames[0].surface - result.middle.surface), 'the second slide starts from the height the first one reached').toBeLessThanOrEqual(TOLERANCE);
            for (const [index, frame] of result.frames.entries()) {
                const welcome = frame.pages.find(candidate => candidate.title === 'Welcome');
                expect(welcome, `frame ${index} still shows the Welcome page beside the sliding pages`).toBeTruthy();
                expect(Math.abs(welcome.height - welcomeHeight), `frame ${index}: the Welcome page is ${welcome.height}px, and it was ${welcomeHeight}px`).toBeLessThanOrEqual(TOLERANCE);
            }
            expect(result.after.pages.map(candidate => candidate.title)).toEqual(['What\u2019s Next']);
            await expect(page.locator(PINNED)).toHaveCount(0);
        });
    });
}

test.describe('Welcome page transitions in a right-to-left document', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('Next and Back slide from the leading side and keep the dialog steady', async ({ page }) => {
        await openWelcome(page);
        await page.evaluate(() => { document.documentElement.dir = 'rtl'; });

        const forward = await runTransition(page, '.sb-dialog__affirmative', { keyboard: false });
        expect(forward.end, 'Next animates').toBeGreaterThan(0);
        await test.step('Next', () => expectSteadyTransition(forward, { rtl: true }));
        const back = await runTransition(page, '.sb-dialog__cancel', { keyboard: false });
        await test.step('Back', () => expectSteadyTransition(back, { rtl: true }));
    });
});

test.describe('Shared page chain', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('a pushed page of another height grows and shrinks the dialog with the slide', async ({ page }) => {
        await openChain(page);

        const forward = await page.evaluate(() => window.__transition(() => {
            window.__child = window.__chain.push({ title: 'Child', content: window.__block(420) });
        }));
        expect(forward.end, 'the push animates').toBeGreaterThan(0);
        await test.step('push a taller page', () => expectSteadyTransition(forward));

        const back = await page.evaluate(() => window.__transition(() => window.__child.close()));
        await test.step('pop back to the shorter page', () => expectSteadyTransition(back));
    });

    test('content added after push() returns sets the height the slide ends at', async ({ page }) => {
        await openChain(page);

        const forward = await page.evaluate(() => window.__transition(() => {
            const child = window.__chain.push({ title: 'Late' });
            child.body.append(window.__block(420));
        }));

        expectSteadyTransition(forward);
        expect(forward.after.surface, 'the dialog rests at the height of the late content').toBeGreaterThan(420);
    });

    for (const how of ['cancel', 'close']) {
        test(`a slide that is ${how === 'cancel' ? 'cancelled' : 'cut short by closing the dialog'} leaves no pinned height`, async ({ page }) => {
            await openChain(page);

            const result = await page.evaluate(mode => window.__stopped(() => {
                window.__chain.push({ title: 'Child', content: window.__block(420) });
            }, mode), how);

            expect(result.pinnedDuring, 'the pages are pinned while the slide runs').toBeGreaterThan(0);
            expect(result.pinnedAfter, 'no page or pages node keeps an inline height or flex-shrink').toBe(0);
        });
    }

    test('closing several pages at once keeps each page that is still showing at its height', async ({ page }) => {
        await openChain(page);
        await page.evaluate(() => {
            window.__first = window.__chain.push({ title: 'First', content: window.__block(300) });
        });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect.poll(() => page.evaluate(IDLE_ANIMATIONS)).toBe(0);
        await page.evaluate(() => {
            window.__second = window.__first.push({ title: 'Second', content: window.__block(520) });
        });
        await expect.poll(() => page.evaluate(IDLE_ANIMATIONS)).toBe(0);

        const result = await page.evaluate(() => window.__transition(() => {
            window.__second.forceClose();
            window.__first.forceClose();
        }));
        const chrome = result.before.pages[0].height - 520;
        const rest = { Root: result.after.pages[0].height, First: 300 + chrome, Second: 520 + chrome };

        for (const [index, frame] of result.frames.entries()) {
            expect(frame.pages.map(shown => shown.title), `frame ${index} shows all three pages`).toEqual(['Root', 'First', 'Second']);
            for (const shown of frame.pages) {
                expect(Math.abs(shown.height - rest[shown.title]), `frame ${index}: ${shown.title} is ${shown.height}px, and it rests at ${rest[shown.title]}px`).toBeLessThanOrEqual(TOLERANCE);
            }
        }
        await expect(page.locator(PINNED)).toHaveCount(0);
    });
});
