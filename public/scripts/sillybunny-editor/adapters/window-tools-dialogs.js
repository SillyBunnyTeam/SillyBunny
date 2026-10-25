import { t } from '../../i18n.js';
import { createCheckRow, createEntryRow, createPrefGroup, createPropertyRow, createRow, releaseRowIds } from '../rows.js';

function asElement(source) {
    const root = source?.jquery ? source.get(0) : source;
    if (root instanceof HTMLElement) return root;
    throw new TypeError('A window tools adapter needs an HTML element.');
}

function moveCaption(target, source) {
    if (source.dataset.i18n) target.dataset.i18n = source.dataset.i18n;
    target.replaceChildren(...source.childNodes);
    target.textContent = target.textContent.trim().replace(/[：:]$/, '').trim();
    source.remove();
}

function displayLabel(node) {
    return node?.textContent.trim().replace(/[：:]$/, '').trim() ?? '';
}

function splitProperty(node) {
    const [label, ...value] = (node?.textContent.trim() ?? '').split(/[:：]/);
    return { label: label.trim(), value: value.join(':').trim() };
}

/** Preserve the live tokenizer inputs and output spans while grouping their source captions. */
export function tokenCounterOptions(source) {
    const root = asElement(source);
    const input = root.querySelector('#token_counter_textarea');
    const ids = root.querySelector('#token_counter_ids');
    const count = root.querySelector('#token_counter_result');
    const chunks = root.querySelector('#tokenized_chunks_display');
    if (!input || !ids || !count || !chunks) throw new TypeError('The token counter needs its source inputs and outputs.');

    const content = input.parentElement;
    const intro = content.querySelector(':scope > h4');
    const tokenizerProperty = splitProperty(content.querySelector(':scope > p'));
    const inputCaption = input.previousElementSibling;
    const idsCaption = ids.previousElementSibling;
    const countCaption = count.previousElementSibling;
    const chunksCaption = chunks.previousElementSibling;
    const inputLabel = displayLabel(inputCaption);
    const chunksLabel = displayLabel(chunksCaption);
    const inputRow = createEntryRow({ label: displayLabel(inputCaption), field: 'token-counter-input', input });
    const idsRow = createEntryRow({ label: displayLabel(idsCaption), field: 'token-counter-ids', input: ids });
    inputRow.row.classList.add('ds-row--stacked');
    idsRow.row.classList.add('ds-row--stacked');
    const countRow = createPropertyRow({ label: displayLabel(countCaption), value: count.textContent, field: 'token-counter-result' });
    const tokenizerRow = createPropertyRow({ label: tokenizerProperty.label, value: tokenizerProperty.value, field: 'token-counter-tokenizer' });
    moveCaption(countRow.row.querySelector('.ds-row-subtitle'), countCaption);
    count.classList.add('ds-row-label', 'ds-row-property__value');
    countRow.row.querySelector('.ds-row-property__value').replaceWith(count);
    const chunksRow = createRow({ label: '', field: 'token-counter-chunks', suffix: chunks, stacked: true });
    moveCaption(inputRow.row.querySelector('.ds-row-label'), inputCaption);
    moveCaption(idsRow.row.querySelector('.ds-row-label'), idsCaption);
    moveCaption(chunksRow.row.querySelector('.ds-row-label'), chunksCaption);

    content.classList.add('sb-dialog-rows');
    const inputGroup = createPrefGroup({
        title: inputLabel,
        subtitle: intro?.textContent.trim(),
        field: 'token-counter-input-group',
        rows: [tokenizerRow, inputRow, countRow],
    });
    const tokenGroup = createPrefGroup({ title: chunksLabel, field: 'token-counter-output-group', rows: [chunksRow, idsRow] });
    content.replaceChildren(inputGroup.section, tokenGroup.section);
    return {
        tier: 'window',
        onClose() { releaseRowIds(root); },
    };
}

/** Adopt sampler inputs into trailing check rows without changing their names or checked state. */
export function adaptSamplerSelectList(source) {
    const root = asElement(source);
    const sourceRows = [...root.querySelectorAll(':scope > label.sampler_view_list_item')];
    const rows = [];
    const inputs = [];
    const listeners = [];

    for (const sourceRow of sourceRows) {
        const input = sourceRow.querySelector('input[type="checkbox"]');
        const label = sourceRow.querySelector('.sampler_name');
        if (!input || !label) throw new TypeError('A sampler row needs its source checkbox and label.');

        const row = createCheckRow({
            label: label.textContent.trim(),
            field: `sampler-${input.name}`,
            input,
        });
        row.row.classList.add('sampler_view_list_item');
        row.row.querySelector('.ds-row-label').replaceWith(label);
        label.classList.add('ds-row-label');
        inputs.push(input);
        rows.push(row);
    }

    let selectAll = null;
    if (inputs.length > 5) {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'sampler_select_all';
        selectAll = createCheckRow({ label: t`Select All`, field: 'sampler-select-all', input });
        selectAll.row.querySelector('.ds-row-label').dataset.i18n = 'Select All';

        const updateSelectAll = () => {
            const selectedCount = inputs.filter(sampler => sampler.checked).length;
            selectAll.control.checked = selectedCount === inputs.length;
            selectAll.control.indeterminate = selectedCount > 0 && selectedCount < inputs.length;
        };
        const synchronizeSamplers = () => {
            const checked = selectAll.control.checked;
            for (const sampler of inputs) {
                if (sampler.checked === checked) continue;
                sampler.checked = checked;
                sampler.dispatchEvent(new Event('change', { bubbles: true }));
            }
        };

        selectAll.control.addEventListener('change', synchronizeSamplers);
        listeners.push([selectAll.control, 'change', synchronizeSamplers]);
        for (const sampler of inputs) {
            sampler.addEventListener('change', updateSelectAll);
            listeners.push([sampler, 'change', updateSelectAll]);
        }
        updateSelectAll();
        rows.unshift(selectAll);
    }

    const group = createPrefGroup({ field: 'sampler-visibility', rows });
    root.classList.remove('flex-container', 'flexNoGap');
    root.classList.add('sb-dialog-rows');
    root.replaceChildren(group.section);

    let destroyed = false;
    return {
        inputs,
        selectAll: selectAll?.control ?? null,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
            rows.forEach(row => row.destroy());
            releaseRowIds(group.section);
        },
    };
}

/** Reflow the debug actions into settings rows while keeping the delegated action nodes intact. */
export function adaptDebugMenu(source) {
    const root = asElement(source);
    const table = root.querySelector('#debug_table');
    if (!table) throw new TypeError('A debug menu needs its source action table.');

    table.classList.add('sb-debug-menu');
    for (const tableRow of table.querySelectorAll('tr')) {
        const cell = tableRow.querySelector('td');
        const name = cell?.querySelector('b');
        const description = cell?.querySelector('.justifyLeft:nth-child(2)');
        const action = cell?.querySelector('[data-debug-function]');
        if (!cell || !name || !description || !action) {
            throw new TypeError('A debug menu action needs a name, description, and action control.');
        }

        const row = createRow({
            label: name.textContent.trim(),
            subtitle: description.textContent.trim(),
            field: `debug-${action.dataset.debugFunction}`,
            suffix: action,
        });
        row.row.classList.add('ds-row-debug');
        cell.replaceChildren(row.row);
    }

    return table;
}
