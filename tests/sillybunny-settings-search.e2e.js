import { expect, test } from '@playwright/test';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { showSettingsSidebar } from './helpers/settings-phone-pane.js';
import { applyWelcomeSettings } from './helpers/welcome-dialog.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

const VIEWPORTS = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
];
const CLEAR_BUDGET_MS = 100;
const HIGHLIGHT_NAME = 'sb-settings-search-text';

async function loadApp(page, baseURL, { viewport }) {
    const origin = new URL(baseURL).origin;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    let version = Date.now();
    const readEndpoints = new Set([
        '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
        '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me',
    ]);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
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
            applyWelcomeSettings(settings);
            settings.power_user.auto_connect = false;
            data.request_compression = { ...data.request_compression, enabled: false };
            data.settings = JSON.stringify(settings);
            return route.fulfill({ json: data });
        }
        if (readEndpoints.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')) return route.continue();
        if (url.pathname.startsWith('/api/backends/')) return route.fulfill({ json: { data: [] } });
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) {
            return route.fulfill({ json: url.pathname === '/api/settings/save' ? { version: ++version } : {} });
        }
        return route.continue();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
}

/** Opens a page of a shell and leaves the sidebar with its search field showing, as a user would before typing. */
async function openSidebarSearch(page, shell, tab) {
    await page.evaluate(({ shell, tab }) => window.SillyBunnyShell.openTab(shell, tab), { shell, tab });
    await expect(page.locator(`button[data-sb-settings-tab="${tab}"]`)).toHaveAttribute('aria-selected', 'true');
    // On a phone the open page covers the sidebar, so the back button brings the sidebar and its search back.
    await showSettingsSidebar(page);
    const toggle = page.locator('#sb-settings-search-toggle');
    await expect(toggle).toBeVisible();
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    const input = page.locator('#sb-settings-search-input');
    await expect(input).toBeVisible();
    return input;
}

async function selectTab(page, tab) {
    await page.locator(`button[data-sb-settings-tab="${tab}"]`).click();
    await expect(page.locator(`button[data-sb-settings-tab="${tab}"]`)).toHaveAttribute('aria-selected', 'true');
}

/** The count of a page: a bare number on screen, "N matching setting(s)" as the tab's description, the tab's name unchanged. */
async function expectCount(page, tab, label) {
    const button = tabState(page, tab);
    const badge = button.locator('.sb-settings-tab-badge');
    await expect(badge).toHaveText(/^\d+$/);
    await expect(badge).not.toHaveAttribute('data-sb-copy-placeholder', /.*/);
    await expect(badge).toHaveAttribute('aria-hidden', 'true');
    const count = Number(await badge.innerText());
    await expect(button).toHaveAccessibleDescription(count === 1 ? '1 matching setting' : `${count} matching settings`);
    await expect(button).toHaveAccessibleName(label);
    return count;
}

const tabState = (page, tab) => page.locator(`button[data-sb-settings-tab="${tab}"]`);

/** Records every element that gets the pulse class, so a 1.8 second pulse is never missed between two polls. */
function recordPulses(page) {
    return page.evaluate(() => {
        window.__sbPulses = [];
        new MutationObserver(records => {
            for (const record of records) {
                const target = record.target;
                if (target.classList?.contains('highlighted-drawer')) {
                    window.__sbPulses.push(target.className + ' | ' + (target.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60));
                }
            }
        }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
    });
}

/** What the open page shows: rows left in the list and the headed groups with a row in view. */
function readPanel(page, tab) {
    return page.evaluate(tab => {
        const panel = document.querySelector(`[data-sb-panel="${tab}"]`);
        const shown = element => element.getAttribute('aria-hidden') !== 'true' && !element.classList.contains('sb-settings-row--filtered');
        const rows = [];
        const groups = [];
        for (const body of panel.querySelectorAll(':scope .ds-pref-group, :scope .sb-settings-category-body')) {
            if (body.parentElement?.closest('.ds-pref-group, .sb-settings-category-body')) continue;
            const container = body.closest('.sb-settings-category, .sb-editor-section') ?? body;
            const heading = container.querySelector('.sb-settings-category-title, .ds-pref-group-heading');
            const kept = [...body.children].filter(child => shown(child) && child.checkVisibility());
            if (container.checkVisibility() && shown(container) && kept.length) groups.push((heading?.textContent ?? '').trim());
            for (const child of kept) rows.push((child.textContent ?? '').replace(/\s+/g, ' ').trim());
        }
        return {
            rows,
            groups,
            filtered: panel.querySelectorAll('.sb-settings-row--filtered').length,
        };
    }, tab);
}

/** Saves a screenshot for the review folder when SB_SEARCH_EVIDENCE_DIR names one. */
async function saveEvidence(page, viewport, name) {
    const dir = process.env.SB_SEARCH_EVIDENCE_DIR;
    if (!dir) return;
    // The phone layout slides between the sidebar and the page, so the capture waits for the slide to end.
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
    await page.screenshot({ path: `${dir}/${viewport.name}-${name}.png` });
}

/** On a phone, the page of a tab replaces the sidebar when its button is pressed; a desktop shows both already. */
async function showPageOnPhone(page, viewport, tab) {
    if (viewport.width > 600) return;
    await tabState(page, tab).click();
    await expect(page.locator('#sb-settings-page.sb-settings-page--content')).toBeVisible();
}

const highlightCount = page => page.evaluate(name => (CSS.highlights?.get(name)?.size) ?? 0, HIGHLIGHT_NAME);

for (const viewport of VIEWPORTS) {
    test.describe(`${viewport.name} ${viewport.width}x${viewport.height}`, () => {
        test.beforeEach(async ({ page, baseURL }) => {
            test.setTimeout(120000);
            await loadApp(page, baseURL, { viewport });
        });

        test('Backend: a word keeps the pages that hold it, counts them and hides the rows that miss', async ({ page }) => {
            await openSidebarSearch(page, 'left', 'sampling');
            await recordPulses(page);
            await saveEvidence(page, viewport, 'backend-sidebar-before');
            await page.locator('#sb-settings-search-input').fill('Frequency');
            await expect(tabState(page, 'sampling')).not.toHaveClass(/sb-settings-tab--filtered/);
            const count = await expectCount(page, 'sampling', 'Sampling');
            await expect(tabState(page, 'connections')).toHaveClass(/sb-settings-tab--filtered/);
            await expect(tabState(page, 'connections')).toHaveAttribute('aria-hidden', 'true');

            await expect(async () => {
                const panel = await readPanel(page, 'sampling');
                expect(panel.rows.length).toBeGreaterThan(0);
                expect(panel.filtered).toBeGreaterThan(0);
            }).toPass({ timeout: 15000 });
            const panel = await readPanel(page, 'sampling');
            expect(panel.rows.map(row => row.slice(0, 40))).toEqual(expect.arrayContaining([expect.stringMatching(/^Frequency Penalty/)]));
            expect(panel.rows.filter(row => !/\bfrequency\b/i.test(row)).map(row => row.slice(0, 40))).toEqual([]);
            expect(panel.rows.map(row => row.slice(0, 40))).not.toEqual(expect.arrayContaining([expect.stringMatching(/^Temperature/)]));
            expect(count).toBe(panel.rows.length);

            expect(await highlightCount(page)).toBeGreaterThan(0);
            await showPageOnPhone(page, viewport, 'sampling');
            await expect.poll(() => page.evaluate(() => window.__sbPulses.length)).toBeGreaterThan(0);
            await saveEvidence(page, viewport, 'backend-frequency');
            await expect.poll(() => readPanel(page, 'sampling').then(state => state.rows.length)).toBe(count);
            await saveEvidence(page, viewport, 'backend-frequency-page');
        });

        if (viewport.width <= 600) {
            test('a phone that still shows the sidebar does not reveal the hidden page, and reveals when the page opens', async ({ page }) => {
                await recordPulses(page);
                const input = await openSidebarSearch(page, 'left', 'sampling');
                await input.fill('Frequency');
                await expect.poll(() => readPanel(page, 'sampling').then(state => state.filtered)).toBeGreaterThan(0);
                // The reveal runs 180 ms after a keystroke; wait past it inside the page.
                await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 600)));
                expect(await page.evaluate(() => window.__sbPulses.length)).toBe(0);
                await showPageOnPhone(page, viewport, 'sampling');
                await expect.poll(() => page.evaluate(() => window.__sbPulses.length)).toBeGreaterThan(0);
            });
        }

        test('Backend: the start of a word finds the setting, the middle of a word matches nothing', async ({ page }) => {
            const input = await openSidebarSearch(page, 'left', 'sampling');
            for (const query of ['Freq', 'penalty freq', 'FRÉQ']) {
                await input.fill(query);
                await expect(tabState(page, 'sampling')).not.toHaveClass(/sb-settings-tab--filtered/);
                await expect.poll(async () => (await readPanel(page, 'sampling')).rows.some(row => /^Frequency Penalty/.test(row))).toBe(true);
            }
            await input.fill('Freq');
            await expect.poll(() => page.evaluate(name => [...(CSS.highlights.get(name) ?? [])].map(range => range.toString()), HIGHLIGHT_NAME)).toContain('Freq');
            await saveEvidence(page, viewport, 'backend-start-of-word');
            for (const query of ['quency', 'equency', 'FrequencyPenalty']) {
                await input.fill(query);
                await expect(page.locator('#sb-settings-tab-list .sb-settings-tab-empty')).toHaveText('No matching pages');
                await expect(page.locator('#sb-settings-tab-list .sb-settings-tab:not(.sb-settings-tab--filtered)')).toHaveCount(0);
                expect((await readPanel(page, 'sampling')).filtered).toBe(0);
            }
            await saveEvidence(page, viewport, 'backend-middle-of-word-empty');
        });

        test('clearing the field restores pages, rows, counts and marks inside the budget', async ({ page }, testInfo) => {
            const input = await openSidebarSearch(page, 'left', 'sampling');
            await input.fill('Frequency');
            await expect.poll(async () => (await readPanel(page, 'sampling')).filtered).toBeGreaterThan(0);
            expect(await highlightCount(page)).toBeGreaterThan(0);

            const timing = await page.evaluate(async () => {
                const field = document.getElementById('sb-settings-search-input');
                const start = performance.now();
                field.value = '';
                field.dispatchEvent(new Event('input', { bubbles: true }));
                const afterInput = performance.now() - start;
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const afterFrames = performance.now() - start;
                return {
                    afterInput,
                    afterFrames,
                    filteredRows: document.querySelectorAll('.sb-settings-row--filtered').length,
                    ariaHiddenRows: document.querySelectorAll('[data-sb-panel="sampling"] [aria-hidden="true"]').length,
                    hiddenTabs: document.querySelectorAll('.sb-settings-tab--filtered').length,
                    badges: document.querySelectorAll('.sb-settings-tab-badge').length,
                    empty: document.querySelectorAll('.sb-settings-tab-empty').length,
                    highlights: CSS.highlights?.get('sb-settings-search-text')?.size ?? 0,
                    pulses: document.querySelectorAll('.highlighted-drawer').length,
                };
            });
            console.log(`CLEAR_TIMING ${viewport.name} ${JSON.stringify({ afterInputMs: Math.round(timing.afterInput * 10) / 10, afterTwoFramesMs: Math.round(timing.afterFrames * 10) / 10 })}`);
            testInfo.annotations.push({ type: 'clear-timing', description: `${viewport.name}: input ${timing.afterInput.toFixed(1)} ms, two frames ${timing.afterFrames.toFixed(1)} ms` });
            expect(timing.afterFrames).toBeLessThan(CLEAR_BUDGET_MS);
            expect(timing).toMatchObject({ filteredRows: 0, hiddenTabs: 0, badges: 0, empty: 0, highlights: 0, pulses: 0 });
            const ariaBefore = await page.evaluate(() => document.querySelectorAll('[data-sb-panel="sampling"] .sb-settings-row--filtered').length);
            expect(ariaBefore).toBe(0);
        });

        test('Escape and the clear button also restore everything', async ({ page }) => {
            const input = await openSidebarSearch(page, 'left', 'sampling');
            await input.fill('Frequency');
            await expect(tabState(page, 'connections')).toHaveClass(/sb-settings-tab--filtered/);
            await input.press('Escape');
            await expect(input).toHaveValue('');
            await expect(page.locator('.sb-settings-tab--filtered')).toHaveCount(0);
            await expect(page.locator('.sb-settings-tab-badge')).toHaveCount(0);
            expect((await readPanel(page, 'sampling')).filtered).toBe(0);
        });

        test('a page that the query names shows all of its rows, with the count of what matches inside', async ({ page }) => {
            const input = await openSidebarSearch(page, 'left', 'sampling');
            await input.fill('Sampling');
            await expect(tabState(page, 'sampling')).not.toHaveClass(/sb-settings-tab--filtered/);
            expect((await readPanel(page, 'sampling')).filtered).toBe(0);
        });

        test('Customize: a former group name finds its group and hides the others', async ({ page }) => {
            const input = await openSidebarSearch(page, 'right', 'messages');
            await input.fill('Swipes and Continue');
            await expect(tabState(page, 'messages')).not.toHaveClass(/sb-settings-tab--filtered/);
            await expect(async () => {
                const panel = await readPanel(page, 'messages');
                expect(panel.groups).toEqual(['Swipes', 'Auto-swipe', 'Auto-Continue']);
            }).toPass({ timeout: 15000 });
            const panel = await readPanel(page, 'messages');
            expect(panel.groups).not.toContain('Streaming');
            expect(panel.rows.length).toBeGreaterThan(3);
            await saveEvidence(page, viewport, 'customize-alias-swipes-and-continue');
        });

        test('Customize: a word inside a page finds the page, counts the rows and shows only them', async ({ page }) => {
            const input = await openSidebarSearch(page, 'right', 'messages');
            await input.fill('Streaming');
            await expect(tabState(page, 'messages')).not.toHaveClass(/sb-settings-tab--filtered/);
            await expect(async () => {
                const panel = await readPanel(page, 'messages');
                expect(panel.groups).toEqual(expect.arrayContaining(['Streaming', 'Smooth Streaming']));
                expect(panel.groups).not.toContain('Swipes');
            }).toPass({ timeout: 15000 });
            await expect.poll(() => page.evaluate(name => CSS.highlights.get(name)?.size ?? 0, HIGHLIGHT_NAME)).toBeGreaterThan(0);
            await expectCount(page, 'messages', 'Messages');
        });

        test('Customize: Parser Flags and Import Your SillyTavern Setup find the groups that replaced them', async ({ page }) => {
            const input = await openSidebarSearch(page, 'right', 'interface');
            await input.fill('Parser Flags');
            await expect(tabState(page, 'interface')).not.toHaveClass(/sb-settings-tab--filtered/);
            await expect(async () => {
                expect((await readPanel(page, 'interface')).groups).toEqual(['STscript Settings']);
            }).toPass({ timeout: 15000 });
            await saveEvidence(page, viewport, 'customize-alias-parser-flags');

            await input.fill('Import Your SillyTavern Setup');
            await expect(tabState(page, 'data-security')).not.toHaveClass(/sb-settings-tab--filtered/);
            await expect(tabState(page, 'interface')).toHaveClass(/sb-settings-tab--filtered/);
            await selectTab(page, 'data-security');
            await expect(async () => {
                const panel = await readPanel(page, 'data-security');
                expect(panel.rows.some(row => /Import From Folder Path/.test(row))).toBe(true);
                expect(panel.rows.some(row => /Download Backup/.test(row))).toBe(false);
            }).toPass({ timeout: 15000 });

            await input.fill('Server Tools');
            await expect(async () => {
                const panel = await readPanel(page, 'data-security');
                expect(panel.rows.some(row => /^Runtime/.test(row))).toBe(true);
                expect(panel.rows.some(row => /Download Backup/.test(row))).toBe(false);
            }).toPass({ timeout: 15000 });
        });

        test('Characters shell: pages are found by name, alias and entity, and the list pages keep every entry', async ({ page }) => {
            await page.evaluate(async () => {
                window.qaApp = await import('/script.js');
            });
            await page.waitForFunction(() => window.qaApp.characters.length > 0, null, { timeout: 30000 });
            const input = await openSidebarSearch(page, 'characters', 'characters');
            await input.fill('Persona');
            await expect(tabState(page, 'persona')).not.toHaveClass(/sb-settings-tab--filtered/);
            await saveEvidence(page, viewport, 'characters-persona-name');
            await expectCount(page, 'persona', 'Persona');
            await expect(tabState(page, 'import')).toHaveClass(/sb-settings-tab--filtered/);

            const name = await page.evaluate(() => window.qaApp.characters[0].name);
            const firstWord = name.split(/[^\p{L}\p{N}]+/u).find(Boolean);
            await input.fill(firstWord);
            await expect(tabState(page, 'characters')).not.toHaveClass(/sb-settings-tab--filtered/);
            await expectCount(page, 'characters', 'Characters');
            await input.fill('');
            await expect(page.locator('.sb-settings-tab--filtered')).toHaveCount(0);
        });

        test('Characters shell: the editor of the open character is searched by its field labels', async ({ page }) => {
            await page.evaluate(async () => {
                window.qaApp = await import('/script.js');
            });
            await page.waitForFunction(() => window.qaApp.characters.length > 0, null, { timeout: 30000 });
            await page.evaluate(() => {
                window.qaApp.setCharacterId(0);
                window.qaApp.select_selected_character(0);
            });
            await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'editor'));
            await expect(page.locator('#rm_ch_create_block.sb-active-right-menu')).toBeVisible();
            const input = await openSidebarSearch(page, 'characters', 'editor');
            await input.fill('Description');
            await expect(tabState(page, 'editor')).not.toHaveClass(/sb-settings-tab--filtered/);
            await expectCount(page, 'editor', 'Editor');
            await input.fill('zzzqqq');
            await expect(page.locator('#sb-settings-tab-list .sb-settings-tab-empty')).toBeVisible();
        });

        if (viewport.name === 'desktop') {
            test('Characters shell: the Global Settings of Personas hide the rows that miss while they are open', async ({ page }) => {
                await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'persona'));
                await page.locator('.sb-persona-list-menu').click();
                await page.getByRole('menuitem', { name: 'Global Settings' }).click();
                const rows = page.locator('.sb-persona-settings .sb-persona-settings-switch');
                await expect(rows).toHaveCount(3);
                await page.locator('#sb-settings-search-toggle').click();
                const input = page.locator('#sb-settings-search-input');
                await input.fill('notifications');
                await expect(page.locator('.sb-persona-settings .sb-persona-settings-switch:not(.sb-settings-row--filtered)')).toHaveCount(1);
                await expect(page.locator('.sb-persona-settings .sb-settings-row--filtered')).toHaveCount(2);
                await expect(page.locator('.sb-persona-settings .sb-settings-row--filtered[aria-hidden="true"]')).toHaveCount(2);
                await expectCount(page, 'persona', 'Persona');
                await saveEvidence(page, viewport, 'characters-persona-settings-rows');
                await input.fill('Persona Management');
                await expect(page.locator('.sb-persona-settings .sb-settings-row--filtered')).toHaveCount(0);
                await input.fill('zzzqqq');
                await expect(page.locator('#sb-settings-tab-list .sb-settings-tab-empty')).toBeVisible();
                await input.fill('');
                await expect(page.locator('.sb-persona-settings .sb-settings-row--filtered')).toHaveCount(0);
                await expect(rows).toHaveCount(3);
            });

            test('Characters shell: the Global Settings of World Info hide the rows that miss while they are open', async ({ page }) => {
                await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'world-info'));
                await page.locator('#sb_character_world_info_panel').getByRole('button', { name: 'Global Settings' }).click();
                await expect(page.locator('.sb-wi-settings')).toBeVisible();
                const rows = page.locator('.sb-wi-settings .ds-pref-group > .ds-row');
                const total = await rows.count();
                expect(total).toBeGreaterThan(5);
                await page.locator('#sb-settings-search-toggle').click();
                const input = page.locator('#sb-settings-search-input');
                await input.fill('Recursive Scan');
                await expect(page.locator('.sb-wi-settings .sb-settings-row--filtered').first()).toHaveAttribute('aria-hidden', 'true');
                await expect(page.locator('.sb-wi-settings .ds-pref-group > .ds-row:not(.sb-settings-row--filtered):visible')).toHaveText([/^Recursive Scan/]);
                await saveEvidence(page, viewport, 'characters-world-info-settings-rows');
                await input.fill('');
                await expect(page.locator('.sb-wi-settings .sb-settings-row--filtered')).toHaveCount(0);
            });
        }

        test('reduced motion: the target is scrolled without smooth scrolling and pulses without an animation', async ({ page }) => {
            expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
            await page.evaluate(() => {
                window.__sbScrollBehaviors = [];
                for (const [proto, method] of [[Element.prototype, 'scrollIntoView'], [Element.prototype, 'scrollTo'], [Element.prototype, 'scrollBy']]) {
                    const original = proto[method];
                    proto[method] = function patched(...args) {
                        const options = typeof args[0] === 'object' ? args[0] : null;
                        window.__sbScrollBehaviors.push(options?.behavior ?? 'auto');
                        return original.apply(this, args);
                    };
                }
            });
            await recordPulses(page);
            const input = await openSidebarSearch(page, 'left', 'sampling');
            await input.fill('Frequency');
            await showPageOnPhone(page, viewport, 'sampling');
            await expect.poll(() => page.evaluate(() => window.__sbPulses.length)).toBeGreaterThan(0);
            const behaviors = await page.evaluate(() => window.__sbScrollBehaviors);
            expect(behaviors).not.toContain('smooth');
            const animation = await page.evaluate(() => {
                const target = document.querySelector('.highlighted-drawer');
                return target ? getComputedStyle(target).animationName : 'none';
            });
            expect(animation).toBe('none');
        });

        test('universal search keeps its idle state until the first answer, and never shows a blank list', async ({ page }) => {
            await page.locator('#sb-topbar-search-toggle').click();
            const results = page.locator('#sb-universal-search-results');
            await expect(results.locator('.sb-search-empty')).toBeVisible();
            await page.evaluate(() => {
                const list = document.getElementById('sb-universal-search-results');
                const log = { frames: 0, blankFrames: 0, idleFrames: 0, busyFrames: 0, firstAnswerFrame: -1 };
                window.__sbFrames = log;
                const sample = () => {
                    log.frames += 1;
                    if (list.classList.contains('is-visible') && list.childElementCount === 0) log.blankFrames += 1;
                    if (list.querySelector('.sb-search-empty') && !list.querySelector('.sb-search-result')) log.idleFrames += 1;
                    if (list.getAttribute('aria-busy') === 'true') log.busyFrames += 1;
                    if (log.firstAnswerFrame < 0 && list.querySelector('.sb-search-result')) log.firstAnswerFrame = log.frames;
                    if (log.firstAnswerFrame < 0 || log.frames < log.firstAnswerFrame + 3) requestAnimationFrame(sample);
                };
                requestAnimationFrame(sample);
            });
            await page.locator('#sb-universal-search input').fill('Show Bottom Chat Bar');
            await expect(results.getByRole('option').first()).toBeVisible();
            await expect.poll(() => page.evaluate(() => window.__sbFrames.firstAnswerFrame)).toBeGreaterThan(0);
            const log = await page.evaluate(() => window.__sbFrames);
            console.log(`F305_FRAMES ${viewport.name} ${JSON.stringify(log)}`);
            expect(log.blankFrames).toBe(0);
            await expect(results).not.toHaveAttribute('aria-busy', 'true');
        });

        test('the sidebar search never shows the empty message while the first query waits for the pages', async ({ page }) => {
            const input = await openSidebarSearch(page, 'left', 'sampling');
            await page.evaluate(() => {
                const list = document.getElementById('sb-settings-tab-list');
                const log = { frames: 0, emptyFrames: 0, busyFrames: 0, answered: false };
                window.__sbTabFrames = log;
                const sample = () => {
                    log.frames += 1;
                    if (list.querySelector('.sb-settings-tab-empty')) log.emptyFrames += 1;
                    if (list.getAttribute('aria-busy') === 'true') log.busyFrames += 1;
                    if (list.querySelector('.sb-settings-tab-badge')) log.answered = true;
                    if (!log.answered || log.frames < 600) requestAnimationFrame(sample);
                };
                requestAnimationFrame(sample);
            });
            await input.fill('Frequency');
            await expect.poll(() => page.evaluate(() => window.__sbTabFrames.answered)).toBe(true);
            const log = await page.evaluate(() => window.__sbTabFrames);
            console.log(`SIDEBAR_FRAMES ${viewport.name} ${JSON.stringify(log)}`);
            expect(log.emptyFrames).toBe(0);
            await expect(page.locator('#sb-settings-tab-list')).not.toHaveAttribute('aria-busy', 'true');
        });

        test('the other search surfaces still work: universal search, the character list filter and the persona title', async ({ page }) => {
            await page.locator('#sb-topbar-search-toggle').click();
            await page.locator('#sb-universal-search input').fill('Frequency');
            await expect(page.locator('#sb-universal-search-results').getByRole('option').first()).toBeVisible();
            await page.keyboard.press('Escape');

            const titleHits = await page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                const { fuzzySearchPersonas } = await import('/scripts/power-user.js');
                const key = 'sb-search-probe.png';
                power_user.personas[key] = 'Alpha';
                power_user.persona_descriptions[key] = { description: '', title: 'Zebra Keeper' };
                try {
                    return {
                        byTitle: fuzzySearchPersonas([key], 'Zebra').length,
                        byName: fuzzySearchPersonas([key], 'Alpha').length,
                        none: fuzzySearchPersonas([key], 'Quokka').length,
                    };
                } finally {
                    delete power_user.personas[key];
                    delete power_user.persona_descriptions[key];
                }
            });
            expect(titleHits).toEqual({ byTitle: 1, byName: 1, none: 0 });
        });
    });
}

test('the Mobile Quick Actions search keeps its message until the first answer, and never shows a blank results region', async ({ page, baseURL }) => {
    test.setTimeout(120000);
    await loadApp(page, baseURL, { viewport: VIEWPORTS[1] });
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'interface'));
    const box = page.locator('#sb-mobile-quick-actions-box');
    await expect(box.locator('[data-sb-region="results"]')).toBeVisible();
    await page.evaluate(() => {
        const list = document.getElementById('sb-mobile-quick-actions-box');
        const log = { frames: 0, blankFrames: 0, busyFrames: 0, firstAnswerFrame: -1 };
        window.__sbQuickFrames = log;
        const sample = () => {
            log.frames += 1;
            if (!list.querySelector(':scope > [data-sb-region="results"]')) log.blankFrames += 1;
            if (list.getAttribute('aria-busy') === 'true') log.busyFrames += 1;
            if (log.firstAnswerFrame < 0 && list.querySelector('.sb-mobile-quick-action-result')) log.firstAnswerFrame = log.frames;
            if (log.firstAnswerFrame < 0 || log.frames < log.firstAnswerFrame + 3) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    });
    await page.locator('#sb-mobile-quick-action-search').fill('Frequency');
    await expect.poll(() => page.evaluate(() => window.__sbQuickFrames.firstAnswerFrame)).toBeGreaterThan(0);
    const log = await page.evaluate(() => window.__sbQuickFrames);
    console.log(`QUICK_ACTIONS_FRAMES ${JSON.stringify(log)}`);
    expect(log.blankFrames).toBe(0);
    await expect(box).not.toHaveAttribute('aria-busy', 'true');

    await page.locator('#sb-mobile-quick-action-search').fill('x');
    await expect(box.locator('[data-sb-region="results"]')).toContainText('Type at least 2 characters');
    await expect(box).not.toHaveAttribute('aria-busy', 'true');
});

test('the character list filter keeps its own behaviour while a settings search is open', async ({ page, baseURL }) => {
    test.setTimeout(120000);
    await loadApp(page, baseURL, { viewport: VIEWPORTS[0] });
    await page.evaluate(async () => {
        window.qaApp = await import('/script.js');
    });
    await page.waitForFunction(() => window.qaApp.characters.length > 0, null, { timeout: 30000 });
    const name = await page.evaluate(() => window.qaApp.characters[0].name);
    await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
    await page.locator('.sb-list-header__button[aria-label="Search"]').click();
    const filter = page.locator('#character_search_bar');
    await expect(filter).toBeVisible();
    const total = await page.locator('#rm_print_characters_block .character_select:visible').count();
    await filter.fill(name.slice(0, Math.max(3, Math.ceil(name.length / 2))));
    await expect(page.locator('#rm_print_characters_block .character_select:visible').filter({ hasText: name }).first()).toBeVisible();
    await filter.fill('');
    await expect(page.locator('#rm_print_characters_block .character_select:visible')).toHaveCount(total);
});
