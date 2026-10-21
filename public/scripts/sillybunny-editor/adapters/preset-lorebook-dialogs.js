import { t } from '../../i18n.js';
import { createCheckRow, createPrefGroup, createSpinRow, createSwitchRow, releaseRowIds } from '../rows.js';
import { createSelectRow } from '../select-row.js';

function moveText(target, source) {
    if (!source) return;
    if (source.dataset.i18n) target.dataset.i18n = source.dataset.i18n;
    target.replaceChildren(...source.childNodes);
    source.remove();
}

function checkChoice(label) {
    const input = label.querySelector('input[type="checkbox"]');
    if (!input) throw new TypeError('A dialog choice must contain a checkbox.');
    const caption = label.querySelector('span');
    const detail = label.querySelector('small');
    const row = createCheckRow({ label: '', subtitle: detail?.textContent.trim(), field: input.dataset.chid ?? input.value, input });
    moveText(row.row.querySelector('.ds-row-label'), caption);
    moveText(row.row.querySelector('.ds-row-subtitle'), detail);
    return row;
}

function choiceGroup(labels, allInput = null) {
    const rows = labels.map(checkChoice);
    if (rows.length <= 5) return createPrefGroup({ field: 'choices', rows });
    const inputs = rows.map(row => row.control);
    const all = createCheckRow({ label: t`Select All`, field: 'select-all', ...(allInput ? { input: allInput } : {}) });
    all.control.dataset.sbSelectAll = 'true';
    all.row.querySelector('.ds-row-label').dataset.i18n = 'Select All';
    const sync = () => {
        const enabled = inputs.filter(input => !input.disabled);
        const checked = enabled.filter(input => input.checked).length;
        all.control.disabled = enabled.length === 0;
        all.control.checked = enabled.length > 0 && checked === enabled.length;
        all.control.indeterminate = checked > 0 && checked < enabled.length;
    };
    all.control.addEventListener('change', () => {
        const checked = all.control.checked;
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
    return createPrefGroup({ field: 'choices', rows: [all, ...rows] });
}

export function presetChoicesOptions(root, { deletion = false } = {}) {
    const description = deletion ? root.firstElementChild : null;
    const group = choiceGroup([...root.querySelectorAll('label.checkbox_label')]);
    root.className = 'sb-dialog-rows';
    root.replaceChildren(...[description, group.section].filter(Boolean));
    return {
        tier: 'dialog',
        ...(deletion ? { title: t`Delete selected` } : {}),
        onOpen(popup) {
            if (deletion) popup.okButton.classList.add('is-destructive');
        },
        // Callers read the adopted checkboxes after show() resolves; do not remove the rows here.
        onClose() { releaseRowIds(root); },
    };
}

export function embeddedLorebookOptions(root) {
    const heading = root.querySelector('h3');
    const note = root.querySelector('.m-b-1:not(label)');
    const all = root.querySelector('label > input:not(.batch_wi_import_candidate)');
    const group = choiceGroup([...root.querySelectorAll('label')].filter(label => label.querySelector('.batch_wi_import_candidate')), all);
    root.className = 'sb-dialog-rows';
    root.replaceChildren(...[heading, note, group.section].filter(Boolean));
    return { tier: 'dialog', onClose() { releaseRowIds(root); } };
}

/** Popup owns creation and collection of customInputs; only their presentation moves. */
export function lorebookSortingOptions(root, definitions) {
    return {
        tier: 'dialog',
        onOpen(popup) {
            const warning = root.lastElementChild;
            const rows = definitions.map(definition => {
                const input = popup.dlg.querySelector(`#${definition.id}`);
                const adoptedSwitch = input.closest('.ds-row-switch');
                if (adoptedSwitch) return { row: adoptedSwitch, control: input };
                const options = { label: definition.label, subtitle: definition.tooltip, field: definition.id, input };
                return definition.type === 'checkbox' ? createSwitchRow(options) : createSpinRow({ ...options, nullable: true });
            });
            root.classList.add('sb-dialog-rows');
            warning.before(createPrefGroup({ field: 'sorting', rows }).section);
            popup.inputControls.replaceChildren();
            rows[0].control.focus({ preventScroll: true });
        },
        onClose() { releaseRowIds(root); },
    };
}

export function lorebookSelectOptions(root, { character = false } = {}) {
    const heading = root.querySelector('h3, h4');
    heading.classList.add('popup-header');
    const selects = [...root.querySelectorAll('select')];
    const captions = character ? [...root.querySelectorAll('h4')] : [];
    const descriptions = [...root.querySelectorAll('.range-block-counter')];
    const rows = selects.map((select, index) => {
        const caption = captions[index];
        const description = descriptions[index];
        const label = caption?.textContent.trim() ?? t`Lorebook`;
        const auxiliary = character && select.multiple;
        if (auxiliary) {
            const sentinel = [...select.options].find(option => option.value === '');
            if (sentinel) sentinel.hidden = true;
        }
        const noneLabel = auxiliary ? t`No auxiliary Lorebooks set. Click here to select.` : select.options[0].textContent;
        const row = createSelectRow({ select, label, subtitle: description.textContent.trim(), field: select.classList[0], searchLabel: t`Search`, emptyText: t`No results`, noneLabel });
        if (caption) moveText(row.row.querySelector('.ds-row-label'), caption);
        else row.row.querySelector('.ds-row-label').dataset.i18n = 'Lorebook';
        moveText(row.row.querySelector('.ds-row-subtitle'), description);
        return row;
    });
    root.className = 'sb-dialog-rows';
    root.replaceChildren(heading, createPrefGroup({ field: 'lorebooks', rows }).section);
    return {
        tier: 'dialog',
        onClose() {
            for (const row of rows) {
                const select = globalThis.jQuery?.(row.control);
                if (select?.data('select2')) select.select2('destroy');
                row.destroy();
            }
            releaseRowIds(root);
        },
    };
}
