import { t } from '../../i18n.js';
import { createCheckRow, createComboRow, createEntryRow, createPrefGroup, createPropertyRow, moveCaption, releaseRowIds } from '../../sillybunny-editor/rows.js';

/** Heading-like captions give up their content; any other node (a label with a control) moves whole. */
function adoptCaption(row, caption, selector = '.ds-row-label') {
    if (!caption) return;
    const target = row.querySelector(selector);
    if (caption.matches('h2, h3, small')) moveCaption(target, caption);
    else target.replaceChildren(caption);
}

/** Adopt choices before Popup's generic boolean fallback can turn them into switches. */
export function createProfileChoices(root, { title, subtitle, selector = 'label.checkbox_label' } = {}) {
    const inputs = [];
    const rows = [...root.querySelectorAll(selector)].map(label => {
        const input = label.querySelector('input[type="checkbox"]');
        if (!input) throw new TypeError('A profile choice must contain a checkbox.');
        const caption = label.querySelector('strong') ?? label.querySelector('span');
        const value = caption?.tagName === 'STRONG'
            ? [...caption.parentNode.childNodes].filter(node => node !== caption).map(node => node.textContent).join('').trim()
            : '';
        const row = createCheckRow({ label: '', subtitle: value, field: input.value, input });
        adoptCaption(row.row, caption);
        inputs.push(input);
        return row;
    });
    if (inputs.length > 5) {
        const all = createCheckRow({ label: t`Select All`, field: 'select-all' });
        all.row.querySelector('.ds-row-label').dataset.i18n = 'Select All';
        const sync = () => {
            const checked = inputs.filter(input => input.checked).length;
            all.control.checked = checked === inputs.length;
            all.control.indeterminate = checked > 0 && checked < inputs.length;
        };
        all.control.addEventListener('change', () => {
            const checked = all.control.checked;
            for (const input of inputs) {
                if (input.disabled || input.checked === checked) continue;
                input.checked = checked;
                // Create records omissions on input; Edit reads the same adopted controls on Save.
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
            sync();
        });
        inputs.forEach(input => {
            input.addEventListener('input', sync);
            input.addEventListener('change', sync);
        });
        sync();
        rows.unshift(all);
    }
    return createPrefGroup({ title, subtitle, field: 'profile-choices', rows });
}

/** The template stays the source of controls, labels and translated help. */
export function profileDialogOptions(root, { edit = false } = {}) {
    const heading = edit ? null : root.querySelector('h2');
    const nameCaption = root.querySelector('h3:last-child');
    const folder = root.querySelector('#profile_folder_select');
    const folderCaption = folder?.previousElementSibling;
    const settingsCaption = edit ? root.querySelector('[data-i18n="Included settings:"]') : null;
    const hint = root.querySelector('small');
    const choices = createProfileChoices(root, { title: settingsCaption?.textContent.trim(), subtitle: hint?.textContent.replace(/\s+/g, ' ').trim() });
    if (settingsCaption) adoptCaption(choices.section, settingsCaption, '.ds-pref-group-heading');
    if (hint) adoptCaption(choices.section, hint, '.ds-pref-group-subtitle');
    const folderRow = folder ? createComboRow({ label: folderCaption.textContent.trim(), field: 'profile-folder', select: folder }) : null;
    if (folderRow) adoptCaption(folderRow.row, folderCaption);
    const identity = createPrefGroup({ field: 'profile-identity', rows: folderRow ? [folderRow] : [] });
    root.classList.add('sb-connection-dialog-content');
    root.replaceChildren(...[heading, identity.section, choices.section].filter(Boolean));
    return {
        tier: 'dialog',
        ...(edit ? { title: t`Edit a connection profile` } : {}),
        okButton: t`Save`,
        onOpen(popup) {
            const name = createEntryRow({ label: '', field: 'profile-name', input: popup.mainInput });
            adoptCaption(name.row, nameCaption);
            identity.group.prepend(name.row);
            popup.mainInput.focus({ preventScroll: true });
        },
        onClose() { releaseRowIds(root); },
    };
}

export function adaptProfileDeletion(root) {
    const description = root.firstElementChild;
    const group = createProfileChoices(root, { subtitle: description.textContent.trim() });
    root.className = 'sb-connection-dialog-content';
    root.replaceChildren(group.section);
    return {
        tier: 'dialog',
        title: t`Delete selected connection profiles?`,
        onOpen(popup) { popup.okButton.classList.add('is-destructive'); },
        onClose() { releaseRowIds(root); },
    };
}

export function adaptProfileFolders(root) {
    const note = root.querySelector('small');
    const folders = [...root.querySelectorAll('.folder-item')].map(item => {
        const input = item.querySelector('.folder-name-input');
        const count = item.querySelector('.folder-profile-count');
        const remove = item.querySelector('.folder-delete-btn');
        remove.setAttribute('role', 'button');
        remove.setAttribute('aria-label', remove.title);
        remove.tabIndex = 0;
        remove.classList.add('is-destructive');
        remove.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            remove.click();
        });
        const row = createEntryRow({ label: t`Folder:`, subtitle: count.textContent, field: input.id || 'folder-name', input, floating: true, suffix: remove });
        adoptCaption(row.row, count, '.ds-row-entry__caption');
        row.row.querySelector('.ds-row-label').dataset.i18n = 'Folder:';
        item.className = 'folder-item';
        item.replaceChildren(row.row);
        return item;
    });
    const empty = root.querySelector('.folder-empty-message');
    empty?.classList.add('ds-row');
    const list = createPrefGroup({ subtitle: note.textContent.trim(), field: 'profile-folders', rows: folders.length ? folders : [empty] });
    adoptCaption(list.section, note, '.ds-pref-group-subtitle');
    const input = root.querySelector('#new_profile_folder_name');
    const add = root.querySelector('#add_new_folder');
    const entry = createEntryRow({ label: input.placeholder, field: 'new-folder', input, floating: true, suffix: add });
    entry.row.querySelector('.ds-row-label').dataset.i18n = 'New folder name';
    root.classList.add('sb-connection-dialog-content');
    root.replaceChildren(list.section, createPrefGroup({ field: 'add-folder', rows: [entry] }).section);
    return root;
}

export function adaptProfileDetails(root) {
    for (const list of root.querySelectorAll('ul')) {
        const rows = [...list.querySelectorAll('li')].map((item, index) => {
            const caption = item.querySelector('.profile-summary-label');
            const value = item.querySelector('.profile-summary-value');
            const row = createPropertyRow({ label: '', value: '', field: `profile-property-${index}` });
            adoptCaption(row.row, caption, '.ds-row-subtitle');
            adoptCaption(row.row, value, '.ds-row-property__value');
            return row;
        });
        list.replaceWith(createPrefGroup({ field: 'profile-properties', rows }).section);
    }
    const omitted = root.querySelector('[data-i18n="Omitted Settings:"]');
    if (omitted) {
        const container = omitted.parentElement;
        const value = omitted.nextElementSibling;
        const row = createPropertyRow({ label: '', value: '', field: 'omitted-settings' });
        adoptCaption(row.row, omitted, '.ds-row-subtitle');
        adoptCaption(row.row, value, '.ds-row-property__value');
        container.replaceWith(createPrefGroup({ field: 'omitted-settings-group', rows: [row] }).section);
    }
    root.classList.add('sb-connection-dialog-content');
    return root;
}

export { releaseRowIds as releaseProfileDialog };
