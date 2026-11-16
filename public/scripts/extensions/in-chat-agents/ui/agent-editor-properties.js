import { t } from '../../../i18n.js';
import { createSegmentedControl, setSegmentedControlValue } from '../../../sillybunny-segmented-control.js';
import { openActionMenu } from '../../../sillybunny-action-menu.js';
import { openDialog } from '../../../sillybunny-editor/dialog.js';
import { nameByValue, setSummaryText } from '../../../sillybunny-editor/chrome.js';

let nextId = 0;
const element = (tag, className = '', text = '') => Object.assign(document.createElement(tag), {
    className,
    textContent: text,
});

// The property bar reuses the prompt editor's bar and sheet classes: both are the same strip of labelled controls.
export function createAgentEditorProperties({ categories, onChange, preparePopup = () => {} }) {
    const propertyId = ++nextId;
    const frame = element('div', 'sb-prompt-editor ica-agent-property-frame');
    const summary = element('button', 'menu_button sb-prompt-property-summary ica-agent-property-summary');
    summary.type = 'button';
    summary.setAttribute('aria-haspopup', 'dialog');
    summary.setAttribute('aria-expanded', 'false');
    const bar = element('div', 'sb-prompt-properties ica-agent-properties');
    const property = (path, label, control) => {
        // A switch property is one label: a press on its text or beside the switch toggles it, so the property is the target.
        const node = element(control.matches('input.sb-switch') ? 'label' : 'div', 'sb-prompt-property');
        node.dataset.sbEditorField = path;
        node.append(element('span', '', label), control);
        bar.append(node);
        return node;
    };
    const categoryOptions = new Map(categories);
    let currentCategory;
    let propertyDialog = null;
    const category = element('button', 'menu_button sb-prompt-dropdown');
    category.type = 'button';
    category.setAttribute('aria-label', t`Category`);
    category.setAttribute('aria-haspopup', 'menu');
    category.setAttribute('aria-expanded', 'false');
    const categoryLabel = element('span');
    const categoryChevron = element('i', 'fa-solid fa-chevron-down');
    categoryChevron.setAttribute('aria-hidden', 'true');
    category.append(categoryLabel, categoryChevron);
    const openCategoryMenu = keyboard => {
        preparePopup(category);
        openActionMenu({
            trigger: category,
            title: t`Category`,
            keyboard,
            sections: [{
                items: [...categoryOptions].map(([value, label]) => ({
                    label,
                    kind: 'radio',
                    checked: value === currentCategory,
                    onSelect: () => {
                        if (value !== currentCategory) onChange('category', value);
                    },
                })),
            }],
        });
    };
    category.addEventListener('click', event => {
        event.stopPropagation();
        openCategoryMenu(false);
    });
    category.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault();
        openCategoryMenu(true);
    });
    property('category', t`Category`, category);
    const stages = [['pre', t`Before`], ['post', t`After`], ['both', t`Both`]];
    const executions = [['inline', t`Inline`], ['companion', t`Companion`]];
    const segmented = (label, choices, path) => createSegmentedControl(
        label,
        choices,
        choices[0][0],
        value => onChange(path, value),
        { detachFromForm: true },
    );
    const stage = segmented(t`Stage`, stages, 'phase');
    const stageProperty = property('phase', t`Stage`, stage);
    const execution = segmented(t`Execution`, executions, 'execution');
    property('execution', t`Execution`, execution);
    const pin = element('input', 'sb-switch');
    pin.type = 'checkbox';
    pin.setAttribute('role', 'switch');
    pin.setAttribute('aria-label', t`Pin`);
    pin.addEventListener('change', () => onChange('favorite', pin.checked));
    property('favorite', t`Pin`, pin);
    frame.append(summary, bar);

    function openProperties() {
        if (propertyDialog?.isOpen) {
            propertyDialog.close('close');
            return;
        }
        preparePopup(summary);
        summary.setAttribute('aria-expanded', 'true');
        const heading = element('h2', '', t`Agent properties`);
        heading.id = `ica-agent-properties-title-${propertyId}`;
        heading.tabIndex = -1;
        const content = document.createDocumentFragment();
        content.append(heading, bar);
        const dialog = openDialog({
            tier: 'dialog',
            title: heading.textContent,
            content,
            className: 'sb-prompt-properties-dialog ica-agent-properties-dialog',
            initialFocus: () => heading,
        });
        dialog.header.querySelector('.sb-dialog__title')?.replaceWith(heading);
        heading.classList.add('sb-dialog__title');
        const closeButton = dialog.header.querySelector('.sb-dialog__close');
        closeButton?.setAttribute('aria-label', t`Close agent properties`);
        closeButton?.setAttribute('title', t`Close agent properties`);
        dialog.root.setAttribute('aria-labelledby', heading.id);
        propertyDialog = dialog;
        dialog.closed.then(() => {
            if (propertyDialog !== dialog) return;
            propertyDialog = null;
            frame.append(bar);
            summary.setAttribute('aria-expanded', 'false');
        });
    }
    summary.addEventListener('click', openProperties);

    return {
        element: frame,
        render(fields, visibility) {
            if (!categoryOptions.has(fields.category)) categoryOptions.set(fields.category, fields.category);
            currentCategory = fields.category;
            categoryLabel.textContent = categoryOptions.get(fields.category);
            nameByValue(category, t`Category`, categoryLabel.textContent);
            setSegmentedControlValue(stage, fields.phase);
            setSegmentedControlValue(execution, fields.execution);
            stageProperty.hidden = visibility.fields.phase === false;
            const locked = Boolean(visibility.disabled.execution);
            execution.setAttribute('aria-disabled', String(locked));
            for (const input of execution.querySelectorAll('input')) input.disabled = locked;
            pin.checked = Boolean(fields.favorite);
            const labels = [categoryLabel.textContent];
            if (!stageProperty.hidden) labels.push(stages.find(([value]) => value === fields.phase)?.[1] ?? fields.phase);
            labels.push(executions.find(([value]) => value === fields.execution)?.[1] ?? fields.execution);
            setSummaryText(summary, t`Agent properties`, labels.join(' · '));
        },
        destroy() {
            propertyDialog?.forceClose();
            propertyDialog = null;
            frame.remove();
        },
    };
}
