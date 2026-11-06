import { expect, test } from '@playwright/test';
import { motionOn, startPaintProbe, stopPaintProbe, warmUpPopups } from './helpers/first-paint-probe.js';
import { testSetup } from './frontend/frontent-test-utils.js';
import { bootConnectionDialogs } from './helpers/connection-manager-dialogs.js';
import { bootMiscDialogs, openMiscDialog } from './helpers/misc-dialogs.js';
import { bootPresetLorebookDialogs, openPresetLorebookDialog } from './helpers/preset-lorebook-dialogs.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { bootWindowContentDialogs, openAdminPanel } from './helpers/window-content-dialogs.js';
import { bootWindowDialogs } from './helpers/window-dialogs.js';
import { bootWindowToolsDialogs } from './helpers/window-tools-dialogs.js';
import { bootUtilityDialogs, triggerUtilityDialog, UTILITY_VIEWPORTS } from './helpers/utility-dialogs.js';

test.setTimeout(90000);
// Playwright's `page.route` does not see requests that the app's service worker handles.
test.use({ serviceWorkers: 'block' });

// The frame adapters rebuild the Popup's content. That has to be done before the first paint: the opening animation
// runs for a while, and a dialog that is adapted only when it ends shows the upstream form first.
const SURFACES = [
    { surface: 'recent', rows: ['Max recent chats', 'Collapsed recent chats'] },
    { surface: 'persona', rows: ['Name', 'Persona Title (optional, display only)'] },
    { surface: 'secret', rows: ['Secret value (can be empty):', 'Label (optional):'], popups: 2 },
    { surface: 'web' },
    { surface: 'youtube' },
    { surface: 'image' },
    { surface: 'icons', classes: ['sb-icon-picker'] },
];

// Fields that change on their own while a dialog opens.
function withoutAnimationState({ opening, opacity, ...frame }) {
    return frame;
}

/** Entries of the array fields in `a` that `b` lacks, to show what changed. */
function listOnly(a, b) {
    return Object.fromEntries(Object.entries(a)
        .filter(([key, value]) => Array.isArray(value))
        .map(([key, value]) => [key, value.filter(entry => !b[key].includes(entry))])
        .filter(([, value]) => value.length));
}

const MOTION_ON = {
    // Motion on: with reduced motion Popup runs `onOpen` at once, which hides the bug.
    reducedMotion: 'no-preference',
    configureSettings: settings => { settings.power_user.reduced_motion = false; },
};

// Adapters outside utility-dialogs.js that also build their rows when the dialog opens.
const MISC_SURFACES = [
    { surface: 'screenshot', rows: ['Start ID', 'End ID'] },
    { surface: 'install', rows: ['Enter the Git URL of the extension to install'] },
    { surface: 'branch', rows: ['Switch branch'] },
];

/**
 * Every frame must match the settled dialog. `only` limits the comparison to those fields, for a Window whose list
 * loads after it opens: only the parts that an adapter owns are compared, and the loose-control checks are skipped.
 */
function expectEveryFrameSettled(frames, { rows, classes = [], requireRows = true, header = null, destructive = false, only = null }) {
    const [first] = frames;
    const settled = frames.at(-1);
    // The probe proves nothing unless the opening animation was running in the first frame.
    expect(first.opening, 'the first sampled frame is inside the opening animation').toBe(true);
    expect(settled.opening).toBe(false);

    if (!only) {
        expect(settled.looseLabels, 'the settled dialog has no Popup labels').toBe(0);
        expect(settled.looseFields, 'the settled dialog has no field outside a row').toBe(0);
    }
    if (requireRows) expect(settled.rowTitles.length, 'the settled dialog has rows').toBeGreaterThan(0);
    for (const name of classes) expect(settled.classes).toContain(name);
    if (rows) expect(first.rowTitles).toEqual(expect.arrayContaining(rows));
    if (header) {
        expect(settled.headerOutline.join(' '), 'the settled header has the adapter control').toContain(header);
        expect(first.headerOutline.join(' '), 'the first frame has the adapter control in its header').toContain(header);
    }
    if (destructive) expect(first.okClasses, 'the first frame already marks OK as destructive').toContain('is-destructive');

    const comparable = frame => {
        const state = withoutAnimationState(frame);
        return only ? Object.fromEntries(only.map(key => [key, state[key]])) : state;
    };
    const expected = comparable(settled);
    const differing = frames
        .map((frame, index) => ({ index, frame: comparable(frame) }))
        .filter(({ frame }) => JSON.stringify(frame) !== JSON.stringify(expected))
        .map(({ index, frame }) => ({
            index,
            differs: Object.keys(expected).filter(key => JSON.stringify(frame[key]) !== JSON.stringify(expected[key])),
            ...(index === 0 ? { onlyInFirst: listOnly(frame, expected), onlyInSettled: listOnly(expected, frame) } : {}),
        }));
    expect(differing.length, `frames whose layout differs from the settled dialog: ${JSON.stringify(differing.slice(0, 1))} and ${Math.max(0, differing.length - 1)} more`).toBe(0);
}

for (const viewport of UTILITY_VIEWPORTS) {
    const size = `${viewport.width}×${viewport.height}`;
    for (const { surface, rows, popups = 1, classes = [] } of SURFACES) {
        test(`${surface} dialog paints its adapted layout in every frame, from the first, at ${size}`, async ({ page }) => {
            await bootUtilityDialogs(page, viewport, MOTION_ON);
            await warmUpPopups(page);
            await startPaintProbe(page);
            await triggerUtilityDialog(page, surface);
            const frames = await stopPaintProbe(page, popups);
            expect(frames.length, 'frames sampled during and after the opening animation').toBeGreaterThan(2);
            expectEveryFrameSettled(frames, { rows, classes });
        });
    }

    for (const { surface, rows } of MISC_SURFACES) {
        test(`${surface} dialog paints its adapted layout in every frame, from the first, at ${size}`, async ({ page }) => {
            await bootMiscDialogs(page, viewport, MOTION_ON);
            await warmUpPopups(page);
            await startPaintProbe(page);
            await openMiscDialog(page, surface);
            const frames = await stopPaintProbe(page);
            expect(frames.length, 'frames sampled during and after the opening animation').toBeGreaterThan(2);
            expectEveryFrameSettled(frames, { rows });
        });
    }
}

// Frame adapters in other files, each with the boot and opener its own spec uses.
async function bootSwipePicker(page, viewport) {
    let settingsVersion = Date.now();
    await page.route('**/api/settings/save', route => route.fulfill({ json: { result: 'ok', version: ++settingsVersion } }));
    await page.route('**/api/settings/get', async route => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        settings.power_user.world_import_dialog = false;
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });
    await page.route('**/api/chats/save', route => route.fulfill({ json: { integrity: 'first-paint-test' } }));
    await page.setViewportSize(viewport);
    await testSetup.awaitST({ page });
}

async function openSwipePicker(page) {
    const messageId = await page.evaluate(async () => {
        const { newAssistantChat, selectCharacterById } = await import('/script.js');
        const context = window.SillyTavern.getContext();
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        const characterId = context.characters.findIndex(character => character?.avatar);
        if (characterId >= 0) await selectCharacterById(characterId, { switchMenu: false });
        else await newAssistantChat({ temporary: true });
        const count = 12;
        const message = {
            name: 'Assistant', is_user: false, is_system: false, send_date: new Date().toISOString(), mes: 'Swipe 1 preview text', extra: {},
            swipes: Array.from({ length: count }, (_, index) => `Swipe ${index + 1} preview text`), swipe_id: 1,
            swipe_info: Array.from({ length: count }, () => ({ send_date: Date.now(), extra: { token_count: 4 } })),
        };
        context.chat.push(message);
        await context.addOneMessage(message);
        const id = context.chat.length - 1;
        document.querySelector(`.mes[mesid="${id}"] .swipes-counter`)?.classList.add('swipe-picker-enabled');
        return id;
    });
    return page.locator(`.mes[mesid="${messageId}"] .swipes-counter.swipe-picker-enabled`).click();
}

const ADAPTER_SURFACES = [
    {
        name: 'connection profile', expect: {},
        boot: bootConnectionDialogs,
        open: page => page.evaluate(() => document.getElementById('create_connection_profile').click()),
    },
    {
        name: 'connection profile deletion', expect: { destructive: true },
        boot: bootConnectionDialogs,
        open: page => page.evaluate(() => document.getElementById('delete_all_connection_profiles').click()),
    },
    {
        name: 'preset deletion', expect: { destructive: true },
        boot: bootPresetLorebookDialogs,
        open: page => openPresetLorebookDialog(page, 'delete'),
    },
    {
        name: 'lorebook sorting', expect: {},
        boot: bootPresetLorebookDialogs,
        open: page => openPresetLorebookDialog(page, 'sorting'),
    },
    {
        // Select2 starts in onOpen. The shared select row hides its container, so only a class on the hidden native select changes.
        name: 'character lorebook', expect: { only: ['classes', 'rowTitles', 'rowSubtitles', 'rowHeights', 'contentHeadings', 'looseLabels', 'looseFields'] },
        boot: bootMiscDialogs,
        open: page => page.evaluate(() => {
            const { characters } = window.SillyTavern.getContext();
            $('#set_character_world').data('chid', characters.findIndex(character => character.avatar === 'misc-dialog-character.png'));
            $('#char-management-dropdown').val($('#set_character_world').val()).trigger('change');
        }),
    },
    {
        name: 'admin panel', expect: { requireRows: false, only: ['classes', 'headerOutline', 'okClasses'], header: 'sb-dialog__header-end' },
        boot: (page, viewport) => bootWindowContentDialogs(page, viewport, { admin: true }),
        open: openAdminPanel,
    },
    {
        name: 'extensions manager', expect: { requireRows: false, only: ['classes', 'headerOutline', 'okClasses'], header: 'extensions-header-menus' },
        boot: (page, viewport) => bootWindowToolsDialogs(page, viewport),
        open: async page => {
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
            await page.locator('#extensions_details').waitFor({ state: 'visible' });
            await page.locator('#extensions_details').click();
        },
    },
    {
        name: 'data bank', expect: { requireRows: false, only: ['classes', 'headerOutline', 'okClasses'], header: 'sb-data-bank-search-toggle' },
        boot: bootWindowDialogs,
        open: page => page.locator('#manageAttachments').dispatchEvent('click'),
    },
    {
        name: 'swipe picker', expect: { requireRows: false, only: ['classes', 'headerOutline', 'okClasses'], header: 'swipe_picker_footer' },
        boot: bootSwipePicker,
        open: openSwipePicker,
    },
];

for (const viewport of UTILITY_VIEWPORTS) {
    const size = `${viewport.width}×${viewport.height}`;
    for (const { name, expect: expectations, boot, open } of ADAPTER_SURFACES) {
        test(`${name} dialog paints its adapted layout in every frame, from the first, at ${size}`, async ({ page }) => {
            await boot(page, viewport);
            await motionOn(page);
            await warmUpPopups(page);
            await startPaintProbe(page);
            await open(page);
            const frames = await stopPaintProbe(page);
            expect(frames.length, 'frames sampled during and after the opening animation').toBeGreaterThan(2);
            expectEveryFrameSettled(frames, expectations);
        });
    }
}

test('recent chats settings first frame shows two spin rows with a range subtitle and no heading or labelled inputs', async ({ page }) => {
    await bootUtilityDialogs(page, UTILITY_VIEWPORTS[0], MOTION_ON);
    await warmUpPopups(page);
    await startPaintProbe(page);
    await triggerUtilityDialog(page, 'recent');
    const [first] = await stopPaintProbe(page);
    expect(first.opening).toBe(true);
    expect(first.rowTitles).toEqual(['Max recent chats', 'Collapsed recent chats']);
    expect(first.rowSubtitles).toEqual(['1 - 1000', '1 - 1000']);
    expect(first.contentHeadings).toEqual([]);
    expect(first.looseLabels).toBe(0);
});
