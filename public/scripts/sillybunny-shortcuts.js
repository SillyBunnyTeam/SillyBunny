import { t } from './i18n.js';
import { SHORTCUTS_DIALOG_CLASS } from './sillybunny-help/dialog-classes.js';
import { openDialog } from './sillybunny-editor/dialog.js';
import { createStatusPage } from './sillybunny-editor/status-page.js';
import { createPrefGroup, createRow } from './sillybunny-editor/rows.js';
import { createArtIntro } from './sillybunny-home/art-intro.js';
import { isApplePlatform } from './sillybunny-platform.js';
import { ensureWindowStyles } from './sillybunny-window-styles.js';

export const SHORTCUT_SCOPES = Object.freeze(['general', 'editors', 'lists', 'chat', 'formatting']);

/**
 * `Mod` stands for the modifier of the shell shortcuts: Ctrl, or Command on Apple platforms. The chat and
 * Markdown hotkeys read `ctrlKey` only, so they name Ctrl on every platform.
 *
 * @typedef {object} Shortcut
 * @property {string[]} keys One entry per key of the combination.
 * @property {'general' | 'editors' | 'lists' | 'chat' | 'formatting'} scope
 * @property {string} label
 */

/**
 * Built on each call, so the labels follow the language that is active when the window opens.
 * @returns {Shortcut[]}
 */
export function getShortcuts() {
    return [
        { keys: ['Mod', '?'], scope: 'general', label: t`Keyboard Shortcuts` },
        { keys: ['F1'], scope: 'general', label: t`Help` },
        { keys: ['Mod', 'O'], scope: 'general', label: t`Home` },
        { keys: ['Mod', 'U'], scope: 'general', label: t`Backend` },
        { keys: ['Mod', 'I'], scope: 'general', label: t`Customize` },
        { keys: ['Mod', 'P'], scope: 'general', label: t`Characters` },
        { keys: ['Mod', 'F'], scope: 'general', label: t`Search` },
        { keys: ['Mod', 'M'], scope: 'general', label: t`Switch Mode` },

        { keys: ['Mod', 'S'], scope: 'editors', label: t`Save` },
        { keys: ['Mod', 'F'], scope: 'editors', label: t`Find in List` },

        { keys: ['Up'], scope: 'lists', label: t`Previous Row` },
        { keys: ['Down'], scope: 'lists', label: t`Next Row` },
        { keys: ['Home'], scope: 'lists', label: t`First Row` },
        { keys: ['End'], scope: 'lists', label: t`Last Row` },
        { keys: ['Page Up'], scope: 'lists', label: t`Previous Page` },
        { keys: ['Page Down'], scope: 'lists', label: t`Next Page` },
        // Left and Right step between cards only where the cards sit side by side, as in the character grid.
        { keys: ['Left'], scope: 'lists', label: t`Previous Card` },
        { keys: ['Right'], scope: 'lists', label: t`Next Card` },
        // Only in a list that can be reordered, and not while a search or a sort is on.
        { keys: ['Alt', 'Up'], scope: 'lists', label: t`Move Row Up` },
        { keys: ['Alt', 'Down'], scope: 'lists', label: t`Move Row Down` },
        { keys: ['Alt', 'Home'], scope: 'lists', label: t`Move to Top` },
        { keys: ['Alt', 'End'], scope: 'lists', label: t`Move to Bottom` },

        { keys: ['Up'], scope: 'chat', label: t`Edit Last Message` },
        { keys: ['Ctrl', 'Up'], scope: 'chat', label: t`Edit Last User Message` },
        { keys: ['Left'], scope: 'chat', label: t`Swipe Left` },
        { keys: ['Right'], scope: 'chat', label: t`Swipe Right` },
        { keys: ['Enter'], scope: 'chat', label: t`Send Message` },
        { keys: ['Ctrl', 'Enter'], scope: 'chat', label: t`Regenerate Response` },
        { keys: ['Alt', 'Enter'], scope: 'chat', label: t`Continue Response` },
        { keys: ['Escape'], scope: 'chat', label: t`Stop Generation` },
        { keys: ['Ctrl', 'Shift', 'Up'], scope: 'chat', label: t`Scroll to Context Line` },
        { keys: ['Ctrl', 'Shift', 'Down'], scope: 'chat', label: t`Scroll to Bottom` },

        { keys: ['Ctrl', 'B'], scope: 'formatting', label: t`Bold` },
        { keys: ['Ctrl', 'I'], scope: 'formatting', label: t`Italic` },
        { keys: ['Ctrl', 'U'], scope: 'formatting', label: t`Underline` },
        { keys: ['Ctrl', 'K'], scope: 'formatting', label: t`Inline Code` },
        { keys: ['Ctrl', 'Shift', '~'], scope: 'formatting', label: t`Strikethrough` },
    ];
}

function getScopeTitles() {
    return { general: t`General`, editors: t`Editors and Lists`, lists: t`List Navigation`, chat: t`Chat`, formatting: t`Formatting` };
}

/**
 * @param {string} token One entry of {@link Shortcut.keys}.
 * @param {{ apple: boolean }} platform
 * @returns {string}
 */
export function formatKeyToken(token, { apple }) {
    if (token !== 'Mod') {
        return token;
    }
    return apple ? '⌘' : 'Ctrl';
}

function createKeys(keys, apple) {
    const combination = document.createElement('kbd');
    combination.className = 'sbKeys';
    keys.forEach((token, index) => {
        if (index > 0) {
            combination.append('+');
        }
        const key = document.createElement('kbd');
        key.textContent = formatKeyToken(token, { apple });
        combination.append(key);
    });
    return combination;
}

/**
 * The note under a group whose keys work only where a setting or a mark allows.
 * @param {string} scope
 * @returns {string | undefined}
 */
function getScopeNote(scope) {
    return scope === 'formatting' ? t`Turn on Markdown Hotkeys in Customize ▸ Interface ▸ Typing. These use Ctrl on all supported platforms.` : undefined;
}

/**
 * Fills the window body with one group per scope.
 * @param {HTMLElement} body
 * @param {Shortcut[]} shortcuts
 * @param {boolean} apple
 * @returns {{ filter: (query: string) => number }} `filter` shows the rows whose label or keys have the query, hides a
 *   group with no such row, and returns how many rows show.
 */
export function fillShortcuts(body, shortcuts, apple) {
    const titles = getScopeTitles();
    const groups = [];
    for (const scope of SHORTCUT_SCOPES) {
        const entries = shortcuts
            .filter(shortcut => shortcut.scope === scope)
            .map((shortcut, index) => ({
                controller: createRow({
                    label: shortcut.label,
                    field: `shortcut-${scope}-${index}`,
                    suffix: createKeys(shortcut.keys, apple),
                }),
                // The keys are matched as they are written on this platform, so a user can search for the key that they press.
                text: `${shortcut.label} ${shortcut.keys.map(token => formatKeyToken(token, { apple })).join('+')}`.toLocaleLowerCase(),
            }));
        const { section } = createPrefGroup({ title: titles[scope], subtitle: getScopeNote(scope), field: `shortcuts-${scope}`, rows: entries.map(entry => entry.controller) });
        body.append(section);
        groups.push({ section, entries });
    }
    return {
        filter(query) {
            const needle = query.trim().toLocaleLowerCase();
            let shown = 0;
            for (const { section, entries } of groups) {
                let shownInGroup = 0;
                for (const { controller, text } of entries) {
                    const matches = text.includes(needle);
                    controller.row.hidden = !matches;
                    shownInGroup += matches ? 1 : 0;
                }
                section.hidden = shownInGroup === 0;
                shown += shownInGroup;
            }
            return shown;
        },
    };
}

/**
 * Opens the Keyboard Shortcuts window.
 * @returns {Promise<ReturnType<typeof openDialog>>}
 */
export async function openShortcutsWindow() {
    await ensureWindowStyles();
    const apple = isApplePlatform();
    let dialog;
    let list;
    let body;
    // Made on the first search that matches nothing, so a window that is only read holds no unwritten text.
    let noMatch = null;
    const getNoMatch = () => {
        if (!noMatch) {
            noMatch = createStatusPage({ state: 'no-results', title: t`No Results Found`, description: t`Try a different search`, compact: true });
            body.append(noMatch.element);
        }
        return noMatch.element;
    };
    dialog = openDialog({
        tier: 'dialog',
        title: t`Keyboard Shortcuts`,
        className: SHORTCUTS_DIALOG_CLASS,
        search: {
            label: t`Search Shortcuts`,
            toggleLabel: t`Search Shortcuts`,
            placeholder: t`Search shortcuts`,
            collapsed: true,
            escapeClearsFirst: true,
            onChange: (query) => {
                const shown = list.filter(query);
                if (shown === 0) {
                    getNoMatch().hidden = false;
                } else if (noMatch) {
                    noMatch.element.hidden = true;
                }
                dialog.search.report(shown, getShortcuts().length);
            },
        },
        content: (contentBody) => {
            body = contentBody;
            body.append(createArtIntro({ art: 'shortcuts-tewi', text: t`I know every shortcut through the bamboo forest, and through SillyBunny too! Try a few and you'll get around much faster.` }).intro);
            list = fillShortcuts(body, getShortcuts(), apple);
        },
    });
    return dialog;
}
