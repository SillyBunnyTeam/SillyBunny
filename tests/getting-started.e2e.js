import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke, selectSampleCharacter } from './chat-scroll-regression-helpers.js';
import { testSetup } from './frontend/frontent-test-utils.js';
import { CHARACTER_DONE_LINES, HOME_COPY } from './helpers/copy-home.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { captureAccountStorageSaves, gettingStartedValue, savedGettingStarted, stubGettingStarted } from './helpers/getting-started-state.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { sizeFreeTestFor } from './helpers/matrix.js';
import { BUNDLED_THEME_NAMES, GLYPH_CONTRAST, readChipContrast, resolveColor, selectTheme } from './helpers/page-contrast.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 30_000;
const SAVE_TIMEOUT = 15_000;

const VIEWPORTS = [
    { name: 'desktop 1440x900', checksColours: true, options: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone 390x844', checksColours: false, options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];

const menuButton = page => page.locator('#chat > .welcomePanel .sbHomeMenuButton');
const tile = page => page.locator('#chat > .welcomePanel .sbHomeTile[data-sb-home-key="getting-started"]');
const progressOf = page => tile(page).locator('.sbHomeTileSub');
/** The toasts of Getting Started only: other parts of the app toast on their own events, such as a preset change. */
const toasts = page => page.locator('#toast-container .toast', { has: page.locator('.sbHomeToast') });
const hosts = page => page.locator('dialog.sb-dialog-host:not([closing])');
const rowOf = (host, title) => host.locator('.ds-row', { hasText: title });

async function expectHome(page) {
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
    await expect(page.locator('#chat > .welcomePanel')).toBeAttached({ timeout: STARTUP_TIMEOUT });
}

/** Emits an event of the app, the way its own code does. */
function emit(page, name, ...args) {
    return page.evaluate(async ([eventName, eventArgs]) => {
        const { eventSource, event_types: types } = await import('/scripts/events.js');
        await eventSource.emit(types[eventName], ...eventArgs);
    }, [name, args]);
}

/**
 * Emits an event of the app from a script that has no gesture of the user. `page.evaluate` runs with one, which would
 * make a preset look applied by the user, so this goes through the protocol with the gesture off, once the transient
 * activation that earlier calls left has run out.
 */
async function emitWithoutGesture(page, name, ...args) {
    const session = await page.context().newCDPSession(page);
    const evaluate = (expression, awaitPromise = false) => session.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: false });
    await expect.poll(async () => (await evaluate('navigator.userActivation.isActive')).result.value, { timeout: 10_000 }).toBe(false);
    await evaluate(`import('/scripts/events.js').then(({ eventSource, event_types: types }) => eventSource.emit(types[${JSON.stringify(name)}], ...${JSON.stringify(args)}))`, true);
    await session.detach();
}

/** Puts a message of the user in the open chat, as sending one does, and returns its index for `MESSAGE_SENT`. */
function addUserMessage(page) {
    return page.evaluate(async () => {
        const { chat } = await import('/script.js');
        chat.push({ name: 'User', is_user: true, is_system: false, mes: 'Hello', send_date: Date.now(), extra: {} });
        return chat.length - 1;
    });
}

/** The steps of the shared state, as the app holds them. */
const stepsOf = page => page.evaluate(async () => {
    const { getSharedGettingStartedState } = await import('/scripts/sillybunny-home/getting-started.js');
    return getSharedGettingStartedState().getSnapshot().steps;
});

async function showGettingStartedFromMenu(page) {
    await menuButton(page).click();
    await page.getByRole('menuitem', { name: 'Show Getting Started', exact: true }).click();
}

async function openWindow(page) {
    await tile(page).click();
    const host = hosts(page);
    await expect(host).toBeVisible();
    return host;
}

/**
 * Boots Home with a stored checklist (by default shown with every step open) or with none (`value: null`, an account
 * from before Getting Started). The saved connection and the library of the account do not reach the test.
 */
async function bootHome(page, { value, firstRun } = {}) {
    await protectMaintainerServer(page);
    await installFixtureChats(page, { bundledCardsOnly: true });
    if (value !== undefined || firstRun !== undefined) {
        await stubGettingStarted(page, { value, firstRun, bundledCardsOnly: true });
    }
    const captured = await captureAccountStorageSaves(page);
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await expectHome(page);
    await showToasts(page);
    return captured;
}

for (const { name, options, checksColours } of VIEWPORTS) {
    test.describe(`Getting Started signals at ${name}`, () => {
        test.use(options);
        // Only the tests that measure a row or a toast use `test`; the rest do not depend on the size.
        const sizeFreeTest = sizeFreeTestFor(test, options.viewport);

        sizeFreeTest('an account from before Getting Started starts hidden, and its checklist is written as the default of the account', async ({ page }) => {
            const captured = await bootHome(page, { value: null, firstRun: false });

            await expect(tile(page)).toHaveCount(0);
            await expect.poll(() => savedGettingStarted(captured), { timeout: SAVE_TIMEOUT }).toMatchObject({ hidden: true, hiddenBy: 'account' });
        });

        sizeFreeTest('Show Getting Started brings the checklist of an old account back with its progress', async ({ page }) => {
            const captured = await bootHome(page, { value: null });
            await expect(tile(page)).toHaveCount(0);

            await showGettingStartedFromMenu(page);

            await expect(progressOf(page)).toHaveText('0 of 4');
            await expect.poll(() => savedGettingStarted(captured)?.hidden, { timeout: SAVE_TIMEOUT }).toBe(false);
        });

        sizeFreeTest('a stored checklist decides what the tile, the window and its rows show', async ({ page }) => {
            await bootHome(page, { value: gettingStartedValue({ steps: { connect: 'done', preset: 'skipped' } }) });
            await expect(progressOf(page)).toHaveText('2 of 4');

            const host = await openWindow(page);

            await expect(host.locator('.sb-dialog__subtitle')).toHaveText('2 of 4');
            await expect(rowOf(host, 'Connect a Model')).toHaveAttribute('data-sb-step-state', 'done');
            await expect(rowOf(host, 'Connect a Model').locator('.sbHomeTag:visible')).toHaveText(['Done']);
            await expect(rowOf(host, 'Connect a Model').getByRole('button', { name: 'Skip', exact: true })).toBeHidden();
            await expect(rowOf(host, 'Set Up a Preset')).toHaveAttribute('data-sb-step-state', 'skipped');
            await expect(rowOf(host, 'Set Up a Preset').locator('.sbHomeTag:visible')).toHaveText(['Optional', 'Skipped']);
            await expect(rowOf(host, 'Get a Character Card')).toHaveAttribute('data-sb-step-state', 'open');
        });

        test.describe('a step that is done', () => {
            const STATES = { steps: { connect: 'done', preset: 'skipped' } };
            const markOf = row => row.locator('.sbHomeStepDone');
            const chipOf = row => row.locator('.sbStatusChip:visible');

            test('starts with a check in Success Green and carries a Done chip with a check, while a skipped step keeps a neutral chip', async ({ page }) => {
                await bootHome(page, { value: gettingStartedValue({ steps: STATES.steps }) });
                const host = await openWindow(page);
                const done = rowOf(host, 'Connect a Model');
                const skipped = rowOf(host, 'Set Up a Preset');
                const open = rowOf(host, 'Get a Character Card');

                await expect(markOf(done)).toBeVisible();
                await expect(markOf(done)).toHaveAttribute('aria-hidden', 'true');
                await expect(chipOf(done)).toHaveText('Done');
                await expect(chipOf(done)).toHaveAttribute('data-sb-tone', 'success');
                await expect(chipOf(done).locator('i')).toHaveCount(1);
                await expect(markOf(skipped)).toBeHidden();
                await expect(chipOf(skipped)).toHaveText('Skipped');
                await expect(chipOf(skipped)).toHaveAttribute('data-sb-tone', 'neutral');
                await expect(chipOf(skipped).locator('i')).toHaveCount(0);
                await expect(markOf(open)).toBeHidden();
                await expect(chipOf(open)).toHaveCount(0);
                const titleStarts = await Promise.all([done, skipped, open].map(row => row.locator('.ds-row-label').evaluate(node => Math.round(node.getBoundingClientRect().left))));
                expect(new Set(titleStarts).size, `the titles of a done, a skipped and an open row start in line: ${titleStarts}`).toBe(1);

                const [success, check, tint, quiet] = await Promise.all([
                    resolveColor(page, await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sb-color-success'))),
                    markOf(done).evaluate(node => getComputedStyle(node).color).then(color => resolveColor(page, color)),
                    chipOf(done).evaluate(node => getComputedStyle(node).backgroundColor).then(color => resolveColor(page, color)),
                    chipOf(skipped).evaluate(node => getComputedStyle(node).backgroundColor).then(color => resolveColor(page, color)),
                ]);
                expect(check).toEqual(success);
                expect([tint.g > tint.r, quiet.g > quiet.r || quiet.a > 0], 'the Done tint is green, the Skipped tint is a neutral wash').toEqual([true, true]);
                expect(tint.a).toBeGreaterThan(quiet.a);
            });

            test('follows a step that is finished while the window is open, and the check keeps its place in the row', async ({ page }) => {
                await bootHome(page);
                const host = await openWindow(page);
                const row = rowOf(host, 'Connect a Model');
                await expect(markOf(row)).toBeHidden();
                await expect(chipOf(row)).toHaveCount(0);
                const titleBefore = await row.locator('.ds-row-label').evaluate(node => node.getBoundingClientRect().left);

                await page.evaluate(async () => {
                    const { getSharedGettingStartedState } = await import('/scripts/sillybunny-home/getting-started.js');
                    getSharedGettingStartedState().markDone('connect');
                });

                await expect(markOf(row)).toBeVisible();
                await expect(chipOf(row)).toHaveText('Done');
                expect(await row.locator('.ds-row-label').evaluate(node => node.getBoundingClientRect().left), 'the title does not move when the step is done').toBe(titleBefore);
                const box = await Promise.all([markOf(row), row.locator('.ds-row-label')].map(node => node.boundingBox()));
                expect(box[0].x + box[0].width, 'the check is before the title').toBeLessThanOrEqual(box[1].x);
            });

            if (checksColours) {
                test('keeps the Done chip, the Skipped chip and the check readable in the dark theme, the light theme and every bundled theme', async ({ page, browserName }) => {
                    // eslint-disable-next-line playwright/no-slowed-test -- an engine speed difference, not a test to fix later
                    test.slow(browserName === 'webkit', 'Switching and reading every bundled theme takes WebKit about three times as long as Chromium');
                    await bootHome(page, { value: gettingStartedValue({ steps: STATES.steps }) });
                    const host = await openWindow(page);
                    // The window focuses its first button, which WebKit draws with a focus ring on the pixels that sit under the chip.
                    await page.evaluate(() => document.activeElement?.blur());
                    const readings = [];

                    for (const theme of BUNDLED_THEME_NAMES) {
                        await selectTheme(page, theme);
                        const done = rowOf(host, 'Connect a Model');
                        readings.push(...await readChipContrast(page, chipOf(done), `${theme}, Done chip`));
                        readings.push(...await readChipContrast(page, chipOf(rowOf(host, 'Set Up a Preset')), `${theme}, Skipped chip`));
                        readings.push(...await readChipContrast(page, markOf(done), `${theme}, check of the row`));
                    }

                    // The text of a chip needs 4.5:1. The check of the row is a glyph, which needs 3:1 (DESIGN.md Contrast Rule), and the Done chip says the same in words.
                    const floorOf = reading => (reading.where.endsWith('check of the row') ? GLYPH_CONTRAST : reading.floor);
                    const below = readings.filter(reading => reading.ratio < floorOf(reading));
                    expect([...new Set(below.map(reading => `${reading.where}: ${reading.part} ${reading.ratio.toFixed(2)} < ${floorOf(reading)}`))]).toEqual([]);
                    expect(readings.filter(reading => reading.where.endsWith('Done chip') && reading.part === 'check')).toHaveLength(BUNDLED_THEME_NAMES.length * 2);
                });
            }
        });

        sizeFreeTest('a damaged stored checklist falls back to the defaults of the account without breaking Home', async ({ page }) => {
            await bootHome(page, { value: '{not json' });

            await expect(tile(page)).toHaveCount(0);
            await showGettingStartedFromMenu(page);
            await expect(progressOf(page)).toHaveText('0 of 4');
        });

        sizeFreeTest('a connection that the backend confirmed finishes Connect a Model, and the toast names the next step with one Show Me', async ({ page }) => {
            const captured = await bootHome(page);

            await emit(page, 'ONLINE_STATUS_CHANGED', 'no_connection');
            await expect(progressOf(page)).toHaveText('0 of 4');
            await emit(page, 'ONLINE_STATUS_CHANGED', 'valid');

            await expect(progressOf(page)).toHaveText('1 of 4');
            await expect(toasts(page)).toHaveCount(1);
            await expect(toasts(page).locator('.toast-title')).toHaveText('Connect a Model');
            await expect(toasts(page)).toContainText('Set Up a Preset');
            await expect(toasts(page).locator('[data-sb-home-toast="done"]')).toHaveText(HOME_COPY.toastDone);
            await expect(toasts(page).locator('[data-sb-home-toast="next-line"]')).toHaveText(HOME_COPY.toastNext);
            await expect(toasts(page).locator('.sbHomeToast')).toContainText(`Set Up a Preset ${HOME_COPY.toastNext}`);
            await expect(toasts(page).getByRole('button')).toHaveText(['×', 'Show Me']);
            await expect.poll(() => savedGettingStarted(captured)?.steps.connect, { timeout: SAVE_TIMEOUT }).toBe('done');
        });

        test.describe('statuses that confirm no connection', () => {
            for (const status of [
                'Key saved; press "Test Message" to verify.',
                'Invalid endpoint URL. Requests may fail.',
                'Invalid Azure endpoint URL. Requests may fail.',
                'Status check bypassed',
            ]) {
                sizeFreeTest(`"${status}" does not finish Connect a Model`, async ({ page }) => {
                    await bootHome(page);

                    await emit(page, 'ONLINE_STATUS_CHANGED', status);

                    await expect(progressOf(page)).toHaveText('0 of 4');
                    await expect(toasts(page)).toHaveCount(0);
                });
            }
        });

        sizeFreeTest('Show Me on the toast opens the place of the next step', async ({ page }) => {
            await bootHome(page);
            await emit(page, 'ONLINE_STATUS_CHANGED', 'valid');

            await toasts(page).getByRole('button', { name: 'Show Me', exact: true }).click();

            await expect(page.getByRole('tab', { name: 'Presets', selected: true })).toBeVisible();
            await expect(toasts(page)).toHaveCount(0);
        });

        test('a toast that shows over the Getting Started window is on top of it, and Show Me closes the window and opens the target', async ({ page }) => {
            await bootHome(page);
            const host = await openWindow(page);

            await emit(page, 'ONLINE_STATUS_CHANGED', 'valid');

            await expect(toasts(page)).toHaveCount(1);
            const hit = await toasts(page).evaluate((toast) => {
                const box = toast.getBoundingClientRect();
                const element = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
                return { onTop: toast.contains(element), inDialog: Boolean(toast.closest('dialog')) };
            });
            expect(hit).toEqual({ onTop: true, inDialog: true });

            await toasts(page).getByRole('button', { name: 'Show Me', exact: true }).click();

            await expect(host).toBeHidden();
            await expect(page.getByRole('tab', { name: 'Presets', selected: true })).toBeVisible();
        });

        test.describe('a preset', () => {
            sizeFreeTest('that the app applies without a gesture of the user does not finish Set Up a Preset', async ({ page, browserName }) => {
                // eslint-disable-next-line playwright/no-skipped-test -- an engine gap, not a pending test
                test.skip(browserName !== 'chromium', 'Only the Chrome DevTools Protocol can run a script without a gesture of the user');
                await bootHome(page);

                await emitWithoutGesture(page, 'PRESET_CHANGED', { apiId: 'openai', name: 'Default' });

                await expect(progressOf(page)).toHaveText('0 of 4');
                await expect(toasts(page)).toHaveCount(0);
            });

            sizeFreeTest('that the user applies in the presets list finishes Set Up a Preset', async ({ page }) => {
                await bootHome(page);
                await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'prompting'));
                const presets = page.locator('#settings_preset_openai');
                await presets.focus();

                await presets.press('ArrowDown');

                await expect.poll(async () => (await stepsOf(page)).preset).toBe('done');
                await expect(toasts(page).locator('.toast-title')).toHaveText('Set Up a Preset');
                await expect(toasts(page)).toContainText('Get a Character Card');
            });
        });

        sizeFreeTest('a card of the user in the library finishes Get a Character Card with the line for another card', async ({ page }) => {
            await bootHome(page);
            await expect(progressOf(page), 'the cards that ship with SillyBunny are not a card of the user').toHaveText('0 of 4');

            await page.evaluate(async () => {
                const { characters } = await import('/script.js');
                characters.push({ avatar: 'qa-getting-started-card.png', name: 'QA Card' });
            });
            await emit(page, 'CHARACTER_PAGE_LOADED');

            await expect(progressOf(page)).toHaveText('1 of 4');
            await expect(toasts(page).locator('.toast-title')).toHaveText('Get a Character Card');
            const host = await openWindow(page);
            await expect(rowOf(host, 'Get a Character Card')).toHaveAttribute('data-sb-step-state', 'done');
            await expect(rowOf(host, 'Get a Character Card').locator('.ds-row-subtitle')).toHaveText(CHARACTER_DONE_LINES.other);
        });

        sizeFreeTest('the card of Nahida, which earlier versions let the user install, does not finish Get a Character Card', async ({ page }) => {
            await bootHome(page);
            await expect(progressOf(page)).toHaveText('0 of 4');

            await page.evaluate(async () => {
                const { characters } = await import('/script.js');
                characters.push({ avatar: 'default_AssistantNahida.png', name: 'Assistant Nahida' });
            });
            await emit(page, 'CHARACTER_PAGE_LOADED');

            await expect(progressOf(page)).toHaveText('0 of 4');
            const host = await openWindow(page);
            await expect(rowOf(host, 'Get a Character Card')).toHaveAttribute('data-sb-step-state', 'open');
        });

        sizeFreeTest('opening a chat finishes Get a Character Card', async ({ page }) => {
            await bootHome(page);
            await expect(progressOf(page)).toHaveText('0 of 4');

            await selectSampleCharacter(page);
            await page.locator('#sb-home-toggle').click();
            await expectHome(page);

            await expect(progressOf(page)).toHaveText('1 of 4');
        });

        sizeFreeTest('opening a Conversation thread with a bundled card finishes Get a Character Card, and a message finishes Start Chatting', async ({ page }) => {
            await bootHome(page);
            await expect(progressOf(page)).toHaveText('0 of 4');

            await page.evaluate(async () => {
                const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
                openConversationWorkspaceForAvatar('default_Seraphina.png', { showToast: false, enable: true });
            });
            await expect.poll(async () => (await stepsOf(page)).character).toBe('done');
            await page.evaluate(() => window.dispatchEvent(new CustomEvent('sb:conversation-user-message-sent')));

            await expect.poll(stepsOf.bind(null, page)).toEqual({ connect: null, preset: null, character: 'done', chat: 'done' });
        });

        sizeFreeTest('a message of the user finishes Start Chatting, in either mode', async ({ page }) => {
            await bootHome(page);
            const messageId = await addUserMessage(page);

            await emit(page, 'MESSAGE_SENT', messageId);

            await expect(progressOf(page)).toHaveText('1 of 4');
            await expect(toasts(page).locator('.toast-title')).toHaveText('Start Chatting');
        });

        sizeFreeTest('a Conversation message finishes Start Chatting as well', async ({ page }) => {
            await bootHome(page);

            await page.evaluate(() => window.dispatchEvent(new CustomEvent('sb:conversation-user-message-sent')));

            await expect(progressOf(page)).toHaveText('1 of 4');
        });

        sizeFreeTest('Skip is silent: no toast, and a skipped step that gets its signal becomes done without one', async ({ page }) => {
            await bootHome(page);
            const host = await openWindow(page);

            await rowOf(host, 'Connect a Model').getByRole('button', { name: 'Skip', exact: true }).click();
            await expect(progressOf(page)).toHaveText('1 of 4');
            await expect(toasts(page)).toHaveCount(0);
            await emit(page, 'ONLINE_STATUS_CHANGED', 'valid');

            await expect(rowOf(host, 'Connect a Model')).toHaveAttribute('data-sb-step-state', 'done');
            await expect(progressOf(page)).toHaveText('1 of 4');
            await expect(toasts(page)).toHaveCount(0);
        });

        sizeFreeTest('while Getting Started is hidden the progress is recorded and no toast shows', async ({ page }) => {
            await bootHome(page, { value: null });

            await emit(page, 'ONLINE_STATUS_CHANGED', 'valid');

            await expect(tile(page)).toHaveCount(0);
            await expect(toasts(page)).toHaveCount(0);
            await showGettingStartedFromMenu(page);
            await expect(progressOf(page)).toHaveText('1 of 4');
        });

        sizeFreeTest('the signal that finishes the last step shows no toast, and the tile goes', async ({ page }) => {
            await bootHome(page, { value: gettingStartedValue({ steps: { connect: 'done', preset: 'skipped', character: 'done' } }) });
            await expect(progressOf(page)).toHaveText('3 of 4');
            const messageId = await addUserMessage(page);

            await emit(page, 'MESSAGE_SENT', messageId);

            await expect(tile(page)).toHaveCount(0);
            await expect(toasts(page)).toHaveCount(0);
        });

        sizeFreeTest('un-skipping after the auto-hide brings the tile back', async ({ page }) => {
            const captured = await bootHome(page, { value: gettingStartedValue({ steps: { connect: 'skipped', preset: 'skipped', character: 'skipped' } }) });
            const host = await openWindow(page);

            await rowOf(host, 'Start Chatting').getByRole('button', { name: 'Skip', exact: true }).click();
            await expect(tile(page)).toHaveCount(0);
            await expect.poll(() => savedGettingStarted(captured)?.hiddenBy, { timeout: SAVE_TIMEOUT }).toBe('auto');
            await rowOf(host, 'Start Chatting').getByRole('button', { name: 'Skip', exact: true }).click();

            await expect(progressOf(page)).toHaveText('3 of 4');
            await expect.poll(() => savedGettingStarted(captured)?.hidden, { timeout: SAVE_TIMEOUT }).toBe(false);
        });

        sizeFreeTest('what the app saved comes back after a reload, and a preset load of the first moments does not count', async ({ page, browserName }) => {
            const captured = await bootHome(page);
            await emit(page, 'ONLINE_STATUS_CHANGED', 'valid');
            await expect(progressOf(page)).toHaveText('1 of 4');
            await expect.poll(() => savedGettingStarted(captured)?.steps.connect, { timeout: SAVE_TIMEOUT }).toBe('done');
            const stored = JSON.stringify(savedGettingStarted(captured));

            await stubGettingStarted(page, { value: stored, bundledCardsOnly: true });
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction('document.getElementById("preloader") === null', undefined, { timeout: STARTUP_TIMEOUT });
            await testSetup.waitForAppReady({ page });
            await showToasts(page);
            await expectHome(page);
            await expect(progressOf(page)).toHaveText('1 of 4');

            // Only the Chrome DevTools Protocol can run a script without a gesture of the user.
            // eslint-disable-next-line playwright/no-conditional-in-test
            if (browserName !== 'chromium') return;
            await emitWithoutGesture(page, 'PRESET_CHANGED', { apiId: 'openai', name: 'Default' });

            await expect(progressOf(page)).toHaveText('1 of 4');
            await expect(toasts(page)).toHaveCount(0);
        });
    });
}

// The first run of a fresh install asks for a name in a popup that the smoke helpers dismiss on a desktop window only.
test.describe('Getting Started on a fresh install', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('a fresh install starts shown, and its checklist is written for the next boot', async ({ page }) => {
        const captured = await bootHome(page, { value: null, firstRun: true });

        await expect(tile(page)).toBeVisible();
        await expect(progressOf(page)).toHaveText('0 of 4');
        await expect.poll(() => savedGettingStarted(captured), { timeout: SAVE_TIMEOUT }).toMatchObject({ hidden: false });
    });
});

test.describe('Getting Started in a chat with a generated reply', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    async function openChatWithBypassedConnection(page) {
        await bootHome(page);
        await page.route('**/api/backends/chat-completions/generate', route => route.fulfill({
            json: { choices: [{ message: { role: 'assistant', content: 'A generated reply.' }, finish_reason: 'stop' }], model: 'qa-model' },
        }));
        await page.evaluate(async () => {
            const { eventSource, event_types } = await import('/scripts/events.js');
            window.qaReceived = [];
            window.qaSent = [];
            eventSource.on(event_types.MESSAGE_RECEIVED, (id, type) => window.qaReceived.push(type));
            eventSource.on(event_types.MESSAGE_SENT, (id) => window.qaSent.push(id));
        });
        await selectSampleCharacter(page);
        await page.evaluate(async () => {
            const { setOnlineStatus } = await import('/script.js');
            const { oai_settings } = await import('/scripts/openai.js');
            oai_settings.stream_openai = false;
            setOnlineStatus('Status check bypassed');
        });
    }

    const runSlash = (page, command) => page.evaluate(async (text) => {
        const { executeSlashCommandsWithOptions } = await import('/scripts/slash-commands.js');
        await executeSlashCommandsWithOptions(text);
    }, command);

    const receivedTypes = page => page.evaluate(() => window.qaReceived);

    test.describe('a message of a character that no chat model generated', () => {
        for (const type of ['first_message', 'extension']) {
            test(`received with type ${type} does not finish Connect a Model`, async ({ page }) => {
                await openChatWithBypassedConnection(page);
                const messageId = await page.evaluate(async () => {
                    const { chat } = await import('/script.js');
                    chat.push({ name: 'Character', is_user: false, is_system: false, mes: 'A greeting.', send_date: Date.now(), extra: {} });
                    return chat.length - 1;
                });

                await emit(page, 'MESSAGE_RECEIVED', messageId, type);

                expect(await receivedTypes(page), 'the event reached the listeners').toContain(type);
                expect(await stepsOf(page)).toMatchObject({ connect: null });
            });
        }
    });

    test('the greeting, /sys and /comment finish nothing, and the first generated reply finishes Connect a Model', async ({ page }) => {
        await openChatWithBypassedConnection(page);

        await runSlash(page, '/sys A note of the system.');
        await runSlash(page, '/comment A comment.');

        expect(await page.evaluate(() => window.qaSent), '/sys and /comment emit MESSAGE_SENT for their system messages').toHaveLength(2);
        expect((await receivedTypes(page)).every(type => type === 'first_message'), 'no model has replied: at most the greeting was received').toBe(true);
        expect(await stepsOf(page), 'the greeting of the chat, /sys and /comment finish nothing').toMatchObject({ connect: null, chat: null });

        await page.locator('#send_textarea').fill('Hello there.');
        await page.locator('#send_but').click();

        await expect.poll(() => stepsOf(page), { timeout: 20_000 }).toMatchObject({ connect: 'done', chat: 'done' });
        expect(await receivedTypes(page)).toContain('normal');
    });
});
