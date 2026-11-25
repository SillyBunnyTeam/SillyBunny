import { t } from './i18n.js';
import { openActionMenu } from './sillybunny-action-menu.js';
import { createButtonRow, createEntryRow, createPropertyRow, createSpinRow, createSwitchRow, createTextAreaField, moveCaption } from './sillybunny-editor/rows.js';
import { createProfileRow, createSelectRow } from './sillybunny-editor/select-row.js';
import { adoptButtonRows, adoptFieldRow, bindDependentSets, readRowTitle, unwrapLoneSelects } from './sillybunny-settings-presentation.js';
import { createServerRequestSettings } from './sillybunny-server-request-settings.js';

/**
 * Backend ▸ Formatting and Backend ▸ Presets. `sillybunny-tabs.js` builds the groups (a heading above one boxed list) and
 * moves the upstream controls into them; this module gives those controls the rows of the settings page contract and adds
 * the rows that link the two reasoning groups. Controls keep their nodes, ids and listeners: upstream and extensions bind
 * to them, and the Backend visibility rules write to the nodes that wrap them.
 *
 * `context` carries what lives in `sillybunny-tabs.js`: `revealGroup(tabId, groupId)` and, for Presets,
 * `templateMenuSections(holder)`, the Template Actions menu sections for the action buttons a holder keeps, and
 * `refreshPresets()`, which updates the page's groups and its search index after a group came or went.
 */

const textOf = node => node?.textContent.replace(/\s+/g, ' ').trim() ?? '';

/**
 * Hides what is left of an upstream block whose controls moved into rows. `[hidden]` alone loses to the `display` of the
 * flex classes these nodes carry, so the order pass's own marker hides them as well.
 * @param {Element|null|undefined} node
 */
function retire(node) {
    if (!(node instanceof HTMLElement)) return;
    // The provider rules show and hide whatever carries these, and would show the emptied node again.
    node.removeAttribute('data-source');
    node.removeAttribute('data-source-mode');
    node.hidden = true;
    node.dataset.sbEmptiedByOrder = 'true';
    // A hidden node in front of the rows would still give the first visible row a separator above it, so it leaves the box.
    const section = node.parentElement?.matches('.sb-prompting-group-body') ? node.parentElement.parentElement : null;
    if (section?.matches('.sb-prompting-group')) section.append(node);
}

/**
 * Moves the translation key and the content of an upstream caption into a row's title or subtitle.
 * @param {Element|null} target
 * @param {Element|null|undefined} source
 */
function carry(target, source) {
    if (!target || !source) return;
    // A caption that is still empty gets its text from the translation key, which is the English string.
    if (!textOf(source) && source.dataset.i18n) {
        target.dataset.i18n = source.dataset.i18n;
        return;
    }
    moveCaption(target, source, { keepSource: true });
}

/**
 * Carries the help links of an upstream caption into a row's title; a link that holds only an icon is named "Help".
 * @param {Element|null|undefined} title
 * @param {Element|null|undefined} source
 */
function carryLinks(title, source) {
    for (const link of source?.querySelectorAll('a[href]') ?? []) {
        title?.append(' ', link);
        if (!link.textContent?.trim() && !link.hasAttribute('aria-label')) link.setAttribute('aria-label', t`Help`);
    }
}

/**
 * A group that only appears while a Chat Completions backend is off keeps hiding its rows through the upstream attribute that
 * the upstream wrapper carries.
 * @param {HTMLElement} row
 * @param {Element|null|undefined} wrapper
 */
function inheritVisibility(row, wrapper) {
    if (wrapper instanceof HTMLElement && wrapper.hasAttribute('data-cc-null')) row.dataset.ccNull = '';
}

/** @param {string} id @param {HTMLElement} root */
function field(id, root = document.body) {
    return root.querySelector(`#${CSS.escape(id)}`);
}

/**
 * Advanced Formatting: Tokenizer & Padding, Stopping Strings, Reply Prefix, Text Cleanup, Reasoning, Add to Prompts, Rendering and Advanced Formatting.
 * @param {{revealGroup: (tabId: string, groupId: string) => void}} context
 */
export function presentFormatting(context) {
    const formatting = document.getElementById('AdvancedFormatting');
    if (!(formatting instanceof HTMLElement) || formatting.dataset.sbGrouped !== 'true' || formatting.dataset.sbFormattingPresented === 'true') return;
    const body = id => formatting.querySelector(`#${id} > .sb-prompting-group-body`);
    const bodies = {
        tokenizer: body('sb-af-tokenizer'),
        stopping: body('sb-af-stopping'),
        replyPrefix: body('sb-af-reply-prefix'),
        reasoning: body('sb-af-reasoning'),
        prompts: body('sb-af-reasoning-prompts'),
        rendering: body('sb-af-rendering'),
        advanced: body('sb-af-advanced'),
    };
    if (Object.values(bodies).some(node => !(node instanceof HTMLElement))) return;
    formatting.dataset.sbFormattingPresented = 'true';
    const searchLabel = t`Search`;
    const emptyText = t`No Results`;
    const expandLabel = t`Expand the Editor`;

    const tokenizerBlock = bodies.tokenizer.querySelector('[name="tokenizerSettingsBlock"]');
    const tokenizer = field('tokenizer', bodies.tokenizer);
    if (tokenizerBlock && tokenizer instanceof HTMLSelectElement) {
        const heading = tokenizerBlock.querySelector('h4');
        const select = createSelectRow({ select: tokenizer, label: textOf(heading), field: 'tokenizer', searchLabel, emptyText });
        const title = select.row.querySelector('.ds-row-label');
        carry(title, heading?.querySelector(':scope > span'));
        carryLinks(title, heading);
        const padding = field('token_padding', tokenizerBlock);
        const paddingTitle = tokenizerBlock.querySelector('[name="tokenPaddingBlock"] small');
        const rows = [select.row];
        if (padding instanceof HTMLInputElement) {
            const spin = createSpinRow({ input: padding, label: textOf(paddingTitle), field: 'token-padding', normalize: false });
            carry(spin.row.querySelector('.ds-row-label'), paddingTitle);
            rows.push(spin.row);
        }
        for (const row of rows) inheritVisibility(row, tokenizerBlock);
        bodies.tokenizer.append(...rows);
        retire(tokenizerBlock);
    }

    const stopping = bodies.stopping.querySelector('.sb-custom-stopping-strings');
    const stoppingArea = field('custom_stopping_strings', bodies.stopping);
    if (stopping && stoppingArea instanceof HTMLTextAreaElement) {
        const heading = stopping.querySelector('h4');
        const hint = stopping.querySelector(':scope > div > small');
        const area = createTextAreaField({
            input: stoppingArea,
            label: textOf(heading?.querySelector(':scope > span')),
            subtitle: textOf(hint?.querySelector(':scope > span')) || undefined,
            field: 'custom-stopping-strings',
            expandLabel,
        });
        const title = area.row.querySelector('.ds-row-label');
        carry(title, heading?.querySelector(':scope > span'));
        carry(area.row.querySelector('.ds-row-subtitle'), hint?.querySelector(':scope > span'));
        const example = hint?.querySelector('i[title]');
        if (example) area.row.querySelector('.ds-row-subtitle')?.setAttribute('title', example.getAttribute('title'));
        carryLinks(title, heading);
        const macro = stopping.querySelector('.ds-row-switch');
        bodies.stopping.append(area.row, ...(macro ? [macro] : []));
        retire(stopping);
    }

    const replyBlock = bodies.replyPrefix.querySelector('[name="startReplyWithBlock"]');
    const replyArea = field('start_reply_with', bodies.replyPrefix);
    if (replyBlock && replyArea instanceof HTMLTextAreaElement) {
        const caption = replyBlock.querySelector(':scope > div > small > span');
        const area = createTextAreaField({ input: replyArea, label: textOf(caption), field: 'start-reply-with', expandLabel });
        carry(area.row.querySelector('.ds-row-label'), caption);
        const show = replyBlock.querySelector('.ds-row-switch');
        bodies.replyPrefix.append(area.row, ...(show ? [show] : []));
        retire(replyBlock);
    }

    const reasoningSource = bodies.reasoning.firstElementChild;
    const switches = id => field(id, bodies.reasoning)?.closest('.ds-row-switch');
    const max = field('reasoning_max_additions', bodies.reasoning);
    if (reasoningSource && max instanceof HTMLInputElement) {
        const caption = max.closest('label')?.querySelector(':scope > span');
        const spin = createSpinRow({
            input: max,
            label: textOf(caption),
            subtitle: max.closest('label')?.getAttribute('title') || undefined,
            field: 'reasoning-max-additions',
            normalize: false,
        });
        carry(spin.row.querySelector('.ds-row-label'), caption);
        const link = createButtonRow({
            label: t`Reasoning Template`,
            field: 'reasoning-template-link',
            arrow: true,
            onActivate: () => context.revealGroup('prompting', 'sb-reasoning-template'),
        });
        const reasoningRows = ['reasoning_auto_parse', 'reasoning_auto_expand', 'reasoning_show_hidden'].map(switches).filter(Boolean);
        bodies.reasoning.append(...reasoningRows, link.row);
        bodies.prompts.dataset.sbEnabledBy = '#reasoning_add_to_prompts';
        bodies.prompts.append(...[switches('reasoning_add_to_prompts'), spin.row].filter(Boolean));
        retire(reasoningSource);
        bindDependentSets(formatting);
    }

    const markdown = field('markdown_escape_strings', bodies.rendering);
    if (markdown instanceof HTMLInputElement) {
        const source = markdown.closest('div')?.parentElement;
        const caption = source?.querySelector(':scope > small > span');
        const entry = createEntryRow({ input: markdown, label: textOf(caption), field: 'markdown-escape-strings', floating: true });
        carry(entry.row.querySelector('.ds-row-label'), caption);
        bodies.rendering.append(entry.row);
        retire(source);
    }

    presentAdvancedFormatting(formatting);
}

/**
 * The last group of Formatting. Upstream heads the page with "Advanced Formatting", its documentation link and the Master Import and
 * Master Export buttons; they become the group's heading, the link beside it, and two button rows. The buttons are the upstream nodes
 * themselves (the handlers bind to their ids), and the hidden file input stays in the document beside the box. The group carries
 * `data-cc-null`, so it hides with the buttons while a message-style Chat Completions backend is active.
 * @param {HTMLElement} formatting
 */
function presentAdvancedFormatting(formatting) {
    const section = formatting.querySelector('#sb-af-advanced');
    const body = section && bodyOf(section);
    const heading = section?.querySelector('.sb-settings-category-title');
    if (!(section instanceof HTMLElement && body && heading instanceof HTMLElement)) return;
    section.dataset.ccNull = '';

    const link = formatting.querySelector('a.notes-link[href*="advancedformatting"]');
    const legacyTitle = link?.closest('h3');
    if (link instanceof HTMLElement) {
        const row = document.createElement('div');
        row.className = 'sb-settings-category-title-row';
        heading.before(row);
        row.append(heading, link);
        if (!link.hasAttribute('aria-label')) link.setAttribute('aria-label', t`Help`);
    }
    const buttons = ['af_master_import', 'af_master_export'].map(id => document.getElementById(id)).filter(button => button instanceof HTMLElement);
    body.append(...buttons);
    adoptButtonRows(section);
    // Upstream translates the first line of the import tooltip only; the rest stays a second caption line under it.
    for (const button of buttons) {
        const subtitle = button.closest('.ds-row')?.querySelector('.ds-row-subtitle');
        const [first, ...rest] = button.title.split(/\n+/).map(line => line.trim()).filter(Boolean);
        if (!subtitle || !rest.length) continue;
        subtitle.textContent = first;
        const more = document.createElement('small');
        more.className = 'ds-row-subtitle';
        more.textContent = rest.join(' ');
        subtitle.after(more);
    }
    const file = document.getElementById('af_master_import_file');
    if (file instanceof HTMLElement) section.append(file);

    // The upstream heading block and its button bar are retired below. The upstream title goes, so that no pass builds a header from it again.
    legacyTitle?.remove();
    for (const old of formatting.querySelectorAll(':scope > .sb-settings-flat-header, :scope > .flex-container.alignItemsBaseline')) retire(old);
}

const ADOPT_OPTIONS = Object.freeze({ keepWrapper: true, keepLinks: true, manual: true });
const TEMPLATE_ACTION_ATTRIBUTES = ['import', 'export', 'update', 'rename', 'new', 'restore', 'restore-defaults', 'delete', 'delete-all', 'file'];
const CONTROL_SELECTOR = 'input, select, textarea';

/** The profile rows of the template groups, which sync with their selects because upstream sets some without a change event. */
const templateRows = [];

export function syncTemplateRows() {
    for (const row of templateRows) row.sync();
}

/** @param {Element|null|undefined} node */
const titleOf = node => node?.getAttribute('title') || node?.getAttribute('data-sttt--title') || '';

/** @param {Element|null|undefined} node */
const titleKeyOf = node => node?.getAttribute('data-i18n')?.match(/(?:^|;)\[title\]([^;]+)/)?.[1];

/** @param {HTMLElement} section @returns {HTMLElement|null} */
const bodyOf = section => section.querySelector(':scope > .sb-prompting-group-body');

/**
 * Copies what a Backend page reads off a wrapper (the provider list, the hidden state) onto the row that replaces it.
 * @param {HTMLElement} row
 * @param {Element|null|undefined} wrapper
 */
function carryVisibility(row, wrapper) {
    if (!(wrapper instanceof HTMLElement)) return;
    for (const name of wrapper.getAttributeNames()) {
        if (name.startsWith('data-') && !name.startsWith('data-sb-')) row.setAttribute(name, wrapper.getAttribute(name));
    }
    if (wrapper.style.display) row.style.display = wrapper.style.display;
    if (wrapper.hidden) row.hidden = true;
}

/** The child of `body` that holds `node`. @param {HTMLElement} body @param {Element|null} node */
function topOf(body, node) {
    let top = node;
    while (top && top.parentElement !== body) top = top.parentElement;
    return top instanceof HTMLElement ? top : null;
}

/**
 * The template buttons (import, export, update, rename, save as, restore, delete) and the hidden file input stay in the
 * document, because the preset manager listens to them from the document. The Template Actions menu clicks them.
 * @param {string} api
 * @param {HTMLElement} section
 */
function keepTemplateActions(api, section) {
    let holder = section.querySelector(`:scope > [data-sb-template-actions="${api}"]`);
    if (!holder) {
        holder = document.createElement('div');
        holder.hidden = true;
        holder.dataset.sbTemplateActions = api;
        section.append(holder);
    }
    for (const attribute of TEMPLATE_ACTION_ATTRIBUTES) {
        for (const node of document.querySelectorAll(`[data-preset-manager-${attribute}="${api}"]`)) {
            if (node.parentElement !== holder) holder.append(node);
        }
    }
    return holder;
}

/**
 * The select of a template with its actions in one trailing menu, as Appearance does for themes.
 * @param {{api: string, section: HTMLElement, select: HTMLSelectElement, label: string, subtitle?: string, labelKey?: string, subtitleKey?: string}} options
 * @param {{templateMenuSections: (holder: HTMLElement) => object[]}} context
 */
function createTemplateRow({ api, section, select, label, subtitle, labelKey, subtitleKey }, context) {
    const holder = keepTemplateActions(api, section);
    const profile = createProfileRow({
        select,
        label,
        subtitle: subtitle || undefined,
        field: `template-${api}`,
        searchLabel: t`Search`,
        emptyText: t`No Results`,
        menuLabel: t`Template Actions`,
        onMenu: trigger => openActionMenu({ trigger, title: label, sections: context.templateMenuSections(holder) }),
    });
    // Template actions replace and write presets themselves, so autosave saves pending edits when a press reaches the row.
    profile.row.dataset.sbPresetRow = '';
    const title = profile.row.querySelector('.ds-row-label');
    if (labelKey && title) title.dataset.i18n = labelKey;
    const caption = profile.row.querySelector('.ds-row-subtitle');
    if (subtitleKey && caption) caption.dataset.i18n = subtitleKey;
    templateRows.push(profile);
    return profile.row;
}

/**
 * A switch row for an upstream icon toggle. The input keeps its node and listeners; the toggle's tooltip becomes the title.
 * @param {string} id
 * @param {HTMLElement} scope
 * @param {{name: string, subtitleFromTooltip?: boolean}} options
 * @returns {HTMLElement|null}
 */
function createToggleRow(id, scope, { name, subtitleFromTooltip = false }) {
    const input = field(id, scope);
    const toggle = input?.closest('label');
    if (!(input instanceof HTMLInputElement) || !toggle) return null;
    const [first, ...rest] = titleOf(toggle).split('\n').map(line => line.trim()).filter(Boolean);
    if (!first) return null;
    const key = titleKeyOf(toggle);
    input.style.removeProperty('display');
    const { row } = createSwitchRow({ input, label: first, subtitle: subtitleFromTooltip ? rest.join(' ') || undefined : undefined, field: name });
    carryVisibility(row, toggle.closest('[data-cc-null]'));
    const title = row.querySelector('.ds-row-label');
    const subtitle = row.querySelector('.ds-row-subtitle');
    if (key && subtitle) subtitle.dataset.i18n = key;
    else if (key && title) title.dataset.i18n = key;
    toggle.hidden = true;
    return row;
}

/** Gives every upstream field row left in the scope the row of its control: a select row or a spin row. @param {HTMLElement} scope */
function adoptRows(scope) {
    unwrapLoneSelects(scope);
    for (const wrapper of scope.querySelectorAll('.ds-row-suffix > .wide100p')) {
        if (wrapper.children.length === 1 && wrapper.firstElementChild?.matches(CONTROL_SELECTOR)) wrapper.replaceWith(wrapper.firstElementChild);
    }
    for (const row of scope.querySelectorAll('.ds-row')) {
        if (row instanceof HTMLElement && row.isConnected) adoptFieldRow(row, ADOPT_OPTIONS);
    }
}

/**
 * Presets ▸ System Prompt: the enabling switch, then the template.
 * @param {HTMLElement} section @param {object} context
 */
function presentSystemPrompt(section, context) {
    const body = bodyOf(section);
    const select = body && field('sysprompt_select', body);
    const block = body?.querySelector('#SystemPromptBlock');
    const header = body && select ? body.querySelector(':scope > .title_restorable') : null;
    if (!(body && select instanceof HTMLSelectElement && block instanceof HTMLElement && header instanceof HTMLElement)) return;
    const enable = createToggleRow('sysprompt_enabled', header, { name: 'sysprompt-enabled' });
    const wrapper = select.parentElement;
    const tooltip = titleOf(wrapper);
    const row = createTemplateRow({
        api: 'sysprompt',
        section,
        select,
        label: textOf(section.querySelector('.sb-settings-category-title')),
        subtitle: tooltip,
        labelKey: section.querySelector('.sb-settings-category-title')?.dataset.i18n,
        subtitleKey: titleKeyOf(wrapper),
    }, context);
    carryVisibility(row, wrapper);
    wrapper.replaceWith(row);
    block.classList.add('sb-settings-row-wrapper');
    // The upstream bottom margin would show as an empty strip inside the box.
    block.classList.remove('marginBot10');
    if (enable) block.before(enable);
    retire(header);
}

/**
 * Presets ▸ Instruct Template: the switches of the icon bar, then the template and its fields.
 * @param {HTMLElement} section @param {object} context
 */
function presentInstruct(section, context) {
    const body = bodyOf(section);
    const column = body?.querySelector('#InstructSettingsColumn');
    const block = column?.querySelector('#instructSettingsBlock');
    const select = block && field('instruct_presets', block);
    const header = column?.querySelector(':scope > .title_restorable');
    if (!(column instanceof HTMLElement && block instanceof HTMLElement && select instanceof HTMLSelectElement && header instanceof HTMLElement)) return;
    const switches = [
        createToggleRow('instruct_enabled', header, { name: 'instruct-enabled' }),
        createToggleRow('instruct_derived', header, { name: 'instruct-derived' }),
        createToggleRow('instruct_bind_to_context', header, { name: 'instruct-bind-to-context', subtitleFromTooltip: true }),
    ].filter(Boolean);
    const wrapper = select.parentElement;
    const heading = section.querySelector('.sb-settings-category-title');
    const row = createTemplateRow({
        api: 'instruct',
        section,
        select,
        label: textOf(heading),
        subtitle: titleOf(wrapper),
        labelKey: heading?.dataset.i18n,
        subtitleKey: titleKeyOf(wrapper),
    }, context);
    wrapper.replaceWith(row);

    const regex = field('instruct_activation_regex', block);
    const regexBox = regex?.closest('#instructSettingsBlock > div');
    const regexTitle = regexBox?.previousElementSibling;
    if (regex instanceof HTMLInputElement && regexTitle instanceof HTMLElement) {
        const tooltip = regexTitle.querySelector('[title], [data-sttt--title]');
        const entry = createEntryRow({
            input: regex,
            label: textOf(regexTitle.querySelector('span:not(.fa-circle-question)')),
            subtitle: titleOf(tooltip) || undefined,
            field: 'instruct-activation-regex',
            floating: true,
        });
        carry(entry.row.querySelector('.ds-row-label'), regexTitle.querySelector('span[data-i18n]'));
        const key = titleKeyOf(tooltip);
        const subtitle = entry.row.querySelector('.ds-row-subtitle');
        if (key && subtitle) subtitle.dataset.i18n = key;
        row.after(entry.row);
        retire(regexTitle);
        retire(regexBox);
    }
    column.prepend(...switches);
    retire(header);
}

/**
 * Presets ▸ Context Template.
 * @param {HTMLElement} section @param {object} context
 */
function presentContextTemplate(section, context) {
    const body = bodyOf(section);
    const select = body && field('context_presets', body);
    const header = body?.querySelector(':scope > .title_restorable');
    if (!(body && select instanceof HTMLSelectElement && header instanceof HTMLElement)) return;
    const derive = createToggleRow('context_derived', header, { name: 'context-derived' });
    const wrapper = select.parentElement;
    const heading = section.querySelector('.sb-settings-category-title');
    const row = createTemplateRow({
        api: 'context',
        section,
        select,
        label: textOf(heading),
        subtitle: titleOf(wrapper),
        labelKey: heading?.dataset.i18n,
        subtitleKey: titleKeyOf(wrapper),
    }, context);
    carryVisibility(row, wrapper);
    wrapper.replaceWith(row);
    if (derive) row.after(derive);
    retire(header);
}

/**
 * Presets ▸ Reasoning Template: the template, the three text areas and the link to the Reasoning group of Formatting.
 * @param {HTMLElement} section @param {object} context
 */
function presentReasoningTemplate(section, context) {
    const body = bodyOf(section);
    const select = body && field('reasoning_select', body);
    if (!(body && select instanceof HTMLSelectElement)) return;
    const top = topOf(body, select);
    const caption = top?.querySelector('label[for="reasoning_select"], .ds-row-label');
    const subtitle = top?.querySelector('.ds-row-subtitle');
    if (!top || !caption) return;
    const row = createTemplateRow({
        api: 'reasoning',
        section,
        select,
        label: readRowTitle(caption),
        subtitle: textOf(subtitle) || undefined,
        labelKey: caption.dataset.i18n,
        subtitleKey: subtitle?.dataset.i18n,
    }, context);
    const fields = [];
    const emptied = [];
    for (const [id, name] of [['reasoning_prefix', 'reasoning-prefix'], ['reasoning_suffix', 'reasoning-suffix'], ['reasoning_separator', 'reasoning-separator']]) {
        const input = field(id, body);
        if (!(input instanceof HTMLTextAreaElement)) continue;
        emptied.push(topOf(body, input));
        const source = input.closest('.ds-row') ?? input.parentElement;
        const sourceTitle = source?.querySelector('.ds-row-label, small');
        const sourceSubtitle = source?.querySelector('.ds-row-subtitle');
        const tooltip = input.closest('[title], [data-sttt--title]');
        const area = createTextAreaField({
            input,
            label: textOf(sourceTitle),
            subtitle: textOf(sourceSubtitle) || titleOf(tooltip) || undefined,
            field: name,
            rows: 3,
            expandLabel: t`Expand the Editor`,
        });
        carry(area.row.querySelector('.ds-row-label'), sourceTitle);
        const newSubtitle = area.row.querySelector('.ds-row-subtitle');
        if (newSubtitle) {
            if (sourceSubtitle) carry(newSubtitle, sourceSubtitle);
            else if (titleKeyOf(tooltip)) newSubtitle.dataset.i18n = titleKeyOf(tooltip);
        }
        fields.push(area.row);
    }
    for (const node of emptied) retire(node);
    const link = createButtonRow({
        label: t`Reasoning`,
        field: 'reasoning-link',
        arrow: true,
        onActivate: () => context.revealGroup('context', 'sb-af-reasoning'),
    });
    top.replaceWith(row);
    body.append(...fields, link.row);
}

/**
 * A group of the Presets page: a heading block above one boxed list, built like the groups `sillybunny-tabs.js` creates.
 * @param {{id: string, title: string, titleKey?: string, description?: string, descriptionKey?: string}} options
 * @returns {{section: HTMLElement, body: HTMLElement}}
 */
function createGroup({ id, title, titleKey, description, descriptionKey, headless = false }) {
    const section = document.createElement('section');
    section.id = id;
    section.className = 'sb-prompting-group';
    const body = document.createElement('div');
    body.className = 'ds-pref-group sb-prompting-group-body';
    if (headless) {
        // A group whose one row carries the title has no heading of its own; its box is named by a label instead.
        body.setAttribute('role', 'group');
        body.setAttribute('aria-label', title);
        section.dataset.sbDescription = 'none';
        section.append(body);
        return { section, body };
    }
    const header = document.createElement('div');
    header.className = 'sb-settings-flat-header sb-settings-category-header';
    const heading = document.createElement('div');
    heading.className = 'flex-container flexFlowColumn sb-settings-category-heading';
    const name = document.createElement('h3');
    name.className = 'ds-pref-group-heading sb-settings-category-title';
    name.id = `${id}-heading`;
    name.textContent = title;
    name.dataset.i18n = titleKey || title;
    heading.append(name);
    if (description) {
        const caption = document.createElement('small');
        caption.textContent = description;
        if (descriptionKey) caption.dataset.i18n = descriptionKey;
        heading.append(caption);
    } else {
        section.dataset.sbDescription = 'none';
    }
    header.append(heading);
    section.append(header, body);
    return { section, body };
}

/**
 * Takes what follows a row (the help lines under a switch) into the row's own text, so the row holds all of its copy.
 * @param {HTMLElement} root
 */
function absorbHelp(root) {
    for (const wrapper of root.querySelectorAll('.sb-prompting-row-with-help')) {
        const row = wrapper.querySelector(':scope > .ds-row');
        const text = row?.querySelector(':scope > .ds-row-text');
        if (!(row instanceof HTMLElement && text)) continue;
        for (const help of [...wrapper.children].filter(node => node !== row)) {
            if (help instanceof HTMLElement) help.classList.add('ds-row-subtitle');
            text.append(help);
        }
        carryVisibility(row, wrapper);
        wrapper.replaceWith(row);
    }
}

/**
 * A set of upstream radios as one select row. The radios stay in the document, hidden, because upstream reads and writes
 * them: a preset load checks one with `prop('checked')` and no event, and a user's choice has to reach their `input`
 * handler. A mirror select is therefore the row's control, and the radios remain the stored value's transport.
 * @param {HTMLElement} set  The upstream block that holds the labelled radios and the readout of the chosen label.
 * @param {string} name  The field name of the row.
 * @param {string} title
 * @returns {HTMLElement|null} The row.
 */
export function createRadioSelectRow(set, name, title) {
    const labels = [...set.querySelectorAll(':scope > label')].filter(label => label.querySelector('input[type="radio"]'));
    if (!labels.length) return null;
    const radios = labels.map(label => /** @type {HTMLInputElement} */ (label.querySelector('input[type="radio"]')));
    const select = document.createElement('select');
    select.id = `sb-${name}-select`;
    for (const [index, label] of labels.entries()) {
        const option = document.createElement('option');
        option.value = radios[index].value;
        option.textContent = textOf(label.querySelector(':scope > span'));
        const hint = textOf(label.querySelector(':scope > small'));
        if (hint) option.dataset.hint = hint;
        select.append(option);
    }
    const built = createSelectRow({
        select,
        label: title,
        field: name,
        searchLabel: t`Search`,
        emptyText: t`No Results`,
        mapItem: (item, option) => (option.dataset.hint ? { ...item, subtitle: option.dataset.hint } : item),
        onChange: value => {
            const radio = radios.find(input => input.value === value);
            if (!radio || radio.checked) return;
            radio.checked = true;
            radio.dispatchEvent(new Event('input', { bubbles: true }));
            radio.dispatchEvent(new Event('change', { bubbles: true }));
        },
    });
    const showChecked = () => {
        const checked = radios.find(input => input.checked);
        if (checked && select.value !== checked.value) built.setValue(checked.value);
    };
    showChecked();
    for (const radio of radios) radio.addEventListener('change', showChecked);
    // A preset load checks a radio with no event, then rewrites the readout of the chosen label; the row follows that rewrite.
    const readout = set.querySelector('[id$="_display"]');
    if (readout) new MutationObserver(showChecked).observe(readout, { childList: true, characterData: true, subtree: true });
    // The capture listener runs before the row opens its picker, so the picker never shows a stale choice.
    built.trigger.addEventListener('click', showChecked, true);
    return built.row;
}

/**
 * Character Names Behavior and Continue Postfix are sets of four exclusive choices, so each becomes a group of its own with
 * one select row.
 * @param {HTMLElement} root
 */
function presentNames(root) {
    const names = root.querySelector('#sb-openai-names');
    const body = names && bodyOf(names);
    if (!(names instanceof HTMLElement && body) || names.dataset.sbPresented === 'true') return;
    const sets = [...body.querySelectorAll(':scope > .sb-settings-flat-section')].filter(set => set.querySelector('input[type="radio"]'));
    if (sets.length !== 2) return;
    names.dataset.sbPresented = 'true';
    for (const [index, set] of sets.entries()) {
        const heading = set.querySelector('.sb-settings-flat-header b');
        const group = createGroup({
            id: ['sb-openai-names-behavior', 'sb-openai-continue-postfix'][index],
            title: textOf(heading),
            titleKey: heading?.dataset.i18n,
            headless: true,
        });
        const row = createRadioSelectRow(set, ['names-behavior', 'continue-postfix'][index], textOf(heading));
        if (!row) continue;
        const title = row.querySelector('.ds-row-label');
        if (title instanceof HTMLElement && heading?.dataset.i18n) title.dataset.i18n = heading.dataset.i18n;
        group.body.append(row);
        names.before(group.section);
        // The readout of the chosen value stays in the document for the code that writes it.
        retire(set);
        for (const label of set.querySelectorAll(':scope > label')) label.hidden = true;
    }
}

/**
 * Reply Prefill: the Claude prefill text areas become text-area fields.
 * @param {HTMLElement} root
 */
function presentPrefill(root) {
    const section = root.querySelector('#sb-openai-prefill');
    const body = section && bodyOf(section);
    if (!(section instanceof HTMLElement && body)) return;
    absorbHelp(body);
    for (const [id, labelId, name] of [['claude_assistant_prefill', 'claude_assistant_prefill_text', 'claude-assistant-prefill'], ['claude_assistant_impersonation', 'claude_assistant_impersonation_text', 'claude-assistant-impersonation']]) {
        const input = field(id, body);
        const caption = field(labelId, body);
        const container = input?.parentElement;
        if (!(input instanceof HTMLTextAreaElement && caption && container instanceof HTMLElement && container !== body)) continue;
        const area = createTextAreaField({ input, label: textOf(caption) || caption.dataset.i18n || '', field: name, rows: 3, expandLabel: t`Expand the Editor` });
        carry(area.row.querySelector('.ds-row-label'), caption);
        // The upstream bar holds only the caption and the maximize icon, which the field's own Expand button replaces.
        caption.parentElement?.remove();
        container.before(area.row);
        if (!container.querySelector('textarea')) retire(container);
    }
    adoptRows(body);
}

/**
 * A select with its notes, which two or more nodes share a row with, as a select row that carries the notes.
 * @param {HTMLElement} row
 * @returns {boolean}
 */
function adoptSelectWithNotes(row) {
    const text = row.querySelector(':scope > .ds-row-text');
    const suffix = row.querySelector(':scope > .ds-row-suffix');
    const select = suffix?.querySelector(':scope > select');
    const caption = text?.querySelector(':scope > .ds-row-label');
    if (!(row.children.length === 2 && text && suffix && select instanceof HTMLSelectElement && caption)) return false;
    const notes = [...suffix.children].filter(node => node !== select && !node.matches('.select2-container'));
    if (!notes.length || !notes.every(node => node.matches('.toggle-description'))) return false;
    select.classList.remove('ds-control-flex');
    const subtitle = text.querySelector('.ds-row-subtitle');
    const built = createSelectRow({ select, label: readRowTitle(caption), subtitle: textOf(subtitle) || undefined, field: select.id, searchLabel: t`Search`, emptyText: t`No Results` });
    const title = built.row.querySelector('.ds-row-label');
    const key = caption.querySelector('[data-i18n]')?.dataset.i18n ?? caption.dataset.i18n;
    if (key && title instanceof HTMLElement) title.dataset.i18n = key;
    carryLinks(title, caption);
    const newSubtitle = built.row.querySelector('.ds-row-subtitle');
    if (subtitle && newSubtitle) carry(newSubtitle, subtitle);
    for (const note of notes) {
        note.classList.add('ds-row-subtitle');
        built.row.querySelector('.ds-row-text')?.append(note);
    }
    const wrapper = row.parentElement?.matches('.flex-container.flexFlowColumn.wide100p') ? row.parentElement : null;
    carryVisibility(built.row, wrapper ?? row);
    (wrapper ?? row).replaceWith(built.row);
    return true;
}

/**
 * Verbosity: a title, a help line and a select inside one flex container.
 * @param {HTMLElement} container `.sb-setting-inline-help`
 */
function adoptInlineHelpSelect(container) {
    const select = container.querySelector(':scope > select');
    const copy = container.querySelector(':scope > .sb-setting-inline-copy');
    const caption = copy?.querySelector('label');
    if (!(select instanceof HTMLSelectElement && copy && caption)) return;
    const notes = [...copy.querySelectorAll('.toggle-description')];
    const [description, ...more] = notes;
    const built = createSelectRow({ select, label: readRowTitle(caption), subtitle: textOf(description) || undefined, field: select.id, searchLabel: t`Search`, emptyText: t`No Results` });
    const key = caption.querySelector('[data-i18n]')?.dataset.i18n;
    const title = built.row.querySelector('.ds-row-label');
    if (key && title instanceof HTMLElement) title.dataset.i18n = key;
    const newSubtitle = built.row.querySelector('.ds-row-subtitle');
    if (description && newSubtitle) carry(newSubtitle, description);
    for (const note of more) {
        note.classList.add('ds-row-subtitle');
        built.row.querySelector('.ds-row-text')?.append(note);
    }
    const wrapper = container.parentElement?.matches('.flex-container.flexFlowColumn.wide100p') ? container.parentElement : container;
    carryVisibility(built.row, wrapper);
    wrapper.replaceWith(built.row);
}

/**
 * Moves one of the dependent sets of Request Options into a group of its own: the heading is the title of the enabling
 * switch, the switch comes first, and the rows after it are insensitive while it is off.
 * @param {HTMLElement} request `#sb-openai-request`
 * @param {{id: string, source: Element|null|undefined, switchId: string, rows?: (HTMLElement|null)[]}} options
 */
function moveDependentSet(request, { id, source, switchId, rows = [] }) {
    const input = source && field(switchId, source);
    const switchRow = input?.closest('.ds-row');
    if (!(source instanceof HTMLElement && input instanceof HTMLInputElement && switchRow instanceof HTMLElement)) return null;
    const title = switchRow.querySelector('.ds-row-label');
    const label = title?.querySelector('[data-i18n]') ?? title;
    if (!title) return null;
    const group = createGroup({ id, title: readRowTitle(title), titleKey: label?.dataset.i18n });
    carryVisibility(group.section, source);
    group.body.dataset.sbEnabledBy = `#${switchId}`;
    group.body.append(switchRow, ...rows.filter(Boolean));
    let anchor = request;
    while (anchor.nextElementSibling?.matches('[data-sb-request-set]')) anchor = anchor.nextElementSibling;
    group.section.dataset.sbRequestSet = '';
    anchor.after(group.section);
    retire(source);
    return group;
}

/**
 * Request Options: selects become select rows, and each switch with settings that depend on it becomes a group. The
 * server's own settings (Prompt Caching and three rows of this group) come from `sillybunny-server-request-settings.js`.
 * @param {HTMLElement} root
 * @param {{refreshPresets?: () => void}} [context]
 */
function presentRequestOptions(root, context = {}) {
    const request = root.querySelector('#sb-openai-request');
    const body = request && bodyOf(request);
    if (!(request instanceof HTMLElement && body)) return;
    absorbHelp(body);
    for (const row of body.querySelectorAll('.ds-row:not(.ds-select-row)')) {
        if (row instanceof HTMLElement && row.isConnected) adoptSelectWithNotes(row);
    }
    for (const container of body.querySelectorAll('.sb-setting-inline-help')) {
        if (container instanceof HTMLElement && container.querySelector(':scope > select:not(.ds-select-row__native)')) adoptInlineHelpSelect(container);
    }
    adoptRows(body);
    if (request.dataset.sbPresented === 'true') return;
    const wrapperOf = id => field(id, body)?.closest('[data-source]');
    const lift = id => {
        const control = field(id, body);
        const row = control?.closest('.ds-row');
        const wrapper = row?.parentElement;
        if (row instanceof HTMLElement && wrapper instanceof HTMLElement && wrapper !== body && wrapper.children.length === 1) {
            carryVisibility(row, wrapper);
            wrapper.replaceWith(row);
        }
        return row instanceof HTMLElement ? row : null;
    };

    const recurse = field('tool_call_recurse_limit_block', body);
    moveDependentSet(request, { id: 'sb-openai-function-calling', source: wrapperOf('openai_function_calling'), switchId: 'openai_function_calling', rows: [recurse] });

    const quality = lift('openai_inline_image_quality');
    moveDependentSet(request, { id: 'sb-openai-inline-media', source: wrapperOf('openai_media_inlining'), switchId: 'openai_media_inlining', rows: [quality] });

    const resolution = lift('request_image_resolution');
    const aspect = lift('request_image_aspect_ratio');
    moveDependentSet(request, { id: 'sb-openai-request-images', source: wrapperOf('openai_request_images'), switchId: 'openai_request_images', rows: [resolution, aspect] });

    const interleaved = field('tool_reasoning_mode', body)?.closest('.ds-row');
    const interleavedSource = interleaved?.closest('[data-source]');
    if (interleaved instanceof HTMLElement && interleavedSource instanceof HTMLElement) {
        carryVisibility(interleaved, interleavedSource);
        for (const note of interleavedSource.querySelectorAll('.toggle-description')) {
            note.classList.add('ds-row-subtitle');
            interleaved.querySelector('.ds-row-text')?.append(note);
        }
        retire(interleavedSource);
    }
    moveDependentSet(request, { id: 'sb-openai-request-reasoning', source: wrapperOf('openai_show_thoughts'), switchId: 'openai_show_thoughts', rows: [interleaved] });

    const tagStyle = lift('openai_reasoning_tag_style');
    moveDependentSet(request, { id: 'sb-openai-reasoning-tags', source: wrapperOf('openai_auto_append_reasoning_tags'), switchId: 'openai_auto_append_reasoning_tags', rows: [tagStyle] });

    createServerRequestSettings({ request, body, createGroup, onPlacementChange: () => context.refreshPresets?.() });

    request.dataset.sbPresented = 'true';
}

/**
 * NovelAI: the loose blocks after the template groups become groups.
 * @param {HTMLElement} root
 */
function presentNovel(root) {
    const novel = root.querySelector('#range_block_novel');
    if (!(novel instanceof HTMLElement) || novel.dataset.sbPresented === 'true') return;
    const penalty = field('phrase_rep_pen_novel', novel);
    const preamble = field('nai_preamble_textarea', novel);
    const banned = field('nai_banned_tokens', novel);
    if (!(penalty instanceof HTMLSelectElement && preamble instanceof HTMLTextAreaElement && banned instanceof HTMLTextAreaElement)) return;
    novel.dataset.sbPresented = 'true';
    const blocks = [];

    const penaltyBlock = penalty.closest('.range-block');
    const penaltyTitle = penaltyBlock?.querySelector('.range-block-title');
    const penaltyGroup = createGroup({ id: 'sb-novel-phrase-penalty', title: textOf(penaltyTitle), titleKey: penaltyTitle?.dataset.i18n });
    const penaltyRow = createSelectRow({ select: penalty, label: textOf(penaltyTitle), field: 'phrase-rep-pen', searchLabel: t`Search`, emptyText: t`No Results` });
    carry(penaltyRow.row.querySelector('.ds-row-label'), penaltyTitle);
    penaltyGroup.body.append(penaltyRow.row);
    blocks.push([penaltyBlock, penaltyGroup.section]);

    for (const [input, id, name] of [[preamble, 'sb-novel-preamble', 'nai-preamble'], [banned, 'sb-novel-banned-tokens', 'nai-banned-tokens']]) {
        const block = input.closest('.range-block');
        const title = block?.querySelector('.range-block-title > span, .range-block-title');
        const description = block?.querySelector(':scope > .toggle-description');
        const group = createGroup({ id, title: textOf(title), titleKey: title?.dataset.i18n });
        const area = createTextAreaField({
            input,
            label: textOf(title),
            subtitle: textOf(description) || undefined,
            field: name,
            rows: 3,
            expandLabel: t`Expand the Editor`,
        });
        carry(area.row.querySelector('.ds-row-label'), title);
        const newSubtitle = area.row.querySelector('.ds-row-subtitle');
        if (description && newSubtitle) carry(newSubtitle, description);
        const restore = block?.querySelector('#nai_preamble_restore');
        if (restore) area.labelRow.insertBefore(restore, area.expand);
        group.body.append(area.row);
        blocks.push([block, group.section]);
    }
    for (const [block, section] of blocks) block?.before(section);
    for (const [block] of blocks) retire(block);
}

/**
 * The groups of the upstream Chat Completions form title themselves with a bold element; a group heading is a heading.
 * @param {HTMLElement} root
 */
function adoptHeadings(root) {
    for (const title of root.querySelectorAll('.sb-openai-settings-drawer > .sb-settings-flat-header .sb-settings-category-heading > b.sb-settings-category-title')) {
        const heading = document.createElement('h3');
        for (const { name, value } of title.attributes) heading.setAttribute(name, value);
        heading.classList.add('ds-pref-group-heading');
        heading.append(...title.childNodes);
        title.replaceWith(heading);
    }
}

/**
 * "Max prompt cost" of OpenRouter, Electron Hub and Chutes: a property row that keeps the upstream value node, which the model
 * list writes the cost into, and the provider attribute that shows the row for its provider only.
 * @param {HTMLElement} body
 */
function presentPromptCosts(body) {
    for (const id of ['openrouter_max_prompt_cost', 'electronhub_max_prompt_cost', 'chutes_max_prompt_cost']) {
        const value = field(id, body);
        const wrapper = value?.parentElement;
        if (!(value instanceof HTMLElement && wrapper && wrapper.parentElement === body)) continue;
        const { row } = createPropertyRow({ label: '', value: '', field: id.replaceAll('_', '-') });
        moveCaption(row.querySelector('.ds-row-subtitle'), wrapper.querySelector(':scope > span:not([id])'), { stripColon: true });
        const display = row.querySelector('.ds-row-property__value');
        if (!(display instanceof HTMLElement)) continue;
        value.className = display.className;
        value.style.cssText = display.style.cssText;
        display.replaceWith(value);
        carryVisibility(row, wrapper);
        wrapper.replaceWith(row);
    }
}

/**
 * Chat Completions groups.
 * @param {HTMLElement} root
 * @param {{refreshPresets?: () => void}} [context]
 */
function presentChatCompletion(root, context = {}) {
    adoptHeadings(root);
    const budget = root.querySelector('#sb-openai-budget');
    if (budget instanceof HTMLElement) {
        const body = bodyOf(budget);
        if (body) presentPromptCosts(body);
        adoptRows(budget);
    }
    presentNames(root);
    presentPrefill(root);
    presentRequestOptions(root, context);
}

/**
 * Backend ▸ Presets. Safe to call again: each group is built once and the row pass runs every time.
 * @param {{revealGroup: (tabId: string, groupId: string) => void, templateMenuSections: (holder: HTMLElement) => object[]}} context
 */
export function presentPresets(context) {
    const root = document.getElementById('ai_response_configuration');
    if (!(root instanceof HTMLElement)) return;
    const groups = [
        ['sb-tc-sysprompt', presentSystemPrompt],
        ['sb-tc-instruct', presentInstruct],
        ['sb-tc-context', presentContextTemplate],
        ['sb-reasoning-template', presentReasoningTemplate],
    ];
    for (const [id, present] of groups) {
        const section = root.querySelector(`#${id}`);
        if (!(section instanceof HTMLElement) || section.dataset.sbPresented === 'true') continue;
        present(section, context);
        if (!bodyOf(section)?.querySelector('.ds-select-row')) continue;
        section.dataset.sbPresented = 'true';
    }
    for (const id of ['sb-tc-sysprompt', 'sb-tc-instruct', 'sb-tc-context', 'sb-tc-names', 'sb-reasoning-template', 'common-gen-settings-block']) {
        const section = root.querySelector(`#${id}`);
        if (section instanceof HTMLElement) adoptRows(section);
    }
    presentChatCompletion(root, context);
    presentNovel(root);
    bindDependentSets(root);
    syncTemplateRows();
}
