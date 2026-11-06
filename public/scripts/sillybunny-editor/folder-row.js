import { createEntityRow } from './entity-row.js';
import { t } from '../i18n.js';

/** Member count for a folder in the Characters or Groups scope. */
export function folderCountLabel(count, scope) {
    if (scope === 'groups') return count === 1 ? t`1 group` : t`${count} groups`;
    return count === 1 ? t`1 character` : t`${count} characters`;
}

function setExpanded(row, expanded) {
    row.setAttribute('aria-expanded', String(Boolean(expanded)));
    const chevron = row.querySelector('.ds-entity-row__chevron');
    if (!chevron) return;
    chevron.classList.remove('fa-chevron-right', 'fa-chevron-down', 'fa-chevron-up');
    chevron.classList.add(expanded ? 'fa-chevron-up' : 'fa-chevron-down');
}

function setColor(dot, color) {
    if (color) dot.style.setProperty('--sb-folder-color', color);
    else dot.style.removeProperty('--sb-folder-color');
}

/** Builds an accessible, keyed folder section header for the main entity list. */
export function createFolderRow({ key, folder, count, countLabel, expanded }) {
    const dot = document.createElement('span');
    dot.className = 'sb-folder-row__dot';
    dot.setAttribute('aria-hidden', 'true');
    setColor(dot, folder.color);

    const rowFactory = createEntityRow({
        key,
        label: `${folder.name}, ${countLabel}`,
        title: folder.name,
        subtitle: countLabel,
        avatar: dot,
        activation: 'navigate',
    });
    const { row } = rowFactory;
    row.classList.add('ds-row-expander', 'sb-folder-row');
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `${folder.name}, ${countLabel}`);
    row.dataset.folderId = folder.id;
    row.dataset.folderScope = folder.scope;
    setExpanded(row, expanded);

    return {
        row,
        update(entry) {
            rowFactory.update({
                label: `${entry.folder.name}, ${entry.countLabel}`,
                title: entry.folder.name,
                subtitle: entry.countLabel,
            });
            row.setAttribute('aria-label', `${entry.folder.name}, ${entry.countLabel}`);
            row.dataset.folderId = entry.folder.id;
            row.dataset.folderScope = entry.scope;
            setColor(dot, entry.folder.color);
            setExpanded(row, entry.expanded);
            row.classList.toggle('is-folder-temporarily-expanded', Boolean(entry.temporaryExpansion));
            row.inert = Boolean(entry.inert);
            if (entry.inert) row.setAttribute('aria-disabled', 'true');
            else row.removeAttribute('aria-disabled');
            row.tabIndex = entry.inert ? -1 : 0;
        },
    };
}
