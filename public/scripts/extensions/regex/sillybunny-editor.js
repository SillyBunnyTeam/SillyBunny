import { t } from '../../i18n.js';
import { createCheckRow, createEntryRow, createPrefGroup, createSpinRow, createSwitchRow, createTextAreaField, moveCaption, releaseRowIds } from '../../sillybunny-editor/rows.js';
import { createSelectRow } from '../../sillybunny-editor/select-row.js';

function textOf(node) {
    return node?.textContent.replace(/\s+/g, ' ').trim().replace(/[：:]$/, '').trim() ?? '';
}

function needed(root, selector, ElementType = HTMLElement) {
    const source = root.querySelector(selector);
    if (!(source instanceof ElementType)) throw new TypeError(`The regex editor template is missing ${selector}.`);
    return source;
}

/** A group heading that keeps the translation key of the template's own caption. */
function titled(group, caption) {
    moveCaption(group.section.querySelector('.ds-pref-group-heading'), caption, { keepSource: true });
    return group;
}

/**
 * Puts the body of the regex editor in boxed groups, as the Quick Reply editor has them: the script's fields, what it affects,
 * its options, and its ephemerality. Every control keeps its node, name, class and listener, so the extension still reads
 * the fields by the selectors it always used; only their rows and groups are new. Call it after the extension has filled
 * the fields, because a floating entry row reads its value once as it is built.
 * The header keeps Cancel and Save: a regex edit is applied when it is saved, not as it is made.
 * @param {HTMLElement} root The editor template, `#regex_editor_template`.
 * @returns {{ options: { onClose: () => void } }}
 */
export function adaptRegexEditor(root) {
    if (!(root instanceof HTMLElement) || !root.querySelector('.regex_editor')) {
        throw new TypeError('The regex editor needs its source template.');
    }

    // The four fields of the script: two entry rows and two text-area fields.
    const fields = needed(root, '.regex_editor > .flex-container.flexFlowColumn');
    const fieldRows = [];
    for (const block of fields.querySelectorAll(':scope > .flex1')) {
        const input = block.querySelector('input.text_pole, textarea.text_pole');
        const caption = block.querySelector('label > small');
        if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) || !caption) throw new TypeError('A regex editor field needs its input and caption.');
        const name = input.className.split(/\s+/).find(className => className.startsWith('regex_') || className === 'find_regex');
        const row = input instanceof HTMLTextAreaElement
            ? createTextAreaField({ label: textOf(caption), field: name, input, expandLabel: t`Expand the editor` })
            : createEntryRow({ label: textOf(caption), field: name, input, floating: true });
        moveCaption(row.row.querySelector('.ds-row-label'), caption, { keepSource: true });
        fieldRows.push(row);
    }
    const scriptGroup = createPrefGroup({ field: 'regex-script', rows: fieldRows });
    fields.replaceWith(scriptGroup.section);

    // The test fields, which the Test Mode button shows and hides by the class `displayNone`.
    const test = needed(root, '#regex_test_mode');
    const testRows = [];
    for (const block of test.querySelectorAll(':scope > .flex1')) {
        const input = block.querySelector('textarea');
        const caption = block.querySelector('label > small');
        if (!input || !caption) throw new TypeError('A regex test field needs its textarea and caption.');
        const row = createTextAreaField({ label: textOf(caption), field: input.id, input, expandLabel: t`Expand the editor` });
        moveCaption(row.row.querySelector('.ds-row-label'), caption, { keepSource: true });
        testRows.push(row);
    }
    test.replaceChildren(...testRows.map(row => row.row));
    test.classList.remove('flex1', 'flex-container');
    test.classList.add('ds-pref-group');

    // What the script affects: a pick-several list of places, and the depth range.
    const [affects, other] = [...root.querySelectorAll('.regex_editor > .flex-container > .wi-enter-footer-text')];
    if (!affects || !other) throw new TypeError('The regex editor template is missing its option columns.');
    const placeRows = [...affects.querySelectorAll('input[name="replace_position"]')].map(input => {
        const label = input.closest('label');
        const caption = label.querySelector('span');
        const row = createCheckRow({ label: textOf(caption), subtitle: label.parentElement.title || undefined, field: `replace-position-${input.value}`, input });
        moveCaption(row.row.querySelector('.ds-row-label'), caption, { keepSource: true });
        label.parentElement.remove();
        return row;
    });
    const depthRows = [...affects.querySelectorAll('input[type="number"]')].map(input => {
        const caption = input.parentElement.querySelector('small');
        const row = createSpinRow({ label: textOf(caption), subtitle: caption.title || undefined, field: input.name, input, normalize: false });
        moveCaption(row.row.querySelector('.ds-row-label'), caption.querySelector('[data-i18n]'), { keepSource: true });
        return row;
    });
    const affectsGroup = titled(createPrefGroup({ title: textOf(affects.querySelector(':scope > small')), field: 'regex-affects', rows: [...placeRows, ...depthRows] }), affects.querySelector(':scope > small'));

    // The options: two switches and the macro mode, then the ephemerality pair.
    const switchRow = label => {
        const input = label.querySelector('input[type="checkbox"]');
        const caption = label.querySelector('span');
        const row = createSwitchRow({ label: textOf(caption), subtitle: label.title || undefined, field: input.name, input });
        moveCaption(row.row.querySelector('.ds-row-label'), caption, { keepSource: true });
        return row;
    };
    const optionLabels = [...other.querySelectorAll(':scope > label.checkbox')];
    const labelOf = name => {
        const label = optionLabels.find(candidate => candidate.querySelector(`[name="${name}"]`));
        if (!label) throw new TypeError(`The regex editor template is missing the ${name} option.`);
        return label;
    };
    const onOff = ['disabled', 'run_on_edit'].map(labelOf);
    const substitute = labelOf('substitute_regex');
    const ephemeral = ['only_format_display', 'only_format_prompt'].map(labelOf);
    const select = substitute.querySelector('select');
    const macroCaption = substitute.querySelector('small');
    const macroRow = createSelectRow({ select, label: textOf(macroCaption), subtitle: substitute.title || undefined, field: select.name, searchLabel: t`Search`, emptyText: t`No results` });
    moveCaption(macroRow.row.querySelector('.ds-row-label'), macroCaption.querySelector('[data-i18n]') ?? macroCaption, { keepSource: true });
    const optionsGroup = titled(createPrefGroup({ title: textOf(other.querySelector(':scope > small')), field: 'regex-options', rows: [...onOff.map(switchRow), macroRow] }), other.querySelector(':scope > small'));

    const ephemeralHeading = [...other.querySelectorAll(':scope > span')].find(span => span.querySelector('small'));
    const ephemeralCaption = ephemeralHeading?.querySelector('small');
    const ephemeralGroup = titled(createPrefGroup({
        title: textOf(ephemeralCaption),
        subtitle: ephemeralHeading?.querySelector('[title]')?.getAttribute('title') || undefined,
        field: 'regex-ephemerality',
        rows: ephemeral.map(switchRow),
    }), ephemeralCaption);

    // The two columns held the groups' sources; the sections replace them in the body's order.
    affects.closest('.regex_editor > .flex-container').replaceWith(affectsGroup.section, optionsGroup.section, ephemeralGroup.section);

    // The dividers the template drew are replaced by the spacing between the groups.
    for (const rule of root.querySelectorAll('.regex_editor > hr')) rule.hidden = true;

    // The extension reads the fields after the editor has closed, so the rows are not destroyed: that would take the controls out of the template. Only the ids they reserved are given back.
    return {
        options: {
            onClose() {
                releaseRowIds(root);
            },
        },
    };
}
