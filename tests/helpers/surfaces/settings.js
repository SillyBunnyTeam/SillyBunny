/**
 * The settings family: the twelve pages of the Backend and Customize shells, and the three panes that behave like
 * settings pages (World Info Global Settings, Persona Global Settings, the Conversation settings panel).
 *
 * Backend (Connections, Sampling, Presets) changes these pages, so each of them lists `backends` and its `open` reads
 * `ctx.backend`. The backend is a parameter of the surface, not a state: states are things that open on top of a page.
 * Every shell page has one state, `expanded`, which opens every expander of the page at once (a capture per expander
 * would be dozens of images per page) and fails if one stays closed. Agents and Extensions add the subpages that open over
 * them. A page's `ready` names an element that exists only once the page has built its content, and for the pages that
 * differ by backend, the block that belongs to the backend.
 */

import { viewportById } from '../surface-matrix.js';
import { alternatingMessages, seedConversation } from '../conversation-seed.js';
import { FIXTURES } from './fixture-data.js';
import { BACKENDS, DEFAULT_BACKEND } from './schema.js';
import { chooseMenuItem, expandAll, openCharactersTab, openExtensionsList, openSettingsTab, selectBackend, selectLogitBiasPreset, settle } from './steps.js';

const BACKEND_IDS = Object.keys(BACKENDS);
/** The Presets page differs between sources only by a toggle, so it keeps the four backends and not the extra Text Completion sources. */
const PRESET_BACKEND_IDS = ['chat-completion', 'text-completion', 'novelai', 'horde'];
const SCRIPTS = 'public/scripts';

const backendOf = ctx => BACKENDS[ctx.backend ?? DEFAULT_BACKEND];
const modePill = (selector, ctx) => `${selector}:has-text("Backend: ${backendOf(ctx).modeLabel}")`;

/** Runs a wait after the open step of an entry, for content that the page fills in after it shows. */
function afterOpen(entry, wait) {
    const open = entry.open;
    return {
        ...entry,
        async open(page, ctx) {
            await open(page, ctx);
            await wait(page, ctx ?? {});
        },
    };
}

/** The console lines that the Logs page shows: the server's log grows with every request, so its length and the page count of the capture would not repeat. */
const FIXED_LOG = {
    entries: Array.from({ length: 24 }, (_, index) => ({ id: index + 1, timestamp: 1_769_990_400_000 + index * 1000, stream: 'stdout', message: `Audit console line ${index + 1}` })),
    latestId: 24,
    totalBuffered: 24,
    captureStartedAt: 1_769_990_400_000,
    truncated: false,
};
const LOG_ROUTE = '**/api/server-admin/logs';

/** Answers the log requests of the page with `FIXED_LOG` from the moment the entry is opened. The page is not given back before the test ends, so the route stays. */
function withFixedConsoleLog(entry) {
    const open = entry.open;
    return {
        ...entry,
        async open(page, ctx) {
            await page.route(LOG_ROUTE, route => route.fulfill({ json: FIXED_LOG }));
            await open(page, ctx);
        },
    };
}

/**
 * A page of the Backend or Customize shell.
 * @param {object} page
 * @param {string} page.id Last two segments of the id.
 * @param {'left' | 'right'} page.shell `left` is Backend, `right` is Customize.
 * @param {string} page.tab The value of `data-sb-settings-tab`.
 */
function shellPage({ id, title, shell, tab, sources, upstreamMarkup = false, backends, masks, ready, states = [], needs = [] }) {
    const root = `[data-sb-panel="${tab}"]`;
    return {
        id: `settings.${id}`,
        family: 'settings',
        owner: 'A',
        ...(upstreamMarkup && { upstreamMarkup }),
        title,
        root,
        ready,
        async open(page, ctx = {}) {
            if (backends) {
                await selectBackend(page, ctx.backend ?? DEFAULT_BACKEND);
            }
            await openSettingsTab(page, { shell, tab });
        },
        states: [
            { id: 'expanded', open: page => expandAll(page, `${root} .sb-shell-panel-scroller`) },
            ...states,
        ],
        ...(masks && { masks }),
        ...(backends && { backends }),
        needs,
        sources,
        primaryFlow: true,
    };
}

const AGENT_PAGES = '[data-sb-panel="agents"] .ica-agents-editor';

/** Leaves a page that the Agents menu pushed over the list, if one is open. */
async function backToAgentList(page) {
    const back = page.locator(`${AGENT_PAGES} [data-agent-page]`).getByRole('button', { name: 'Back', exact: true });
    if (await back.count()) {
        await back.click();
        await page.locator(`${AGENT_PAGES} [data-agent-page]`).waitFor({ state: 'detached' });
    }
}

/**
 * A page of the Agents menu, such as Settings or Agent Groups. From `in-chat-agents-pages.e2e.js` (`destination`).
 * @param {string} id The `data-agent-page` value.
 * @param {string} label The menu item.
 */
function agentsPage(id, label) {
    return {
        id: `${id}-page`,
        root: `${AGENT_PAGES} [data-agent-page="${id}"]`,
        ready: `${AGENT_PAGES} [data-agent-page="${id}"] :is(button, input, select, textarea)`,
        async open(page) {
            await backToAgentList(page);
            await page.locator(AGENT_PAGES).getByRole('button', { name: 'Agents Menu', exact: true }).click();
            await page.locator('.sb-action-menu').last().getByRole('menuitem', { name: label, exact: true }).click();
            await page.locator(`${AGENT_PAGES} [data-agent-page="${id}"]`).waitFor({ state: 'visible' });
            await settle(page);
        },
    };
}

const EXTENSIONS_PANEL = '[data-sb-panel="extensions"]';

/** Opens the page on its list, whatever an earlier state left open over it. */
function withExtensionsList(entry) {
    return { ...entry, open: openExtensionsList };
}

/**
 * Pane of the Characters shell that opens from a header menu: World Info Global Settings and Persona Global Settings.
 */
function characterShellPane({ id, title, tab, host, trigger, root, back, ready, needs, sources }) {
    return {
        id: `settings.${id}`,
        family: 'settings',
        owner: 'A',
        title,
        root: `${host} ${root}`,
        ...(ready && { ready }),
        async open(page) {
            await openCharactersTab(page, tab);
            await page.locator(`${host} ${trigger}`).waitFor({ state: 'visible' });
            await chooseMenuItem(page, `${host} ${trigger}`, 'Global Settings');
            await page.locator(`${host} ${root}`).waitFor({ state: 'visible' });
            await settle(page);
        },
        async close(page) {
            await page.locator(`${host} ${back}`).click();
            await page.locator(`${host} ${root}`).waitFor({ state: 'hidden' });
        },
        needs,
        sources,
        primaryFlow: true,
    };
}

/**
 * Opens the Conversation workspace for the audit character and shows its settings. From `foundation/conversation-mode.e2e.js`:
 * a desktop window has a settings button in the header, and a phone has pages, where the settings sit in the Conversation menu.
 */
async function openConversationSettings(page) {
    await page.evaluate(async (avatar) => {
        const context = window.SillyTavern.getContext();
        if (!context.characters.length) {
            await context.getCharacters();
        }
        const index = context.characters.findIndex(character => character.avatar === avatar);
        if (index < 0) {
            throw new Error(`The audit character ${avatar} is not on the server.`);
        }
        await context.selectCharacterById(index, { switchMenu: false });
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    }, FIXTURES.character.avatar);
    await seedConversation(page, { avatar: FIXTURES.character.avatar, chats: [{ messages: alternatingMessages(FIXTURES.chat.messages) }] });
    await page.evaluate(async (avatar) => {
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        if (!await openConversationWorkspaceForAvatar(avatar, { showToast: false, enable: true })) {
            throw new Error(`Could not open the Conversation workspace for ${avatar}.`);
        }
    }, FIXTURES.character.avatar);
    await page.locator('#sheld[data-sb-conversation-mode="on"]').waitFor({ state: 'visible' });
    await page.locator('#sb_conversation_timeline .sb-conversation-message').first().waitFor({ state: 'visible' });
    const layout = await page.locator('#sheld').getAttribute('data-sb-conversation-layout');
    if (layout === 'pages') {
        await page.locator('[data-sb-conversation-action="open-conversation-menu"]').click();
        await page.locator('.sb-action-menu-item', { hasText: 'Conversation settings' }).click();
    } else {
        await page.locator('[data-sb-conversation-action="open-settings"]').click();
    }
    await page.locator('#sb_conversation_settings_drawer').waitFor({ state: 'visible' });
    await settle(page);
}

/** @type {import('./index.js').Surface[]} */
export const surfaces = [
    shellPage({
        id: 'backend.connections',
        title: 'Backend: Connections',
        shell: 'left',
        tab: 'connections',
        ready: ctx => `[data-sb-panel="connections"] ${backendOf(ctx).connector}`,
        upstreamMarkup: true,
        backends: BACKEND_IDS,
        masks: ['[data-sb-panel="connections"] .ds-row:has(select[id*="model"])', '[data-sb-panel="connections"] .online_status'],
        sources: [`${SCRIPTS}/sillybunny-connections-form.js`, `${SCRIPTS}/sillybunny-connections-panel.js`],
    }),
    afterOpen(shellPage({
        id: 'backend.sampling',
        title: 'Backend: Sampling',
        shell: 'left',
        tab: 'sampling',
        ready: ctx => modePill('[data-sb-panel="sampling"] .sb-sampling-mode-pill:visible', ctx),
        upstreamMarkup: true,
        backends: BACKEND_IDS,
        needs: ['logit-bias'],
        sources: [`${SCRIPTS}/sillybunny-tabs.js`],
    }), async (page, ctx) => {
        // Chat Completions is the backend that has the logit bias list.
        if ((ctx.backend ?? DEFAULT_BACKEND) === 'chat-completion') {
            await selectLogitBiasPreset(page);
        }
    }),
    shellPage({
        id: 'backend.presets',
        title: 'Backend: Presets',
        shell: 'left',
        tab: 'prompting',
        ready: ctx => modePill('[data-sb-panel="prompting"] [data-sb-prompting-mode]', ctx),
        upstreamMarkup: true,
        backends: PRESET_BACKEND_IDS,
        sources: [`${SCRIPTS}/sillybunny-tabs.js`],
    }),
    shellPage({
        id: 'backend.editor',
        title: 'Backend: Editor (page chrome)',
        shell: 'left',
        tab: 'editor',
        ready: ['[data-sb-panel="editor"] [data-sb-editor-mode]', '[data-sb-panel="editor"] .sb-prompt-list-header .sb-list-header__title'],
        sources: [`${SCRIPTS}/sillybunny-prompt-editor.js`],
    }),
    shellPage({
        id: 'backend.formatting',
        title: 'Backend: Formatting',
        shell: 'left',
        tab: 'context',
        upstreamMarkup: true,
        sources: [`${SCRIPTS}/sillybunny-tabs.js`],
    }),
    shellPage({
        id: 'backend.agents',
        title: 'Backend: Agents (page chrome and subpages)',
        shell: 'left',
        tab: 'agents',
        ready: `${AGENT_PAGES} >> role=button[name="Agents Menu"]`,
        sources: [`${SCRIPTS}/extensions/in-chat-agents/ui/agent-list.js`, `${SCRIPTS}/extensions/in-chat-agents/ui/settings-page.js`, `${SCRIPTS}/extensions/in-chat-agents/ui/groups-page.js`],
        states: [
            agentsPage('settings', 'Settings'),
            agentsPage('groups', 'Agent Groups'),
            agentsPage('companions', 'Companions Overview'),
        ],
    }),
    shellPage({
        id: 'customize.appearance',
        title: 'Customize: Appearance',
        shell: 'right',
        tab: 'appearance',
        upstreamMarkup: true,
        sources: [`${SCRIPTS}/sillybunny-tabs.js`, `${SCRIPTS}/sillybunny-settings-presentation.js`],
    }),
    withExtensionsList(shellPage({
        id: 'customize.extensions',
        title: 'Customize: Extensions (list and detail pages)',
        shell: 'right',
        tab: 'extensions',
        ready: `${EXTENSIONS_PANEL} .sb-subpage-row:visible`,
        upstreamMarkup: true,
        sources: [`${SCRIPTS}/sillybunny-settings-subpage.js`, `${SCRIPTS}/sillybunny-settings-subpage-descriptors.js`],
        states: [{
            id: 'detail-page',
            root: `${EXTENSIONS_PANEL} .sb-subpage-detail[aria-hidden="false"]`,
            async open(page) {
                await page.locator(`${EXTENSIONS_PANEL} .sb-subpage-row:visible`).first().click();
                await page.locator(`${EXTENSIONS_PANEL} .sb-subpage-detail[aria-hidden="false"]`).waitFor({ state: 'visible' });
                await settle(page);
            },
        }],
    })),
    shellPage({
        id: 'customize.interface',
        title: 'Customize: Interface',
        shell: 'right',
        tab: 'interface',
        upstreamMarkup: true,
        sources: [`${SCRIPTS}/sillybunny-tabs.js`, `${SCRIPTS}/sillybunny-settings-content.js`],
    }),
    shellPage({
        id: 'customize.messages',
        title: 'Customize: Messages',
        shell: 'right',
        tab: 'messages',
        upstreamMarkup: true,
        sources: [`${SCRIPTS}/sillybunny-settings-content.js`],
    }),
    afterOpen(shellPage({
        id: 'customize.data-security',
        title: 'Customize: Data & Security',
        shell: 'right',
        tab: 'data-security',
        ready: '[data-sb-panel="data-security"] button:has-text("Usage Stats")',
        masks: ['[data-sb-panel="data-security"] .sb-server-stat-value', '[data-sb-panel="data-security"] .sb-server-pill', '[data-sb-panel="data-security"] .sb-server-note', '[data-sb-panel="data-security"] .ds-row:has(select)', '[data-sb-panel="data-security"] #version_display'],
        sources: [`${SCRIPTS}/sillybunny-data-security.js`, `${SCRIPTS}/sillybunny-server-tools.js`],
    }), async (page) => {
        // The version line is written when the server has answered, and its width moves the rows around it.
        await page.waitForFunction(() => Boolean(document.querySelector('[data-sb-panel="data-security"] #version_display')?.textContent.trim()), null, { timeout: 10_000 });
    }),
    withFixedConsoleLog(shellPage({
        id: 'customize.logs',
        title: 'Customize: Logs',
        shell: 'right',
        tab: 'logs',
        // The button rows sit under the console, below the fold of a phone, so the ready mark is the status row above it.
        ready: '[data-sb-panel="logs"] .sb-console-log-note',
        masks: ['[data-sb-panel="logs"] .sb-console-log-output', '[data-sb-panel="logs"] .sb-server-pill', '[data-sb-panel="logs"] .sb-console-log-note'],
        sources: [`${SCRIPTS}/sillybunny-server-tools.js`],
    })),
    characterShellPane({
        id: 'worldinfo.global',
        title: 'World Info Global Settings',
        tab: 'world-info',
        host: '#WorldInfo',
        trigger: '.sb-wi-book-actions',
        root: '.sb-wi-settings',
        back: '.sb-wi-settings .sb-wi-detail-back',
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-world-info-settings.js`],
    }),
    characterShellPane({
        id: 'persona.global',
        title: 'Persona Global Settings',
        tab: 'persona',
        host: '#PersonaManagement',
        trigger: '.sb-persona-list-menu',
        root: '.sb-persona-settings',
        back: '.sb-persona-settings .sb-persona-detail-back',
        // A phone or tablet shows the list or the settings pane, not both, so there the pane's own rows stand in for the fixture row.
        ready: ctx => (ctx.viewport && viewportById(ctx.viewport).pointer === 'coarse'
            ? '#PersonaManagement .sb-persona-settings .sb-persona-settings-switch'
            : `#PersonaManagement :text-is("${FIXTURES.persona.name}"):visible`),
        // The persona avatars on the server include those of `personas-many`, and the list names a persona that has no name `[Unnamed Persona]`
        // and sorts it first, which would push the fixture row to the second page. So the surface boots with both.
        needs: ['persona', 'personas-many'],
        sources: [`${SCRIPTS}/sillybunny-persona-settings.js`],
    }),
    {
        id: 'settings.characters.import',
        family: 'settings',
        owner: 'A',
        title: 'Characters shell: Import',
        root: '#sb_character_import_content',
        ready: ['#sb_character_import_drop', '#sb_character_import_urls', '#sb_character_import_url_action'],
        async open(page) {
            await openCharactersTab(page, 'import');
            await page.locator('#sb_character_import_panel[data-mounted="true"]').waitFor();
            await page.locator('#sb_character_import_content').waitFor({ state: 'visible' });
            await settle(page);
        },
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-character-import.js`, 'public/css/sillybunny-character-import.css'],
        primaryFlow: true,
    },
    {
        id: 'settings.conversation.panel',
        family: 'settings',
        owner: 'A',
        title: 'Conversation settings panel',
        root: '#sb_conversation_settings_drawer',
        // The edge of a switch changes by a few pixels between two screenshots of the same page, so that the capture never settles.
        masks: ['#sb_conversation_settings_drawer input.sb-switch'],
        open: openConversationSettings,
        async close(page) {
            await page.locator('[data-sb-conversation-action="close-settings"]').first().click();
            await page.locator('#sb_conversation_settings_drawer').waitFor({ state: 'hidden' });
        },
        needs: ['character'],
        sources: [`${SCRIPTS}/sillybunny-conversation/settings-panel.js`, `${SCRIPTS}/sillybunny-conversation/timeline-render.js`],
        primaryFlow: true,
    },
];
