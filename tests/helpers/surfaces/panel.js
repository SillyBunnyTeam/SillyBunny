/**
 * The panel family: surfaces that sit beside or above the chat without replacing it.
 *
 * - Side panels (`registerSidePanel`): Author's Note, CFG, Token Probabilities and the chat sidebar. A side panel is a
 *   docked pane on a wide window and a bottom sheet on a narrow one, so each has one entry that shows whichever layout
 *   the viewport gives it. Two panels on one side split the height, which only a docked layout does (`stacked`).
 * - Phone sheets: the bottom chat sheet, the chat tools sheet, and the property sheets of the four list-content editors
 *   (World Info entry, persona, prompt, agent). A property sheet exists only where the editor has collapsed its property
 *   bar to a summary button, so those entries list the viewports where it does.
 * - Moving UI (owner class B): the zoomed avatar, the gallery with its image viewer, and the expression holder.
 * - The in-chat-agents companion panel (owner class C).
 *
 * The bottom-sheet form of menus and pickers belongs to the menu family, and so does the side panel header menu.
 */

import { readFileSync } from 'node:fs';
import { AVATAR_IMAGE } from './need-kit.js';
import { FIXTURES } from './fixture-data.js';
import { seedCompanionPanel } from '../in-chat-agents-companion-panel.js';
import {
    MOBILE_LAYOUT_VIEWPORTS,
    PROPERTY_SHEETS,
    WIDE_LAYOUT_VIEWPORTS,
    closeBottomChatSheet,
    closeChatToolsSheet,
    closePropertySheet,
    closeSidePanelById,
    openAuditChat,
    openBottomChatSheet,
    openChatToolsSheet,
    openPropertySheet,
    openSidePanelById,
    waitForPanelToSettle,
} from './panel-steps.js';
import { settle } from './steps.js';

const SCRIPTS = 'public/scripts';
const SIDE_PANELS_SOURCES = [`${SCRIPTS}/sillybunny-editor/side-panel.js`, `${SCRIPTS}/sillybunny-editor/adapters/side-panels.js`];
const sidePanelRoot = id => `.sb-side-panel[data-sb-side-panel-id="${id}"]`;

/**
 * The viewports where a side panel docks: a panel is 280px at least and the chat keeps 360px (`MIN_CHAT_WIDTH` in
 * `side-panel.js`), so a panel on one side docks from a 640px viewport and is a bottom sheet below it. That makes 768x1024
 * a docked layout although the shell is in its mobile layout there. Measured on the stacked entry: both panels dock at
 * these six sizes, and one panel is a sheet at 390x844 and below.
 */
const DOCKED_VIEWPORTS = [...WIDE_LAYOUT_VIEWPORTS, '768x1024'];

/**
 * The viewports where Visual Novel mode exists. The extension enters it by user agent (`isMobile()` is false only for a
 * desktop browser), so a phone or a tablet never does. The test browser always has a desktop user agent and would enter it
 * at any width, which no user can reach, so only the desktop-sized windows are listed.
 */
const VISUAL_NOVEL_VIEWPORTS = ['1440x900', '1024x600', '900x700'];

const mockedPages = new WeakMap();

/** Runs `register` once per page: a route handler stacks on every call, and a page keeps its routes across reloads. */
async function mockOnce(page, key, register) {
    const done = mockedPages.get(page) ?? new Set();
    mockedPages.set(page, done);
    if (!done.has(key)) {
        done.add(key);
        await register(page);
    }
}

/**
 * A side panel of `registerSidePanel`.
 * @param {object} panel
 * @param {string} panel.id The panel id that the controller and `data-sb-side-panel-id` use.
 * @param {string} panel.name The last word of the surface id.
 * @param {string} [panel.trigger] The options-menu item that opens it.
 * @param {(page: import('@playwright/test').Page) => Promise<void>} [panel.afterOpen] Waits for content that the panel adds on a timer of its own, once it is shown.
 * @param {(page: import('@playwright/test').Page) => Promise<void>} [panel.reset] Puts back what a state of the entry changes. It runs once the panel is open, in case an
 *   earlier visit left the change, and again before the panel closes, so that the next entry does not inherit it.
 */
function sidePanel({ id, name, title, trigger, sources, masks, states, needs = ['character', 'chat'], ready, afterOpen, reset }) {
    return {
        id: `panel.side.${name}`,
        family: 'panel',
        owner: 'A',
        title,
        root: sidePanelRoot(id),
        async open(page) {
            await openSidePanelById(page, { id, trigger });
            await afterOpen?.(page);
            await reset?.(page);
        },
        async close(page) {
            await reset?.(page);
            await closeSidePanelById(page, id);
        },
        ready: [`${sidePanelRoot(id)} .sb-side-panel__title`, ...ready],
        ...(states && { states }),
        ...(masks && { masks }),
        needs,
        sources: [...SIDE_PANELS_SOURCES, ...sources],
        primaryFlow: true,
    };
}

const logprobTokens = ['The', ' room', ' is', ' quiet', ',', ' and', ' the', ' lamp', ' glows', '.'];

/**
 * Has the panel render its view, which it does on a debounce after an edit or a chat change and only while it is shown, so
 * that a chat change that comes before the panel is shown leaves the view blank. The message for a chat without
 * probabilities is what a render gives here.
 */
async function renderTokenProbabilities(page) {
    await page.evaluate(async () => {
        const { eventSource, event_types } = await import('/script.js');
        await eventSource.emit(event_types.MESSAGE_EDITED, 0);
    });
    await page.locator('#logprobs_generation_output .logprobs_empty_state').waitFor({ state: 'visible' });
}

/** Gives the last message token probabilities, as a generation with "Request token probabilities" would, and selects a token. */
async function showTokenProbabilities(page) {
    await page.evaluate(async tokens => {
        const { saveLogprobsForActiveMessage } = await import('/scripts/logprobs.js');
        const { eventSource, event_types } = await import('/script.js');
        saveLogprobsForActiveMessage(tokens.map((token, index) => ({
            token,
            topLogprobs: [[token, -0.1 - index * 0.05], [`${token}s`, -2.4], [`${token}!`, -3.1], [` other${index}`, -4.2]],
        })), null);
        await eventSource.emit(event_types.MESSAGE_EDITED, 0);
    }, logprobTokens);
    await page.locator('#logprobs_generation_output .logprobs_output_token').first().waitFor({ state: 'visible' });
    await page.locator('#logprobs_generation_output .logprobs_output_token').nth(3).click();
    await page.locator('#logprobs_selected_top_logprobs .logprobs_top_candidate').first().waitFor({ state: 'visible' });
    await settle(page);
}

/**
 * A property sheet of a list-content editor: the dialog that the editor's summary button opens once it has collapsed. The
 * steps and the sizes are in `panel-steps.js` (`PROPERTY_SHEETS`), where the header family reads them too.
 */
function propertySheet({ name, title, editor, ready, sources, needs }) {
    const sheet = PROPERTY_SHEETS[editor];
    return {
        id: `panel.sheet.${name}`,
        family: 'panel',
        owner: 'A',
        title,
        root: sheet.root,
        ready,
        open: page => openPropertySheet(page, sheet),
        close: page => closePropertySheet(page, sheet),
        viewports: sheet.viewports,
        needs,
        sources,
    };
}

/** Serves the images that the gallery lists, so that it has thumbnails without a gallery folder on the server. */
async function mockGalleryImages(page) {
    await page.route('**/api/images/list', route => route.fulfill({ json: ['audit-image-1.png', 'audit-image-2.png', 'audit-image-3.png'] }));
    await page.route('**/user/images/**', route => route.fulfill({ contentType: 'image/png', body: AVATAR_IMAGE }));
}

const GALLERY = '#gallery';
const GALLERY_IMAGE = '.galleryImageDraggable';

/** A bundled sprite with a transparent background, so that a holder shows as a figure and not as a block. */
const SPRITE_IMAGE = readFileSync(new URL('../../../default/content/Seraphina/caring.png', import.meta.url));

/** Serves a sprite for every character, so that the expression holder has an image. From `side-panel-adapters.e2e.js`. */
async function mockSprite(page) {
    await page.route(/\/api\/sprites\/get(?:\?.*)?$/, route => route.fulfill({ json: [{ label: 'caring', path: '/audit-expression-sprite.png' }] }));
    await page.route('**/audit-expression-sprite.png', route => route.fulfill({ contentType: 'image/png', body: SPRITE_IMAGE }));
}

/** Keeps the expressions extension off its classifier, which would fetch a model, and sets the one sprite label that the mock serves. */
async function useMockedExpressions(page) {
    await page.waitForFunction(() => Boolean(window.SillyTavern.getContext().extensionSettings.expressions));
    await page.evaluate(() => {
        const settings = window.SillyTavern.getContext().extensionSettings.expressions;
        settings.api = 'none';
        settings.fallback_expression = 'caring';
    });
}

const AUTHORS_NOTE_POSITION = 'input[name="extension_floating_position"]';

/** Selects an Author's Note position as a click on its radio does. The position is stored in the chat's metadata, so a change outlives the page. */
async function selectAuthorsNotePosition(page, value) {
    await page.evaluate(({ selector, value }) => {
        const input = document.querySelector(`${selector}[value="${value}"]`);
        if (input.checked) {
            return;
        }
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, { selector: AUTHORS_NOTE_POSITION, value });
}

/** "In-chat @ Depth", the position that a chat has until the user picks another. */
const AUTHORS_NOTE_DEFAULT_POSITION = '1';
const AUTHORS_NOTE_POSITION_BEFORE = '2';

/** Opens the audit group and its chat, as the group list does. */
async function openAuditGroup(page, { switchMenu }) {
    await page.evaluate(async ({ name, switchMenu }) => {
        const groupChats = await import('/scripts/group-chats.js');
        const group = groupChats.groups.find(candidate => candidate.name === name);
        if (!group || !await groupChats.openGroupById(group.id, { switchMenu })) {
            throw new Error(`Could not open the group ${name}.`);
        }
    }, { name: FIXTURES.group.name, switchMenu });
}

/** @type {import('./index.js').Surface[]} */
export const surfaces = [
    sidePanel({
        id: 'floatingPrompt',
        name: 'authors-note',
        title: 'Side panel: Author\'s Note',
        trigger: '#option_toggle_AN',
        ready: ['#extension_floating_prompt'],
        states: [{
            id: 'position-before',
            ready: '.ds-row[data-sb-editor-field="authors-note-main-position"]',
            async open(page) {
                // "Before" and "After" hide the Depth and Role rows that "In-chat @ Depth" shows.
                await selectAuthorsNotePosition(page, AUTHORS_NOTE_POSITION_BEFORE);
                await page.locator('.ds-row[data-sb-editor-field="authors-note-main-depth"]').waitFor({ state: 'hidden' });
                // On a phone the row is below the fold of the sheet, so the user scrolls to it.
                await page.locator('.ds-row[data-sb-editor-field="authors-note-main-position"]').scrollIntoViewIfNeeded();
                await settle(page);
            },
        }],
        reset: page => selectAuthorsNotePosition(page, AUTHORS_NOTE_DEFAULT_POSITION),
        sources: [`${SCRIPTS}/authors-note.js`],
    }),
    sidePanel({
        id: 'cfgConfig',
        name: 'cfg',
        title: 'Side panel: CFG',
        trigger: '#option_toggle_CFG',
        ready: ['#chat_cfg_negative_prompt'],
        // The group-chat state opens the group, which creates its chat file when there is none.
        needs: ['character', 'chat', 'group', 'group-chat'],
        states: [{
            id: 'group-chat',
            ready: '#groupchat_cfg_use_chara_container',
            async open(page) {
                // A group chat swaps the Character CFG section for a switch that uses each member's scales.
                await openAuditGroup(page, { switchMenu: false });
                if (!await page.locator(sidePanelRoot('cfgConfig')).isVisible()) {
                    await page.evaluate(() => document.querySelector('#option_toggle_CFG').click());
                }
                await page.locator('#groupchat_cfg_use_chara_container').waitFor({ state: 'visible' });
                await waitForPanelToSettle(page, 'cfgConfig');
                // On a phone the switch is below the fold of the sheet, so the user scrolls to it.
                await page.locator('#groupchat_cfg_use_chara_container').scrollIntoViewIfNeeded();
                await settle(page);
            },
        }],
        sources: [`${SCRIPTS}/cfg-scale.js`],
    }),
    sidePanel({
        id: 'logprobsViewer',
        name: 'token-probabilities',
        title: 'Side panel: Token Probabilities',
        trigger: '#option_toggle_logprobs',
        ready: ['.logprobs_panel_content > small'],
        afterOpen: renderTokenProbabilities,
        sources: [`${SCRIPTS}/logprobs.js`],
        states: [{ id: 'token-selected', ready: '#logprobs_selected_top_logprobs .logprobs_top_candidate', open: showTokenProbabilities }],
    }),
    sidePanel({
        id: 'sb-chat-sidebar',
        name: 'chat-sidebar',
        title: 'Side panel: Recent Chats (chat sidebar)',
        ready: ['.sb-chat-sidebar-list .sb-chat-file'],
        sources: [`${SCRIPTS}/sillybunny-tabs.js`],
        masks: ['.sb-chat-file-head small', '.sb-chat-file-meta small'],
    }),
    {
        id: 'panel.side.stacked',
        family: 'panel',
        owner: 'A',
        title: 'Side panels: Author\'s Note and CFG stacked on the left',
        root: sidePanelRoot('floatingPrompt'),
        async open(page) {
            await openSidePanelById(page, { id: 'floatingPrompt', trigger: '#option_toggle_AN' });
            await openSidePanelById(page, { id: 'cfgConfig', trigger: '#option_toggle_CFG' });
            // The entry is the docked layout: a viewport that is listed but turns the panels into a sheet must fail here.
            const layouts = await page.evaluate(selectors => selectors.map(selector => document.querySelector(selector).className), [sidePanelRoot('floatingPrompt'), sidePanelRoot('cfgConfig')]);
            if (!layouts.every(className => className.includes('sb-side-panel--left'))) {
                throw new Error(`The panels are not docked on the left: ${layouts.join(' | ')}`);
            }
        },
        async close(page) {
            await closeSidePanelById(page, 'cfgConfig');
            await closeSidePanelById(page, 'floatingPrompt');
        },
        ready: [`${sidePanelRoot('floatingPrompt')} .sb-side-panel__title`, `${sidePanelRoot('cfgConfig')} .sb-side-panel__title`],
        viewports: DOCKED_VIEWPORTS,
        needs: ['character', 'chat'],
        sources: SIDE_PANELS_SOURCES,
    },
    {
        id: 'panel.sheet.bottom-chat',
        family: 'panel',
        owner: 'A',
        title: 'Bottom chat sheet (chat picker and chat actions)',
        root: '#sb-bottom-chat-sheet',
        ready: ['#sb-bottom-chat-select', '#sb-bottom-chat-sheet .sb-bottom-chat-btn'],
        open: openBottomChatSheet,
        close: closeBottomChatSheet,
        masks: ['#sb-bottom-chat-select'],
        viewports: MOBILE_LAYOUT_VIEWPORTS,
        needs: ['character', 'chat'],
        sources: [`${SCRIPTS}/sillybunny-mobile-bottom-bar.js`],
        primaryFlow: true,
    },
    {
        id: 'panel.sheet.chat-tools',
        family: 'panel',
        owner: 'A',
        title: 'Chat tools sheet (search, switch chat, recent chats)',
        root: '#sb-mobile-chat-tools',
        ready: ['#sb-mobile-chat-search', '#sb-mobile-chat-select'],
        open: openChatToolsSheet,
        close: closeChatToolsSheet,
        masks: ['#sb-mobile-chat-select', '.sb-mobile-chat-files small'],
        viewports: MOBILE_LAYOUT_VIEWPORTS,
        needs: ['character', 'chat'],
        sources: [`${SCRIPTS}/sillybunny-tabs.js`],
        primaryFlow: true,
    },
    propertySheet({
        name: 'world-info-properties',
        title: 'World Info entry: properties sheet',
        editor: 'worldInfo',
        ready: '.sb-world-info-properties-dialog .sb-wi-property',
        needs: ['lorebook'],
        sources: [`${SCRIPTS}/sillybunny-world-info-entry.js`],
    }),
    propertySheet({
        name: 'persona-properties',
        title: 'Persona detail: properties sheet',
        editor: 'persona',
        ready: '.sb-persona-properties-dialog .sb-persona-property',
        needs: ['persona'],
        sources: [`${SCRIPTS}/sillybunny-persona-detail.js`],
    }),
    propertySheet({
        name: 'prompt-properties',
        title: 'Prompt editor: properties sheet',
        editor: 'prompt',
        ready: '.sb-prompt-properties-dialog .sb-prompt-property',
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-prompt-editor.js`],
    }),
    propertySheet({
        name: 'agent-properties',
        title: 'Agent editor: properties sheet',
        editor: 'agent',
        ready: '.ica-agent-property-sheet h2',
        needs: ['agents'],
        sources: [`${SCRIPTS}/extensions/in-chat-agents/ui/agent-editor-properties.js`],
    }),
    {
        id: 'panel.moving.zoomed-avatar',
        family: 'panel',
        owner: 'B',
        title: 'Zoomed avatar (moving UI window)',
        root: '.zoomed_avatar[forChar]',
        ready: '.zoomed_avatar[forChar] img',
        async open(page) {
            await openAuditChat(page);
            if (!await page.locator('.zoomed_avatar[forChar]').count()) {
                await page.locator('#chat .mes[is_user="false"] .avatar').first().click();
            }
            await page.locator('.zoomed_avatar[forChar]').first().waitFor({ state: 'visible' });
            await page.waitForFunction(() => {
                const zoomed = document.querySelector('.zoomed_avatar[forChar]');
                const image = zoomed?.querySelector('img');
                return Boolean(image?.complete && image.naturalWidth > 0) && getComputedStyle(zoomed).opacity === '1';
            });
            await settle(page);
        },
        async close(page) {
            // The close button can sit under the top bar on a very short window, where a pointer click cannot reach it.
            await page.locator('.zoomed_avatar[forChar] .dragClose').first().evaluate(button => button.click());
            await page.locator('.zoomed_avatar[forChar]').waitFor({ state: 'detached' });
        },
        // The composer's wand button, which the edge of the window crosses at 844x390, moves by 1/255 from one screenshot to the next.
        masks: ['#extensionsMenuButton'],
        needs: ['character', 'chat'],
        sources: ['public/script.js', 'public/style.css'],
    },
    {
        id: 'panel.moving.gallery',
        family: 'panel',
        owner: 'B',
        title: 'Gallery (moving UI window) and its image viewer',
        root: GALLERY,
        ready: `${GALLERY} .nGY2GThumbnail`,
        async open(page) {
            await mockOnce(page, 'gallery', mockGalleryImages);
            await openAuditChat(page);
            if (!await page.locator(GALLERY).count()) {
                await page.evaluate(() => document.getElementById('show_gallery_wand_button').click());
            }
            await page.locator(`${GALLERY} .nGY2GThumbnail`).first().waitFor({ state: 'visible' });
            await page.waitForFunction(selector => {
                const thumbnails = [...document.querySelectorAll(`${selector} .nGY2GThumbnail`)];
                return getComputedStyle(document.querySelector(selector)).opacity === '1' && thumbnails.length === 3
                    && thumbnails.every(thumbnail => thumbnail.querySelector('img')?.complete && getComputedStyle(thumbnail).opacity === '1');
            }, GALLERY);
            await settle(page);
        },
        async close(page) {
            await page.locator(`${GALLERY_IMAGE} .dragClose`).evaluateAll(buttons => buttons.forEach(button => button.click()));
            await page.locator(`${GALLERY} .dragClose`).click();
            await page.locator(GALLERY).waitFor({ state: 'detached' });
        },
        // Two translucent spots whose pixels move by 1/255 from one screenshot to the next: the folder field at 390x844, and
        // the composer's wand button, which the window's edge crosses at 844x390.
        masks: ['#gallery .gallery-folder-input', '#extensionsMenuButton'],
        states: [{
            id: 'image-viewer',
            root: GALLERY_IMAGE,
            ready: `${GALLERY_IMAGE} img`,
            async open(page) {
                await page.locator(`${GALLERY} .nGY2GThumbnail`).first().click();
                await page.locator(`${GALLERY_IMAGE} img`).first().waitFor({ state: 'visible' });
                await settle(page);
            },
        }],
        needs: ['character', 'chat'],
        sources: [`${SCRIPTS}/extensions/gallery/index.js`],
    },
    {
        id: 'panel.moving.expression-holder',
        family: 'panel',
        owner: 'B',
        title: 'Expression holder (moving UI sprite)',
        root: '#expression-holder',
        ready: '#expression-image',
        async open(page) {
            await mockOnce(page, 'sprite', mockSprite);
            await useMockedExpressions(page);
            await openAuditChat(page);
            // The extension clears its sprite when a chat opens and then loads the sprite list, which it shows in the settings;
            // a command that comes before that is wiped, so it waits for the list and then gives the command once.
            await page.waitForFunction(() => document.getElementById('image_list_header_name')?.textContent.trim() !== '');
            await page.evaluate(() => window.SillyTavern.getContext().executeSlashCommandsWithOptions('/sprite caring'));
            await page.waitForFunction(() => {
                const image = document.getElementById('expression-image');
                return Boolean(image?.complete && image.naturalWidth > 0) && getComputedStyle(document.getElementById('expression-holder')).display !== 'none';
            });
            await settle(page);
        },
        // Nothing in the app hides the holder once a sprite has shown it; this puts back the inline style that it has at page load.
        async close(page) {
            await page.evaluate(() => { document.getElementById('expression-holder').style.display = 'none'; });
            await page.locator('#expression-holder').waitFor({ state: 'hidden' });
        },
        // `mobile-styles.css` is linked for `(max-width: 768px)` only, and there it hides `#expression-wrapper` outside Visual Novel mode.
        viewports: WIDE_LAYOUT_VIEWPORTS,
        needs: ['character', 'chat'],
        sources: [`${SCRIPTS}/extensions/expressions/index.js`, `${SCRIPTS}/extensions/expressions/style.css`],
    },
    {
        id: 'panel.moving.visual-novel',
        family: 'panel',
        owner: 'B',
        title: 'Visual Novel mode: expression holders of a group chat',
        root: '#visual-novel-wrapper',
        ready: '#visual-novel-wrapper .expression-holder img',
        async open(page) {
            await mockOnce(page, 'sprite', mockSprite);
            await useMockedExpressions(page);
            await openAuditGroup(page, { switchMenu: false });
            await page.evaluate(() => {
                const toggle = document.getElementById('waifuMode');
                toggle.checked = true;
                toggle.dispatchEvent(new Event('change', { bubbles: true }));
            });
            // The extension shows the wrapper, and empties it, on its next poll after the switch; a sprite that is set before that is wiped.
            await page.waitForFunction(() => document.body.classList.contains('waifuMode') && getComputedStyle(document.getElementById('visual-novel-wrapper')).display !== 'none', null, { timeout: 30_000 })
                .catch(() => { throw new Error('Visual Novel mode did not show its wrapper within 30 s of the switch.'); });
            const setSprites = () => page.evaluate(async () => {
                const context = window.SillyTavern.getContext();
                const expressions = await import('/scripts/extensions/expressions/index.js');
                const group = context.groups.find(candidate => candidate.id === context.groupId);
                for (const avatar of group.members) {
                    const character = context.characters.find(candidate => candidate.avatar === avatar);
                    await expressions.sendExpressionCall(character.name, 'caring');
                }
            });
            const spritesShown = timeout => page.waitForFunction(() => {
                const context = window.SillyTavern.getContext();
                const group = context.groups.find(candidate => candidate.id === context.groupId);
                const holders = [...document.querySelectorAll('#visual-novel-wrapper .expression-holder:not(.hidden)')];
                return group.members.every(avatar => holders.some(holder => holder.dataset.avatar === avatar)) && holders.every(holder => {
                    const image = holder.querySelector('img');
                    return Boolean(image?.complete && image.naturalWidth > 0) && getComputedStyle(holder).opacity === '1';
                });
            }, null, { timeout }).then(() => true, () => false);
            // A later poll of the extension can build the holders again and drop the sprites, so they are set again until every
            // member shows one. The wait is bounded and fails with its own message.
            const deadline = Date.now() + 40_000;
            for (;;) {
                await setSprites();
                if (await spritesShown(5000)) {
                    break;
                }
                if (Date.now() > deadline) {
                    throw new Error('Visual Novel mode did not show a sprite for every group member within 40 s.');
                }
            }
            await settle(page);
        },
        async close(page) {
            await page.evaluate(() => {
                const toggle = document.getElementById('waifuMode');
                toggle.checked = false;
                toggle.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await page.locator('#visual-novel-wrapper').waitFor({ state: 'hidden' });
        },
        viewports: VISUAL_NOVEL_VIEWPORTS,
        needs: ['group', 'group-chat'],
        sources: [`${SCRIPTS}/extensions/expressions/index.js`, 'public/css/toggle-dependent.css'],
    },
    {
        id: 'panel.moving.summary-popout',
        family: 'panel',
        owner: 'B',
        title: 'Summarize popout (moving UI window)',
        root: '#summaryExtensionPopout',
        ready: '#summaryExtensionPopout textarea',
        async open(page) {
            await openAuditChat(page);
            if (!await page.locator('#summaryExtensionPopout').count()) {
                await page.evaluate(() => document.getElementById('summaryExtensionPopoutButton').click());
            }
            await page.locator('#summaryExtensionPopout').waitFor({ state: 'visible' });
            await page.waitForFunction(() => getComputedStyle(document.getElementById('summaryExtensionPopout')).opacity === '1');
            await settle(page);
        },
        async close(page) {
            await page.locator('#summaryExtensionPopoutClose').evaluate(button => button.click());
            await page.locator('#summaryExtensionPopout').waitFor({ state: 'detached' });
        },
        needs: ['character', 'chat'],
        sources: [`${SCRIPTS}/extensions/memory/index.js`, `${SCRIPTS}/extensions/memory/style.css`],
    },
    {
        id: 'panel.moving.quick-reply-popout',
        family: 'panel',
        owner: 'B',
        title: 'Quick Reply popout (moving UI window)',
        root: '#qr--popout',
        ready: '#qr--popout .qr--button',
        async open(page) {
            await openAuditChat(page);
            if (!await page.locator('#qr--popout').count()) {
                await page.locator('#qr--popoutTrigger').evaluate(trigger => trigger.click());
            }
            await page.locator('#qr--popout').waitFor({ state: 'visible' });
            await page.waitForFunction(() => getComputedStyle(document.getElementById('qr--popout')).opacity === '1');
            await settle(page);
        },
        async close(page) {
            await page.locator('#qr--popout .qr--close').evaluate(button => button.click());
            await page.locator('#qr--popout').waitFor({ state: 'detached' });
        },
        needs: ['character', 'chat', 'quick-replies'],
        sources: ['public/scripts/extensions/quick-reply/src/ui/ButtonUi.js', 'public/scripts/extensions/quick-reply/style.css'],
    },
    {
        id: 'panel.moving.group-members-popout',
        family: 'panel',
        owner: 'B',
        title: 'Group member list popout (moving UI window)',
        root: '#groupMemberListPopout',
        ready: '#groupMemberListPopout .group_member',
        async open(page) {
            if (!await page.locator('#groupMemberListPopout').count()) {
                await openAuditGroup(page, { switchMenu: true });
                await page.locator('#groupCurrentMemberPopoutButton').evaluate(button => button.click());
            }
            await page.locator('#groupMemberListPopout').waitFor({ state: 'visible' });
            await page.waitForFunction(() => getComputedStyle(document.getElementById('groupMemberListPopout')).opacity === '1');
            await settle(page);
        },
        async close(page) {
            await page.locator('#groupMemberListPopoutClose').evaluate(button => button.click());
            await page.locator('#groupMemberListPopout').waitFor({ state: 'detached' });
        },
        // Opening the group opens its chat, which is created when the file is missing.
        needs: ['group', 'group-chat'],
        sources: [`${SCRIPTS}/group-chats.js`],
    },
    {
        id: 'panel.companion.panel',
        family: 'panel',
        owner: 'C',
        title: 'In-chat agents: companion panel',
        root: '#ica--tracker-panel',
        ready: '#ica--tracker-panel .ica--tpanel-agent',
        async open(page) {
            await openAuditChat(page);
            if (!await page.locator('#ica--tracker-panel.is-open').count()) {
                await seedCompanionPanel(page);
                await page.locator('#ica_tracker_panel_wand_item').evaluate(item => item.click());
            }
            await page.locator('#ica--tracker-panel.is-open').waitFor({ state: 'visible' });
            await settle(page, { root: '#ica--tracker-panel' });
        },
        async close(page) {
            await page.locator('#ica--tracker-panel [data-action="panel-close"]').click();
            await page.locator('#ica--tracker-panel').waitFor({ state: 'hidden' });
        },
        states: [{
            id: 'handle',
            root: '#ica--tracker-panel-handle',
            async open(page) {
                await page.locator('#ica--tracker-panel [data-action="panel-close"]').click();
                await page.locator('#ica--tracker-panel-handle').waitFor({ state: 'visible' });
                await settle(page);
            },
        }],
        needs: ['character', 'chat'],
        sources: [`${SCRIPTS}/extensions/in-chat-agents/companion/companion-panel.js`, `${SCRIPTS}/extensions/in-chat-agents/style.css`],
    },
];
