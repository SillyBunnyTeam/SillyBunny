import { t } from './i18n.js';
import { openActionMenu } from './sillybunny-action-menu.js';
import { createButtonRow, createEntryRow, createPrefGroup, createRow, createSwitchRow, createTextAreaField, moveCaption } from './sillybunny-editor/rows.js';
import { createProfileRow, createSelectRow } from './sillybunny-editor/select-row.js';
import { createToggleRow } from './sillybunny-editor/toggle-row.js';

/**
 * Customize > Appearance groups that SillyBunny builds. Upstream rows are moved into them, never recreated, because
 * `power-user.js`, `backgrounds.js` and the Bunny Preset Tools extension bind to their nodes by ID or class.
 */

const GROUP_CLASS = 'sb-appearance-group';

const textOf = node => node?.textContent.replace(/\s+/g, ' ').trim() ?? '';

/**
 * Hides a leftover of an upstream block whose rows have moved into a group. `[hidden]` alone loses to the
 * `display` of the flex and grid classes these nodes carry, so the order pass's own marker hides it as well.
 * @param {Element|null|undefined} node
 */
function retire(node) {
    if (!(node instanceof HTMLElement)) return;
    node.hidden = true;
    node.dataset.sbEmptiedByOrder = 'true';
}

/**
 * A boxed-list group that the settings normaliser leaves alone.
 * @param {object} options
 * @param {string} options.id
 * @param {string} [options.elementId]  The `id` of the group's section, for lookups that name it.
 * @param {string} options.title
 * @param {string} options.description
 * @param {{ title?: Element|null, description?: Element|null }} [options.source]  Upstream captions whose content and `data-i18n` move into the heading.
 */
export function createAppearanceGroup({ id, elementId, title, description, source = {} }) {
    const group = createPrefGroup({ title, subtitle: description, field: id, id: elementId });
    const { section } = group;
    section.classList.add(GROUP_CLASS);
    section.dataset.sbPresentation = 'manual';
    section.dataset.sbCategory = id;
    const heading = section.querySelector('.ds-pref-group-heading');
    const subtitle = section.querySelector('.ds-pref-group-subtitle');
    for (const [target, caption, text] of [[heading, source.title, title], [subtitle, source.description, description]]) {
        if (!target) continue;
        if (caption) moveCaption(target, caption, { keepSource: true });
        else target.dataset.i18n = text;
    }
    return group;
}

/**
 * The title and subtitle of the upstream row a control sits in. A label that wraps its text in a `small` yields that
 * `small`, so the new row's title does not nest one.
 * @param {Element|null|undefined} control
 */
function copyOf(control) {
    const row = control?.closest('.ds-row') ?? control?.parentElement;
    const found = row?.querySelector('.ds-row-label, :scope > label, :scope > span');
    const label = found?.querySelector(':scope > small') ?? found;
    const subtitle = row?.querySelector('.ds-row-subtitle');
    return { row, label, subtitle, labelText: textOf(label), subtitleText: textOf(subtitle) || undefined };
}

/** Moves the upstream captions of `copy` into the title and subtitle of the row built from it, so `data-i18n` survives. */
function carryCopy(controller, copy, { stripColon = false } = {}) {
    const title = controller.row.querySelector('.ds-row-label');
    if (title && copy.label) moveCaption(title, copy.label, { keepSource: true, stripColon });
    const subtitle = controller.row.querySelector('.ds-row-subtitle');
    if (subtitle && copy.subtitle) moveCaption(subtitle, copy.subtitle, { keepSource: true });
}

function actionMenuSections(holder) {
    const item = (selector, label, danger = false) => {
        const original = holder.querySelector(selector);
        return original ? [{ label, icon: original.querySelector('i')?.className, danger, onSelect: () => original.click() }] : [];
    };
    return [
        { items: [...item('#ui-preset-update-button', t`Update a theme file`), ...item('#ui-preset-save-button', t`Save as a new theme`)] },
        { items: [...item('#ui_preset_import_button', t`Import a theme file`), ...item('#ui_preset_export_button', t`Export a theme file`)] },
        { items: item('#ui-preset-delete-button', t`Delete a theme`, true) },
    ].filter(section => section.items.length);
}

/**
 * UI Theme: the theme select with its file actions in a trailing menu, the accent colour grid and Reset.
 * The save, update, import, export and delete buttons stay in the document, hidden, because `power-user.js` binds
 * each to its node and the menu clicks them.
 */
function presentTheme(container) {
    if (container.querySelector('[data-sb-category="ui-theme"]')) return;
    const select = container.querySelector('#themes');
    const block = container.querySelector('#UI-presets-block');
    if (!(select instanceof HTMLSelectElement) || !block) return;

    const heading = block.querySelector(':scope > h4 > span');
    const description = block.querySelector(':scope > small.ds-row-subtitle');
    const group = createAppearanceGroup({
        id: 'ui-theme',
        title: textOf(heading) || 'UI Theme',
        description: textOf(description) || 'Manage saved themes and choose accent colors for the interface.',
        source: { title: heading, description },
    });

    const holder = document.createElement('div');
    holder.hidden = true;
    holder.dataset.sbThemeActions = '';
    for (const selector of ['#ui-preset-update-button', '#ui-preset-save-button', '#ui_preset_import_button', '#ui_preset_export_button', '#ui-preset-delete-button', '#ui_preset_import_file']) {
        const node = container.querySelector(selector);
        if (node) holder.append(node);
    }

    const copy = copyOf(select);
    const themeRow = createProfileRow({
        select,
        label: copy.labelText,
        subtitle: copy.subtitleText,
        field: 'ui-theme',
        searchLabel: t`Search`,
        emptyText: t`No results`,
        menuLabel: t`Theme Actions`,
        onMenu: trigger => openActionMenu({ trigger, title: copy.labelText, sections: actionMenuSections(holder) }),
    });
    carryCopy(themeRow, copy);

    const rows = [themeRow];
    const presets = block.querySelector('.sb-accent-presets');
    if (presets) {
        const accentLabel = block.querySelector('.sb-accent-color-label');
        const accentRow = createRow({ label: textOf(accentLabel).replace(/[：:]$/, '').trim(), field: 'accent-colors', stacked: true, suffix: presets });
        rows.push(accentRow);
    }
    const reset = block.querySelector('.sb-theme-preset-reset');
    if (reset) {
        // The click handler is delegated on the class, so the row takes it from the button it replaces.
        const resetRow = createButtonRow({ label: reset.getAttribute('title') || textOf(reset), icon: 'rotate-left', field: 'theme-reset' });
        resetRow.row.classList.add('sb-theme-preset-reset');
        rows.push(resetRow);
    }
    group.append(...rows);
    group.section.append(holder);

    block.before(group.section);
    for (const child of block.children) {
        if (child !== group.section && !child.matches('#sb-theme-card')) retire(child);
    }
}

/**
 * Custom RGB Accent: a dependent set. The switch leads, and the two colour rows are insensitive while it is off.
 * The switch keeps its handler in `power-user.js`, which also shows and hides the emptied picker box: that is harmless.
 */
function presentCustomAccent(container) {
    if (container.querySelector('[data-sb-category="custom-accent"]')) return;
    const toggle = container.querySelector('#sb-custom-accent-mode');
    if (!(toggle instanceof HTMLInputElement)) return;

    const oldLabel = toggle.closest('label');
    const title = oldLabel?.querySelector(':scope > span');
    // The upstream subtitle belongs to the switch it describes; the group states what its two colour rows are.
    const group = createAppearanceGroup({
        id: 'custom-accent',
        title: textOf(title) || 'Custom RGB Accent',
        description: 'Choose your own primary and secondary accent colors.',
        source: { title },
    });
    // The settings normaliser pointed the switch at captions that the group now holds.
    toggle.removeAttribute('aria-labelledby');
    const rows = [createSwitchRow({ label: textOf(title) || 'Custom RGB Accent', field: 'custom-accent', input: toggle })];
    for (const [selector, field] of [['#sb-accent-primary-picker', 'accent-primary'], ['#sb-accent-secondary-picker', 'accent-secondary']]) {
        const picker = container.querySelector(selector);
        if (!picker) continue;
        const label = picker.closest('.sb-accent-picker-row')?.querySelector('.sb-accent-picker-label');
        const row = createRow({ label: textOf(label), field, suffix: picker });
        const caption = row.row.querySelector('.ds-row-label');
        caption.id ||= `sb-setting-${picker.id}-label`;
        picker.setAttribute('role', 'group');
        picker.setAttribute('aria-labelledby', caption.id);
        rows.push(row);
    }
    group.append(...rows);
    group.group.dataset.sbEnabledBy = '#sb-custom-accent-mode';
    group.section.dataset.sbCategory = 'custom-accent';

    const anchor = container.querySelector('[data-sb-category="ui-theme"]') ?? oldLabel;
    anchor?.after(group.section);
    retire(oldLabel);
}

/** The fonts module and the host that owns its settings, loaded when the Font group first needs them. */
async function loadFonts() {
    const { loadFontsModule } = await import('./power-user.js');
    return loadFontsModule();
}

/**
 * The Font Actions menu: Import Font, and Remove Font alone in a last section while an imported font is selected.
 * @param {HTMLSelectElement} select
 * @param {HTMLInputElement} importInput
 */
function fontMenuSections(select, importInput) {
    const sections = [{ items: [{ label: t`Import Font`, icon: 'fa-solid fa-file-import', onSelect: () => importInput.click() }] }];
    if (select.selectedOptions[0]?.dataset.sbFontKind === 'imported') {
        const family = select.value;
        sections.push({
            items: [{
                label: t`Remove Font`,
                icon: 'fa-solid fa-trash-can',
                danger: true,
                onSelect: async () => {
                    const { fonts, host } = await loadFonts();
                    await fonts.removeFontFamily(family, host);
                },
            }],
        });
    }
    return sections;
}

/**
 * Font Settings: one select over the presets, the imported fonts and, while one is saved, a legacy Google name, with its
 * actions in a trailing menu. The select keeps its id and handler in `power-user.js`; the fonts module rebuilds its options.
 */
function presentFont(container) {
    if (container.querySelector('[data-sb-category="font"]')) return;
    const presetSelect = container.querySelector('#google_font_preset');
    const importInput = container.querySelector('#sb_font_import_input');
    const block = container.querySelector('#GoogleFont-block');
    if (!(presetSelect instanceof HTMLSelectElement) || !(importInput instanceof HTMLInputElement) || !block) return;

    const bodyCopy = block.querySelector(':scope > small, :scope > .sb-settings-subdrawer-body > small');
    const group = createAppearanceGroup({
        id: 'font',
        title: 'Font Settings',
        description: textOf(bodyCopy) || 'Change SillyBunny\'s body font to any custom font. Defaults to Adwaita Sans.',
        source: { description: bodyCopy },
    });

    const presetCopy = copyOf(presetSelect);
    const presetRow = createProfileRow({
        select: presetSelect,
        label: presetCopy.labelText,
        subtitle: presetCopy.subtitleText,
        field: 'google-font-preset',
        searchLabel: t`Search`,
        emptyText: t`No results`,
        menuLabel: t`Font Actions`,
        onMenu: trigger => openActionMenu({ trigger, title: presetCopy.labelText, sections: fontMenuSections(presetSelect, importInput) }),
    });
    carryCopy(presetRow, presetCopy);

    // A saved Google Fonts name still loads from Google, so while it is chosen the subtitle says so in place of the local-font one.
    const subtitle = presetRow.row.querySelector('.ds-row-text > .ds-row-subtitle:not(.ds-select-row__detail)');
    const localSubtitle = { text: subtitle?.textContent ?? '', i18n: subtitle?.dataset.i18n };
    const syncSubtitle = () => {
        if (!subtitle) return;
        const google = presetSelect.dataset.sbFontSource === 'google';
        if (google) {
            subtitle.textContent = t`TODO(copy)`;
            subtitle.dataset.sbCopyPlaceholder = 'true';
            delete subtitle.dataset.i18n;
        } else {
            subtitle.textContent = localSubtitle.text;
            delete subtitle.dataset.sbCopyPlaceholder;
            if (localSubtitle.i18n) subtitle.dataset.i18n = localSubtitle.i18n;
        }
    };
    new MutationObserver(syncSubtitle).observe(presetSelect, { attributes: true, attributeFilter: ['data-sb-font-source'] });
    syncSubtitle();

    importInput.addEventListener('change', async () => {
        const files = [...importInput.files];
        importInput.value = '';
        if (!files.length) return;
        try {
            const { fonts, host } = await loadFonts();
            await fonts.importFontFiles(files, host);
        } catch (error) {
            console.error('Could not import the font.', error);
            globalThis.toastr?.error(t`Import failed`);
        }
    });

    group.append(presetRow);
    group.section.append(importInput);
    block.before(group.section);
    retire(block);
}

/**
 * Custom CSS: a text-area field. The save indicator and the AI wand stay in the label row beside Expand,
 * and keep the ids and handlers `power-user.js` binds.
 */
function presentCustomCss(container) {
    if (container.querySelector('[data-sb-category="custom-css"]')) return;
    const textarea = container.querySelector('#customCSS');
    const block = container.querySelector('#CustomCSS-block');
    if (!(textarea instanceof HTMLTextAreaElement) || !block) return;

    const copy = copyOf(textarea);
    const group = createAppearanceGroup({
        id: 'custom-css',
        title: 'Custom CSS',
        description: copy.subtitleText || 'Apply a custom CSS style to the whole SillyBunny interface.',
        source: { description: copy.subtitle },
    });
    textarea.classList.remove('ds-control-flex', 'margin0', 'margin-r5');
    const field = createTextAreaField({
        label: copy.labelText || 'Custom CSS',
        field: 'custom-css',
        input: textarea,
        expandLabel: t`Expand the editor`,
    });
    if (copy.label) moveCaption(field.row.querySelector('.ds-row-label'), copy.label, { keepSource: true });
    const indicator = container.querySelector('#custom_css_save_state');
    const wand = container.querySelector('#custom_css_ai_wand');
    const actions = [indicator, wand].filter(Boolean);
    if (actions.length) field.expand.before(...actions);
    // The old Expand icon and the toolbar line are replaced by the field's own Expand button and the group description.
    for (const stale of block.querySelectorAll('.editor_maximize[data-for="customCSS"]')) stale.remove();
    group.append(field);
    block.before(group.section);
    retire(block);
}

/**
 * Moves the background fitting select out of the gallery header into a select row of the Background group, and turns
 * the gallery into a plain block of that group. The header keeps the Auto-select, New Folder and Add Background
 * buttons and the filter and sort of the gallery, which `backgrounds.js` binds by id.
 * @param {HTMLElement} gallery  `#backgrounds-button`.
 * @returns {object|null}  The fitting row, or null when it was built already.
 */
export function presentBackgroundGallery(gallery) {
    const select = gallery.querySelector('#background_fitting');
    if (!(select instanceof HTMLSelectElement) || select.closest('.ds-select-row')) return null;

    const copy = copyOf(select);
    const row = createSelectRow({
        select,
        label: copy.labelText,
        subtitle: copy.subtitleText,
        field: 'background-fitting',
        searchLabel: t`Search`,
        emptyText: t`No results`,
    });
    carryCopy(row, copy);
    // What is left of the old row is a bar of three buttons.
    copy.row?.querySelector(':scope > .ds-row-text')?.remove();
    copy.row?.classList.add('ds-row-actions');
    gallery.querySelector('#bg-header-fixed')?.classList.remove('ds-pref-group');
    return row;
}

/**
 * The Animated Background thumbnails switch, as a switch row. The settings pass leaves a Background group alone, so
 * the upstream label is rebuilt here when that pass has not already made it a row.
 * @param {HTMLInputElement} input  `#background_thumbnails_animation`.
 * @returns {HTMLElement}
 */
export function presentBackgroundSwitch(input) {
    const label = input.closest('label');
    if (label?.classList.contains('ds-row')) return label;
    const title = label?.querySelector(':scope > small, :scope > span');
    const row = createSwitchRow({ label: textOf(title), subtitle: label?.title || undefined, field: 'background-thumbnails-animation', input });
    if (title) moveCaption(row.row.querySelector('.ds-row-label'), title, { keepSource: true });
    const subtitle = row.row.querySelector('.ds-row-subtitle');
    if (subtitle && label?.title) subtitle.dataset.i18n = label.title;
    label?.remove();
    return row.row;
}

/**
 * Animated Backgrounds: the panel Bunny Preset Tools injects becomes a group in place. Its nodes move; the extension
 * binds them by id and class. The URL field is a floating entry row whose button is the suffix.
 * @param {HTMLElement} panel  `#bpt-animated-bg-panel`.
 * @returns {boolean}  Whether the panel was presented.
 */
export function presentAnimatedBackgrounds(panel) {
    if (panel.dataset.sbBackgroundPresented === 'true') return false;
    const title = panel.querySelector('.bpt-animated-bg-title');
    const note = panel.querySelector('.bpt-animated-bg-note');
    const controls = panel.querySelector('.bpt-animated-bg-controls');
    const urlRow = panel.querySelector('.bpt-animated-bg-url-row');
    const url = urlRow?.querySelector('input');
    const apply = urlRow?.querySelector('button');
    const sources = panel.querySelector('#bpt-animated-bg-sources');
    if (!title || !note || !controls || !(url instanceof HTMLInputElement) || !apply) return false;

    const group = createAppearanceGroup({
        id: 'animated-backgrounds',
        title: textOf(title),
        description: textOf(note),
    });
    // The extension's own title and note become the group's heading and description.
    title.classList.add('ds-pref-group-heading');
    title.id ||= 'sb-animated-backgrounds-heading';
    title.setAttribute('role', 'heading');
    title.setAttribute('aria-level', '3');
    note.classList.add('ds-pref-group-subtitle');
    note.id ||= 'sb-animated-backgrounds-note';
    group.group.setAttribute('aria-labelledby', title.id);
    group.group.setAttribute('aria-describedby', note.id);
    group.section.querySelector('.ds-pref-group-header').replaceChildren(title, note);
    // The upstream-injected row has no caption of its own, so the field's title is SillyBunny's.
    const entry = createEntryRow({ label: t`Video URL`, field: 'animated-background-url', input: url, floating: true, suffix: [apply] });
    urlRow.remove();

    const box = group.group;
    box.append(entry.row, ...controls.children);
    if (sources) box.append(sources);
    controls.remove();

    panel.classList.add(...group.section.classList);
    panel.dataset.sbPresentation = 'manual';
    panel.dataset.sbCategory = 'animated-backgrounds';
    panel.dataset.sbBackgroundPresented = 'true';
    panel.replaceChildren(...group.section.children);
    return true;
}

/** Builds the groups of the Appearance page that SillyBunny owns. Safe to call again. */
export function presentAppearance(container) {
    if (!(container instanceof HTMLElement)) return;
    presentTheme(container);
    presentCustomAccent(container);
    presentFont(container);
    presentCustomCss(container);
}

/**
 * Zen Sliders and Mad Lab Mode as one exclusive choice of three (neither, Zen Sliders, Mad Lab Mode).
 *
 * Upstream keeps the two as separate checkboxes, `#enableZenSliders` and `#enableLabMode`, and stores them as the booleans
 * `power_user.enableZenSliders` and `power_user.enableLabMode`. Those inputs stay in the document as the transport: their
 * `input` handlers write the booleans, run the switch functions and save. This control only drives them.
 */
/**
 * The switch functions in `power-user.js` wait 100 ms before they change the page. Turning one mode off and the other on
 * without a gap would let the second pass start before the first one has reset the sliders.
 */
const SWITCH_SETTLE_MS = 150;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {boolean} zen
 * @param {boolean} lab
 * @returns {'none'|'zen'|'lab'}
 */
export function readSliderMode(zen, lab) {
    if (zen) return 'zen';
    return lab ? 'lab' : 'none';
}

/**
 * Writes the choice through the two upstream inputs: the mode that is not chosen goes off first, so the upstream rule that
 * rejects one mode while the other is on never fires.
 * @param {'none'|'zen'|'lab'} mode
 * @param {{ zen: HTMLInputElement, lab: HTMLInputElement }} inputs
 * @param {(ms: number) => Promise<void>} [settle]
 */
export async function chooseSliderMode(mode, { zen, lab }, settle = wait) {
    const write = (input, on) => {
        if (input.checked === on) return false;
        input.checked = on;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    };
    const switchedOff = [mode !== 'zen' && write(zen, false), mode !== 'lab' && write(lab, false)].some(Boolean);
    if (switchedOff && mode !== 'none') await settle(SWITCH_SETTLE_MS);
    if (mode === 'zen') write(zen, true);
    if (mode === 'lab') write(lab, true);
}

/**
 * Builds the row over the two inputs and keeps it in step with them: the upstream settings load and the switch functions
 * set the inputs and fire `input`, so the row follows those events.
 * @param {{ zen: HTMLInputElement, lab: HTMLInputElement }} inputs
 * @returns {HTMLElement}
 */
export function createSliderModeRow(inputs) {
    const choices = [
        ['none', t`None`],
        ['zen', t`Zen Sliders`],
        ['lab', t`Mad Lab Mode`],
    ];
    const current = () => readSliderMode(inputs.zen.checked, inputs.lab.checked);
    let queue = Promise.resolve();
    const toggle = createToggleRow({
        label: t`Slider Mode`,
        field: 'slider-mode',
        id: 'sb-slider-mode',
        choices,
        value: current(),
        onChange: mode => {
            queue = queue.then(() => chooseSliderMode(mode, inputs)).catch(error => console.warn('Could not change the slider mode.', error));
        },
    });
    const titles = {
        zen: t`Alternative UI for numeric sampling parameters with fewer steps.`,
        lab: t`Entirely unrestrict all numeric sampling parameters.`,
    };
    toggle.group.querySelectorAll('.sb-boolean-radio-option').forEach((option, index) => {
        const title = titles[choices[index][0]];
        if (title) option.title = title;
    });
    const follow = () => toggle.setValue(current());
    inputs.zen.addEventListener('input', follow);
    inputs.lab.addEventListener('input', follow);
    return toggle.row;
}
