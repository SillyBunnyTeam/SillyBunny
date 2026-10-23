import { t } from '../../../i18n.js';
import { createSegmentedControl, setSegmentedControlValue } from '../../../sillybunny-segmented-control.js';
import { blockUpstreamDrawerClose, createSheetController } from '../../../sillybunny-sheet.js';
import { closeActionMenu } from '../../../sillybunny-action-menu.js';
import { MOTION_EASE_OUT_CUBIC, MOTION_FAST, MOTION_POPOVER_CLOSE, play, stopMotion } from '../../../sillybunny-motion.js';

let nextId = 0;
const element = (tag, className = '', text = '') => Object.assign(document.createElement(tag), {
    className,
    textContent: text,
});

export function createAgentEditorProperties({ categories, onChange, preparePopup = () => {} }) {
    const propertyId = ++nextId;
    const frame = element('div', 'sb-prompt-editor ica-agent-property-frame');
    const summary = element('button', 'menu_button sb-prompt-property-summary ica-agent-property-summary');
    summary.type = 'button';
    summary.setAttribute('aria-label', t`Agent properties`);
    summary.setAttribute('aria-haspopup', 'dialog');
    summary.setAttribute('aria-expanded', 'false');
    const bar = element('div', 'sb-prompt-properties ica-agent-properties');
    const property = (path, label, control) => {
        const node = element('div', 'sb-prompt-property');
        node.dataset.sbEditorField = path;
        node.append(element('span', '', label), control);
        bar.append(node);
        return node;
    };
    const categoryOptions = new Map(categories);
    let currentCategory;
    let categoryPopover = null;
    const closingCategoryPopovers = new Set();
    const category = element('button', 'menu_button sb-prompt-dropdown');
    category.type = 'button';
    category.setAttribute('aria-label', t`Category`);
    category.setAttribute('aria-haspopup', 'listbox');
    category.setAttribute('aria-expanded', 'false');
    const categoryLabel = element('span');
    const categoryChevron = element('i', 'fa-solid fa-chevron-down');
    categoryChevron.setAttribute('aria-hidden', 'true');
    category.append(categoryLabel, categoryChevron);
    const closeCategoryPopover = (animate = true, restoreFocus = false) => {
        if (!categoryPopover) return;
        const node = categoryPopover;
        categoryPopover = null;
        category.setAttribute('aria-expanded', 'false');
        node.inert = true;
        if (restoreFocus) category.focus({ preventScroll: true });
        if (!animate) {
            stopMotion(node);
            node.remove();
            return;
        }
        closingCategoryPopovers.add(node);
        play(node, [{ opacity: 1 }, { opacity: 0 }], {
            duration: MOTION_POPOVER_CLOSE,
            onFinish: () => {
                closingCategoryPopovers.delete(node);
                node.remove();
            },
        });
    };
    const removeClosingCategoryPopovers = () => {
        for (const node of closingCategoryPopovers) {
            stopMotion(node);
            node.remove();
        }
        closingCategoryPopovers.clear();
    };
    const openCategoryPopover = () => {
        if (categoryPopover) {
            closeCategoryPopover(true, true);
            return;
        }
        removeClosingCategoryPopovers();
        closeActionMenu({ animate: false, restoreFocus: false });
        // Prompt's Role listbox is private; mirror its markup, keyboard model and positioning locally.
        const node = element('div', 'sb-prompt-popover sb-prompt-role-list');
        node.setAttribute('role', 'listbox');
        node.setAttribute('aria-label', t`Category`);
        node.tabIndex = 0;
        const choices = [...categoryOptions];
        let activeIndex = Math.max(0, choices.findIndex(([value]) => value === currentCategory));
        const update = () => {
            options.forEach((option, index) => option.classList.toggle('is-active', index === activeIndex));
            node.setAttribute('aria-activedescendant', options[activeIndex].id);
        };
        const choose = index => {
            const [value] = choices[index];
            if (value !== currentCategory) onChange('category', value);
            closeCategoryPopover(true, true);
        };
        const options = choices.map(([value, label], index) => {
            const option = element('div', 'sb-prompt-option');
            option.id = `ica-agent-category-${propertyId}-${index}`;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(value === currentCategory));
            const check = element('i', 'fa-solid fa-check');
            check.setAttribute('aria-hidden', 'true');
            option.append(check, element('span', '', label));
            option.addEventListener('pointermove', () => { activeIndex = index; update(); });
            option.addEventListener('click', () => choose(index));
            return option;
        });
        node.append(...options);
        node.addEventListener('keydown', event => {
            if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) event.preventDefault();
            if (event.key === 'ArrowDown') activeIndex = (activeIndex + 1) % choices.length;
            if (event.key === 'ArrowUp') activeIndex = (activeIndex + choices.length - 1) % choices.length;
            if (event.key === 'Home') activeIndex = 0;
            if (event.key === 'End') activeIndex = choices.length - 1;
            if (event.key === 'Enter' || event.key === ' ') choose(activeIndex);
            if (event.key === 'Tab') closeCategoryPopover(true, true);
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeCategoryPopover(true, true);
            }
            update();
        });
        update();
        categoryPopover = node;
        category.setAttribute('aria-expanded', 'true');
        document.body.append(node);
        blockUpstreamDrawerClose(node);
        const rect = category.getBoundingClientRect();
        const width = Math.min(Math.max(208, rect.width), innerWidth - 16);
        node.style.width = `${width}px`;
        node.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
        node.style.top = `${innerHeight - rect.bottom > node.offsetHeight + 14
            ? rect.bottom + 6 : Math.max(8, rect.top - node.offsetHeight - 6)}px`;
        play(node, [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], {
            duration: MOTION_FAST,
            easing: MOTION_EASE_OUT_CUBIC,
        });
        node.focus({ preventScroll: true });
    };
    category.addEventListener('click', event => {
        event.stopPropagation();
        preparePopup(category);
        openCategoryPopover();
    });
    category.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault();
        category.click();
    });
    const dismissCategoryPopover = event => {
        if (categoryPopover && !categoryPopover.contains(event.target) && !category.contains(event.target)) {
            closeCategoryPopover();
        }
    };
    document.addEventListener('pointerdown', dismissCategoryPopover);
    property('category', t`Category`, category);
    const stages = [['pre', t`Before`], ['post', t`After`], ['both', t`Both`]];
    const executions = [['inline', t`Inline`], ['companion', t`Companion`]];
    const segmented = (label, choices, path) => createSegmentedControl(
        label,
        choices,
        choices[0][0],
        value => onChange(path, value),
        { compact: false, detachFromForm: true },
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

    const sheet = element('div', 'sb-prompt-sheet ica-agent-property-sheet');
    sheet.hidden = true;
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    const heading = element('h2', '', t`Agent properties`);
    heading.id = `ica-agent-properties-title-${propertyId}`;
    heading.tabIndex = -1;
    sheet.setAttribute('aria-labelledby', heading.id);
    const sheetHeader = element('header', 'sb-prompt-sheet-header');
    const close = element('button', 'menu_button menu_button_icon');
    close.type = 'button';
    close.setAttribute('aria-label', t`Close agent properties`);
    close.title = t`Close agent properties`;
    const glyph = element('i', 'fa-solid fa-xmark');
    glyph.setAttribute('aria-hidden', 'true');
    close.append(glyph);
    sheetHeader.append(heading, close);
    sheet.append(sheetHeader);
    const scrim = element('button', 'sb-prompt-sheet-backdrop');
    scrim.type = 'button';
    scrim.hidden = true;
    scrim.tabIndex = -1;
    scrim.setAttribute('aria-label', t`Close agent properties`);
    const sheetController = createSheetController({
        sheet,
        backdrop: scrim,
        getInitialFocus: () => heading,
        getReturnFocus: () => summary,
        onClose: () => {
            closeCategoryPopover(false);
            frame.append(bar);
            summary.setAttribute('aria-expanded', 'false');
        },
    });
    close.addEventListener('click', () => sheetController.close());
    summary.addEventListener('click', () => {
        sheet.append(bar);
        document.body.append(scrim, sheet);
        summary.setAttribute('aria-expanded', 'true');
        sheetController.open();
    });

    return {
        element: frame,
        closePopover(except) {
            if (except === category) return;
            closeCategoryPopover(false);
            removeClosingCategoryPopovers();
        },
        render(fields, visibility) {
            if (!categoryOptions.has(fields.category)) categoryOptions.set(fields.category, fields.category);
            currentCategory = fields.category;
            categoryLabel.textContent = categoryOptions.get(fields.category);
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
            summary.textContent = `${labels.join(' · ')} ›`;
        },
        destroy() {
            closeCategoryPopover(false);
            removeClosingCategoryPopovers();
            document.removeEventListener('pointerdown', dismissCategoryPopover);
            sheetController.close({ animate: false, restoreFocus: false, force: true });
            sheet.remove();
            scrim.remove();
            frame.remove();
        },
    };
}
