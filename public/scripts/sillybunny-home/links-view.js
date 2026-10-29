import { t } from '../i18n.js';
import { createPrefGroup, createRow } from '../sillybunny-editor/rows.js';
import { COPY_PLACEHOLDER, markRowSubtitle } from './copy.js';
import { stubAction } from './stubs.js';

/**
 * Fills the links section: Help and Bundled Extras, each a row with a trailing arrow.
 * @param {HTMLElement} panel The `.welcomePanel` root.
 * @param {object} actions
 * @param {(opener: HTMLElement) => void} actions.openBundledExtras Receives the row, so focus can come back to it.
 */
export function mountLinks(panel, { openBundledExtras }) {
    const section = panel.querySelector('[data-sb-home-region="links"]');
    if (!section) {
        return;
    }

    const help = createRow({
        label: t`Help`,
        subtitle: COPY_PLACEHOLDER,
        field: 'links-help',
        activatable: true,
        onActivate: stubAction('links.help'),
    });
    markRowSubtitle(help, 'HOME-ROW-HELP');
    help.row.dataset.sbStub = 'true';

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
