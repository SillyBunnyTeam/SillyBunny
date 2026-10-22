import { t } from '../../../i18n.js';
import { createEntryRow, createRow, createSpinRow, createSwitchRow, releaseRowIds } from '../../../sillybunny-editor/rows.js';
import { createSelectRow } from '../../../sillybunny-editor/select-row.js';

function textOf(node) {
    return node?.textContent.replace(/\s+/g, ' ').trim() ?? '';
}

function adoptCaption(row, caption, hint) {
    const target = row.row.querySelector('.ds-row-label');
    if (caption) {
        target.replaceChildren(caption);
    }
    const description = row.row.querySelector('.ds-row-subtitle');
    if (hint && description) description.replaceChildren(hint);
}

function requireSource(root, selector, ElementType = HTMLElement) {
    const source = root.querySelector(selector);
    if (!(source instanceof ElementType)) throw new TypeError(`The Quick Reply editor template is missing ${selector}.`);
    return source;
}

/** Keep the source label as well as its native click listeners and translated child nodes. */
function adoptSwitch(label) {
    const input = label.querySelector('input[type="checkbox"]');
    if (!input) throw new TypeError('A Quick Reply switch needs its source checkbox.');
    const caption = [...label.childNodes].filter(node => node !== input);
    const row = createSwitchRow({ label: textOf(label), subtitle: label.title, field: input.id || input.className, input });
    row.row.querySelector('.ds-row-label').replaceChildren(...caption);
    label.classList.add(...row.row.classList);
    label.htmlFor = input.id;
    label.replaceChildren(...row.row.childNodes);
    return label;
}

/** Adapt only presentation; QuickReply retains every update, execution and Popup callback. */
export function adaptQuickReplyEditor(root) {
    if (!(root instanceof HTMLElement) || !root.matches('#qr--modalEditor')) {
        throw new TypeError('The Quick Reply editor needs its source template.');
    }
    const selects = [];
    const labels = requireSource(root, '.qr--labels');
    const icon = requireSource(root, '#qr--modal-icon');
    const iconCaption = icon.parentElement.querySelector('.qr--labelText');
    const iconRow = createRow({ label: textOf(iconCaption), field: icon.id, suffix: icon });
    adoptCaption(iconRow, iconCaption);

    const label = requireSource(root, '#qr--modal-label', HTMLInputElement);
    const labelContainer = label.closest('.label');
    const labelRow = createEntryRow({ label: textOf(labelContainer.querySelector('.qr--labelText')), subtitle: textOf(labelContainer.querySelector('.qr--labelHint')), field: label.id, input: label });
    adoptCaption(labelRow, labelContainer.querySelector('.qr--labelText'), labelContainer.querySelector('.qr--labelHint'));
    labelRow.row.classList.add('label');
    // The switcher appends its live list to the label input's parent.
    const inputGroup = labelContainer.querySelector('.qr--inputGroup');
    const showLabel = adoptSwitch(inputGroup.querySelector('.checkbox_label'));
    inputGroup.prepend(label);
    labelRow.row.querySelector('.ds-row-text').append(inputGroup);

    const title = requireSource(root, '#qr--modal-title', HTMLInputElement);
    const titleContainer = title.parentElement;
    const titleRow = createEntryRow({ label: textOf(titleContainer.querySelector('.qr--labelText')), subtitle: textOf(titleContainer.querySelector('.qr--labelHint')), field: title.id, input: title });
    adoptCaption(titleRow, titleContainer.querySelector('.qr--labelText'), titleContainer.querySelector('.qr--labelHint'));
    labels.classList.add('ds-pref-group');
    labels.replaceChildren(iconRow.row, labelRow.row, showLabel, titleRow.row);

    const settings = requireSource(root, '.qr--modal-editorSettings');
    settings.classList.add('ds-pref-group');
    for (const source of [...settings.querySelectorAll('.checkbox_label')]) {
        const input = source.querySelector('input');
        if (input.type === 'checkbox') {
            adoptSwitch(source);
            continue;
        }
        const caption = source.querySelector('span');
        const row = createSpinRow({ label: textOf(caption), field: input.id, input, normalize: false });
        adoptCaption(row, caption);
        source.replaceWith(row.row);
    }

    const automation = requireSource(root, '#qr--autoExec');
    automation.classList.add('ds-pref-group');
    automation.querySelectorAll('.checkbox_label').forEach(adoptSwitch);
    const automationId = requireSource(automation, '#qr--automationId', HTMLInputElement);
    const automationContainer = automationId.parentElement;
    const automationCaption = automationContainer.querySelector('small');
    const automationRow = createEntryRow({ label: textOf(automationCaption), subtitle: automationContainer.title, field: automationId.id, input: automationId });
    adoptCaption(automationRow, automationCaption);
    automationContainer.replaceWith(automationRow.row);

    // Shrinking after a scrolled debug view must not strand Maximize above the viewport.
    root.querySelector('#qr--modal-minimize').addEventListener('click', () => {
        requestAnimationFrame(() => root.closest('.popup-content')?.scrollTo({ top: 0, behavior: 'instant' }));
    });

    return {
        options: {
            tier: 'window',
            title: t`Quick Reply`,
            onClose() {
                for (const row of selects) {
                    row.row.replaceWith(row.control);
                    row.destroy();
                }
                releaseRowIds(root);
            },
        },
        adoptContextItem(item) {
            const select = item.querySelector('select.qr--set');
            if (!(select instanceof HTMLSelectElement)) throw new TypeError('A Quick Reply context row needs its source set select.');
            const row = createSelectRow({ select, label: t`Quick Reply Set`, field: 'quick-reply-context-set', searchLabel: t`Search`, emptyText: t`No results` });
            const chainedLabel = item.querySelector('.qr--isChainedLabel');
            if (!(chainedLabel instanceof HTMLLabelElement)) throw new TypeError('A Quick Reply context row needs its chain switch.');
            item.insertBefore(row.row, chainedLabel);
            selects.push(row);
            adoptSwitch(chainedLabel);
        },
    };
}
