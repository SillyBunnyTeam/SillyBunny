import { t } from './i18n.js';
import { openDialog } from './sillybunny-editor/dialog.js';
import { createPrefGroup, createRow } from './sillybunny-editor/rows.js';
import { createArtPlaceholder } from './sillybunny-home/art.js';
import { isApplePlatform } from './sillybunny-platform.js';
import { ensureWindowStyles } from './sillybunny-window-styles.js';

export const SHORTCUT_SCOPES = Object.freeze(['general', 'editors', 'chat', 'formatting']);

/**
 * `Mod` stands for the modifier of the shell shortcuts: Ctrl, or Command on Apple platforms. The chat and
 * Markdown hotkeys read `ctrlKey` only, so they name Ctrl on every platform.
 *
 * @typedef {object} Shortcut
 * @property {string[]} keys One entry per key of the combination.
 * @property {'general' | 'editors' | 'chat' | 'formatting'} scope
 * @property {string} label
 * @property {boolean} [planned] No key handler runs the shortcut yet, so the window does not list it.
 */

/**
 * Built on each call, so the labels follow the language that is active when the window opens.
 * @returns {Shortcut[]}
 */
export function getShortcuts() {
    return [
        { keys: ['Mod', '?'], scope: 'general', label: t`Keyboard Shortcuts`, planned: true },
        { keys: ['F1'], scope: 'general', label: t`Help`, planned: true },
        { keys: ['Mod', 'O'], scope: 'general', label: t`Home` },
        { keys: ['Mod', 'U'], scope: 'general', label: t`Backend` },
        { keys: ['Mod', 'I'], scope: 'general', label: t`Customize` },
        { keys: ['Mod', 'P'], scope: 'general', label: t`Characters` },
        { keys: ['Mod', 'F'], scope: 'general', label: t`Search` },
        { keys: ['Mod', 'M'], scope: 'general', label: t`Switch Mode` },

        { keys: ['Mod', 'S'], scope: 'editors', label: t`Save` },
        { keys: ['Mod', 'F'], scope: 'editors', label: t`Find in List` },

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
    return { general: t`General`, editors: t`Editors and Lists`, chat: t`Chat`, formatting: t`Formatting` };
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
 * Fills the window body with one group per scope. A planned shortcut has no handler yet, so it stays out.
 * @param {HTMLElement} body
 * @param {Shortcut[]} shortcuts
 * @param {boolean} apple
 */
export function fillShortcuts(body, shortcuts, apple) {
    const titles = getScopeTitles();
    const listed = shortcuts.filter(shortcut => !shortcut.planned);
    for (const scope of SHORTCUT_SCOPES) {
        const rows = listed
            .filter(shortcut => shortcut.scope === scope)
            .map((shortcut, index) => createRow({
                label: shortcut.label,
                field: `shortcut-${scope}-${index}`,
                suffix: createKeys(shortcut.keys, apple),
            }));
        body.append(createPrefGroup({ title: titles[scope], field: `shortcuts-${scope}`, rows }).section);
    }
}

/**
 * Opens the Keyboard Shortcuts window.
 * @returns {Promise<ReturnType<typeof openDialog>>}
 */
export async function openShortcutsWindow() {
    await ensureWindowStyles();
    const apple = isApplePlatform();
    return openDialog({
        tier: 'dialog',
        title: t`Keyboard Shortcuts`,
        className: 'sbShortcutsDialog',
        content: (body) => {
            const art = createArtPlaceholder('shortcuts-tewi');
            art.classList.add('sbWindowArt');
            body.append(art);
            fillShortcuts(body, getShortcuts(), apple);
        },
    });
}
