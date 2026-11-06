import { t } from '../../../i18n.js';
import { createCheckRow, createEntryRow, createPrefGroup, moveCaption } from '../../../sillybunny-editor/rows.js';
import { createSelectRow } from '../../../sillybunny-editor/select-row.js';
import { createToggleRow } from '../../../sillybunny-editor/toggle-row.js';

const preparedDialogs = new WeakMap();

function asElement(source) {
    const root = source?.jquery ? source.get(0) : source;
    if (root instanceof HTMLElement) return root;
    throw new TypeError('An in-chat agents dialog needs an HTML element.');
}

function textOf(node) {
    return node?.textContent.replace(/\s+/g, ' ').trim() ?? '';
}

function labelText(label) {
    const text = [...label.childNodes]
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent)
        .join(' ')
        .trim();
    return text || textOf(label.querySelector('strong, span'));
}

function checkboxGroup(labels, field) {
    const rows = labels.map(label => {
        const input = label.querySelector('input[type="checkbox"]');
        if (!input) throw new TypeError('An in-chat agents choice needs a checkbox.');
        const caption = label.querySelector('span');
        const row = createCheckRow({ label: '', field: input.id || input.name || input.value || field, input });
        moveCaption(row.row.querySelector('.ds-row-label'), caption, { keepSource: true });
        label.replaceWith(row.row);
        return row;
    });
    if (rows.length <= 5) return createPrefGroup({ field, rows });

    const selectAll = createCheckRow({ label: t`Select All`, field: `${field}-all` });
    selectAll.control.dataset.sbSelectAll = 'true';
    const inputs = rows.map(row => row.control);
    const sync = () => {
        const enabled = inputs.filter(input => !input.disabled);
        const checked = enabled.filter(input => input.checked).length;
        selectAll.control.disabled = enabled.length === 0;
        selectAll.control.checked = enabled.length > 0 && checked === enabled.length;
        selectAll.control.indeterminate = checked > 0 && checked < enabled.length;
    };
    selectAll.control.addEventListener('change', () => {
        const checked = selectAll.control.checked;
        for (const input of inputs) {
            if (input.disabled || input.checked === checked) continue;
            input.checked = checked;
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
    return createPrefGroup({ field, rows: [selectAll, ...rows] });
}

function segmentedSelect(select, label, field) {
    const choices = [...select.options].map(option => [option.value, textOf(option)]);
    const row = createToggleRow({
        label,
        field,
        choices,
        value: select.value,
        onChange(value) {
            select.value = value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        },
    });
    // Keep the native select measurable for existing automation and extension callers, while the
    // segmented radios remain the visible and keyboard-facing control.
    select.classList.add('sb-dialog-source-select');
    select.style.position = 'absolute';
    select.style.width = '1px';
    select.style.height = '1px';
    select.style.opacity = '0';
    select.style.pointerEvents = 'none';
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.addEventListener('change', () => row.setValue(select.value));
    row.row.append(select);
    row.sync = () => row.setValue(select.value);
    return row;
}

/** Rebuilds the persisted bulk-edit controls without changing their source selects. */
export function prepareBulkEditDialog(source) {
    const root = asElement(source);
    const existing = preparedDialogs.get(root);
    if (existing) return existing;

    const body = root.querySelector('.ica--bulk-edit-popup-content');
    if (!body) throw new TypeError('The bulk-edit dialog template is incomplete.');
    const labels = [...body.querySelectorAll(':scope > .ica--editor-row > label')];
    if (labels.length !== 6) throw new TypeError('The bulk-edit dialog needs six property controls.');

    const segmentedFields = new Set(['promptMode', 'promptEnabled', 'ppEnabled', 'scan']);
    const rows = [];
    const segmented = [];
    for (const label of labels) {
        const select = label.querySelector('select');
        if (!select) throw new TypeError('A bulk-edit property needs a source select.');
        const field = select.id.replace('ica--bulkEdit-', '');
        const caption = labelText(label);
        const row = segmentedFields.has(field)
            ? segmentedSelect(select, caption, `bulk-edit-${field}`)
            : createSelectRow({
                select,
                label: caption,
                field: `bulk-edit-${field}`,
                title: caption,
                searchLabel: t`Search`,
                emptyText: t`No results`,
            });
        if (segmentedFields.has(field)) segmented.push(row);
        label.replaceWith(row.row);
        rows.push(row);
    }

    const description = body.querySelector('p');
    body.classList.add('sb-dialog-rows');
    body.replaceChildren(...[description, createPrefGroup({ field: 'bulk-edit-fields', rows }).section].filter(Boolean));
    const state = {
        sync() {
            rows.forEach(row => row.sync?.());
            segmented.forEach(row => row.sync());
        },
    };
    preparedDialogs.set(root, state);
    return state;
}

/** Converts manual run targets to trailing checkboxes while keeping the source inputs queryable. */
export function prepareManualRunTargets(source) {
    const root = asElement(source);
    const existing = preparedDialogs.get(root);
    if (existing) return existing;

    const heading = root.querySelector('h4');
    heading?.classList.add('popup-header');
    const labels = [...root.querySelectorAll(':scope > label.checkbox_label')];
    if (!labels.length) throw new TypeError('The manual run target picker has no choices.');
    const group = checkboxGroup(labels, 'manual-run-targets');
    const rangeLabel = root.querySelector(':scope > .ica--run-target-range');
    const rangeInput = rangeLabel?.querySelector('input');
    let rangeRow = null;
    if (rangeInput) {
        rangeRow = createEntryRow({
            label: textOf(rangeLabel.querySelector('span')),
            field: rangeInput.id,
            input: rangeInput,
            floating: true,
        });
        rangeLabel.remove();
    }
    root.classList.add('sb-dialog-rows');
    root.replaceChildren(...[heading, group.section, rangeRow?.row].filter(Boolean));
    const state = {};
    preparedDialogs.set(root, state);
    return state;
}

/** Converts the custom-group form to entry and check rows while retaining its query selectors. */
export function prepareCustomGroupDialog(source) {
    const root = asElement(source);
    const existing = preparedDialogs.get(root);
    if (existing) return existing;

    const nameInput = root.querySelector('#ica--grp-name');
    const descriptionInput = root.querySelector('#ica--grp-desc');
    const agentList = root.querySelector('#ica--grp-agents');
    if (!nameInput || !descriptionInput || !agentList) throw new TypeError('The custom-group dialog template is incomplete.');
    const nameLabel = nameInput.closest('label');
    const descriptionLabel = descriptionInput.closest('label');
    const nameRow = createEntryRow({ label: textOf(nameLabel?.querySelector('strong')), field: nameInput.id, input: nameInput, floating: true });
    const descriptionRow = createEntryRow({ label: textOf(descriptionLabel?.querySelector('strong')), field: descriptionInput.id, input: descriptionInput, floating: true });
    const labels = [...agentList.querySelectorAll(':scope > label.checkbox_label')];
    const group = checkboxGroup(labels, 'custom-group-agents');
    const preferenceGroup = group.section.querySelector('.ds-pref-group');
    const selectAllRow = preferenceGroup?.querySelector('[data-sb-select-all]')?.closest('.ds-row-check');
    if (selectAllRow) {
        const list = document.createElement('div');
        list.id = agentList.id;
        list.className = 'ica--custom-group-agent-list';
        list.append(...[...preferenceGroup.querySelectorAll('.ds-row-check')].filter(row => row !== selectAllRow));
        preferenceGroup.replaceChildren(selectAllRow, list);
    } else {
        group.section.id = agentList.id;
    }
    nameLabel?.remove();
    descriptionLabel?.remove();
    root.classList.add('sb-dialog-rows');
    root.replaceChildren(
        createPrefGroup({ field: 'custom-group-fields', rows: [nameRow, descriptionRow] }).section,
        group.section,
    );
    const state = {};
    preparedDialogs.set(root, state);
    return state;
}

/** Presents the five refinement modes as one keyboard-accessible select and keeps the old radios as the source. */
export function prepareRefinePromptDialog(source) {
    const root = asElement(source);
    const existing = preparedDialogs.get(root);
    if (existing) return existing;

    const radioLabels = [...root.querySelectorAll('label.checkbox_label')];
    const customInput = root.querySelector('#ica--refine-custom');
    const customLabel = customInput?.previousElementSibling;
    const description = root.querySelector('p');
    if (radioLabels.length < 2 || !(customInput instanceof HTMLInputElement) || !description) {
        throw new TypeError('The refine-prompt dialog template is incomplete.');
    }
    const radioBin = document.createElement('div');
    radioBin.hidden = true;
    radioLabels.forEach(label => radioBin.append(label));
    const select = document.createElement('select');
    select.id = 'ica--refine-mode-select';
    const inputs = radioLabels.map(label => label.querySelector('input[type="radio"]'));
    inputs.forEach(input => {
        const option = document.createElement('option');
        option.value = input.value;
        option.textContent = textOf(input.closest('label')?.querySelector('span'));
        select.append(option);
    });
    select.value = inputs.find(input => input.checked)?.value ?? inputs[0].value;
    select.addEventListener('change', () => {
        const selected = inputs.find(input => input.value === select.value);
        if (!selected) return;
        selected.checked = true;
        selected.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const modeRow = createSelectRow({
        select,
        label: textOf(description),
        field: 'refine-prompt-mode',
        title: textOf(description),
        searchLabel: t`Search`,
        emptyText: t`No results`,
    });
    description.remove();
    const customRow = createEntryRow({
        label: textOf(customLabel?.querySelector('span')),
        field: customInput.id,
        input: customInput,
        floating: true,
    });
    root.classList.add('sb-dialog-rows');
    root.replaceChildren(createPrefGroup({ field: 'refine-prompt-fields', rows: [modeRow, customRow] }).section, radioBin);
    const state = {};
    preparedDialogs.set(root, state);
    return state;
}
