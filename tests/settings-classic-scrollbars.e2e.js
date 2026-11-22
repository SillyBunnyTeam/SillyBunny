import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import {
    PREFERENCE_PAGES, boot, openCharactersTab, openHosted, preferenceContent, readPage, readPreferencePage, readWidePages,
} from './helpers/settings-page-frames.js';

// A classic scrollbar (Windows, Linux, or macOS with scrollbars always shown) takes room from the box that scrolls. The page
// padding is a percentage of the container of that box, which has no scrollbar, so a column that is centred by padding would
// sit half a scrollbar off the centre of the pane. Playwright hides the scrollbars of headless Chromium, so this spec starts
// it with them.
test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' }, launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });
test.describe.configure({ timeout: 120_000 });
test.beforeEach(async ({ page }) => { await protectMaintainerServer(page); });

for (const [width, height] of [[1440, 900], [3440, 1440]]) {
    test(`a column is centred in its pane within 1px, and loses no more than the scrollbar, at ${width}px`, async ({ page }) => {
        await boot(page, { width, height });
        const reads = {};
        for (const entry of [PREFERENCE_PAGES[0], PREFERENCE_PAGES[5]]) reads[entry.id] = await readPreferencePage(page, entry);
        const extensions = await openHosted(page, 'right', 'extensions');
        await expect.poll(() => extensions.locator('.sb-subpage-row').count()).toBeGreaterThan(0);
        reads.extensions = await readPage(page, { panel: '[data-sb-panel="extensions"]', scroller: '[data-sb-panel="extensions"] .sb-subpage-list' });
        await openCharactersTab(page, 'import');
        await expect(page.locator('#sb_character_import_content')).toBeVisible();
        await expect.poll(async () => (await readPage(page, { panel: '#sb_character_import_content', scroller: '#sb_character_import_panel' })).error ?? '').toBe('');
        reads.import = await readPage(page, { panel: '#sb_character_import_content', scroller: '#sb_character_import_panel' });
        const frames = await readWidePages(page);

        // A classic scrollbar is what this spec is about: an overlay one would make every read pass for the wrong reason.
        const scrollbar = reads.interface.scrollbar;
        expect(scrollbar, 'the gutter of the Interface page takes room').toBeGreaterThan(8);

        const problems = Object.entries({ ...reads, ...frames }).flatMap(([name, read]) => [
            [read.error !== undefined, `${read.error}`],
            [Math.abs(read.centre) > 1, `its centre is ${read.centre}px from the centre of the pane`],
        ].filter(([failed]) => failed).map(([, text]) => `${name}: ${text}`));
        // The gutter is kept on both edges, so the scroller is short by two scrollbars and the column gives up that room and no more.
        const lost = preferenceContent(width) - reads.interface.width;
        expect(lost, `the Interface column is ${lost}px narrower than AdwClamp, with ${scrollbar}px of gutter`).toBeLessThanOrEqual(scrollbar + 1);
        expect(problems).toEqual([]);
    });
}
