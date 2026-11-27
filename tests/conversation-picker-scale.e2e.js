/**
 * The character pickers of the conversation mode against a large library, on a CPU that is 4 times slower (Chromium only).
 * The library is made in the page: `/api/characters/all` answers 300 or 3,000 small cards (the cards of the test server
 * first, so that conversations can be seeded with real characters), `/thumbnail` answers one tiny picture and counts the
 * requests, and the tags are put into the page's tag list. The figures are the budgets of the plan: a picker opens in
 * under a second, and a keystroke, a clear, a pick and a Show More press each take under 100 ms. The thumbnail requests
 * after an open and after a keystroke must not grow with the library.
 *
 * The absolute budgets hold on a quiet machine, so they are asserted only when SILLYBUNNY_PICKER_BUDGETS=1 (run the spec
 * alone: `SILLYBUNNY_PICKER_BUDGETS=1 e2e conversation-picker-scale.e2e.js`). On a machine that runs a whole suite the same
 * code takes two to three times as long. Every run asserts what does not depend on the machine: the cost of a step with 3,000
 * cards against the cost with 300, the rows and pictures that the page holds, and ceilings that the old pickers missed by
 * seconds.
 *
 * Real thumbnails, real cards and the server's own time are measured by the scripts of `review/research/picker-scale/`
 * on the golden data roots; this spec covers the code of the page.
 */
import { expect, test } from '@playwright/test';
import { DETAILS_HOST, openDetails, openDetailsApp, seedAndOpen, shownPage } from './helpers/conversation-details.js';

const NEW_MENU = '[data-sb-conversation-action="open-new-menu"]';
// The picker is a popover at 1440x900 and a bottom sheet at 390x844; its search field and rows have the same classes in both.
const SEARCH = '.sb-picker__search';
// A paged list keeps the rows that it built and hides the ones that are not shown.
const OPTION = '.sb-picker__option:not(.sb-picker__more):not(.is-hidden)';
const STRICT = process.env.SILLYBUNNY_PICKER_BUDGETS === '1';
const OPEN_BUDGET_MS = STRICT ? 1000 : 3000;
// The plan's budget for what the user does in a list: a keystroke that only shows or hides rows that were built, a clear and a pick.
const INTERACTION_BUDGET_MS = STRICT ? 100 : 500;
// A keystroke that reaches rows that were never built, and Show More, must insert rows. On the phone profile every insertion
// restyles most of the page (the app has a few hundred `:has()` rules), about 50 ms at 4 times slower, before the picker's own
// work, so these two get the plan's budget plus that cost.
const INSERT_BUDGET_MS = STRICT ? 150 : 800;
// What a step costs with ten times the cards, against what it costs with the smaller library.
const GROWTH_FACTOR = 1.6;
const GROWTH_SLACK_MS = 40;
const THROTTLE = 4;
const SIZES = [300, 3000];
const PHONE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
// A 1x1 JPEG, so that every thumbnail request is answered at once and the figures are those of the page.
const PIXEL = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
// Two stems hold the letters z and e together, so that a search for them reaches cards that the first batch does not show.
const STEMS = ['Aria', 'Brom', 'Cass', 'Dov', 'Ede', 'Fenn', 'Gil', 'Hux', 'Ira', 'Jun', 'Zeno', 'Zed'];

test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'The CPU throttle is a Chromium DevTools command.');
});

// Other work on the machine only adds time to a measurement, so the fastest of several runs is what the code costs; the
// slower runs stay in the attached figures. A real slowdown makes every run slower and fails the budget.
const RUNS = 5;
const best = values => Math.min(...values);

/** Waits until no picture has been asked for during the last 300 ms, so that a count is read after the page has settled. */
const settleThumbnails = thumbnails => expect.poll(() => Date.now() - thumbnails.lastAt, { timeout: 15_000 }).toBeGreaterThanOrEqual(300);

/** Small cards that look like the server's: the cards of the test server, then synthetic ones up to `size`. */
function fabricateCards(real, size) {
    const template = real[0];
    const slim = (card, index) => {
        const name = `${STEMS[index % STEMS.length]} ${String(index).padStart(4, '0')}`;
        const fav = index % 40 === 7;
        return {
            ...template,
            name,
            avatar: `scale-${index}.png`,
            chat: `scale-${index}`,
            description: '',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            creatorcomment: '',
            fav,
            tags: [],
            json_data: '',
            data: { ...template.data, name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], extensions: { fav, talkativeness: '0.5' } },
        };
    };
    const synthetic = Array.from({ length: Math.max(0, size - real.length) }, (_, index) => slim(template, index));
    return [...real, ...synthetic];
}

/** A new page with the library of `size` cards, the app loaded, the workspace open and the CPU throttled. */
async function openLibraryPage(browser, baseURL, { size, phone }) {
    const context = await browser.newContext({
        baseURL,
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
        viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
        ...(phone ? { isMobile: true, hasTouch: true, userAgent: PHONE_USER_AGENT } : {}),
    });
    const page = await context.newPage();
    const thumbnails = { count: 0, lastAt: 0 };
    await page.route('**/thumbnail?**', route => {
        thumbnails.count += 1;
        thumbnails.lastAt = Date.now();
        return route.fulfill({ status: 200, contentType: 'image/jpeg', body: PIXEL });
    });
    await page.route('**/api/characters/all', async route => {
        const response = await route.fetch();
        const real = await response.json();
        await route.fulfill({ response, json: fabricateCards(real, size) });
    });
    const { avatars } = await openDetailsApp(page);
    await page.evaluate(() => {
        const { tags, tagMap, characters } = window.SillyTavern.getContext();
        for (let id = 0; id < 20; id++) tags.push({ id: `scale-tag-${id}`, name: `Tag ${String.fromCharCode(97 + id)}`, color: id % 2 ? '#3584e4' : '' });
        characters.forEach((card, index) => {
            if (card.avatar.startsWith('scale-')) tagMap[card.avatar] = [`scale-tag-${index % 20}`, `scale-tag-${(index + 5) % 20}`];
        });
    });
    expect(avatars.length).toBe(size);
    const client = await context.newCDPSession(page);
    return { context, page, thumbnails, avatars, throttle: () => client.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE }) };
}

/**
 * Times the next interaction: from the input event that starts it to the frame after the first frame in which `until`
 * holds. Returns a function that gives the time once the interaction has been made.
 */
async function startProbe(page, untilSource, argument = null) {
    await page.evaluate(([source, arg]) => {
        window.__probe = new Promise(resolve => {
            const condition = new Function('arg', `return (${source})(arg);`);
            let t0 = null;
            const begin = event => {
                if (t0 === null) t0 = event.timeStamp;
            };
            for (const type of ['pointerdown', 'keydown', 'click']) addEventListener(type, begin, { capture: true, once: true });
            const poll = () => {
                if (t0 !== null && condition(arg)) requestAnimationFrame(() => resolve(performance.now() - t0));
                // A condition that never holds ends the probe with a figure that fails every budget, not with a test that hangs.
                else if (t0 !== null && performance.now() - t0 > 20000) resolve(Infinity);
                else requestAnimationFrame(poll);
            };
            poll();
        });
    }, [untilSource, argument]);
    return () => page.evaluate(() => window.__probe);
}

const labelsOf = '() => [...document.querySelectorAll(\'.sb-picker__option:not(.sb-picker__more):not(.is-hidden) .sb-picker__label\')].map(label => label.textContent)';

/** Opens the New menu item and times it until the search field has focus and the list has rows. */
async function openStartPicker(page, name) {
    await page.locator(NEW_MENU).click();
    const item = page.getByRole('menuitem', { name, exact: true });
    await expect(item).toBeVisible();
    const finish = await startProbe(page, '() => Boolean(document.querySelector(\'.sb-picker__option:not(.is-hidden)\')) && document.activeElement === document.querySelector(\'.sb-picker__search\')');
    await item.click();
    const ms = await finish();
    await expect(page.locator(SEARCH)).toBeVisible();
    return ms;
}

async function closePickerWithEscape(page) {
    await page.keyboard.press('Escape');
    await expect(page.locator(SEARCH)).toBeHidden();
}

async function openEmptyWorkspace(page) {
    await page.evaluate(async () => {
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        const { stopConversationAutoWorker } = await import('/scripts/sillybunny-conversation/auto-engine.js');
        openConversationWorkspaceForAvatar(null, { showToast: false });
        stopConversationAutoWorker();
    });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
    await expect(page.locator(NEW_MENU)).toBeVisible();
}

/** The figures of one library size on one viewport. */
async function measureStartPickers(browser, baseURL, { size, phone }) {
    const { context, page, thumbnails, throttle } = await openLibraryPage(browser, baseURL, { size, phone });
    await openEmptyWorkspace(page);
    await throttle();
    const figures = { size, open: [], first: [], second: [], clear: [], more: [], pick: [], openThumbnails: 0, keyThumbnails: 0, rowsAfterOpen: 0 };

    for (let run = 0; run < RUNS; run++) {
        thumbnails.count = 0;
        figures.open.push(await openStartPicker(page, 'New Conversation'));
        await settleThumbnails(thumbnails);
        figures.openThumbnails = Math.max(figures.openThumbnails, thumbnails.count);
        figures.rowsAfterOpen = Math.max(figures.rowsAfterOpen, await page.locator('.sb-picker__option').count());
        const search = page.locator(SEARCH);
        const unfiltered = await page.evaluate(`(${labelsOf})()`);
        expect(unfiltered, 'the first batch is 50 rows').toHaveLength(Math.min(50, size));

        const before = thumbnails.count;
        let finish = await startProbe(page, `() => { const labels = (${labelsOf})(); return labels.length > 0 && labels.every(label => label.toLowerCase().includes('z')); }`);
        await search.pressSequentially('z');
        figures.first.push(await finish());
        finish = await startProbe(page, `() => { const labels = (${labelsOf})(); return labels.length > 0 && labels.every(label => label.toLowerCase().includes('ze')) ; }`);
        await search.pressSequentially('e');
        figures.second.push(await finish());
        await settleThumbnails(thumbnails);
        figures.keyThumbnails = Math.max(figures.keyThumbnails, thumbnails.count - before);

        // The selection is made before the probe starts, so that the time runs from the key that clears the field.
        await search.press('Control+a');
        finish = await startProbe(page, `() => { const labels = (${labelsOf})(); return labels.length === ${Math.min(50, size)} && labels[0] === ${JSON.stringify(unfiltered[0])}; }`);
        await search.press('Backspace');
        figures.clear.push(await finish());

        if (size > 50) {
            const shown = await page.locator(OPTION).count();
            finish = await startProbe(page, `() => document.querySelectorAll('.sb-picker__option:not(.sb-picker__more):not(.is-hidden)').length === ${shown + 50}`);
            await page.locator('.sb-picker__more').click();
            figures.more.push(await finish());
        }
        await closePickerWithEscape(page);
    }

    figures.group = [];
    figures.groupOpen = [];
    for (let run = 0; run < RUNS; run++) {
        figures.groupOpen.push(await openStartPicker(page, 'New Group'));
        const options = page.locator(OPTION);
        for (const index of [2, 9, 17]) {
            const row = options.nth(index);
            const id = await row.getAttribute('id');
            const finish = await startProbe(page, `() => document.getElementById(${JSON.stringify(id)})?.getAttribute('aria-selected') === 'true'`);
            await row.click();
            figures.group.push(await finish());
        }
        await expect(page.locator('.sb-picker__count')).toHaveText('3 selected');
        await closePickerWithEscape(page);
    }
    await context.close();
    return figures;
}

/** Add Member on a group, at the size of the library: five runs of open, keystroke, clear and tick, each from a fresh page. */
async function measureAddMember(browser, baseURL, { size, phone }) {
    const { context, page, thumbnails, avatars, throttle } = await openLibraryPage(browser, baseURL, { size, phone });
    const group = await seedAndOpen(page, { avatar: avatars[0], members: [avatars[1]], name: 'Scale group' });
    await openDetails(page, group.conversationId);
    await throttle();
    const figures = { size, open: [], first: [], clear: [], pick: [], openThumbnails: 0, keyThumbnails: 0 };

    for (let run = 0; run < RUNS; run++) {
        thumbnails.count = 0;
        const opened = await startProbe(page, `() => Boolean(document.querySelector('${DETAILS_HOST} .sb-picker__option:not(.is-hidden)'))`);
        await shownPage(page).getByRole('button', { name: 'Add Member' }).click();
        figures.open.push(await opened());
        await settleThumbnails(thumbnails);
        figures.openThumbnails = Math.max(figures.openThumbnails, thumbnails.count);

        const search = shownPage(page).getByRole('combobox', { name: /Search/ });
        const before = thumbnails.count;
        const keyed = await startProbe(page, `() => { const labels = [...document.querySelectorAll('${DETAILS_HOST} .sb-picker__option:not(.sb-picker__more):not(.is-hidden) .sb-picker__label')].map(label => label.textContent); return labels.length > 0 && labels.every(label => label.toLowerCase().includes('z')); }`);
        await search.pressSequentially('z');
        figures.first.push(await keyed());
        await settleThumbnails(thumbnails);
        figures.keyThumbnails = Math.max(figures.keyThumbnails, thumbnails.count - before);
        await search.press('Control+a');
        const cleared = await startProbe(page, `() => document.querySelectorAll('${DETAILS_HOST} .sb-picker__option:not(.sb-picker__more):not(.is-hidden)').length === ${Math.min(50, size - 2)}`);
        await search.press('Backspace');
        figures.clear.push(await cleared());

        const row = shownPage(page).locator(OPTION).nth(4 + run);
        const id = await row.getAttribute('id');
        const picked = await startProbe(page, `() => document.getElementById(${JSON.stringify(id)})?.getAttribute('aria-selected') === 'true'`);
        await row.click();
        figures.pick.push(await picked());
        await expect(shownPage(page).getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
        await shownPage(page).getByRole('button', { name: 'Cancel' }).click();
        await expect(page.locator(DETAILS_HOST).locator('.sb-picker__search')).toHaveCount(0);
    }
    await context.close();
    return figures;
}

/** A step that was not made slower by ten times the cards, whatever the speed of the machine. */
function expectNoGrowth(small, large, steps) {
    for (const step of steps) {
        if (!small[step]?.length) continue;
        expect.soft(best(large[step]), `${step}: ${large.size} cards against ${small.size}`).toBeLessThanOrEqual(best(small[step]) * GROWTH_FACTOR + GROWTH_SLACK_MS);
    }
}

function expectWithinBudgets(figures, { picker }) {
    const where = `${picker}, ${figures.size} cards`;
    expect.soft(best(figures.open), `${where}: open`).toBeLessThan(OPEN_BUDGET_MS);
    expect.soft(best(figures.first), `${where}: first keystroke, which builds rows`).toBeLessThan(INSERT_BUDGET_MS);
    expect.soft(best(figures.second), `${where}: second keystroke`).toBeLessThan(INTERACTION_BUDGET_MS);
    expect.soft(best(figures.clear), `${where}: clear`).toBeLessThan(INTERACTION_BUDGET_MS);
    expect.soft(best(figures.more), `${where}: Show More, which builds rows`).toBeLessThan(INSERT_BUDGET_MS);
    expect.soft(best(figures.pick), `${where}: pick`).toBeLessThan(INTERACTION_BUDGET_MS);
}

for (const [name, phone] of [['1440x900', false], ['390x844 phone', true]]) {
    test.describe(`character pickers at ${name} with the CPU 4 times slower`, () => {
        test('New Conversation and New Group stay within the budgets and ask for no more pictures as the library grows', async ({ browser, baseURL }, testInfo) => {
            test.setTimeout(420_000);
            const results = [];
            for (const size of SIZES) results.push(await measureStartPickers(browser, baseURL, { size, phone }));
            await testInfo.attach('start-pickers.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });

            for (const figures of results) {
                expectWithinBudgets({ ...figures, pick: figures.group }, { picker: 'New Conversation and New Group' });
                expect.soft(best(figures.groupOpen), `New Group, ${figures.size} cards: open`).toBeLessThan(OPEN_BUDGET_MS);
                expect.soft(figures.openThumbnails, `${figures.size} cards: pictures asked for after an open`).toBeLessThanOrEqual(100);
                expect.soft(figures.keyThumbnails, `${figures.size} cards: pictures asked for after a keystroke`).toBeLessThanOrEqual(100);
            }
            const [small, large] = results;
            expect.soft(large.openThumbnails, 'the open asks for no more pictures with 10 times the cards').toBeLessThanOrEqual(small.openThumbnails + 10);
            expect.soft(large.keyThumbnails, 'a keystroke asks for no more pictures with 10 times the cards').toBeLessThanOrEqual(small.keyThumbnails + 10);
            expect.soft(large.rowsAfterOpen, 'the page holds one batch of rows and the Show More row, whatever the library').toBeLessThanOrEqual(51);
            expectNoGrowth(small, large, ['open', 'first', 'second', 'clear', 'more', 'group']);
        });

        test('Add Member stays within the budgets', async ({ browser, baseURL }, testInfo) => {
            test.setTimeout(420_000);
            const results = [];
            for (const size of SIZES) results.push(await measureAddMember(browser, baseURL, { size, phone }));
            await testInfo.attach('add-member.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });

            for (const figures of results) {
                const where = `Add Member, ${figures.size} cards`;
                expect.soft(best(figures.open), `${where}: open`).toBeLessThan(OPEN_BUDGET_MS);
                expect.soft(best(figures.first), `${where}: first keystroke, which builds rows`).toBeLessThan(INSERT_BUDGET_MS);
                expect.soft(best(figures.clear), `${where}: clear`).toBeLessThan(INTERACTION_BUDGET_MS);
                expect.soft(best(figures.pick), `${where}: tick one row`).toBeLessThan(INTERACTION_BUDGET_MS);
                expect.soft(figures.openThumbnails, `${where}: pictures asked for after an open`).toBeLessThanOrEqual(100);
            }
            const [small, large] = results;
            expect.soft(large.openThumbnails, 'the open asks for no more pictures with 10 times the cards').toBeLessThanOrEqual(small.openThumbnails + 10);
            expectNoGrowth(small, large, ['open', 'first', 'clear', 'pick']);
        });
    });
}
