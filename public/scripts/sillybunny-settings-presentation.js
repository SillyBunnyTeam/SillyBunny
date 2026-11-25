/**
 * SillyBunny settings presentation normalizer.
 *
 * Backend and Customize mix two kinds of markup:
 *
 * - Sections a SillyBunny panel or the settings order pass authors: `section.sb-settings-category`
 *   holding a two-line heading (a title and a description) above one boxed list. Messages, most of
 *   Appearance, and the Advanced Formatting categories are this shape and already read as
 *   libadwaita.
 * - Sections authored by upstream or by an extension: a bare `h3`/`h4`, or a heading nested in a
 *   baseline row, followed by loose `flex-container` rows with no pill around any of it. That is
 *   Connections, and pieces of Appearance and Interface, which is why those tabs read as flat text
 *   with settings spilling down the page.
 *
 * This pass brings the second shape up to the first: a bare heading becomes a two-line heading, gains
 * a description line if it has none, and the rows that belong to it are gathered into one
 * `.ds-pref-group` pill.
 *
 * Four rules keep the pass safe on markup it does not own:
 *
 * - A `form` is opaque. Upstream builds one per provider and fills it with `h4` field labels, so
 *   nothing inside a form is a section and nothing inside a form is touched. A detail page is the
 *   exception and has its own entry point: it holds one rendered provider form, and that form is
 *   the page's boxed list.
 * - A heading that follows another heading's rows is a field label, not a section. Upstream nests
 *   provider blocks inside a provider section, and the `h4`s in them name fields.
 * - A container that holds sections is not a row. Advanced Formatting is one heading above a drawer
 *   of sections, so its body is left alone and each section is normalized on its own turn.
 * - A panel that designs itself is not passed to this module at all. The sampling panel and the
 *   agents dashboard have layouts of their own, and the panels shown as sliding subpages
 *   build their own headers, so the caller skips them.
 *
 * Nothing is cloned and nothing moves between sections, so ids, listeners, jQuery data, and the
 * extension lookups that reach into these containers all keep working. The pass is idempotent: a
 * section it has normalized has a pill body and a description, so a second run finds nothing to do.
 */

import { formatSettingsMacroExamples } from './sillybunny-settings-macros.js';
import { t } from './i18n.js';
import { createEntryRow, createRow, createSpinRow, createTextAreaField, moveCaption } from './sillybunny-editor/rows.js';
import { createSelectRow } from './sillybunny-editor/select-row.js';
import { SB_SETTINGS_SECTION_ORDER } from './sillybunny-settings-content.js';

/**
 * Placeholder description, used where a section has no copy of its own.
 *
 * Every one of these needs human-written text. `data-sb-copy-placeholder` marks them so the
 * maintainers can find them, and the return value lists them per tab.
 */
const SB_PLACEHOLDER_DESCRIPTION = 'lorum ipsum';

const SB_CUSTOMIZE_TABS = new Set(['appearance', 'interface', 'messages', 'data-security', 'logs', 'console-logs']);

/**
 * @param {HTMLElement} row
 * @param {{placeholder?: boolean}} [options] `placeholder: false` returns null instead of copy that still needs writing
 * @returns {HTMLElement|null}
 */
function createRowSubtitle(row, { placeholder = true } = {}) {
    let existing = row.querySelector('.ds-row-subtitle, :scope > .toggle-description, label small + small');
    // An extension's label may carry its own note as a trailing `small` inside the title span (Quick Reply's "Inject user input"). A span that holds nothing else is a title, not a note.
    if (!existing && !placeholder) {
        const note = row.querySelector(':scope > span:not(.ds-row-text) > small:last-child');
        if (note && note.parentElement.textContent.trim() !== note.textContent.trim()) existing = note;
    }
    // These rows already own live help beside the label. Keep that node (and its dynamic
    // provider/preset updates) instead of promoting a redundant title or a status-icon tooltip.
    if (!existing && row.matches('label:is([for="bind_preset_to_connection"], [for="bind_preset_to_sampling"], [for="squash_system_messages"], [for="openai_function_calling"], [for="openai_media_inlining"])') && row.nextElementSibling?.matches('.toggle-description')) {
        existing = row.nextElementSibling;
    }
    if (existing instanceof HTMLElement && existing.textContent.trim()) {
        existing.classList.add('ds-row-subtitle');
        formatSettingsMacroExamples(existing);
        return existing;
    }

    const subtitle = document.createElement('small');
    subtitle.className = 'ds-row-subtitle';
    // The tooltip extension relocates title attributes before the settings panel opens.
    const tooltipSelector = ':is([title], [data-sttt--title]):not(input, select, button, a, .menu_button, [data-cc-toggle], [data-cc-toggle] *)';
    const source = (row.matches(tooltipSelector) ? row : row.querySelector(tooltipSelector))
        ?? row.querySelector('select[title], select[data-sttt--title], textarea[title], textarea[data-sttt--title]');
    const sourceText = (source?.getAttribute('title') || source?.getAttribute('data-sttt--title'))?.trim();
    if (!sourceText && !placeholder) return null;
    subtitle.textContent = sourceText || SB_PLACEHOLDER_DESCRIPTION;
    if (subtitle.textContent === SB_PLACEHOLDER_DESCRIPTION) {
        subtitle.dataset.sbCopyPlaceholder = 'true';
    } else {
        const key = source?.getAttribute('data-i18n')?.match(/(?:^|;)\[title\]([^;]+)/)?.[1];
        if (key) subtitle.dataset.i18n = key;
    }
    formatSettingsMacroExamples(subtitle);
    return subtitle;
}

/**
 * `classList.add`/`remove` queue a `class` mutation record even when nothing changes, and the
 * keyboard-interactable observer re-scans the subtree for every class record. These normalizers re-run
 * on every panel activation, so only touch tokens whose state actually differs.
 * @param {Element} element @param {...string} tokens
 */
function addMissingClasses(element, ...tokens) {
    const missing = tokens.filter(token => !element.classList.contains(token));
    if (missing.length) element.classList.add(...missing);
}

/** @param {Element} element @param {...string} tokens */
function removePresentClasses(element, ...tokens) {
    const present = tokens.filter(token => element.classList.contains(token));
    if (present.length) element.classList.remove(...present);
}

/**
 * `subtitles` is `false` for none, `true` for the tooltip or a copy placeholder, and `'titled'` for the tooltip only.
 * @param {HTMLLabelElement} label @param {{subtitles?: boolean|'titled'}} [options]
 */
function normalizeCustomizeSwitch(label, { subtitles = true } = {}) {
    const input = label.querySelector('input[type="checkbox"]');
    if (!(input instanceof HTMLInputElement)) return;

    addMissingClasses(input, 'sb-switch');
    if (input.getAttribute('role') !== 'switch') input.setAttribute('role', 'switch');
    // Native checked state also covers programmatic theme/settings updates without change events.
    input.removeAttribute('aria-checked');
    removePresentClasses(label, 'alignItemsBaseline', 'alignitemsflexstart', 'alignItemsFlexEnd', 'gap0', 'flexNoGap');
    if (label.classList.contains('ds-row')) return;

    const text = document.createElement('span');
    text.className = 'ds-row-text';
    const title = document.createElement('span');
    title.className = 'ds-row-label';
    if (input.id && !input.hasAttribute('aria-label') && !input.hasAttribute('aria-labelledby')) {
        title.id = `sb-setting-${input.id}-label`;
        input.setAttribute('aria-labelledby', title.id);
    }
    const subtitle = subtitles ? createRowSubtitle(label, { placeholder: subtitles !== 'titled' }) : null;
    for (const marker of label.querySelectorAll(':is(.fa-circle-info, .fa-info-circle):not(a *)')) marker.remove();
    const suffix = document.createElement('span');
    suffix.className = 'ds-row-suffix';
    for (const node of [...label.childNodes]) {
        if (node === input || node instanceof HTMLElement && node.matches('audio, [hidden]')) continue;
        title.appendChild(node);
    }
    text.append(title);
    if (subtitle) text.append(subtitle);
    suffix.appendChild(input);
    label.append(text, suffix);
    label.classList.add('ds-row', 'ds-row-switch');
    if (input.id) label.htmlFor = input.id;
}

/** @param {HTMLElement} scope */
function normalizeSwitchRowWrappers(scope) {
    for (const row of scope.querySelectorAll('.ds-row-switch')) {
        const group = row.closest('.ds-pref-group, .sb-sampling-control-card');
        if (!group || !scope.contains(group)) continue;
        if (group.matches('.sb-sampling-control-card')) addMissingClasses(group, 'sb-settings-row-wrapper');
        for (let wrapper = row.parentElement; wrapper && wrapper !== group; wrapper = wrapper.parentElement) {
            if (wrapper.matches('.ds-row, .ds-row-expander, .ds-row-expander-content')) break;
            addMissingClasses(wrapper, 'sb-settings-row-wrapper');
        }
    }
}

/** @param {HTMLElement} row @param {HTMLElement} control @param {{subtitles?: boolean|'titled'}} [options] */
function normalizeCustomizeField(row, control, { subtitles = true } = {}) {
    if (row.classList.contains('ds-row') || row.querySelector('.ds-row, .checkbox_label')) return;
    const title = row.querySelector(':scope > label, :scope > small, :scope > span, :scope > .range-block-title, :scope > h4');
    if (!(title instanceof HTMLElement)) return;

    const text = document.createElement('div');
    text.className = 'ds-row-text';
    const suffix = document.createElement('div');
    suffix.className = 'ds-row-suffix';
    const subtitle = subtitles ? createRowSubtitle(row, { placeholder: subtitles !== 'titled' }) : null;
    // The subtitle shows the tooltip copy, so the tooltip info markers go; actionable help links keep their handlers.
    for (const marker of title.querySelectorAll('.fa-circle-info, .fa-info-circle')) marker.remove();
    addMissingClasses(title, 'ds-row-label');
    removePresentClasses(title, 'displayNone');
    if (title instanceof HTMLLabelElement && control.id) title.htmlFor = control.id;
    text.append(title);
    if (subtitle) text.append(subtitle);
    if (!control.hasAttribute('aria-label') && !control.hasAttribute('aria-labelledby') && !(title instanceof HTMLLabelElement)) {
        if (!title.id && control.id) title.id = `sb-setting-${control.id}-label`;
        if (title.id) control.setAttribute('aria-labelledby', title.id);
    }
    const isSlider = control instanceof HTMLInputElement && control.type === 'range';
    if (!isSlider) control.classList.add('ds-control-flex');
    for (const node of [...row.children]) {
        if (node === title || node === subtitle || node.matches('script, style, [hidden]')) continue;
        suffix.appendChild(node);
    }
    row.classList.remove('flex-container', 'flexFlowColumn', 'flexBasis48p', 'flexGrow', 'flexShrink', 'flex1', 'wide100p', 'alignitemscenter', 'alignItemsCenter', 'alignItemsBaseline', 'gap0');
    row.classList.add('ds-row');
    if (isSlider) row.classList.add('ds-row-slider');
    row.append(text, suffix);
    for (const input of suffix.querySelectorAll('input, select, textarea')) {
        if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement)) continue;
        if (input.hasAttribute('aria-label') || input.hasAttribute('aria-labelledby') || input.labels?.length) continue;
        if (!title.id && control.id) title.id = `sb-setting-${control.id}-label`;
        if (title.id) input.setAttribute('aria-labelledby', title.id);
    }
}

const SB_ROW_FIELD_SELECTOR = 'select, input[type="range"], input[type="number"], input[type="text"], textarea';

/**
 * Normalize explicitly owned Backend controls without restructuring provider forms or prompt editors.
 *
 * `labels` and `controls` narrow which switch labels and field controls become rows, `subtitles` is
 * passed to the row builders (see `normalizeCustomizeSwitch`), and `skip` names areas a page lays out
 * itself.
 * @param {HTMLElement} scope
 * @param {{fields?: boolean, labels?: string, controls?: string, subtitles?: boolean|'titled', skip?: string}} [options]
 */
export function normalizeBackendSettingsRows(scope, { fields = true, labels = '.checkbox_label', controls = SB_ROW_FIELD_SELECTOR, subtitles = true, skip = '' } = {}) {
    if (!(scope instanceof HTMLElement)) return;
    for (const label of scope.querySelectorAll(labels)) {
        if (!(label instanceof HTMLLabelElement) || label.closest('#completion_prompt_manager') || (skip && label.closest(skip))) continue;
        const input = label.querySelector('input[type="checkbox"]');
        // Icon actions such as Banned Tokens use a hidden checkbox as state, not as a visible switch.
        if (input instanceof HTMLInputElement && input.style.display === 'none' && label.querySelector('.menu_button')) continue;
        normalizeCustomizeSwitch(label, { subtitles });
    }
    normalizeSwitchRowWrappers(scope);
    bindSettingsSwitchKeyboard(scope);
    if (!fields) return;
    const skipped = `.ds-row, #completion_prompt_manager, form, .sb-non-chat-preset-row${skip ? `, ${skip}` : ''}`;
    for (const control of scope.querySelectorAll(controls)) {
        if (!(control instanceof HTMLElement) || control.closest(skipped)) continue;
        let row = control.parentElement;
        for (let depth = 0; depth < 3 && row && !row.querySelector(':scope > label, :scope > small, :scope > span, :scope > .range-block-title, :scope > h4'); depth++) {
            if (!row.parentElement || row.parentElement.matches('.ds-pref-group, .sb-sampling-control-card')) break;
            row = row.parentElement;
        }
        if (!(row instanceof HTMLElement) || row.querySelectorAll('input[type="range"]').length > 1) continue;
        normalizeCustomizeField(row, control, { subtitles });
    }
    bindCustomizeSliderCounters(scope);
}

/** @param {HTMLElement} scope */
function bindSettingsSwitchKeyboard(scope) {
    if (scope.dataset.sbSwitchKeyboardBound === 'true') return;
    scope.dataset.sbSwitchKeyboardBound = 'true';
    scope.addEventListener('keydown', event => {
        const input = event.target;
        if (event.defaultPrevented || event.key !== 'Enter' || !(input instanceof HTMLInputElement) || input.getAttribute('role') !== 'switch') return;
        event.preventDefault();
        if (!event.repeat && !input.disabled) input.click();
    });
}

/** @param {HTMLElement} scope */
function bindCustomizeSliderCounters(scope) {
    for (const counter of scope.querySelectorAll('.ds-row-slider input[type="number"][data-for]')) {
        if (!(counter instanceof HTMLInputElement)) continue;
        const rangeId = counter.dataset.for;
        if (!rangeId) continue;
        const range = scope.querySelector(`#${CSS.escape(rangeId)}`) ?? document.getElementById(rangeId);
        if (!(range instanceof HTMLInputElement) || range.type !== 'range') continue;

        counter.disabled = range.disabled;
        if (counter.dataset.sbCounterBound === 'true') continue;
        counter.value = range.value;
        counter.dataset.sbCounterBound = 'true';
        const applyNumber = () => {
            if (range.disabled || !counter.value || !counter.validity.valid) {
                counter.value = range.value;
                return;
            }
            range.value = counter.value;
            counter.value = range.value;
            range.dispatchEvent(new Event('input', { bubbles: true }));
        };
        $(range).on('input.sbCustomizeCounter', () => { counter.value = range.value; });
        counter.addEventListener('change', applyNumber);
        counter.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            event.stopPropagation();
            applyNumber();
        });
    }
}

/** @type {((panel: HTMLElement) => boolean)|null} */
let animatedBackgroundPresenter = null;

/** The Appearance module loads on demand, so the page hands over its presenter once it has arrived. @param {(panel: HTMLElement) => boolean} presenter */
export function setAnimatedBackgroundPresenter(presenter) {
    animatedBackgroundPresenter = presenter;
}

/** @param {HTMLElement|null} panel  `#bpt-animated-bg-panel`, which the section order moves out of the gallery. */
function normalizeAnimatedBackgroundPanel(panel) {
    if (!(panel instanceof HTMLElement) || panel.dataset.sbBackgroundPresented === 'true') return;

    const controls = panel.querySelector('.bpt-animated-bg-controls');
    if (!(controls instanceof HTMLElement)) return;

    // BunnyPresetTools owns the inputs and listeners; move its nodes rather than rewriting its markup.
    controls.classList.add('ds-pref-group');
    for (const label of controls.querySelectorAll('.checkbox_label')) {
        if (label instanceof HTMLLabelElement) normalizeCustomizeSwitch(label, { subtitles: false });
    }
    const volume = controls.querySelector('input[type="range"]');
    if (volume instanceof HTMLInputElement) normalizeCustomizeField(volume.parentElement, volume, { subtitles: false });
    animatedBackgroundPresenter?.(panel);
}

/** @param {HTMLElement} scope */
function normalizeBackgroundSettings(scope) {
    const gallery = scope.querySelector('#Backgrounds');
    if (!(gallery instanceof HTMLElement)) return;
    normalizeAnimatedBackgroundPanel(scope.querySelector('#bpt-animated-bg-panel'));
    if (gallery.dataset.sbBackgroundObserverBound === 'true') return;

    // Extensions can inject the panel after Appearance is already open. Only direct additions matter.
    new MutationObserver(() => normalizeAnimatedBackgroundPanel(document.getElementById('bpt-animated-bg-panel'))).observe(gallery, { childList: true });
    gallery.dataset.sbBackgroundObserverBound = 'true';
}

/**
 * Whether a Customize tab is built to the settings page contract: its selects, numbers and text areas
 * become rows, and a group that depends on a switch follows that switch (see `SB_SETTINGS_SECTION_ORDER`).
 * @param {string} tabName
 */
function isContractTab(tabName) {
    return SB_SETTINGS_SECTION_ORDER[tabName]?.contract === true;
}

/** Rows that already have the form of their control, or that hold more than one control. */
const SB_ADOPTED_ROW_SELECTOR = '.ds-row-switch, .ds-row-slider, .ds-select-row, .ds-row--spin, .ds-row-textarea, .ds-row-entry, .ds-row-expander__header';

/** The controllers of the rows this pass built, by row, so that a dependent set can make a row insensitive through its own controller. */
const sbRowControllers = new WeakMap();

/**
 * The title a row shows, as plain text and without the colon an upstream label ends with. The source node keeps
 * its text, so the translation key and the stored string do not change.
 * @param {HTMLElement} label
 */
export function readRowTitle(label) {
    const copy = /** @type {HTMLElement} */ (label.cloneNode(true));
    for (const part of copy.querySelectorAll('.ds-row-subtitle, .fa-circle-info, i, svg, script, style, .sr-only')) part.remove();
    return normalizeFieldTitle(copy.textContent ?? '');
}

/**
 * Gives a field row of a contract tab the row that fits its control: a select row, a spin row or a text-area field.
 * The control keeps its node, id, value and listeners; the title and the subtitle move into the new row with their
 * translation keys. A row with any other control, or with more than one, is left as the row pass made it.
 *
 * A Backend page shows and hides rows through attributes of the row's own node (`data-source`, `data-tg-type`), so
 * `keepWrapper` leaves a node that carries an id, a data attribute or an inline style in place as a wrapper around
 * the new row. `keepLinks` carries the help links of the old title into the new one. `manual` also adopts rows inside a
 * panel that lays itself out (`data-sb-presentation="manual"`): the Presets page builds its own groups and adopts the rest.
 * `owned` is for a page that adopts its rows inside its own wrappers and inside expanders, and keeps their gating attributes (Sampling).
 * @param {HTMLElement} row
 * @param {{keepWrapper?: boolean, keepLinks?: boolean, manual?: boolean, owned?: boolean}} [options]
 */
export function adoptFieldRow(row, { keepWrapper = false, keepLinks = false, manual = false, owned = false } = {}) {
    if (row.matches(SB_ADOPTED_ROW_SELECTOR) || (!owned && row.closest(`${manual ? 'form' : SB_SKIP_SELECTOR}, .ds-row-expander-content`)) || row.children.length !== 2) return;
    const text = row.querySelector(':scope > .ds-row-text');
    const suffix = row.querySelector(':scope > .ds-row-suffix');
    const label = text?.querySelector(':scope > .ds-row-label');
    if (!(text instanceof HTMLElement) || !(suffix instanceof HTMLElement) || !(label instanceof HTMLElement)) return;

    const nodes = [...suffix.children].filter(node => !node.matches('.select2-container'));
    const control = nodes[0];
    if (nodes.length !== 1 || !(control instanceof HTMLSelectElement || control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) return;
    const kind = control instanceof HTMLSelectElement ? (control.multiple || control.size > 1 ? null : 'select')
        : control instanceof HTMLTextAreaElement ? 'textarea'
            : control.type === 'number' && !control.dataset.for ? 'spin' : null;
    const title = readRowTitle(label);
    if (!kind || !title) return;

    // The generic field pass flagged the control to fill its row; each factory lays its own control out.
    control.classList.remove('ds-control-flex');
    const subtitle = text.querySelector('.ds-row-subtitle');
    const subtitleText = subtitle?.textContent?.trim() ?? '';
    const field = control.id || control.name || 'customize-field';
    const options = { label: title, subtitle: subtitleText || undefined, field };
    const { top, buttons } = kind === 'select' ? collectRowButtons(row) : { top: row, buttons: [] };
    /** @type {{row: HTMLElement}} */
    let built;
    if (kind === 'select') {
        built = createSelectRow({ ...options, select: /** @type {HTMLSelectElement} */ (control), searchLabel: t`Search`, emptyText: t`No Results`, suffix: buttons.length ? buttons : undefined });
    } else if (kind === 'spin') {
        built = createSpinRow({ ...options, input: /** @type {HTMLInputElement} */ (control), normalize: false });
    } else {
        built = createTextAreaField({ ...options, input: /** @type {HTMLTextAreaElement} */ (control), expandLabel: t`Expand the Editor` });
    }

    // The new captions take the nodes' content, so the translation keys, macro examples and copy placeholders survive.
    const key = readLabelI18nKey(label);
    const caption = built.row.querySelector('.ds-row-label');
    if (key && caption instanceof HTMLElement) caption.dataset.i18n = key;
    const newSubtitle = built.row.querySelector('.ds-row-subtitle');
    if (subtitle instanceof HTMLElement && newSubtitle instanceof HTMLElement) {
        moveCaption(newSubtitle, subtitle, { keepSource: true });
        if (subtitle.dataset.sbCopyPlaceholder) newSubtitle.dataset.sbCopyPlaceholder = subtitle.dataset.sbCopyPlaceholder;
    }
    if (keepLinks && caption instanceof HTMLElement) {
        for (const link of label.querySelectorAll('a[href]')) {
            caption.append(' ', link);
            if (!link.textContent?.trim() && !link.hasAttribute('aria-label')) link.setAttribute('aria-label', t`Help`);
        }
    }
    sbRowControllers.set(built.row, built);
    const carriesState = top.id || top.getAttributeNames().some(name => name.startsWith('data-') || name === 'style');
    if (keepWrapper && carriesState) {
        top.classList.remove('ds-row', 'ds-row-slider');
        top.classList.add('sb-settings-row-wrapper');
        top.replaceChildren(built.row);
        return;
    }
    if (top !== row && top.id) built.row.id = top.id;
    if (owned) carryGatingAttributes(row, built.row);
    top.replaceWith(built.row);
}

/** The attributes by which the backends show and hide a control (`showTGSamplerControls`, `updateCommonSourceElements`). */
const SB_GATING_ATTRIBUTES = Object.freeze(['data-source', 'data-source-mode', 'data-tg-type', 'data-tg-type-mode', 'data-tg-samplers', 'data-sb-sampler-ungated']);

/**
 * A control that moves into a row of its own hands the row the attributes the backends gate it by.
 * @param {Element} from @param {Element} to
 */
export function carryGatingAttributes(from, to) {
    for (const name of SB_GATING_ATTRIBUTES) {
        if (from.hasAttribute(name) && !to.hasAttribute(name)) to.setAttribute(name, from.getAttribute(name) ?? '');
    }
}

/**
 * Backend ▸ Sampling gives the field rows of its cards (a seed, the DRY sequence breakers) the row that fits the control.
 * @param {HTMLElement} scope
 */
export function adoptSamplingFieldRows(scope) {
    for (const row of scope.querySelectorAll('.ds-row')) {
        if (row instanceof HTMLElement) adoptFieldRow(row, { owned: true });
    }
}

/**
 * A select that upstream wrapped in a flex container of its own (the AutoComplete Style row) sits in its row without the wrapper,
 * so that the select row can lay the control out.
 * @param {HTMLElement} scope
 */
export function unwrapLoneSelects(scope) {
    for (const wrapper of scope.querySelectorAll('.ds-row-suffix > .flex-container')) {
        if (wrapper.children.length === 1 && wrapper.firstElementChild instanceof HTMLSelectElement) wrapper.replaceWith(wrapper.firstElementChild);
    }
}

/**
 * The wrappers around a field row that hold nothing else but its action buttons (the MovingUI Preset block and its save button).
 * @param {HTMLElement} row
 * @returns {{top: HTMLElement, buttons: HTMLElement[]}} the outermost such wrapper, and the buttons it holds beside the row
 */
function collectRowButtons(row) {
    const buttons = [];
    let top = row;
    for (let parent = row.parentElement; parent?.matches('.flex-container:not(.ds-pref-group)'); parent = parent.parentElement) {
        const siblings = [...parent.children].filter(node => node !== top);
        if (!siblings.every(node => node instanceof HTMLElement && node.matches('.menu_button'))) break;
        buttons.push(...siblings);
        top = parent;
    }
    return { top, buttons };
}

/**
 * A section that a contract tab keeps from a drawer (AutoComplete) is a group like the rest: its bold title becomes the group heading
 * element, and every category title carries the group heading class.
 * @param {HTMLElement} scope
 */
export function adoptGroupHeadings(scope) {
    for (const title of scope.querySelectorAll('.sb-settings-category-heading > b > .sb-settings-category-title')) {
        const bold = title.parentElement;
        if (!bold || bold.children.length !== 1) continue;
        const heading = document.createElement('h4');
        for (const { name, value } of title.attributes) heading.setAttribute(name, value);
        heading.append(...title.childNodes);
        bold.replaceWith(heading);
    }
    for (const title of scope.querySelectorAll('.sb-settings-category-title')) addMissingClasses(title, 'ds-pref-group-heading');
}

/**
 * Gives each button that sits loose in a boxed list a row of its own: a title that reads like the button, the button's tooltip as the subtitle,
 * and the button itself, with its id and listeners, in the trailing slot. A flex container that holds only buttons (Miscellaneous) is opened first.
 * @param {HTMLElement} scope
 */
export function adoptButtonRows(scope) {
    for (const box of scope.querySelectorAll('.ds-pref-group:is(.sb-settings-category-body, .sb-prompting-group-body)')) {
        for (const wrapper of box.querySelectorAll(':scope > .flex-container')) {
            const nodes = [...wrapper.children];
            if (nodes.length && nodes.every(node => node.matches('.menu_button'))) wrapper.replaceWith(...nodes);
        }
        for (const button of box.querySelectorAll(':scope > .menu_button')) {
            if (!(button instanceof HTMLElement)) continue;
            const next = button.nextSibling;
            const row = createButtonRow(button);
            if (row) box.insertBefore(row, next);
        }
    }
}

/**
 * The row for one loose button: a title that reads like the button, the button's tooltip as the subtitle, and the button itself, with
 * its id and listeners, in the trailing slot.
 * @param {HTMLElement} button
 * @returns {HTMLElement|null} the row, or null when the button has no text to title it
 */
function createButtonRow(button) {
    const caption = button.querySelector('span, small') ?? button;
    const title = readRowTitle(caption instanceof HTMLElement ? caption : button);
    if (!title) return null;
    const tooltip = button.getAttribute('title')?.trim();
    const { row } = createRow({ label: title, subtitle: tooltip || undefined, field: button.id || 'button', suffix: button });
    row.classList.add('ds-row-actions');
    const key = readLabelI18nKey(caption instanceof HTMLElement ? caption : button);
    const rowTitle = row.querySelector('.ds-row-label');
    if (key && rowTitle instanceof HTMLElement) rowTitle.dataset.i18n = key;
    const tooltipKey = button.getAttribute('data-i18n')?.match(/(?:^|;)\[title\]([^;]+)/)?.[1];
    const rowSubtitle = row.querySelector('.ds-row-subtitle');
    if (tooltipKey && rowSubtitle instanceof HTMLElement) rowSubtitle.dataset.i18n = tooltipKey;
    return row;
}

/**
 * An extension page that lays out a field and its buttons in one flex container (the provider select, its endpoint select and
 * the Key and URL buttons of Translate) has its rows opened into the group, and each button gets a button row of its own. The
 * extension shows and hides such a button itself (`.toggle()`), so its row follows the button's own `display`.
 * @param {HTMLElement} scope
 */
function adoptWrappedButtonRows(scope) {
    for (const wrapper of scope.querySelectorAll('.ds-pref-group > .flex-container')) {
        const nodes = [...wrapper.children];
        if (!nodes.some(node => node.matches('.menu_button')) || !nodes.some(node => node.matches('.ds-row'))) continue;
        if (!nodes.every(node => node.matches('.ds-row, .menu_button'))) continue;
        const rows = nodes.map(node => {
            if (!node.matches('.menu_button') || !(node instanceof HTMLElement)) return node;
            const row = createButtonRow(node);
            if (!row) return node;
            const follow = () => { row.hidden = node.style.display === 'none'; };
            follow();
            new MutationObserver(follow).observe(node, { attributes: true, attributeFilter: ['style'] });
            return row;
        });
        wrapper.replaceWith(...rows);
    }
}

/**
 * A button that sits loose in an extension page's group, beside rows that the page has adopted (Translate's Clear Translations), gets
 * a button row of its own, like the buttons of {@link adoptWrappedButtonRows}. A group without rows is left alone: its button
 * is part of a layout that this pass did not change.
 * @param {HTMLElement} scope
 */
function adoptLooseButtonRows(scope) {
    for (const group of scope.querySelectorAll('.ds-pref-group')) {
        if (!group.querySelector(':scope > .ds-row')) continue;
        for (const button of group.querySelectorAll(':scope > .menu_button:not(.ds-row)')) {
            if (!(button instanceof HTMLElement)) continue;
            const next = button.nextSibling;
            const row = createButtonRow(button);
            if (row) group.insertBefore(row, next);
        }
    }
}

/** @param {HTMLElement} row @param {boolean} insensitive */
export function setRowInsensitive(row, insensitive) {
    if (row.classList.contains('is-insensitive') === insensitive) return;
    const controller = sbRowControllers.get(row);
    if (controller) {
        controller.setDisabled(insensitive);
        return;
    }
    row.classList.toggle('is-insensitive', insensitive);
    row.setAttribute('aria-disabled', String(insensitive));
    for (const control of row.querySelectorAll('input, select, textarea, button')) {
        if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement || control instanceof HTMLButtonElement)) continue;
        // SillyBunny: a control marked data-sb-keeps-sensitive (the Sampling details button) explains the row, so it keeps working in an insensitive row.
        if (control.hasAttribute('data-sb-keeps-sensitive')) continue;
        // A control that something else disables stays disabled when the row becomes sensitive again.
        if (insensitive && !control.disabled) {
            control.disabled = true;
            control.dataset.sbInsensitive = 'true';
        } else if (!insensitive && control.dataset.sbInsensitive) {
            control.disabled = false;
            delete control.dataset.sbInsensitive;
        }
    }
}

const sbDependentBodies = new WeakSet();

/**
 * Keeps a dependent set in step with its switch: the rows after the enabling switch are insensitive while it is off.
 * Other code sets the switch without an event, so the group also looks again when the pointer or focus reaches it.
 * @param {HTMLElement} scope
 */
export function bindDependentSets(scope) {
    for (const body of scope.querySelectorAll('[data-sb-enabled-by]')) {
        const enabler = body instanceof HTMLElement ? scope.querySelector(body.dataset.sbEnabledBy ?? '') : null;
        if (!(body instanceof HTMLElement) || !(enabler instanceof HTMLInputElement)) continue;
        const enablerRow = enabler.closest('.ds-row');
        const sync = () => {
            for (const row of body.children) {
                // A row that carries `data-sb-sensitivity-owned` has an owner that also holds it insensitive for another reason.
                if (row instanceof HTMLElement && row !== enablerRow && !row.hasAttribute('data-sb-sensitivity-owned') && row.matches('.ds-row, .ds-row-expander')) setRowInsensitive(row, !enabler.checked);
            }
        };
        if (!sbDependentBodies.has(body)) {
            sbDependentBodies.add(body);
            enabler.addEventListener('change', sync);
            body.addEventListener('pointerover', sync);
            body.addEventListener('focusin', sync);
        }
        sync();
    }
}

/**
 * @param {HTMLElement} scope
 * @param {string} [tabName]
 */
function normalizeCustomizeRows(scope, tabName = '') {
    normalizeBackgroundSettings(scope);
    for (const header of scope.querySelectorAll('[data-sb-settings-compound] > .sb-settings-flat-header')) {
        if (header instanceof HTMLElement) ensureDescription(header, header, true);
    }
    for (const picker of scope.querySelectorAll('.ds-row toolcool-color-picker:not([aria-labelledby])')) {
        const title = picker.closest('.ds-row')?.querySelector('.ds-row-label');
        if (!(picker instanceof HTMLElement) || !picker.id || !(title instanceof HTMLElement)) continue;
        if (!title.id) title.id = `sb-setting-${picker.id}-label`;
        // The component's shadow button keeps its own name; the group supplies the color's purpose.
        picker.setAttribute('role', 'group');
        picker.setAttribute('aria-labelledby', title.id);
    }
    const version = scope.querySelector('#version_display');
    if (version instanceof HTMLElement && !version.closest('.ds-row')) {
        const row = document.createElement('div');
        row.className = 'ds-row';
        const text = document.createElement('div');
        text.className = 'ds-row-text';
        const title = document.createElement('span');
        title.className = 'ds-row-label';
        title.textContent = 'Version';
        text.append(title, createRowSubtitle(row));
        const suffix = document.createElement('div');
        suffix.className = 'ds-row-suffix';
        version.before(row);
        suffix.append(version);
        row.append(text, suffix);
    }
    for (const label of scope.querySelectorAll('.checkbox_label')) {
        if (label instanceof HTMLLabelElement && !label.closest('[data-sb-presentation="manual"]')) normalizeCustomizeSwitch(label);
    }
    for (const control of scope.querySelectorAll('select, input[type="range"], input[type="number"], input[type="text"], textarea')) {
        if (!(control instanceof HTMLElement) || control.closest('.ds-row, [data-sb-presentation="manual"]')) continue;
        let row = control.parentElement;
        // Some upstream fields wrap the control one or two levels below its label (autocomplete).
        for (let depth = 0; depth < 2 && row && !row.querySelector(':scope > label, :scope > small, :scope > span'); depth++) {
            const parent = row.parentElement;
            if (!parent || parent.matches('.ds-pref-group, .sb-settings-flat-section, [data-sb-presentation="manual"]')) break;
            row = parent;
        }
        if (row instanceof HTMLElement) normalizeCustomizeField(row, control);
    }
    bindCustomizeSliderCounters(scope);
    bindSettingsSwitchKeyboard(scope);
    normalizeSwitchRowWrappers(scope);
    if (isContractTab(tabName)) {
        // A title wrapped in a flex container (upstream baseline layout) would add that container's own box to the row.
        for (const wrapper of scope.querySelectorAll('.ds-row-label > .flex-container')) wrapper.replaceWith(...wrapper.childNodes);
        adoptGroupHeadings(scope);
        unwrapLoneSelects(scope);
        adoptButtonRows(scope);
        for (const row of scope.querySelectorAll('.ds-row')) {
            if (row instanceof HTMLElement) adoptFieldRow(row);
        }
        bindDependentSets(scope);
    }
    if (scope.dataset.sbRowEvents === 'true') return;
    scope.dataset.sbRowEvents = 'true';
    // Upstream changes range availability when Fast UI or No Shadows is toggled.
    const rangeAvailabilityObserver = new MutationObserver(mutations => {
        for (const { target } of mutations) {
            if (!(target instanceof HTMLInputElement) || target.type !== 'range') continue;
            const counter = target.closest('.ds-row-slider')?.querySelector('input[type="number"][data-for]');
            if (counter instanceof HTMLInputElement) counter.disabled = target.disabled;
        }
    });
    rangeAvailabilityObserver.observe(scope, { subtree: true, attributes: true, attributeFilter: ['disabled'] });
}

/** A two-line heading a SillyBunny panel already authored. */
const SB_MODERN_HEADER_SELECTOR = '.sb-settings-flat-header, .sb-settings-category-header';

/** A bare heading that may name a section. */
const SB_LEGACY_HEADING_SELECTOR = 'h3, h4, .standoutHeader';

/** Any heading, modern or bare. */
const SB_HEADING_ANY_SELECTOR = `${SB_MODERN_HEADER_SELECTOR}, ${SB_LEGACY_HEADING_SELECTOR}`;

/**
 * Sections that name themselves.
 *
 * These are targets in their own right wherever they appear: they carry their own header and body, so
 * the pass never has to guess where their rows start.
 */
const SB_SECTION_SELECTOR = '.sb-settings-flat-section, .sb-settings-category, .sb-settings-subdrawer';

/** A baseline bar that carries a heading beside its own buttons. */
const SB_BAR_SELECTOR = '.flex-container.alignItemsBaseline';

/** A pill. A heading inside one names a block within the pill, not a section. */
const SB_PILL_SELECTOR = '.ds-pref-group';

/** Subtrees this pass never restructures. */
const SB_SKIP_SELECTOR = 'form, [data-sb-presentation="manual"]';

/** Hidden markup has nothing to present. */
const SB_HIDDEN_SELECTOR = '[hidden], .hidden, .displayNone';

/** Controls that make an element a settings row rather than decoration. */
const SB_CONTROL_SELECTOR = 'input, select, textarea, button, .menu_button, toolcool-color-picker';

/**
 * Where a bare heading sits inside a section.
 *
 * Upstream is inconsistent: most sections put the heading first, but a "section bar" shape wraps it
 * in a baseline row beside its own controls, as the Connection Profile header does.
 */
const SB_HEADING_IN_SECTION_SELECTOR = [
    `:scope > ${SB_LEGACY_HEADING_SELECTOR}`,
    `:scope > ${SB_BAR_SELECTOR} > :is(${SB_LEGACY_HEADING_SELECTOR})`,
].join(', ');

/**
 * Headings a section may be wrapped in, deepest match first.
 *
 * A modern heading wraps its text in a column, so the `small` beside the title is a description and
 * must not be read as part of the name; the title element is therefore resolved to the innermost node
 * that holds the name. The `.flex-container` entries cover the authored three-node shape
 * (`header > .flex-container > b` plus its `small`), which is what Prompting and Advanced Formatting
 * build.
 */
const SB_TITLE_SELECTORS = Object.freeze([
    '.sb-settings-category-heading > .sb-settings-category-title',
    '.sb-settings-category-heading > :is(h3, h4)',
    '.sb-settings-category-heading > .flex-container > b',
    '.sb-settings-category-heading > .flex-container > strong',
    '.sb-settings-flat-header > .flex-container > b > span',
    '.sb-settings-flat-header > .flex-container > b',
    '.sb-settings-flat-header > .flex-container > strong',
    '.sb-settings-flat-header > b > span',
    '.sb-settings-flat-header > b',
    '.sb-settings-flat-header > strong',
    ':scope > span',
    ':scope > b',
    ':scope > strong',
]);

/** The decorative icon an authored drawer header puts before its title. */
const SB_HEADING_ICON_SELECTOR = ':scope > :is(b, strong) > i[class*="fa-"]:first-child, :scope > .flex-container > :is(b, strong) > i[class*="fa-"]:first-child';

/** Things a section title is never taken from: description lines and the controls beside them. */
const SB_TITLE_EXCLUDE_SELECTOR = 'small, .menu_button, button, select, input, textarea, label';

/**
 * Whether a subtree is one this pass must not restructure.
 *
 * @param {HTMLElement} node
 * @returns {boolean}
 */
function isSkipped(node) {
    return node.matches(SB_SKIP_SELECTOR)
        || node.closest(SB_SKIP_SELECTOR) !== null
        || node.matches(SB_HIDDEN_SELECTOR)
        || node.closest(SB_HIDDEN_SELECTOR) !== null;
}

/**
 * Whether a node is a heading, or a bar that carries one.
 *
 * @param {HTMLElement} node
 * @returns {boolean}
 */
function isHeadingCarrier(node) {
    if (node.matches(SB_HEADING_ANY_SELECTOR)) {
        return true;
    }
    return node.matches(SB_BAR_SELECTOR) && node.querySelector(SB_LEGACY_HEADING_SELECTOR) !== null;
}

/**
 * The display text of a title element.
 *
 * @param {HTMLElement} element
 * @returns {string}
 */
function getTitleText(element) {
    return element.textContent.replace(/\s+/g, ' ').trim();
}

/**
 * The element whose text names the section.
 *
 * A description line lives beside the title in the same column, so it is excluded explicitly: the
 * section name must never be read as `Title` plus its own sub-text.
 *
 * @param {HTMLElement} heading
 * @returns {HTMLElement}
 */
function getTitleElement(heading) {
    for (const selector of SB_TITLE_SELECTORS) {
        const found = heading.querySelector(selector);
        if (!(found instanceof HTMLElement)) {
            continue;
        }
        // A `small` is always the description, and a control's text is never a section name; both
        // would otherwise be read back as the title of a section that only has a description.
        if (found.closest(SB_TITLE_EXCLUDE_SELECTOR) !== null || getTitleText(found) === '') {
            continue;
        }
        return found;
    }
    return heading;
}

/**
 * Whether a section's own heading is the one given.
 *
 * @param {HTMLElement} section
 * @param {HTMLElement} heading
 * @returns {boolean}
 */
function isSectionHeading(section, heading) {
    return section === heading
        || section.querySelector(`:scope > ${SB_HEADING_ANY_SELECTOR}`) === heading;
}

/**
 * The heading of a bare section, or null when it has none.
 *
 * @param {HTMLElement} section
 * @returns {HTMLElement|null}
 */
function findHeading(section) {
    return section.querySelector(SB_HEADING_IN_SECTION_SELECTOR);
}

/**
 * The element that owns the rows below a heading.
 *
 * A bare heading in a baseline row keeps its controls beside it in that row and its rows after it,
 * so the walk starts from the row; every other heading's rows are its own siblings.
 *
 * @param {HTMLElement} heading
 * @returns {HTMLElement|null}
 */
function getRowOwner(heading) {
    const parent = heading.parentElement;
    if (!(parent instanceof HTMLElement)) {
        return null;
    }

    const bar = parent.closest(SB_BAR_SELECTOR);
    if (bar instanceof HTMLElement && bar.parentElement instanceof HTMLElement) {
        return bar.parentElement;
    }

    return parent;
}

/**
 * The section a heading names, whether or not it is one already.
 *
 * @param {HTMLElement} heading
 * @returns {HTMLElement|null}
 */
function resolveSection(heading) {
    const authored = heading.closest(SB_SECTION_SELECTOR);
    if (authored instanceof HTMLElement && isSectionHeading(authored, heading)) {
        return authored;
    }
    return getRowOwner(heading);
}

/**
 * Whether a heading that is not a section's own names a field or a block instead.
 *
 * Upstream nests provider blocks inside a provider section and puts an `h4` on each field, and a
 * heading inside a pill names a block of that pill. Both follow a real section heading, and both are
 * labels rather than sections.
 *
 * @param {HTMLElement} heading
 * @param {HTMLElement} owner
 * @returns {boolean}
 */
function isFieldLabel(heading, owner) {
    if (owner.closest(SB_PILL_SELECTOR) !== null) {
        return true;
    }

    // A heading that follows another one's rows belongs to that one's body.
    for (let node = owner.parentElement; node; node = node.parentElement) {
        if (node.matches(SB_SECTION_SELECTOR) || isSectionHeading(node, heading)) {
            break;
        }
        const headingAbove = node.querySelector(`:scope > ${SB_LEGACY_HEADING_SELECTOR}, :scope > ${SB_BAR_SELECTOR} > h3, :scope > ${SB_BAR_SELECTOR} > h4`);
        if (headingAbove instanceof HTMLElement
            && (headingAbove.compareDocumentPosition(owner) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
            return true;
        }
    }

    return false;
}

/**
 * Whether an element reads as a settings row worth boxing.
 *
 * A heading is not a row, and neither is anything that holds sections of its own: a nested section
 * carries its own header and pill and is normalized on its own turn.
 *
 * @param {HTMLElement} node
 * @returns {boolean}
 */
function isRow(node) {
    if (isHeadingCarrier(node) || node.matches('script, style') || isSkipped(node)) {
        return false;
    }
    if (node.matches(SB_SECTION_SELECTOR)) {
        return false;
    }
    if (node.querySelector(`:scope > ${SB_SECTION_SELECTOR}`) !== null) {
        return false;
    }
    return node.matches(SB_CONTROL_SELECTOR) || node.querySelector(SB_CONTROL_SELECTOR) !== null;
}

/**
 * The rows between `start` and the next heading, or the next nested section.
 *
 * @param {HTMLElement} start the element to start after
 * @returns {HTMLElement[]}
 */
function collectRows(start) {
    const rows = [];
    for (let node = start.nextElementSibling; node; node = node.nextElementSibling) {
        if (isHeadingCarrier(node) || node.matches(SB_SECTION_SELECTOR)) {
            break;
        }
        if (isRow(node)) {
            rows.push(node);
        }
    }
    return rows;
}

/**
 * The wrapping ancestors between `node` and `stop`, nearest first.
 *
 * @param {HTMLElement} node
 * @param {HTMLElement} stop
 * @returns {HTMLElement[]}
 */
function collectWrappers(node, stop) {
    const wrappers = [];
    for (let current = node.parentElement; current && current !== stop; current = current.parentElement) {
        wrappers.push(current);
    }
    return wrappers;
}

/**
 * The two-line heading column of a section, built around `heading` when the section has none.
 *
 * The markup matches what a SillyBunny panel builds, so a normalized section and an authored one are
 * the same shape and share one set of styles.
 *
 * The header takes the heading's own slot rather than going to the top of the section. A bare `h3`
 * part-way down a panel titles the rows below it, so moving it would reorder the panel; and a heading
 * inside a baseline bar sits there so the bar's own buttons stay on its right, so the header goes
 * into that bar in place of the heading and the buttons keep their position.
 *
 * @param {HTMLElement} section the element that will hold the header
 * @param {HTMLElement} heading
 * @returns {HTMLElement|null} the column that holds the title and description
 */
function buildHeadingColumn(section, heading) {
    const title = getTitleElement(heading);
    if (getTitleText(title) === '') {
        return null;
    }

    const wrappers = collectWrappers(title, section);
    if (wrappers.length === 0) {
        return null;
    }

    const barIndex = wrappers.findIndex(wrapper => wrapper.matches(SB_BAR_SELECTOR));
    const slot = barIndex > 0 ? wrappers[barIndex - 1] : wrappers[wrappers.length - 1];

    const header = document.createElement('div');
    header.className = 'sb-settings-flat-header sb-settings-category-header';

    const column = document.createElement('div');
    column.className = 'flex-container flexFlowColumn sb-settings-category-heading';
    header.appendChild(column);

    slot.parentElement?.insertBefore(header, slot);

    title.classList.add('sb-settings-category-title');
    column.appendChild(title);

    // A wrapper that held nothing but the title is gone once the title moves; the baseline bar is
    // kept even when it empties, because it is the row the section's buttons live in.
    for (const wrapper of wrappers) {
        if (wrapper.childElementCount === 0 && getTitleText(wrapper) === '' && !wrapper.matches(SB_BAR_SELECTOR)) {
            wrapper.remove();
        }
    }

    return column;
}

/**
 * The description line of a section header, if it already has one.
 *
 * Upstream writes the description in one of two places, and both are searched because the authored
 * three-node header (`header > .flex-container > b + small`) nests it a level deeper than the
 * two-node heading column a SillyBunny panel builds.
 *
 * @param {HTMLElement} header
 * @returns {HTMLElement|null}
 */
function findDescription(header) {
    for (const candidate of header.querySelectorAll('small')) {
        // Copy inside a control (a button's caption, a label's note) is not the section description.
        if (candidate.parentElement?.closest(SB_TITLE_EXCLUDE_SELECTOR) !== null) {
            continue;
        }
        if (candidate.textContent.trim() !== '') {
            return candidate;
        }
    }
    return null;
}

/**
 * The element a description line belongs in: the heading column of a modern header, or the container
 * holding the title when a header was authored as a bare `<b>`/`<span>` inside one.
 *
 * @param {HTMLElement} header
 * @param {HTMLElement} title
 * @returns {HTMLElement}
 */
function getDescriptionHost(header, title) {
    const column = header.querySelector(':scope > .sb-settings-category-heading');
    if (column instanceof HTMLElement) {
        return column;
    }

    const holder = title.parentElement;
    if (holder instanceof HTMLElement && header.contains(holder) && holder !== header) {
        return holder;
    }

    return header;
}

/**
 * Ensures a section has a description line, adding the placeholder when it has none.
 *
 * @param {HTMLElement} section the element the header belongs to
 * @param {HTMLElement} heading the section's heading
 * @param {boolean} promoteTooltip
 * @returns {string|null} the title that needs copy, or null when it already has a description
 */
function ensureDescription(section, heading, promoteTooltip) {
    const modern = section.matches(SB_MODERN_HEADER_SELECTOR)
        ? section
        : section.querySelector(`:scope > ${SB_MODERN_HEADER_SELECTOR}`);
    const header = modern ?? buildHeadingColumn(section, heading);
    if (!(header instanceof HTMLElement)) {
        return null;
    }

    // SillyBunny: every settings header uses the Messages category-title typography. Keep the
    // authored title node live, but mark it so legacy b/strong headings and nested title spans use
    // the same style as generated category headings.
    const titleElement = getTitleElement(header);
    if (titleElement !== header && titleElement instanceof HTMLElement) {
        titleElement.classList.add('sb-settings-category-title');
    }

    // A group heading carries no icon, but the authored drawer headers in index.html lead with one.
    for (const icon of header.querySelectorAll(SB_HEADING_ICON_SELECTOR)) icon.remove();

    if (promoteTooltip && !header.querySelector(':scope > .sb-settings-category-heading')) {
        const title = titleElement;
        let titleBlock = title;
        while (titleBlock.parentElement && titleBlock.parentElement !== header) titleBlock = titleBlock.parentElement;
        if (titleBlock !== header) {
            const column = document.createElement('div');
            column.className = 'flex-container flexFlowColumn sb-settings-category-heading';
            const description = findDescription(header);
            titleBlock.before(column);
            column.append(titleBlock);
            if (description && !column.contains(description)) column.append(description);
        }
    }
    if (findDescription(header) !== null) return null;

    // A group built to have no description is not missing copy.
    if (section.dataset.sbDescription === 'none') return null;

    const existingCaption = header.nextElementSibling;
    if (promoteTooltip && existingCaption instanceof HTMLElement && existingCaption.matches('.sb-theme-slider-caption') && existingCaption.textContent.trim()) {
        getDescriptionHost(header, getTitleElement(header)).appendChild(existingCaption);
        existingCaption.className = 'ds-row-subtitle';
        return null;
    }

    // The copy is attributed to the header the description lands in, not to the heading that was
    // looked up: a section may be found through a wrapper that has a heading of its own.
    const title = getTitleElement(header);
    const description = promoteTooltip ? createRowSubtitle(heading) : document.createElement('small');
    if (!promoteTooltip) {
        description.textContent = SB_PLACEHOLDER_DESCRIPTION;
        description.dataset.sbCopyPlaceholder = 'true';
    }
    getDescriptionHost(header, title).appendChild(description);

    return description.dataset.sbCopyPlaceholder === 'true' ? getTitleText(title) || null : null;
}

/**
 * Gathers the rows below a heading into one pill.
 *
 * A single `flex-container` body becomes the pill itself, so a group that already lays its own rows
 * out keeps that layout; a run of loose rows is collected into a new pill so the pill's own row
 * separators apply.
 *
 * @param {HTMLElement} owner the element holding the heading's rows
 * @param {HTMLElement[]} rows the rows to box, in document order
 * @returns {number} how many rows ended up boxed
 */
function boxRows(owner, rows) {
    if (rows.length === 0) {
        return 0;
    }

    if (rows.length === 1 && rows[0].classList.contains(SB_PILL_SELECTOR.slice(1))) {
        return 0;
    }

    let body;
    if (rows.length === 1 && rows[0].classList.contains('flex-container')) {
        body = rows[0];
    } else {
        body = document.createElement('div');
        owner.insertBefore(body, rows[0]);
        for (const row of rows) {
            body.appendChild(row);
        }
    }

    body.classList.add('ds-pref-group', 'sb-settings-category-body');
    return rows.length;
}

/**
 * Normalizes one section, returning what changed.
 *
 * @param {HTMLElement} section
 * @param {HTMLElement} heading
 * @param {string} tabName
 * @returns {{pills: number, placeholder: string|null}}
 */
function normalizeSection(section, heading, tabName) {
    const owner = getRowOwner(heading);
    if (!(owner instanceof HTMLElement)) {
        return { pills: 0, placeholder: null };
    }

    const title = getTitleText(getTitleElement(heading));
    if (title === '' || title === SB_PLACEHOLDER_DESCRIPTION) {
        return { pills: 0, placeholder: null };
    }

    // The rows are read before anything is built, because placing the heading column reparents the
    // title and would invalidate an anchor captured from its old wrapper.
    const anchor = heading.parentElement === owner ? heading : /** @type {HTMLElement} */ (heading.parentElement);
    const rows = collectRows(anchor);

    const missingCopy = ensureDescription(section, heading, SB_CUSTOMIZE_TABS.has(tabName));
    return {
        pills: boxRows(owner, rows),
        placeholder: missingCopy === null ? null : `${tabName} › ${missingCopy}`,
    };
}

/**
 * Normalizes every section of one settings panel.
 *
 * @param {HTMLElement|null|undefined} scope the tab's panel or container
 * @param {{name?: string}} [options] `name` labels the tab in the placeholder report
 * @returns {{pills: number, placeholders: string[]}} what the pass changed
 */
export function normalizeSettingsPresentation(scope, options = {}) {
    const report = { pills: 0, placeholders: [] };

    if (!(scope instanceof HTMLElement) || isSkipped(scope)) {
        return report;
    }

    const tabName = options.name ?? 'settings';
    const seen = new Set();

    for (const heading of scope.querySelectorAll(SB_HEADING_ANY_SELECTOR)) {
        if (isSkipped(heading)) {
            continue;
        }

        // A heading inside a two-line header is that header's own title. It is reached again on
        // later runs and through the section's header either way, and treating it as a section of
        // its own would wrap the header in a second header.
        if (heading.parentElement?.closest(SB_MODERN_HEADER_SELECTOR) !== null) {
            continue;
        }

        const section = resolveSection(heading);
        if (!(section instanceof HTMLElement) || isSkipped(section) || seen.has(section)) {
            continue;
        }

        // A section that sits inside a pill is a block of that pill, not a section of the panel:
        // the flatten pass leaves nested drawers in place as flat sections, and Messages has one per
        // sub-drawer inside its category bodies. Boxing it would put a pill inside a pill.
        if (section.parentElement?.closest(SB_PILL_SELECTOR) !== null) {
            continue;
        }

        // A section this pass did not author must have the heading as its own first heading, and the
        // heading must not be a field label inside another section.
        if (!section.matches(SB_SECTION_SELECTOR)) {
            if (findHeading(section) !== heading || isFieldLabel(heading, section)) {
                continue;
            }
        }

        seen.add(section);
        const { pills, placeholder } = normalizeSection(section, heading, tabName);
        report.pills += pills;
        if (placeholder !== null) {
            report.placeholders.push(placeholder);
        }
    }

    if (SB_CUSTOMIZE_TABS.has(tabName)) {
        const rowsRoot = tabName === 'data-security' ? scope.querySelector('#sb-data-security-content') ?? scope : scope;
        if (rowsRoot instanceof HTMLElement) normalizeCustomizeRows(rowsRoot, tabName);
    }

    return report;
}

/**
 * Opens the drawer a detail page names, so the page shows settings rather than a closed card.
 *
 * A detail page opened from a row that named a drawer is that drawer's page: the row carries the
 * card's own title, read from its toggle, and the page draws the card's content directly. The match
 * is what distinguishes the card from an expander inside it. Advanced Formatting holds a Logit Bias
 * editor and a CFG block, and those stay closed as the panel draws them.
 *
 * When nothing in the section matches, the section is not a card and nothing is opened. An extension
 * that builds its settings without a drawer keeps whatever it drew.
 *
 * @param {HTMLElement} scope the moved section
 * @param {string|undefined} label the label of the row that opened it
 * @returns {HTMLElement|null} the card body the page now shows
 */
function openNamedDrawer(scope, label) {
    const wanted = label?.replace(/\s+/g, ' ').trim();
    if (!wanted) {
        return null;
    }

    for (const drawer of scope.querySelectorAll('.inline-drawer')) {
        const title = readDrawerTitle(drawer);
        if (title !== wanted) {
            continue;
        }
        const toggle = drawer.querySelector(':scope > .inline-drawer-toggle, :scope > .inline-drawer-header');
        const content = drawer.querySelector(':scope > .inline-drawer-content');
        if (toggle instanceof HTMLElement) {
            toggle.hidden = true;
        }
        // Opened the way a click leaves it, inline style and all: the settings shell styles a card
        // body by matching that inline display, so forcing it from CSS would draw the body without
        // the styles the rest of the page's cards get.
        if (content instanceof HTMLElement) {
            content.style.display = 'block';
        }
        drawer.dataset.sbDetailOpened = 'true';
        return content instanceof HTMLElement ? content : null;
    }

    return null;
}

/**
 * Whether a hidden child is the rest of the group its shown sibling belongs to.
 *
 * Tab panels are drawn as siblings that share a class and are revealed one at a time, so the hidden
 * ones belong with the shown one and have to travel into the same pill: otherwise the panel a user
 * switches to falls out of the box that holds the one they started on. A container that is simply
 * hidden (another API's block, a section upstream emptied) shares no class with the shown row and
 * is skipped, which is what keeps it out of the group.
 *
 * @param {Element} shown the group's last visible child
 * @param {Element} hidden the child being considered
 * @returns {boolean}
 */
function sharesShape(shown, hidden) {
    if (shown.tagName !== hidden.tagName || shown.classList.length === 0) {
        return false;
    }

    return [...shown.classList].some(name => hidden.classList.contains(name));
}

/**
 * Boxes one opened card body's rows, so an extension's page reads like the Messages tab.
 *
 * An extension writes its card as a list of rows (a checkbox label, a labelled select, a slider)
 * with no headings between them, which is exactly the shape the row pass boxes when a section has
 * one. There is no heading here to say where a group ends, so the card is one group, except where the
 * extension drew its own divider: an `hr` is the extension saying a group ended, and boxing across it
 * would merge two things it kept apart. A group of one is still a group: Quick Reply keeps three
 * set lists apart with rules, and each of those lists is a preference pill.
 *
 * Rows are the top level only. A nested block the extension built for itself keeps its own layout.
 *
 * @param {HTMLElement|null} body
 * @returns {number} how many rows were boxed
 */
function boxCardBody(body) {
    if (!(body instanceof HTMLElement) || body.closest(SB_PILL_SELECTOR) !== null) {
        return 0;
    }

    const groups = [];
    let current = [];
    for (const child of body.children) {
        if (child.matches('hr, script, style')) {
            if (current.length > 0) {
                groups.push(current);
            }
            current = [];
            continue;
        }
        if (child.getBoundingClientRect().height === 0) {
            // A hidden branch beside a shown one is usually the rest of a tab set: Extensions and the
            // OpenAI presets both draw their panels as siblings and reveal one at a time. Skipping
            // those would leave the panel a user switches to outside the pill that holds the one they
            // started on, so a hidden sibling of the same shape joins the group rather than breaking
            // it. Anything else hidden is genuinely absent and skipped.
            const previous = current.at(-1);
            if (previous && sharesShape(previous, child)) {
                current.push(child);
            }
            continue;
        }
        // A row that `normalizeSettingsPresentation` already pilled is a group of its own, and wrapping it again would put
        // a pill inside a pill. Splitting here also keeps the rows around it in their own pill.
        if (child.classList.contains(SB_PILL_SELECTOR.slice(1))) {
            if (current.length > 0) {
                groups.push(current);
            }
            current = [];
            continue;
        }
        current.push(child);
    }
    if (current.length > 0) {
        groups.push(current);
    }

    let boxed = 0;
    for (const group of groups) {
        boxed += boxRows(body, group);
    }

    // The extension's rules sat between rows that are now pills of their own, and a pill boundary
    // already reads as a break. Left in place they would draw a second line in the same gap.
    if (boxed > 0) {
        for (const rule of body.querySelectorAll(':scope > hr')) {
            rule.hidden = true;
        }
    }

    return boxed;
}

/**
 * The title a drawer's toggle displays, read the way the row builder read it.
 *
 * The two have to agree, because the row's label is what the detail page matches against. A help
 * marker the toggle carries is not part of the name, so the text of a link is left out.
 *
 * @param {HTMLElement} drawer
 * @returns {string}
 */
function readDrawerTitle(drawer) {
    const toggle = drawer.querySelector(':scope > .inline-drawer-toggle, :scope > .inline-drawer-header');
    const title = toggle?.querySelector(':scope > b, :scope > h3, :scope > h4, :scope > span') ?? toggle;
    if (!(title instanceof HTMLElement)) {
        return '';
    }

    let text = '';
    for (const node of title.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.nodeValue ?? '';
            continue;
        }
        if (node instanceof HTMLElement && node.closest('a') === null) {
            text += node.textContent ?? '';
        }
    }

    return text.replace(/\s+/g, ' ').trim();
}

/**
 * Boxes the rows of a page in which `normalizeSettingsPresentation` read nothing.
 *
 * The Presets page is the case that needs this: it is a preset picker, a tab pair, and the panels
 * behind them, with no heading anywhere to say where a group starts or ends. The blocks a user
 * reads are named by a picker rather than by a title. So the rows are grouped the way the Extensions
 * pages group theirs, one pill at a time, and a divider the page drew still ends a group.
 *
 * The wrappers are descended first, because a block laid out per API keeps exactly one of them on
 * screen, and the rows a page shows are inside that one rather than beside it.
 *
 * @param {HTMLElement} scope the moved section
 * @returns {number} how many rows were boxed
 */
function boxDetailRows(scope) {
    let container = scope;
    for (let depth = 0; depth < 8; depth++) {
        const visible = [...container.children].filter(child => child.getBoundingClientRect().height > 0);
        if (visible.length !== 1 || visible[0].matches('script, style, hr')) {
            break;
        }
        container = visible[0];
    }

    return boxCardBody(container);
}

/**
 * Whether anything in a container would occupy space.
 *
 * A container's upload form is `display: none` inputs and nothing else, and pilling it would draw an
 * empty box under the row that names the page. Measured rather than inspected, so a form whose rows
 * an extension fills in later is not mistaken for an empty one.
 *
 * @param {HTMLElement} container
 * @returns {boolean}
 */
function hasVisibleRow(container) {
    for (const child of container.children) {
        if (child.getBoundingClientRect().height > 0) {
            return true;
        }
    }
    return false;
}

/**
 * Presents one moved detail page.
 *
 * A detail page is a single section in its own page, which changes what counts as a row: the plain
 * pass reads the provider blocks a Connections page holds side by side, but a detail page holds one
 * of them, filled out by one `form` the pass leaves opaque. So `normalizeSettingsPresentation` is applied to what it
 * can read, and then the rendered form is pilled on its own, at `h4` boundaries, because a
 * provider's `h4`s name its fields rather than sections of a settings page.
 *
 * What a form's heading means only resolves here, since upstream nests provider blocks inside a
 * provider section and the ancestors that make those `h4`s field labels are gone once the block has
 * moved. Nothing is restructured that the form did not already hold; the pill goes on the form
 * itself, so its own layout is unchanged.
 *
 * Idempotent: the form is found by its lack of a pill, not by a marker.
 *
 * @param {HTMLElement|null|undefined} scope the moved section
 * @param {{name?: string, rowLabel?: string}} [options] `name` labels the tab in the placeholder
 *   report; `rowLabel` is the row that opened it, which names the card inside
 * @returns {{pills: number, placeholders: string[]}} what the pass changed
 */
export function normalizeSettingsDetail(scope, options = {}) {
    const report = normalizeSettingsPresentation(scope, options);
    if (!(scope instanceof HTMLElement)) {
        return report;
    }

    const card = openNamedDrawer(scope, options.rowLabel);
    if (card !== null) {
        report.pills += boxCardBody(card);
    } else {
        report.pills += boxDetailRows(scope);
    }

    for (const form of scope.querySelectorAll('form')) {
        // The form itself is the pill; what must not be pilled is a form that is hidden, belongs to
        // a panel that presents itself, already sits inside a pill, or holds nothing a reader can
        // see. A container's upload form is three hidden inputs and no row.
        if (form.matches(SB_HIDDEN_SELECTOR) || form.classList.contains('hidden') || form.classList.contains('displayNone')) {
            continue;
        }
        if (form.closest('[data-sb-presentation="manual"]') !== null || form.closest(SB_HIDDEN_SELECTOR) !== null) {
            continue;
        }
        if (form.classList.contains(SB_PILL_SELECTOR.slice(1))) {
            continue;
        }
        if (form.parentElement?.closest(SB_PILL_SELECTOR) !== null) {
            continue;
        }
        if (form.querySelector(SB_CONTROL_SELECTOR) === null && form.childElementCount < 2) {
            continue;
        }
        if (!hasVisibleRow(form)) {
            continue;
        }

        form.classList.add('ds-pref-group', 'sb-settings-category-body');
        report.pills += form.childElementCount;
    }

    // Only the extensions SillyBunny ships get rows; the caller decides, and a third-party page keeps
    // the markup it was authored with.
    if (options.builtIn === true) {
        watchExtensionSettings(scope);
    }

    return report;
}

/** Input types an adopted entry row takes; password and number inputs have their own rows. */
const SB_EXT_ENTRY_TYPES = new Set(['text', 'url', 'search', 'email', 'tel']);

/** Controls that are already part of a row, or that a panel presents itself. */
const SB_EXT_DONE_SELECTOR = '.ds-row, .ds-select-row, .ds-row-entry--floating, [data-sb-presentation="manual"]';

/** Elements that can carry the text of a label when no `label` names the control. */
const SB_EXT_TITLE_SELECTOR = 'label, small, span, b, strong, h4, h5, .range-block-title';

/** Anything a title element must not hold, because retiring it would hide a control or a link. */
const SB_EXT_FOREIGN_SELECTOR = 'input, select, textarea, button, .menu_button, a, [role="button"]';

/** Buttons that sit beside a field, such as Connect or a refresh icon. */
const SB_EXT_ACTION_SELECTOR = 'button, .menu_button, .right_menu_button, input[type="submit"], input[type="button"]';

/** A form control, or an element that holds one. */
const SB_EXT_FIELD_SELECTOR = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea';

const SB_EXT_MAX_TITLE_LENGTH = 90;

/** Plain labels that wrap a checkbox and its text are switches too, where the extension did not use `checkbox_label`. */
const SB_EXT_SWITCH_LABELS = '.checkbox_label, label:has(> input[type="checkbox"])';

/**
 * Areas of an extension's page that the extension builds and lays out from script, per container.
 * `left` is left as the extension draws it, because it rebuilds those rows on its own schedule and
 * styles their parts by position. `entriesOnly` is a page of rows that each provider lays out with a
 * stylesheet of its own: there only the text fields are adopted, because a floating row sits in any
 * of those layouts and the other rows would fight them.
 * @type {ReadonlyMap<string, {left?: string, entriesOnly?: string}>}
 */
const SB_EXT_AREAS = new Map([
    ['qr_container', { left: '#qr--global, #qr--chat, #qr--character, #qr--editor > :not(#qr--set-settings)' }],
    // The script rows are shared entity rows that the extension's own adapter builds. Bulk Edit is a toggle button whose
    // checkbox is hidden state, not a switch for a row.
    ['regex_container', { left: '.regex-script-label, label[for="regex_bulk_edit"]' }],
]);

/**
 * Selects that the extension shows and hides itself with `.toggle()`, so their rows follow the select's own display. The
 * row cannot be left out of this: the extension never sees it.
 * @type {ReadonlySet<string>}
 */
const SB_EXT_TOGGLED_SELECTS = new Set(['deepl_api_endpoint']);

/**
 * Controls whose only name is their tooltip, which the row shows as its title. A control with a label of its own does not
 * need an entry here.
 * @type {ReadonlySet<string>}
 */
const SB_EXT_TITLED_BY_TOOLTIP = new Set(['deepl_api_endpoint']);

/** @type {WeakMap<HTMLElement, {sync?: () => void}>} */
const sbExtensionControllers = new WeakMap();

/** @type {WeakMap<HTMLElement, MutationObserver>} */
const sbExtensionObservers = new WeakMap();

/** @param {string} text */
function normalizeFieldTitle(text) {
    return text.replace(/\s+/g, ' ').trim().replace(/\s*[:：]\s*$/, '');
}

/**
 * The text a label shows for a control, without the controls, icons and help links inside it.
 * @param {Node} node
 * @returns {string}
 */
function readOwnLabelText(node) {
    let text = '';
    for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            text += child.nodeValue ?? '';
        } else if (child instanceof HTMLElement && !child.matches('input, select, textarea, button, .menu_button, a, i, svg, script, style, .sr-only')) {
            text += readOwnLabelText(child);
        }
    }
    return text;
}

/** @param {HTMLElement} control @param {HTMLElement} node */
function distanceToAncestor(control, node) {
    let steps = 0;
    for (let ancestor = control.parentElement; ancestor; ancestor = ancestor.parentElement, steps++) {
        if (ancestor.contains(node)) return steps;
    }
    return Infinity;
}

/**
 * The element right before a control whose text names it, when no `label` does.
 *
 * Only an element counts: text that sits loose in the wrapper cannot be retired once the row repeats
 * it, so a control behind such text reads as unlabelled rather than gaining a second title.
 *
 * @param {HTMLElement} control
 * @returns {HTMLElement|null}
 */
function findPrecedingTitle(control) {
    for (let node = control, depth = 0; node.parentElement && depth < 3; node = node.parentElement, depth++) {
        for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) {
            if (sibling.nodeType === Node.COMMENT_NODE) continue;
            if (sibling.nodeType === Node.TEXT_NODE) {
                if (sibling.nodeValue?.trim()) return null;
                continue;
            }
            if (!(sibling instanceof HTMLElement) || sibling.matches('script, style, br')) continue;
            if (sibling.matches('hr, .ds-row') || sibling.matches(SB_EXT_FOREIGN_SELECTOR) || sibling.querySelector(SB_EXT_FOREIGN_SELECTOR)) return null;
            if (!sibling.matches(SB_EXT_TITLE_SELECTOR)) return null;
            const text = normalizeFieldTitle(readOwnLabelText(sibling));
            return text && text.length <= SB_EXT_MAX_TITLE_LENGTH ? sibling : null;
        }
        // A wrapper that holds other fields would hand this control the title of a neighbour.
        if (node.parentElement.querySelectorAll(SB_EXT_FIELD_SELECTOR).length > 1) return null;
    }
    return null;
}

/**
 * What names a control: a `label` that points at it or wraps it, its `aria-label`, the text right
 * before it, and last its placeholder.
 *
 * @param {HTMLElement} control
 * @returns {{title: string, nodes: HTMLElement[], source: 'label'|'wrapping-label'|'aria-label'|'preceding'|'placeholder'}|null}
 *   `nodes` are the elements whose text the title repeats; the caller retires them once it shows the title.
 */
export function resolveFieldLabel(control) {
    const labels = [...(/** @type {HTMLInputElement} */ (control).labels ?? [])]
        .filter(label => label instanceof HTMLElement)
        .sort((a, b) => distanceToAncestor(control, a) - distanceToAncestor(control, b));
    for (const label of labels) {
        const title = normalizeFieldTitle(readOwnLabelText(label));
        if (title) return { title, nodes: [label], source: label.contains(control) ? 'wrapping-label' : 'label' };
    }

    const ariaLabel = normalizeFieldTitle(control.getAttribute('aria-label') ?? '');
    if (ariaLabel) return { title: ariaLabel, nodes: [], source: 'aria-label' };

    const preceding = findPrecedingTitle(control);
    if (preceding) return { title: normalizeFieldTitle(readOwnLabelText(preceding)), nodes: [preceding], source: 'preceding' };

    const placeholder = normalizeFieldTitle(control.getAttribute('placeholder') ?? '');
    if (placeholder) return { title: placeholder, nodes: [], source: 'placeholder' };

    return null;
}

/**
 * Hides a label whose text the row now shows. It stays in the document for whatever looks it up, and
 * leaves the control's label list, so the field is named once.
 * @param {HTMLElement} label
 */
function retireLabel(label) {
    if (label instanceof HTMLLabelElement && label.htmlFor) {
        label.dataset.sbAdoptedFor = label.htmlFor;
        label.removeAttribute('for');
    }
    label.dataset.sbAdoptedLabel = 'true';
    label.classList.add('sb-legacy-search-hidden');
}

/** The translation key a label carries, when the row can carry the same one. */
export function readLabelI18nKey(label) {
    const holder = label.dataset.i18n ? label : label.querySelector(':scope > [data-i18n]');
    const key = holder instanceof HTMLElement ? holder.dataset.i18n : '';
    return key && !key.includes('[') ? key : '';
}

/**
 * The action buttons that belong to a field: the ones in its label (a refresh icon) and the ones beside
 * it in a wrapper that holds nothing else but its title. They travel into the row's trailing slot, so
 * the field and its Connect button read as one row.
 *
 * @param {HTMLElement} control
 * @param {HTMLElement[]} titles the elements that name the control
 * @returns {{actions: HTMLElement[], bars: HTMLElement[]}} the buttons, and the title bars that hold nothing else afterwards
 */
function findTrailingActions(control, titles) {
    const actions = titles.flatMap(title => [...title.querySelectorAll(SB_EXT_ACTION_SELECTOR)]);
    const wrapper = control.parentElement;
    if (!(wrapper instanceof HTMLElement) || wrapper.closest('label')) return { actions, bars: [] };
    // A title bar holds the label and a button such as Refresh; once the row shows both, the bar is empty.
    const bars = titles.map(title => title.parentElement).filter(bar => bar instanceof HTMLElement && bar !== wrapper && !bar.contains(control)
        && [...bar.children].every(node => titles.includes(/** @type {HTMLElement} */ (node)) || node.matches(SB_EXT_ACTION_SELECTOR)));
    for (const bar of bars) actions.push(...[...bar.children].filter(node => node.matches(SB_EXT_ACTION_SELECTOR)));
    const siblings = [...wrapper.children].filter(node => node !== control && !node.matches('.select2-container') && !titles.includes(/** @type {HTMLElement} */ (node)));
    if (siblings.length > 0 && siblings.every(node => node.matches(SB_EXT_ACTION_SELECTOR))) actions.push(...siblings);
    return { actions: /** @type {HTMLElement[]} */ (actions), bars: /** @type {HTMLElement[]} */ (bars) };
}

/**
 * Whether a number input is a row of its own. A number that sits right beside another field (the depth
 * of an in-chat position, a slider's counter) is one part of a bigger row and keeps that row.
 * @param {HTMLElement} control
 */
function isStandaloneNumber(control) {
    if (control.dataset.for || control.closest('.range-block-counter, .ds-row-slider')) return false;
    return [control.previousElementSibling, control.nextElementSibling]
        .every(sibling => !(sibling instanceof HTMLElement) || sibling.matches(SB_EXT_ACTION_SELECTOR) || !(sibling.matches(SB_EXT_FIELD_SELECTOR) || sibling.querySelector(SB_EXT_FIELD_SELECTOR)));
}

/**
 * The description an option carries (`data-sb-description`). The select row shows it under its title while
 * the option is chosen, and the picker shows it under the option.
 * @param {{label?: string}} item
 * @param {HTMLOptionElement} option
 */
function describeOption(item, option) {
    const subtitle = option.dataset.sbDescription?.trim();
    return subtitle ? { ...item, subtitle } : item;
}

/**
 * A `small` hint that sits between a title and its control ("Won't be used in groups."), or before the wrapper that holds a
 * field with only its action buttons (Regex Presets). The row shows it as its own caption, so the caller hides the original.
 * @param {HTMLElement} control
 * @param {HTMLElement[]} titles
 * @returns {HTMLElement|null}
 */
function takeHintBefore(control, titles) {
    let anchor = control;
    const wrapper = control.parentElement;
    if (!control.previousElementSibling && wrapper && wrapper !== control.closest('.ds-row, .ds-pref-group')
        && [...wrapper.children].every(node => node === control || node.matches(SB_EXT_ACTION_SELECTOR))) {
        anchor = wrapper;
    }
    const hint = anchor.previousElementSibling;
    if (!(hint instanceof HTMLElement) || !hint.matches('small') || titles.includes(hint) || hint.querySelector(SB_EXT_FOREIGN_SELECTOR)) return null;
    return hint.textContent?.trim() ? hint : null;
}

/**
 * Moves the text of a hint into the caption of the row built for it, with its translation key, and hides what is left.
 * @param {HTMLElement} row
 * @param {HTMLElement|null} hint
 */
function carryHint(row, hint) {
    if (!hint) return;
    const caption = row.querySelector(':scope > .ds-row-text > .ds-row-subtitle:not(.ds-select-row__detail), :scope > .ds-row-textarea__caption');
    if (caption instanceof HTMLElement) moveCaption(caption, hint, { keepSource: true });
    hint.classList.add('sb-legacy-search-hidden');
}

/**
 * Gives a range the slider row. Other pages get theirs from the row pass, which leaves a range alone when
 * its wrapper holds several; an extension that lists its sliders one after another is such a wrapper.
 * The title (with the live value the extension writes into it), the range and a counter beside it move
 * into a row of their own at the range's place. A trailing `small` in the title ("0 = default") becomes
 * the subtitle, and a button in the title (a restore or auto-adjust icon) moves to the row's end.
 *
 * @param {HTMLInputElement} range
 * @param {{nodes: HTMLElement[], source: string}} found
 */
function adoptExtensionSlider(range, found) {
    const [title] = found.nodes;
    const counter = range.nextElementSibling instanceof HTMLInputElement && range.nextElementSibling.dataset.for === range.id ? range.nextElementSibling : null;
    const after = counter ?? range;
    // The section pass can pull a bare range into a group of its own and leave its label behind, so a label that names the range
    // by `for` travels to the range even when it no longer sits beside it.
    const adjacent = title?.nextElementSibling === range || title?.nextElementSibling === after;
    if (!(title instanceof HTMLElement) || (!adjacent && found.source !== 'label')) return false;

    const actions = [...title.querySelectorAll(SB_EXT_ACTION_SELECTOR)];
    const hint = [...title.querySelectorAll('small')].pop();
    const wrapper = document.createElement('div');
    (adjacent ? title : range).before(wrapper);
    wrapper.append(title, range, ...(counter ? [counter] : []));
    if (hint && hint.textContent?.trim() && title.textContent?.trim() !== hint.textContent.trim()) {
        hint.classList.add('ds-row-subtitle');
        wrapper.append(hint);
    }
    // `title_restorable` is the extension's bold, tracked heading for a label with a restore icon; a row title is a plain title.
    title.classList.remove('title_restorable');
    normalizeCustomizeField(wrapper, range, { subtitles: 'titled' });
    wrapper.querySelector(':scope > .ds-row-suffix')?.append(...actions);
    sbExtensionControllers.set(range, {});
    return true;
}

/**
 * Gives one control the row that fits it, inside the wrapper the extension put it in.
 *
 * @param {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement} control
 * @param {'entry'|'select'|'spin'|'textarea'} kind
 * @param {{title: string, nodes: HTMLElement[], source: string}} found
 * @returns {boolean}
 */
function adoptExtensionField(control, kind, found) {
    const field = control.id || control.name || 'extension-field';
    const marker = document.createComment('sb-adopt');
    control.before(marker);

    const { actions, bars } = findTrailingActions(control, found.nodes);
    let row;
    if (kind === 'select') {
        const hint = found.source === 'preceding' ? null : takeHintBefore(control, found.nodes);
        row = createSelectRow({
            select: /** @type {HTMLSelectElement} */ (control),
            label: found.title,
            subtitle: hint?.textContent?.trim() || undefined,
            field,
            noneLabel: control.dataset.placeholder ?? '',
            searchLabel: t`Search`,
            emptyText: t`No Results`,
            suffix: actions,
            mapItem: describeOption,
            followsHidden: SB_EXT_TOGGLED_SELECTS.has(control.id),
        });
        carryHint(row.row, hint);
    } else if (kind === 'textarea') {
        const subtitle = takeHintBefore(control, found.nodes);
        row = createTextAreaField({
            label: found.title,
            field,
            input: /** @type {HTMLTextAreaElement} */ (control),
            subtitle: subtitle?.textContent?.trim() || undefined,
            expandLabel: t`Expand the Editor`,
        });
        // A refresh or restore icon of the old title stays beside the label, ahead of Expand.
        for (const action of actions) row.expand ? row.labelRow.insertBefore(action, row.expand) : row.labelRow.append(action);
        // The extension drew its own Expand icon for this field; the row has one now.
        for (const own of document.querySelectorAll('.editor_maximize[data-for]:not(.ds-row-textarea__expand)')) {
            if (own instanceof HTMLElement && own.dataset.for === control.id && !row.row.contains(own)) own.classList.add('sb-legacy-search-hidden');
        }
        carryHint(row.row, subtitle);
    } else if (kind === 'spin') {
        row = createSpinRow({ label: found.title, field, input: /** @type {HTMLInputElement} */ (control), normalize: false });
        // Numeric keypads of some phones have no decimal point, so a fractional step asks for the decimal one.
        if (!Number.isInteger(Number(control.getAttribute('step') || 1))) /** @type {HTMLInputElement} */ (control).inputMode = 'decimal';
        row.row.querySelector('.ds-row-suffix')?.append(...actions);
    } else {
        row = createEntryRow({ label: found.title, field, input: /** @type {HTMLInputElement} */ (control), floating: true, suffix: actions });
        // The placeholder was the title, so repeating it as the accessible description adds nothing.
        if (found.source === 'placeholder' && control.getAttribute('aria-description') === found.title) control.removeAttribute('aria-description');
    }

    marker.replaceWith(row.row);
    sbExtensionControllers.set(control, row);
    const key = found.nodes[0] ? readLabelI18nKey(found.nodes[0]) : '';
    const caption = row.row.querySelector('.ds-row-label');
    if (key && caption instanceof HTMLElement) caption.dataset.i18n = key;
    for (const node of found.nodes) retireLabel(node);
    for (const bar of bars) bar.classList.add('sb-legacy-search-hidden');
    return true;
}

/**
 * Presents the settings of one built-in extension with the shared rows: switch and slider rows from the
 * row pass the other settings pages use, and select, spin and floating entry rows around the fields
 * that have a label. A control keeps its node, id, value and listeners, and a row stays inside the
 * wrapper the extension drew; the extension's own save path is the one it always had.
 *
 * Idempotent, because it runs again whenever the extension rebuilds part of its page.
 *
 * @param {HTMLElement} scope the extension's container
 * @returns {{selects: number, numbers: number, entries: number, textareas: number, sliders: number, left: {id: string, type: string, reason: string}[]}}
 */
export function normalizeExtensionSettings(scope) {
    const report = { selects: 0, numbers: 0, entries: 0, textareas: 0, sliders: 0, left: [] };
    if (!(scope instanceof HTMLElement)) return report;

    // Switches come from the row pass of the other pages; a tooltip becomes the subtitle and a row
    // without one stays a title, because this page has no copy to put under it.
    const { left: leftAreas = '', entriesOnly = '' } = SB_EXT_AREAS.get(scope.id) ?? {};
    normalizeBackendSettingsRows(scope, {
        labels: SB_EXT_SWITCH_LABELS,
        controls: 'input[type="range"]',
        subtitles: 'titled',
        skip: [leftAreas, entriesOnly].filter(Boolean).join(', '),
    });

    for (const control of scope.querySelectorAll('select, input, textarea')) {
        if (!(control instanceof HTMLSelectElement || control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) continue;
        if (control.closest('.ds-select-row')) {
            sbExtensionControllers.get(control)?.sync?.();
            continue;
        }
        if (control.closest(SB_EXT_DONE_SELECTOR) || control.matches('[hidden], .displayNone, .hidden')) continue;
        if (leftAreas && control.closest(leftAreas)) continue;

        const kind = control instanceof HTMLSelectElement
            ? (control.size > 1 ? null : 'select')
            : control instanceof HTMLTextAreaElement ? (control.readOnly ? null : 'textarea')
                : control.type === 'range' ? 'slider'
                    : control.type === 'number' ? 'spin' : SB_EXT_ENTRY_TYPES.has(control.type) ? 'entry' : null;
        if (!kind) continue;
        if (kind === 'spin' && (control.dataset.for || control.closest('.range-block-counter'))) continue;

        const leave = reason => report.left.push({ id: control.id, type: kind, reason });
        if (kind !== 'entry' && kind !== 'slider' && entriesOnly && control.closest(entriesOnly)) {
            leave('laid out by the provider');
            continue;
        }
        if (control.closest('label')) {
            leave('inside a label');
            continue;
        }
        if (kind === 'spin' && !isStandaloneNumber(control)) {
            leave('beside other controls');
            continue;
        }
        const tooltip = SB_EXT_TITLED_BY_TOOLTIP.has(control.id) ? normalizeFieldTitle(control.title) : '';
        const found = resolveFieldLabel(control) ?? (tooltip ? { title: tooltip, nodes: [], source: 'aria-label' } : null);
        if (!found) {
            leave('no label or placeholder');
            continue;
        }
        // A refresh icon in the label travels with the field; any other control or link would be hidden with it.
        if (found.nodes.some(node => [...node.querySelectorAll(SB_EXT_FOREIGN_SELECTOR)].some(inner => !inner.matches(SB_EXT_ACTION_SELECTOR)))) {
            leave('its label holds a control or a link');
            continue;
        }

        if (kind === 'slider') {
            if (adoptExtensionSlider(/** @type {HTMLInputElement} */ (control), found)) report.sliders++;
            else leave('its title is not right before it');
            continue;
        }
        adoptExtensionField(control, kind, found);
        report[kind === 'select' ? 'selects' : kind === 'spin' ? 'numbers' : kind === 'textarea' ? 'textareas' : 'entries']++;
    }

    adoptWrappedButtonRows(scope);
    adoptLooseButtonRows(scope);

    return report;
}

/**
 * Presents a built-in extension's settings now and again each time the extension adds markup to them,
 * as the Text-to-speech page does when another provider is picked.
 *
 * The observer reads only its own batch of changes: the rows this pass inserts are dropped from the
 * queue, so a pass never schedules another.
 *
 * @param {HTMLElement} scope
 */
export function watchExtensionSettings(scope) {
    const present = () => {
        normalizeExtensionSettings(scope);
        observer?.takeRecords();
    };
    let observer = sbExtensionObservers.get(scope);
    if (observer) {
        present();
        return;
    }

    observer = new MutationObserver(records => {
        const added = records.some(record => [...record.addedNodes].some(node => node instanceof HTMLElement));
        if (added) present();
    });
    sbExtensionObservers.set(scope, observer);
    present();
    observer.observe(scope, { childList: true, subtree: true });
}
