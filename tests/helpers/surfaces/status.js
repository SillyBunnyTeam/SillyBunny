/**
 * The status family: every status page and empty state that a user can see. `root` is the status page element (or the
 * element that shows the empty state), so that a tool can compare them with each other.
 *
 * An empty state needs the absence of data, and the servers are seeded, so each `open` takes the data away in the page: it
 * answers the request that loads it with an empty list, or edits the in-memory list the way the existing specs do. Nothing
 * is deleted on the server, and the writes of a surface run are answered by `protectMaintainerServer()` in `boot.js`.
 * Where a surface also has a "no results" variant, a search term that matches nothing produces it.
 *
 * An entry leaves its routes and its in-page changes in place, so it needs a page of its own (the tools boot a fresh one per
 * surface); a state runs after its surface's `open` and works after any other state of the surface.
 */

import { showSettingsSidebar } from '../settings-phone-pane.js';
import { alternatingMessages, seedConversation } from '../conversation-seed.js';
import { FIXTURES } from './fixture-data.js';
import { openAuditChat as openAuditChatAfterFocus } from './dialog-steps.js';
import { closeSidePanelById, MOBILE_LAYOUT_VIEWPORTS, openAuditChat } from './panel-steps.js';
import { chooseMenuItem, openCharactersTab, openSettingsTab, selectBackend, selectLogitBiasPreset, settle } from './steps.js';

const SCRIPTS = 'public/scripts';
const NO_MATCH = 'zz no such entry';

const CHARACTER_LIST = '.sb-character-list[data-mounted="true"]';
const WORLD_INFO = '#WorldInfo';
const PERSONAS = '#PersonaManagement';
const AGENTS = '.ica-agents-editor';

/** Shows the Characters or Groups view of the Characters shell. From `character-list.e2e.js` (`showView`). */
async function showCharacterView(page, view) {
    await page.evaluate(async view => { await window.SillyBunnyShell.openTab('characters', view); }, view);
    await page.locator(CHARACTER_LIST).waitFor({ state: 'visible' });
    await page.waitForFunction(({ selector, view }) => document.querySelector(selector)?.dataset.view === view, { selector: CHARACTER_LIST, view });
}

/** Empties the characters and the groups in the page, as `character-list.e2e.js` does. The server keeps its data. */
async function emptyCharacterLists(page) {
    await page.evaluate(async () => {
        const app = await import('/script.js');
        const groups = await import('/scripts/group-chats.js');
        app.entitiesFilter.setFilterData('search', '', true);
        document.getElementById('character_search_bar').value = '';
        app.characters.splice(0, app.characters.length);
        groups.groups.splice(0, groups.groups.length);
        await app.printCharacters(false);
    });
}

/** Types a search that matches nothing. From `character-list.e2e.js` (`setSearch`, `openHeaderMenu`). */
async function searchCharacterList(page, query) {
    if (!await page.locator('#character_search_bar').isVisible()) {
        const direct = page.locator(`${CHARACTER_LIST} [data-action-id="search"]`);
        if (await direct.isVisible()) {
            await direct.click();
        } else {
            await page.locator(`${CHARACTER_LIST} [data-action-id="more"]`).click();
            await page.getByRole('menuitem', { name: 'Search', exact: true }).click();
        }
    }
    await page.locator('#character_search_bar').fill(query);
    await page.waitForFunction(query => window.SillyBunnyCharacterListController.captureState().query === query, query);
}

/** Opens a list's search field from its header button, then types a query. */
async function typeInto(page, toggle, input, query) {
    if (!await page.locator(input).isVisible()) {
        await page.locator(toggle).click();
    }
    await page.locator(input).fill(query);
}

/** Searches in a dialog whose header has the shared search field. From `sillybunny-overlays.e2e.js` and `home-windows.e2e.js`. */
async function searchDialog(page, host, query) {
    const input = page.locator(`${host} .sb-dialog__search-input`).first();
    if (!await input.isVisible()) {
        await page.locator(`${host} .sb-dialog__search-toggle`).first().click();
    }
    await input.fill(query);
}

/**
 * Closes every open dialog with Escape, one press per dialog or per search field, and fails when one stays open. A press
 * that only clears a search field leaves the count as it was, so the wait is for fewer dialogs or for empty search fields.
 */
async function closeDialogs(page) {
    for (let press = 0; press < 5 && await page.locator('dialog[open]').count(); press++) {
        const open = await page.locator('dialog[open]').count();
        await page.keyboard.press('Escape');
        await page.waitForFunction(before => document.querySelectorAll('dialog[open]').length < before
            || [...document.querySelectorAll('dialog[open] .sb-dialog__search-input')].every(input => !input.value), open, { timeout: 3000 });
    }
    await page.locator('dialog[open]').first().waitFor({ state: 'detached', timeout: 3000 });
}

/** What the page holds for each selector (how many, and how the first is drawn), on one line, for a failure message. */
async function describeSelectors(page, selectors) {
    const lines = await page.evaluate(list => list.map(selector => {
        let nodes;
        try {
            nodes = [...document.querySelectorAll(selector)];
        } catch {
            return `${selector}: not a CSS selector`;
        }
        const first = nodes[0];
        if (!first) {
            return `${selector}: none`;
        }
        const style = getComputedStyle(first);
        const box = first.getBoundingClientRect();
        return `${selector}: ${nodes.length} found, display ${style.display}, visibility ${style.visibility}, ${Math.round(box.width)}x${Math.round(box.height)} at ${Math.round(box.left)},${Math.round(box.top)}`;
    }), selectors);
    return lines.join(' ; ');
}

/**
 * Waits for the status page and scrolls it to the middle of the viewport, because a page taller than the screen shows it
 * below the fold. When it does not show, the error says what the page holds for the selector and for `hints`.
 */
async function reveal(page, selector, { hints = [], timeout = 15_000 } = {}) {
    const target = page.locator(selector).first();
    try {
        await target.waitFor({ state: 'visible', timeout });
    } catch {
        throw new Error(`${selector} did not show within ${timeout} ms. ${await describeSelectors(page, [selector, ...hints])}`);
    }
    // The app may rebuild a menu between the wait and the scroll, so a node that has gone is not an error.
    await target.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }), null, { timeout: 2000 }).catch(() => {});
}

/**
 * How an entry draws its empty state. The schema has no field for it, so the title ends with the note, for a tool that
 * compares the status pages with each other.
 */
const COMPONENTS = {
    shared: 'status page: shared createStatusPage',
    adapted: 'status page: own markup that carries the sb-status-page classes',
    own: 'status page: own markup',
    none: 'status page: none',
};

/**
 * A status page surface: `root` is the page, `needs` lists the data that a search can miss, and `component` says whether
 * the page is `createStatusPage` (`shared`), own markup with its classes (`adapted`), own markup (`own`) or absent (`none`).
 * `upstreamMarkup` marks an A surface whose markup is upstream's.
 */
function status({ id, title, root, open, close, states, needs = [], sources, owner = 'A', masks, primaryFlow, backends, component, ready, overlay, viewports, upstreamMarkup }) {
    if (!(component in COMPONENTS)) {
        throw new Error(`status.${id}: component must be one of ${Object.keys(COMPONENTS).join(', ')}.`);
    }
    return {
        id: `status.${id}`,
        family: 'status',
        owner,
        title: `${title} [${COMPONENTS[component]}]`,
        root,
        ...(ready && { ready }),
        open,
        ...(close && { close }),
        ...(states && { states }),
        ...(masks && { masks }),
        ...(backends && { backends }),
        ...(overlay && { overlay }),
        ...(upstreamMarkup && { upstreamMarkup }),
        ...(viewports && { viewports }),
        needs,
        sources,
        ...(primaryFlow && { primaryFlow }),
    };
}

/** `root` narrowed to the status page that carries the given title, so that two pages of one surface cannot pass for each other. */
const titled = (root, title) => `${root}:has(.sb-status-page__title:text-is("${title}"))`;

const STATUS_PAGE_SOURCE = `${SCRIPTS}/sillybunny-editor/status-page.js`;

// --- Characters shell -------------------------------------------------------------------------------------------------

const characterStatus = `${CHARACTER_LIST} .sb-character-list__status .sb-status-page`;
const groupStatus = `${CHARACTER_LIST}[data-view="groups"] .sb-character-list__status .sb-status-page`;

const charactersEmpty = status({
    id: 'characters.empty',
    title: 'Characters: empty list, and an empty Groups list as a state',
    component: 'shared',
    root: characterStatus,
    ready: `${characterStatus}:has-text("There are no items to display")`,
    async open(page) {
        await showCharacterView(page, 'characters');
        await emptyCharacterLists(page);
        await page.locator(characterStatus).waitFor({ state: 'visible' });
        await settle(page);
    },
    states: [{
        id: 'groups',
        ready: `${groupStatus}:has-text("There are no items to display")`,
        async open(page) {
            await showCharacterView(page, 'groups');
            await page.locator(characterStatus).waitFor({ state: 'visible' });
            await settle(page);
        },
    }],
    sources: [`${SCRIPTS}/sillybunny-character-list.js`, STATUS_PAGE_SOURCE],
    primaryFlow: true,
});

const charactersNoResults = status({
    id: 'characters.no-results',
    title: 'Characters: no results for a search, and the same in Groups as a state',
    component: 'shared',
    root: characterStatus,
    ready: `${titled(characterStatus, 'No Results Found')}`,
    async open(page) {
        await showCharacterView(page, 'characters');
        await searchCharacterList(page, NO_MATCH);
        await page.locator(characterStatus).waitFor({ state: 'visible' });
        await settle(page);
    },
    states: [{
        id: 'groups',
        ready: `${titled(groupStatus, 'No Results Found')}`,
        async open(page) {
            await showCharacterView(page, 'groups');
            await searchCharacterList(page, NO_MATCH);
            await page.locator(characterStatus).waitFor({ state: 'visible' });
            await settle(page);
        },
    }],
    needs: ['character', 'group'],
    sources: [`${SCRIPTS}/sillybunny-character-list.js`, STATUS_PAGE_SOURCE],
    primaryFlow: true,
});

const characterEditorEmpty = status({
    id: 'characters.editor-empty',
    title: 'Character editor: no character selected',
    component: 'shared',
    root: '#sb_character_editor_empty',
    ready: '#sb_character_editor_empty #sb_character_empty_browse',
    async open(page) {
        await page.evaluate(async () => (await import('/script.js')).setCharacterId(undefined));
        await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'editor'));
        await page.locator('#right-nav-panel[data-menu-type="editor_empty"]').waitFor();
        await reveal(page, '#sb_character_editor_empty');
        await settle(page);
    },
    sources: [`${SCRIPTS}/sillybunny-tabs.js`, STATUS_PAGE_SOURCE],
    primaryFlow: true,
});

/**
 * Holds the stylesheet of a Characters shell panel, as `character-shell-performance.e2e.js` does, so that the panel
 * shows its loading page, which the app builds from its own markup (`revealDeferredCharacterPanel`), for as long as the
 * sheet is held. The panel must not have been opened before.
 */
const charactersLoading = status({
    id: 'characters.panel-loading',
    title: 'Characters shell: a panel that is still loading',
    component: 'shared',
    root: '.sb-character-panel-loading:not([hidden])',
    async open(page) {
        await showCharacterView(page, 'characters');
        await page.evaluate(() => {
            const load = window.SillyBunnyAssets.loadStylesheetAsync;
            window.SillyBunnyAssets.loadStylesheetAsync = async (...args) => {
                await load(...args);
                await new Promise(() => {});
            };
            void window.SillyBunnyShell.openTab('characters', 'persona');
        });
        await page.locator('.sb-character-panel-loading:not([hidden])').waitFor({ state: 'visible' });
        await settle(page);
    },
    sources: [`${SCRIPTS}/sillybunny-tabs.js`, STATUS_PAGE_SOURCE],
});

const importLoading = status({
    id: 'import.loading',
    title: 'Import: results while an import is running',
    component: 'shared',
    root: '#sb_character_import_results .sb-status-page',
    ready: titled('#sb_character_import_results .sb-status-page', 'Importing Content'),
    masks: ['#sb_character_import_results .sb-status-page__icon'],
    async open(page) {
        // A held answer keeps the import running, which is when the results show their loading page.
        await page.route('**/api/content/importUUID', () => new Promise(() => {}));
        await openCharactersTab(page, 'import');
        await page.locator('#sb_character_import_panel[data-mounted="true"]').waitFor();
        await page.locator('#sb_character_import_content').waitFor({ state: 'visible' });
        await page.evaluate(async () => {
            const { mountCharacterImport } = await import('/scripts/sillybunny-character-import.js');
            void mountCharacterImport(document.getElementById('sb_character_import_panel')).run({ urls: ['lorebooks/qa/book'] });
        });
        await reveal(page, '#sb_character_import_results .sb-status-page');
        await settle(page);
    },
    sources: [`${SCRIPTS}/sillybunny-character-import.js`, STATUS_PAGE_SOURCE],
});

// --- Persona and World Info -------------------------------------------------------------------------------------------

const personaStatus = `${PERSONAS} .sb-persona-list-status .sb-status-page`;

const personaEmpty = status({
    id: 'persona.empty',
    title: 'Persona list: no personas',
    component: 'shared',
    root: personaStatus,
    async open(page) {
        await page.route('**/api/avatars/get', route => route.fulfill({ json: [] }));
        await openCharactersTab(page, 'persona');
        await page.evaluate(async () => (await import('/scripts/personas.js')).getUserAvatars(true));
        await page.locator(personaStatus).waitFor({ state: 'visible' });
        await settle(page);
    },
    sources: [`${SCRIPTS}/sillybunny-persona-editor.js`, STATUS_PAGE_SOURCE],
    primaryFlow: true,
});

const personaNoResults = status({
    id: 'persona.no-results',
    title: 'Persona list: no results for a search',
    component: 'shared',
    root: personaStatus,
    ready: `${PERSONAS} .sb-persona-search`,
    async open(page) {
        await openCharactersTab(page, 'persona');
        await page.locator(`${PERSONAS} .sb-persona-list-body`).waitFor({ state: 'visible' });
        await typeInto(page, `${PERSONAS} button[aria-label="Search"]`, `${PERSONAS} .sb-persona-search`, NO_MATCH);
        await page.locator(personaStatus).waitFor({ state: 'visible' });
        await settle(page);
    },
    needs: ['persona'],
    sources: [`${SCRIPTS}/sillybunny-persona-editor.js`, STATUS_PAGE_SOURCE],
});

const worldInfoStatus = `${WORLD_INFO} .sb-wi-list-status .sb-status-page`;

/** Opens World Info on a book and waits for its editor. From `world-info-editor.e2e.js` (`openBook`). */
async function openBook(page, name) {
    await page.evaluate(async name => {
        const { openWorldInfoEditor } = await import('/scripts/world-info.js');
        await openWorldInfoEditor(name);
    }, name);
    await page.locator(`${WORLD_INFO} .sb-wi-editor`).waitFor({ state: 'visible' });
}

const worldInfoPick = status({
    id: 'worldinfo.pick-book',
    title: 'World Info: no book picked',
    component: 'shared',
    root: worldInfoStatus,
    async open(page) {
        await openCharactersTab(page, 'world-info');
        await page.locator(worldInfoStatus).waitFor({ state: 'visible' });
        await settle(page);
    },
    sources: [`${SCRIPTS}/sillybunny-world-info-editor.js`, STATUS_PAGE_SOURCE],
    primaryFlow: true,
});

const worldInfoNoEntries = status({
    id: 'worldinfo.no-entries',
    title: 'World Info: a book without entries',
    component: 'shared',
    root: worldInfoStatus,
    async open(page) {
        await page.route('**/api/worldinfo/get', route => route.fulfill({ json: { entries: {} } }));
        await openBook(page, FIXTURES.lorebook.name);
        await page.locator(worldInfoStatus).waitFor({ state: 'visible' });
        await settle(page);
    },
    needs: ['lorebook'],
    sources: [`${SCRIPTS}/sillybunny-world-info-editor.js`, STATUS_PAGE_SOURCE],
});

const worldInfoNoResults = status({
    id: 'worldinfo.no-results',
    title: 'World Info: no results for a search',
    component: 'shared',
    root: worldInfoStatus,
    ready: `${WORLD_INFO} .sb-wi-search`,
    async open(page) {
        await openBook(page, FIXTURES.lorebook.name);
        await page.locator(`${WORLD_INFO} .sb-wi-row`).first().waitFor({ state: 'visible' });
        await typeInto(page, `${WORLD_INFO} button[aria-label="Search"]`, `${WORLD_INFO} .sb-wi-search`, NO_MATCH);
        await page.locator(worldInfoStatus).waitFor({ state: 'visible' });
        await settle(page);
    },
    needs: ['lorebook'],
    sources: [`${SCRIPTS}/sillybunny-world-info-editor.js`, STATUS_PAGE_SOURCE],
});

const worldInfoSettingsStatus = `${WORLD_INFO} .sb-wi-settings .sb-wi-settings-empty`;

/** Opens World Info Global Settings from the book menu. */
async function openWorldInfoSettings(page) {
    await openCharactersTab(page, 'world-info');
    await page.locator(`${WORLD_INFO} .sb-wi-book-actions`).waitFor({ state: 'visible' });
    await chooseMenuItem(page, `${WORLD_INFO} .sb-wi-book-actions`, 'Global Settings');
    await page.locator(`${WORLD_INFO} .sb-wi-settings`).waitFor({ state: 'visible' });
}

async function closeWorldInfoSettings(page) {
    await page.locator(`${WORLD_INFO} .sb-wi-settings .sb-wi-detail-back`).click();
    await page.locator(`${WORLD_INFO} .sb-wi-settings`).waitFor({ state: 'hidden' });
}

const worldInfoSettingsNoResults = status({
    id: 'worldinfo.settings-no-results',
    title: 'World Info Global Settings: no results for a book search',
    component: 'shared',
    root: worldInfoSettingsStatus,
    ready: titled(worldInfoSettingsStatus, 'No Results Found'),
    async open(page) {
        await openWorldInfoSettings(page);
        await page.locator(`${WORLD_INFO} .sb-wi-settings-search`).fill(NO_MATCH);
        await page.locator(worldInfoSettingsStatus).waitFor({ state: 'visible' });
        await settle(page);
    },
    close: closeWorldInfoSettings,
    needs: ['lorebook'],
    sources: [`${SCRIPTS}/sillybunny-world-info-settings.js`, STATUS_PAGE_SOURCE],
});

// --- Manager dialogs --------------------------------------------------------------------------------------------------

const FOLDER_HOST = '.sb-dialog-host[open]:has(> .sb-folder-manager)';
const FOLDER_STATUS = `${FOLDER_HOST} .sb-folder-manager__status .sb-status-page`;

/** Opens the Folder Manager from the Characters list menu. From `character-folders.e2e.js`. */
async function openFolderManager(page) {
    await showCharacterView(page, 'characters');
    await page.locator(`${CHARACTER_LIST} [data-action-id="more"]`).click();
    await page.getByRole('menuitem', { name: 'Manage Folders', exact: true }).click();
    await page.locator(FOLDER_HOST).waitFor({ state: 'visible' });
    await settle(page);
}

const foldersEmpty = status({
    id: 'folders.empty',
    title: 'Folder Manager: no folders',
    component: 'shared',
    overlay: true,
    root: FOLDER_STATUS,
    ready: titled(FOLDER_STATUS, 'No Folders'),
    async open(page) {
        // The folders are kept in the account settings, so the page's copy of them is emptied.
        await page.evaluate(() => {
            const store = window.SillyTavern.getContext().powerUserSettings.sb_folders;
            if (store) {
                store.characters = { folders: [], members: {} };
            }
        });
        await openFolderManager(page);
        await page.locator(FOLDER_STATUS).waitFor({ state: 'visible' });
        await settle(page);
    },
    close: closeDialogs,
    sources: [`${SCRIPTS}/sillybunny-folder-manager.js`, STATUS_PAGE_SOURCE],
});

const foldersNoResults = status({
    id: 'folders.no-results',
    title: 'Folder Manager: no results for a search',
    component: 'shared',
    overlay: true,
    root: FOLDER_STATUS,
    ready: titled(FOLDER_STATUS, 'No Results Found'),
    async open(page) {
        await openFolderManager(page);
        await page.locator(`${FOLDER_HOST} .sb-folder-manager__folder-row`).first().waitFor({ state: 'visible' });
        await searchDialog(page, FOLDER_HOST, NO_MATCH);
        await page.locator(FOLDER_STATUS).waitFor({ state: 'visible' });
        await settle(page);
    },
    close: closeDialogs,
    needs: ['character', 'folders'],
    sources: [`${SCRIPTS}/sillybunny-folder-manager.js`, STATUS_PAGE_SOURCE],
});

const foldersNoMembers = status({
    id: 'folders.no-members',
    title: 'Folder Manager: a folder without members',
    component: 'shared',
    overlay: true,
    root: `${FOLDER_HOST} .sb-folder-manager__members .sb-status-page`,
    ready: titled(`${FOLDER_HOST} .sb-folder-manager__members .sb-status-page`, 'No Members'),
    async open(page) {
        await openFolderManager(page);
        const row = page.locator(`${FOLDER_HOST} [data-folder-id="${FIXTURES.folders.characters[1].id}"]`);
        await row.waitFor({ state: 'visible' });
        await row.focus();
        await page.keyboard.press('Enter');
        await page.locator(`${FOLDER_HOST} .sb-folder-manager__members .sb-status-page`).waitFor({ state: 'visible' });
        await settle(page);
    },
    close: closeDialogs,
    needs: ['character', 'folders'],
    sources: [`${SCRIPTS}/sillybunny-folder-manager.js`, STATUS_PAGE_SOURCE],
});

const TAG_HOST = '.sb-dialog-host:has(> #tag_view_list)';

/** Opens the Tag Manager from the Characters list menu. From `tag-manager.e2e.js` (`openFromList`). */
async function openTagManager(page) {
    await showCharacterView(page, 'characters');
    await page.locator(`${CHARACTER_LIST} [data-action-id="more"]`).click();
    await page.getByRole('menuitem', { name: 'Manage Tags', exact: true }).click();
    await page.locator('#tag_view_list').waitFor({ state: 'visible' });
    await settle(page);
}

const tagsEmpty = status({
    id: 'tags.empty',
    title: 'Tag Manager: no tags',
    component: 'shared',
    overlay: true,
    root: '#tag_view_list .sb-tag-manager__empty .sb-status-page',
    ready: titled('#tag_view_list .sb-tag-manager__empty .sb-status-page', 'Create a New Tag'),
    async open(page) {
        await page.evaluate(async () => {
            const tags = await import('/scripts/tags.js');
            tags.tags.splice(0, tags.tags.length);
            for (const key of Object.keys(tags.tag_map)) {
                delete tags.tag_map[key];
            }
        });
        await openTagManager(page);
        await page.locator('#tag_view_list .sb-tag-manager__empty .sb-status-page').waitFor({ state: 'visible' });
        await settle(page);
    },
    close: closeDialogs,
    sources: [`${SCRIPTS}/sillybunny-tag-manager.js`, STATUS_PAGE_SOURCE],
});

const tagsNoResults = status({
    id: 'tags.no-results',
    title: 'Tag Manager: no results for a search',
    component: 'shared',
    overlay: true,
    root: '#tag_view_list .sb-tag-manager__empty .sb-status-page',
    ready: titled('#tag_view_list .sb-tag-manager__empty .sb-status-page', 'No Results Found'),
    async open(page) {
        await openTagManager(page);
        await page.locator('#tag_view_list .tag_view_item').first().waitFor({ state: 'visible' });
        await searchDialog(page, TAG_HOST, NO_MATCH);
        await page.locator('#tag_view_list .sb-tag-manager__empty .sb-status-page').waitFor({ state: 'visible' });
        await settle(page);
    },
    close: closeDialogs,
    needs: ['character', 'tags'],
    sources: [`${SCRIPTS}/sillybunny-tag-manager.js`, STATUS_PAGE_SOURCE],
});

const tagsNoMembers = status({
    id: 'tags.no-members',
    title: 'Tag Manager: a tag without members',
    component: 'shared',
    overlay: true,
    root: `${TAG_HOST} .sb-tag-manager__members .sb-status-page`,
    ready: titled(`${TAG_HOST} .sb-tag-manager__members .sb-status-page`, 'No Members'),
    async open(page) {
        await openTagManager(page);
        // The fixture assigns only the first tags to the audit character, so the next one has no members. Tag ids count from 1.
        const unassigned = `audit-tag-${FIXTURES.tags.assigned + 1}`;
        await page.locator(`#tag_view_list .tag_view_item[id="${unassigned}"] .ds-entity-row__avatar`).click();
        await page.locator(`${TAG_HOST} .sb-tag-manager__members .sb-status-page`).waitFor({ state: 'visible' });
        await settle(page);
    },
    close: closeDialogs,
    needs: ['character', 'tags'],
    sources: [`${SCRIPTS}/sillybunny-tag-manager.js`, STATUS_PAGE_SOURCE],
});

// --- Chat History, Chats Archive, Data Bank ---------------------------------------------------------------------------

const CHAT_HISTORY_HOST = '.sb-dialog-host[data-tier="window"]:has(.sb-chat-history-dialog)';
const CHAT_HISTORY_STATUS = `${CHAT_HISTORY_HOST} #select_chat_div .sb-status-page`;

/** Opens Chat History for the audit character, as the chat bar button does. From `sillybunny-overlays.e2e.js`. */
async function openChatHistory(page) {
    await openAuditChat(page);
    await page.evaluate(() => document.getElementById('option_select_chat').click());
    await page.locator(CHAT_HISTORY_HOST).waitFor({ state: 'visible' });
    await settle(page);
}

const chatHistoryEmpty = status({
    id: 'chat-history.empty',
    title: 'Chat History: no saved chats',
    component: 'shared',
    overlay: true,
    root: CHAT_HISTORY_STATUS,
    ready: titled(CHAT_HISTORY_STATUS, 'No Chats'),
    async open(page) {
        await page.route('**/api/characters/chats', route => route.fulfill({ json: [] }));
        await page.route('**/api/chats/search', route => route.fulfill({ json: [] }));
        await openChatHistory(page);
        await page.locator(CHAT_HISTORY_STATUS).waitFor({ state: 'visible' });
        await settle(page);
    },
    close: closeDialogs,
    needs: ['character', 'chat'],
    sources: [`${SCRIPTS}/sillybunny-chat-dialogs.js`, STATUS_PAGE_SOURCE],
});

const chatHistoryNoResults = status({
    id: 'chat-history.no-results',
    title: 'Chat History: no results for a search',
    component: 'shared',
    overlay: true,
    root: CHAT_HISTORY_STATUS,
    ready: titled(CHAT_HISTORY_STATUS, 'No Results Found'),
    async open(page) {
        await openChatHistory(page);
        await page.locator(`${CHAT_HISTORY_HOST} .select_chat_block`).first().waitFor({ state: 'visible' });
        await searchDialog(page, CHAT_HISTORY_HOST, NO_MATCH);
        await page.locator(CHAT_HISTORY_STATUS).waitFor({ state: 'visible' });
        await settle(page);
    },
    close: closeDialogs,
    needs: ['character', 'chat'],
    sources: [`${SCRIPTS}/sillybunny-chat-dialogs.js`, STATUS_PAGE_SOURCE],
});

const ARCHIVE = '.sbca-dialog';

/** Answers the archive's requests from memory. From `helpers/chats-archive.js` (`bootArchive`). */
async function routeArchive(page, inventory) {
    await page.route('**/user/files/_sbca_organization.json', route => route.fulfill({ status: 404 }));
    await page.route('**/api/chats/archive/inventory', inventory);
}

/**
 * Opens the archive from the Characters list header and shows its chat list. A phone stacks the panes into pages, so the
 * list is a page that a location pushes. From `helpers/chats-archive.js` (`openArchive`, `showList`).
 */
async function openArchive(page) {
    await showCharacterView(page, 'characters');
    await page.locator('#sbca_drawer_button').click();
    await page.locator(ARCHIVE).waitFor();
    await page.waitForFunction(() => !document.querySelector('.sbca-dialog[opening]'));
    const collapsed = await page.locator('.sbca-shell').getAttribute('data-collapsed') === 'true';
    if (collapsed) {
        await page.locator('.sbca-location').first().click();
    }
}

const archiveRows = rows => route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ rows, cursor: null, read_token: null, errors: 0, total: rows.length }),
});

const archiveEmpty = status({
    id: 'archive.empty',
    title: 'Chats Archive: no chat files',
    component: 'shared',
    overlay: true,
    root: `${ARCHIVE} .sb-status-page`,
    async open(page) {
        await routeArchive(page, archiveRows([]));
        await openArchive(page);
        await page.locator(`${ARCHIVE} .sb-status-page`).first().waitFor({ state: 'visible' });
        await settle(page);
    },
    close: closeDialogs,
    owner: 'C',
    sources: ['public/scripts/extensions/sillybunny-chats-archive/src/ui/list.js', STATUS_PAGE_SOURCE],
});

const archiveError = status({
    id: 'archive.error',
    title: 'Chats Archive: the chat list could not be loaded',
    component: 'shared',
    overlay: true,
    root: `${ARCHIVE} .sb-status-page`,
    async open(page) {
        await routeArchive(page, route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"audit"}' }));
        await openArchive(page);
        await page.locator(`${ARCHIVE} .sb-status-page`).first().waitFor({ state: 'visible' });
        await settle(page);
    },
    close: closeDialogs,
    owner: 'C',
    sources: ['public/scripts/extensions/sillybunny-chats-archive/src/ui/list.js', STATUS_PAGE_SOURCE],
});

const archiveLoading = status({
    id: 'archive.loading',
    title: 'Chats Archive: loading the chat list',
    component: 'shared',
    overlay: true,
    root: `${ARCHIVE} .sb-status-page`,
    masks: [`${ARCHIVE} .sb-status-page__icon`],
    async open(page) {
        await routeArchive(page, () => new Promise(() => {}));
        await openArchive(page);
        await page.locator(`${ARCHIVE} .sb-status-page`).first().waitFor({ state: 'visible' });
        await settle(page);
    },
    close: closeDialogs,
    owner: 'C',
    sources: ['public/scripts/extensions/sillybunny-chats-archive/src/ui/list.js', STATUS_PAGE_SOURCE],
});

const dataBankEmpty = status({
    id: 'databank.empty',
    title: 'Data Bank: no attachments',
    component: 'own',
    overlay: true,
    root: '.dataBankAttachments .attachmentEmptyRow',
    async open(page) {
        // The attachments are kept in the account settings, so the page's copy of them is emptied.
        await page.evaluate(() => {
            const settings = window.SillyTavern.getContext().extensionSettings;
            settings.attachments = [];
            settings.character_attachments = {};
        });
        await page.locator('#manageAttachments').dispatchEvent('click');
        await page.locator('dialog.popup[open] .dataBankAttachments').waitFor();
        await page.locator('.dataBankAttachments .attachmentEmptyRow').first().waitFor({ state: 'visible' });
        await settle(page);
    },
    close: closeDialogs,
    sources: [`${SCRIPTS}/sillybunny-editor/adapters/data-bank-dialog.js`, `${SCRIPTS}/chats.js`],
});

const DATA_BANK_NO_RESULTS = 'dialog.popup[open] .data-bank-empty-search:not([hidden])';

const dataBankNoResults = status({
    id: 'databank.no-results',
    title: 'Data Bank: no results for a search',
    component: 'shared',
    overlay: true,
    root: DATA_BANK_NO_RESULTS,
    ready: titled(DATA_BANK_NO_RESULTS, 'No Results Found'),
    async open(page) {
        await page.locator('#manageAttachments').dispatchEvent('click');
        await page.locator('dialog.popup[open] .dataBankAttachments .attachmentListItem[data-attachment-url]').first().waitFor({ state: 'visible' });
        await page.locator('dialog.popup[open] .sb-data-bank-search-toggle').click();
        await page.locator('dialog.popup[open] #data-bank-search-field input').fill(NO_MATCH);
        await reveal(page, DATA_BANK_NO_RESULTS);
        await settle(page);
    },
    close: closeDialogs,
    needs: ['character', 'databank'],
    sources: [`${SCRIPTS}/sillybunny-editor/adapters/data-bank-dialog.js`, STATUS_PAGE_SOURCE],
});

// --- Agents -----------------------------------------------------------------------------------------------------------

/** Loads agents into the store, as `in-chat-agents-list.e2e.js` does, and shows the Agents page. Nothing is saved. */
async function showAgents(page, names) {
    await page.evaluate(async names => {
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        store.loadAgents(names.map((name, index) => ({
            ...store.createDefaultAgent(), id: `audit-${name.toLowerCase()}`, name: `Audit ${name}`, prompt: 'Audit prompt',
            description: 'Audit description', category: 'custom', phase: 'pre', enabled: false,
            favorite: index === 0, injection: { role: 0, order: index * 10, position: 0, depth: 0, scan: false },
        })));
        store.setGlobalSettings({ enabled: true, separateRecentChats: false });
        (await import('/scripts/extensions/in-chat-agents/ui/agent-list.js')).refreshAgentsPanels();
    }, names);
    await openSettingsTab(page, { shell: 'left', tab: 'agents' });
    await page.locator(AGENTS).waitFor({ state: 'visible' });
}

const agentsEmpty = status({
    id: 'agents.empty',
    title: 'Agents: no agents',
    component: 'shared',
    root: `${AGENTS} .sb-status-page`,
    async open(page) {
        await showAgents(page, []);
        await page.locator(`${AGENTS} .sb-status-page`).waitFor({ state: 'visible' });
        await settle(page);
    },
    sources: [`${SCRIPTS}/extensions/in-chat-agents/ui/agent-list.js`, STATUS_PAGE_SOURCE],
});

const agentsNoResults = status({
    id: 'agents.no-results',
    title: 'Agents: no results for a search',
    component: 'shared',
    root: `${AGENTS} .sb-status-page`,
    async open(page) {
        await showAgents(page, ['Alpha', 'Bravo', 'Charlie']);
        await page.locator(`${AGENTS} .ica-agent-row`).first().waitFor({ state: 'visible' });
        await typeInto(page, `${AGENTS} button[aria-label="Search Agents"]`, `${AGENTS} .ica-agents-search-input`, NO_MATCH);
        await page.locator(`${AGENTS} .sb-status-page`).waitFor({ state: 'visible' });
        await settle(page);
    },
    sources: [`${SCRIPTS}/extensions/in-chat-agents/ui/agent-list.js`, STATUS_PAGE_SOURCE],
});

const COMPANIONS_PAGE = `${AGENTS} [data-agent-page="companions"]`;

const companionsUnavailable = status({
    id: 'agents.companions-unavailable',
    title: 'Agents: the Companions Overview in Conversation mode',
    component: 'shared',
    root: `${COMPANIONS_PAGE} .sb-status-page`,
    async open(page) {
        await showAgents(page, ['Alpha']);
        await page.locator(AGENTS).getByRole('button', { name: 'Agents Menu', exact: true }).click();
        await page.locator('.sb-action-menu').last().getByRole('menuitem', { name: 'Companions Overview', exact: true }).click();
        await page.locator(COMPANIONS_PAGE).waitFor({ state: 'visible' });
        // The page lists no companions while Conversation mode is on. From `in-chat-agents-pages.e2e.js`.
        await page.evaluate(() => { document.getElementById('sheld').dataset.sbConversationMode = 'on'; });
        await page.locator(`${COMPANIONS_PAGE} .sb-status-page`).waitFor({ state: 'visible' });
        await settle(page);
    },
    async close(page) {
        await page.evaluate(() => { document.getElementById('sheld').dataset.sbConversationMode = 'off'; });
        await page.locator(COMPANIONS_PAGE).getByRole('button', { name: 'Back', exact: true }).click();
        await page.locator(COMPANIONS_PAGE).waitFor({ state: 'detached' });
    },
    sources: [`${SCRIPTS}/extensions/in-chat-agents/ui/companions-page.js`, STATUS_PAGE_SOURCE],
});

// --- Pickers and search ------------------------------------------------------------------------------------------------

const ASSISTANT_STATUS = 'dialog.sb-dialog-host .sb-status-page:not([hidden])';

/** Opens the Choose Assistant window on a list that the audit gives it. */
async function openAssistantPicker(page, entries) {
    await page.evaluate(async entries => {
        const { openAssistantPickerWindow } = await import('/scripts/sillybunny-home/assistant-picker.js');
        void openAssistantPickerWindow({
            getEntries: () => entries,
            getThumbnailUrl: avatar => `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`,
            choose: () => {},
        });
    }, entries);
    await page.locator('dialog.sb-dialog-host').waitFor({ state: 'visible' });
}

const assistantPickerEmpty = status({
    id: 'assistant-picker.empty',
    title: 'Assistant picker: no characters yet',
    component: 'shared',
    overlay: true,
    root: ASSISTANT_STATUS,
    async open(page) {
        await openAssistantPicker(page, []);
        await page.locator(ASSISTANT_STATUS).waitFor({ state: 'visible' });
        await settle(page);
    },
    close: closeDialogs,
    sources: [`${SCRIPTS}/sillybunny-home/assistant-picker.js`, STATUS_PAGE_SOURCE],
});

const assistantPickerNoResults = status({
    id: 'assistant-picker.no-results',
    title: 'Assistant picker: no results for a search',
    component: 'shared',
    overlay: true,
    root: ASSISTANT_STATUS,
    async open(page) {
        await openAssistantPicker(page, [{ name: FIXTURES.character.name, avatar: FIXTURES.character.avatar, selected: false }]);
        await page.locator('dialog.sb-dialog-host .ds-row[data-sb-assistant-avatar]').first().waitFor({ state: 'visible' });
        await searchDialog(page, 'dialog.sb-dialog-host', NO_MATCH);
        await page.locator(ASSISTANT_STATUS).waitFor({ state: 'visible' });
        await settle(page);
    },
    close: closeDialogs,
    sources: [`${SCRIPTS}/sillybunny-home/assistant-picker.js`, STATUS_PAGE_SOURCE],
});

const helpNoResults = status({
    id: 'help.no-results',
    title: 'Help: no topic matches a search',
    component: 'shared',
    overlay: true,
    root: 'dialog.sb-dialog-host .sb-status-page:not([hidden])',
    async open(page) {
        await page.evaluate(async () => {
            const { openHelpWindow } = await import('/scripts/sillybunny-help/help-window.js');
            void openHelpWindow();
        });
        await page.locator('dialog.sb-dialog-host').waitFor({ state: 'visible' });
        await searchDialog(page, 'dialog.sb-dialog-host', NO_MATCH);
        await page.locator('dialog.sb-dialog-host .sb-status-page:not([hidden])').waitFor({ state: 'visible' });
        await settle(page);
    },
    close: closeDialogs,
    sources: [`${SCRIPTS}/sillybunny-help/help-views.js`, STATUS_PAGE_SOURCE],
});

const pickerEmpty = status({
    id: 'picker.empty',
    title: 'Shared picker: no items to choose from',
    component: 'shared',
    overlay: true,
    root: '.sb-picker__empty .sb-status-page',
    async open(page) {
        await page.evaluate(async () => {
            const { openPicker } = await import('/scripts/sillybunny-editor/picker.js');
            const trigger = document.createElement('button');
            trigger.type = 'button';
            trigger.id = 'status_picker_trigger';
            trigger.textContent = 'Audit';
            trigger.style.cssText = 'position: fixed; top: 96px; left: 50%; transform: translateX(-50%); z-index: 1;';
            document.body.append(trigger);
            openPicker({ trigger, title: 'Audit', items: [], onSelect: () => {} });
        });
        await page.locator('.sb-picker__empty .sb-status-page').waitFor({ state: 'visible' });
        await settle(page);
    },
    async close(page) {
        await page.evaluate(async () => {
            (await import('/scripts/sillybunny-editor/picker.js')).closePicker({ animate: false, restoreFocus: false });
            document.getElementById('status_picker_trigger')?.remove();
        });
        await page.locator('.sb-picker__empty').first().waitFor({ state: 'hidden' });
    },
    sources: [`${SCRIPTS}/sillybunny-editor/picker.js`, STATUS_PAGE_SOURCE],
});

const promptsNoResults = status({
    id: 'prompts.no-results',
    title: 'Prompt editor: no results for a search',
    component: 'shared',
    root: '.sb-prompt-editor .sb-prompt-list-body > .sb-status-page',
    ready: '.sb-prompt-editor .sb-prompt-list-body > .sb-status-page',
    async open(page) {
        await openSettingsTab(page, { shell: 'left', tab: 'editor' });
        await page.locator('.sb-prompt-editor').waitFor({ state: 'visible' });
        await typeInto(page, '.sb-prompt-editor button[aria-label="Search Prompts"]', '.sb-prompt-editor input[aria-label="Search Prompts"]', NO_MATCH);
        await page.locator('.sb-prompt-editor .sb-prompt-list-body > .sb-status-page').waitFor({ state: 'visible' });
        await settle(page);
    },
    sources: [`${SCRIPTS}/sillybunny-prompt-editor.js`, STATUS_PAGE_SOURCE],
});

const groupMembersEmpty = status({
    id: 'group.members-empty',
    title: 'Group editor: a new group without members',
    component: 'shared',
    root: '[data-sb-section="members"] .sb-status-page',
    ready: '[data-sb-section="members"]:has(#rm_group_members:empty) .sb-status-page',
    async open(page) {
        await showCharacterView(page, 'groups');
        await page.locator(`${CHARACTER_LIST} [data-action-id="new"]`).click();
        await page.locator('#sb_group_editor_header').waitFor({ state: 'visible' });
        await reveal(page, '[data-sb-section="members"]');
        await settle(page);
    },
    async close(page) {
        // Cancel only discards a dirty draft, so a clean new group is left with Back. A phone has no Back button in the editor
        // header, and the shell's own back goes to the Groups tab, as `_closeSafely` does.
        const back = page.locator('#sb_group_editor_back');
        if (await back.isVisible()) {
            await back.click();
        } else {
            await showCharacterView(page, 'groups');
        }
        await page.locator('[data-sb-section="members"]').first().waitFor({ state: 'hidden' });
    },
    needs: ['character'],
    sources: [`${SCRIPTS}/sillybunny-group-editor.js`, `${SCRIPTS}/group-chats.js`],
});

// --- Settings ----------------------------------------------------------------------------------------------------------

const settingsSidebarNoMatch = status({
    id: 'settings.sidebar-no-match',
    title: 'Settings sidebar: no page matches a search',
    component: 'own',
    root: '#sb-settings-tab-list .sb-settings-tab-empty',
    async open(page) {
        await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'connections'));
        // A phone shows the page and hides the sidebar until Back is pressed.
        await showSettingsSidebar(page);
        await typeInto(page, '#sb-settings-search-toggle', '#sb-settings-search-input', 'zzzqqq');
        await page.locator('#sb-settings-tab-list .sb-settings-tab-empty').waitFor({ state: 'visible' });
        await settle(page);
    },
    sources: [`${SCRIPTS}/sillybunny-tabs.js`],
    primaryFlow: true,
});

const settingsSearchNoMatch = status({
    id: 'settings.search-no-match',
    title: 'Settings search: nothing found',
    component: 'shared',
    overlay: true,
    root: '#sb-universal-search-results .sb-search-empty .sb-status-page',
    async open(page) {
        await page.evaluate(() => window.SillyBunnyShell.openGlobalSearch());
        await page.locator('#sb-universal-search input').fill('no-such-setting-982734');
        // The idle state shares the empty class, and the first query waits for the on-demand settings pages before it answers.
        await page.locator('#sb-universal-search-results .sb-search-empty', { hasText: 'No Results Found' }).waitFor({ state: 'visible' });
        await settle(page);
    },
    async close(page) {
        await page.keyboard.press('Escape');
        await page.locator('#sb-universal-search-results .sb-search-empty').waitFor({ state: 'hidden' });
    },
    sources: [`${SCRIPTS}/sillybunny-tabs.js`],
    primaryFlow: true,
});

const SERVER_TOOLS_SCRIPT = /\/sillybunny-server-tools(?:-[a-f0-9]{12})?\.js(?:\?[^#]*)?$/;
const DATA_SECURITY_STATUS = '[data-sb-panel="data-security"] .sb-status-page';

const settingsPanelError = status({
    id: 'settings.panel-load-error',
    title: 'Settings: a page whose script failed to load',
    component: 'shared',
    root: DATA_SECURITY_STATUS,
    ready: `${DATA_SECURITY_STATUS}[data-state="error"] button`,
    // The browser's message names the server URL, whose port differs from run to run.
    masks: [`${DATA_SECURITY_STATUS} .sb-status-page__description`],
    async open(page) {
        // From `startup-on-demand.e2e.js`: the page script is requested when the page opens, and a failed request shows Retry.
        await page.route(SERVER_TOOLS_SCRIPT, route => route.abort('failed'));
        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
        await page.locator(`${DATA_SECURITY_STATUS} button`).waitFor({ state: 'visible' });
        await reveal(page, DATA_SECURITY_STATUS);
        await settle(page);
    },
    sources: [`${SCRIPTS}/sillybunny-tabs.js`, STATUS_PAGE_SOURCE],
});

const settingsPanelLoading = status({
    id: 'settings.panel-loading',
    title: 'Settings: a page whose script is still loading',
    component: 'shared',
    root: DATA_SECURITY_STATUS,
    ready: '[data-sb-panel="data-security"][aria-hidden="false"] .sb-status-page[data-state="loading"]',
    async open(page) {
        await page.route(SERVER_TOOLS_SCRIPT, () => new Promise(() => {}));
        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
        await reveal(page, DATA_SECURITY_STATUS);
        await settle(page);
    },
    sources: [`${SCRIPTS}/sillybunny-tabs.js`, STATUS_PAGE_SOURCE],
});

const samplingUnavailable = status({
    id: 'sampling.unavailable',
    title: 'Sampling: samplers that Chat Completions does not have',
    component: 'own',
    root: '#sb-sampling-openai [data-sb-sampling-placeholder]',
    // The placeholder sits in the block of the Chat Completions backend, so it only shows once that block is the one in use.
    ready: '#sb-sampling-openai [data-sb-sampling-placeholder]',
    async open(page, ctx = {}) {
        await selectBackend(page, ctx.backend ?? 'chat-completion');
        await openSettingsTab(page, { shell: 'left', tab: 'sampling' });
        await selectLogitBiasPreset(page);
        const row = page.locator('#sb-sampling-openai [data-sb-sampling-placeholder]').first();
        await row.scrollIntoViewIfNeeded();
        await settle(page);
    },
    backends: ['chat-completion'],
    needs: ['logit-bias'],
    sources: [`${SCRIPTS}/sillybunny-tabs.js`],
    primaryFlow: true,
});

// --- Home ----------------------------------------------------------------------------------------------------------------

const HOME = '#chat > .welcomePanel';

/** Renders Home again with the given recent chats. From `home-layout.e2e.js` (`renderHome`). */
async function renderHome(page, items) {
    await page.route('**/api/chats/recent', route => route.fulfill({ json: items }));
    await page.evaluate(async () => {
        const { openWelcomeScreen } = await import('/scripts/welcome-screen.js');
        await openWelcomeScreen({ force: true });
    });
    await page.locator('#sheld[data-sb-home="on"]').waitFor();
    await page.locator(HOME).waitFor({ state: 'attached' });
}

const homeRecentEmpty = status({
    id: 'home.recent-empty',
    title: 'Home: no recent chats',
    component: 'own',
    root: `${HOME} [data-sb-home-empty="all"]`,
    async open(page) {
        await renderHome(page, []);
        await reveal(page, `${HOME} [data-sb-home-empty="all"]`);
        await settle(page);
    },
    sources: [`${SCRIPTS}/sillybunny-home/mount.js`, `${SCRIPTS}/templates/sillybunnyHome.html`],
    primaryFlow: true,
});

const homeRecentFiltered = status({
    id: 'home.recent-filtered',
    title: 'Home: no recent chat matches the filter',
    component: 'shared',
    root: `${HOME} [data-recent-chat-empty-state="filtered"] .sb-status-page`,
    async open(page) {
        await renderHome(page, [{
            file_name: `${FIXTURES.chat.file}.jsonl`, avatar: FIXTURES.character.avatar, last_mes: Date.UTC(2026, 0, 1, 12), mes: 'Audit preview', chat_items: 3, file_size: '1kb',
        }]);
        await page.locator(`${HOME} .recentChatList .recentChat`).first().waitFor({ state: 'visible' });
        await page.locator(`${HOME} [data-recent-chat-filter="group"]`).click();
        await reveal(page, `${HOME} [data-recent-chat-empty-state="filtered"] .sb-status-page`);
        await settle(page);
    },
    needs: ['character', 'chat'],
    sources: [`${SCRIPTS}/sillybunny-home/mount.js`, STATUS_PAGE_SOURCE],
});

const homeRecentFailed = status({
    id: 'home.recent-failed',
    title: 'Home: the request for the recent chats failed',
    component: 'shared',
    root: `${HOME} [data-recent-chat-empty-state="failed"] .sb-status-page`,
    async open(page) {
        await page.route('**/api/chats/recent', route => route.fulfill({ status: 500, body: '' }));
        await page.evaluate(async () => {
            const { openWelcomeScreen } = await import('/scripts/welcome-screen.js');
            await openWelcomeScreen({ force: true });
        });
        await page.locator('#sheld[data-sb-home="on"]').waitFor();
        await reveal(page, `${HOME} [data-recent-chat-empty-state="failed"] .sb-status-page`);
        await settle(page);
    },
    sources: [`${SCRIPTS}/sillybunny-home/mount.js`, `${SCRIPTS}/welcome-screen.js`, STATUS_PAGE_SOURCE],
});

const homeOffline = status({
    id: 'home.offline',
    title: 'Home: the assistant cards while no model is connected',
    component: 'own',
    root: `${HOME} .sbHomeCards`,
    ready: `${HOME} .sbHomeCardConnect`,
    async open(page) {
        await renderHome(page, []);
        await page.locator(`${HOME} .sbHomeCardConnect`).first().waitFor({ state: 'visible' });
        await reveal(page, `${HOME} .sbHomeCards`);
        await settle(page);
    },
    sources: [`${SCRIPTS}/sillybunny-home/assistant-cards.js`, `${SCRIPTS}/sillybunny-connection-state.js`],
    primaryFlow: true,
});

const aboutUnknown = status({
    id: 'home.about-unknown',
    title: 'About: the server does not answer for the branch and commit',
    component: 'own',
    overlay: true,
    root: 'dialog.sb-dialog-host section.sb-dialog:has([data-sb-editor-field="about-branch"])',
    async open(page) {
        await page.route(url => url.pathname === '/version', route => route.abort());
        await page.evaluate(async () => {
            const { openAboutWindow } = await import('/scripts/sillybunny-about.js');
            void openAboutWindow();
        });
        await page.locator('[data-sb-editor-field="about-branch"]').waitFor({ state: 'visible' });
        await page.waitForFunction(() => document.querySelector('[data-sb-editor-field="about-branch"]')?.textContent.includes('Unknown'));
        await settle(page);
    },
    close: closeDialogs,
    masks: ['[data-sb-editor-field="about-version"]'],
    sources: [`${SCRIPTS}/sillybunny-about.js`],
});

// --- Persona picker and the Conversation workspace -----------------------------------------------------------------------

const PERSONA_PICKER = '#sb-persona-picker';
const PERSONA_PICKER_EMPTY = `${PERSONA_PICKER} .sb-persona-option-empty .sb-status-page`;
const PERSONA_NOTES_EMPTY = `${PERSONA_PICKER} .sb-persona-picker-appendices-empty`;

/**
 * Opens the persona menu of the bottom chat bar, with no personas defined when `withoutPersonas` is set. `getChat()`
 * (`script.js`) clicks and focuses the message box a moment after a chat loads, and that click closes an open persona
 * menu, so the menu is opened once the box has the focus. A chat that the boot restored has had that focus already, and
 * nothing moves it again (the persona bubble holds it in about one boot in fifty): only a load that this step starts is
 * waited for, which is what `openAuditChatAfterFocus()` does.
 */
async function openPersonaMenu(page, target, { withoutPersonas }) {
    await openAuditChatAfterFocus(page);
    await reveal(page, '#sb-persona-bubble', { hints: ['#sb-bottom-chat-bar'] });
    await page.evaluate(() => {
        // The notes are kept in the persona's descriptor in the account settings, so the page's copy of them is emptied.
        const context = window.SillyTavern.getContext();
        const descriptor = context.powerUserSettings.persona_descriptions?.[context.userAvatar];
        if (descriptor) {
            descriptor.appendices = [];
        }
    });
    if (withoutPersonas) {
        await page.evaluate(() => {
            const settings = window.SillyTavern.getContext().powerUserSettings;
            // The persona events reload the list, so the property answers with no personas.
            Object.defineProperty(settings, 'personas', { configurable: true, enumerable: true, get: () => ({}), set: () => {} });
        });
    }
    // The app renders an open picker again on a persona or settings event, and a picker is hidden until the frame after it is built.
    // A capture that finds it hidden opens its surface again, and the bubble would close the picker that is still there.
    if (await page.locator(PERSONA_PICKER).count() === 0) {
        await page.locator('#sb-persona-bubble').click();
    }
    await reveal(page, target, { hints: ['#sb-persona-bubble', PERSONA_PICKER, '.sb-persona-options'] });
    await settle(page);
}

async function closePersonaMenu(page, target) {
    await page.evaluate(() => document.getElementById('sb-persona-picker')?.remove());
    await page.locator(target).waitFor({ state: 'detached' });
}

const personaPickerEmpty = status({
    id: 'persona-picker.empty',
    title: 'Persona bubble menu: no personas defined',
    component: 'shared',
    overlay: true,
    root: PERSONA_PICKER_EMPTY,
    open: page => openPersonaMenu(page, PERSONA_PICKER_EMPTY, { withoutPersonas: true }),
    close: page => closePersonaMenu(page, PERSONA_PICKER_EMPTY),
    needs: ['character', 'chat'],
    sources: [`${SCRIPTS}/sillybunny-tabs.js`, STATUS_PAGE_SOURCE],
});

const personaPickerNoNotes = status({
    id: 'persona-picker.no-notes',
    title: 'Persona bubble menu: the active persona has no Scenario Notes',
    component: 'own',
    overlay: true,
    root: PERSONA_NOTES_EMPTY,
    open: page => openPersonaMenu(page, PERSONA_NOTES_EMPTY, { withoutPersonas: false }),
    close: page => closePersonaMenu(page, PERSONA_NOTES_EMPTY),
    needs: ['character', 'chat'],
    sources: [`${SCRIPTS}/sillybunny-tabs.js`],
});

const CONVERSATION_ON = '#sheld[data-sb-conversation-mode="on"]';
const TIMELINE_EMPTY = '#sb_conversation_timeline .sb-conversation-timeline-empty';
const LIST_EMPTY = '#sb_conversation_list_items .sb-status-page';

/** Opens the Conversation workspace, on the audit character's thread or on none. */
async function openConversation(page, { thread = false, messages = null } = {}) {
    if (thread) {
        await openAuditChat(page);
    }
    const avatar = thread ? FIXTURES.character.avatar : null;
    if (messages && avatar) {
        await seedConversation(page, { avatar, chats: [{ messages: alternatingMessages(messages) }] });
    }
    await page.evaluate(async (avatar) => {
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        await openConversationWorkspaceForAvatar(avatar, { showToast: false, enable: Boolean(avatar) });
    }, avatar);
    await page.locator(CONVERSATION_ON).waitFor({ state: 'visible' });
}

/** Leaves Conversation mode with the app's own function, which is what the mode's exit control calls. */
async function leaveConversation(page) {
    await page.evaluate(async () => {
        const { disableConversationModeForCurrentCharacter } = await import('/scripts/sillybunny-conversation.js');
        disableConversationModeForCurrentCharacter({ focusRoleplay: false });
    });
    await page.locator(CONVERSATION_ON).waitFor({ state: 'detached' });
}

const CONVERSATION_SOURCES = [`${SCRIPTS}/sillybunny-conversation/timeline-render.js`, `${SCRIPTS}/sillybunny-conversation/chrome.js`, STATUS_PAGE_SOURCE];

const conversationChoose = status({
    id: 'conversation.choose-conversation',
    title: 'Conversation: no DM chosen yet',
    component: 'shared',
    root: TIMELINE_EMPTY,
    ready: titled(TIMELINE_EMPTY, 'Choose a DM to Begin'),
    async open(page) {
        await openConversation(page);
        await reveal(page, TIMELINE_EMPTY);
        await settle(page);
    },
    close: leaveConversation,
    // A phone shows the Pals page when no DM is chosen; the thread area with this text is the wide layouts'.
    viewports: ['3440x1440', '1920x1080', '1440x900', '1024x600', '900x700'],
    sources: CONVERSATION_SOURCES,
    primaryFlow: true,
});

const conversationNoMessages = status({
    id: 'conversation.no-messages',
    title: 'Conversation: a DM without messages',
    component: 'shared',
    root: TIMELINE_EMPTY,
    ready: titled(TIMELINE_EMPTY, 'No DM Messages Yet'),
    async open(page) {
        await openConversation(page, { thread: true });
        await reveal(page, TIMELINE_EMPTY);
        await settle(page);
    },
    close: leaveConversation,
    needs: ['character'],
    sources: CONVERSATION_SOURCES,
});

const conversationNoMatches = status({
    id: 'conversation.no-matches',
    title: 'Conversation: no message matches the search',
    component: 'shared',
    root: TIMELINE_EMPTY,
    ready: [titled(TIMELINE_EMPTY, 'No Matching Messages'), '#sb_conversation_search'],
    async open(page) {
        await openConversation(page, { thread: true, messages: FIXTURES.chat.messages });
        await page.locator('#sb_conversation_timeline .sb-conversation-message').first().waitFor({ state: 'visible' });
        if (!await page.locator('#sb_conversation_search').isVisible()) {
            await page.locator('[data-sb-conversation-action="toggle-search"]').first().click();
        }
        await page.locator('#sb_conversation_search').fill(NO_MATCH);
        await reveal(page, TIMELINE_EMPTY);
        await settle(page);
    },
    close: leaveConversation,
    needs: ['character'],
    sources: CONVERSATION_SOURCES,
});

const START_DIRECT_CONVERSATION_EMPTY = '.sb-picker .sb-picker__empty .sb-status-page, .sb-picker-sheet:not([hidden]) .sb-picker__empty .sb-status-page';
const PICKER_SEARCH = '.sb-picker__search:visible';
const NEW_MENU = '[data-sb-conversation-action="open-new-menu"]';

const conversationStartNoMatches = status({
    id: 'conversation.start-direct-conversation-no-matches',
    title: 'Conversation: the New DM list finds no character, and the New group list as a state',
    component: 'shared',
    root: START_DIRECT_CONVERSATION_EMPTY,
    ready: titled(START_DIRECT_CONVERSATION_EMPTY, 'No matching characters found.'),
    async open(page) {
        await openConversation(page);
        await chooseMenuItem(page, NEW_MENU, 'New DM');
        await page.locator(PICKER_SEARCH).fill(NO_MATCH);
        await reveal(page, START_DIRECT_CONVERSATION_EMPTY);
        await settle(page);
    },
    states: [{
        id: 'new-group',
        async open(page) {
            await page.keyboard.press('Escape');
            await chooseMenuItem(page, NEW_MENU, 'New Group');
            await page.locator(PICKER_SEARCH).fill(NO_MATCH);
            await reveal(page, START_DIRECT_CONVERSATION_EMPTY);
            await settle(page);
        },
    }],
    close: leaveConversation,
    needs: ['character'],
    sources: [`${SCRIPTS}/sillybunny-conversation/pickers.js`, ...CONVERSATION_SOURCES],
});

const CONVERSATION_PERSONAS_EMPTY = '#sb_conversation_persona_picker .sb-status-page';

const conversationPersonasEmpty = status({
    id: 'conversation.personas-empty',
    title: 'Conversation: the persona list with no personas defined',
    component: 'shared',
    root: CONVERSATION_PERSONAS_EMPTY,
    async open(page) {
        await openConversation(page, { thread: true });
        await page.evaluate(() => {
            const settings = window.SillyTavern.getContext().powerUserSettings;
            // The persona events reload the list, so the property answers with no personas.
            Object.defineProperty(settings, 'personas', { configurable: true, enumerable: true, get: () => ({}), set: () => {} });
        });
        const personaMenu = '[data-sb-conversation-action="open-persona-menu"]';
        if (!await page.locator(personaMenu).first().isVisible()) {
            // A phone keeps the user's footer on the Pals page.
            await page.locator('[data-sb-conversation-action="toggle-list"]').first().click();
        }
        await chooseMenuItem(page, personaMenu, 'Switch Persona…');
        await reveal(page, CONVERSATION_PERSONAS_EMPTY);
        await settle(page);
    },
    close: leaveConversation,
    // The round avatars of the Pals rail and the rail footer are cut from a downscaled picture, and the status dots are small circles: their edge pixels differ by a few levels between runs.
    masks: ['.sb-conversation-participant-avatar', '.sb-conversation-status-dot', '#sb_conversation_rail_footer .sb-conversation-persona-button'],
    needs: ['character'],
    sources: [`${SCRIPTS}/sillybunny-conversation/pickers.js`, ...CONVERSATION_SOURCES],
});

const conversationListEmpty = status({
    id: 'conversation.list-empty',
    title: 'Conversation: the Pals list without a DM',
    component: 'shared',
    root: LIST_EMPTY,
    async open(page) {
        await openConversation(page);
        if (!await page.locator(LIST_EMPTY).first().isVisible()) {
            // A phone keeps the Pals list on its own page.
            await page.locator('[data-sb-conversation-action="toggle-list"]').first().click();
        }
        await reveal(page, LIST_EMPTY);
        await settle(page);
    },
    close: leaveConversation,
    sources: [`${SCRIPTS}/sillybunny-conversation/interface.js`, ...CONVERSATION_SOURCES],
});

// --- Settings pages and their dialogs ------------------------------------------------------------------------------------

const LOGS_EMPTY = '[data-sb-panel="logs"] .sb-console-log-output.is-empty';

const logsEmpty = status({
    id: 'logs.empty',
    title: 'Logs: no console output captured',
    component: 'own',
    root: LOGS_EMPTY,
    masks: ['[data-sb-panel="logs"] .sb-console-log-note'],
    async open(page) {
        await page.route('**/api/server-admin/logs', route => route.fulfill({ json: { entries: [], latestId: 0, totalBuffered: 0, captureStartedAt: 0 } }));
        await openSettingsTab(page, { shell: 'right', tab: 'logs' });
        // The page shows its first answer once the status pill has left "Loading".
        await page.locator('[data-sb-panel="logs"] .sb-server-pill:has-text("Live")').first().waitFor({ state: 'visible' });
        await reveal(page, LOGS_EMPTY);
        await settle(page);
    },
    sources: [`${SCRIPTS}/sillybunny-server-tools.js`],
});

const BACKGROUNDS_HINT = '#bg_chat_hint .sb-status-page';

const backgroundsChatEmpty = status({
    id: 'backgrounds.chat-empty',
    title: 'Backgrounds: no chat backgrounds yet (the Chat tab shows a hint)',
    component: 'shared',
    root: BACKGROUNDS_HINT,
    async open(page) {
        // The Chat tab lists the backgrounds that the open chat has saved, and no chat is open here; the list is cleared anyway.
        await page.evaluate(() => { delete window.SillyTavern.getContext().chatMetadata.chat_backgrounds; });
        await openSettingsTab(page, { shell: 'right', tab: 'appearance' });
        await page.locator('#bg_tabs a[href="#bg_chat_tab"]').click();
        await reveal(page, BACKGROUNDS_HINT);
        await settle(page);
    },
    upstreamMarkup: true,
    sources: [`${SCRIPTS}/backgrounds.js`, 'public/index.html'],
});

const LOGPROBS_EMPTY = '.sb-side-panel[data-sb-side-panel-id="logprobsViewer"] .logprobs_empty_state';

const logprobsEmpty = status({
    id: 'logprobs.empty',
    title: 'Token Probabilities: nothing to show for the message',
    component: 'shared',
    overlay: true,
    root: `${LOGPROBS_EMPTY} .sb-status-page`,
    async open(page) {
        // The view draws itself on a chat event while it is shown, so the panel opens first and the chat is then opened.
        await page.evaluate(() => window.SillyBunnySidePanels.openSidePanel('logprobsViewer'));
        await openAuditChat(page);
        await reveal(page, LOGPROBS_EMPTY, { hints: ['.sb-side-panel[data-sb-side-panel-id="logprobsViewer"]', '#logprobs_generation_output', '.logprobs_empty_state'] });
        await settle(page);
    },
    close: page => closeSidePanelById(page, 'logprobsViewer'),
    owner: 'B',
    sources: [`${SCRIPTS}/logprobs.js`],
});

const PATHFINDER_ROW = '[data-sb-subpage-row="extension_settings_in_chat_agents_pathfinder"]';
const PATHFINDER_EMPTY = '#pf--lorebook-list .pf--empty-state';

const pathfinderEmpty = status({
    id: 'pathfinder.no-lorebooks',
    title: 'Pathfinder settings: no lorebooks to choose from',
    component: 'shared',
    root: `${PATHFINDER_EMPTY} .sb-status-page`,
    async open(page) {
        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
        // A state opens on a page whose subpage is already open, where the row is hidden.
        if (!await page.locator('#pf--settings').isVisible()) {
            await reveal(page, PATHFINDER_ROW);
            await page.locator(PATHFINDER_ROW).click();
        }
        await page.locator('#pf--settings').waitFor({ state: 'visible' });
        // The list shows the books the server has, so the app's own list of them is emptied before the refresh button redraws it.
        await page.evaluate(async () => {
            (await import('/scripts/world-info.js')).world_names.splice(0);
            document.getElementById('pf--refresh-lorebooks').click();
        });
        await reveal(page, PATHFINDER_EMPTY, { hints: ['#pf--lorebook-list', '#pf--lorebook-list .pf--lorebook-item', '.pf--empty-state'] });
        await settle(page);
    },
    states: [{
        id: 'permissions',
        root: '#pf--permission-matrix .pf--permission-empty .sb-status-page',
        ready: '#pf--permission-matrix .pf--permission-empty .sb-status-page',
        async open(page) {
            await reveal(page, '#pf--permission-matrix .pf--permission-empty');
            await settle(page);
        },
    }],
    sources: [`${SCRIPTS}/extensions/in-chat-agents/pathfinder-settings-ui.js`, `${SCRIPTS}/extensions/in-chat-agents/pathfinder-settings.html`],
    owner: 'C',
});

const KEY_MANAGER_EMPTY = 'dialog.popup[open] .secretKeyManagerListEmpty';

const secretsEmpty = status({
    id: 'secrets.no-keys',
    title: 'API key manager: no secrets saved',
    component: 'shared',
    overlay: true,
    root: `${KEY_MANAGER_EMPTY} .sb-status-page`,
    async open(page) {
        await page.route('**/api/secrets/read', route => route.fulfill({ json: { api_key_openai: [] } }));
        await page.route('**/api/secrets/settings', route => route.fulfill({ json: { allowKeysExposure: true } }));
        await page.locator('.manage-api-keys[data-key="api_key_openai"]').first().dispatchEvent('click');
        await reveal(page, KEY_MANAGER_EMPTY);
        await settle(page);
    },
    close: closeDialogs,
    owner: 'B',
    sources: [`${SCRIPTS}/secrets.js`, `${SCRIPTS}/templates/secretKeyManager.html`],
});

const CM_FOLDERS_EMPTY = 'dialog.popup[open] .folder-empty-message';

const connectionFoldersEmpty = status({
    id: 'connection-profiles.no-folders',
    title: 'Connection profile folders: no folders yet',
    component: 'own',
    overlay: true,
    root: CM_FOLDERS_EMPTY,
    async open(page) {
        await openSettingsTab(page, { shell: 'left', tab: 'connections' });
        // The folders are kept in the account settings, so the page's copy of them is emptied.
        await page.evaluate(() => { window.SillyTavern.getContext().extensionSettings.connectionManager.folders = []; });
        await page.locator('#manage_profile_folders').dispatchEvent('click');
        await reveal(page, CM_FOLDERS_EMPTY);
        await settle(page);
    },
    close: closeDialogs,
    sources: ['public/scripts/extensions/connection-manager/index.js', 'public/scripts/extensions/connection-manager/folder-manager.html'],
    owner: 'C',
});

const MODEL_PICKER_TRIGGER = '[data-sb-editor-field="model_openrouter_select"] .ds-select-row__trigger';
const MODEL_PICKER_EMPTY = '.sb-picker__empty .sb-status-page';

const modelPickerEmpty = status({
    id: 'connections.model-picker-empty',
    title: 'Connections: the model list when the backend has no options',
    component: 'shared',
    overlay: true,
    root: MODEL_PICKER_EMPTY,
    async open(page) {
        await selectBackend(page, 'chat-completion');
        await openSettingsTab(page, { shell: 'left', tab: 'connections' });
        // The select has lost its options, as one does while the model list loads; the row's own picker opens from its trigger, on a phone too.
        await page.evaluate(() => {
            const select = document.getElementById('model_openrouter_select');
            if (!select) {
                throw new Error('The OpenRouter model select is not in the page.');
            }
            select.replaceChildren();
        });
        const trigger = page.locator(MODEL_PICKER_TRIGGER);
        await trigger.scrollIntoViewIfNeeded();
        await trigger.click();
        await reveal(page, MODEL_PICKER_EMPTY);
        await settle(page);
    },
    async close(page) {
        await page.keyboard.press('Escape');
        await page.locator(MODEL_PICKER_EMPTY).first().waitFor({ state: 'hidden' });
    },
    viewports: MOBILE_LAYOUT_VIEWPORTS,
    sources: [`${SCRIPTS}/sillybunny-editor/select-row.js`, `${SCRIPTS}/sillybunny-editor/picker.js`, STATUS_PAGE_SOURCE],
});

// --- Companion panel and cards -------------------------------------------------------------------------------------------

const TRACKER_PANEL = '#ica--tracker-panel.is-open';

/** Loads companion agents into the store without saving them, as `helpers/in-chat-agents-companion-panel.js` does. */
async function loadCompanions(page, mode) {
    await page.evaluate(async mode => {
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        store.loadAgents(mode ? [{
            ...store.createDefaultAgent(), id: 'qa-note', name: 'Continuity Note', execution: 'companion', category: 'companion', enabled: true,
            icon: 'fa-user-astronaut', injection: { order: 0 }, companion: { displayMode: mode, format: 'markdown' },
        }] : []);
        store.setGlobalSettings({ enabled: true, separateRecentChats: false });
    }, mode);
}

async function openCompanionPanel(page, root) {
    await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel());
    await reveal(page, root);
    await settle(page);
}

async function closeCompanionPanel(page) {
    await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).closeCompanionPanel());
    await page.locator(TRACKER_PANEL).waitFor({ state: 'detached' });
}

const COMPANION_SOURCES = [`${SCRIPTS}/extensions/in-chat-agents/companion/companion-panel.js`, `${SCRIPTS}/extensions/in-chat-agents/companion/companion-ui.js`];

const companionPanelEmpty = status({
    id: 'companion-panel.empty',
    title: 'Companion panel: no companion agents enabled',
    component: 'shared',
    overlay: true,
    root: `${TRACKER_PANEL} .ica--tpanel-body > .sb-status-page`,
    async open(page) {
        await loadCompanions(page, null);
        await openCompanionPanel(page, `${TRACKER_PANEL} .ica--tpanel-body > .sb-status-page`);
    },
    close: closeCompanionPanel,
    sources: [...COMPANION_SOURCES, STATUS_PAGE_SOURCE],
    owner: 'C',
});

const companionPanelNoState = status({
    id: 'companion-panel.no-state',
    title: 'Companion panel: an enabled companion that has not run yet',
    component: 'own',
    overlay: true,
    root: `${TRACKER_PANEL} .ica--tpanel-agent .ica--cdash-empty`,
    async open(page) {
        await loadCompanions(page, 'panel');
        await openCompanionPanel(page, `${TRACKER_PANEL} .ica--tpanel-agent .ica--cdash-empty`);
    },
    close: closeCompanionPanel,
    sources: COMPANION_SOURCES,
    owner: 'C',
});

const COMPANION_CARD_EMPTY = '#chat .ica--companion-card .ica--companion-empty';

/** Shows a companion note card on the first message of the audit chat. */
async function showCompanionCard(page, { status: resultStatus, content }) {
    await openAuditChat(page);
    await loadCompanions(page, 'card');
    await page.evaluate(async ({ resultStatus, content }) => {
        const app = await import('/script.js');
        const message = app.chat[0];
        if (!message) {
            throw new Error('The audit chat has no first message.');
        }
        // The agents read the active swipe's own extra first, which this setter keeps in step with the message's.
        const { setAgentExtraValue } = await import('/scripts/extensions/in-chat-agents/agent-runner.js');
        setAgentExtraValue(message, 'inChatAgentCompanionResults', {
            'qa-note': { status: resultStatus, agentName: 'Continuity Note', content, displayMode: 'card', format: 'markdown', icon: 'fa-user-astronaut' },
        });
        (await import('/scripts/extensions/in-chat-agents/companion/companion-ui.js')).renderCompanionResultsForMessage(0);
    }, { resultStatus, content });
}

const companionCardEmpty = status({
    id: 'companion-card.empty',
    title: 'Companion note card: the run was cancelled, and no note was returned as a state',
    component: 'own',
    root: COMPANION_CARD_EMPTY,
    ready: `${COMPANION_CARD_EMPTY}:has-text("cancelled")`,
    async open(page) {
        await showCompanionCard(page, { status: 'cancelled', content: '' });
        await reveal(page, COMPANION_CARD_EMPTY, { hints: ['#chat .mes', '.ica--companion-card', '.ica--companion-ledger', '.ica--companion-empty', '#chat'] });
        await settle(page);
    },
    states: [{
        id: 'no-note',
        ready: `${COMPANION_CARD_EMPTY}:has-text("No note returned")`,
        async open(page) {
            await showCompanionCard(page, { status: 'done', content: '' });
            await reveal(page, COMPANION_CARD_EMPTY);
            await settle(page);
        },
    }],
    needs: ['character', 'chat'],
    sources: [`${SCRIPTS}/extensions/in-chat-agents/companion/companion-ui.js`],
    owner: 'C',
});

/** @type {import('./index.js').Surface[]} */
export const surfaces = [
    charactersEmpty,
    charactersNoResults,
    characterEditorEmpty,
    charactersLoading,
    importLoading,
    personaEmpty,
    personaNoResults,
    worldInfoPick,
    worldInfoNoEntries,
    worldInfoNoResults,
    worldInfoSettingsNoResults,
    foldersEmpty,
    foldersNoResults,
    foldersNoMembers,
    tagsEmpty,
    tagsNoResults,
    tagsNoMembers,
    chatHistoryEmpty,
    chatHistoryNoResults,
    archiveEmpty,
    archiveError,
    archiveLoading,
    dataBankEmpty,
    dataBankNoResults,
    agentsEmpty,
    agentsNoResults,
    companionsUnavailable,
    assistantPickerEmpty,
    assistantPickerNoResults,
    helpNoResults,
    pickerEmpty,
    promptsNoResults,
    groupMembersEmpty,
    settingsSidebarNoMatch,
    settingsSearchNoMatch,
    settingsPanelError,
    settingsPanelLoading,
    samplingUnavailable,
    homeRecentEmpty,
    homeRecentFiltered,
    homeRecentFailed,
    homeOffline,
    aboutUnknown,
    personaPickerEmpty,
    personaPickerNoNotes,
    conversationChoose,
    conversationNoMessages,
    conversationNoMatches,
    conversationListEmpty,
    conversationStartNoMatches,
    conversationPersonasEmpty,
    logsEmpty,
    backgroundsChatEmpty,
    logprobsEmpty,
    pathfinderEmpty,
    secretsEmpty,
    connectionFoldersEmpty,
    modelPickerEmpty,
    companionPanelEmpty,
    companionPanelNoState,
    companionCardEmpty,
];
