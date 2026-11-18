import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { waitForAppReady } from './helpers/app-ready.js';
import { scanStable } from './helpers/axe-scan.js';

// The Backgrounds gallery's folders. Backgrounds and folders are made on the server the test runs against, with names that
// start with PREFIX, and removed again after each test.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const PREFIX = 'p13e-';
const NAMES = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map(name => `${PREFIX}${name}.png`);
const STUB = file => `#bg_menu_content .bg_example[bgfile="${file}"]`;

async function seed(page, { folders = [], members = {} } = {}) {
    return page.evaluate(async ({ names, folders: folderNames, members: memberMap }) => {
        const { getRequestHeaders } = await import('./script.js');
        const { getBackgrounds } = await import('./scripts/backgrounds.js');
        const json = headers => ({ ...getRequestHeaders(), ...headers });
        const post = async (path, body) => (await fetch(path, { method: 'POST', headers: json(), body: JSON.stringify(body) })).json().catch(() => ({}));
        for (const [index, name] of names.entries()) {
            const canvas = document.createElement('canvas');
            canvas.width = 64;
            canvas.height = 36;
            const context = canvas.getContext('2d');
            context.fillStyle = `hsl(${index * 55}, 70%, 50%)`;
            context.fillRect(0, 0, 64, 36);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            const form = new FormData();
            form.append('avatar', new File([blob], name, { type: 'image/png' }));
            await fetch('/api/backgrounds/upload', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
        }
        const ids = {};
        for (const folderName of folderNames) ids[folderName] = (await post('/api/image-metadata/folders/create', { name: folderName })).id;
        for (const [folderName, files] of Object.entries(memberMap)) {
            if (files.length) await post('/api/image-metadata/folders/assign', { id: ids[folderName], paths: files.map(file => `backgrounds/${file}`) });
        }
        await getBackgrounds();
        return ids;
    }, { names: NAMES, folders, members });
}

async function cleanup(page) {
    await page.evaluate(async prefix => {
        const { getRequestHeaders } = await import('./script.js');
        const post = (path, body) => fetch(path, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
        const { folders } = await (await post('/api/backgrounds/folders', {})).json();
        for (const folder of folders) if (folder.name.startsWith(prefix)) await post('/api/image-metadata/folders/delete', { id: folder.id });
        const { images } = await (await post('/api/backgrounds/all', {})).json();
        for (const image of images) if (image.filename.startsWith(prefix)) await post('/api/backgrounds/delete', { bg: image.filename });
    }, PREFIX);
}

const serverFolders = page => page.evaluate(async () => {
    const { getRequestHeaders } = await import('./script.js');
    return (await fetch('/api/backgrounds/folders', { method: 'POST', headers: getRequestHeaders(), body: '{}' })).json();
});

async function openGallery(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'appearance'));
    await page.locator('button[data-sb-settings-tab="appearance"]').evaluate(button => button.click());
    await expect(page.locator('#bg_tabs')).toBeVisible();
    await expect(page.locator('#Backgrounds .sb-bg-search-field')).toBeVisible();
    await page.locator('#bg_tabs').scrollIntoViewIfNeeded();
}

const folderRow = (page, name) => page.locator('#bg_menu_content .sb-folder-row', { hasText: name });
const section = (page, name) => page.locator('#bg_menu_content .sb-bg-section', { has: page.locator('.sb-folder-row', { hasText: name }) });
const stored = page => page.evaluate(async () => structuredClone((await import('./scripts/power-user.js')).power_user.sb_folders.backgrounds ?? null));
const currentBackground = page => page.evaluate(async () => (await import('./scripts/backgrounds.js')).background_settings.name);

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    await page.goto('/');
    await waitForAppReady(page, { timeout: 60_000 });
});

test.afterEach(async ({ page }) => {
    await cleanup(page).catch(() => {});
});

/**
 * Clicks a folder row in the page and records its section body on every frame: the running animations, the box height,
 * the opacity and the chevron's transform. `clickAgainAt` clicks a second time that many milliseconds after the first.
 * `seekStep` pauses every animation after the first frame and steps it by that many milliseconds instead: a headless engine that
 * draws in software (Firefox) delivers a frame only every 50 to 100 ms, which leaves too few frames inside a 250 ms motion and lets a
 * motion move a long way between the frames on each side of a second click.
 */
async function traceFolder(page, name, { clickAgainAt = 0, duration = 450, seekStep = 0 } = {}) {
    return page.evaluate(({ name: folderName, clickAgainAt: again, duration: span, seekStep: step }) => new Promise(resolve => {
        const row = [...document.querySelectorAll('#bg_menu_content .sb-folder-row')].find(node => node.textContent.includes(folderName));
        const bodyOf = () => row.closest('.sb-bg-section').querySelector('.sb-bg-section__body');
        const frames = [];
        const sample = at => {
            const body = bodyOf();
            const chevron = row.querySelector('.ds-entity-row__chevron');
            frames.push({
                at: Math.round(at),
                height: body.getBoundingClientRect().height,
                opacity: Number(getComputedStyle(body).opacity),
                hidden: body.hidden,
                thumbs: body.querySelectorAll('.bg_example').length,
                expanded: row.getAttribute('aria-expanded'),
                chevron: getComputedStyle(chevron).transform,
                // WebKit reports the curve of `ease`, which is this one, by its keyword.
                animations: body.getAnimations().map(animation => ({ duration: animation.effect.getTiming().duration, easing: animation.effect.getTiming().easing === 'ease' ? 'cubic-bezier(0.25, 0.1, 0.25, 1)' : animation.effect.getTiming().easing })),
            });
        };
        const start = performance.now();
        row.click();
        sample(0);
        if (step) {
            // Steps every running animation through its whole length, then lets the ends run (`finish` is delivered asynchronously).
            const stepThrough = (offset, until) => {
                const running = document.getAnimations();
                for (const animation of running) animation.pause();
                const longest = Math.max(...running.map(animation => Number(animation.effect.getComputedTiming().endTime)));
                for (let at = step; at < Math.min(longest, until); at += step) {
                    for (const animation of running) animation.currentTime = at;
                    sample(offset + at);
                }
                return { running, longest };
            };
            const first = stepThrough(0, again || Infinity);
            let finishing = first;
            let offset = 0;
            if (again) {
                // The second click comes at `again`, with the first motion held at that time.
                for (const animation of first.running) animation.currentTime = again;
                sample(again);
                row.click();
                sample(again + 1);
                offset = again;
                finishing = stepThrough(offset, Infinity);
            }
            for (const animation of finishing.running) animation.finish();
            setTimeout(() => {
                sample(offset + finishing.longest);
                resolve(frames);
            }, 150);
            return;
        }
        let clickedAgain = !again;
        const tick = now => {
            const at = now - start;
            if (!clickedAgain && at >= again) {
                clickedAgain = true;
                row.click();
            }
            sample(at);
            if (at < span) requestAnimationFrame(tick);
            else resolve(frames);
        };
        requestAnimationFrame(tick);
    }), { name, clickAgainAt, duration, seekStep });
}

async function endsOf(page) {
    return page.evaluate(() => {
        const edge = node => Math.round(node.getBoundingClientRect().right * 100) / 100;
        // A hidden button that still takes room is the gap the user saw, so only a button the user can see counts as the last one.
        const controls = [...document.querySelectorAll('#bg_tabs .heading-controls > *')]
            .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
        const grid = document.getElementById('bg_menu_content');
        const cells = [...grid.querySelectorAll('.bg_example')].filter(node => node.getClientRects().length);
        return {
            lastControl: edge(controls.at(-1)),
            grid: edge(grid),
            widestCell: Math.max(...cells.map(edge)),
            row: edge(document.querySelector('#bg_tabs')),
        };
    });
}

for (const { label, width, height, touch } of [
    { label: 'desktop', width: 1440, height: 900, touch: false },
    { label: 'phone', width: 390, height: 844, touch: true },
]) {
    test.describe(`Background folders on ${label}`, () => {
        test.use({ viewport: { width, height }, hasTouch: touch, isMobile: touch });

        test('the tab row ends where the thumbnail grid ends, with and without folders and with the scroll button shown', async ({ page }) => {
            await seed(page);
            await openGallery(page);
            await expect(page.locator(STUB(NAMES[0]))).toBeVisible();
            let ends = await endsOf(page);
            expect(ends.lastControl).toBeCloseTo(ends.grid, 0);
            expect(ends.widestCell).toBeCloseTo(ends.grid, 0);

            await page.evaluate(() => document.getElementById('bg-scroll-top').classList.add('visible'));
            ends = await endsOf(page);
            expect(ends.lastControl).toBeCloseTo(ends.grid, 0);
            await page.evaluate(() => document.getElementById('bg-scroll-top').classList.remove('visible'));

            await seed(page, { folders: [`${PREFIX}One`], members: { [`${PREFIX}One`]: [NAMES[0]] } });
            await expect(folderRow(page, `${PREFIX}One`)).toBeVisible();
            ends = await endsOf(page);
            expect(ends.lastControl).toBeCloseTo(ends.grid, 0);
            const sectionEdge = await page.locator('#bg_menu_content .sb-bg-section').first().evaluate(node => Math.round(node.getBoundingClientRect().right * 100) / 100);
            expect(sectionEdge).toBeCloseTo(ends.lastControl, 0);
        });

        test('folders are sections with a count, closed folders build no thumbnails, and the rest follow under No Folder', async ({ page }) => {
            await seed(page, {
                folders: [`${PREFIX}One`, `${PREFIX}Empty`],
                members: { [`${PREFIX}One`]: [NAMES[0], NAMES[1]], [`${PREFIX}Empty`]: [] },
            });
            await openGallery(page);
            await expect(folderRow(page, `${PREFIX}One`)).toHaveAccessibleName(`${PREFIX}One 2 backgrounds`);
            await expect(folderRow(page, `${PREFIX}Empty`)).toHaveAccessibleName(`${PREFIX}Empty 0 backgrounds`);
            await expect(section(page, `${PREFIX}One`).locator('.bg_example')).toHaveCount(2);
            await expect(page.locator('.sb-bg-unfiled__heading')).toHaveText('No Folder');
            await expect(page.locator('.sb-bg-unfiled .bg_example[bgfile^="p13e-"]')).toHaveCount(4);

            await expect(folderRow(page, `${PREFIX}One`)).toMatchAriaSnapshot(`- button "${PREFIX}One 2 backgrounds" [expanded]`);
            await folderRow(page, `${PREFIX}One`).click();
            await expect(section(page, `${PREFIX}One`).locator('.bg_example')).toHaveCount(0);
            await expect(folderRow(page, `${PREFIX}One`)).toMatchAriaSnapshot(`- button "${PREFIX}One 2 backgrounds"`);
            await expect.poll(async () => (await stored(page))?.folders.find(folder => folder.name === `${PREFIX}One`)?.expanded).toBe(false);
            await folderRow(page, `${PREFIX}One`).click();
            await expect(section(page, `${PREFIX}One`).locator('.bg_example')).toHaveCount(2);
            const server = await serverFolders(page);
            expect(Object.keys(server.imageFolderMap).filter(file => file.startsWith(PREFIX)).sort()).toEqual([NAMES[0], NAMES[1]]);
            for (const folder of server.folders.filter(entry => entry.name.startsWith(PREFIX))) expect(Object.keys(folder).sort()).toEqual(['id', 'name', 'thumbnailFile']);
        });

        test('with no folders the gallery is the flat grid, with no heading', async ({ page }) => {
            await seed(page);
            await openGallery(page);
            await expect(page.locator(STUB(NAMES[0]))).toBeVisible();
            await expect(page.locator('#bg_menu_content > .bg_example[bgfile^="p13e-"]')).toHaveCount(NAMES.length);
            await expect(page.locator('.sb-bg-unfiled__heading, #bg_menu_content .sb-folder-row')).toHaveCount(0);
        });

        test('Move to Folder files a background in one folder, from the thumbnail menu', async ({ page }) => {
            const ids = await seed(page, { folders: [`${PREFIX}One`, `${PREFIX}Two`], members: { [`${PREFIX}One`]: [NAMES[0]], [`${PREFIX}Two`]: [NAMES[0]] } });
            await openGallery(page);
            // Upstream data placed this file in both folders, so it shows in both until it is moved.
            await expect(page.locator(`#bg_menu_content .bg_example[bgfile="${NAMES[0]}"]`)).toHaveCount(2);
            const cell = section(page, `${PREFIX}One`).locator(`.bg_example[bgfile="${NAMES[0]}"]`);
            await cell.locator('.sb-bg-cell-menu').focus();
            await page.keyboard.press('Enter');
            await expect(page.getByRole('menuitem', { name: 'Move to Folder', exact: true })).toBeVisible();
            await page.getByRole('menuitem', { name: 'Move to Folder', exact: true }).click();
            await page.getByRole('menuitemradio', { name: `${PREFIX}Two`, exact: true }).click();
            await expect(page.locator(`#bg_menu_content .bg_example[bgfile="${NAMES[0]}"]`)).toHaveCount(1);
            await expect(section(page, `${PREFIX}Two`).locator(`.bg_example[bgfile="${NAMES[0]}"]`)).toHaveCount(1);
            await expect.poll(async () => (await serverFolders(page)).imageFolderMap[NAMES[0]]).toEqual([ids[`${PREFIX}Two`]]);
        });

        test('selection mode moves and deletes the selected backgrounds, and the delete confirmation states the count', async ({ page }) => {
            const ids = await seed(page, { folders: [`${PREFIX}One`], members: { [`${PREFIX}One`]: [NAMES[0]] } });
            await openGallery(page);
            await page.getByRole('button', { name: 'Background', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Select', exact: true }).click();
            await expect(page.locator('#Backgrounds')).toHaveAttribute('data-selection-mode', 'true');
            await page.locator(STUB(NAMES[1])).click();
            await page.locator(STUB(NAMES[2])).click();
            const bar = page.locator('.sb-bg-selection-bar');
            await expect(bar.getByRole('button')).toHaveText(['Move to Folder', 'Delete']);
            await bar.getByRole('button', { name: 'Move to Folder' }).click();
            await page.getByRole('menuitemradio', { name: `${PREFIX}One`, exact: true }).click();
            await expect(page.locator('#Backgrounds')).toHaveAttribute('data-selection-mode', 'false');
            await expect.poll(async () => Object.entries((await serverFolders(page)).imageFolderMap).filter(([, folderIds]) => folderIds.includes(ids[`${PREFIX}One`])).map(([file]) => file).sort())
                .toEqual([NAMES[0], NAMES[1], NAMES[2]]);

            await page.getByRole('button', { name: 'Background', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Select', exact: true }).click();
            await page.locator(STUB(NAMES[3])).click();
            await page.locator(STUB(NAMES[4])).click();
            await page.locator('.sb-bg-selection-bar').getByRole('button', { name: 'Delete' }).click();
            const confirmation = page.locator('.sb-popup-destructive-confirm');
            await expect(confirmation).toContainText('2 backgrounds');
            await confirmation.getByRole('button', { name: 'Cancel' }).click();
            await expect(page.locator(STUB(NAMES[3]))).toBeVisible();
            await page.locator('.sb-bg-selection-bar').getByRole('button', { name: 'Delete' }).click();
            await page.locator('.sb-popup-destructive-confirm').getByRole('button', { name: 'Delete' }).click();
            await expect(page.locator(STUB(NAMES[3]))).toHaveCount(0);
            await expect(page.locator(STUB(NAMES[4]))).toHaveCount(0);
            await expect(page.locator(STUB(NAMES[5]))).toBeVisible();
            const { images } = await page.evaluate(async () => {
                const { getRequestHeaders } = await import('./script.js');
                return (await fetch('/api/backgrounds/all', { method: 'POST', headers: getRequestHeaders(), body: '{}' })).json();
            });
            expect(images.map(image => image.filename).filter(file => file.startsWith(PREFIX)).sort()).toEqual([NAMES[0], NAMES[1], NAMES[2], NAMES[5]]);
        });

        test('a search opens the folders that hold a match and leaves their stored state alone', async ({ page }) => {
            await seed(page, { folders: [`${PREFIX}One`, `${PREFIX}Two`], members: { [`${PREFIX}One`]: [NAMES[0], NAMES[1]], [`${PREFIX}Two`]: [NAMES[2]] } });
            await openGallery(page);
            await folderRow(page, `${PREFIX}One`).click();
            await expect.poll(async () => (await stored(page))?.folders.find(folder => folder.name === `${PREFIX}One`)?.expanded).toBe(false);
            await expect(section(page, `${PREFIX}One`).locator('.bg_example')).toHaveCount(0);
            await page.locator('#bg-filter').fill('bravo');
            await expect(section(page, `${PREFIX}One`).locator('.bg_example')).toHaveCount(1);
            await expect(section(page, `${PREFIX}Two`)).toHaveCount(0);
            expect((await stored(page)).folders.find(folder => folder.name === `${PREFIX}One`).expanded).toBe(false);
            await page.locator('#bg-filter').fill('');
            await expect(section(page, `${PREFIX}One`).locator('.bg_example')).toHaveCount(0);
            await expect(section(page, `${PREFIX}Two`)).toHaveCount(1);
        });

        test('a folder opens and closes with the motion of the other folders: the shared duration and easing, a body that shrinks to nothing, a turning chevron', async ({ page }) => {
            const folderName = `${PREFIX}One`;
            await seed(page, { folders: [folderName], members: { [folderName]: NAMES.slice(0, 4) } });
            await openGallery(page);
            const thumbs = section(page, folderName).locator('.bg_example');
            await expect(thumbs).toHaveCount(4);
            const body = section(page, folderName).locator('.sb-bg-section__body');
            const settled = await body.evaluate(node => node.getBoundingClientRect().height);
            expect(settled).toBeGreaterThan(60);
            const chevronRest = await folderRow(page, folderName).locator('.ds-entity-row__chevron').evaluate(node => getComputedStyle(node).transform);
            expect(chevronRest).toBe('matrix(-1, 0, 0, -1, 0, 0)');

            const closing = await traceFolder(page, folderName, { seekStep: 25 });
            // The first frame already has the running animation, with the duration and easing of every other folder.
            expect(closing[0].animations).toEqual([{ duration: 250, easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)' }]);
            expect(closing[0].expanded).toBe('false');
            const shrinking = closing.filter(frame => !frame.hidden && frame.animations.length);
            const heights = shrinking.map(frame => frame.height);
            expect(heights.filter(height => height > settled * 0.1 && height < settled * 0.9).length).toBeGreaterThanOrEqual(3);
            for (let index = 1; index < heights.length; index++) expect(heights[index]).toBeLessThanOrEqual(heights[index - 1] + 0.5);
            // The body is not held up by its own padding: it passes below 19px (padding and border) before it is hidden, so it never snaps at the end.
            expect(Math.min(...heights)).toBeLessThan(10);
            expect(Math.max(...shrinking.map(frame => frame.opacity))).toBeGreaterThan(0.9);
            expect(Math.min(...shrinking.map(frame => frame.opacity))).toBeLessThan(0.1);
            expect(closing.some(frame => !['matrix(-1, 0, 0, -1, 0, 0)', 'none'].includes(frame.chevron))).toBe(true);
            const closed = closing.at(-1);
            expect(closed).toMatchObject({ hidden: true, thumbs: 0, expanded: 'false', chevron: 'none' });
            await expect(thumbs).toHaveCount(0);
            await expect.poll(async () => (await stored(page))?.folders.find(folder => folder.name === folderName)?.expanded).toBe(false);

            const opening = await traceFolder(page, folderName, { seekStep: 25 });
            expect(opening[0].animations).toEqual([{ duration: 250, easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)' }]);
            expect(opening[0].height).toBeLessThan(1);
            const growing = opening.filter(frame => frame.animations.length).map(frame => frame.height);
            expect(growing.filter(height => height > settled * 0.1 && height < settled * 0.9).length).toBeGreaterThanOrEqual(3);
            for (let index = 1; index < growing.length; index++) expect(growing[index]).toBeGreaterThanOrEqual(growing[index - 1] - 0.5);
            expect(opening.some(frame => !['matrix(-1, 0, 0, -1, 0, 0)', 'none'].includes(frame.chevron))).toBe(true);
            // Late thumbnails fill cells that already have their size, so the settled height is the height the motion aimed at.
            expect(growing.at(-1)).toBeGreaterThan(settled * 0.97);
            const opened = opening.at(-1);
            expect(opened).toMatchObject({ hidden: false, thumbs: 4, expanded: 'true', chevron: 'matrix(-1, 0, 0, -1, 0, 0)' });
            expect(opened.height).toBeCloseTo(settled, 0);
            await expect.poll(async () => (await stored(page))?.folders.find(folder => folder.name === folderName)?.expanded).toBe(true);
        });

        test('an empty folder moves its note the same way, and a second click in the middle of a motion goes on from where the body is', async ({ page }) => {
            const folderName = `${PREFIX}One`;
            const emptyName = `${PREFIX}Empty`;
            await seed(page, { folders: [folderName, emptyName], members: { [folderName]: NAMES.slice(0, 4), [emptyName]: [] } });
            await openGallery(page);
            await expect(section(page, folderName).locator('.bg_example')).toHaveCount(4);
            const settled = await section(page, folderName).locator('.sb-bg-section__body').evaluate(node => node.getBoundingClientRect().height);

            // Closed after 120ms of the opening: the body turns round from its own height, with no jump to the full height or to nothing.
            await traceFolder(page, folderName);
            await expect(section(page, folderName).locator('.sb-bg-section__body')).toBeHidden();
            const turned = await traceFolder(page, folderName, { clickAgainAt: 120, seekStep: 25 });
            const before = turned.findLast(frame => frame.at < 120);
            const after = turned.find(frame => frame.at > 120 && frame.expanded === 'false');
            expect(before.height).toBeGreaterThan(5);
            expect(before.height).toBeLessThan(settled - 5);
            expect(Math.abs(after.height - before.height)).toBeLessThan(settled * 0.35);
            expect(turned.at(-1)).toMatchObject({ hidden: true, thumbs: 0, expanded: 'false' });

            // And the other way round: closing, then opening again in the middle of it.
            const reopened = await traceFolder(page, folderName);
            expect(reopened.at(-1)).toMatchObject({ hidden: false, thumbs: 4, expanded: 'true' });
            const midway = await traceFolder(page, folderName, { clickAgainAt: 120, seekStep: 25 });
            const closingFrame = midway.findLast(frame => frame.at < 120);
            const openingFrame = midway.find(frame => frame.at > 120 && frame.expanded === 'true');
            expect(Math.abs(openingFrame.height - closingFrame.height)).toBeLessThan(settled * 0.35);
            expect(midway.at(-1)).toMatchObject({ hidden: false, thumbs: 4, expanded: 'true' });
            expect(midway.at(-1).height).toBeCloseTo(settled, 0);

            // An empty folder has a note and no thumbnails; the note opens and closes over the same motion.
            const emptyBody = section(page, emptyName).locator('.sb-bg-section__body');
            for (let click = 0; click < 2; click++) {
                const wasOpen = await emptyBody.evaluate(node => !node.hidden);
                const emptyTrace = await traceFolder(page, emptyName);
                expect(emptyTrace[0].animations).toEqual([{ duration: 250, easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)' }]);
                expect(emptyTrace.at(-1).hidden).toBe(wasOpen);
                expect(await emptyBody.locator('.sb-bg-section__empty').count()).toBe(wasOpen ? 0 : 1);
            }
        });

        test('reduced motion opens and closes a folder with no animation', async ({ page }) => {
            const folderName = `${PREFIX}One`;
            await seed(page, { folders: [folderName], members: { [folderName]: NAMES.slice(0, 3) } });
            await openGallery(page);
            await expect(section(page, folderName).locator('.bg_example')).toHaveCount(3);
            await page.emulateMedia({ reducedMotion: 'reduce' });
            const closing = await traceFolder(page, folderName, { duration: 100 });
            expect(closing.every(frame => frame.animations.length === 0)).toBe(true);
            expect(closing[0]).toMatchObject({ hidden: true, thumbs: 0, expanded: 'false' });
            const opening = await traceFolder(page, folderName, { duration: 100 });
            expect(opening.every(frame => frame.animations.length === 0)).toBe(true);
            expect(opening[0]).toMatchObject({ hidden: false, thumbs: 3, expanded: 'true' });
        });

        test('the Chat tab keeps its behaviour and has no folders', async ({ page }) => {
            await seed(page, { folders: [`${PREFIX}One`], members: { [`${PREFIX}One`]: [NAMES[0]] } });
            await openGallery(page);
            await expect(page.getByRole('button', { name: 'Background', exact: true })).toBeVisible();
            await page.locator('#bg_tabs a[href="#bg_chat_tab"]').click();
            await expect(page.locator('#bg_chat_tab')).toBeVisible();
            await expect(page.locator('#bg_chat_tab .sb-bg-section, #bg_chat_tab .sb-folder-row')).toHaveCount(0);
            await expect(page.getByRole('button', { name: 'Background', exact: true })).toBeHidden();
            await page.locator('#bg_tabs a[href="#bg_global_tab"]').click();
            await expect(folderRow(page, `${PREFIX}One`)).toBeVisible();
        });

        test('the Folder Manager creates a folder with the id the server issues, and Remove takes a file out of that folder only', async ({ page }) => {
            const ids = await seed(page, { folders: [`${PREFIX}One`, `${PREFIX}Two`], members: { [`${PREFIX}One`]: [NAMES[0]], [`${PREFIX}Two`]: [NAMES[0]] } });
            await openGallery(page);
            await page.getByRole('button', { name: 'Background', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Manage Folders', exact: true }).click();
            const manager = page.locator('.sb-dialog-host[open]:has(> .sb-folder-manager)');
            await expect(manager).toBeVisible();
            await manager.locator('.sb-dialog__header-end').getByRole('button', { name: 'New Folder', exact: true }).click();
            const input = page.locator('.sb-custom-popover:visible, .sb-action-sheet:visible').getByRole('textbox', { name: 'New Folder', exact: true });
            await input.fill(`${PREFIX}Three`);
            await input.press('Enter');
            const server = (await serverFolders(page)).folders.find(folder => folder.name === `${PREFIX}Three`);
            expect(server).toBeTruthy();
            await expect(manager.locator(`[data-folder-id="${server.id}"]`)).toBeVisible();
            await manager.locator(`[data-folder-id="${ids[`${PREFIX}One`]}"] .ds-entity-row__chevron`).click();
            await manager.locator('.sb-folder-manager__remove').click();
            await expect.poll(async () => (await serverFolders(page)).imageFolderMap[NAMES[0]]).toEqual([ids[`${PREFIX}Two`]]);
        });

        test('the gallery with folders, open and in selection mode, has no WCAG A or AA violation', async ({ page }) => {
            await seed(page, { folders: [`${PREFIX}One`, `${PREFIX}Empty`], members: { [`${PREFIX}One`]: [NAMES[0], NAMES[1]], [`${PREFIX}Empty`]: [] } });
            await openGallery(page);
            await expect(folderRow(page, `${PREFIX}One`)).toBeVisible();
            const found = result => result.violations.map(violation => `${violation.id}: ${violation.nodes.map(node => node.target).join(' | ')}`);
            const open = await scanStable(page, '#bg_menu_content');
            expect(found(open)).toEqual([]);
            await page.getByRole('button', { name: 'Background', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Select', exact: true }).click();
            await page.locator(STUB(NAMES[0])).first().click();
            const selecting = await scanStable(page, '#bg_menu_content');
            expect(found(selecting)).toEqual([]);
        });

        test('the keyboard opens a background\'s menu from a focused thumbnail', async ({ page }) => {
            await seed(page);
            await openGallery(page);
            const cell = page.locator(STUB(NAMES[0]));
            await cell.focus();
            await page.keyboard.press('Shift+F10');
            await expect(page.getByRole('menuitem', { name: 'Set as Background', exact: true })).toBeVisible();
            await expect(page.locator('#Backgrounds')).toHaveAttribute('data-selection-mode', 'false');
            await page.keyboard.press('Escape');
            await expect(page.getByRole('menuitem', { name: 'Set as Background', exact: true })).toBeHidden();
            await cell.focus();
            await page.keyboard.press('ContextMenu');
            await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible();
            await expect(page.locator('#Backgrounds')).toHaveAttribute('data-selection-mode', 'false');
        });
    });
}

test.describe('Background thumbnails on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('no button covers the title, a tap sets the background and a long press opens the menu', async ({ page }) => {
        await seed(page);
        await openGallery(page);
        const cell = page.locator(STUB(NAMES[1]));
        await expect(cell).toBeVisible();
        const button = cell.locator('.sb-bg-cell-menu');
        await expect(button).toHaveCSS('opacity', '0');
        await expect(button).toHaveCSS('pointer-events', 'none');

        await cell.tap();
        await expect.poll(() => currentBackground(page)).toBe(NAMES[1]);

        const other = page.locator(STUB(NAMES[2]));
        await other.evaluate(async node => {
            const rect = node.getBoundingClientRect();
            const init = { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: rect.x + 20, clientY: rect.y + 20, bubbles: true, cancelable: true, composed: true };
            node.dispatchEvent(new PointerEvent('pointerdown', init));
            await new Promise(resolve => setTimeout(resolve, 700));
            node.dispatchEvent(new PointerEvent('pointerup', init));
            node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: init.clientX, clientY: init.clientY }));
        });
        await expect(page.getByRole('menuitem', { name: 'Set as Background', exact: true })).toBeVisible();
        expect(await currentBackground(page)).toBe(NAMES[1]);
        await expect(page.locator('#Backgrounds')).toHaveAttribute('data-selection-mode', 'false');
        await page.getByRole('menuitem', { name: 'Set as Background', exact: true }).click();
        await expect.poll(() => currentBackground(page)).toBe(NAMES[2]);
    });

    test('the menu button shows when a thumbnail has keyboard focus', async ({ page }) => {
        await seed(page);
        await openGallery(page);
        const button = page.locator(STUB(NAMES[0])).locator('.sb-bg-cell-menu');
        await button.focus();
        await expect(button).toHaveCSS('opacity', '1');
    });
});
