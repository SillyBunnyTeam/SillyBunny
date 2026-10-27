import { t } from '../../i18n.js';
import { createEntryRow, createPrefGroup, createSpinRow, moveCaption, releaseRowIds } from '../rows.js';
import { createSelectRow } from '../select-row.js';
import { createToggleRow } from '../toggle-row.js';

function asElement(root) {
    const element = root?.jquery ? root.get(0) : root;
    if (element instanceof HTMLElement) return element;
    throw new TypeError('A dialog adapter needs an HTML element.');
}

function textOf(node) {
    return node?.textContent.replace(/\s+/g, ' ').trim() ?? '';
}

function segmentedRow(labels, field, label) {
    const inputs = labels.map(label => label.querySelector('input[type="radio"]'));
    if (inputs.some(input => !input)) throw new TypeError('A segmented dialog needs radio inputs.');
    const choices = labels.map((label, index) => [String(index), textOf(label)]);
    const selected = inputs.findIndex(input => input.checked);
    const row = createToggleRow({
        label,
        field,
        choices,
        value: String(Math.max(selected, 0)),
        inputs,
        fill: true,
    });
    const targetLabels = [...row.group.querySelectorAll('.sb-boolean-radio-option > span')];
    labels.forEach((label, index) => {
        targetLabels[index].replaceChildren(...[...label.childNodes].filter(node => node !== inputs[index]));
    });
    return row;
}

function dialogCleanup(root, options = {}) {
    return {
        tier: 'dialog',
        ...options,
        onClose(popup) {
            options.onClose?.(popup);
            releaseRowIds(root);
        },
    };
}

function disposeSelectRow(row) {
    if (!row) return;
    // Callers may read the source select after Popup resolves; destroy observers, not their value.
    row.row.replaceWith(row.control);
    row.destroy();
}

/** Adopt the template's radio inputs so existing ids, names, values and listeners survive. */
export function creatorStylesPreferenceOptions(source) {
    const root = asElement(source);
    const heading = root.querySelector('h3');
    const warning = root.querySelector('h4');
    const labels = [...root.querySelectorAll('.sb-boolean-radio-group > label')];
    const row = segmentedRow(labels, 'creator-styles-preference', textOf(heading));
    moveCaption(row.row.querySelector('.ds-row-label'), heading, { copyId: true });
    row.group.setAttribute('aria-labelledby', row.row.querySelector('.ds-row-label').id);
    root.className = 'sb-dialog-rows';
    root.replaceChildren(...[warning, createPrefGroup({ field: 'creator-styles', rows: [row] }).section].filter(Boolean));
    return dialogCleanup(root, { title: t`Creator's Notes` });
}

/** The dynamic global-state captions stay attached to the adopted radio labels. */
export function externalMediaOptions(source) {
    const root = asElement(source);
    const heading = root.querySelector('h4');
    const subtitle = root.querySelector('small');
    const labels = [...root.querySelectorAll(':scope > label.checkbox_label')];
    const row = segmentedRow(labels, 'external-media-override', textOf(heading));
    moveCaption(row.row.querySelector('.ds-row-label'), heading, { copyId: true });
    const group = createPrefGroup({ field: 'external-media', rows: [row] });
    root.className = 'forbid_media_override sb-dialog-rows';
    root.replaceChildren(...[subtitle, group.section].filter(Boolean));
    return dialogCleanup(root, { title: t`External Media` });
}

function customCssRadioLabels(root) {
    return [...root.querySelectorAll('input[name="custom_css_ai_apply_mode"]')]
        .map(input => input.closest('label'))
        .filter(Boolean);
}

export function customCssAiOptions(source) {
    const root = asElement(source);
    const heading = root.querySelector('h3');
    const instruction = root.querySelector('#custom_css_ai_instruction');
    const profile = root.querySelector('#custom_css_ai_profile');
    const instructionCaption = root.querySelector('label[for="custom_css_ai_instruction"]');
    const profileCaption = root.querySelector('label[for="custom_css_ai_profile"]');
    const applyLabels = customCssRadioLabels(root);
    if (!(instruction instanceof HTMLTextAreaElement) || !(profile instanceof HTMLSelectElement) || applyLabels.length !== 2) {
        throw new TypeError('The Custom CSS AI dialog template is incomplete.');
    }

    const instructionRow = createEntryRow({
        label: textOf(instructionCaption),
        field: instruction.id,
        input: instruction,
    });
    instructionRow.row.classList.add('ds-row--stacked');
    const profileRow = createSelectRow({
        select: profile,
        label: textOf(profileCaption),
        field: profile.id,
        title: textOf(profileCaption),
        searchLabel: t`Search`,
        emptyText: t`No results`,
    });
    const applyRow = segmentedRow(applyLabels, 'custom-css-ai-apply-mode', t`Apply`);
    const notes = [...root.querySelectorAll(':scope > small')];
    moveCaption(instructionRow.row.querySelector('.ds-row-label'), instructionCaption, { copyId: true });
    moveCaption(profileRow.row.querySelector('.ds-row-label'), profileCaption, { copyId: true });
    root.className = 'sb-dialog-rows';
    root.replaceChildren(
        ...[heading, createPrefGroup({ field: 'custom-css-ai-fields', rows: [instructionRow, profileRow, applyRow] }).section, ...notes].filter(Boolean),
    );
    return dialogCleanup(root, {
        onClose() { disposeSelectRow(profileRow); },
    });
}

/** Convert Popup custom text inputs to spin rows without adding range clamping. */
export function messageScreenshotOptions({ startId, endId }) {
    return {
        tier: 'dialog',
        title: t`Screenshot messages`,
        onOpen(popup) {
            const labels = [...popup.inputControls.querySelectorAll(':scope > label.text_label')];
            const rows = labels.map(label => {
                const input = label.querySelector('input');
                if (!input || ![startId, endId].includes(input.id)) return null;
                const row = createSpinRow({ label: textOf(label.querySelector('span')), subtitle: input.title, field: input.id, input, normalize: false });
                moveCaption(row.row.querySelector('.ds-row-label'), label.querySelector('span'), { copyId: true });
                return row;
            }).filter(Boolean);
            popup.content.append(createPrefGroup({ field: 'message-screenshot-range', rows }).section);
            popup.inputControls.replaceChildren();
            popup.inputControls.style.display = 'none';
            rows[0]?.control.focus({ preventScroll: true });
        },
        onClose(popup) {
            releaseRowIds(popup.content);
        },
    };
}

export function installExtensionOptions(source) {
    const root = asElement(source);
    root.querySelectorAll(':scope > br').forEach(node => node.remove());
    return dialogCleanup(root, {
        onOpen(popup) {
            const branchInput = popup.inputControls.querySelector('#extension_branch_name');
            const branchLabel = branchInput?.closest('label');
            const urlRow = createEntryRow({
                label: t`Enter the Git URL of the extension to install`,
                field: 'extension-url',
                input: popup.mainInput,
            });
            const rows = [urlRow];
            if (branchInput) {
                rows.push(createEntryRow({
                    label: textOf(branchLabel?.querySelector('span')),
                    field: branchInput.id,
                    input: branchInput,
                }));
                moveCaption(rows[1].row.querySelector('.ds-row-label'), branchLabel.querySelector('span'), { copyId: true });
            }
            popup.inputControls.replaceChildren();
            popup.inputControls.style.display = 'none';
            root.classList.add('sb-dialog-rows');
            root.append(createPrefGroup({ field: 'extension-install-fields', rows }).section);
            popup.mainInput.focus({ preventScroll: true });
        },
    });
}

export function switchBranchOptions(select) {
    if (!(select instanceof HTMLSelectElement)) throw new TypeError('A branch dialog needs a select.');
    let row;
    return dialogCleanup(select, {
        title: t`Switch branch`,
        onOpen(popup) {
            row = createSelectRow({
                select,
                label: t`Switch branch`,
                field: 'extension-branch',
                title: t`Switch branch`,
                searchLabel: t`Search`,
                emptyText: t`No results`,
            });
            popup.content.replaceChildren(createPrefGroup({ field: 'extension-branch-selection', rows: [row] }).section);
        },
        onClose() { disposeSelectRow(row); },
    });
}

export function accountFormOptions(source, { title = null, destructive = false } = {}) {
    const root = asElement(source);
    const fields = [...root.querySelectorAll('input[type="password"], input[type="text"]')];
    for (const input of fields) {
        const container = input.closest('.currentPasswordBlock, .newPasswordBlock, .confirmPasswordBlock, .resetCodeBlock');
        const caption = container?.querySelector('label') ?? input.previousElementSibling;
        if (!caption) throw new TypeError('An account field needs its upstream caption.');
        const anchor = document.createComment('account entry row');
        input.before(anchor);
        const row = createEntryRow({ label: textOf(caption), field: input.name, input });
        moveCaption(row.row.querySelector('.ds-row-label'), caption, { copyId: true });
        const group = createPrefGroup({ field: `${input.name}-field`, rows: [row] });
        if (container) container.replaceChildren(group.section);
        else anchor.replaceWith(group.section);
    }
    root.classList.add('sb-dialog-rows');
    return dialogCleanup(root, {
        ...(title ? { title } : {}),
        onOpen(popup) {
            const switchRow = root.querySelector(':scope > .ds-row-switch');
            if (switchRow) {
                const group = createPrefGroup({ field: 'account-option' });
                switchRow.replaceWith(group.section);
                group.append(switchRow);
            }
            if (destructive) popup.okButton.classList.add('is-destructive');
        },
    });
}
