import { t } from '../i18n.js';
import { createPrefGroup, createRow } from '../sillybunny-editor/rows.js';
import { COPY_PLACEHOLDER, markRowSubtitle } from './copy.js';

/**
 * Fills the links section: Help and Bundled Extras, each a row with a trailing arrow.
 * @param {HTMLElement} panel The `.welcomePanel` root.
 * @param {object} actions
 * @param {(opener: HTMLElement) => void} actions.openBundledExtras Receives the row, so focus can come back to it.
 * @param {() => void} actions.openHelp
 */
export function mountLinks(panel, { openBundledExtras, openHelp }) {
    const section = panel.querySelector('[data-sb-home-region="links"]');
    if (!section) {
        return;
    }

    const help = createRow({
        label: t`Help`,
        subtitle: COPY_PLACEHOLDER,
        field: 'links-help',
        activatable: true,
        // Safari does not focus a button on click, and the window returns focus to the element that had it.
        onActivate: () => {
            help.row.focus({ preventScroll: true });
            openHelp();
        },
    });
    markRowSubtitle(help, 'HOME-ROW-HELP');

    const extras = createRow({
        label: t`Bundled Extras`,
        subtitle: COPY_PLACEHOLDER,
        field: 'links-bundled-extras',
        activatable: true,
        onActivate: () => openBundledExtras(extras.row),
    });
    markRowSubtitle(extras, 'HOME-ROW-EXTRAS');

    section.replaceChildren(createPrefGroup({ field: 'links-group', rows: [help, extras] }).section);
}
