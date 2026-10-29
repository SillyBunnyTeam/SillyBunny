import { t } from '../i18n.js';
import { openActionMenu } from '../sillybunny-action-menu.js';
import { parseDisplayMode } from './modes.js';

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
    const sections = [
        { title: t`Display Mode`, items: displayModeItems(displayMode, actions.setDisplayMode) },
        {
            items: commandItems([
                [actions.showWelcome, t`Show Welcome`, 'fa-solid fa-hand'],
                [actions.openRecentChatsSettings, t`Recent Chats Settings`, 'fa-solid fa-sliders'],
                [gettingStartedHidden ? actions.showGettingStarted : undefined, t`Show Getting Started`, 'fa-solid fa-list-check'],
            ]),
        },
        {
            items: commandItems([
                [actions.openKeyboardShortcuts, t`Keyboard Shortcuts`, 'fa-solid fa-keyboard'],
                [actions.openHelp, t`Help`, 'fa-solid fa-circle-question'],
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
    });
}

/** Marks an item whose action is not wired yet. The same marker sits on the stubbed rows. */
const STUB_MARKER = Object.freeze({ sbStub: 'true' });

/**
 * @typedef {object} AssistantMenuActions
 * @property {() => void} newChat
 * @property {() => void} temporaryChat
 * @property {(mode: 'roleplay' | 'conversation') => void} openInMode
 */

/**
 * @param {unknown} lastMode The remembered chat mode. Anything but Conversation counts as Roleplay.
 * @returns {'roleplay' | 'conversation'} The mode the remembered one is not.
 */
export function getOtherChatMode(lastMode) {
    return lastMode === 'conversation' ? 'roleplay' : 'conversation';
}

/**
 * New Chat and Temporary Chat open in the remembered mode. The last item opens the other one.
 * @param {object} options
 * @param {unknown} options.lastMode
 * @param {AssistantMenuActions} options.actions
 * @returns {import('../sillybunny-action-menu.js').ActionMenuSection[]}
 */
export function buildAssistantMenuSections({ lastMode, actions }) {
    const otherMode = getOtherChatMode(lastMode);
    const openInOther = otherMode === 'conversation'
        ? { label: t`Open in Conversation`, icon: 'fa-solid fa-comments fa-fw' }
        : { label: t`Open in Roleplay`, icon: 'fa-solid fa-masks-theater fa-fw' };
    return [
        {
            items: [
                { label: t`New Chat`, icon: 'fa-solid fa-plus fa-fw', data: STUB_MARKER, onSelect: () => actions.newChat() },
                { label: t`Temporary Chat`, icon: 'fa-solid fa-hourglass-half fa-fw', data: STUB_MARKER, onSelect: () => actions.temporaryChat() },
            ],
        },
        { items: [{ ...openInOther, data: STUB_MARKER, onSelect: () => actions.openInMode(otherMode) }] },
    ];
}

/**
 * Opens the menu of one assistant row below its button, or closes it when it is already open.
 * @param {HTMLElement} trigger
 * @param {{ lastMode: unknown, actions: AssistantMenuActions }} menu
 * @param {object} [options]
 * @param {boolean} [options.keyboard=false] Focus the first item, for a keyboard activation.
 * @param {Element|null} [options.bounds=null] The popover stays inside this element.
 */
export function openAssistantMenu(trigger, { lastMode, actions }, { keyboard = false, bounds = null } = {}) {
    openActionMenu({
        trigger,
        title: t`Assistant Menu`,
        sections: buildAssistantMenuSections({ lastMode, actions }),
        keyboard,
        bounds,
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
