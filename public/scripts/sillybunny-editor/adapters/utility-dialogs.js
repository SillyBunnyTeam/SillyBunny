import { t } from '../../i18n.js';
import { createEntryRow, createPrefGroup, createSpinRow, moveCaption, releaseRowIds } from '../rows.js';
import { createToggleRow } from '../toggle-row.js';
import { createSelectRow } from '../select-row.js';

function asElement(source) {
    const root = source?.jquery ? source.get(0) : source;
    if (root instanceof HTMLElement) return root;
    throw new TypeError('A utility dialog needs an HTML element.');
}

function textOf(node) {
    return node?.textContent.replace(/\s+/g, ' ').trim() ?? '';
}

function entryRow(input, caption, subtitle) {
    const floating = input instanceof HTMLInputElement && ['text', 'url', 'search', 'email', 'tel'].includes(input.type);
    const row = createEntryRow({ label: textOf(caption), subtitle, field: input.id || input.name, input, floating });
    if (input instanceof HTMLTextAreaElement) row.row.classList.add('ds-row--stacked');
    moveCaption(row.row.querySelector('.ds-row-label'), caption);
    return row;
}

/** Popup still creates, validates and collects custom inputs; only their presentation moves. */
export function utilityFormOptions({ title, mainLabel = null, clearContent = false } = {}) {
    return {
        tier: 'dialog',
        ...(title ? { title } : {}),
        onOpen(popup) {
            const rows = [];
            if (mainLabel) {
                rows.push(createEntryRow({ label: mainLabel, field: 'main-input', input: popup.mainInput }));
                if (popup.mainInput.rows > 3) rows[0].row.classList.add('ds-row--stacked');
            }
            for (const label of [...popup.inputControls.querySelectorAll('label.text_label, .ds-row-switch')]) {
                if (label.classList.contains('ds-row-switch')) {
                    rows.push({ row: label, control: label.querySelector('input') });
                    continue;
                }
                const input = label.querySelector('input, textarea');
                if (!input) throw new TypeError('A custom dialog field needs its source control.');
                const caption = label.querySelector('span');
                if (input.type === 'number') {
                    const row = createSpinRow({ label: textOf(caption), subtitle: input.title, field: input.id, input, normalize: false });
                    moveCaption(row.row.querySelector('.ds-row-label'), caption);
                    rows.push(row);
                } else {
                    rows.push(entryRow(input, caption, input.title));
                }
            }
            if (clearContent) popup.content.replaceChildren();
            popup.content.classList.add('sb-dialog-rows');
            popup.content.append(createPrefGroup({ field: 'utility-fields', rows }).section);
            popup.inputControls.replaceChildren();
            popup.inputControls.style.display = 'none';
            rows[0]?.control.focus({ preventScroll: true });
        },
        onClose(popup) { releaseRowIds(popup.content); },
    };
}

/** Radio identity and native input events remain the source of the selected import/output target. */
function segmentedRow(labels, caption, field) {
    const inputs = labels.map(label => label.querySelector('input[type="radio"]'));
    if (inputs.length < 2 || inputs.some(input => !input)) throw new TypeError('A segmented dialog needs its source radios.');
    const captions = labels.map(label => label.querySelector('span'));
    const row = createToggleRow({
        label: textOf(caption), field, fill: true, inputs,
        choices: inputs.map((input, index) => [input.value, textOf(captions[index])]),
        value: inputs.find(input => input.checked)?.value,
    });
    moveCaption(row.row.querySelector('.ds-row-label'), caption);
    const segments = [...row.group.querySelectorAll('.sb-boolean-radio-option > span')];
    captions.forEach((source, index) => moveCaption(segments[index], source));
    return row;
}

export function regexImportOptions(source) {
    const root = asElement(source);
    const heading = root.querySelector('h3');
    const row = segmentedRow([...root.querySelectorAll('label')], null, 'regex-import-target');
    // Reuse the upstream heading for both the frame title and the named row.
    row.row.querySelector('.ds-row-label').textContent = textOf(heading);
    row.row.querySelector('.ds-row-label').dataset.i18n = heading.dataset.i18n;
    root.className = 'sb-dialog-rows';
    root.replaceChildren(heading, createPrefGroup({ field: 'regex-import', rows: [row] }).section);
    return { tier: 'dialog', onClose() { releaseRowIds(root); } };
}

export function quickReplyTransferOptions(source) {
    const root = asElement(source);
    const select = root.querySelector('select');
    if (!select) throw new TypeError('A Quick Reply transfer needs its source select.');
    const hint = root.querySelector('p');
    const row = createSelectRow({ select, label: t`Quick Reply Set`, field: 'quick-reply-target', searchLabel: t`Search`, emptyText: t`No results` });
    const group = createPrefGroup({ field: 'quick-reply-transfer', subtitle: textOf(hint), rows: [row] });
    moveCaption(group.section.querySelector('.ds-pref-group-subtitle'), hint?.querySelector('small'));
    root.classList.add('sb-dialog-rows');
    root.replaceChildren(...[root.querySelector('h3'), root.querySelector('h4'), group.section].filter(Boolean));
    for (const type of ['keydown', 'keyup']) {
        row.trigger.addEventListener(type, event => {
            if (event.key !== 'Shift' && event.key !== 'Enter') return;
            if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
            }
            select.dispatchEvent(new KeyboardEvent(type, { key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, bubbles: true }));
        });
    }
    return {
        tier: 'dialog',
        onOpen() { row.trigger.focus({ preventScroll: true }); },
        onClose() {
            // Destroying the row returns the select to its old parent, which the caller reads after the dialog resolves.
            row.destroy();
            releaseRowIds(root);
        },
    };
}

export function scraperDialogOptions(source, kind) {
    const root = asElement(source);
    const rows = [];
    if (kind === 'mediawiki' || kind === 'fandom') {
        for (const input of root.querySelectorAll('input[type="text"]')) {
            const block = input.parentElement;
            const caption = block.querySelector('label');
            const notes = [...block.querySelectorAll('i, small')];
            const row = entryRow(input, caption, notes.map(textOf).join(' '));
            row.row.querySelector('.ds-row-subtitle')?.replaceChildren(...notes);
            rows.push(row);
        }
        const radios = [...root.querySelectorAll('input[type="radio"]')].map(input => input.closest('label'));
        const caption = radios[0].parentElement.querySelector('label:not([for])');
        const output = segmentedRow(radios, caption, 'scrape-output');
        const descriptions = radios.map(label => label.querySelector('small')).filter(Boolean);
        const group = createPrefGroup({ field: 'scrape-output', subtitle: descriptions.map(textOf).join(' '), rows: [output] });
        group.section.querySelector('.ds-pref-group-subtitle').replaceChildren(...descriptions);
        root.replaceChildren(createPrefGroup({ field: 'scrape-fields', rows }).section, group.section);
    } else if (kind === 'youtube') {
        const input = root.querySelector('input');
        rows.push(entryRow(input, input.previousElementSibling));
        root.querySelector(':scope > label:last-child')?.remove();
        root.append(createPrefGroup({ field: 'scrape-language', rows }).section);
    } else if (kind !== 'web') {
        throw new TypeError(`Unknown scraper dialog: ${kind}`);
    }
    root.classList.add('sb-dialog-rows');
    const mainLabel = kind === 'web' ? textOf(root) : kind === 'youtube' ? t`Video ID:` : null;
    const title = { web: t`Web`, mediawiki: t`MediaWiki`, fandom: t`Fandom`, youtube: t`YouTube` }[kind];
    return {
        tier: 'dialog', title,
        onOpen(popup) {
            if (!mainLabel) {
                rows[0]?.control.focus({ preventScroll: true });
                return;
            }
            const row = createEntryRow({ label: mainLabel, field: 'scrape-source', input: popup.mainInput });
            if (kind === 'web') {
                row.row.classList.add('ds-row--stacked');
                if (root.dataset.i18n) row.row.querySelector('.ds-row-label').dataset.i18n = root.dataset.i18n;
                root.removeAttribute('data-i18n');
                root.replaceChildren();
            }
            root.append(createPrefGroup({ field: 'scrape-source', rows: [row] }).section);
            popup.mainInput.focus({ preventScroll: true });
        },
        onClose(popup) { releaseRowIds(popup.content); },
    };
}

export function iconPickerOptions(source) {
    const root = asElement(source);
    const input = root.querySelector('input.faQuery');
    if (!input) throw new TypeError('An icon picker needs its source search input.');
    const row = createEntryRow({ label: input.placeholder, field: 'icon-search', input, floating: true });
    input.placeholder = ' ';
    root.querySelector('.faQuery-container').replaceChildren(createPrefGroup({ field: 'icon-search', rows: [row] }).section);
    for (const icon of root.querySelectorAll('.faPicker > [data-result]')) {
        icon.setAttribute('role', 'button');
        icon.setAttribute('aria-label', icon.title);
        icon.tabIndex = 0;
        icon.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            icon.click();
        });
    }
    return {
        tier: 'dialog', title: input.placeholder,
        onOpen(popup) {
            popup.dlg.classList.add('sb-icon-picker');
            input.focus({ preventScroll: true });
        },
        onClose() { releaseRowIds(root); },
    };
}
