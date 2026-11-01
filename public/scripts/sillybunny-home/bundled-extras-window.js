import { t } from '../i18n.js';
import { BUNDLED_EXTRAS, getBundledExtraSubtitleSlot, groupBundledExtras } from '../sillybunny-bundled-extras.js';
import { openDialog } from '../sillybunny-editor/dialog.js';
import { createPrefGroup, createRow } from '../sillybunny-editor/rows.js';
import { ensureWindowStyles } from '../sillybunny-window-styles.js';
import { createArtPlaceholder } from './art.js';
import { createArtIntro } from './art-intro.js';
import { COPY_PLACEHOLDER, markRowSubtitle } from './copy.js';
import { openShellTarget } from './shell-targets.js';

function getGroupTitle(groupId) {
    switch (groupId) {
        case 'assistants': return t`Assistants`;
        case 'first-party-extensions': return t`First-Party Extensions`;
        case 'third-party-extensions': return t`Third-Party Extensions`;
        case 'themes': return t`Themes`;
        case 'third-party-themes': return t`Third-Party Themes`;
        case 'presets': return t`Presets`;
        default: throw new Error(`No title for the Bundled Extras group: ${groupId}`);
    }
}

const ACTION_SLOT_ERROR = 'BE-ACTION-ERROR';

function getStatusLabel(status) {
    switch (status) {
        case 'not-installed': return t`Not installed`;
        case 'installed': return t`Installed`;
        case 'enabled': return t`Enabled`;
        default: throw new Error(`No label for the status: ${status}`);
    }
}

function getActionLabel(action) {
    switch (action) {
        case 'install': return t`Install`;
        case 'enable': return t`Enable`;
        case 'disable': return t`Disable`;
        case 'remove': return t`Remove`;
        case 'restore': return t`Restore`;
        case 'apply': return t`Apply`;
        default: throw new Error(`No label for the action: ${action}`);
    }
}

/** The toast has no copy yet, and it carries the placeholder marks like the text of a page. */
function reportActionFailure() {
    const toast = globalThis.toastr?.error(COPY_PLACEHOLDER);
    toast?.find('.toast-message').attr({ 'data-sb-copy-placeholder': 'true', 'data-sb-copy-slot': ACTION_SLOT_ERROR });
}

/**
 * The end of a row that can change: the state of the item and one button for each action that the state offers.
 * The row draws the state again after every action, because the action may have changed it.
 * @param {object} item
 * @param {ReturnType<typeof import('./bundled-extras-actions.js').createBundledExtrasActions>} actions
 * @param {string} labelId The id of the row's label, which the buttons are described by.
 * @returns {HTMLElement}
 */
function createItemControls(item, actions, labelId) {
    const controls = document.createElement('span');
    controls.className = 'sbBundledExtraControls';

    const draw = ({ busy = false } = {}) => {
        const state = actions.getState(item);
        const status = document.createElement('span');
        status.className = 'sbBundledExtraState';
        status.dataset.sbStatus = state.status;
        status.textContent = getStatusLabel(state.status);
        const buttons = state.actions.map((action) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'sbHomeFlatButton';
            button.dataset.sbAction = action;
            button.disabled = busy;
            button.textContent = getActionLabel(action);
            button.setAttribute('aria-describedby', labelId);
            button.addEventListener('click', () => void perform(action));
            return button;
        });
        controls.setAttribute('aria-busy', String(busy));
        controls.replaceChildren(status, ...buttons);
    };

    async function perform(action) {
        draw({ busy: true });
        try {
            await actions.run(item, action);
        } catch (error) {
            console.error(`Bundled Extras: "${action}" failed for "${item.id}".`, error);
            reportActionFailure();
        } finally {
            draw();
        }
    }

    draw();
    return controls;
}

function createItemRow(item, actions) {
    const labelId = `sb-bundled-extra-${item.id}-title`;
    const row = createRow({
        label: item.name,
        subtitle: COPY_PLACEHOLDER,
        field: `bundled-extra-${item.id}`,
        prefix: item.kind === 'assistant' ? createArtPlaceholder(`row-${item.id}`) : undefined,
        suffix: createItemControls(item, actions, labelId),
    });
    markRowSubtitle(row, getBundledExtraSubtitleSlot(item));
    row.row.querySelector('.ds-row-label').id = labelId;
    return row;
}

/**
 * The groups of the window in page order. The third-party CSS themes are a group of their own after Themes, and the
 * group exists only when an item has the kind `theme-css`.
 * @param {readonly import('../sillybunny-bundled-extras.js').BundledExtra[]} items
 */
function getWindowGroups(items) {
    return groupBundledExtras(items).flatMap((entry) => {
        if (entry.id !== 'themes') {
            return [entry];
        }
        const cssThemes = entry.items.filter(item => item.kind === 'theme-css');
        const themes = { id: 'themes', items: entry.items.filter(item => item.kind !== 'theme-css') };
        return cssThemes.length === 0 ? [themes] : [themes, { id: 'third-party-themes', items: cssThemes }];
    });
}

/**
 * Opens the Bundled Extras window. It is a Window because it is a long list of groups, and a Window is the
 * tier for lists. The rows act at once, so it has no responses and shows Close.
 * @param {object} [options]
 * @param {string | null} [options.group] A group id to open at. Its heading takes focus, so the list is
 *   already scrolled there and a screen reader starts at the group.
 * @param {(target: string) => unknown} [options.openTarget]
 * @param {readonly import('../sillybunny-bundled-extras.js').BundledExtra[]} [options.items] What the window lists.
 * @param {ReturnType<typeof import('./bundled-extras-actions.js').createBundledExtrasActions>} [options.actions]
 *   What the rows show and do. The app's own when it is not given.
 * @returns {Promise<ReturnType<typeof openDialog>>}
 */
export async function openBundledExtrasWindow({ group = null, openTarget = openShellTarget, items = BUNDLED_EXTRAS, actions = null } = {}) {
    await ensureWindowStyles();
    const rowActions = actions ?? (await import('./bundled-extras-adapters.js')).createAppBundledExtrasActions();
    /** @type {ReturnType<typeof openDialog>} */
    let dialog;
    /** @type {Map<string, HTMLElement>} */
    const headings = new Map();

    const itemGroups = getWindowGroups(items).filter(entry => entry.items.length > 0).map((entry) => {
        const { section } = createPrefGroup({
            title: getGroupTitle(entry.id),
            field: `bundled-extras-${entry.id}`,
            rows: entry.items.map(item => createItemRow(item, rowActions)),
        });
        const heading = section.querySelector('.ds-pref-group-heading');
        if (entry.id === group) {
            // A heading is not focusable by itself. The tabindex lets the window put focus there without adding a tab stop.
            heading.tabIndex = -1;
        }
        headings.set(entry.id, heading);
        return section;
    });
    if (group !== null && !headings.has(group)) {
        throw new Error(`Unknown Bundled Extras group: ${group}`);
    }

    const uiThemes = createRow({
        label: t`UI Themes`,
        field: 'bundled-extras-ui-themes',
        activatable: true,
        onActivate: () => {
            void dialog.close('ui-themes');
            void dialog.closed.then(() => openTarget('ui-theme'));
        },
    });

    dialog = openDialog({
        tier: 'window',
        size: 'content',
        title: t`Bundled Extras`,
        className: 'sbBundledExtrasDialog',
        initialFocus: group === null ? undefined : () => {
            const heading = headings.get(group);
            heading.scrollIntoView({ block: 'start' });
            return heading;
        },
        content: body => body.append(
            createArtIntro({ art: 'extras-tewi', slot: 'BE-INTRO' }).intro,
            ...itemGroups,
            createPrefGroup({ field: 'bundled-extras-ui-themes-group', rows: [uiThemes] }).section,
        ),
    });
    return dialog;
}
