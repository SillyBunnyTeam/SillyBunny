import { openPopover } from '../../../../sillybunny-action-menu.js';
import { createIconButton } from '../../../../sillybunny-editor/dialog.js';
import { createButtonRow, createCheckRow, createEntryRow, createRow, releaseRowIds } from '../../../../sillybunny-editor/rows.js';
import { createSelectRow } from '../../../../sillybunny-editor/select-row.js';
import { t } from '../../../../i18n.js';
import { KINDS, ORPHAN_REASONS, SEARCH_DEBOUNCE_MS } from './constants.js';
import { appendOption, el, markPlaceholder, placeholderCopy, tr } from './dom.js';
import {
    countFromText,
    countText,
    dateFromInput,
    dateInputText,
    mebibytesText,
    sizeFromMebibytes,
} from './filter-values.js';
import { commitModel } from './saved-views.js';
import { filtersActive, resetFilters } from './view-model.js';

const NUMBER_FIELDS = [
    { field: 'minSize', parse: sizeFromMebibytes, format: mebibytesText, step: 'any' },
    { field: 'maxSize', parse: sizeFromMebibytes, format: mebibytesText, step: 'any' },
    { field: 'minMessages', parse: countFromText, format: countText, step: '1' },
    { field: 'maxMessages', parse: countFromText, format: countText, step: '1' },
];

function suffixInput(type, label) {
    const input = document.createElement('input');
    input.type = type;
    input.className = 'text_pole sbca-filter-input';
    input.setAttribute('aria-label', label);
    return input;
}

function buildFilters(ctx, state, ui) {
    const content = el('div', 'sbca-filters');
    const commit = patch => commitModel(ctx, state, ui, { ...state.model, ...patch });
    // One pending edit per field, so a quick edit in a second field does not drop the first.
    const pending = new Map();
    let timer = null;
    function flush() {
        clearTimeout(timer);
        const edits = [...pending.values()];
        pending.clear();
        for (const apply of edits) apply();
    }
    const commitSoon = (field, apply) => {
        pending.set(field, apply);
        clearTimeout(timer);
        timer = setTimeout(flush, SEARCH_DEBOUNCE_MS);
    };

    const reasonSelect = document.createElement('select');
    for (const [value, label] of ORPHAN_REASONS) {
        appendOption(reasonSelect, value, tr(ctx, label));
    }
    reasonSelect.value = state.model.orphan;
    const reasonRow = createSelectRow({
        select: reasonSelect,
        label: tr(ctx, 'Orphan reason'),
        field: 'filter-orphan-reason',
        noneLabel: tr(ctx, 'Any reason'),
        bounds: ui.dialog.surface,
        onChange: value => commit({ orphan: value }),
    });
    reasonRow.setVisible(state.model.types.has('orphan'));

    const typeRows = KINDS.map(([kind, label]) => createCheckRow({
        label: tr(ctx, label),
        field: `filter-${kind}`,
        checked: state.model.types.has(kind),
        onChange: checked => {
            const types = new Set(state.model.types);
            types[checked ? 'add' : 'delete'](kind);
            commit({ types });
            reasonRow.setVisible(types.has('orphan'));
        },
    }));
    const favoriteRow = createCheckRow({
        label: tr(ctx, 'Favorites'),
        field: 'filter-favorite',
        checked: state.model.favorite !== false,
        onChange: checked => commit({ favorite: checked ? undefined : false }),
    });

    const tagInput = document.createElement('input');
    tagInput.setAttribute('list', ui.tagOptions.id);
    tagInput.placeholder = tr(ctx, 'Tag');
    const tagRow = createEntryRow({
        label: tr(ctx, 'Tag'),
        field: 'filter-tag',
        input: tagInput,
        value: state.model.tag,
        onInput: value => commitSoon('tag', () => commit({ tag: value.trim() })),
    });

    const dateInputs = [['minDate', 'From date', false], ['maxDate', 'To date', true]].map(([field, label, endOfDay]) => {
        const input = suffixInput('date', tr(ctx, label));
        input.value = dateInputText(state.model[field]);
        input.addEventListener('change', () => commit({ [field]: dateFromInput(input.value, endOfDay) }));
        return { field, input, row: createRow({ label: tr(ctx, label), field: `filter-${field}`, suffix: input }) };
    });

    const numberInputs = NUMBER_FIELDS.map(({ field, parse, format, step }) => {
        const input = suffixInput('number', placeholderCopy());
        input.min = '0';
        input.step = step;
        input.inputMode = step === '1' ? 'numeric' : 'decimal';
        input.value = format(state.model[field]);
        input.addEventListener('input', () => commitSoon(field, () => commit({ [field]: parse(input.value) })));
        const { row } = createRow({ label: placeholderCopy(), field: `filter-${field}`, suffix: input });
        markPlaceholder(row.querySelector('.ds-row-label'));
        return { field, input, format, row };
    });

    function sync() {
        const { model } = state;
        KINDS.forEach(([kind], index) => typeRows[index].setValue(model.types.has(kind)));
        favoriteRow.setValue(model.favorite !== false);
        reasonRow.setValue(model.orphan);
        reasonRow.setVisible(model.types.has('orphan'));
        tagRow.setValue(model.tag);
        for (const { field, input } of dateInputs) {
            input.value = dateInputText(model[field]);
        }
        for (const { field, input, format } of numberInputs) {
            input.value = format(model[field]);
        }
    }

    const resetRow = createButtonRow({
        label: t`Reset`,
        icon: 'rotate-left',
        field: 'filter-reset',
        onActivate: () => {
            clearTimeout(timer);
            pending.clear();
            commitModel(ctx, state, ui, resetFilters(state.model));
            sync();
        },
    });

    content.append(
        ...typeRows.map(({ row }) => row),
        favoriteRow.row,
        reasonRow.row,
        tagRow.row,
        ui.tagOptions,
        ...dateInputs.map(({ row }) => row.row),
        ...numberInputs.map(({ row }) => row),
        resetRow.row,
    );
    return { content, flush };
}

function openFilters(ctx, state, ui, trigger) {
    const { content, flush } = buildFilters(ctx, state, ui);
    openPopover({
        trigger,
        title: tr(ctx, 'Filters'),
        content,
        bounds: ui.dialog.surface,
        onClose: () => {
            flush();
            releaseRowIds(content);
        },
    });
}

export function createFilterButton(ctx, state, ui) {
    const control = createIconButton(tr(ctx, 'Filters'), 'filter', 'sbca-filters-button');
    control.setAttribute('aria-haspopup', 'dialog');
    control.addEventListener('click', () => openFilters(ctx, state, ui, control));
    ui.filterButtons.add(control);
    return control;
}

export function syncFilterButtons(state, ui) {
    const active = filtersActive(state.model);
    for (const control of ui.filterButtons) {
        if (!control.isConnected) {
            ui.filterButtons.delete(control);
            continue;
        }
        control.toggleAttribute('data-active', active);
        if (active) {
            control.setAttribute('aria-describedby', ui.filtersDescription.id);
        } else {
            control.removeAttribute('aria-describedby');
        }
    }
}
