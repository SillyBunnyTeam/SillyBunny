import { t } from '../i18n.js';
import { getBundledExtraSubtitleSlot, groupBundledExtras } from '../sillybunny-bundled-extras.js';
import { openDialog } from '../sillybunny-editor/dialog.js';
import { createPrefGroup, createRow } from '../sillybunny-editor/rows.js';
import { ensureWindowStyles } from '../sillybunny-window-styles.js';
import { createArtPlaceholder } from './art.js';
import { COPY_PLACEHOLDER, markCopyPlaceholder, markRowSubtitle } from './copy.js';
import { openShellTarget } from './shell-targets.js';
import { stubAction } from './stubs.js';

function getGroupTitle(groupId) {
    switch (groupId) {
        case 'assistants': return t`Assistants`;
        case 'first-party-extensions': return t`First-Party Extensions`;
        case 'third-party-extensions': return t`Third-Party Extensions`;
        case 'themes': return t`Themes`;
        case 'presets': return t`Presets`;
        default: throw new Error(`No title for the Bundled Extras group: ${groupId}`);
    }
}

function createIntro() {
    const intro = document.createElement('div');
    intro.className = 'sbHomeIntro';
    intro.append(createArtPlaceholder('extras-tewi'), markCopyPlaceholder(document.createElement('p'), 'BE-INTRO'));
    return intro;
}

/** An assistant installs on demand, so its row has an Add button that waits for the install flow. */
function createAssistantRow(item) {
    const labelId = `sb-bundled-extra-${item.id}-title`;
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'sbHomeFlatButton';
    add.textContent = t`Add`;
    add.dataset.sbStub = 'true';
    add.setAttribute('aria-describedby', labelId);
    add.addEventListener('click', stubAction('bundled-extras.add-assistant'));

    const row = createRow({
        label: item.name,
        subtitle: COPY_PLACEHOLDER,
        field: `bundled-extra-${item.id}`,
        prefix: createArtPlaceholder(`row-${item.id}`),
        suffix: add,
    });
    markRowSubtitle(row, getBundledExtraSubtitleSlot(item));
    row.row.querySelector('.ds-row-label').id = labelId;
    return row;
}

function createItemRow(item) {
    if (item.kind === 'assistant') {
        return createAssistantRow(item);
    }
    const row = createRow({ label: item.name, subtitle: COPY_PLACEHOLDER, field: `bundled-extra-${item.id}` });
    markRowSubtitle(row, getBundledExtraSubtitleSlot(item));
    return row;
}

/**
 * Opens the Bundled Extras window. It is a Window because it is a long list of groups, and a Window is the
 * tier for lists. Nothing here installs yet, so it has no responses and shows Close.
 * @param {object} [options]
 * @param {string | null} [options.group] A group id to open at. Its heading takes focus, so the list is
 *   already scrolled there and a screen reader starts at the group.
 * @param {(target: string) => unknown} [options.openTarget]
 * @returns {Promise<ReturnType<typeof openDialog>>}
 */
export async function openBundledExtrasWindow({ group = null, openTarget = openShellTarget } = {}) {
    await ensureWindowStyles();
    /** @type {ReturnType<typeof openDialog>} */
    let dialog;
    /** @type {Map<string, HTMLElement>} */
    const headings = new Map();

    const itemGroups = groupBundledExtras().map((entry) => {
        const { section } = createPrefGroup({
            title: getGroupTitle(entry.id),
            field: `bundled-extras-${entry.id}`,
            rows: entry.items.map(createItemRow),
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
            createIntro(),
            ...itemGroups,
            createPrefGroup({ field: 'bundled-extras-ui-themes-group', rows: [uiThemes] }).section,
        ),
    });
    return dialog;
}
