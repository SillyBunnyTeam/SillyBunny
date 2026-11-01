import { t } from '../i18n.js';
import { openActionMenu } from '../sillybunny-action-menu.js';
import { getHomeDestination } from './destinations.js';
import { getVisibleRegions, parseDisplayMode } from './modes.js';

/**
 * @typedef {object} HomeMenuState
 * @property {string} displayMode Stored display mode; an unknown value counts as Full.
 * @property {boolean} [gettingStartedHidden=false]
 */

/**
 * Each action is optional except `setDisplayMode`; the menu leaves out the item of an action that is missing.
 * @typedef {object} HomeMenuActions
 * @property {(mode: 'full' | 'compact' | 'list') => void} setDisplayMode
 * @property {() => void} [showWelcome]
 * @property {() => void} [openRecentChatsSettings]
 * @property {() => void} [showGettingStarted]
 * @property {() => void} [openKeyboardShortcuts]
 * @property {() => void} [openHelp]
 * @property {() => void} [openAbout]
 */

function displayModeItems(displayMode, setDisplayMode) {
    const current = parseDisplayMode(displayMode);
    return [
        ['full', t`Full`],
        ['compact', t`Compact`],
        ['list', t`List Only`],
    ].map(([mode, label]) => ({
        label,
        kind: 'radio',
        checked: mode === current,
        onSelect: () => setDisplayMode(mode),
    }));
}

function commandItems(entries) {
    return entries
        .filter(([action]) => typeof action === 'function')
        .map(([action, label, icon]) => ({ label, icon, onSelect: () => action() }));
}

/**
 * @param {HomeMenuState} state
 * @param {HomeMenuActions} actions
 * @returns {import('../sillybunny-action-menu.js').ActionMenuSection[]}
 */
export function buildHomeMenuSections({ displayMode, gettingStartedHidden = false }, actions) {
    const gettingStarted = getHomeDestination('getting-started');
    const help = getHomeDestination('help');
    // The item brings the tile back, so it is offered only in a mode that shows the tile.
    const canShowGettingStarted = gettingStartedHidden && getVisibleRegions(displayMode).includes('getting-started');
    const sections = [
        { title: t`Display Mode`, items: displayModeItems(displayMode, actions.setDisplayMode) },
        {
            items: commandItems([
                [actions.showWelcome, t`Show Welcome`, 'fa-solid fa-hand'],
                [actions.openRecentChatsSettings, t`Recent Chats Settings`, 'fa-solid fa-sliders'],
                [canShowGettingStarted ? actions.showGettingStarted : undefined, t`Show Getting Started`, gettingStarted.icon],
            ]),
        },
        {
            items: commandItems([
                [actions.openKeyboardShortcuts, t`Keyboard Shortcuts`, 'fa-solid fa-keyboard'],
                [actions.openHelp, help.getTitle(), help.icon],
                [actions.openAbout, t`About SillyBunny`, 'fa-solid fa-circle-info'],
            ]),
        },
    ];
    return sections.filter(section => section.items.length > 0);
}

/**
 * @typedef {object} ChatMenuActions
 * @property {() => void} rename
 * @property {() => void} remove
 */

/**
 * Delete sits last in a section of its own, so a slip on the first row cannot reach it.
 * @param {ChatMenuActions} actions
 * @returns {import('../sillybunny-action-menu.js').ActionMenuSection[]}
 */
export function buildChatMenuSections({ rename, remove }) {
    return [
        { items: [{ label: t`Rename`, icon: 'fa-solid fa-pen-to-square', onSelect: () => rename() }] },
        { items: [{ label: t`Delete`, icon: 'fa-solid fa-trash', danger: true, onSelect: () => remove() }] },
    ];
}

/**
 * Opens the menu of one Recent Chats row below its button, or closes it when it is already open.
 * @param {HTMLElement} trigger
 * @param {ChatMenuActions} actions
 * @param {object} [options]
 * @param {boolean} [options.keyboard=false] Focus the first item, for a keyboard activation.
 * @param {Element|null} [options.bounds=null] The popover stays inside this element.
 */
export function openChatMenu(trigger, actions, { keyboard = false, bounds = null } = {}) {
    openActionMenu({
        trigger,
        title: t`Chat Menu`,
        sections: buildChatMenuSections(actions),
        keyboard,
        bounds,
        // The button ends its row, and the bounds are the whole Home panel, so the menu cannot tell which edge to line up with.
        alignment: 'end',
    });
}

/**
 * @typedef {object} AssistantMenuActions
 * @property {(mode: 'roleplay' | 'conversation') => void} newChatInMode
 */

/**
 * @param {unknown} lastMode The remembered chat mode. Anything but Conversation counts as Roleplay.
 * @returns {'roleplay' | 'conversation'} The mode the remembered one is not.
 */
export function getOtherChatMode(lastMode) {
    return lastMode === 'conversation' ? 'roleplay' : 'conversation';
}

/**
 * The card's own actions open a chat in the remembered mode, so the menu offers the other one. A card without a file
 * has no chat to open, so its menu has no items and the card shows no menu button.
 * @param {object} options
 * @param {unknown} options.lastMode
 * @param {AssistantMenuActions} options.actions
 * @param {import('./assistant-cards.js').AssistantCardState} [options.state='available']
 * @returns {import('../sillybunny-action-menu.js').ActionMenuSection[]}
 */
export function buildAssistantMenuSections({ lastMode, actions, state = 'available' }) {
    if (state !== 'available') {
        return [];
    }
    const otherMode = getOtherChatMode(lastMode);
    const inOtherMode = otherMode === 'conversation'
        ? { label: t`New Chat in Conversation`, icon: 'fa-solid fa-comments sbHomeMenuIconFit' }
        : { label: t`New Chat in Roleplay`, icon: 'fa-solid fa-masks-theater sbHomeMenuIconFit' };
    return [{ items: [{ ...inOtherMode, onSelect: () => actions.newChatInMode(otherMode) }] }];
}

/**
 * Opens the menu of one assistant card below its button, or closes it when it is already open.
 * @param {HTMLElement} trigger
 * @param {{ lastMode: unknown, actions: AssistantMenuActions, state?: import('./assistant-cards.js').AssistantCardState }} menu
 * @param {object} [options]
 * @param {boolean} [options.keyboard=false] Focus the first item, for a keyboard activation.
 * @param {Element|null} [options.bounds=null] The popover stays inside this element.
 */
export function openAssistantMenu(trigger, { lastMode, actions, state }, { keyboard = false, bounds = null } = {}) {
    openActionMenu({
        trigger,
        title: t`Assistant Menu`,
        sections: buildAssistantMenuSections({ lastMode, actions, state }),
        keyboard,
        bounds,
        // The button ends the card footer, and the bounds are the whole Home panel, so a card in its start half
        // would otherwise open toward the next card.
        alignment: 'end',
    });
}

/**
 * Opens the main menu below its button, or closes it when it is already open.
 * @param {HTMLElement} trigger
 * @param {HomeMenuState} state
 * @param {HomeMenuActions} actions
 * @param {object} [options]
 * @param {boolean} [options.keyboard=false] Focus the first item, for a keyboard activation.
 */
export function openHomeMenu(trigger, state, actions, { keyboard = false } = {}) {
    openActionMenu({
        trigger,
        title: t`Main Menu`,
        sections: buildHomeMenuSections(state, actions),
        keyboard,
    });
}
