import { t } from '../../i18n.js';
import { openActionMenu } from '../../sillybunny-action-menu.js';
import { createListSearch } from '../list-search.js';
import { createStatusPage } from '../status-page.js';

function iconButton(label, glyph, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `sb-dialog__icon-button ${className}`.trim();
    button.title = label;
    button.setAttribute('aria-label', label);
    const icon = document.createElement('i');
    icon.className = `fa-solid fa-${glyph}`;
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
    return button;
}

function getFramePage(popup) {
    const page = popup?.dlg;
    if (!(page instanceof HTMLElement)) {
        throw new TypeError('The Data Bank manager needs a framed Popup page.');
    }
    return page;
}

function getSortItems(select) {
    return [...select.options].map(option => ({
        label: option.textContent.trim(),
        icon: 'fa-solid fa-arrow-down-a-z',
        kind: 'radio',
        checked: option.selected,
        onSelect: () => {
            select.selectedIndex = [...select.options].indexOf(option);
            select.dispatchEvent(new Event('change', { bubbles: true }));
        },
    }));
}

/** Keep the upstream controls as the source of truth while giving the manager shared Window chrome. */
export function frameDataBankManager(popup, { onSearch, onClose } = {}) {
    const page = getFramePage(popup);
    page.classList.add('sb-data-bank-window');
    const header = page.querySelector(':scope > .sb-dialog__header');
    const body = page.querySelector('.popup-content');
    const searchInput = popup.dlg.querySelector('#attachmentSearch');
    const sortSelect = popup.dlg.querySelector('#attachmentSort');
    const bulkToggle = popup.dlg.querySelector('.attachmentsBulkEditButton');
    const managerRoot = popup.dlg.querySelector('.dataBankAttachments');
    if (!(header instanceof HTMLElement) || !(body instanceof HTMLElement) || !(searchInput instanceof HTMLInputElement)
        || !(sortSelect instanceof HTMLSelectElement) || !(bulkToggle instanceof HTMLElement) || !(managerRoot instanceof HTMLElement)) {
        throw new TypeError('The Data Bank manager is missing its source controls.');
    }

    const headerStart = document.createElement('div');
    headerStart.className = 'sb-dialog__header-start';
    const headerEnd = document.createElement('div');
    headerEnd.className = 'sb-dialog__header-end';
    header.prepend(headerStart);
    const responseControls = header.querySelector(':scope > .popup-controls');
    if (responseControls) headerEnd.append(responseControls);
    const closeButton = popup.closeButton;
    if (closeButton instanceof HTMLElement) {
        headerEnd.append(closeButton);
        header.append(headerEnd);
    } else {
        header.append(headerEnd);
    }

    const searchField = document.createElement('label');
    searchField.className = 'sb-dialog__search sb-data-bank-search';
    searchField.id = 'data-bank-search-field';
    searchField.hidden = true;
    const searchEntry = document.createElement('span');
    searchEntry.className = 'sb-dialog__search-entry';
    const searchIcon = document.createElement('i');
    searchIcon.className = 'fa-solid fa-magnifying-glass';
    searchIcon.setAttribute('aria-hidden', 'true');
    searchEntry.append(searchIcon);
    searchInput.classList.add('sb-dialog__entry', 'sb-dialog__search-input');
    searchEntry.append(searchInput);
    searchField.append(searchEntry);
    header.after(searchField);

    const status = document.createElement('div');
    status.className = 'sb-dialog__status data-bank-search-status';
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    managerRoot.append(status);
    const emptySearch = createStatusPage({ icon: 'magnifying-glass', title: t`No results`, compact: true });
    emptySearch.element.classList.add('data-bank-empty-search');
    emptySearch.element.hidden = true;
    managerRoot.append(emptySearch.element);

    const searchToggle = iconButton(t`Search`, 'magnifying-glass', 'sb-data-bank-search-toggle');
    searchToggle.setAttribute('aria-controls', searchField.id);
    headerStart.prepend(searchToggle);
    const search = createListSearch({
        field: searchField,
        input: searchInput,
        trigger: searchToggle,
        scope: page,
        scroller: body,
        status,
        collapsed: true,
        debounce: 300,
        escapeClearsFirst: true,
        onChange: query => onSearch?.(query),
    });
    const toggleSearch = () => search.toggle();
    searchToggle.addEventListener('click', toggleSearch);

    const sortButton = iconButton(t`Sort`, 'arrow-down-wide-short', 'sb-data-bank-sort');
    sortButton.setAttribute('aria-haspopup', 'menu');
    sortButton.setAttribute('aria-expanded', 'false');
    sortButton.addEventListener('click', () => {
        openActionMenu({
            trigger: sortButton,
            title: t`Sort`,
            sections: [{ items: getSortItems(sortSelect) }],
            bounds: popup.dlg,
        });
    });
    headerEnd.prepend(sortButton);

    headerEnd.append(bulkToggle);
    bulkToggle.classList.remove('menu_button', 'menu_button_icon', 'margin0');
    bulkToggle.classList.add('sb-dialog__icon-button', 'sb-header-icon-button');
    bulkToggle.title = t`Bulk Edit`;
    bulkToggle.setAttribute('aria-label', t`Bulk Edit`);
    bulkToggle.setAttribute('role', 'button');
    bulkToggle.querySelector('span')?.setAttribute('hidden', '');
    const bulkIcon = bulkToggle.querySelector('i');
    bulkIcon?.classList.replace('fa-edit', 'fa-check-square');
    bulkToggle.classList.add('sb-data-bank-bulk-toggle');
    bulkToggle.setAttribute('aria-pressed', String(Boolean(bulkToggle.querySelector('input')?.checked)));
    const bulkInput = bulkToggle.querySelector('input');
    if (bulkInput instanceof HTMLInputElement) {
        bulkInput.id ||= 'sb-data-bank-bulk-edit';
        bulkToggle.htmlFor = bulkInput.id;
        managerRoot.append(bulkInput);
    }
    bulkInput?.addEventListener('change', () => bulkToggle.setAttribute('aria-pressed', String(bulkInput.checked)));

    const bulkActions = popup.dlg.querySelector('.attachmentBulkActionsContainer');
    if (bulkActions instanceof HTMLElement) {
        bulkActions.classList.add('sb-dialog__bottom-bar', 'sb-data-bank-action-bar');
        bulkActions.querySelector('.bulkActionDelete')?.classList.add('is-destructive');
        const popupBody = body.closest('.popup-body');
        if (popupBody instanceof HTMLElement) popupBody.after(bulkActions);
        else page.append(bulkActions);
    }

    for (const section of body.querySelectorAll('.globalAttachmentsBlock, .characterAttachmentsBlock, .chatAttachmentsBlock')) {
        const heading = section.querySelector('h3');
        const description = section.querySelector('small, .flex-container');
        if (!heading || !description) continue;
        heading.classList.add('ds-pref-group-heading');
        const groupHeader = document.createElement('div');
        groupHeader.className = 'ds-pref-group-header';
        const groupDescription = document.createElement('div');
        groupDescription.className = 'ds-pref-group-subtitle';
        groupDescription.append(description);
        heading.before(groupHeader);
        groupHeader.append(heading, groupDescription);
    }

    body.querySelector('.flex-container.marginTopBot5')?.setAttribute('hidden', '');
    popup.dlg.querySelector('.attachmentSort')?.setAttribute('aria-hidden', 'true');
    popup.dlg.querySelectorAll('.openActionModalButton').forEach(button => {
        button.setAttribute('aria-label', t`Add`);
        button.setAttribute('title', t`Add`);
    });

    return {
        search,
        report(shown, total) {
            search.report(shown, total);
            status.hidden = shown !== 0 || !search.query;
            emptySearch.element.hidden = status.hidden;
        },
        destroy() {
            search.destroy();
            searchToggle.removeEventListener('click', toggleSearch);
            searchToggle.remove();
            sortButton.remove();
            searchField.remove();
            status.remove();
            emptySearch.element.remove();
            onClose?.();
        },
    };
}

/** Add the shared row affordances without replacing any upstream action node. */
export function decorateDataBankRow(row, { view, actions }) {
    if (!(row instanceof HTMLElement)) return;
    row.classList.add('sb-data-bank-row', 'ds-row', 'ds-row--activatable');
    row.tabIndex = 0;
    row.setAttribute('role', 'listitem');

    const actionHost = row.querySelector('.attachmentRowActions') || document.createElement('div');
    actionHost.className = 'attachmentRowActions ds-row-suffix';
    row.querySelector('.attachmentListItemText')?.classList.add('ds-row-text');
    row.querySelector('.attachmentListItemMeta')?.classList.add('ds-row-subtitle');
    row.querySelectorAll('.right_menu_button').forEach(button => button.classList.add('sb-dialog__icon-button'));
    const overflow = iconButton(t`Menu`, 'ellipsis-vertical', 'attachmentRowMenu');
    overflow.setAttribute('aria-haspopup', 'menu');
    actionHost.append(overflow);
    row.append(actionHost);

    const actionItems = actions.map(action => ({
        label: action.label,
        icon: action.icon,
        danger: action.danger,
        onSelect: () => action.button.click(),
    }));
    overflow.addEventListener('click', () => openActionMenu({
        trigger: overflow,
        title: t`Menu`,
        sections: [{ items: actionItems }],
        bounds: row.closest('.sb-dialog'),
    }));

    const activate = event => {
        if (event.target instanceof Element && event.target.closest('button, input, a, .right_menu_button')) return;
        const bulk = row.closest('.dataBankAttachments')?.querySelector('.attachmentsBulkEditCheckbox')?.checked;
        if (bulk) {
            const checkbox = row.querySelector('.attachmentListItemCheckbox');
            if (checkbox instanceof HTMLInputElement) checkbox.checked = !checkbox.checked;
            return;
        }
        view.click();
    };
    row.addEventListener('click', activate);
    row.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (event.target !== row) return;
        event.preventDefault();
        activate(event);
    });
}
