import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchBodyOrSkip } from './helpers/route-fetch.js';
import { installSlideProbe } from './helpers/slide-frames.js';

/*
 * Guards the Welcome page slide against stutter.
 *
 * The app style sheets hold many `:has()` rules, so a DOM insertion, an inline-style write or a `hidden` change
 * restyles the whole document, and every one of them in a slide is a chance to drop a frame. The count of restyles does
 * not depend on how fast or how busy the machine is, so the guard counts them in a trace and does not time frames.
 *
 * A recalculation counts as whole-document when it covers at least WHOLE_DOCUMENT_ELEMENTS elements. A slide needs
 * three of them by its structure: the insertion of the incoming page, the write of the header layout variable and the
 * `hidden` attribute on the covered page. Layout reads between those writes, or inline styles for the pins, add more.
 * The limit sits one above the structural count. The median over the slides of a run absorbs the occasional restyle of
 * an unrelated periodic job (toast, picker refresh).
 */
test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'no-preference' } });
test.describe.configure({ timeout: 180_000 });

const HOST = 'dialog.sb-dialog-host:not([closing])';
const SHOWN = `${HOST} .sb-dialog__page:not([hidden]):not(.is-underlay):not(.is-leaving)`;
const WHOLE_DOCUMENT_ELEMENTS = 300;
const MAX_MEDIAN_RESTYLES_PER_SLIDE = 4;
const CYCLES = 2;
const TRACE_CATEGORIES = 'devtools.timeline,blink.user_timing';

const VIEWPORTS = [
    { name: 'dialog 1440x900', options: { viewport: { width: 1440, height: 900 } } },
    { name: 'sheet 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];

const SLIDES = [
    ['1 to 2', '.sb-dialog__affirmative'],
    ['2 to 3', '.sb-dialog__affirmative'],
    ['3 to 2', '.sb-dialog__cancel'],
    ['2 to 1', '.sb-dialog__cancel'],
];

/** The saved Reduced Motion setting would turn the slide off, so the settings the page loads say it is off. */
async function useMotion(page) {
    await page.route('**/api/settings/get', async (route) => {
        const fetched = await fetchBodyOrSkip(route, response => response.json());
        if (!fetched) return;
        const { response, body: data } = fetched;
        const settings = JSON.parse(data.settings);
        settings.power_user.reduced_motion = false;
        applyHomeTestSettings(settings);
        return route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
    });
}

async function openWelcome(page) {
    await page.locator('#chat > .welcomePanel .sbHomeMenuButton').click();
    await page.getByRole('menuitem', { name: 'Show Welcome', exact: true }).click();
    await expect(page.locator(`${HOST} .sb-dialog__title`)).toHaveText('Welcome');
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.effect?.target?.closest?.('dialog.sb-dialog-host')
        && Number.isFinite(animation.effect.getComputedTiming().endTime)).length)).toBe(0);
}

async function closeWelcome(page) {
    await page.locator(`${SHOWN} .sb-dialog__cancel`).click();
    await expect(page.locator(HOST)).toHaveCount(0);
}

/** Starts a trace and returns a function that stops it and resolves with the collected events. */
async function startTrace(page) {
    const session = await page.context().newCDPSession(page);
    const events = [];
    session.on('Tracing.dataCollected', ({ value }) => events.push(...value));
    const complete = new Promise(resolve => session.once('Tracing.tracingComplete', resolve));
    await session.send('Tracing.start', { categories: TRACE_CATEGORIES, transferMode: 'ReportEvents' });
    return async () => {
        await session.send('Tracing.end');
        await complete;
        await session.detach();
        return events;
    };
}

/** @returns {number[]} for each slide marked in the trace, the number of whole-document style recalculations inside it */
function wholeDocumentRestylesPerSlide(events) {
    const renderer = events.find(event => event.name === 'thread_name' && event.args?.name === 'CrRendererMain');
    expect(renderer, 'the trace has a renderer main thread').toBeTruthy();
    const marks = name => events
        .filter(event => event.cat?.includes('blink.user_timing') && event.name === name)
        .map(event => event.ts)
        .sort((a, b) => a - b);
    const starts = marks('slide-start');
    const ends = marks('slide-end');
    const recalcs = events.filter(event => event.pid === renderer.pid && event.tid === renderer.tid
        && event.ph === 'X' && event.name === 'UpdateLayoutTree' && (event.args?.elementCount ?? 0) >= WHOLE_DOCUMENT_ELEMENTS);
    return starts.map((start, index) => recalcs.filter(event => event.ts >= start && event.ts <= ends[index]).length);
}

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

for (const { name, options } of VIEWPORTS) {
    test.describe(`Welcome slide at ${name}`, () => {
        test.use(options);

        test('a Welcome page slide restyles the whole document at most a handful of times', async ({ page }) => {
            await protectMaintainerServer(page);
            await installFixtureChats(page);
            await useMotion(page);
            await openQuietChatForSmoke(page, { selectCharacter: false });
            const stopTrace = await startTrace(page);

            for (let cycle = 0; cycle < CYCLES; cycle++) {
                await openWelcome(page);
                await installSlideProbe(page);
                for (const [, button] of SLIDES) {
                    await page.evaluate(query => window.__slideFrames(() => document.querySelector(query).click()), `${SHOWN} ${button}`);
                    // Lets the work queued behind the slide (focus, observers) run outside the next slide's window.
                    await page.evaluate(() => new Promise(resolve => requestIdleCallback(resolve, { timeout: 300 })));
                }
                await closeWelcome(page);
            }

            const counts = wholeDocumentRestylesPerSlide(await stopTrace());
            expect(counts).toHaveLength(CYCLES * SLIDES.length);
            expect(median(counts), `whole-document restyles per slide: ${counts.join(', ')}`).toBeLessThanOrEqual(MAX_MEDIAN_RESTYLES_PER_SLIDE);
        });
    });
}
