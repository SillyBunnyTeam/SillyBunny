import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchBodyOrSkip, fetchJsonOrSkip } from './helpers/route-fetch.js';

/*
 * Every overlay bottom sheet that a sheet controller or the Conversation workspace builds has the
 * shared grab handle, follows the finger, and closes through its normal close path on a long swipe.
 */

test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
test.describe.configure({ timeout: 90_000 });

async function waitForApp(page) {
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60_000 });
}

// The test data turns the reduced-motion setting on, which would skip every spring.
async function useMotion(page) {
    await page.route('**/api/settings/get', async route => {
        const fetched = await fetchBodyOrSkip(route, response => response.json());
        if (!fetched) return;
        const { response, body: data } = fetched;
        const settings = JSON.parse(data.settings);
        settings.power_user.reduced_motion = false;
        return route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
    });
}

async function bootApp(page) {
    await protectMaintainerServer(page);
    await useMotion(page);
    await page.goto('/');
    await waitForApp(page);
    await page.waitForFunction(() => !document.getElementById('preloader'));
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
}

async function bootConversation(page, baseURL) {
    const origin = new URL(baseURL).origin;
    await protectMaintainerServer(page);
    const readEndpoints = new Set([
        '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
        '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me',
    ]);
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/extensions/discover') {
            const extensions = await fetchJsonOrSkip(route);
            if (!extensions) return;
            return route.fulfill({ json: extensions.filter(extension => !extension.name.startsWith('third-party/')) });
        }
        if (url.pathname === '/api/settings/get') {
            const data = await fetchJsonOrSkip(route);
            if (!data) return;
            const settings = JSON.parse(data.settings);
            settings.firstRun = false;
            settings.power_user.auto_connect = false;
            settings.power_user.reduced_motion = false;
            settings.extension_settings.sillybunny_conversation = {};
            settings.extension_settings['quick-image-gen'] = { setupWizardSeen: true };
            data.request_compression = { ...data.request_compression, enabled: false };
            data.settings = JSON.stringify(settings);
            return route.fulfill({ json: data });
        }
        if (readEndpoints.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')) return route.continue();
        if (url.pathname.startsWith('/api/backends/')) return route.fulfill({ json: { data: [] } });
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) return route.fulfill({ json: {} });
        return route.continue();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await page.evaluate(async () => {
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        const { stopConversationAutoWorker } = await import('/scripts/sillybunny-conversation/auto-engine.js');
        const { renderConversationTimeline } = await import('/scripts/sillybunny-conversation/timeline-render.js');
        const context = window.SillyTavern.getContext();
        const character = context.characters.find(entry => /Bunny Guide|Seraphina/.test(entry?.name ?? ''));
        if (!character?.avatar) throw new Error('No bundled Conversation character found.');
        openConversationWorkspaceForAvatar(character.avatar, { showToast: false });
        stopConversationAutoWorker();
        renderConversationTimeline();
    });
    await expect(page.locator('#sb_conversation_user_status_picker')).toBeAttached();
}

// The trigger sits at the top of the viewport so that the sheet never covers it.
async function addTrigger(page) {
    await page.evaluate(() => {
        const trigger = document.createElement('button');
        trigger.id = 'qa-sheet-trigger';
        trigger.type = 'button';
        trigger.textContent = 'Trigger';
        trigger.style.cssText = 'position: fixed; top: 4px; left: 4px; z-index: 1; width: 60px; height: 40px;';
        document.body.append(trigger);
    });
}

const SURFACES = [
    {
        name: 'picker sheet',
        boot: bootApp,
        exitContinuesFromDrag: true,
        async open(page) {
            await addTrigger(page);
            await page.evaluate(async () => {
                const { openPicker } = await import('/scripts/sillybunny-editor/picker.js');
                const trigger = document.getElementById('qa-sheet-trigger');
                window.qaSheet = { picked: [] };
                openPicker({
                    trigger,
                    title: 'QA picker',
                    items: [{ value: 'alpha', label: 'Alpha' }, { value: 'beta', label: 'Beta' }],
                    onSelect: value => window.qaSheet.picked.push(value),
                });
            });
            return {
                sheet: page.locator('.sb-picker-sheet'),
                title: page.locator('.sb-picker-sheet .sb-action-sheet-title'),
                closeButton: page.locator('.sb-picker-sheet .sb-action-sheet-close'),
                unchanged: () => page.evaluate(() => window.qaSheet.picked.length === 0),
            };
        },
    },
    {
        name: 'menu sheet',
        boot: bootApp,
        exitContinuesFromDrag: true,
        async open(page) {
            await addTrigger(page);
            await page.evaluate(async () => {
                const { openActionMenu } = await import('/scripts/sillybunny-action-menu.js');
                const trigger = document.getElementById('qa-sheet-trigger');
                window.qaSheet = { picked: [] };
                openActionMenu({
                    trigger,
                    title: 'QA menu',
                    sections: [{ items: [{ label: 'Alpha', onSelect: () => window.qaSheet.picked.push('alpha') }] }],
                });
            });
            return {
                sheet: page.locator('.sb-action-sheet:not(.sb-picker-sheet)'),
                title: page.locator('.sb-action-sheet:not(.sb-picker-sheet) .sb-action-sheet-title'),
                closeButton: page.locator('.sb-action-sheet:not(.sb-picker-sheet) .sb-action-sheet-close'),
                unchanged: () => page.evaluate(() => window.qaSheet.picked.length === 0),
            };
        },
    },
    {
        name: 'popover form sheet',
        boot: bootApp,
        exitContinuesFromDrag: true,
        async open(page) {
            await addTrigger(page);
            await page.evaluate(async () => {
                const { openPopover } = await import('/scripts/sillybunny-action-menu.js');
                const trigger = document.getElementById('qa-sheet-trigger');
                const content = document.createElement('form');
                const input = document.createElement('input');
                input.setAttribute('aria-label', 'QA name');
                content.append(input);
                window.qaSheet = { submitted: 0 };
                content.addEventListener('submit', () => { window.qaSheet.submitted += 1; });
                openPopover({ trigger, content, title: 'QA form' });
            });
            return {
                sheet: page.locator('.sb-action-sheet:not(.sb-picker-sheet)'),
                title: page.locator('.sb-action-sheet:not(.sb-picker-sheet) .sb-action-sheet-title'),
                closeButton: page.locator('.sb-action-sheet:not(.sb-picker-sheet) .sb-action-sheet-close'),
                unchanged: () => page.evaluate(() => window.qaSheet.submitted === 0),
            };
        },
    },
    {
        name: 'Conversation picker',
        boot: bootConversation,
        hasHeader: false,
        exitContinuesFromDrag: true,
        async open(page) {
            await addTrigger(page);
            await page.evaluate(async () => {
                const { toggleUserStatusPicker } = await import('/scripts/sillybunny-conversation/pickers.js');
                const { getUserStatus } = await import('/scripts/sillybunny-conversation/personas.js');
                const trigger = document.getElementById('qa-sheet-trigger');
                window.qaSheet = { status: getUserStatus() };
                toggleUserStatusPicker(trigger);
            });
            return {
                sheet: page.locator('#sb_conversation_user_status_picker'),
                unchanged: () => page.evaluate(async () => {
                    const { getUserStatus } = await import('/scripts/sillybunny-conversation/personas.js');
                    return getUserStatus() === window.qaSheet.status;
                }),
            };
        },
    },
    {
        name: 'agent property sheet',
        boot: bootApp,
        exitContinuesFromDrag: true,
        async open(page) {
            await page.evaluate(async () => {
                const { createAgentEditorProperties } = await import('/scripts/extensions/in-chat-agents/ui/agent-editor-properties.js');
                await window.SillyBunnyAssets.loadStylesheetAsync('css/sillybunny-prompt-editor.css?v=20261027a', { id: 'deferred-prompt-editor-css' });
                window.qaSheet = { changes: [] };
                const properties = createAgentEditorProperties({
                    categories: [['general', 'General']],
                    onChange: (...change) => window.qaSheet.changes.push(change),
                });
                document.body.append(properties.element);
                properties.render({ category: 'general', phase: 'before', execution: 'sequential', favorite: false }, { fields: {}, disabled: {} });
                const summary = properties.element.querySelector('.ica-agent-property-summary');
                summary.id = 'qa-sheet-trigger';
                summary.click();
            });
            return {
                sheet: page.locator('.ica-agent-property-sheet'),
                title: page.locator('.ica-agent-property-sheet .sb-prompt-sheet-header h2'),
                closeButton: page.locator('.ica-agent-property-sheet .sb-prompt-sheet-header button'),
                unchanged: () => page.evaluate(() => window.qaSheet.changes.length === 0),
            };
        },
    },
];

const topOf = sheet => sheet.evaluate(node => node.getBoundingClientRect().top);

// A swipe is short while it stays under 30% of the sheet height, which differs per sheet.
async function shortSwipeDistance(sheet) {
    const { height } = await sheet.boundingBox();
    return Math.max(8, Math.floor(height * 0.15));
}

// The pointer stays still before release, so the release velocity is 0 and only the distance decides.
async function dragDown(page, handle, distance) {
    const box = await handle.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + distance, { steps: 8 });
}

async function openSettled(surface, page, baseURL, { reducedMotion = false } = {}) {
    await surface.boot(page, baseURL);
    expect(await page.evaluate(async () => (await import('/scripts/sillybunny-motion.js')).prefersReducedMotion())).toBe(reducedMotion);
    const opened = await surface.open(page);
    const handle = opened.sheet.locator(':scope > .sb-dialog__handle');
    await expect(opened.sheet).toBeVisible();
    await expect(handle).toBeVisible();
    await expect.poll(() => opened.sheet.evaluate(node => node.getAnimations().length)).toBe(0);
    return { ...opened, handle, trigger: page.locator('#qa-sheet-trigger'), restTop: await topOf(opened.sheet) };
}

for (const surface of SURFACES) {
    test.describe(`${surface.name} swipe at 390×844`, () => {
        test('the handle sits at the top edge and a mid-drag sheet follows the finger', async ({ page, baseURL }) => {
            const { sheet, handle, restTop } = await openSettled(surface, page, baseURL);
            const handleBox = await handle.boundingBox();
            expect(handleBox.width).toBe(80);
            expect(handleBox.height).toBe(20);
            expect(Math.abs(handleBox.y - (restTop + 1))).toBeLessThanOrEqual(1);

            await dragDown(page, handle, 120);
            await expect.poll(() => topOf(sheet)).toBeCloseTo(restTop + 120, 0);
            expect(await sheet.evaluate(node => getComputedStyle(node).transform)).not.toBe('none');
            await page.mouse.up();
        });

        test('a long swipe closes through the normal path and leaves the result unchanged', async ({ page, baseURL }) => {
            const { sheet, handle, trigger, unchanged } = await openSettled(surface, page, baseURL);
            await dragDown(page, handle, 300);
            await page.mouse.up();

            await expect(sheet).toBeHidden();
            expect(await unchanged()).toBe(true);
            expect(await sheet.evaluate(node => node.style.transform)).toBe('');
            await expect(trigger).toBeFocused();
        });

        if (surface.exitContinuesFromDrag) {
            test('the exit animation continues from the dragged position', async ({ page, baseURL }) => {
                const { sheet, handle, restTop } = await openSettled(surface, page, baseURL);
                await dragDown(page, handle, 300);
                // A slowed page keeps the exit running long enough to read the sheet's position.
                const client = await page.context().newCDPSession(page);
                await client.send('Animation.enable');
                await client.send('Animation.setPlaybackRate', { playbackRate: 0.05 });
                await page.mouse.up();
                expect(await topOf(sheet)).toBeGreaterThanOrEqual(restTop + 250);
                await client.send('Animation.setPlaybackRate', { playbackRate: 1 });
                await expect(sheet).toBeHidden();
            });
        }

        // The Conversation pickers have no header bar, so only the handle starts a swipe there.
        if (surface.hasHeader !== false) {
            test('a swipe that starts on the header closes, and one that starts on the Close button does not move the sheet', async ({ page, baseURL }) => {
                const { sheet, title, closeButton, restTop } = await openSettled(surface, page, baseURL);
                await dragDown(page, closeButton, 120);
                expect(await topOf(sheet)).toBe(restTop);
                await page.mouse.up();
                await expect(sheet).toBeVisible();

                await dragDown(page, title, 300);
                await page.mouse.up();
                await expect(sheet).toBeHidden();
            });
        }

        test('under reduced motion a long swipe closes at once, clears the drag and restores focus', async ({ page, baseURL }) => {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            const { sheet, handle, trigger, unchanged } = await openSettled(surface, page, baseURL, { reducedMotion: true });
            await dragDown(page, handle, 300);
            await page.mouse.up();

            await expect(sheet).toBeHidden();
            expect(await sheet.evaluate(node => node.style.transform)).toBe('');
            expect(await unchanged()).toBe(true);
            await expect(trigger).toBeFocused();
        });

        test('a short swipe springs back and keeps the sheet open', async ({ page, baseURL }) => {
            const { sheet, handle, restTop } = await openSettled(surface, page, baseURL);
            const distance = await shortSwipeDistance(sheet);
            await dragDown(page, handle, distance);
            await expect.poll(() => topOf(sheet)).toBeCloseTo(restTop + distance, 0);
            await page.mouse.up();

            await expect.poll(() => topOf(sheet)).toBeCloseTo(restTop, 0);
            await expect(sheet).toBeVisible();
        });

        test('reduced motion springs back at once, without an animation', async ({ page, baseURL }) => {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            const { sheet, handle, restTop } = await openSettled(surface, page, baseURL, { reducedMotion: true });
            const distance = await shortSwipeDistance(sheet);
            await dragDown(page, handle, distance);
            await expect.poll(() => topOf(sheet)).toBeCloseTo(restTop + distance, 0);
            await page.mouse.up();

            expect(await sheet.evaluate(node => ({ animations: node.getAnimations().length, top: node.getBoundingClientRect().top }))).toEqual({ animations: 0, top: restTop });
        });
    });
}

test.describe('Conversation pickers at 390×844', () => {
    const PICKERS = [
        { name: 'status picker', id: 'sb_conversation_user_status_picker' },
        { name: 'persona picker', id: 'sb_conversation_persona_picker' },
        { name: 'add-DM picker', id: 'sb_conversation_add_dm_picker' },
    ];

    // Each opener fills the picker through the renderer that replaces its children.
    async function openPicker(page, id) {
        await addTrigger(page);
        await page.evaluate(async pickerId => {
            const pickers = await import('/scripts/sillybunny-conversation/pickers.js');
            const trigger = document.getElementById('qa-sheet-trigger');
            if (pickerId === 'sb_conversation_user_status_picker') pickers.toggleUserStatusPicker(trigger);
            if (pickerId === 'sb_conversation_persona_picker') pickers.togglePersonaPicker(trigger);
            if (pickerId === 'sb_conversation_add_dm_picker') pickers.toggleConversationGroupPicker({ anchor: trigger });
            // Counts how often the picker becomes hidden, so a double close shows.
            const picker = document.getElementById(pickerId);
            window.qaHides = 0;
            new MutationObserver(records => {
                for (const record of records) if (record.oldValue === null && picker.hasAttribute('hidden')) window.qaHides += 1;
            }).observe(picker, { attributes: true, attributeFilter: ['hidden'], attributeOldValue: true });
        }, id);
        const picker = page.locator(`#${id}`);
        await expect(picker).toBeVisible();
        return picker;
    }

    async function swipeClosed(page, picker) {
        await expect.poll(() => picker.evaluate(node => node.getAnimations().length)).toBe(0);
        await dragDown(page, picker.locator(':scope > .sb-dialog__handle'), 300);
        await page.mouse.up();
        await expect(picker).toBeHidden();
        expect(await page.evaluate(() => window.qaHides)).toBe(1);
    }

    test('the persona picker keeps one handle when its renderer wipes it while open, and one swipe closes it once', async ({ page, baseURL }) => {
        await bootConversation(page, baseURL);
        const picker = await openPicker(page, 'sb_conversation_persona_picker');
        await expect(picker.locator(':scope > .sb-dialog__handle')).toHaveCount(1);
        await page.evaluate(async () => {
            const { renderConversationPersonaPicker } = await import('/scripts/sillybunny-conversation/pickers.js');
            renderConversationPersonaPicker(document.getElementById('sb_conversation_persona_picker'));
        });
        await expect(picker.locator(':scope > .sb-dialog__handle')).toHaveCount(1);
        await swipeClosed(page, picker);
    });

    test('the add-DM picker keeps one handle across both wipe paths while open, and one swipe closes it once', async ({ page, baseURL }) => {
        await bootConversation(page, baseURL);
        const picker = await openPicker(page, 'sb_conversation_add_dm_picker');
        await expect(picker.locator(':scope > .sb-dialog__handle')).toHaveCount(1);
        // Opening the solo form while the group form is open rewrites the picker again.
        await page.evaluate(async () => {
            const { toggleAddDmPicker } = await import('/scripts/sillybunny-conversation/pickers.js');
            toggleAddDmPicker(document.getElementById('qa-sheet-trigger'));
        });
        await expect(picker.locator('.sb-conversation-add-dm-title')).toHaveText('Create a solo DM');
        await expect(picker.locator(':scope > .sb-dialog__handle')).toHaveCount(1);
        await swipeClosed(page, picker);
    });

    for (const { name, id } of PICKERS) {
        test(`the ${name} slides out from the drag position and leaves clean state`, async ({ page, baseURL }) => {
            await bootConversation(page, baseURL);
            const picker = await openPicker(page, id);
            const backdrop = page.locator('#sb_conversation_picker_backdrop');
            await expect.poll(() => picker.evaluate(node => node.getAnimations().length)).toBe(0);
            const restTop = await topOf(picker);

            await dragDown(page, picker.locator(':scope > .sb-dialog__handle'), 300);
            const client = await page.context().newCDPSession(page);
            await client.send('Animation.enable');
            await client.send('Animation.setPlaybackRate', { playbackRate: 0.05 });
            await page.mouse.up();
            expect(await topOf(picker)).toBeGreaterThanOrEqual(restTop + 250);
            await expect(backdrop).toHaveAttribute('data-open', 'true');
            await client.send('Animation.setPlaybackRate', { playbackRate: 1 });

            await expect(picker).toBeHidden();
            await expect(backdrop).toHaveAttribute('data-open', 'false');
            expect(await backdrop.evaluate(node => node.style.opacity)).toBe('');
            expect(await picker.evaluate(node => node.style.transform)).toBe('');
            await expect(page.locator('#qa-sheet-trigger')).toBeFocused();

            await page.evaluate(async pickerId => {
                const pickers = await import('/scripts/sillybunny-conversation/pickers.js');
                const trigger = document.getElementById('qa-sheet-trigger');
                if (pickerId === 'sb_conversation_user_status_picker') pickers.toggleUserStatusPicker(trigger);
                if (pickerId === 'sb_conversation_persona_picker') pickers.togglePersonaPicker(trigger);
                if (pickerId === 'sb_conversation_add_dm_picker') pickers.toggleConversationGroupPicker({ anchor: trigger });
            }, id);
            await expect(picker).toBeVisible();
            await expect.poll(() => picker.evaluate(node => node.getAnimations().length)).toBe(0);
            expect(await topOf(picker)).toBe(restTop);
        });
    }
});
