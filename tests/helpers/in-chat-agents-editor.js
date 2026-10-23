import { expect } from '@playwright/test';
import { agentFixture, toolFixture } from '../fixtures/in-chat-agents-editor.js';

const READS = new Set([
    '/api/settings/get',
    '/api/characters/all',
    '/api/characters/get',
    '/api/characters/chats',
    '/api/groups/all',
    '/api/backgrounds/all',
    '/api/avatars/get',
    '/api/stats/get',
    '/api/secrets/read',
    '/api/secrets/settings',
    '/api/users/me',
    '/api/extensions/discover',
    '/api/worldinfo/get',
    '/api/worldinfo/list',
    '/api/themes/all',
    '/api/presets/list',
    '/api/in-chat-agents/groups/list',
    '/api/chats/search',
]);

const common = ['general', 'prompt'];
const tail = ['regex', 'conditions'];
const companion = [
    ...common,
    'companion-output',
    'companion-context',
    'companion-chat-history',
    'companion-feedback',
    'companion-coordination',
];

export const editorCases = [
    {
        id: 'pre',
        groups: [...common, 'before', ...tail],
    },
    {
        id: 'both',
        fields: { phase: 'both' },
        groups: [...common, 'before', 'after', ...tail],
    },
    {
        id: 'post',
        fields: { phase: 'post' },
        groups: [...common, 'after', ...tail],
    },
    ...['replace', 'wrap', 'patch'].map(applyMode => ({
        id: applyMode,
        fields: {
            preProcess: {
                mode: 'intercept',
                applyMode,
            },
        },
        groups: [...common, 'before', ...tail],
    })),
    {
        id: 'companion',
        fields: {
            category: 'companion',
            execution: 'companion',
            phase: 'post',
        },
        groups: [...companion, ...tail],
    },
    {
        id: 'tracker',
        fields: { category: 'tracker' },
        groups: [...common, 'tracker-builder', 'before', ...tail],
    },
    {
        id: 'tool',
        fields: {
            category: 'tool',
            tools: [toolFixture()],
        },
        groups: [...common, 'before', ...tail],
    },
    ...[
        [
            'chatroom',
            'tpl-chatroom-companion',
            {
                chatroomStyle: 'custom',
                chatroomCustomStyles: 'QA: Test style',
                chatroomCustomStyleName: 'QA',
            },
        ],
        [
            'director',
            'tpl-directors-commentary-companion',
            {
                directorCommentaryVoice: 'custom',
                directorCommentaryCustomVoices: 'QA: Test voice',
                directorCommentaryCustomVoiceName: 'QA',
            },
        ],
        ['plot', 'tpl-plot-compass-companion', { plotCompassObjective: 'QA objective' }],
    ].map(([id, sourceTemplateId, settings]) => ({
        id,
        fields: {
            category: 'companion',
            execution: 'companion',
            sourceTemplateId,
            settings,
        },
        groups: [...companion, 'template-options', ...tail],
    })),
];

export async function chooseAgentTemplate(page, root, { name = null, companion = false } = {}) {
    const title = companion ? 'New Companion from Template' : 'New Agent from Template';
    await root.getByRole('button', { name: 'Add Agent', exact: true }).click();
    await expectAgentMenuIcons(page);
    await page.getByRole('menuitem', { name: `${title}…`, exact: true }).click();
    const picker = page.getByRole('dialog', { name: title, exact: true });
    await expect(picker.getByRole('combobox')).toBeFocused();
    if (name) await picker.getByRole('combobox').fill(name);
    const option = name ? picker.getByRole('option').filter({ has: page.getByText(name, { exact: true }) }) : picker.getByRole('option').first();
    const label = await option.locator('.sb-picker__label').textContent();
    await option.click();
    await expect(root.locator('.ica-agent-detail')).toBeVisible();
    return label;
}

export async function expectAgentMenuIcons(page) {
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.fa-puzzle-piece, .fa-undefined')).toHaveCount(0);
    for (const item of await menu.getByRole('menuitem', { exact: true }).all()) {
        const icon = item.locator(':scope > i.fa-solid');
        await expect(icon).toHaveCount(1);
        const content = await icon.evaluate(node => getComputedStyle(node, '::before').content);
        expect(content).not.toBe('none');
        expect(content).not.toBe('normal');
        expect(content).not.toBe('""');
    }
}

export async function seedEditorAgents(page) {
    const agents = editorCases.map(({
        id,
        fields,
    }) => agentFixture({
        ...fields,
        id: `editor-${id}`,
        name: `Editor ${id}`,
        enabled: id === 'companion',
        connectionProfile: 'editor-mock-profile',
    }));
    await page.evaluate(
        async agents => {
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            store.loadAgents(agents);
            store.setGlobalSettings({
                enabled: true,
                separateRecentChats: false,
            });
            (await import('/scripts/extensions/in-chat-agents/ui/agent-list.js')).refreshAgentsPanels();
            window.$('#themes').val('Libadwaita').trigger('change');
            await window.SillyBunnyShell.openTab('left', 'agents');
        },
        agents,
    );
    await page.locator('button[data-sb-settings-tab="agents"]').evaluate(node => node.click());
    await expect(page.locator('.ica-agents-editor')).toBeVisible();
}

export async function openEditorAgents(page, baseURL, width, { seed = true } = {}) {
    if (new URL(baseURL).port !== '4455') throw new Error('Agent editor QA requires the isolated 4455 instance');
    const origin = new URL(baseURL).origin;
    const writes = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({
        width,
        height: 1000,
    });
    // Deny by default before the first navigation, including reloads and model calls.
    await page.context().route(
        '**/*',
        async route => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.origin !== origin) return route.abort();
            if (!url.pathname.startsWith('/api/') || request.method() === 'GET') return route.continue();
            if (READS.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')) return route.continue();
            if (/^\/api\/chats\/(?:group\/)?get$/.test(url.pathname) && request.postDataJSON()?.allow_create !== true) {
                return route.continue();
            }
            const body = request.postDataJSON();
            writes.push({
                path: url.pathname,
                body,
            });
            return route.fulfill({
                json: url.pathname === '/api/settings/save' ? {
                    result: 'ok',
                    version: Number(body?._version ?? 0) + 1,
                } : {},
            });
        },
    );
    await page.context().route('**/api/horde/text-models', route => route.fulfill({ json: [] }));
    await page.addInitScript(() => {
        window.__editorMaxDialogs = 0;
        document.addEventListener(
            'DOMContentLoaded',
            () => {
                new MutationObserver(() => {
                    window.__editorMaxDialogs = Math.max(window.__editorMaxDialogs, document.querySelectorAll('dialog[open]').length);
                }).observe(
                    document.body,
                    {
                        childList: true,
                        subtree: true,
                        attributes: true,
                        attributeFilter: ['open'],
                    },
                );
            },
        );
    });
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await waitForEditorApp(page);
    if (seed) await seedEditorAgents(page);
    else {
        await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'agents'));
        await page.locator('button[data-sb-settings-tab="agents"]').evaluate(node => node.click());
        await expect(page.locator('.ica-agents-editor')).toBeVisible();
    }
    writes.length = 0;
    const root = page.locator('.ica-agents-editor');
    const detail = root.locator('.ica-agent-detail');
    return {
        root,
        detail,
        writes,
        errors,
        saves: () => writes.filter(write => write.path === '/api/in-chat-agents/save').map(write => write.body),
        name: detail.getByRole('textbox', {
            name: 'Name',
            exact: true,
        }),
        prompt: detail.getByRole('textbox', {
            name: 'Prompt',
            exact: true,
        }),
        save: detail.getByRole('button', {
            name: 'Save',
            exact: true,
        }),
        discard: detail.getByRole('button', {
            name: 'Cancel',
            exact: true,
        }),
        async open(id) {
            await root.locator(`[data-sb-list-key="agent:editor-${id}"]`).evaluate(node => node.click());
            await expect(detail).toBeVisible();
        },
        async back() {
            await detail.getByRole('button', {
                name: 'Back',
                exact: true,
            }).click();
            await expect(detail).toHaveCount(0);
        },
    };
}

export async function waitForEditorApp(page) {
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'));
}

export async function activatePromptAction(page, detail, label) {
    const direct = detail.getByRole('button', { name: label, exact: true });
    if (await direct.isVisible()) return direct.click();
    await detail.getByRole('button', { name: 'More prompt actions', exact: true }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
}

export async function activateAgentEditorAction(page, detail, label) {
    const direct = detail.getByRole('button', { name: label, exact: true });
    if (await direct.isVisible()) return direct.click();
    await detail.getByRole('button', { name: 'More…', exact: true }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
}

export async function openAgentProperties(detail) {
    const summary = detail.locator('.ica-agent-property-summary');
    if (await summary.isVisible()) await summary.click();
}

export async function closeAgentProperties(page) {
    const sheet = page.locator('.ica-agent-property-sheet');
    if (await sheet.isVisible()) await page.keyboard.press('Escape');
}

export async function chooseAgentCategory(page, bar, label) {
    await bar.getByRole('button', { name: 'Category', exact: true }).click();
    await page.getByRole('listbox', { name: 'Category', exact: true }).getByRole('option', { name: label, exact: true }).click();
}

export async function sampleDropdownTrigger(trigger) {
    await trigger.page().mouse.move(1, 1);
    await trigger.evaluate(node => node.blur());
    return trigger.evaluate(node => {
        const read = (target, properties) => {
            const style = getComputedStyle(target);
            return Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)]));
        };
        return {
            tag: node.tagName,
            trigger: read(node, [
                'display', 'align-items', 'justify-content', 'gap', 'height', 'width', 'min-width', 'max-width',
                'padding', 'margin', 'color', 'background-color', 'border', 'border-radius', 'box-shadow',
                'font-family', 'font-size', 'font-weight', 'line-height',
            ]),
            label: read(node.querySelector(':scope > span'), ['color', 'overflow', 'text-overflow', 'white-space']),
            chevron: read(node.querySelector(':scope > i'), ['color', 'font-size', 'width', 'height']),
        };
    });
}

export async function samplePropertyPopover(popover, trigger) {
    await popover.page().mouse.move(1, 1);
    return popover.evaluate((node, trigger) => {
        const read = (target, properties) => {
            const style = getComputedStyle(target);
            return Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)]));
        };
        const selected = node.querySelector('[aria-selected="true"]');
        const unselected = node.querySelector('[aria-selected="false"]');
        const properties = [
            'display', 'align-items', 'gap', 'min-height', 'padding', 'border-radius', 'background-color',
            'color', 'font-family', 'font-size', 'font-weight', 'line-height', 'cursor',
        ];
        const rect = trigger.getBoundingClientRect();
        const bounds = node.getBoundingClientRect();
        const width = Math.min(Math.max(208, rect.width), innerWidth - 16);
        const left = Math.max(8, Math.min(rect.left, innerWidth - width - 8));
        const top = innerHeight - rect.bottom > node.offsetHeight + 14
            ? rect.bottom + 6 : Math.max(8, rect.top - node.offsetHeight - 6);
        return {
            popover: read(node, [
                'position', 'z-index', 'width', 'max-height', 'overflow', 'padding', 'border', 'border-radius',
                'background-color', 'color', 'font-family', 'box-shadow', 'transform-origin', 'outline',
            ]),
            selected: read(selected, properties),
            unselected: read(unselected, properties),
            selectedIcon: read(selected.querySelector('i'), ['color', 'width', 'visibility', 'font-family', 'font-size']),
            unselectedIcon: read(unselected.querySelector('i'), ['color', 'width', 'visibility', 'font-family', 'font-size']),
            placement: { width: bounds.width, leftDelta: bounds.left - left, topDelta: bounds.top - top },
            aria: {
                haspopup: trigger.getAttribute('aria-haspopup'),
                expanded: trigger.getAttribute('aria-expanded'),
                role: node.getAttribute('role'),
                tabIndex: node.tabIndex,
                focused: document.activeElement === node,
                activeSelected: document.getElementById(node.getAttribute('aria-activedescendant')) === selected,
                selectedCount: node.querySelectorAll('[role="option"][aria-selected="true"]').length,
                allOptions: [...node.children].every(option => option.getAttribute('role') === 'option'),
            },
        };
    }, await trigger.elementHandle());
}

export async function sampleListboxKeyboard(trigger, listbox) {
    const selectedText = await listbox.getByRole('option', { selected: true }).textContent();
    const movement = [];
    for (const key of ['Home', 'ArrowUp', 'ArrowDown', 'End', 'ArrowUp']) {
        await listbox.press(key);
        movement.push(await listbox.evaluate(node => {
            const options = [...node.querySelectorAll('[role="option"]')];
            const active = document.getElementById(node.getAttribute('aria-activedescendant'));
            const index = options.indexOf(active);
            return {
                active: index === 0 ? 'first' : index === options.length - 1 ? 'last' : 'middle',
                focused: document.activeElement === node,
            };
        }));
        await expect(listbox.getByRole('option', { selected: true })).toHaveText(selectedText);
    }
    await listbox.press('Escape');
    await expect(listbox).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.press('ArrowUp');
    await expect(listbox).toBeFocused();
    await listbox.press('Tab');
    await expect(listbox).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    const tabRestoredTrigger = await trigger.evaluate(node => document.activeElement === node);
    for (const key of ['Enter', 'Space']) {
        await trigger.press(key);
        await expect(listbox).toBeFocused();
        await listbox.press(key);
        await expect(listbox).toBeHidden();
        await expect(trigger).toBeFocused();
    }
    return { movement, tabRestoredTrigger };
}

export async function expectAgentHeaderIcons(detail) {
    const icons = await detail.locator('.sb-persona-entry-header button:visible > i').evaluateAll(nodes => nodes.map(node =>
        [...node.classList].find(name => name.startsWith('fa-') && name !== 'fa-solid'),
    ));
    expect(new Set(icons).size).toBe(icons.length);
}

export async function samplePropertyGeometry(root, categoryLabel, segmentedLabel, switchLabel, secondSegmentedLabel = segmentedLabel) {
    return root.evaluate((root, labels) => {
        const visible = node => Boolean(node.getClientRects().length);
        const read = (node, properties) => Object.fromEntries(properties.map(key => [key, getComputedStyle(node).getPropertyValue(key)]));
        const bar = root.querySelector('.sb-prompt-properties');
        const summary = root.querySelector('.sb-prompt-property-summary');
        const output = {};
        if (visible(summary)) {
            output.summary = read(summary, ['height', 'min-height', 'padding', 'border-bottom-width', 'font-size', 'font-weight']);
        }
        if (visible(bar)) {
            const property = label => [...bar.querySelectorAll('.sb-prompt-property')]
                .find(node => node.firstElementChild.textContent === label);
            const select = property(labels[0]);
            const segmented = property(labels[1]);
            const toggle = property(labels[2]);
            const secondSegmented = property(labels[3]);
            output.bar = read(bar, ['height', 'padding', 'gap', 'border-bottom-width']);
            output.label = read(select.firstElementChild, ['font-size', 'font-weight', 'line-height', 'color']);
            output.select = read(select.lastElementChild, ['height', 'min-height', 'padding', 'font-size']);
            output.segmented = read(segmented.lastElementChild, ['height', 'padding']);
            output.segment = read(segmented.querySelector('label > span'), ['height', 'padding', 'min-height', 'font-size']);
            output.secondSegmented = read(secondSegmented.lastElementChild, ['height', 'padding']);
            output.secondSegment = read(secondSegmented.querySelector('label > span'), ['height', 'padding', 'min-height', 'font-size']);
            output.labels = [...bar.querySelectorAll('.sb-prompt-property > span')].filter(visible)
                .map(node => read(node, ['font-size', 'font-weight', 'line-height', 'color']));
            output.switch = read(toggle.lastElementChild, ['height', 'width']);
        }
        return output;
    }, [categoryLabel, segmentedLabel, switchLabel, secondSegmentedLabel]);
}

export async function mockEditorModel(page) {
    await page.evaluate(() => {
        window.__editorModelCalls = 0;
        const service = window.SillyTavern.getContext().ConnectionManagerRequestService;
        service.sendRequest = async (_profile, messages) => {
            window.__editorModelCalls++;
            const system = messages[0].content;
            const content = system.includes('tracker agent kits') ? JSON.stringify({
                name: 'Mock tracker',
                prompt: 'Mock tracker prompt',
                phase: 'both',
                postProcess: {
                    extractPattern: '\\[TRACKER\\|[^]+',
                    extractVariable: 'mock_tracker',
                },
                regexScripts: [{
                    scriptName: 'Mock regex',
                    findRegex: '/QA/g',
                    replaceString: '<b>QA</b>',
                    placement: [2],
                }],
            }) : system.includes('companion') ? JSON.stringify({
                name: 'Mock companion',
                prompt: 'Mock companion prompt',
                companion: { format: 'text' },
            }) : 'Mock refined prompt';
            return { content };
        };
    });
}
