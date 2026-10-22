import { t } from '../../i18n.js';
import { createComboRow, createEntryRow, createPrefGroup, releaseRowIds } from '../rows.js';

function asElement(source) {
    const root = source?.jquery ? source.get(0) : source;
    if (root instanceof HTMLElement) return root;
    throw new TypeError('A window content adapter needs an HTML element.');
}

function textOf(node) {
    return node?.textContent.replace(/\s+/g, ' ').trim() ?? '';
}

function moveCaption(target, source) {
    if (!source) return;
    if (source.dataset.i18n) target.dataset.i18n = source.dataset.i18n;
    target.replaceChildren(...source.childNodes);
    source.remove();
}

function windowOptions(root, options = {}) {
    return {
        tier: 'window',
        ...options,
        onClose(popup) {
            options.onClose?.(popup);
            releaseRowIds(root);
        },
    };
}

/** Keep the source account heading as the Window title and all live profile controls in place. */
export function accountProfileOptions(source) {
    const root = asElement(source);
    const heading = root.querySelector('h3[data-i18n="Account Info"]');
    if (!heading) throw new TypeError('The account profile needs its source heading.');
    root.prepend(heading);
    root.classList.add('sb-dialog-rows');
    return windowOptions(root);
}

/** Put the source snapshot action in the scrolling body and keep the generated list live. */
export function snapshotsOptions(source) {
    const root = asElement(source);
    const heading = root.querySelector(':scope > h3');
    const action = heading?.querySelector('.makeSnapshotButton');
    const list = root.querySelector('.snapshotList');
    if (!heading || !action || !list) {
        throw new TypeError('The snapshots view needs its heading, action, and list.');
    }

    heading.after(action);
    heading.remove();
    root.classList.add('sb-dialog-rows', 'sb-window-snapshots');
    const decorateSnapshots = () => list.querySelectorAll('.snapshot').forEach(snapshot => snapshot.classList.add('ds-pref-group', 'sb-window-snapshot'));
    const observer = new MutationObserver(decorateSnapshots);
    observer.observe(list, { childList: true });
    decorateSnapshots();
    return windowOptions(root, {
        title: t`Settings Snapshots`,
        onClose() { observer.disconnect(); },
    });
}

function createUserField(fieldContainer) {
    const input = fieldContainer.querySelector('input[name]');
    const caption = [...fieldContainer.children].find(node => node.matches('span:not(.warning)'));
    const requiredMarker = [...fieldContainer.children].find(node => node.matches('span.warning'));
    if (!(input instanceof HTMLInputElement) || !caption) {
        throw new TypeError('The admin user form needs four captioned inputs.');
    }

    const row = createEntryRow({ label: textOf(caption), field: input.name, input });
    moveCaption(row.row.querySelector('.ds-row-label'), caption);
    if (requiredMarker) row.row.querySelector('.ds-row-label').append(requiredMarker);
    fieldContainer.replaceWith(row.row);
    return row;
}

function adaptNewUserForm(root) {
    const form = root.querySelector('.userCreateForm');
    if (!(form instanceof HTMLFormElement)) throw new TypeError('The admin view needs its new-user form.');
    const fields = [...form.querySelectorAll(':scope > .flex-container')]
        .filter(field => field.querySelector('input[name]'));
    if (fields.length !== 4) throw new TypeError('The admin new-user form must contain four inputs.');

    const rows = fields.map(createUserField);
    const group = createPrefGroup({ field: 'admin-new-user-fields', rows });
    const note = form.querySelector(':scope > span');
    const submit = form.querySelector(':scope > .justifyCenter');
    form.replaceChildren(...[group.section, note, submit].filter(Boolean));
    form.classList.add('sb-dialog-rows');
}

/** Present the account-management view as a Window and adopt the four live new-user inputs. */
export function adminPanelOptions(source) {
    const root = asElement(source);
    const title = root.querySelector('.manageUsersButton h4');
    if (!title) throw new TypeError('The admin view needs its source title.');
    adaptNewUserForm(root);
    root.classList.add('sb-dialog-rows');
    return windowOptions(root, { title: textOf(title) });
}

/** Adopt the three scenario textareas while preserving their maximize controls and source events. */
export function scenarioOverrideOptions(source) {
    const root = asElement(source);
    const textareas = ['chat_scenario_override', 'chat_examples_override', 'chat_system_prompt_override']
        .map(id => root.querySelector(`#${id}`));
    if (textareas.some(textarea => !(textarea instanceof HTMLTextAreaElement))) {
        throw new TypeError('The scenario override needs all three source textareas.');
    }

    const fieldsContainer = textareas[0].closest('.wide100p.flex-container.flexFlowColumn');
    if (!fieldsContainer) throw new TypeError('The scenario override needs its source fields container.');
    const rows = [];
    for (const textarea of textareas) {
        const field = textarea.parentElement;
        const heading = field?.previousElementSibling;
        if (!field || !heading?.matches('h4')) throw new TypeError('A scenario textarea needs its source heading.');
        const row = createEntryRow({ label: '', field: textarea.id, input: textarea });
        row.row.classList.add('ds-row--stacked', 'sb-window-stacked-textarea');
        moveCaption(row.row.querySelector('.ds-row-label'), heading);
        field.replaceWith(row.row);
        rows.push(row);
    }

    fieldsContainer.replaceChildren(createPrefGroup({ field: 'scenario-overrides', rows }).section);
    root.classList.add('sb-dialog-rows');
    return windowOptions(root);
}

function createYamlRow(textarea) {
    const field = textarea.parentElement;
    const heading = field?.querySelector(':scope > h4');
    if (!field || !heading) throw new TypeError('A YAML textarea needs its source heading.');
    const row = createEntryRow({ label: textOf(heading), field: textarea.id, input: textarea });
    row.row.classList.add('ds-row--stacked', 'sb-window-stacked-textarea');
    moveCaption(row.row.querySelector('.ds-row-label'), heading);
    field.replaceWith(row.row);
    return row;
}

function createLabeledInputRow(input, label) {
    if (!(input instanceof HTMLInputElement) || !label) throw new TypeError('A reasoning parameter needs its source input and label.');
    const field = label.parentElement;
    if (!field) throw new TypeError('A reasoning input needs its source field.');
    const row = createEntryRow({ label: textOf(label), field: input.id, input });
    moveCaption(row.row.querySelector('.ds-row-label'), label);
    field.replaceWith(row.row);
    return row;
}

function createLabeledSelectRow(select, label) {
    if (!(select instanceof HTMLSelectElement) || !label) throw new TypeError('A reasoning preset needs its source select and label.');
    const row = createComboRow({ label: textOf(label), field: select.id, select });
    moveCaption(row.row.querySelector('.ds-row-label'), label.querySelector('span') ?? label);
    label.replaceWith(row.row);
    return row;
}

/** Adopt the YAML textareas and native reasoning controls without changing their event semantics. */
export function customEndpointParametersOptions(source) {
    const root = asElement(source);
    const yamlRows = ['custom_include_body', 'custom_exclude_body', 'custom_include_headers']
        .map(id => root.querySelector(`#${id}`));
    const preset = root.querySelector('#custom_reasoning_preset');
    const format = root.querySelector('#custom_reasoning_param_format');
    const parameterName = root.querySelector('#custom_reasoning_param_name');
    const enabledValue = root.querySelector('#custom_reasoning_enabled_value');
    const disabledValue = root.querySelector('#custom_reasoning_disabled_value');
    const reasonSection = preset?.closest('.flex1');
    const reasonHeading = reasonSection?.querySelector(':scope > h4');
    const values = root.querySelector('.sb-custom-reasoning-toggle-values');
    const note = reasonSection?.querySelector(':scope > small');
    if (yamlRows.some(textarea => !(textarea instanceof HTMLTextAreaElement))
        || !(preset instanceof HTMLSelectElement)
        || !(format instanceof HTMLSelectElement)
        || !(parameterName instanceof HTMLInputElement)
        || !(enabledValue instanceof HTMLInputElement)
        || !(disabledValue instanceof HTMLInputElement)
        || !reasonHeading
        || !values) {
        throw new TypeError('The custom endpoint parameters template is incomplete.');
    }

    const bodyRows = yamlRows.map(createYamlRow);
    const presetLabel = preset.closest('label');
    const formatLabel = format.closest('label');
    const nameLabel = parameterName.closest('label');
    const reasoningRows = [
        createLabeledSelectRow(preset, presetLabel),
        createLabeledSelectRow(format, formatLabel),
        createLabeledInputRow(parameterName, nameLabel?.querySelector('span')),
    ];
    const valueRows = [
        createLabeledInputRow(enabledValue, enabledValue.closest('label')?.querySelector('span')),
        createLabeledInputRow(disabledValue, disabledValue.closest('label')?.querySelector('span')),
    ];
    values.replaceChildren(...valueRows.map(row => row.row));
    values.classList.remove('flex-container', 'flexFlowColumn');
    values.classList.add('sb-dialog-rows');

    const bodyGroup = createPrefGroup({ field: 'custom-endpoint-yaml', rows: bodyRows });
    const reasoningGroup = createPrefGroup({ title: textOf(reasonHeading), field: 'custom-endpoint-reasoning', rows: reasoningRows });
    moveCaption(reasoningGroup.section.querySelector('.ds-pref-group-heading'), reasonHeading);
    reasoningGroup.section.append(...[values, note].filter(Boolean));

    const title = root.querySelector(':scope > h3');
    root.classList.add('sb-dialog-rows');
    root.replaceChildren(...[title, bodyGroup.section, reasoningGroup.section].filter(Boolean));
    return windowOptions(root);
}
