import { expect, test } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { q56Screenshot } from './helpers/q56-review.js';
import {
    activatePromptAction,
    activateAgentEditorAction,
    chooseAgentTemplate,
    chooseAgentCategory,
    editorCases,
    expectAgentMenuIcons,
    expectAgentHeaderIcons,
    mockEditorModel,
    openEditorAgents,
    openAgentProperties,
    closeAgentProperties,
    seedEditorAgents,
    samplePropertyGeometry,
    sampleDropdownTrigger,
    samplePropertyPopover,
    sampleListboxKeyboard,
    waitForEditorApp,
} from './helpers/in-chat-agents-editor.js';

test.use({
    serviceWorkers: 'block',
    contextOptions: { reducedMotion: 'reduce' },
});
const mounted = new WeakMap();
const screens = '/home/geechan/.opencode/plan/sb-qa/screens/a3';
const modeRoles = { 1440: 'radio', 390: 'button' };

async function setup(page, baseURL, width) {
    const editor = await openEditorAgents(page, baseURL, width);
    mounted.set(page, editor);
    return editor;
}

async function screenshot(page, name) {
    await mkdir(screens, { recursive: true });
    await expect(page.locator('.toast-error')).toHaveCount(0);
    await page.mouse.move(1, 1);
    await page.screenshot({ path: `${screens}/stage3-${name}.png` });
}

async function expectActiveOption(listbox, label) {
    const option = listbox.getByRole('option', { name: label, exact: true });
    await expect(listbox).toHaveAttribute('aria-activedescendant', await option.getAttribute('id'));
    await expect(option).toHaveClass('sb-prompt-option is-active');
    await expect(listbox).toBeFocused();
}

test('q56 dropdown sweep toggles each trigger closed on its second pointer click', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(300000);
    const editor = await setup(page, baseURL, 1440);
    const trace = [];
    const close = () => page.evaluate(async () => {
        (await import('/scripts/sillybunny-editor/picker.js')).closePicker({ animate: false });
        (await import('/scripts/sillybunny-action-menu.js')).closeActionMenu({ animate: false });
    });
    const check = async (trigger, label, target = trigger) => {
        await target.click();
        await expect(trigger, label).toHaveAttribute('aria-expanded', 'true');
        await target.click();
        await expect.soft(trigger, label).toHaveAttribute('aria-expanded', 'false');
        trace.push({ label, secondClickExpanded: await trigger.getAttribute('aria-expanded') });
        await close();
    };
    for (const label of ['Add Agent', 'Agents Menu']) {
        await check(editor.root.getByRole('button', { name: label, exact: true }), label);
    }
    await editor.root.getByRole('button', { name: 'Search Agents', exact: true }).click();
    await editor.root.getByRole('searchbox').fill('Editor');
    await check(editor.root.getByRole('button', { name: 'Filter Agents', exact: true }), 'Filter Agents');
    await check(editor.root.locator('[data-sb-list-key="agent:editor-pre"]').getByRole('button', { name: 'Agent Menu', exact: true }), 'Agent row menu');
    for (const id of ['pre', 'wrap', 'post', 'companion', 'tool', 'chatroom', 'director', 'plot']) {
        await editor.open(id);
        if (['companion', 'chatroom', 'director', 'plot'].includes(id)) {
            await editor.detail.locator('[data-sb-editor-field="companion.batch"] input').check();
            await editor.detail.locator('[data-sb-editor-field="companion.sendContextToCompanions"] input').check();
        }
        if (id === 'post') await editor.detail.locator('[data-sb-editor-field="conditions.runOnCompanionOutputs"] input').check();
        for (const row of await editor.detail.locator('.ds-select-row:visible').all()) {
            const trigger = row.locator('.ds-select-row__trigger');
            const label = `${id}: ${await row.locator('.ds-row-label').textContent()}`;
            await check(trigger, `${label} button`);
            await check(trigger, `${label} row`, row.locator('.ds-row-label'));
        }
        if (id === 'pre') {
            for (const label of ['More…', 'Sections', 'Connection Profile', 'Category']) {
                const trigger = editor.detail.getByRole('button', { name: label, exact: true });
                await check(trigger, label);
            }
            await editor.detail.getByRole('button', { name: 'Add Regex Script', exact: true }).click();
            const dialog = page.locator('dialog[open]');
            await dialog.getByRole('textbox', { name: 'Script Name', exact: true }).fill('QA toggle');
            await dialog.getByRole('textbox', { name: 'Find', exact: true }).fill('/QA/g');
            await dialog.locator('.popup-button-ok').click();
            await check(editor.detail.getByRole('button', { name: 'Regex Script', exact: true }), 'Regex row menu');
            await editor.discard.click();
        }
        if (await editor.discard.isEnabled()) await editor.discard.click();
        await editor.back();
    }
    for (const label of ['New Agent from Template…', 'New Companion from Template…']) {
        const trigger = editor.root.getByRole('button', { name: 'Add Agent', exact: true });
        await trigger.click();
        await page.getByRole('menuitem', { name: label, exact: true }).click();
        await expect(page.getByRole('dialog', { name: label.slice(0, -1), exact: true })).toBeVisible();
        await trigger.click();
        const expanded = await trigger.getAttribute('aria-expanded');
        trace.push({ label, secondClickExpanded: expanded });
        await expect.soft(trigger, label).toHaveAttribute('aria-expanded', 'false');
        await expect.soft(page.getByRole('menu'), label).toBeHidden();
        await close();
    }
    await testInfo.attach('q56 dropdown sweep', { body: JSON.stringify(trace), contentType: 'application/json' });
    expect(editor.saves()).toHaveLength(0);
});

for (const width of [360, 390, 430, 768]) {
    test(`q56 ${width}px every Agent textarea has a useful phone minimum`, async ({ page, baseURL }, testInfo) => {
        test.setTimeout(120000);
        const editor = await setup(page, baseURL, width);
        await mockEditorModel(page);
        const heights = [];
        const keyboardCheck = async field => {
            await field.evaluate(node => node.focus({ preventScroll: true }));
            await page.evaluate(() => {
                Object.defineProperty(visualViewport, 'height', { configurable: true, value: 600 });
                visualViewport.dispatchEvent(new Event('resize'));
            });
            await expect.poll(() => field.evaluate(node => {
                const rect = node.getBoundingClientRect();
                const body = node.closest('.sb-persona-entry-body').getBoundingClientRect();
                return rect.top >= body.top && rect.top < visualViewport.height - 80;
            })).toBe(true);
            await expect(field).toBeFocused();
            expect((await outerScroll(editor.detail)).every(position => position.top === 0)).toBe(true);
            await page.evaluate(() => {
                delete visualViewport.height;
                visualViewport.dispatchEvent(new Event('resize'));
            });
        };
        for (const id of ['pre', 'wrap', 'tracker', 'post', 'companion', 'chatroom', 'director', 'plot']) {
            await editor.open(id);
            if (id === 'post') {
                await editor.detail.getByRole('switch', { name: 'Utility Post-processing', exact: true }).check();
                await editor.detail.locator('[data-sb-editor-field="postProcess.type"]').getByRole('radio', { name: 'Append', exact: true }).check();
            }
            const fields = await editor.detail.locator('textarea:visible').evaluateAll(nodes => nodes.map(node => ({
                field: node.getAttribute('aria-label') || node.labels?.[0]?.textContent || node.name || node.id,
                prompt: node.classList.contains('ica-agent-prompt'),
                height: node.getBoundingClientRect().height,
                minimum: getComputedStyle(node).minHeight,
            })));
            heights.push({ id, fields });
            for (const field of fields) expect.soft(field.height, `${id}: ${field.field}`).toBeGreaterThanOrEqual(field.prompt ? 360 : 160);
            await keyboardCheck(editor.detail.locator('textarea:visible').last());
            if (id === 'tracker') {
                await editor.prompt.evaluate(node => node.focus({ preventScroll: true }));
                await q56Screenshot(page, `textareas-${width}-prompt`);
                await editor.detail.getByRole('textbox', { name: 'Format Example', exact: true }).focus();
                await q56Screenshot(page, `textareas-${width}-tracker`);
            }
            if (id === 'pre') {
                await editor.detail.getByRole('button', { name: 'Add Regex Script', exact: true }).click();
                const dialog = page.locator('dialog[open]');
                const fields = await dialog.locator('textarea:visible').evaluateAll(nodes => nodes.map(node => ({ field: node.getAttribute('aria-label'), height: node.getBoundingClientRect().height })));
                heights.push({ id: 'regex-dialog', fields });
                for (const field of fields) expect.soft(field.height, `regex: ${field.field}`).toBeGreaterThanOrEqual(160);
                await dialog.locator('.popup-button-cancel').click();
            }
            if (id === 'tracker' || id === 'companion') {
                if (id === 'tracker') {
                    await editor.detail.getByRole('textbox', { name: 'Format Example', exact: true }).fill('[TRACKER|Field]\nQA\n[/TRACKER]');
                    await editor.detail.getByRole('button', { name: 'Generate Kit…', exact: true }).click();
                } else await editor.detail.getByRole('button', { name: 'AI Maker…', exact: true }).click();
                const dialog = page.locator('dialog[open]');
                const fields = await dialog.locator('textarea:visible').evaluateAll(nodes => nodes.map(node => ({ field: node.id, height: node.getBoundingClientRect().height })));
                expect(fields.length).toBeGreaterThan(0);
                heights.push({ id: `${id}-dialog`, fields });
                for (const field of fields) expect(field.height).toBeGreaterThanOrEqual(180);
                await dialog.locator('.popup-button-cancel').click();
            }
            if (await editor.discard.isEnabled()) await editor.discard.click();
            await editor.back();
        }
        await testInfo.attach('q56 textarea heights', { body: JSON.stringify({ width, heights }), contentType: 'application/json' });
        expect(editor.saves()).toHaveLength(0);
    });
}

test('q56 real saved long tracker prompt stays useful across phone widths and container breakpoints', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(90000);
    const editor = await openEditorAgents(page, baseURL, 430, { seed: false });
    mounted.set(page, editor);
    const savedAgents = () => page.evaluate(async () => JSON.stringify((await import('/scripts/extensions/in-chat-agents/agent-store.js')).getAgents()));
    await expect.poll(async () => JSON.parse(await savedAgents()).length).toBeGreaterThan(0);
    const before = await savedAgents();
    const tracker = JSON.parse(before).filter(agent => agent.category === 'tracker').sort((a, b) => b.prompt.length - a.prompt.length)[0];
    expect(tracker, '4455 requires a real saved tracker').toBeTruthy();
    expect(tracker.prompt.length).toBeGreaterThan(500);
    await editor.root.locator(`[data-sb-list-key="agent:${tracker.id}"]`).first().evaluate(node => node.click());
    await expect(editor.prompt).toHaveValue(tracker.prompt);
    const samples = [];
    for (const width of [360, 390, 430, 768]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.locator('[data-sb-settings-tab="agents"]').evaluate(node => node.click());
        const fields = await editor.detail.locator('textarea:visible').evaluateAll(nodes => nodes.map(node => ({
            field: node.getAttribute('aria-label'), height: node.getBoundingClientRect().height, minimum: getComputedStyle(node).minHeight,
        })));
        samples.push({ width, fields });
        expect(fields.find(field => field.field === 'Prompt').height).toBeGreaterThanOrEqual(360);
        for (const field of fields) expect(field.height).toBeGreaterThanOrEqual(180);
        await editor.prompt.focus();
        await q56Screenshot(page, `textareas-real-${width}-prompt`);
        const extra = editor.detail.getByRole('textbox', { name: 'Format Example', exact: true });
        await extra.focus();
        await q56Screenshot(page, `textareas-real-${width}-tracker`);
    }
    for (const width of [439, 440, 559, 560]) {
        await editor.detail.locator('..').evaluate((node, width) => { node.style.width = `${width}px`; node.style.minWidth = `${width}px`; node.style.flex = 'none'; }, width);
        expect(await editor.prompt.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(360);
    }
    await testInfo.attach('q56 real tracker textarea heights', { body: JSON.stringify({ savedCount: JSON.parse(before).length, promptLength: tracker.prompt.length, samples }), contentType: 'application/json' });
    expect(await savedAgents()).toBe(before);
    expect(editor.writes.filter(write => write.path.startsWith('/api/in-chat-agents/'))).toEqual([]);
});

test.afterEach(async ({ page }) => {
    const editor = mounted.get(page);
    expect(editor?.errors ?? []).toEqual([]);
    expect(await page.evaluate(() => window.__editorMaxDialogs ?? 0)).toBeLessThanOrEqual(1);
});

const round2Screens = '/home/geechan/.opencode/plan/sb-qa/screens/round2';
async function round2Screenshot(page, name) {
    await mkdir(round2Screens, { recursive: true });
    await page.mouse.move(1, 1);
    await page.screenshot({ path: `${round2Screens}/${name}.png` });
}

async function outerScroll(detail) {
    return detail.evaluate(node => {
        const positions = [];
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
            positions.push({ node: parent.id || parent.className, top: parent.scrollTop, left: parent.scrollLeft });
        }
        return positions;
    });
}

for (const width of [1440, 390]) {
    test(`round2 ${width}px Sections scrolls only the detail body`, async ({ page, baseURL }) => {
        const editor = await setup(page, baseURL, width);
        await editor.open('companion');
        const before = await outerScroll(editor.detail);
        const top = await editor.root.evaluate(node => node.getBoundingClientRect().top);
        await activateAgentEditorAction(page, editor.detail, 'Sections');
        await page.getByRole('menuitem', { name: 'Conditions', exact: true }).click();
        await round2Screenshot(page, `after-sections-jump-${width}`);
        expect(await outerScroll(editor.detail)).toEqual(before);
        expect(before.every(position => position.top === 0)).toBe(true);
        expect(await editor.root.evaluate(node => node.getBoundingClientRect().top)).toBe(top);
        await expect(editor.detail.locator('[data-sb-section="conditions"]')).toBeFocused();
        expect(await editor.detail.locator('.sb-persona-entry-body').evaluate(node => node.scrollTop)).toBeGreaterThan(100);
    });
}

test('round2 Prompt content gap equals the measured inter-group gap', async ({ page, baseURL }, testInfo) => {
    const editor = await setup(page, baseURL, 1440);
    await editor.open('pre');
    const geometry = await editor.detail.evaluate(node => {
        const general = node.querySelector('[data-sb-section="general"]');
        const prompt = node.querySelector('[data-sb-section="prompt"]');
        const group = prompt.querySelector('.ds-pref-group');
        const content = prompt.querySelector('.ica-agent-prompt-content');
        return {
            betweenGroups: prompt.getBoundingClientRect().top - general.getBoundingClientRect().bottom,
            beforeContent: content.getBoundingClientRect().top - group.getBoundingClientRect().bottom,
        };
    });
    await testInfo.attach('Prompt group spacing', { body: JSON.stringify(geometry), contentType: 'application/json' });
    await round2Screenshot(page, 'prompt-group-gap');
    expect(geometry.betweenGroups).toBeGreaterThan(0);
    expect(geometry.beforeContent).toBe(geometry.betweenGroups);
});

for (const width of [390, 360]) {
    test(`round2 ${width}px prompt minimum and keyboard viewport keep the focused editor visible`, async ({ page, baseURL }, testInfo) => {
        const editor = await setup(page, baseURL, width);
        await editor.open('pre');
        const height = await editor.prompt.evaluate(node => node.getBoundingClientRect().height);
        await testInfo.attach('Phone prompt height', { body: JSON.stringify({ width, height }), contentType: 'application/json' });
        await round2Screenshot(page, `phone-prompt-${width}`);
        expect(height).toBeGreaterThanOrEqual(400);
        expect(height).toBeLessThanOrEqual(500);
        await editor.prompt.focus();
        await page.evaluate(() => {
            Object.defineProperty(visualViewport, 'height', { configurable: true, value: 600 });
            visualViewport.dispatchEvent(new Event('resize'));
        });
        await expect.poll(() => editor.prompt.evaluate(node => {
            const rect = node.getBoundingClientRect();
            const body = node.closest('.sb-persona-entry-body').getBoundingClientRect();
            return rect.top >= body.top && rect.top < visualViewport.height - 100;
        })).toBe(true);
        await expect(editor.prompt).toBeFocused();
        await round2Screenshot(page, `phone-prompt-keyboard-${width}`);
        expect((await outerScroll(editor.detail)).every(position => position.top === 0)).toBe(true);
    });
}

test('round2 open sidebar rows match Prompt row height and centred single-line geometry', async ({ page, baseURL }, testInfo) => {
    const editor = await setup(page, baseURL, 1440);
    await editor.open('pre');
    const row = editor.root.locator('[data-sb-list-key="agent:editor-pre"]').first();
    await expect(row.locator('.ds-entity-row__subtitle')).toBeHidden();
    await expect(row.getByRole('button', { name: 'Agent Menu', exact: true })).toBeHidden();
    const sample = (row, selectors) => row.evaluate((node, selectors) => {
        const rect = node.getBoundingClientRect();
        return {
            height: rect.height,
            centres: selectors.map(selector => {
                const child = node.querySelector(selector).getBoundingClientRect();
                return Math.round((child.top + child.height / 2 - rect.top - rect.height / 2) * 100) / 100;
            }),
        };
    }, selectors);
    const agents = await sample(row, ['.ds-entity-row__avatar', '.ds-entity-row__title', '.ica-agent-token', '.sb-switch']);
    await round2Screenshot(page, 'agents-open-1440');
    await editor.back();
    await expect(row.locator('.ds-entity-row__subtitle')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Agent Menu', exact: true })).toBeVisible();
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'editor'));
    await page.locator('[data-sb-settings-tab="editor"]').evaluate(node => node.click());
    await page.locator('.sb-prompt-row[data-prompt-id="main"] .sb-prompt-row-name').click();
    const prompt = await sample(page.locator('.sb-prompt-row[data-prompt-id="main"]'), [':scope > i', '.sb-prompt-row-name', '.sb-prompt-token', '.sb-switch']);
    await round2Screenshot(page, 'prompt-open-1440');
    await testInfo.attach('Open sidebar row geometry', { body: JSON.stringify({ agents, prompt }), contentType: 'application/json' });
    expect(agents.height).toBe(prompt.height);
    for (const [index, centre] of agents.centres.entries()) {
        expect(Math.abs(centre - prompt.centres[index])).toBeLessThan(0.1);
    }
});

test('round2 every ordered header popup pair replaces the previous surface', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(120000);
    const editor = await setup(page, baseURL, 1440);
    await editor.open('pre');
    await editor.root.getByRole('button', { name: 'Search Agents', exact: true }).click();
    await editor.root.getByRole('searchbox', { name: 'Search Agents', exact: true }).fill('Editor');
    const activate = locator => locator.evaluate(node => {
        node.click();
        return document.querySelectorAll('.sb-action-popover:not([hidden]), .sb-prompt-popover:not([inert])').length;
    });
    const open = {
        add: () => activate(editor.root.getByRole('button', { name: 'Add Agent', exact: true })),
        listMore: () => activate(editor.root.getByRole('button', { name: 'Agents Menu', exact: true })),
        filter: () => activate(editor.root.getByRole('button', { name: 'Filter Agents', exact: true })),
        more: () => activate(editor.detail.getByRole('button', { name: 'More…', exact: true })),
        sections: () => activate(editor.detail.getByRole('button', { name: 'Sections', exact: true })),
        category: () => activate(editor.detail.getByRole('button', { name: 'Category', exact: true })),
        picker: async () => {
            if (!await page.getByRole('menuitem', { name: 'New Agent from Template…', exact: true }).isVisible()) await open.add();
            await page.getByRole('menuitem', { name: 'New Agent from Template…', exact: true }).click();
            return page.locator('.sb-action-popover:visible').count();
        },
    };
    const surfaces = page.locator('.sb-action-popover:visible, .sb-picker-popover:visible, .sb-prompt-popover:not([inert]):visible');
    const trace = [];
    for (const first of Object.keys(open)) {
        for (const second of Object.keys(open).filter(name => name !== first)) {
            await page.evaluate(async () => {
                (await import('/scripts/sillybunny-action-menu.js')).closeActionMenu({ animate: false });
                (await import('/scripts/sillybunny-editor/picker.js')).closePicker({ animate: false });
            });
            const category = editor.detail.getByRole('button', { name: 'Category', exact: true });
            if (await category.getAttribute('aria-expanded') === 'true') await category.evaluate(node => node.click());
            await open[first]();
            expect.soft(await surfaces.count(), `${first} initial surface`).toBe(1);
            const immediateCount = await open[second]();
            const count = await surfaces.count();
            // Q56: the template picker and Add menu share their trigger; pressing it again closes both.
            const expectedCount = Number(first !== 'picker' || second !== 'add');
            trace.push({ first, second, immediateCount, count, expectedCount });
            expect.soft(immediateCount, `${first} → ${second} before focus/animation`).toBe(expectedCount);
            expect.soft(count, `${first} → ${second}`).toBe(expectedCount);
            if (first === 'picker' && second === 'add') await round2Screenshot(page, 'plus-after-picker');
        }
    }
    await testInfo.attach('Header popup pair trace', { body: JSON.stringify(trace), contentType: 'application/json' });
});

test('round2 More survives saved, switched, preview, helper, template and create/rekey states at header breakpoints', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(180000);
    const editor = await setup(page, baseURL, 1440);
    const trace = [];
    async function check(state) {
        const more = editor.detail.getByRole('button', { name: 'More…', exact: true });
        await expect(more, state).toBeVisible();
        const sample = () => more.evaluate(node => {
            const rect = node.getBoundingClientRect();
            return { width: node.closest('.ica-agent-detail').clientWidth, hit: node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) };
        });
        await expect.poll(async () => (await sample()).hit, { message: state }).toBe(true);
        trace.push({ state, ...await sample() });
        await more.click();
        await expect.soft(page.getByRole('menu'), state).toBeVisible();
        if (await page.getByRole('menu').isVisible()) await page.keyboard.press('Escape');
        else await more.click();
        await expect(more).toHaveAttribute('aria-expanded', 'false');
    }
    for (const width of [1440, 1024, 768]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.locator('button[data-sb-settings-tab="agents"]').evaluate(node => node.click());
        await editor.open('pre');
        await check(`${width} saved`);
        await activateAgentEditorAction(page, editor.detail, 'Preview Prompt in Context');
        await expect(page.locator('dialog[open]')).toBeVisible();
        await page.locator('dialog[open] .popup-button-ok').click();
        await check(`${width} after helper`);
        const preview = editor.detail.getByRole('radio', { name: 'Preview', exact: true });
        if (await preview.isVisible()) await preview.check();
        else await editor.detail.getByRole('button', { name: 'Preview', exact: true }).click();
        await check(`${width} preview`);
        await editor.name.fill(`Editor pre ${width}`);
        await editor.save.click();
        await expect(editor.save).toBeDisabled();
        await check(`${width} after save`);
        await editor.open('companion');
        await check(`${width} switched companion`);
        await editor.back();
        await chooseAgentTemplate(page, editor.root);
        await check(`${width} template`);
        await editor.back();
        await editor.root.getByRole('button', { name: 'Add Agent', exact: true }).click();
        await page.getByRole('menuitem', { name: 'New Agent', exact: true }).click();
        await check(`${width} new`);
        await editor.name.fill(`Round2 ${width}`);
        await editor.prompt.fill('Round2 local fixture only');
        await editor.save.click();
        await expect(editor.save).toBeDisabled();
        await check(`${width} rekeyed`);
        await editor.back();
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await editor.open('pre');
    for (const width of [559, 560, 561]) {
        await editor.detail.locator('..').evaluate((node, width) => { node.style.width = `${width}px`; node.style.flex = 'none'; }, width);
        await check(`container ${width}`);
    }
    await testInfo.attach('More states and hit testing', { body: JSON.stringify(trace), contentType: 'application/json' });
});

test('390px phone property sheet matches Prompt pills, controls, title and summary format', async ({ page, baseURL }, testInfo) => {
    const editor = await setup(page, baseURL, 390);
    const parityScreens = '/home/geechan/.opencode/plan/sb-qa/screens/parity';
    const sample = async (sheet, groupLabel) => {
        await page.mouse.move(1, 1);
        await sheet.locator('h2').focus();
        return sheet.evaluate((sheet, label) => {
            const read = (node, properties, pseudo = null) => {
                const style = getComputedStyle(node, pseudo);
                return Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)]));
            };
            const group = sheet.querySelector(`[role="group"][aria-label="${label}"]`);
            const input = sheet.querySelector('[role="switch"]');
            const properties = ['color', 'background-color', 'border-radius', 'padding', 'font-size', 'font-weight'];
            return {
                selected: read(group.querySelector('input:checked + span'), properties),
                unselected: read(group.querySelector('input:not(:checked) + span'), properties),
                title: read(sheet.querySelector('h2'), [
                    'color', 'font-family', 'font-size', 'font-weight', 'line-height', 'margin', 'padding',
                ]),
                select: read(sheet.querySelector('.sb-prompt-dropdown'), [
                    'color', 'background-color', 'height', 'width', 'min-height', 'padding',
                    'font-size', 'font-weight', 'line-height', 'border-radius', 'border-color',
                ]),
                switch: read(input, ['background-color', 'border-color', 'border-radius', 'height', 'width']),
                thumb: read(input, ['background-color', 'transform'], '::after'),
            };
        }, groupLabel);
    };
    await editor.open('pre');
    const summary = editor.detail.locator('.ica-agent-property-summary');
    await expect(summary).toHaveText('Custom · Before · Inline ›');
    const agentSummary = await summary.textContent();
    await summary.click();
    const agents = page.locator('.ica-agent-property-sheet');
    const pin = agents.getByRole('switch', { name: 'Pin', exact: true });
    await pin.uncheck();
    const agent = await sample(agents, 'Stage');
    const execution = await sample(agents, 'Execution');
    const agentLabels = await agents.evaluate(node => ({
        title: node.querySelector('h2').textContent,
        close: node.querySelector('header button').getAttribute('aria-label'),
    }));
    await page.mouse.move(1, 1);
    await page.screenshot({ path: `${parityScreens}/after-agents-sheet-390.png` });
    await pin.check();
    const checkedAgent = await sample(agents, 'Stage');
    await expect(summary).toHaveText(agentSummary);
    const pinnedSummary = await summary.textContent();
    await pin.uncheck();
    await page.keyboard.press('Escape');
    await editor.back();
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'editor'));
    await page.locator('button[data-sb-settings-tab="editor"]').evaluate(node => node.click());
    await page.locator('.sb-prompt-row[data-prompt-id="main"] .sb-prompt-row-name').click();
    const prompt = page.locator('.sb-prompt-detail');
    const promptSummary = prompt.getByRole('button', { name: 'Prompt properties', exact: true });
    await expect(promptSummary).toHaveText(/^.+ · .+ · .+ ›$/);
    await promptSummary.click();
    const reference = page.locator('.sb-prompt-sheet');
    const forbid = reference.getByRole('switch', { name: 'Forbid overrides', exact: true });
    await forbid.uncheck();
    const promptText = await promptSummary.textContent();
    const promptStyles = await sample(reference, 'Position');
    await page.mouse.move(1, 1);
    await page.screenshot({ path: `${parityScreens}/prompt-sheet-390.png` });
    await forbid.check();
    const checkedPrompt = await sample(reference, 'Position');
    await expect(promptSummary).toHaveText(promptText);
    await testInfo.attach('phone-sheet styles', {
        body: JSON.stringify({
            agent,
            execution,
            prompt: promptStyles,
            checkedAgent,
            checkedPrompt,
            agentSummary,
            pinnedSummary,
            promptText,
        }),
        contentType: 'application/json',
    });
    expect(agent.selected).toEqual(promptStyles.selected);
    expect(agent.unselected).toEqual(promptStyles.unselected);
    expect(execution.selected).toEqual(promptStyles.selected);
    expect(execution.unselected).toEqual(promptStyles.unselected);
    expect(agent.title).toEqual(promptStyles.title);
    expect(agent.select).toEqual(promptStyles.select);
    expect(agent.switch).toEqual(promptStyles.switch);
    expect(agent.thumb).toEqual(promptStyles.thumb);
    expect(checkedAgent.switch).toEqual(checkedPrompt.switch);
    expect(checkedAgent.thumb).toEqual(checkedPrompt.thumb);
    expect(agentLabels).toEqual({ title: 'Agent properties', close: 'Close agent properties' });
});

for (const width of [1440, 768, 390, 360]) {
    test(
        `${width}px every agent fixture renders the specified groups without overflow`,
        async ({
            page,
            baseURL,
        }) => {
            // Twelve fixtures each exercise both the narrow overflow and section menus.
            test.setTimeout(60000);
            const editor = await setup(page, baseURL, width);
            for (const fixture of editorCases) {
                await test.step(
                    fixture.id,
                    async () => {
                        await editor.open(fixture.id);
                        const groups = await editor.detail.locator('[data-sb-section]:visible').evaluateAll(nodes => nodes.map(node => node.dataset.sbSection));
                        expect(groups).toEqual(fixture.groups);
                        await expectAgentHeaderIcons(editor.detail);
                        await activateAgentEditorAction(page, editor.detail, 'Sections');
                        await expectAgentMenuIcons(page);
                        await page.keyboard.press('Escape');
                        await editor.detail.getByRole('button', { name: 'More…', exact: true }).click();
                        await expectAgentMenuIcons(page);
                        await page.keyboard.press('Escape');
                        const overflow = await editor.detail.evaluate(node => ({
                            detail: node.scrollWidth - node.clientWidth,
                            page: document.documentElement.scrollWidth - innerWidth,
                            body: node.querySelector('.sb-persona-entry-body').scrollWidth - node.querySelector('.sb-persona-entry-body').clientWidth,
                        }));
                        expect(overflow.detail).toBeLessThanOrEqual(1);
                        expect(overflow.page).toBeLessThanOrEqual(1);
                        expect(overflow.body).toBeLessThanOrEqual(1);
                        await screenshot(page, `${fixture.id}-${width}`);
                        await editor.back();
                    },
                );
            }
            expect(editor.saves()).toHaveLength(0);
            await expect(page.locator('#ica--editor, .ica--editor-fullscreen')).toHaveCount(0);
        },
    );

    test(
        `${width}px Save, Discard, inline validation, Ctrl/Cmd+S and legacy regex preserve persisted semantics`,
        async ({
            page,
            baseURL,
        }) => {
            const editor = await setup(page, baseURL, width);
            await editor.open('pre');
            await editor.name.fill('Saved name');
            await editor.save.click();
            await expect(editor.save).toBeDisabled();
            expect(editor.saves()).toHaveLength(1);
            expect(editor.saves()[0].name).toBe('Saved name');
            await expect(editor.root.locator('[data-sb-list-key="agent:editor-pre"]')).toHaveAttribute('aria-label', 'Saved name');
            await editor.name.fill('Discarded');
            await editor.discard.click();
            await expect(editor.name).toHaveValue('Saved name');
            expect(editor.saves()).toHaveLength(1);
            for (const key of ['Control+s', 'Meta+s']) {
                await editor.name.fill(`Saved ${key}`);
                await page.keyboard.press(key);
                await expect(editor.save).toBeDisabled();
            }
            expect(editor.saves()).toHaveLength(3);
            await editor.back();
            await editor.open('replace');
            await editor.prompt.fill(' ');
            await editor.save.click();
            await expect(editor.prompt).toHaveAttribute('aria-invalid', 'true');
            await expect(editor.prompt).toBeFocused();
            await expect(editor.detail.locator('.ica-agent-field-error:visible')).toHaveText('Pre-generation intercept mode needs an agent prompt');
            expect(editor.saves()).toHaveLength(3);
            await editor.discard.click();
            await editor.back();
            await page.evaluate(async () => {
                const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                const agents = structuredClone(store.getAgents());
                const agent = agents.find(agent => agent.id === 'editor-post');
                Object.assign(
                    agent.postProcess,
                    {
                        enabled: true,
                        type: 'regex',
                        regexFind: 'legacy',
                        regexReplace: 'retained',
                        regexFlags: 'gi',
                    },
                );
                store.loadAgents(agents);
                (await import('/scripts/extensions/in-chat-agents/ui/agent-list.js')).refreshAgentsPanels();
            });
            await editor.open('post');
            await editor.name.fill('Legacy edited');
            await editor.save.click();
            await expect(editor.save).toBeDisabled();
            expect(editor.saves()).toHaveLength(4);
            expect(editor.saves()[3].postProcess).toMatchObject({
                enabled: true,
                type: 'regex',
                regexFind: 'legacy',
                regexReplace: 'retained',
                regexFlags: 'gi',
            });
        },
    );

    test(
        `${width}px template picker draft open/cancel is read-only and Save materialises once`,
        async ({
            page,
            baseURL,
        }) => {
            const editor = await setup(page, baseURL, width);
            const name = await chooseAgentTemplate(page, editor.root);
            await expect(editor.save).toBeEnabled();
            await editor.back();
            expect(editor.saves()).toHaveLength(0);
            await chooseAgentTemplate(page, editor.root, { name });
            await editor.save.click();
            await expect(editor.save).toBeDisabled();
            expect(editor.saves()).toHaveLength(1);
            const id = editor.saves()[0].id;
            await editor.name.fill('Materialised edited');
            await editor.save.click();
            await expect(editor.save).toBeDisabled();
            expect(editor.saves()).toHaveLength(2);
            expect(editor.saves()[1].id).toBe(id);
            await editor.back();
            await expect(editor.root.locator(`[data-sb-list-key="agent:${id}"]`)).toBeFocused();
        },
    );
}

for (const width of [1440, 390]) {
    test(`${width}px open Category listbox matches Prompt Role popover styles, placement and ARIA`, async ({ page, baseURL }, testInfo) => {
        const editor = await setup(page, baseURL, width);
        const parityScreens = '/home/geechan/.opencode/plan/sb-qa/screens/parity';
        await editor.open('pre');
        await openAgentProperties(editor.detail);
        const category = page.locator('.ica-agent-properties:visible').getByRole('button', { name: 'Category', exact: true });
        await category.click();
        const categoryPopover = page.getByRole('listbox', { name: 'Category', exact: true });
        await expect(categoryPopover).toBeVisible();
        const agentStyles = await samplePropertyPopover(categoryPopover, category);
        await page.screenshot({ path: `${parityScreens}/open-category-${width}.png` });
        const agentKeyboard = await sampleListboxKeyboard(category, categoryPopover);
        await closeAgentProperties(page);
        await editor.back();
        await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'editor'));
        await page.locator('[data-sb-settings-tab="editor"]').evaluate(node => node.click());
        await page.locator('.sb-prompt-row[data-prompt-id="main"] .sb-prompt-row-name').click();
        const prompt = page.locator('.sb-prompt-detail');
        const promptSheet = {
            1440: async () => {},
            390: () => prompt.getByRole('button', { name: 'Prompt properties', exact: true }).click(),
        };
        await promptSheet[width]();
        const role = page.getByRole('button', { name: 'Role', exact: true });
        await role.click();
        const rolePopover = page.getByRole('listbox', { name: 'Role', exact: true });
        await expect(rolePopover).toBeVisible();
        const promptStyles = await samplePropertyPopover(rolePopover, role);
        await page.screenshot({ path: `${parityScreens}/open-role-${width}.png` });
        const promptKeyboard = await sampleListboxKeyboard(role, rolePopover);
        await testInfo.attach('Category vs Role open popover', {
            body: JSON.stringify({ width, agents: agentStyles, prompt: promptStyles, agentKeyboard, promptKeyboard }, null, 2),
            contentType: 'application/json',
        });
        expect(agentStyles).toEqual(promptStyles);
        expect(agentStyles.aria).toEqual({
            haspopup: 'listbox', expanded: 'true', role: 'listbox', tabIndex: 0,
            focused: true, activeSelected: true, selectedCount: 1, allOptions: true,
        });
        expect(agentStyles.placement).toEqual({ width: 208, leftDelta: 0, topDelta: 0 });
        expect(agentKeyboard).toEqual(promptKeyboard);
        expect(agentKeyboard.movement.map(step => step.active)).toEqual(['first', 'last', 'first', 'last', 'middle']);
    });

    test(`${width}px Category button matches Role and its listbox preserves keyboard and editor rules`, async ({ page, baseURL }, testInfo) => {
        const editor = await setup(page, baseURL, width);
        await editor.open('pre');
        const parityScreens = '/home/geechan/.opencode/plan/sb-qa/screens/parity';
        await page.mouse.move(1, 1);
        await page.screenshot({ path: `${parityScreens}/after-agents-${width}.png` });
        await openAgentProperties(editor.detail);
        const bar = page.locator('.ica-agent-properties:visible');
        const category = bar.getByRole('button', { name: 'Category', exact: true });
        await expect(bar.locator('select')).toHaveCount(0);
        await expect(category).toHaveAttribute('aria-haspopup', 'listbox');
        await expect(category).toHaveAttribute('aria-expanded', 'false');
        await expect(category.locator(':scope > span')).toHaveText('Custom');
        await expect(category.locator(':scope > i')).toHaveClass('fa-solid fa-chevron-down');
        await expect(category.locator(':scope > i')).toHaveAttribute('aria-hidden', 'true');
        const agentStyles = await sampleDropdownTrigger(category);
        const captureSheet = {
            1440: async () => {},
            390: () => page.screenshot({ path: `${parityScreens}/after-agents-sheet-390.png` }),
        };
        await captureSheet[width]();
        await category.press('ArrowDown');
        const listbox = page.getByRole('listbox', { name: 'Category', exact: true });
        await expect(listbox).toBeVisible();
        await expect(category).toHaveAttribute('aria-expanded', 'true');
        await expect(category).not.toHaveAttribute('aria-controls');
        await expect(listbox.getByRole('option', { selected: true })).toHaveCount(1);
        await expect(listbox.getByRole('option', { name: 'Custom', exact: true })).toHaveAttribute('aria-selected', 'true');
        await expectActiveOption(listbox, 'Custom');
        await expect(listbox.getByRole('option', { name: 'Tool', exact: true })).toHaveCount(0);
        await page.keyboard.press('ArrowDown');
        await expectActiveOption(listbox, 'Tracker');
        await page.keyboard.press('ArrowUp');
        await expectActiveOption(listbox, 'Custom');
        await page.keyboard.press('Home');
        await expectActiveOption(listbox, 'Tracker');
        await page.keyboard.press('ArrowDown');
        await expectActiveOption(listbox, 'Randomizer');
        await expect(listbox.getByRole('option', { name: 'Custom', exact: true })).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('End');
        await expectActiveOption(listbox, 'Custom');
        await page.keyboard.press('ArrowUp');
        await expectActiveOption(listbox, 'Companion');
        await page.keyboard.press('Enter');
        await expect(listbox).toBeHidden();
        await expect(category).toHaveAttribute('aria-expanded', 'false');
        await expect(category).not.toHaveAttribute('aria-controls');
        await expect(category).toBeFocused();
        await expect(category).toHaveText('Companion');
        await expect(bar.locator('[data-sb-editor-field="phase"]')).toBeHidden();
        const execution = bar.getByRole('group', { name: 'Execution', exact: true });
        await expect(execution.getByRole('radio', { name: 'Companion', exact: true })).toBeChecked();
        await expect(execution.getByRole('radio', { name: 'Inline', exact: true })).toBeDisabled();
        await category.press('ArrowUp');
        await expect(listbox.getByRole('option', { name: 'Companion', exact: true })).toHaveAttribute('aria-selected', 'true');
        await expectActiveOption(listbox, 'Companion');
        await page.keyboard.press('Escape');
        await expect(category).toBeFocused();
        await expect(bar).toBeVisible();
        await category.press('Enter');
        await expectActiveOption(listbox, 'Companion');
        await page.keyboard.press('Tab');
        await expect(listbox).toBeHidden();
        await expect(category).toHaveAttribute('aria-expanded', 'false');
        await expect(bar).toBeVisible();
        await category.click();
        await category.click();
        await expect(listbox).toBeHidden();
        await expect(category).toBeFocused();
        expect(editor.saves()).toHaveLength(0);
        await closeAgentProperties(page);
        await editor.save.click();
        await expect(editor.save).toBeDisabled();
        expect(editor.saves()).toHaveLength(1);
        expect(editor.saves()[0]).toMatchObject({ category: 'companion', execution: 'companion', phase: 'pre' });
        await openAgentProperties(editor.detail);
        await category.press('Space');
        await expectActiveOption(listbox, 'Companion');
        await page.keyboard.press('End');
        await page.keyboard.press('Space');
        await expect(category).toHaveText('Custom');
        await expect(category).toBeFocused();
        await execution.getByRole('radio', { name: 'Inline', exact: true }).check();
        await expect(bar.getByRole('radio', { name: 'Before', exact: true })).toBeChecked();
        await closeAgentProperties(page);
        await editor.discard.click();
        await editor.back();
        await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'editor'));
        await page.locator('[data-sb-settings-tab="editor"]').evaluate(node => node.click());
        await page.locator('.sb-prompt-row[data-prompt-id="main"] .sb-prompt-row-name').click();
        const prompt = page.locator('.sb-prompt-detail');
        const promptSheet = {
            1440: async () => {},
            390: () => prompt.getByRole('button', { name: 'Prompt properties', exact: true }).click(),
        };
        await promptSheet[width]();
        const role = page.getByRole('button', { name: 'Role', exact: true });
        const promptStyles = await sampleDropdownTrigger(role);
        await testInfo.attach('Category vs Role trigger', {
            body: JSON.stringify({ width, agents: agentStyles, prompt: promptStyles }, null, 2),
            contentType: 'application/json',
        });
        expect(agentStyles).toEqual(promptStyles);
    });

    test(
        `${width}px new creation, page Expand, forced colours, large text and keyboard shrink stay usable`,
        async ({
            page,
            baseURL,
        }) => {
            const editor = await setup(page, baseURL, width);
            await editor.root.getByRole('button', {
                name: 'Add Agent',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {
                name: 'New Agent',
                exact: true,
            }).click();
            await expect(editor.save).toBeEnabled();
            expect(editor.saves()).toHaveLength(0);
            await editor.name.fill('Created in detail');
            await editor.save.click();
            await expect(editor.save).toBeDisabled();
            expect(editor.saves()).toHaveLength(1);
            const id = editor.saves()[0].id;
            await editor.detail.getByRole('button', {
                name: 'Expand the editor',
                exact: true,
            }).click();
            const dialog = page.locator('dialog[open]');
            await dialog.locator('.maximized_textarea').fill('Expanded locally');
            await dialog.locator('.popup-button-ok').click();
            await expect(editor.prompt).toHaveValue('Expanded locally');
            await editor.discard.click();
            await page.emulateMedia({
                forcedColors: 'active',
                reducedMotion: 'reduce',
            });
            await page.evaluate(() => document.documentElement.style.setProperty('--mainFontSize', '32px'));
            expect(await editor.detail.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
            await page.evaluate(() => document.documentElement.style.removeProperty('--mainFontSize'));
            await page.setViewportSize({
                width,
                height: 500,
            });
            await editor.prompt.focus();
            await expect(editor.prompt).toBeInViewport();
            await page.keyboard.press('Escape');
            await expect(editor.prompt).not.toBeFocused();
            await expect(editor.detail).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(editor.detail).toHaveCount(0);
            await expect(editor.root.locator(`[data-sb-list-key="agent:${id}"]`)).toBeFocused();
            expect(editor.saves()).toHaveLength(1);
        },
    );

    test(
        `${width}px regex edits, switches, ordering, deletion and bundled reset remain local until Save`,
        async ({
            page,
            baseURL,
        }) => {
            const editor = await setup(page, baseURL, width);
            await editor.open('pre');
            const dialog = page.locator('dialog[open]');
            const rows = editor.detail.locator('.ica-agent-regex-list .ds-row');
            for (const name of ['First regex', 'Second regex']) {
                await editor.detail.getByRole('button', {
                    name: 'Add Regex Script',
                    exact: true,
                }).click();
                await dialog.getByRole('textbox', {
                    name: 'Script Name',
                    exact: true,
                }).fill(name);
                await dialog.getByRole('textbox', {
                    name: 'Find',
                    exact: true,
                }).fill('/QA/g');
                await dialog.locator('.popup-button-ok').click();
            }
            await rows.first().getByRole('button', {
                name: 'Regex Script',
                exact: true,
            }).click();
            await expectAgentMenuIcons(page);
            await page.getByRole('menuitem', {
                name: 'Edit…',
                exact: true,
            }).click();
            await dialog.getByRole('textbox', {
                name: 'Replace',
                exact: true,
            }).fill('replacement');
            await dialog.locator('.popup-button-ok').click();
            await rows.first().getByRole('switch').uncheck();
            await rows.first().getByRole('button', {
                name: 'Regex Script',
                exact: true,
            }).click();
            await expectAgentMenuIcons(page);
            await page.getByRole('menuitem', {
                name: 'Move Down',
                exact: true,
            }).click();
            await expect(rows.first().getByRole('switch')).toHaveAccessibleName('Second regex');
            await rows.last().getByRole('button', {
                name: 'Regex Script',
                exact: true,
            }).click();
            await expectAgentMenuIcons(page);
            await page.getByRole('menuitem', {
                name: 'Delete…',
                exact: true,
            }).click();
            await expect(dialog).toHaveCount(1);
            await dialog.getByRole('button', {
                name: 'Cancel',
                exact: true,
            }).click();
            await expect(rows).toHaveCount(2);
            expect(editor.saves()).toHaveLength(0);
            await editor.save.click();
            await expect(editor.save).toBeDisabled();
            expect(editor.saves()).toHaveLength(1);
            expect(editor.saves()[0].regexScripts.map(script => script.scriptName)).toEqual(['Second regex', 'First regex']);
            expect(editor.saves()[0].regexScripts[1]).toMatchObject({
                disabled: true,
                replaceString: 'replacement',
                findRegex: '/QA/g',
            });
            await editor.back();
            const name = await page.evaluate(async () => (await (await fetch('/scripts/extensions/in-chat-agents/templates/index.json')).json()).find(template => template.id === 'tpl-drift-tracker').name);
            await chooseAgentTemplate(page, editor.root, { name });
            await expect(rows).not.toHaveCount(0);
            const originalCount = await rows.count();
            await rows.first().getByRole('button', {
                name: 'Regex Script',
                exact: true,
            }).click();
            await expectAgentMenuIcons(page);
            await page.getByRole('menuitem', {
                name: 'Delete…',
                exact: true,
            }).click();
            await dialog.getByRole('button', {
                name: 'Delete',
                exact: true,
            }).click();
            await expect(rows).toHaveCount(originalCount - 1);
            await editor.detail.getByRole('button', {
                name: 'Load Bundled Regex',
                exact: true,
            }).click();
            await expect(rows).toHaveCount(originalCount);
            expect(editor.saves()).toHaveLength(1);
        },
    );

    test(
        `${width}px dirty row, tab and origin Back use the shared leave dialog`,
        async ({
            page,
            baseURL,
        }) => {
            const editor = await setup(page, baseURL, width);
            const dialog = page.locator('dialog[open]');
            await editor.open('pre');
            await editor.name.fill('Unsaved');
            await editor.root.locator('[data-sb-list-key="agent:editor-both"]').evaluate(node => node.click());
            await expect(dialog).toHaveCount(1);
            await dialog.locator('.popup-button-cancel').click();
            await expect(editor.name).toHaveValue('Unsaved');
            // Reveal settings navigation on narrow screens without leaving the detail.
            await page.evaluate(() => document.getElementById('sb-settings-back').click());
            await page.locator('[data-sb-settings-tab="connections"]').click();
            await expect(dialog).toHaveCount(1);
            await dialog.locator('.popup-button-cancel').click();
            await page.locator('[data-sb-settings-tab="agents"]').evaluate(node => node.click());
            await expect(editor.detail).toBeVisible();
            await editor.detail.getByRole('button', {
                name: 'Back',
                exact: true,
            }).click();
            await expect(dialog).toHaveCount(1);
            await dialog.locator('.popup-button-cancel').click();
            await expect(editor.name).toHaveValue('Unsaved');
            expect(editor.saves()).toHaveLength(0);
            await editor.detail.getByRole('button', {
                name: 'Back',
                exact: true,
            }).click();
            await dialog.getByRole('button', {
                name: 'Discard',
                exact: true,
            }).click();
            await expect(editor.detail).toHaveCount(0);
        },
    );

    test(
        `${width}px local drafts survive reload and Restore/Discard clear the correct draft`,
        async ({
            page,
            baseURL,
        }) => {
            const editor = await setup(page, baseURL, width);
            await editor.open('pre');
            await editor.name.fill('Recovered draft');
            await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('sb-agent-editor-draft-')))).toBe(true);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await waitForEditorApp(page);
            await seedEditorAgents(page);
            await editor.open('pre');
            await page.locator('#sb_draft_restore_btn').click();
            await expect(editor.name).toHaveValue('Recovered draft');
            expect(editor.saves()).toHaveLength(0);
            await editor.discard.click();
            await expect(editor.name).toHaveValue('Editor pre');
            await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('sb-agent-editor-draft-')))).toEqual([]);
        },
    );

    test(
        `${width}px dirty Duplicate/Export requires Save, Discard or Cancel and blocks invalid Save`,
        async ({
            page,
            baseURL,
        }) => {
            const editor = await setup(page, baseURL, width);
            await editor.open('replace');
            const dialog = page.locator('dialog[open]');
            const more = async action => {
                await editor.detail.getByRole('button', {
                    name: 'More…',
                    exact: true,
                }).click();
                await page.getByRole('menuitem', {
                    name: action,
                    exact: true,
                }).click();
                await expect(dialog.locator('.popup-button-ok')).toHaveText('Save');
                await expect(dialog.locator('.sb-editor-discard')).toHaveText('Discard');
                await expect(dialog.locator('.popup-button-cancel')).toHaveText('Cancel');
            };
            for (const action of ['Duplicate', 'Export…']) {
                await editor.name.fill('Unsaved action');
                await more(action);
                await dialog.locator('.popup-button-cancel').click();
                await expect(editor.name).toHaveValue('Unsaved action');
                expect(editor.saves()).toHaveLength(0);
            }
            await more('Export…');
            const download = page.waitForEvent('download');
            await dialog.locator('.sb-editor-discard').click();
            const file = await download;
            const data = JSON.parse(await readFile(await file.path(), 'utf8'));
            expect(data.name).toBe('Editor replace');
            expect(editor.saves()).toHaveLength(0);
            await editor.name.fill('Explicitly saved');
            await more('Duplicate');
            await dialog.locator('.popup-button-ok').click();
            await expect.poll(() => editor.saves().length).toBe(2);
            expect(editor.saves()[0]).toMatchObject({
                id: 'editor-replace',
                name: 'Explicitly saved',
            });
            expect(editor.saves()[1].id).not.toBe('editor-replace');
            expect(editor.saves()[1].name).toBe('Explicitly saved');
            await editor.prompt.fill(' ');
            await more('Duplicate');
            await dialog.locator('.popup-button-ok').click();
            await expect(editor.prompt).toHaveAttribute('aria-invalid', 'true');
            expect(editor.saves()).toHaveLength(2);
        },
    );

    test(
        `${width}px Preview, Refine, regex and generated kit remain single-level local edits`,
        async ({
            page,
            baseURL,
        }) => {
            const editor = await setup(page, baseURL, width);
            await mockEditorModel(page);
            await editor.open('tracker');
            const dialog = page.locator('dialog[open]');
            await editor.prompt.fill('Unsaved preview marker');
            await activateAgentEditorAction(page, editor.detail, 'Preview Prompt in Context');
            await expect(dialog).toHaveCount(1);
            await expect(dialog.locator('pre')).toContainText('Unsaved preview marker');
            await dialog.locator('.popup-button-ok').click();
            await activateAgentEditorAction(page, editor.detail, 'Refine…');
            await expect(dialog.locator('[name="ica-refine-mode"]')).toHaveCount(5);
            await dialog.locator('.popup-button-ok').click();
            await expect(dialog.locator('h4').last()).toHaveText('Refined');
            await expect(dialog.locator('pre').last()).toHaveText('Mock refined prompt');
            await dialog.locator('.popup-button-ok').click();
            await expect(editor.prompt).toHaveValue('Mock refined prompt');
            await editor.detail.getByRole('button', {
                name: 'Add Regex Script',
                exact: true,
            }).click();
            const find = dialog.getByRole('textbox', {
                name: 'Find',
                exact: true,
            });
            await find.fill('');
            await dialog.locator('.popup-button-ok').click();
            await expect(find).toHaveAttribute('aria-invalid', 'true');
            await expect(find).toBeFocused();
            await find.fill('/QA/g');
            await dialog.locator('.popup-button-ok').click();
            await expect(editor.detail.locator('.ica-agent-regex-list .ds-row')).toHaveCount(1);
            await editor.detail.getByRole('textbox', {
                name: 'Format Example',
                exact: true,
            }).fill('[TRACKER|Field]\nnote: QA\n[/TRACKER]');
            await editor.detail.getByRole('button', {
                name: 'Generate Kit…',
                exact: true,
            }).click();
            await expect(dialog.locator('#ica--tracker-builder-extra-instructions')).toBeVisible();
            await expect(dialog.locator('.editor_maximize, .ica--textarea-fullscreen-toggle')).toHaveCount(0);
            await dialog.evaluate(node => node.dataset.qaTrackerPreview = 'same-popup');
            await dialog.locator('#ica--tracker-builder-extra-instructions').fill('QA regeneration');
            await dialog.getByText('Regenerate', { exact: true }).click();
            await expect.poll(() => page.evaluate(() => window.__editorModelCalls)).toBe(3);
            await expect(dialog).toHaveAttribute('data-qa-tracker-preview', 'same-popup');
            await dialog.locator('.popup-button-ok').click();
            await expect(editor.prompt).toHaveValue('Mock tracker prompt');
            expect(editor.saves()).toHaveLength(0);
            await editor.discard.click();
            await editor.back();
            await editor.open('companion');
            await editor.detail.getByRole('switch', { name: 'Keep in Chat History', exact: true }).check();
            await editor.detail.getByRole('switch', { name: 'Keep All', exact: true }).uncheck();
            await editor.detail.getByRole('spinbutton', { name: 'Notes to Keep', exact: true }).fill('7');
            await editor.detail.getByRole('button', {
                name: 'AI Maker…',
                exact: true,
            }).click();
            await dialog.locator('#ica--companion-maker-goal').fill('QA helper');
            await dialog.locator('.popup-button-ok').click();
            await expect(dialog.locator('pre')).toHaveText('Mock companion prompt');
            await dialog.locator('.popup-button-ok').click();
            await expect(editor.prompt).toHaveValue('Mock companion prompt');
            await editor.detail.getByRole('button', {
                name: 'Preview Feedback',
                exact: true,
            }).click();
            await expect(dialog).toHaveCount(1);
            await dialog.locator('.popup-button-ok').click();
            expect(editor.saves()).toHaveLength(0);
            await editor.save.click();
            await expect(editor.save).toBeDisabled();
            expect(editor.saves()).toHaveLength(1);
            expect(editor.saves()[0].companion).toMatchObject({
                includeInChatHistory: true,
                includeAllChatHistory: false,
                chatHistoryDepth: 7,
            });
            await editor.back();
            await editor.open('tracker');
            await page.evaluate(() => {
                window.SillyTavern.getContext().ConnectionManagerRequestService.sendRequest = async () => {
                    throw new Error('QA model unavailable');
                };
            });
            await editor.detail.getByRole('textbox', { name: 'Format Example', exact: true }).fill('[TRACKER|Field]');
            await editor.detail.getByRole('button', { name: 'Generate Kit…', exact: true }).click();
            await expect(dialog).toContainText('Fallback scaffold used.');
            await dialog.locator('.popup-button-cancel').click();
            await expect(editor.prompt).not.toHaveValue('Mock tracker prompt');
            expect(editor.saves()).toHaveLength(1);
        },
    );

    test(
        `${width}px overview and panel public hooks open detail and Back restores origins`,
        async ({
            page,
            baseURL,
        }) => {
            const editor = await setup(page, baseURL, width);
            const dialog = page.locator('dialog[open]');
            await page.evaluate(() => {
                void import('/scripts/extensions/in-chat-agents/companion/companion-dashboard.js').then(module => module.openCompanionDashboard());
            });
            const overview = editor.root.locator('[data-agent-page="companions"]');
            const companion = overview.locator('[data-companion-key="companion:editor-companion"]');
            await expect(overview).toBeVisible();
            await expect(dialog).toHaveCount(0);
            await companion.click();
            await expect(dialog).toHaveCount(0);
            await expect(editor.name).toHaveValue('Editor companion');
            await editor.name.fill('Origin guarded');
            await editor.detail.getByRole('button', {
                name: 'Back',
                exact: true,
            }).click();
            await expect(dialog.locator('.popup-button-ok')).toHaveText('Save');
            await dialog.locator('.popup-button-cancel').click();
            await expect(editor.name).toHaveValue('Origin guarded');
            await editor.detail.getByRole('button', {
                name: 'Back',
                exact: true,
            }).click();
            await dialog.locator('.sb-editor-discard').click();
            await expect(overview).toBeVisible();
            await expect(companion).toBeFocused();
            await expect(overview.getByRole('button', { name: 'Run All on Last Message', exact: true })).toBeVisible();
            await expect(overview.getByRole('button', { name: 'Open Companion Panel', exact: true })).toBeVisible();
            await expect(overview.locator('[data-action="to-companion"], [data-action="new-companion"], [data-action="ai-maker"]')).toHaveCount(0);
            await overview.getByRole('button', { name: 'Back', exact: true }).click();
            await page.locator('#sb-settings-close').click();
            await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel());
            const panel = page.locator('#ica--tracker-panel');
            await panel.locator('[data-agent-id="editor-companion"] [data-action="panel-edit"]').first().click();
            await expect(editor.detail).toBeVisible();
            await editor.back();
            await expect(panel).toHaveClass(/is-open/);
            await expect(page.locator('#sb-settings-page')).toBeHidden();
            await expect(panel.locator('[data-agent-id="editor-companion"] [data-action="panel-edit"]').first()).toBeFocused();
            expect(editor.saves()).toHaveLength(0);
        },
    );

    test(
        `${width}px Agent detail group, row, header, buttons and textarea match Persona`,
        async ({
            page,
            baseURL,
        }) => {
            const editor = await setup(page, baseURL, width);
            await editor.open('pre');
            const sample = root => root.evaluate((node, width) => {
                const read = (selector, properties) => {
                    const target = [...node.querySelectorAll(selector)].find(element => element.getClientRects().length);
                    const style = getComputedStyle(target);
                    return Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)]));
                };
                return {
                    group: read('.ds-pref-group', ['background-color', 'border-top-color', 'border-top-width', 'border-radius']),
                    row: read('.ds-pref-group .ds-row', ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']),
                    header: read('.sb-persona-entry-header', ['height', 'padding', 'gap']),
                    back: read('.sb-persona-detail-back', ['background-color', 'border-radius']),
                    save: read('.sb-persona-entry-save', ['background-color', 'border-radius']),
                    secondary: read('.sb-persona-entry-cancel', ['background-color', 'border-radius']),
                    // Round 2 enlarges only Agents' phone prompt; its minimum has a separate viewport regression.
                    textarea: read('.sb-persona-entry-textarea', [
                        'background-color', 'border-radius', 'padding', ...(width > 768 ? ['min-height'] : []),
                    ]),
                    title: read('.sb-persona-entry-name', ['height', 'min-width', 'font-size', 'font-weight', 'text-overflow']),
                    body: read('.sb-persona-entry-body', [
                        'padding-top',
                        'padding-right',
                        'padding-bottom',
                        'padding-left',
                        'gap',
                        'overflow-y',
                    ]),
                    firstHeadingInset: node.querySelector('.ds-pref-group-heading').getBoundingClientRect().top
                        - node.querySelector('.sb-persona-entry-body').getBoundingClientRect().top,
                };
            }, width);
            const headerLayout = root => root.locator('header').evaluate(header => {
                const visible = node => Boolean(node.getClientRects().length) && getComputedStyle(node).display !== 'none';
                return [...header.children].filter(visible).flatMap(node => {
                    if (node.matches('input')) return [{
                        kind: 'title',
                        label: node.getAttribute('aria-label'),
                        readOnly: node.readOnly,
                    }];
                    if (node.matches('.sb-persona-entry-modes')) return [{
                        kind: 'modes',
                        labels: [...node.querySelectorAll('label > span')].map(label => label.textContent),
                    }];
                    if (node.matches('.sb-persona-entry-dirty')) return [{ kind: 'dirty' }];
                    const buttons = node.matches('button') ? [node] : [...node.querySelectorAll('button')].filter(visible);
                    return buttons.map(button => ({
                        kind: 'button',
                        label: (button.getAttribute('aria-label') || button.textContent.trim()).replaceAll('...', '…'),
                    }));
                }).filter(control => !['Sections', 'Preview Prompt in Context', 'Refine…'].includes(control.label));
            });
            await expect(editor.name).toBeFocused();
            await expect(editor.detail.locator('.sb-persona-entry-header input[data-sb-editor-field="name"]')).toHaveCount(1);
            await expect(editor.detail.locator('.sb-persona-entry-body [data-sb-editor-field="name"]')).toHaveCount(0);
            await expect(editor.detail.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
            const longName = 'Long agent title '.repeat(20).trim();
            await editor.name.fill(longName);
            const agentLayoutDirty = await headerLayout(editor.detail);
            expect(await editor.prompt.evaluate(node => node.closest('.ds-pref-group'))).toBeNull();
            await expect(editor.detail.locator('.ica-agent-prompt-content .ds-row-text')).toHaveCount(0);
            await expect(editor.detail.locator('.sb-persona-entry-footer .editor_maximize')).toHaveCount(1);
            const geometry = await editor.detail.locator('header').evaluate(header => {
                const controls = [...header.querySelectorAll('input:not([type="radio"]), button')]
                    .filter(node => node.getClientRects().length);
                const bounds = controls.map(node => node.getBoundingClientRect());
                return {
                    overflow: header.scrollWidth - header.clientWidth,
                    overlap: bounds.some((rect, index) => index && bounds[index - 1].right > rect.left + 1),
                };
            });
            expect(geometry).toEqual({ overflow: 0, overlap: false });
            await editor.name.evaluate(node => node.setSelectionRange(10, 10));
            let pendingSave;
            await page.route('**/api/in-chat-agents/save', route => {
                pendingSave = route;
            }, { times: 1 });
            await page.keyboard.press('Control+s');
            await expect.poll(() => Boolean(pendingSave)).toBe(true);
            await expect(editor.detail).toHaveAttribute('aria-busy', 'true');
            await expect(editor.save).toBeDisabled();
            await expect(editor.discard).toBeDisabled();
            await expect(editor.name).toBeEditable();
            await pendingSave.fulfill({ json: {} });
            await expect(editor.detail).toHaveAttribute('aria-busy', 'false');
            await expect(editor.save).toBeDisabled();
            await expect(editor.name).toHaveValue(longName);
            await expect(editor.name).toBeFocused();
            expect(await editor.name.evaluate(node => node.selectionStart)).toBe(10);
            await editor.name.fill('Cancelled header edit');
            await editor.discard.click();
            await expect(editor.name).toHaveValue(longName);
            await expect(editor.name).toBeFocused();
            const mode = label => editor.detail.getByRole(modeRoles[width], { name: label, exact: true });
            await mode('Preview').click();
            await expectAgentHeaderIcons(editor.detail);
            await expect(editor.detail.locator('.ica-agent-prompt-preview')).toHaveText('Preserve {{char}} and whitespace');
            await expect(editor.prompt).toBeHidden();
            await mode('Edit').click();
            await expectAgentHeaderIcons(editor.detail);
            await expect(editor.prompt).toBeVisible();
            const agentLayout = await headerLayout(editor.detail);
            await page.mouse.move(1, 1);
            await page.evaluate(() => document.activeElement?.blur());
            await expect.poll(async () => (await sample(editor.detail)).back['background-color']).toBe('rgba(0, 0, 0, 0)');
            const agent = await sample(editor.detail);
            await editor.back();
            await page.evaluate(async () => {
                const { user_avatar } = await import('/scripts/personas.js');
                await window.SillyBunnyShell.openTab('characters', 'persona');
                await (await import('/scripts/sillybunny-persona-editor.js')).openPersonaEditor({ avatarId: user_avatar });
            });
            const persona = page.locator('#PersonaManagement .sb-persona-entry');
            await expect(persona).toBeVisible();
            await expect(persona.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused();
            expect(await headerLayout(persona)).toEqual(agentLayout);
            await persona.getByRole('textbox', { name: 'Name', exact: true }).fill(longName);
            expect(await headerLayout(persona)).toEqual(agentLayoutDirty);
            await persona.getByRole('button', { name: 'Cancel', exact: true }).click();
            await page.mouse.move(1, 1);
            await page.evaluate(() => document.activeElement?.blur());
            await expect.poll(() => sample(persona)).toEqual(agent);
            await screenshot(page, `persona-parity-${width}`);
        },
    );

    test(
        `${width}px property bar matches Prompt geometry and preserves Stage, Execution and Pin semantics`,
        async ({ page, baseURL }, testInfo) => {
            const editor = await setup(page, baseURL, width);
            await editor.open('pre');
            const agentGeometry = await samplePropertyGeometry(editor.detail, 'Category', 'Stage', 'Pin', 'Execution');
            const tasks = ['Sections', 'Preview Prompt in Context', 'Refine…'];
            const headerTasks = editor.detail.locator('.sb-persona-entry-actions > button:visible');
            const desktopLabels = [...tasks, 'More…'];
            const labelsByWidth = { 1440: desktopLabels, 390: ['More…'] };
            await expect.poll(() => headerTasks.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))))
                .toEqual(labelsByWidth[width]);
            const previewIcon = editor.detail.locator('[aria-label="Preview Prompt in Context"] > i');
            await expect(previewIcon).toHaveClass('fa-solid fa-file-lines');
            expect(await editor.detail.locator('[aria-label="Preview Prompt in Context"]').evaluate(node =>
                node.getAttribute('title') ?? node.getAttribute('data-sttt--title'),
            )).toBe('Preview Prompt in Context');
            await expectAgentHeaderIcons(editor.detail);
            await editor.back();
            for (const [id, category, companion] of [
                ['pre', 'custom', false],
                ['companion', 'companion', true],
                ['tracker', 'tracker', false],
                ['tool', 'tool', false],
            ]) {
                await editor.open(id);
                await openAgentProperties(editor.detail);
                const bar = page.locator('.ica-agent-properties:visible');
                await expect(bar.getByRole('button', { name: 'Category', exact: true }))
                    .toHaveText(category[0].toUpperCase() + category.slice(1));
                const stage = bar.locator('[data-sb-editor-field="phase"]');
                await expect(stage).toBeVisible({ visible: !companion });
                const execution = bar.getByRole('group', { name: 'Execution', exact: true });
                await expect(execution).toHaveAttribute('aria-disabled', String(companion));
                for (const radio of await execution.getByRole('radio').all()) {
                    await expect(radio).toHaveJSProperty('disabled', companion);
                }
                await expect(bar.getByRole('switch', { name: 'Pin', exact: true })).not.toBeChecked();
                await expect(editor.detail.locator('.sb-persona-entry-body [data-sb-editor-field="category"]')).toHaveCount(0);
                await closeAgentProperties(page);
                await expect(page.locator('.ica-agent-property-sheet')).toBeHidden();
                expect(await editor.detail.evaluate(node => {
                    const summary = node.querySelector('.ica-agent-property-summary');
                    return !summary.getClientRects().length || document.activeElement === summary;
                })).toBe(true);
                await expect(editor.detail).toBeVisible();
                await editor.back();
            }
            await editor.open('pre');
            await openAgentProperties(editor.detail);
            const bar = page.locator('.ica-agent-properties:visible');
            await bar.getByRole('radio', { name: 'Both', exact: true }).check();
            await bar.getByRole('switch', { name: 'Pin', exact: true }).check();
            const execution = bar.getByRole('group', { name: 'Execution', exact: true });
            await execution.getByRole('radio', { name: 'Companion', exact: true }).check();
            await expect(bar.locator('[data-sb-editor-field="phase"]')).toBeHidden();
            await expect(execution.getByRole('radio', { name: 'Inline', exact: true })).toBeEnabled();
            await chooseAgentCategory(page, bar, 'Companion');
            await expect(execution.getByRole('radio', { name: 'Inline', exact: true })).toBeDisabled();
            await expect(execution.getByRole('radio', { name: 'Companion', exact: true })).toBeChecked();
            await chooseAgentCategory(page, bar, 'Custom');
            await execution.getByRole('radio', { name: 'Inline', exact: true }).check();
            await expect(bar.getByRole('radio', { name: 'Both', exact: true })).toBeChecked();
            await closeAgentProperties(page);
            await editor.save.click();
            await expect(editor.detail).toHaveAttribute('aria-busy', 'false');
            expect(editor.saves()).toHaveLength(1);
            expect(editor.saves()[0]).toMatchObject({ category: 'custom', execution: 'inline', phase: 'both', favorite: true });
            await editor.back();
            await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'editor'));
            await page.locator('button[data-sb-settings-tab="editor"]').evaluate(node => node.click());
            await page.locator('.sb-prompt-row[data-prompt-id="main"] .sb-prompt-row-name').click();
            const prompt = page.locator('.sb-prompt-detail');
            await expect(prompt).toBeVisible();
            const promptGeometry = await samplePropertyGeometry(prompt, 'Role', 'Position', 'Forbid overrides');
            await testInfo.attach('Q54 property geometry', {
                body: JSON.stringify({ width, agents: agentGeometry, prompt: promptGeometry }, null, 2),
                contentType: 'application/json',
            });
            expect(agentGeometry).toEqual(promptGeometry);
        },
    );

    test(
        `${width}px Prompt editor Send to agents creates a disabled custom entry`,
        async ({
            page,
            baseURL,
        }) => {
            const editor = await setup(page, baseURL, width);
            await page.evaluate(() => window.dispatchEvent(new CustomEvent(
                'PromptManagerSendToAgents',
                {
                    detail: {
                        prompt: {
                            name: 'Sent prompt',
                            content: 'QA sent prompt',
                            role: 'user',
                            injection_position: 1,
                            injection_depth: 4,
                            injection_order: 37,
                            injection_trigger: ['quiet'],
                        },
                    },
                },
            )));
            await expect.poll(() => editor.saves().length).toBe(1);
            expect(editor.saves()[0]).toMatchObject({
                name: 'Sent prompt',
                prompt: 'QA sent prompt',
                enabled: false,
                category: 'custom',
                injection: {
                    role: 1,
                    position: 1,
                    depth: 4,
                    order: 37,
                },
                conditions: { generationTypes: ['quiet'] },
            });
            await expect(editor.root.locator(`[data-sb-list-key="agent:${editor.saves()[0].id}"]`)).toHaveAttribute('aria-label', 'Sent prompt');
            await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'editor'));
            await page.locator('button[data-sb-settings-tab="editor"]').evaluate(node => node.click());
            await page.locator('.sb-prompt-row[data-prompt-id="main"] .sb-prompt-row-name').click();
            const promptDetail = page.locator('.sb-prompt-detail');
            await expect(promptDetail).toBeVisible();
            const content = await promptDetail.getByRole('textbox', { name: 'Prompt content', exact: true }).inputValue();
            const name = await promptDetail.getByRole('textbox', { name: 'Prompt name', exact: true }).inputValue();
            await activatePromptAction(page, promptDetail, 'Send to agents');
            await expect.poll(() => editor.saves().length).toBe(2);
            expect(editor.saves()[1]).toMatchObject({ name, prompt: content, enabled: false, category: 'custom' });
            await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'agents'));
            await page.locator('button[data-sb-settings-tab="agents"]').evaluate(node => node.click());
            await expect(editor.root.locator(`[data-sb-list-key="agent:${editor.saves()[1].id}"]`)).toHaveAttribute('aria-label', name);
        },
    );
}
