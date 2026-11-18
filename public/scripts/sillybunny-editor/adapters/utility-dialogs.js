import { t } from '../../i18n.js';
import { createButtonRow, createEntryRow, createPrefGroup, createSpinRow, createTextAreaField, moveCaption, releaseRowIds } from '../rows.js';
import { createToggleRow } from '../toggle-row.js';
import { createProfileRow, createSelectRow } from '../select-row.js';

function asElement(source) {
    const root = source?.jquery ? source.get(0) : source;
    if (root instanceof HTMLElement) return root;
    throw new TypeError('A utility dialog needs an HTML element.');
}

function textOf(node) {
    return node?.textContent.replace(/\s+/g, ' ').trim() ?? '';
}

function entryRow(input, caption, subtitle) {
    const floating = input instanceof HTMLInputElement && ['text', 'url', 'search', 'email', 'tel'].includes(input.type);
    const row = createEntryRow({ label: textOf(caption), subtitle, field: input.id || input.name, input, floating });
    if (input instanceof HTMLTextAreaElement) row.row.classList.add('ds-row--stacked');
    moveCaption(row.row.querySelector('.ds-row-label'), caption);
    return row;
}

/**
 * Popup still creates, validates and collects custom inputs; only their presentation moves.
 * The rows are built in `onOpening`: `onOpen` waits for the opening animation, and the upstream form would show until then.
 */
export function utilityFormOptions({ title, mainLabel = null, clearContent = false } = {}) {
    return {
        tier: 'dialog',
        ...(title ? { title } : {}),
        onOpening(popup) {
            const rows = [];
            if (mainLabel) {
                rows.push(createEntryRow({ label: mainLabel, field: 'main-input', input: popup.mainInput }));
                if (popup.mainInput.rows > 3) rows[0].row.classList.add('ds-row--stacked');
            }
            for (const label of [...popup.inputControls.querySelectorAll('label.text_label, .ds-row-switch')]) {
                if (label.classList.contains('ds-row-switch')) {
                    rows.push({ row: label, control: label.querySelector('input') });
                    continue;
                }
                const input = label.querySelector('input, textarea');
                if (!input) throw new TypeError('A custom dialog field needs its source control.');
                const caption = label.querySelector('span');
                if (input.type === 'number') {
                    const row = createSpinRow({ label: textOf(caption), subtitle: input.title, field: input.id, input, normalize: false });
                    moveCaption(row.row.querySelector('.ds-row-label'), caption);
                    rows.push(row);
                } else {
                    rows.push(entryRow(input, caption, input.title));
                }
            }
            // An Alert keeps its heading in the content, and `aria-labelledby` points at that heading.
            if (clearContent) popup.content.replaceChildren(...popup.content.querySelectorAll(':scope > .sb-dialog__heading'));
            popup.content.classList.add('sb-dialog-rows');
            popup.content.append(createPrefGroup({ field: 'utility-fields', rows }).section);
            popup.inputControls.replaceChildren();
            popup.inputControls.style.display = 'none';
            rows[0]?.control.focus({ preventScroll: true });
        },
        onClose(popup) { releaseRowIds(popup.content); },
    };
}

/** Radio identity and native input events remain the source of the selected import/output target. */
function segmentedRow(labels, caption, field) {
    const inputs = labels.map(label => label.querySelector('input[type="radio"]'));
    if (inputs.length < 2 || inputs.some(input => !input)) throw new TypeError('A segmented dialog needs its source radios.');
    const captions = labels.map(label => label.querySelector('span'));
    const row = createToggleRow({
        label: textOf(caption), field, fill: true, inputs,
        choices: inputs.map((input, index) => [input.value, textOf(captions[index])]),
        value: inputs.find(input => input.checked)?.value,
    });
    moveCaption(row.row.querySelector('.ds-row-label'), caption);
    const segments = [...row.group.querySelectorAll('.sb-boolean-radio-option > span')];
    captions.forEach((source, index) => moveCaption(segments[index], source));
    return row;
}

export function regexImportOptions(source) {
    const root = asElement(source);
    const heading = root.querySelector('h3');
    const row = segmentedRow([...root.querySelectorAll('label')], null, 'regex-import-target');
    // Reuse the upstream heading for both the frame title and the named row.
    row.row.querySelector('.ds-row-label').textContent = textOf(heading);
    row.row.querySelector('.ds-row-label').dataset.i18n = heading.dataset.i18n;
    root.className = 'sb-dialog-rows';
    root.replaceChildren(heading, createPrefGroup({ field: 'regex-import', rows: [row] }).section);
    return { tier: 'dialog', onClose() { releaseRowIds(root); } };
}

export function quickReplyTransferOptions(source) {
    const root = asElement(source);
    const select = root.querySelector('select');
    if (!select) throw new TypeError('A Quick Reply transfer needs its source select.');
    const hint = root.querySelector('p');
    const row = createSelectRow({ select, label: t`Quick Reply Set`, field: 'quick-reply-target', searchLabel: t`Search`, emptyText: t`No results` });
    const group = createPrefGroup({ field: 'quick-reply-transfer', subtitle: textOf(hint), rows: [row] });
    moveCaption(group.section.querySelector('.ds-pref-group-subtitle'), hint?.querySelector('small'));
    root.classList.add('sb-dialog-rows');
    root.replaceChildren(...[root.querySelector('h3'), root.querySelector('h4'), group.section].filter(Boolean));
    for (const type of ['keydown', 'keyup']) {
        row.trigger.addEventListener(type, event => {
            if (event.key !== 'Shift' && event.key !== 'Enter') return;
            if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
            }
            select.dispatchEvent(new KeyboardEvent(type, { key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, bubbles: true }));
        });
    }
    return {
        tier: 'dialog',
        onOpening() { row.trigger.focus({ preventScroll: true }); },
        onClose() {
            // Destroying the row returns the select to its old parent, which the caller reads after the dialog resolves.
            row.destroy();
            releaseRowIds(root);
        },
    };
}

export function scraperDialogOptions(source, kind) {
    const root = asElement(source);
    const rows = [];
    if (kind === 'mediawiki' || kind === 'fandom') {
        for (const input of root.querySelectorAll('input[type="text"]')) {
            const block = input.parentElement;
            const caption = block.querySelector('label');
            const notes = [...block.querySelectorAll('i, small')];
            const row = entryRow(input, caption, notes.map(textOf).join(' '));
            row.row.querySelector('.ds-row-subtitle')?.replaceChildren(...notes);
            rows.push(row);
        }
        const radios = [...root.querySelectorAll('input[type="radio"]')].map(input => input.closest('label'));
        const caption = radios[0].parentElement.querySelector('label:not([for])');
        const output = segmentedRow(radios, caption, 'scrape-output');
        const descriptions = radios.map(label => label.querySelector('small')).filter(Boolean);
        const group = createPrefGroup({ field: 'scrape-output', subtitle: descriptions.map(textOf).join(' '), rows: [output] });
        group.section.querySelector('.ds-pref-group-subtitle').replaceChildren(...descriptions);
        root.replaceChildren(createPrefGroup({ field: 'scrape-fields', rows }).section, group.section);
    } else if (kind === 'youtube') {
        const input = root.querySelector('input');
        rows.push(entryRow(input, input.previousElementSibling));
        root.querySelector(':scope > label:last-child')?.remove();
        root.append(createPrefGroup({ field: 'scrape-language', rows }).section);
    } else if (kind !== 'web') {
        throw new TypeError(`Unknown scraper dialog: ${kind}`);
    }
    root.classList.add('sb-dialog-rows');
    const mainLabel = kind === 'web' ? textOf(root) : kind === 'youtube' ? t`Video ID:` : null;
    const title = { web: t`Web`, mediawiki: t`MediaWiki`, fandom: t`Fandom`, youtube: t`YouTube` }[kind];
    return {
        tier: 'dialog', title,
        onOpening(popup) {
            if (!mainLabel) {
                rows[0]?.control.focus({ preventScroll: true });
                return;
            }
            const row = createEntryRow({ label: mainLabel, field: 'scrape-source', input: popup.mainInput });
            if (kind === 'web') {
                row.row.classList.add('ds-row--stacked');
                if (root.dataset.i18n) row.row.querySelector('.ds-row-label').dataset.i18n = root.dataset.i18n;
                root.removeAttribute('data-i18n');
                root.replaceChildren();
            }
            root.append(createPrefGroup({ field: 'scrape-source', rows: [row] }).section);
            popup.mainInput.focus({ preventScroll: true });
        },
        onClose(popup) { releaseRowIds(popup.content); },
    };
}

/**
 * The TabbyAPI model downloader keeps its inputs, names and values: the caller reads them by `name` from the template root after
 * the popup closes. The captions come from the template, so the Repo ID text node and the translated labels stay as written.
 */
export function tabbyDownloaderOptions(source) {
    const root = asElement(source);
    const content = root.firstElementChild;
    const control = name => content?.querySelector(`[name="${name}"]`);
    const [repo, revision, folder, token, include, exclude] = ['hf_repo_id', 'revision', 'folder_name', 'hf_token', 'tabby_download_include', 'tabby_download_exclude'].map(control);
    const repoCaption = [...content?.childNodes ?? []].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    if (![repo, revision, folder, token, include, exclude].every(Boolean) || !repoCaption) {
        throw new TypeError('The Tabby downloader needs its six source fields and the Repo ID caption.');
    }

    // The captions of the two groups of help text are `.range-block-title` rows; each holds a title and an info icon whose tooltip is the help.
    const [optionsTitle, includeTitle, excludeTitle] = content.querySelectorAll('.range-block-title');
    const helpOf = title => title.querySelector('[title]')?.title.replace(/\s+/g, ' ').trim() ?? '';
    const captionOf = input => input.parentElement.querySelector('label small');

    const caption = document.createElement('span');
    caption.textContent = repoCaption.textContent.trim();
    const repoRow = entryRow(repo, caption);
    const optionRows = [revision, folder, token].map(input => entryRow(input, captionOf(input)));
    const patternRows = [[include, includeTitle], [exclude, excludeTitle]].map(([input, title]) => entryRow(input, title.querySelector('span'), helpOf(title)));

    // The two help lines and the link to the downloader's notes read as the description of the first group.
    const notes = content.querySelector('h3 a.notes-link');
    const intro = [...content.querySelectorAll(':scope > small')];
    const groups = [
        createPrefGroup({ field: 'tabby-repo', subtitle: intro.map(textOf).join(' '), rows: [repoRow] }),
        createPrefGroup({ field: 'tabby-options', title: textOf(optionsTitle.querySelector('span')), subtitle: helpOf(optionsTitle), rows: optionRows }),
        createPrefGroup({ field: 'tabby-patterns', rows: patternRows }),
    ];
    const optionsKey = optionsTitle.querySelector('span').dataset.i18n;
    if (optionsKey) groups[1].section.querySelector('.ds-pref-group-heading').dataset.i18n = optionsKey;
    if (notes) groups[0].section.querySelector('.ds-pref-group-subtitle')?.append(' ', notes);
    root.classList.add('sb-dialog-rows');
    root.replaceChildren(...groups.map(group => group.section));
    return {
        tier: 'dialog',
        title: t`Download Model`,
        onOpening() { repoRow.control.focus({ preventScroll: true }); },
        onClose() { releaseRowIds(root); },
    };
}

export function iconPickerOptions(source) {
    const root = asElement(source);
    const input = root.querySelector('input.faQuery');
    if (!input) throw new TypeError('An icon picker needs its source search input.');
    const row = createEntryRow({ label: input.placeholder, field: 'icon-search', input, floating: true });
    input.placeholder = ' ';
    root.querySelector('.faQuery-container').replaceChildren(createPrefGroup({ field: 'icon-search', rows: [row] }).section);
    for (const icon of root.querySelectorAll('.faPicker > [data-result]')) {
        icon.setAttribute('role', 'button');
        icon.setAttribute('aria-label', icon.title);
        icon.tabIndex = 0;
        icon.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            icon.click();
        });
    }
    return {
        tier: 'dialog', title: t`Choose Icon`,
        onOpening(popup) {
            popup.dlg.classList.add('sb-icon-picker');
            // Picking an icon is the action; No Icon clears the choice, so it is not the suggested response.
            popup.okButton.classList.add('is-plain');
            input.focus({ preventScroll: true });
        },
        onClose() { releaseRowIds(root); },
    };
}

// The Regex extension's script rows.

// A script that already lives in the list it would move to has no such action.
const MOVE_TARGET_OWN_LIST = '#global_scripts_block .move_to_global, #preset_scripts_block .move_to_preset, #scoped_scripts_block .move_to_scoped';

function iconButton(label, glyph, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ds-entity-row__button ${className}`;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-haspopup', 'menu');
    const icon = document.createElement('i');
    icon.className = `fa-solid fa-${glyph}`;
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
    return button;
}

/**
 * Builds the list that holds a group of regex scripts. Call it before the rows are added.
 * @param {HTMLElement} container One of the three script lists.
 */
export function adoptRegexScriptList(container) {
    container.classList.add('ds-entity-list__rows');
    container.setAttribute('role', 'list');
}

/**
 * Turns a script row from the upstream template into a shared entity row: a grip, the name, a switch and a menu.
 * Every upstream node stays in the row with its handlers, so the actions the menu offers are the template's own buttons.
 * @param {HTMLElement} row The cloned template, with its handlers bound.
 */
export function adoptRegexScriptRow(row) {
    row.classList.add('ds-entity-row', 'ds-entity-row--activatable');
    // The settings normaliser would read the row's checkboxes and buttons as settings of their own.
    row.setAttribute('data-sb-presentation', 'manual');
    row.setAttribute('role', 'listitem');

    const grip = row.querySelector(':scope > .drag-handle');
    grip?.classList.add('ds-entity-row__grip');

    const name = row.querySelector('.regex_script_name');
    const text = document.createElement('div');
    text.className = 'ds-entity-row__text';
    name.classList.add('ds-entity-row__title');
    name.replaceWith(text);
    text.append(name);

    row.querySelector('.regex_bulk_checkbox').setAttribute('aria-label', t`Select ${name.textContent}`);

    const disable = row.querySelector('.disable_regex');
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.className = 'sb-switch regex-script-switch';
    enabled.setAttribute('role', 'switch');
    enabled.setAttribute('aria-label', t`Enable ${name.textContent}`);
    enabled.checked = !disable.checked;
    enabled.addEventListener('change', () => {
        disable.checked = !enabled.checked;
        disable.dispatchEvent(new Event('input', { bubbles: true }));
    });
    disable.addEventListener('input', () => { enabled.checked = !disable.checked; });
    const target = document.createElement('label');
    target.className = 'regex-script-switch-target';
    target.append(enabled);

    const more = iconButton(t`Actions for ${name.textContent}`, 'ellipsis-vertical', 'regex-script-menu');
    more.addEventListener('click', async () => {
        const { openActionMenu } = await import('../../sillybunny-action-menu.js');
        const item = (selector, icon, danger = false) => {
            const button = row.querySelector(selector);
            return button && !button.matches(MOVE_TARGET_OWN_LIST)
                ? { label: button.title, icon: `fa-solid fa-${icon}`, danger, onSelect: () => button.click() }
                : null;
        };
        openActionMenu({
            trigger: more,
            title: name.textContent,
            sections: [
                { items: [item('.edit_existing_regex', 'pencil')].filter(Boolean) },
                { items: [item('.move_to_global', 'globe'), item('.move_to_preset', 'sliders'), item('.move_to_scoped', 'address-card'), item('.export_regex', 'file-export')].filter(Boolean) },
                { items: [item('.delete_regex', 'trash', true)].filter(Boolean) },
            ],
            bounds: row.closest('#sb-settings-page') ?? null,
        });
    });

    const suffix = document.createElement('div');
    suffix.className = 'ds-entity-row__suffix';
    suffix.append(target, more);

    // The template's own controls keep their place in the document for the code that finds them; the row shows the shared ones.
    const original = row.querySelector(':scope > .flex-container');
    original.hidden = true;
    row.append(suffix);

    // A click that the menu or a test sends to a template button bubbles to the row, which must not answer it again.
    row.addEventListener('click', event => {
        if (event.target instanceof Element && event.target.closest('.regex_bulk_checkbox, .drag-handle, .ds-entity-row__suffix, [hidden]')) return;
        // The checkbox is shown in bulk edit only; there the whole row selects the script.
        const selection = row.querySelector('.regex_bulk_checkbox');
        if (getComputedStyle(selection).display !== 'none') selection.click();
        else row.querySelector('.edit_existing_regex').click();
    });
}

// The injection positions of Summarize and Vector Storage.

/**
 * Replaces the radios that choose where an extension injects its text (None, before the main prompt, after it, in-chat at
 * a depth) with one select that the settings normaliser shows as a select row. The radios stay in the page, hidden, as the
 * state that the extension reads and writes, so its handlers and its saved value are the ones it always had. The depth and
 * the role of the in-chat position move out of that radio's label into labelled fields, which the normaliser shows as rows.
 * Call it after the extension has set the radios from its saved settings: the select reads them once and then follows them.
 * @param {HTMLElement} root The extension's settings block.
 * @param {string} name The `name` of the radios, a plain identifier. The select takes it as its id, and the label that points at that id becomes its title.
 */
export function adoptPositionRadios(root, name) {
    const radios = [...root.querySelectorAll(`input[type="radio"][name="${name}"]`)];
    const group = radios[0]?.closest('.radio_group');
    const heading = root.querySelector(`label[for="${name}"]`);
    if (!(group instanceof HTMLElement) || !(heading instanceof HTMLElement) || root.querySelector(`select#${name}`)) return;

    const select = document.createElement('select');
    select.id = name;
    select.className = 'text_pole';
    for (const radio of radios) {
        const label = radio.closest('label');
        const caption = label?.querySelector('span[data-i18n]');
        const option = document.createElement('option');
        option.value = radio.value;
        option.textContent = caption?.textContent?.trim() ?? radio.value;
        if (caption?.dataset.i18n) option.dataset.i18n = caption.dataset.i18n;
        // The explanation sat in an info icon or in the label's tooltip; the select row shows it under its title while the option is chosen.
        const description = label?.querySelector('i[title]')?.getAttribute('title') || label?.getAttribute('title');
        if (description) option.dataset.sbDescription = description;
        select.append(option);
    }

    let syncing = false;
    const readRadios = () => {
        const checked = radios.find(radio => radio.checked);
        if (!checked || select.value === checked.value) return;
        syncing = true;
        select.value = checked.value;
        // The select row redraws its trigger on a change event.
        select.dispatchEvent(new Event('change'));
        syncing = false;
    };
    select.addEventListener('change', () => {
        if (syncing) return;
        const radio = radios.find(candidate => candidate.value === select.value);
        if (radio) globalThis.jQuery(radio).prop('checked', true).trigger('change');
    });
    globalThis.jQuery(radios).on('input change', readRadios);
    readRadios();

    const inChat = radios.find(radio => radio.value === '1')?.closest('label');
    const fields = document.createElement('div');
    fields.className = 'sb-position-fields';
    const depth = inChat?.querySelector('input[type="number"]');
    const role = inChat?.querySelector('select');
    for (const [control, key] of [[depth, 'In-chat @ Depth'], [role, 'Role']]) {
        if (!(control instanceof HTMLElement)) continue;
        const label = document.createElement('label');
        label.htmlFor = control.id;
        label.dataset.i18n = key;
        label.textContent = key;
        fields.append(label, control);
    }

    heading.after(select, fields);
    // `.radio_group` sets its own display, which would beat the hidden attribute.
    group.hidden = true;
    group.style.display = 'none';
}

// The Summarize extension's own controls.

/**
 * The three prompt builders are an exclusive choice of three, so they become a toggle row. The radios keep their ids, name and
 * handlers: they move into the row's segments, and the extension keeps reading and writing them. The row's caption under the
 * title is the explanation of the chosen builder, which the labels carried as tooltips.
 * @param {HTMLElement} root The extension's settings block.
 */
function adoptPromptBuilder(root) {
    const radios = [...root.querySelectorAll('input[type="radio"][name="memory_prompt_builder"]')];
    const labels = radios.map(radio => radio.closest('label'));
    const heading = labels[0]?.parentElement?.querySelector(':scope > label:not(:has(input))');
    if (radios.length < 2 || labels.some(label => !label) || !heading || radios[0].closest('.ds-toggle-row')) return;

    const descriptions = new Map(radios.map((radio, index) => [radio, labels[index].getAttribute('title') ?? '']));
    const row = segmentedRow(labels, heading, 'memory-prompt-builder');
    const subtitle = document.createElement('small');
    subtitle.className = 'ds-row-subtitle';
    subtitle.id = `${row.group.getAttribute('aria-labelledby')}-description`;
    const showDescription = () => { subtitle.textContent = descriptions.get(radios.find(radio => radio.checked)) ?? ''; };
    row.row.querySelector('.ds-row-text').append(subtitle);
    row.group.setAttribute('aria-describedby', subtitle.id);
    globalThis.jQuery(radios).on('input change', showDescription);
    showDescription();
    labels[0].before(row.row);
    // The emptied labels held the radios before the segments took them.
    for (const label of labels) label.remove();
}

/**
 * The summary box is a text-area field with the extension's Restore button in its label row, in place of the loose header
 * that held the caption, an Expand icon and the button.
 * @param {HTMLElement} root The extension's settings block.
 */
function adoptSummaryBox(root) {
    const textarea = root.querySelector('#memory_contents');
    const header = textarea?.previousElementSibling;
    const caption = header?.querySelector(':scope > span[data-i18n="ext_sum_current_summary"]');
    if (!(textarea instanceof HTMLTextAreaElement) || !(header instanceof HTMLElement) || !caption || textarea.closest('.ds-row-textarea')) return;

    const row = createTextAreaField({ label: textOf(caption).replace(/[：:]$/, ''), field: 'memory_contents', input: textarea, expandLabel: t`Expand the editor` });
    const restore = header.querySelector('#memory_restore');
    if (restore) row.labelRow.insertBefore(restore, row.expand);
    header.before(row.row);
    header.remove();
}

/**
 * Brings the Summarize page's loose controls to the shared rows: the summary box, the prompt builder and the injection
 * position. Call it after the extension has set its controls from the saved settings; the rows then follow the controls.
 * @param {HTMLElement} root The extension's settings block.
 */
export function adoptSummarizeSettings(root) {
    adoptSummaryBox(root);
    adoptPromptBuilder(root);
    adoptPositionRadios(root, 'memory_position');
}

// The Quick Reply rows of a set.

/** The buttons of a Quick Reply row that the row's menu runs, as `[selector, icon]`, in the order the menu lists them. */
const QUICK_REPLY_ROW_ACTIONS = Object.freeze({
    insert: [['.qr--set-itemAdder .qr--add', 'plus'], ['.qr--set-itemAdder .qr--paste', 'paste'], ['.qr--set-itemAdder .qr--importFile', 'file-import']],
    own: [['.qr--set-optionsContainer .qr--action', 'sliders'], ['.qr--actions .fa-truck-arrow-right', 'truck-arrow-right'], ['.qr--actions .fa-copy', 'copy'], ['.qr--actions .fa-cut', 'scissors'], ['.qr--actions .fa-file-export', 'file-export']],
    remove: [['.qr--actions .fa-trash-can', 'trash']],
});

/**
 * The ⋮ button of an entity row. Its menu is built when it opens, from the extension's own hidden buttons, so that every
 * handler is the one the extension bound.
 * @param {{ className: string, titleOf: () => string, sectionsOf: () => object[], boundsOf: () => Element|null }} options
 */
function overflowMenuButton({ className, titleOf, sectionsOf, boundsOf }) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = `ds-entity-row__button ${className}`;
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-label', t`Actions`);
    more.title = t`Actions`;
    const glyph = document.createElement('i');
    glyph.className = 'fa-solid fa-ellipsis-vertical';
    glyph.setAttribute('aria-hidden', 'true');
    more.append(glyph);
    more.addEventListener('click', async () => {
        const { openActionMenu } = await import('../../sillybunny-action-menu.js');
        openActionMenu({ trigger: more, title: titleOf(), sections: sectionsOf(), bounds: boundsOf() ?? null });
    });
    return more;
}

/** A menu section that runs hidden buttons of `scope`, each named by the first line of its tooltip. */
function quickReplyMenuSection(scope, actions, danger = false) {
    return {
        items: actions.map(([selector, icon]) => {
            const button = scope.querySelector(selector);
            const name = button?.title?.split('\n')[0].trim();
            return button && name ? { label: name, icon: `fa-solid fa-${icon}`, danger, onSelect: () => button.click() } : null;
        }).filter(Boolean),
    };
}

/**
 * Turns the settings row of one Quick Reply (a button of a set) into a shared entity row: a grip, the icon button, the label
 * field and the message field in the text column, and one menu button at the end. The buttons that the row used to show (add
 * above, options, move, copy, cut, export, remove) stay in the row, hidden, and the menu items run them, so every handler is the
 * one the extension bound. Call it once the row is complete.
 * @param {HTMLElement} item The `.qr--set-item` that `QuickReply.renderSettings()` built.
 */
export function adoptQuickReplyRow(item) {
    const content = item.querySelector(':scope > .qr--content');
    const grip = content?.querySelector(':scope > .drag-handle');
    const labelContainer = content?.querySelector(':scope > .qr--set-itemLabelContainer');
    const message = content?.querySelector(':scope > .qr--set-itemMessage');
    const label = labelContainer?.querySelector('.qr--set-itemLabel');
    if (!content || !grip || !labelContainer || !message || !(label instanceof HTMLInputElement) || item.classList.contains('ds-entity-row')) return;

    item.classList.add('ds-entity-row');
    // The settings normaliser would read the row's fields and buttons as settings of their own.
    item.setAttribute('data-sb-presentation', 'manual');
    item.setAttribute('role', 'listitem');
    grip.classList.add('ds-entity-row__grip');
    label.setAttribute('aria-label', t`Label`);
    message.setAttribute('aria-label', t`Message`);

    const text = document.createElement('div');
    text.className = 'ds-entity-row__text qr--set-itemText';
    text.append(labelContainer, message);

    const more = overflowMenuButton({
        className: 'qr--set-itemMenu',
        boundsOf: () => item.closest('#sb-settings-page'),
        titleOf: () => label.value || t`Quick Reply`,
        sectionsOf: () => [
            quickReplyMenuSection(item, QUICK_REPLY_ROW_ACTIONS.own),
            quickReplyMenuSection(item, QUICK_REPLY_ROW_ACTIONS.insert),
            quickReplyMenuSection(item, QUICK_REPLY_ROW_ACTIONS.remove, true),
        ],
    });
    const suffix = document.createElement('div');
    suffix.className = 'ds-entity-row__suffix';
    suffix.append(more);

    content.hidden = true;
    item.querySelector(':scope > .qr--set-itemAdder')?.setAttribute('hidden', '');
    item.append(grip, text, suffix);
}

// The Image Generation extension.

/**
 * Gives the two controls of Image Generation that have no row of their own a row: the swap button, which the stylesheet laid
 * over the middle of the width slider, becomes a button row after the two dimensions, and the style picker, which has no label,
 * is titled by what it picks, so that the settings normaliser shows it as a select row.
 * @param {HTMLElement} root The extension's container.
 */
export function adoptImageGenerationSettings(root) {
    const swap = root.querySelector('#sd_swap_dimensions');
    if (swap instanceof HTMLElement && !swap.classList.contains('ds-button-row') && swap.title) {
        const label = swap.title;
        swap.replaceChildren();
        createButtonRow({ label, icon: 'arrow-right-arrow-left', field: 'sd-swap-dimensions', button: swap });
        swap.dataset.i18n = '[title]Swap width and height';
    }
    const style = root.querySelector('#sd_style');
    if (style instanceof HTMLSelectElement && !style.hasAttribute('aria-label')) {
        style.setAttribute('aria-label', t`Preset`);
    }
}

/**
 * The picker of the set that the editor edits becomes a select row with one ⋮ menu for the set's actions (rename, new, duplicate,
 * import, export, remove). The six buttons stay in the head, hidden, and the menu runs them.
 * @param {HTMLElement} root The extension's settings block.
 */
export function adoptQuickReplySetPicker(root) {
    const head = root.querySelector('#qr--editor > .qr--head');
    const select = head?.querySelector('#qr--set');
    const title = head?.querySelector(':scope > .qr--title');
    const actions = head?.querySelector(':scope > .qr--actions');
    if (!(select instanceof HTMLSelectElement) || !title || !actions || select.closest('.ds-select-row')) return;

    const heading = textOf(title);
    const row = createProfileRow({
        select, label: heading, field: 'qr-set', searchLabel: t`Search`, emptyText: t`No results`, menuLabel: t`Actions`,
        async onMenu(trigger) {
            const { openActionMenu } = await import('../../sillybunny-action-menu.js');
            openActionMenu({
                trigger,
                title: heading || t`Quick Reply`,
                sections: [
                    quickReplyMenuSection(head, [['#qr--set-rename', 'pencil'], ['#qr--set-new', 'plus'], ['#qr--set-duplicate', 'paste'], ['#qr--set-import', 'file-import'], ['#qr--set-export', 'file-export']]),
                    quickReplyMenuSection(head, [['#qr--set-delete', 'trash']], true),
                ],
                bounds: head.closest('#sb-settings-page') ?? null,
            });
        },
    });
    moveCaption(row.row.querySelector('.ds-row-label'), title);
    actions.hidden = true;
    head.prepend(row.row);
}

/**
 * A set link of the global, chat and character lists becomes an entity row: a grip, the set's select in the text column, and in the
 * suffix the switch that shows its buttons and one ⋮ menu (edit, remove). The pencil and the trash can stay in the row, hidden.
 * @param {HTMLElement} item The `.qr--item` that `QuickReplySetLink.renderSettings()` built.
 */
export function adoptQuickReplySetLink(item) {
    const grip = item.querySelector(':scope > .drag-handle');
    const select = item.querySelector(':scope > select.qr--set');
    const visible = item.querySelector(':scope > .qr--visible');
    const checkbox = visible?.querySelector('input[type="checkbox"]');
    if (!grip || !select || !(checkbox instanceof HTMLInputElement) || item.classList.contains('ds-entity-row')) return;

    item.classList.remove('ds-row', 'ds-row--activatable');
    item.classList.add('ds-entity-row');
    item.setAttribute('data-sb-presentation', 'manual');
    item.setAttribute('role', 'listitem');
    grip.classList.add('ds-entity-row__grip');
    select.setAttribute('aria-label', t`Quick Reply Set`);
    checkbox.classList.add('sb-switch');
    checkbox.setAttribute('role', 'switch');
    checkbox.setAttribute('aria-label', visible.title || t`Show buttons`);
    // The word stays beside the switch on a wide page and goes on a narrow one, where the select needs the room.
    const word = [...visible.childNodes].find(node => node.nodeType === Node.TEXT_NODE);
    if (word) {
        const span = document.createElement('span');
        span.className = 'qr--visibleText';
        span.textContent = word.textContent;
        word.replaceWith(span);
    }

    const text = document.createElement('div');
    text.className = 'ds-entity-row__text';
    text.append(select);
    const more = overflowMenuButton({
        className: 'qr--setlink-menu',
        boundsOf: () => item.closest('#sb-settings-page'),
        titleOf: () => select.value || t`Quick Reply Set`,
        sectionsOf: () => [
            quickReplyMenuSection(item, [[':scope > .fa-pencil', 'pencil']]),
            quickReplyMenuSection(item, [[':scope > .qr--del', 'trash']], true),
        ],
    });
    const suffix = document.createElement('div');
    suffix.className = 'ds-entity-row__suffix';
    suffix.append(visible, more);
    for (const button of item.querySelectorAll(':scope > .menu_button')) button.hidden = true;
    item.append(text, suffix);
}
