import { t } from '../../i18n.js';
import { openActionMenu } from '../../sillybunny-action-menu.js';
import { loadStylesheetAsync } from '../../dynamic-styles.js';

let extensionsManagerStyles;

export function loadExtensionsManagerStyles() {
    extensionsManagerStyles ??= loadStylesheetAsync('/css/sillybunny-extensions-manager.css', { id: 'sillybunny-extensions-manager-css' });
    return extensionsManagerStyles;
}

function asElement(source) {
    const root = source?.jquery ? source.get(0) : source;
    if (root instanceof HTMLElement) return root;
    throw new TypeError('The extensions manager needs an HTML root.');
}

function stripTrailingColon(node) {
    if (!(node instanceof HTMLElement)) return;
    node.textContent = node.textContent.trim().replace(/[：:]$/, '').trim();
}

function iconButton(label, icon) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sb-dialog__icon-button sb-header-icon-button';
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.title = label;
    const glyph = document.createElement('i');
    glyph.className = `fa-solid ${icon}`;
    glyph.setAttribute('aria-hidden', 'true');
    button.append(glyph);
    return button;
}

function moveSectionRows(section, selector, heading, suffix = null) {
    const wrapper = section.closest('.marginBot10');
    if (!wrapper) return null;
    const rows = [...wrapper.querySelectorAll(selector)];
    const header = document.createElement('div');
    header.className = 'ds-pref-group-header';
    heading.classList.add('ds-pref-group-heading');
    stripTrailingColon(heading);
    if (suffix) {
        const line = document.createElement('div');
        line.className = 'flex-container alignitemscenter spaceBetween flexnowrap';
        suffix.classList.add('ds-row-suffix');
        line.append(heading, suffix);
        header.append(line);
    } else {
        header.append(heading);
    }
    const group = document.createElement('div');
    group.className = 'ds-pref-group';
    group.setAttribute('role', 'group');
    for (const row of rows) {
        if (!row.classList.contains('extensions_loading')) continue;
        row.classList.add('ds-row', 'ds-row--stacked');
        row.querySelector('span')?.classList.add('ds-row-text');
    }
    group.append(...rows);
    const replacement = document.createElement('section');
    replacement.className = 'sb-editor-section sb-extensions-section';
    replacement.append(header, group);
    wrapper.replaceWith(replacement);
    return replacement;
}

function groupApiStatus(root) {
    const heading = [...root.children].find(node => node.matches('h3'));
    if (!heading) return;
    const description = heading.nextElementSibling;
    const header = document.createElement('div');
    header.className = 'ds-pref-group-header';
    heading.className = 'ds-pref-group-heading';
    stripTrailingColon(heading);
    const group = document.createElement('div');
    group.className = 'ds-pref-group';
    group.setAttribute('role', 'group');
    if (description) {
        const row = document.createElement('div');
        row.className = 'ds-row';
        const text = document.createElement('div');
        text.className = 'ds-row-text';
        description.classList.add('ds-row-subtitle');
        text.append(description);
        row.append(text);
        group.append(row);
    }
    const section = document.createElement('section');
    section.className = 'sb-editor-section sb-extensions-section sb-extensions-api-status';
    section.append(header, group);
    heading.before(section);
    header.append(heading);
}

function appendMenu(trigger, title, sections) {
    trigger.addEventListener('click', () => {
        openActionMenu({
            trigger,
            title,
            sections,
            bounds: trigger.closest('.sb-dialog'),
            onClose: () => trigger.setAttribute('aria-expanded', 'false'),
        });
        trigger.setAttribute('aria-expanded', 'true');
    });
}

/** Keep extension actions in the frame header and use boxed preference groups for the list. */
export function adaptExtensionsManager(source, {
    updateAllButton,
    updateEnabledOnlyButton,
    sortOrderButton,
    sortByName,
    toggleAllExtensionsButton,
    restoreBulkToggledExtensionsButton,
}) {
    const root = asElement(source);
    const externalWrapper = [...root.querySelectorAll(':scope > .marginBot10')]
        .find(wrapper => wrapper.querySelector('.third_party_toolbar'));
    const builtinWrapper = [...root.querySelectorAll(':scope > .marginBot10')]
        .find(wrapper => wrapper.querySelector(':scope > .extension_block'));
    if (!builtinWrapper || !externalWrapper) throw new TypeError('The extensions manager is missing its extension groups.');

    const suffix = document.createElement('div');
    suffix.className = 'ds-pref-group-header-suffix';
    suffix.append(toggleAllExtensionsButton, restoreBulkToggledExtensionsButton);
    moveSectionRows(builtinWrapper, ':scope > .extension_block', builtinWrapper.querySelector(':scope > h3'));
    const installedHeading = externalWrapper.querySelector(':scope > div > h3');
    moveSectionRows(externalWrapper, ':scope > .extension_block, :scope > .extensions_loading', installedHeading, suffix);
    externalWrapper.querySelector('.third_party_toolbar')?.remove();
    externalWrapper.querySelector('.flex-container.alignitemscenter')?.remove();
    root.querySelector('.extensions_toolbar')?.remove();
    groupApiStatus(root);

    const headerMenus = document.createElement('div');
    headerMenus.className = 'sb-dialog__header-end extensions-header-menus';
    headerMenus.dataset.sbExtensionsHeaderMenus = 'true';
    const updateMenu = iconButton(t`Menu`, 'fa-ellipsis-vertical');
    appendMenu(updateMenu, t`Extensions`, [{
        items: [
            { label: updateAllButton.textContent.trim(), icon: 'fa-solid fa-rotate', onSelect: () => updateAllButton.click() },
            { label: updateEnabledOnlyButton.textContent.trim(), icon: 'fa-solid fa-rotate-right', onSelect: () => updateEnabledOnlyButton.click() },
        ],
    }]);

    const sortMenu = iconButton(t`Sort`, 'fa-arrow-down-wide-short');
    appendMenu(sortMenu, t`Sort`, [{
        items: [
            {
                label: t`Sort: Display Name`,
                kind: 'radio',
                checked: sortByName,
                onSelect: () => { if (!sortByName) sortOrderButton.click(); },
            },
            {
                label: t`Sort: Loading Order`,
                kind: 'radio',
                checked: !sortByName,
                onSelect: () => { if (sortByName) sortOrderButton.click(); },
            },
        ],
    }]);
    headerMenus.append(sortMenu, updateMenu);

    return {
        onOpen: popup => {
            document.dispatchEvent(new CustomEvent('sillybunny:extensions-manager-open'));
            const header = popup.dlg.querySelector('.sb-dialog__header');
            if (!header) return;
            const close = header.querySelector('.popup-button-close, .sb-dialog__close');
            const existingEnd = header.querySelector(':scope > .sb-dialog__header-end');
            if (existingEnd && !existingEnd.dataset.sbExtensionsHeaderMenus) {
                existingEnd.replaceWith(headerMenus);
                headerMenus.append(...existingEnd.childNodes);
            }
            if (close && close.parentElement !== headerMenus) headerMenus.append(close);
            if (headerMenus.parentElement !== header) header.append(headerMenus);
        },
        onClose: () => document.dispatchEvent(new CustomEvent('sillybunny:extensions-manager-close')),
    };
}
