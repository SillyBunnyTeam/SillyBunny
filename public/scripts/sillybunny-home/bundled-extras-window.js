import { t } from '../i18n.js';
import { BUNDLED_EXTRAS, groupBundledExtras } from '../sillybunny-bundled-extras.js';
import { openDialog } from '../sillybunny-editor/dialog.js';
import { createPrefGroup, createRow } from '../sillybunny-editor/rows.js';
import { ensureWindowStyles } from '../sillybunny-window-styles.js';
import { getBundledExtraDescription } from './bundled-extras-copy.js';
import { openShellTarget } from './shell-targets.js';
import { createStatusChip } from './status-chip.js';
import { createArtIntro } from './art-intro.js';

function getGroupTitle(groupId) {
    switch (groupId) {
        case 'first-party-extensions': return t`First-Party Extensions`;
        case 'third-party-extensions': return t`Third-Party Extensions`;
        case 'themes': return t`Themes`;
        case 'third-party-themes': return t`Third-Party Themes`;
        case 'presets': return t`Presets`;
        default: throw new Error(`No title for the Bundled Extras group: ${groupId}`);
    }
}

function getStatusLabel(status) {
    switch (status) {
        case 'not-installed': return t`Not installed`;
        case 'installed': return t`Installed`;
        case 'enabled': return t`Enabled`;
        default: throw new Error(`No label for the status: ${status}`);
    }
}

function getStatusTone(status) {
    switch (status) {
        case 'not-installed': return 'neutral';
        case 'installed':
        case 'enabled': return 'success';
        default: throw new Error(`No tone for the status: ${status}`);
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

function reportActionFailure() {
    globalThis.toastr?.error(t`Failed to apply action. Try again, or check the Extensions panel.`);
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
        const status = createStatusChip({ label: getStatusLabel(state.status), tone: getStatusTone(state.status) });
        status.classList.add('sbBundledExtraState');
        status.dataset.sbStatus = state.status;
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
        subtitle: getBundledExtraDescription(item.id),
        field: `bundled-extra-${item.id}`,
        suffix: createItemControls(item, actions, labelId),
    });
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
 * @param {(target: string) => unknown} [options.openTarget]
 * @param {readonly import('../sillybunny-bundled-extras.js').BundledExtra[]} [options.items] What the window lists.
 * @param {ReturnType<typeof import('./bundled-extras-actions.js').createBundledExtrasActions>} [options.actions]
 *   What the rows show and do. The app's own when it is not given.
 * @returns {Promise<ReturnType<typeof openDialog>>}
 */
export async function openBundledExtrasWindow({ openTarget = openShellTarget, items = BUNDLED_EXTRAS, actions = null } = {}) {
    await ensureWindowStyles();
    const rowActions = actions ?? (await import('./bundled-extras-adapters.js')).createAppBundledExtrasActions();
    /** @type {ReturnType<typeof openDialog>} */
    let dialog;

    const itemGroups = getWindowGroups(items).filter(entry => entry.items.length > 0).map(entry => createPrefGroup({
        title: getGroupTitle(entry.id),
        field: `bundled-extras-${entry.id}`,
        rows: entry.items.map(item => createItemRow(item, rowActions)),
    }).section);

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
        content: body => body.append(
            createArtIntro({ art: 'extras-tewi', text: t`Gege, you're in luck! I found all of these add-ons myself! The first-party ones come from the SillyBunny team, and the third-party ones are their biased favourites~` }).intro,
            ...itemGroups,
            createPrefGroup({ field: 'bundled-extras-ui-themes-group', rows: [uiThemes] }).section,
        ),
    });
    return dialog;
}
