/**
 * The lists of rows that a user acts on. Each entry's `root` is the list itself, the scroller that holds the rows, not the
 * header above it.
 *
 * The states are the ones that change how rows are laid out: a search or filter applied with results, a row menu open,
 * selection mode with rows selected, a collapsed folder, the grid view, the order controls (grips) that a list shows only in
 * some modes, and the page a row leads to inside a manager. Each state is opened on the page the previous one used, so every
 * opener in `list-steps.js` first puts its list in the state as found (no search, filter or selection, folders expanded).
 */

import { FIXTURES } from './fixture-data.js';
import { openGroupEditor } from './header-steps.js';
import { MOBILE_LAYOUT_VIEWPORTS } from './panel-steps.js';
import { chooseMenuItem, selectLogitBiasPreset, settle } from './steps.js';
import {
    AGENTS, ARCHIVE, CHAT_HISTORY, EXTENSIONS_MANAGER, FOLDER_MANAGER, MENU_ROOT, PERSONAS, TAG_MANAGER, WORLD_INFO,
    agentSearch, characterSearch, closeArchive, closeChatHistory, closeDataBank, closeExtensionsManager, closeManager, closeSwipePicker,
    openAgentList, openArchiveList, openBackgrounds, openChatHistory, openCharacterListView, openDataBank, openExtensionBlock, openExtensionsManager,
    openManager, openSamplingList, openPersonaList, openPromptList, openSearch, openSwipePicker, openWorldInfoEntries, personaSearch, promptSearch,
    scrollIntoView, searchFor, selectCharacterRows, settled, shown, waitForRowCount, worldInfoSearch,
} from './list-steps.js';

const SCRIPTS = 'public/scripts';
const CSS = 'public/css';
const EXTENSIONS = `${SCRIPTS}/extensions`;
const LIST_SHELL = [`${SCRIPTS}/sillybunny-editor/list-shell.js`, `${SCRIPTS}/sillybunny-editor/list-rows.js`, `${SCRIPTS}/sillybunny-editor/entity-row.js`];

/** Clicks the first visible trigger of a row menu and waits until the menu has finished opening. */
function rowMenu(trigger, rows) {
    return {
        id: 'row-menu',
        ready: [rows, MENU_ROOT],
        async open(page) {
            await page.locator(trigger).filter({ visible: true }).first().click();
            await shown(page, MENU_ROOT);
            // An animation that repeats for ever (a spinner) never finishes, so only motion that ends is awaited. A cancelled one rejects.
            await page.locator(MENU_ROOT).first().evaluate(node => Promise.all(node.getAnimations({ subtree: true })
                .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
                .map(animation => animation.finished.catch(() => {}))));
            await settle(page);
        },
    };
}

/** A search applied with results: `search` is the `{ input, toggle }` of the list, `rows` counts what is left. */
function searchResults({ search, query, rows, atMost, ready }) {
    return {
        id: 'search-results',
        ready: [ready ?? rows, search.input],
        open: page => searchFor(page, { ...search, query, rows, atMost }),
    };
}

/** The search of a window (Tag Manager, Folder Manager, Chat History): the toggle and the field of the shared dialog frame. */
const dialogSearch = root => ({ input: `${root} .sb-dialog__search-input`, toggle: `${root} .sb-dialog__search-toggle` });

// ---------------------------------------------------------------------------------------------------------------------
// Characters and Groups
// ---------------------------------------------------------------------------------------------------------------------

const CHARACTER_ROWS = '.sb-character-list .character_select';
const GROUP_ROWS = '.sb-character-list .group_select';
const CHARACTER_BOX = '.sb-character-list .sb-character-list__box';

const characterList = [
    {
        id: 'list.characters',
        family: 'list',
        owner: 'A',
        title: 'Character list',
        root: CHARACTER_BOX,
        ready: CHARACTER_ROWS,
        open: page => openCharacterListView(page, 'characters'),
        states: [
            searchResults({ search: characterSearch, query: 'Quill', rows: CHARACTER_ROWS, atMost: 3 }),
            {
                id: 'tag-filter',
                ready: [CHARACTER_ROWS, '.sb-character-list .sb-tag-filter-menu-count'],
                async open(page) {
                    await page.evaluate(async name => {
                        const app = await import('/script.js');
                        const tags = await import('/scripts/tags.js');
                        const tag = tags.tags.find(candidate => candidate.name === name);
                        if (!tag) {
                            throw new Error(`The audit tag ${name} is not in the app.`);
                        }
                        app.entitiesFilter.setFilterData('tag', { selected: [tag.id], excluded: [] }, true);
                        await app.printCharacters(false);
                        tags.printTagFilters(tags.tag_filter_type.character);
                    }, FIXTURES.tags.names[0]);
                    await shown(page, '.sb-character-list .sb-tag-filter-menu-count:not([hidden])');
                    await settle(page);
                },
            },
            rowMenu('.sb-character-list .character_select [aria-label^="Actions for"]', CHARACTER_ROWS),
            {
                id: 'selection-mode',
                ready: [CHARACTER_ROWS, '.sb-character-list__selection-header .sb-selection-header', '.sb-character-list__selection-bar [data-action-id="folder"]'],
                open: page => selectCharacterRows(page, '.character_select'),
            },
            {
                id: 'folder-collapsed',
                ready: '.sb-character-list .sb-folder-row[aria-expanded="false"]',
                async open(page) {
                    await page.locator('.sb-character-list .sb-folder-row').first().click();
                    await shown(page, '.sb-character-list .sb-folder-row[aria-expanded="false"]');
                    await settle(page);
                },
            },
            {
                id: 'grid-view',
                ready: ['body.charListGrid .sb-character-list .character_select'],
                async open(page) {
                    await openSearch(page, characterSearch);
                    await page.locator('.sb-character-list__sort').click();
                    await page.locator('.sb-action-menu').last().getByRole('menuitemradio', { name: 'Grid', exact: true }).click();
                    await page.locator('body.charListGrid').waitFor();
                    await page.locator(characterSearch.toggle).first().evaluate(button => button.click());
                    await page.locator(characterSearch.input).first().waitFor({ state: 'hidden' });
                    await settle(page);
                },
            },
        ],
        needs: ['character', 'characters-many', 'tags', 'folders'],
        sources: [`${SCRIPTS}/sillybunny-character-list.js`, `${SCRIPTS}/sillybunny-editor/folder-row.js`, `${CSS}/sillybunny-character-list.css`, ...LIST_SHELL],
        primaryFlow: true,
    },
    {
        id: 'list.groups',
        family: 'list',
        owner: 'A',
        title: 'Group list',
        root: CHARACTER_BOX,
        ready: GROUP_ROWS,
        open: page => openCharacterListView(page, 'groups'),
        states: [
            searchResults({ search: characterSearch, query: 'Audit', rows: GROUP_ROWS, atMost: 5 }),
            rowMenu('.sb-character-list .group_select [aria-label^="Actions for"]', GROUP_ROWS),
            {
                id: 'selection-mode',
                ready: [GROUP_ROWS, '.sb-character-list__selection-header .sb-selection-header', '.sb-character-list__selection-bar [data-action-id="folder"]'],
                async open(page) {
                    await chooseMenuItem(page, '.sb-character-list [data-action-id="more"]', 'Select');
                    await shown(page, '.sb-character-list__selection-header .sb-selection-header');
                    await page.locator('.sb-character-list .group_select .ch_name').first().click();
                    await shown(page, '.sb-character-list__selection-bar [data-action-id="folder"]');
                    await settle(page);
                },
            },
        ],
        needs: ['character', 'characters-many', 'group', 'folders'],
        sources: [`${SCRIPTS}/sillybunny-character-list.js`, `${CSS}/sillybunny-character-list.css`, ...LIST_SHELL],
    },
];

// ---------------------------------------------------------------------------------------------------------------------
// World Info, Persona, Prompt, Agents
// ---------------------------------------------------------------------------------------------------------------------

const WI_ROWS = `${WORLD_INFO} .sb-wi-row`;

/** Chooses a radio item of the World Info sort and filter menu, which sits beside the search field. */
async function chooseWorldInfoView(page, name) {
    await openSearch(page, worldInfoSearch);
    await page.locator(`${WORLD_INFO} .sb-wi-sort-button`).click();
    await page.locator('.sb-action-menu').last().getByRole('menuitemradio', { name, exact: true }).click();
    await settle(page);
}

const worldInfoList = {
    id: 'list.worldinfo-entries',
    family: 'list',
    owner: 'A',
    title: 'World Info entries',
    root: `${WORLD_INFO} .sb-wi-list-body`,
    ready: WI_ROWS,
    open: page => openWorldInfoEntries(page, FIXTURES['lorebook-entries'].book),
    states: [
        searchResults({ search: worldInfoSearch, query: 'Keyed', rows: WI_ROWS, atMost: 5 }),
        rowMenu(`${WI_ROWS} .sb-wi-row-menu`, WI_ROWS),
        {
            id: 'selection-mode',
            ready: [WI_ROWS, `${WORLD_INFO} .sb-wi-selection-header .sb-selection-header`],
            async open(page) {
                await chooseMenuItem(page, `${WORLD_INFO} .sb-wi-book-actions`, 'Select');
                await shown(page, `${WORLD_INFO} .sb-wi-selection-header .sb-selection-header`);
                await page.locator(WI_ROWS).nth(0).click();
                await page.locator(WI_ROWS).nth(1).click();
                await settle(page);
            },
        },
        {
            id: 'custom-order',
            ready: [WI_ROWS, `${WORLD_INFO} .sb-wi-grip`],
            async open(page) {
                await chooseWorldInfoView(page, 'Custom');
                await shown(page, `${WORLD_INFO} .sb-wi-grip`);
            },
        },
        {
            id: 'disabled-only',
            ready: `${WI_ROWS}.is-disabled:only-child`,
            async open(page) {
                await chooseWorldInfoView(page, 'Disabled');
                await page.waitForFunction(selector => [...document.querySelectorAll(selector)].filter(row => row.getClientRects().length).length === 1, WI_ROWS);
            },
        },
    ],
    needs: ['lorebook-entries'],
    sources: [`${SCRIPTS}/sillybunny-world-info-editor.js`, `${CSS}/sillybunny-world-info-editor.css`, ...LIST_SHELL],
    primaryFlow: true,
};

const PERSONA_ROWS = `${PERSONAS} .sb-persona-row`;

const personaList = {
    id: 'list.persona',
    family: 'list',
    owner: 'A',
    title: 'Persona list',
    root: `${PERSONAS} .sb-persona-list-body`,
    ready: PERSONA_ROWS,
    open: openPersonaList,
    states: [
        searchResults({ search: personaSearch, query: 'fixture', rows: PERSONA_ROWS, atMost: 4 }),
        rowMenu(`${PERSONA_ROWS} .sb-persona-row-menu`, PERSONA_ROWS),
        {
            id: 'selection-mode',
            ready: [PERSONA_ROWS, `${PERSONAS} .sb-persona-selection-header .sb-selection-header`, `${PERSONAS} .sb-persona-selection-bar [data-action-id="folder"]`],
            async open(page) {
                await chooseMenuItem(page, `${PERSONAS} .sb-persona-list-menu`, 'Select');
                await shown(page, `${PERSONAS} .sb-persona-selection-header .sb-selection-header`);
                await page.locator(`${PERSONA_ROWS} .sb-selection-check`).nth(0).click();
                await page.locator(`${PERSONA_ROWS} .sb-selection-check`).nth(1).click();
                await shown(page, `${PERSONAS} .sb-persona-selection-bar [data-action-id="folder"]`);
                await settle(page);
            },
        },
    ],
    needs: ['persona', 'personas-many'],
    sources: [`${SCRIPTS}/sillybunny-persona-editor.js`, `${CSS}/sillybunny-persona-editor.css`, ...LIST_SHELL],
    primaryFlow: true,
};

const PROMPT_ROWS = '.sb-prompt-editor .sb-prompt-row';
/** The prompt list keeps the rows of both backends in the page and hides the ones that do not apply. */
const PROMPT_ROWS_SHOWN = `${PROMPT_ROWS}:visible`;

const promptList = {
    id: 'list.prompt',
    family: 'list',
    owner: 'A',
    title: 'Prompt list (prompts and prompt templates)',
    root: '.sb-prompt-editor .sb-prompt-list-body',
    ready: ctx => (ctx.backend === 'text-completion' ? PROMPT_ROWS_SHOWN : `${PROMPT_ROWS}[data-prompt-id="main"]`),
    open: (page, ctx = {}) => openPromptList(page, ctx.backend ?? 'chat-completion'),
    states: [
        searchResults({ search: promptSearch, query: 'Main', rows: PROMPT_ROWS, atMost: 5, ready: PROMPT_ROWS_SHOWN }),
        rowMenu(`${PROMPT_ROWS} .sb-prompt-row-menu`, PROMPT_ROWS_SHOWN),
    ],
    backends: ['chat-completion', 'text-completion'],
    masks: ['.sb-prompt-editor .sb-prompt-token'],
    needs: [],
    sources: [`${SCRIPTS}/sillybunny-prompt-editor.js`, `${CSS}/sillybunny-prompt-editor.css`, ...LIST_SHELL],
    primaryFlow: true,
};

const AGENT_ROWS = `${AGENTS} [data-saved="true"]`;

const agentList = {
    id: 'list.agents',
    family: 'list',
    owner: 'A',
    title: 'Agent list',
    root: `${AGENTS} .ica-agents-body`,
    ready: AGENT_ROWS,
    open: openAgentList,
    states: [
        searchResults({ search: agentSearch, query: FIXTURES.agents.tool.name, rows: AGENT_ROWS, atMost: 1 }),
        rowMenu(`${AGENT_ROWS} [aria-label="Agent Menu"]`, AGENT_ROWS),
        {
            id: 'selection-mode',
            ready: [AGENT_ROWS, `${AGENTS} .sb-selection-header`],
            async open(page) {
                await chooseMenuItem(page, `${AGENTS} [data-action-id="more"]`, 'Select');
                await shown(page, `${AGENTS} .sb-selection-header`);
                await page.locator(`${AGENT_ROWS} .ds-entity-row__title`).nth(0).click();
                await page.locator(`${AGENT_ROWS} .ds-entity-row__title`).nth(1).click();
                await settle(page);
            },
        },
    ],
    masks: [`${AGENTS} .ica-agent-token`],
    needs: ['agents'],
    sources: [`${EXTENSIONS}/in-chat-agents/ui/agent-list.js`, `${EXTENSIONS}/in-chat-agents/ui/agent-list-model.js`, ...LIST_SHELL],
    primaryFlow: true,
};

// ---------------------------------------------------------------------------------------------------------------------
// Managers and windows that list rows
// ---------------------------------------------------------------------------------------------------------------------

const TAG_ROWS = `${TAG_MANAGER} .tag_view_item:not([hidden])`;

const tagManager = {
    id: 'list.tag-manager',
    family: 'list',
    owner: 'A',
    title: 'Tag Manager list',
    root: `${TAG_MANAGER} .sb-tag-manager__list`,
    ready: TAG_ROWS,
    open: page => openManager(page, { item: 'Manage tags', root: TAG_MANAGER }),
    close: page => closeManager(page, TAG_MANAGER),
    overlay: true,
    states: [
        searchResults({ search: dialogSearch(TAG_MANAGER), query: 'Beta', rows: TAG_ROWS, atMost: 3 }),
        rowMenu(`${TAG_MANAGER} .sb-tag-manager__row-menu`, TAG_ROWS),
        {
            id: 'selection-mode',
            ready: [TAG_ROWS, `${TAG_MANAGER} .sb-dialog__selection-cancel`, `${TAG_MANAGER} .sb-tag-manager__selection-bar [data-action-id="delete"]`],
            async open(page) {
                await chooseMenuItem(page, `${TAG_MANAGER} .sb-dialog__menu`, 'Select');
                await shown(page, `${TAG_MANAGER} .sb-dialog__selection-cancel`);
                await page.locator(`${TAG_ROWS} .sb-selection-check`).nth(0).click();
                await page.locator(`${TAG_ROWS} .sb-selection-check`).nth(1).click();
                await shown(page, `${TAG_MANAGER} .sb-tag-manager__selection-bar [data-action-id="delete"]`);
                await settled(page, TAG_MANAGER);
            },
        },
        {
            id: 'members-page',
            root: '.sb-tag-manager__members',
            ready: ['.sb-tag-manager__members .ds-entity-row', '.sb-tag-manager__member-add'],
            async open(page) {
                const row = page.locator(TAG_ROWS).first();
                await row.focus();
                await page.keyboard.press('Enter');
                await shown(page, '.sb-tag-manager__member-add');
                await settled(page, TAG_MANAGER);
            },
        },
    ],
    needs: ['character', 'characters-many', 'tags'],
    sources: [`${SCRIPTS}/sillybunny-tag-manager.js`, `${CSS}/sillybunny-tag-manager.css`, ...LIST_SHELL],
};

const FOLDER_ROWS = `${FOLDER_MANAGER} .sb-folder-manager__folder-row`;

const folderManager = {
    id: 'list.folder-manager',
    family: 'list',
    owner: 'A',
    title: 'Folder Manager list',
    root: `${FOLDER_MANAGER} .sb-folder-manager__list`,
    ready: FOLDER_ROWS,
    open: page => openManager(page, { item: 'Manage Folders', root: FOLDER_MANAGER }),
    close: page => closeManager(page, FOLDER_MANAGER),
    overlay: true,
    states: [
        searchResults({ search: dialogSearch(FOLDER_MANAGER), query: 'Folder A', rows: FOLDER_ROWS, atMost: 1 }),
        rowMenu(`${FOLDER_MANAGER} .sb-folder-manager__row-menu`, FOLDER_ROWS),
        {
            id: 'members-page',
            root: `${FOLDER_MANAGER} .sb-folder-manager__members`,
            ready: [`${FOLDER_MANAGER} .sb-folder-manager__member-row`, `${FOLDER_MANAGER} .sb-folder-manager__add-member`],
            async open(page) {
                await page.locator(`${FOLDER_MANAGER} .sb-folder-manager__count`).first().click();
                await shown(page, `${FOLDER_MANAGER} .sb-folder-manager__add-member`);
                await settled(page, FOLDER_MANAGER);
            },
        },
    ],
    needs: ['character', 'characters-many', 'folders'],
    sources: [`${SCRIPTS}/sillybunny-folder-manager.js`, `${SCRIPTS}/sillybunny-editor/folder-row.js`, ...LIST_SHELL],
};

const ARCHIVE_HEADER = `${ARCHIVE} .sb-dialog__header:visible`;

const chatsArchive = {
    id: 'list.archive',
    family: 'list',
    owner: 'C',
    title: 'Chats Archive list',
    root: `${ARCHIVE} .sbca-list-pane`,
    ready: `${ARCHIVE} .sbca-row`,
    open: openArchiveList,
    close: closeArchive,
    overlay: true,
    states: [
        {
            id: 'search-results',
            // A phone shows the results on a page of their own, which has no search field.
            ready: ctx => (MOBILE_LAYOUT_VIEWPORTS.includes(ctx.viewport) ? `${ARCHIVE} .sbca-row` : [`${ARCHIVE} .sbca-row`, `${ARCHIVE} .sb-dialog__search-input`]),
            async open(page) {
                // When the archive stacks its panes (a phone), the search is in the header of the page that lists the locations.
                const toggle = page.locator(`${ARCHIVE_HEADER} .sb-dialog__search-toggle`).first();
                if (!await toggle.isVisible()) {
                    await page.locator(`${ARCHIVE_HEADER} .sb-dialog__back`).first().click();
                    await toggle.waitFor({ state: 'visible' });
                    await settled(page, ARCHIVE);
                }
                await openSearch(page, { input: `${ARCHIVE} .sb-dialog__search-input`, toggle: `${ARCHIVE_HEADER} .sb-dialog__search-toggle` });
                await page.locator(`${ARCHIVE} .sb-dialog__search-input`).first().fill('audit-archive-2');
                // On a phone the results are a page that the locations lead to.
                if (!await page.locator(`${ARCHIVE} .sbca-row`).first().isVisible()) {
                    await page.locator(`${ARCHIVE} .sbca-location`).first().click();
                }
                await waitForRowCount(page, { rows: `${ARCHIVE} .sbca-row`, atMost: 4 });
                // The search of the chats' content starts after a debounce and reads the sources one after the other. It has
                // ended when the status gives the number of matching chats.
                await page.waitForFunction(() => {
                    const status = document.querySelector('.sbca-status');
                    return !status?.hasAttribute('aria-busy') && /matching chats/.test(status?.textContent ?? '');
                }, null, { timeout: 30_000 });
                await settled(page, ARCHIVE);
            },
        },
        {
            id: 'selection-mode',
            ready: [`${ARCHIVE} .sbca-row`, `${ARCHIVE} .sbca-selection-bar`],
            async open(page) {
                await page.locator(`${ARCHIVE_HEADER} .sb-dialog__menu`).last().click();
                await page.getByRole('menuitem', { name: 'Select Chats' }).click();
                await page.locator(`${ARCHIVE} .sbca-row`).first().click();
                await shown(page, `${ARCHIVE} .sbca-selection-bar`);
                await settled(page, ARCHIVE);
            },
        },
    ],
    masks: [`${ARCHIVE} .sbca-row .ds-entity-row__subtitle`],
    needs: ['character', 'characters-many', 'archived-chats'],
    sources: [`${EXTENSIONS}/sillybunny-chats-archive/src/ui/list.js`, `${EXTENSIONS}/sillybunny-chats-archive/src/ui/rows.js`, `${EXTENSIONS}/sillybunny-chats-archive/src/ui/selection.js`],
};

const HISTORY_ROWS = '.sb-chat-history-row';

const chatHistory = {
    id: 'list.chat-history',
    family: 'list',
    owner: 'A',
    title: 'Chat History list',
    root: `${CHAT_HISTORY} .sb-chat-history-list-page`,
    ready: HISTORY_ROWS,
    open: openChatHistory,
    close: closeChatHistory,
    overlay: true,
    states: [
        searchResults({ search: dialogSearch(CHAT_HISTORY), query: 'archive-2', rows: HISTORY_ROWS, atMost: 3 }),
    ],
    masks: [`${CHAT_HISTORY} .sb-chat-history-row .ds-entity-row__subtitle`],
    needs: ['character', 'chat', 'archived-chats'],
    sources: [`${SCRIPTS}/sillybunny-chat-dialogs.js`, `${CSS}/sillybunny-tabs.css`],
};

// ---------------------------------------------------------------------------------------------------------------------
// Lists that Customize and the windows hold: the extensions manager, regex scripts, Quick Reply sets, backgrounds, Data Bank, swipes
// ---------------------------------------------------------------------------------------------------------------------

const extensionsManagerList = {
    id: 'list.extensions-manager',
    family: 'list',
    owner: 'A',
    title: 'Extensions manager list (installed extensions)',
    root: `${EXTENSIONS_MANAGER} .popup-content`,
    ready: `${EXTENSIONS_MANAGER} .extension_block`,
    open: openExtensionsManager,
    close: closeExtensionsManager,
    overlay: true,
    masks: [`${EXTENSIONS_MANAGER} .extension_version`],
    needs: [],
    upstreamMarkup: true,
    sources: [`${SCRIPTS}/sillybunny-editor/adapters/extensions-manager-dialog.js`, `${SCRIPTS}/sillybunny-extension-actions.js`, `${SCRIPTS}/extensions.js`],
};

const regexList = {
    id: 'list.regex-scripts',
    family: 'list',
    owner: 'B',
    title: 'Regex script list',
    root: '#saved_regex_scripts',
    ready: '#saved_regex_scripts .regex-script-label',
    async open(page) {
        await openExtensionBlock(page, { row: 'regex_container', container: '#regex_container', list: '#saved_regex_scripts .regex-script-label' });
        if (await page.locator('#regex_bulk_edit').isChecked()) {
            await page.locator('label[for="regex_bulk_edit"]').click();
        }
        await settle(page);
    },
    states: [{
        id: 'bulk-edit',
        ready: ['#saved_regex_scripts .regex-script-label', '#regex_container .regex_bulk_operations'],
        async open(page) {
            await page.locator('label[for="regex_bulk_edit"]').click();
            await shown(page, '#regex_container .regex_bulk_operations');
            await scrollIntoView(page, '#regex_container .regex_bulk_operations');
        },
    }],
    needs: ['regex-scripts'],
    sources: [`${EXTENSIONS}/regex/index.js`, `${EXTENSIONS}/regex/dropdown.html`, `${EXTENSIONS}/regex/scriptTemplate.html`, `${EXTENSIONS}/regex/style.css`],
};

const quickReplyList = {
    id: 'list.quick-replies',
    family: 'list',
    owner: 'B',
    title: 'Quick Reply list (buttons of a set)',
    root: '#qr--set-qrList',
    ready: '#qr--set-qrList .qr--set-item',
    open: page => openExtensionBlock(page, { row: 'qr_container', container: '#qr_container', list: '#qr--set-qrList .qr--set-item' }),
    needs: ['quick-replies'],
    sources: [`${EXTENSIONS}/quick-reply/src/ui/SettingsUi.js`, `${EXTENSIONS}/quick-reply/src/QuickReply.js`, `${EXTENSIONS}/quick-reply/html/settings.html`, `${EXTENSIONS}/quick-reply/style.css`],
};

const backgroundsList = {
    id: 'list.backgrounds',
    family: 'list',
    owner: 'B',
    title: 'Backgrounds list (Customize > Appearance)',
    root: '#bg_menu_content',
    ready: '#bg_menu_content .bg_example',
    open: openBackgrounds,
    needs: [],
    sources: [`${SCRIPTS}/backgrounds.js`, 'public/index.html'],
};

const dataBankList = {
    id: 'list.databank',
    family: 'list',
    owner: 'B',
    title: 'Data Bank attachment list',
    root: '.dataBankAttachments .attachmentsList',
    ready: '.dataBankAttachments .attachmentListItem',
    open: openDataBank,
    close: closeDataBank,
    overlay: true,
    masks: ['.dataBankAttachments .attachmentListItemCreated'],
    needs: ['character', 'chat', 'databank'],
    sources: [`${SCRIPTS}/chats.js`, `${SCRIPTS}/sillybunny-editor/adapters/data-bank-dialog.js`],
};

const SAMPLING = '[data-sb-panel="sampling"]';

const logitBiasList = {
    id: 'list.logit-bias',
    family: 'list',
    owner: 'B',
    title: 'Logit bias list (Chat Completion sampling)',
    root: `${SAMPLING} .openai_logit_bias_list`,
    ready: `${SAMPLING} .openai_logit_bias_list > *`,
    async open(page) {
        await openSamplingList(page, { backend: 'chat-completion', list: `${SAMPLING} .openai_logit_bias_list`, rows: `${SAMPLING} .openai_logit_bias_list > *` });
        await selectLogitBiasPreset(page);
    },
    needs: ['logit-bias'],
    sources: [`${SCRIPTS}/logit-bias.js`, `${SCRIPTS}/openai.js`],
};

/** The sampler order of a backend whose Sampling page shows one: the rows that a user drags. */
function samplerOrder({ id, title, backend, list, sources }) {
    return {
        id: `list.sampler-order-${id}`,
        family: 'list',
        owner: 'B',
        title,
        root: `${SAMPLING} ${list}`,
        ready: `${SAMPLING} ${list} > div`,
        open: page => openSamplingList(page, { backend, list: `${SAMPLING} ${list}`, rows: `${SAMPLING} ${list} > div` }),
        backends: [backend],
        needs: [],
        sources,
    };
}

const swipePickerList = {
    id: 'list.swipe-picker',
    family: 'list',
    owner: 'B',
    title: 'Swipe picker list',
    root: '.swipe_picker_div',
    ready: '.swipe_picker_block',
    open: openSwipePicker,
    close: closeSwipePicker,
    overlay: true,
    needs: ['character', 'chat'],
    sources: [`${SCRIPTS}/swipe-picker.js`],
};

const GROUP_EDITOR_SOURCES = [`${SCRIPTS}/sillybunny-group-editor.js`, `${SCRIPTS}/group-chats.js`];

/** The two lists of the group editor: the members of the group, and the characters that can be added. */
const groupMemberLists = [
    { id: 'members', title: 'Group editor: members of the group', list: '#rm_group_members' },
    { id: 'candidates', title: 'Group editor: characters to add to the group', list: '#rm_group_add_members' },
].map(({ id, title, list }) => ({
    id: `list.group-${id}`,
    family: 'list',
    owner: 'A',
    title,
    root: list,
    ready: `${list} .group_member`,
    async open(page) {
        await openGroupEditor(page);
        await shown(page, `${list} .group_member`);
        await scrollIntoView(page, list);
    },
    needs: ['character', 'characters-many', 'group'],
    sources: GROUP_EDITOR_SOURCES,
}));

/** @type {import('./index.js').Surface[]} */
export const surfaces = [
    ...characterList,
    worldInfoList,
    personaList,
    promptList,
    agentList,
    tagManager,
    folderManager,
    chatsArchive,
    chatHistory,
    extensionsManagerList,
    regexList,
    quickReplyList,
    backgroundsList,
    dataBankList,
    swipePickerList,
    logitBiasList,
    samplerOrder({ id: 'horde', title: 'Sampler order list (Kobold and Horde)', backend: 'horde', list: '#kobold_order', sources: [`${SCRIPTS}/kai-settings.js`] }),
    samplerOrder({ id: 'koboldcpp', title: 'Sampler order list (KoboldCpp)', backend: 'koboldcpp', list: '#koboldcpp_order', sources: [`${SCRIPTS}/textgen-settings.js`] }),
    samplerOrder({ id: 'llamacpp', title: 'Sampler order list (llama.cpp)', backend: 'llamacpp', list: '#llamacpp_samplers_sortable', sources: [`${SCRIPTS}/textgen-settings.js`] }),
    samplerOrder({ id: 'aphrodite', title: 'Sampler order list (Aphrodite)', backend: 'aphrodite', list: '#sampler_priority_container_aphrodite', sources: [`${SCRIPTS}/textgen-settings.js`] }),
    ...groupMemberLists,
];
