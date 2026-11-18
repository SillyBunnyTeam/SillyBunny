import { t } from './i18n.js';
import { loadStylesheetAsync } from './dynamic-styles.js';
import { createRow, createSwitchRow, createTextAreaField, moveCaption } from './sillybunny-editor/rows.js';
import { createSelectRow } from './sillybunny-editor/select-row.js';
import { createToggleRow } from './sillybunny-editor/toggle-row.js';
import { adoptSamplingFieldRows, bindDependentSets, carryGatingAttributes, readLabelI18nKey, readRowTitle } from './sillybunny-settings-presentation.js';

/**
 * Backend ▸ Sampling rows. The page keeps the upstream sampler nodes (ids, listeners and the backends'
 * show/hide attributes), so each block upstream lays out as a heading, a rule and a loose control is
 * rebuilt here as the standard rows around the same nodes: a select row, an action row, a text-area field
 * or a switch row. Lists (the sampler order, the logit bias entries) stay lists, in a block of their own.
 * The module loads when the Sampling panel is first built, so the startup bundle does not carry it.
 */

/** The row rules of the entity lists: the sampler order and the logit bias entries are rows of that pattern. */
const ENTITY_LIST_STYLESHEET = { href: 'css/sillybunny-entity-list.css?v=20261117s', id: 'deferred-entity-list-css' };

/** The sheet has to apply before the Sampling page shows its lists, or their rows change look when it arrives. */
export function loadSamplingStyles() {
    return loadStylesheetAsync(ENTITY_LIST_STYLESHEET.href, { id: ENTITY_LIST_STYLESHEET.id });
}

const clean = text => (text ?? '').replace(/\s+/g, ' ').trim();

function element(tag, className) {
    const node = document.createElement(tag);
    node.className = className;
    return node;
}

/**
 * The tooltip of an info icon, which upstream uses as the only description of a control.
 * @param {Element|null|undefined} node
 * @returns {{text: string, key: string}}
 */
export function readTooltip(node) {
    const holder = node?.matches?.('[title], [data-sttt--title]') ? node : node?.querySelector?.('[title], [data-sttt--title]');
    if (!holder) return { text: '', key: '' };
    return {
        text: (holder.getAttribute('title') || holder.getAttribute('data-sttt--title') || '').trim(),
        key: holder.getAttribute('data-i18n')?.match(/(?:^|;)\[title\]([^;]+)/)?.[1] ?? '',
    };
}

/** @param {Element|null|undefined} node @param {string} key */
function setKey(node, key) {
    if (node instanceof HTMLElement && key) node.dataset.i18n = key;
}

/**
 * A button that does something once, in a row of its own: the title reads like the button, the tooltip is the
 * subtitle, and the button itself, with its id and listeners, sits in the trailing slot.
 * @param {HTMLElement} button
 * @param {{text?: string, key?: string}} [tooltip]
 * @returns {HTMLElement}
 */
export function createActionRow(button, { text = '', key = '' } = {}) {
    const caption = button.querySelector('span, small') ?? button;
    const { row } = createRow({ label: readRowTitle(caption), subtitle: text || undefined, field: button.id || 'button', suffix: button });
    row.classList.add('ds-row-actions');
    setKey(row.querySelector('.ds-row-label'), readLabelI18nKey(caption));
    setKey(row.querySelector('.ds-row-subtitle'), key);
    return row;
}

/**
 * A multi-line field for a textarea, with the docs link of its heading in the label row.
 * @param {HTMLTextAreaElement} textarea
 * @param {{title: string, titleKey?: string, subtitle?: string, subtitleKey?: string, link?: HTMLAnchorElement|null}} options
 */
function createField(textarea, { title, titleKey = '', subtitle = '', subtitleKey = '', link = null }) {
    textarea.classList.remove('wide100p');
    const field = createTextAreaField({ label: title, subtitle: subtitle || undefined, field: textarea.id, input: textarea, expandLabel: t`Expand the Editor` });
    setKey(field.row.querySelector('.ds-row-label'), titleKey);
    setKey(field.row.querySelector('.ds-row-subtitle'), subtitleKey);
    if (link) {
        // The link is an icon; the field's title names where it goes.
        link.setAttribute('aria-label', title);
        if (titleKey) link.setAttribute('data-i18n', `[aria-label]${titleKey}`);
        field.labelRow.insertBefore(link, field.expand);
    }
    return field;
}

/** @param {Element} node */
function createListBlock(node) {
    const block = element('div', 'sb-sampling-list');
    block.append(node);
    return block;
}

/** A node that carries a backend's gating hands it to the row that replaces the node. */
function replaceGated(node, row) {
    carryGatingAttributes(node, row);
    node.replaceWith(row);
}

/** Chat Completions logit bias: a preset select row with its four icon buttons, an action row for new entries, and the list. */
function prepareChatLogitBias(block) {
    const select = block.querySelector('#openai_logit_bias_preset');
    const title = block.querySelector('#logit_bias_openai');
    // The Prompting pass may already have made the block a row; its parts are found wherever they sit.
    const description = block.querySelector('.toggle-description');
    const form = block.querySelector('.openai_logit_bias_preset_form');
    const add = block.querySelector('#openai_logit_bias_new_entry');
    const list = block.querySelector('.openai_logit_bias_list');
    if (!(select instanceof HTMLSelectElement) || !title || !description || !form || !(add instanceof HTMLElement) || !list) return;

    const tip = add.parentElement?.querySelector('.m-t-1 span[data-i18n]');
    const { row } = createSelectRow({
        select,
        label: readRowTitle(title),
        subtitle: clean(description.textContent),
        field: 'logit-bias-preset',
        searchLabel: t`Search`,
        emptyText: t`No Results`,
        suffix: [...form.querySelectorAll('.menu_button, input[type="file"]')],
    });
    setKey(row.querySelector('.ds-row-label'), readLabelI18nKey(title));
    // The description carries a link to the tokenizer; its words and keys move whole.
    const subtitle = row.querySelector('.ds-row-text > .ds-row-subtitle');
    if (subtitle) moveCaption(subtitle, description);

    add.classList.remove('wide100p', 'flex-container', 'justifyCenter');
    const addRow = createActionRow(add, { text: clean(tip?.textContent), key: tip?.getAttribute('data-i18n') ?? '' });
    block.classList.remove('ds-row', 'm-t-1');
    block.replaceChildren(row, addRow, createListBlock(list));
}

/** Text Completions logit bias: one row with the Add button, then the list. */
function prepareTextLogitBias(block) {
    const title = block.querySelector('h4 [data-i18n]');
    const description = block.querySelector('.toggle-description');
    const add = block.querySelector('#textgen_logit_bias_new_entry');
    const list = block.querySelector('.logit_bias_list');
    if (!title || !description || !(add instanceof HTMLElement) || !list) return;

    const { row } = createRow({ label: readRowTitle(title), subtitle: clean(description.textContent), field: 'logit-bias', suffix: add });
    row.classList.add('ds-row-actions');
    setKey(row.querySelector('.ds-row-label'), readLabelI18nKey(title));
    const subtitle = row.querySelector('.ds-row-subtitle');
    if (subtitle) moveCaption(subtitle, description);
    block.replaceChildren(row, createListBlock(list));
}

/**
 * Banned tokens and strings: the kill switch (a hidden checkbox behind a power icon upstream) is a switch row, and the
 * two lists are text-area fields that are insensitive while it is off.
 */
function prepareBannedTokens(block) {
    const label = block.querySelector('#send_banned_tokens_label');
    const input = block.querySelector('#send_banned_tokens_textgenerationwebui');
    const help = readTooltip(block.querySelector(':scope > .range-block-title .fa-circle-info'));
    const lists = [
        ['#global_banned_tokens_textgenerationwebui', help],
        ['#banned_tokens_textgenerationwebui', { text: '', key: '' }],
    ].map(([selector, tooltip]) => {
        const textarea = block.querySelector(selector);
        const wrapper = textarea?.parentElement;
        const title = wrapper?.previousElementSibling?.querySelector('[data-i18n]');
        return textarea instanceof HTMLTextAreaElement && wrapper && title ? { textarea, wrapper, title, tooltip } : null;
    });
    if (!(label instanceof HTMLElement) || !(input instanceof HTMLInputElement) || lists.some(list => !list)) return;

    input.removeAttribute('style');
    const enabled = createSwitchRow({ label: 'Enabled', field: 'send_banned_tokens', input });
    setKey(enabled.row.querySelector('.ds-row-label'), 'Enabled');
    enabled.row.id = 'send_banned_tokens_label';
    carryGatingAttributes(label, enabled.row);

    const rows = lists.map(({ textarea, wrapper, title, tooltip }) => {
        const { row } = createField(textarea, {
            title: readRowTitle(title),
            titleKey: readLabelI18nKey(title),
            subtitle: tooltip.text,
            subtitleKey: tooltip.key,
        });
        carryGatingAttributes(wrapper, row);
        return row;
    });
    block.dataset.sbEnabledBy = '#send_banned_tokens_textgenerationwebui';
    block.replaceChildren(enabled.row, ...rows);
}

/** CFG: the Scale slider is titled "CFG Scale" from the two words the block already has, and the negative prompt is a text-area field. */
function prepareCfg(block) {
    const name = block.querySelector(':scope > h4 [data-i18n="CFG"]');
    const scale = block.querySelector('small[data-i18n="Scale"]');
    const prompt = block.querySelector('[data-tg-samplers="negative_prompt"]');
    const textarea = prompt?.querySelector('textarea');
    const title = prompt?.querySelector('small[data-i18n]');
    if (!name || !scale || !(textarea instanceof HTMLTextAreaElement) || !title) return;

    const tip = readTooltip(prompt.querySelector('.fa-circle-info'));
    block.querySelector(':scope > hr')?.remove();
    block.querySelector(':scope > h4')?.remove();
    scale.removeAttribute('data-i18n');
    const word = element('span', '');
    word.dataset.i18n = 'Scale';
    word.textContent = 'Scale';
    scale.replaceChildren(name, ' ', word);
    const { row } = createField(textarea, {
        title: readRowTitle(title), titleKey: readLabelI18nKey(title), subtitle: tip.text, subtitleKey: tip.key,
    });
    replaceGated(prompt, row);
}

/** Grammar (Text Completions and Kobold): the heading becomes the field's title and its docs link stays in the label row. */
function prepareGrammar(block, root) {
    const textarea = block.querySelector('textarea');
    const heading = block.querySelector(':scope > h4');
    const name = heading?.querySelector(':scope [data-i18n]:not(a, a *)');
    if (!(textarea instanceof HTMLTextAreaElement) || !name) return;

    const tip = readTooltip(heading.querySelector('.fa-circle-info'));
    // Kobold's heading carries no tooltip; it takes the description Text Completions gives the same setting.
    const source = tip.text ? null : root?.querySelector('[data-sb-sampling-control="#grammar_block_ooba"] .ds-row-subtitle:not([data-sb-copy-placeholder])');
    const { row } = createField(textarea, {
        title: readRowTitle(name),
        titleKey: readLabelI18nKey(name),
        subtitle: tip.text || clean(source?.textContent),
        subtitleKey: tip.key || source?.getAttribute('data-i18n') || '',
        link: heading.querySelector('a'),
    });
    block.replaceChildren(row);
}

/** JSON schema: a text-area field with the docs link, then the switch row the block already has. */
function prepareJsonSchema(block) {
    const textarea = block.querySelector('textarea');
    const heading = block.querySelector(':scope > h4');
    const name = heading?.querySelector('[data-i18n]:not(a, a *)');
    if (!(textarea instanceof HTMLTextAreaElement) || !name) return;

    const { row } = createField(textarea, { title: readRowTitle(name), titleKey: readLabelI18nKey(name), link: heading.querySelector('a') });
    heading.remove();
    block.querySelector(':scope > hr')?.remove();
    block.prepend(row);
}

let samplerToggleCount = 0;

/**
 * NovelAI's order lets each sampler be switched off: upstream draws that as a bare div with a click handler. It becomes a button
 * (the page's accessibility pass gives it `role="button"`) that the sampler's name and its state, in hidden words, label, reachable
 * by keyboard. The state follows the `disabled` class the handler toggles. `aria-pressed` is not used: the shell draws a pressed
 * `.right_menu_button` as an active chip with a dot, in place of the glyph that shows this state.
 * @param {HTMLElement} list
 */
function adoptSamplerToggles(list) {
    const items = [...list.querySelectorAll(':scope > [data-id]')];
    /** @type {Map<Element, HTMLElement>} */
    const states = new Map();
    const syncItem = item => {
        const state = states.get(item);
        const text = item.classList.contains('disabled') ? t`Disabled` : t`Enabled`;
        if (state && state.textContent !== text) state.textContent = text;
    };
    for (const item of items) {
        const toggle = item.querySelector(':scope > .toggle_button');
        const name = item.querySelector(':scope > span');
        if (!(toggle instanceof HTMLElement) || !name) continue;
        const state = element('span', 'sr-only');
        const number = ++samplerToggleCount;
        name.id ||= `sb-sampler-toggle-name-${number}`;
        state.id = `sb-sampler-toggle-state-${number}`;
        states.set(item, state);
        toggle.append(state);
        toggle.setAttribute('aria-labelledby', `${name.id} ${state.id}`);
        toggle.tabIndex = 0;
        toggle.addEventListener('keydown', event => {
            if (event.key !== ' ' && event.key !== 'Enter') return;
            event.preventDefault();
            toggle.click();
        });
        syncItem(item);
    }
    if (!states.size) return;
    new MutationObserver(records => {
        for (const record of records) {
            const item = record.target instanceof Element ? record.target.closest('[data-id]') : null;
            if (item) syncItem(item);
        }
    }).observe(list, { attributes: true, attributeFilter: ['class'], subtree: true });
}

/**
 * The sampler order and priority lists: a row with the title, the description and the lock, the list in a
 * block of its own, and the button that loads the default order, where the backend has one, as an action row.
 */
function prepareSamplerList(block) {
    const list = block.querySelector(':scope > .prompt_order');
    const lock = block.querySelector('.sampler-order-lock');
    const heading = block.querySelector(':scope > .range-block-title');
    const name = heading?.querySelector(':scope > span[data-i18n]');
    const description = block.querySelector(':scope > .toggle-description');
    const reset = block.querySelector(':scope > .menu_button');
    if (!list || !(lock instanceof HTMLElement) || !name) return;

    const { row } = createRow({ label: readRowTitle(name), subtitle: clean(description?.textContent) || undefined, field: list.id || 'sampler-order', suffix: lock });
    setKey(row.querySelector('.ds-row-label'), readLabelI18nKey(name));
    const subtitle = row.querySelector('.ds-row-subtitle');
    if (subtitle && description) moveCaption(subtitle, description);
    // The list scrolls, so a keyboard user needs a stop on it to reach what is below its fold.
    list.setAttribute('tabindex', '0');
    // Upstream and its drag handler move these nodes and never rebuild them, so the class set here stays.
    for (const item of list.querySelectorAll(':scope > div')) item.classList.add('ds-entity-row');
    adoptSamplerToggles(list);
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', readRowTitle(name));
    const nameKey = readLabelI18nKey(name);
    if (nameKey) list.setAttribute('data-i18n', `[aria-label]${nameKey}`);
    // NovelAI's order has no button that loads a default order.
    block.replaceChildren(row, createListBlock(list), ...(reset instanceof HTMLElement ? [createActionRow(reset)] : []));
}

/** Dynamic temperature: its range sliders follow its switch, as a dependent set does elsewhere. */
function prepareDynamicTemperature(block) {
    block.querySelector(':scope > .flexFlowRow')?.setAttribute('data-sb-enabled-by', '#dynatemp_textgenerationwebui');
}

/**
 * Rebuilds the block of a sampler that upstream lays out as a heading and loose controls. Runs before the generic row pass.
 * @param {string} selector The registry selector of the card.
 * @param {HTMLElement} block The control block the card holds.
 * @param {{root?: ParentNode}} [context]
 */
export function prepareSamplingBlock(selector, block, { root } = {}) {
    switch (selector) {
        case '#openai_logit_bias_preset': return prepareChatLogitBias(block);
        case '#logit_bias_block_ooba': return prepareTextLogitBias(block);
        case '#banned_tokens_block_ooba': return prepareBannedTokens(block);
        case '#cfg_block_ooba': return prepareCfg(block);
        case '#grammar_block_ooba':
        case '#grammar': return prepareGrammar(block, root);
        case '#json_schema_block': return prepareJsonSchema(block);
        case '#dynatemp_block_ooba': return prepareDynamicTemperature(block);
        default:
            if (block.querySelector(':scope > .prompt_order')) prepareSamplerList(block);
    }
}

const WIRE_HELP = 'Controls how this setting is sent to the AI:\n\n• Auto: Normal default behavior.\n• Send: Force this slider\'s exact value to be sent.\n• Omit: Completely delete this setting from the request so models that reject it (like Grok or o1) won\'t crash.';
const WIRE_CHOICES = Object.freeze([
    ['inherit', 'Auto', 'Auto: Normal Default Behavior'],
    ['include', 'Send', 'Send: Force this slider\'s exact value to be sent'],
    ['omit', 'Omit', 'Omit: Completely delete this setting from the request to prevent crashes'],
]);

/** @type {WeakMap<HTMLElement, ReturnType<typeof createToggleRow>>} */
const wireRows = new WeakMap();

/**
 * @typedef {object} WireSource How a sampler is sent to the AI, as the page's transmission policy keeps it.
 * @property {string} parameterId
 * @property {() => {storedState: string, targetKey?: unknown, reason?: string}} read
 * @property {(state: string) => boolean} write
 */

/**
 * The wire control of a sampler: a toggle row of its own after the slider row, with the same gating. Its radios carry the
 * policy state in `data-policy-state`; a change goes through the policy and the row then shows what the policy kept.
 * @param {HTMLElement} card
 * @param {WireSource} wire
 */
function addWireRow(card, wire) {
    const slider = card.querySelector(':scope > .ds-row-slider');
    const range = slider?.querySelector('input[type="range"][id]');
    if (!slider || !range || card.querySelector(':scope > .sb-sampling-wire')) return;

    const view = wire.read();
    const toggle = createToggleRow({
        label: t`Sent to the AI`,
        subtitle: WIRE_HELP,
        field: `wire-${range.id}`,
        choices: WIRE_CHOICES.map(([state, label]) => [state, label]),
        value: view.storedState,
        onChange: state => {
            wire.write(state);
            syncWireRow(card, wire.read());
        },
    });
    const row = toggle.row;
    row.classList.add('sb-sampling-wire');
    row.dataset.samplingTransmissionFor = wire.parameterId;
    carryGatingAttributes(slider, row);
    toggle.group.querySelectorAll('.sb-boolean-radio-option').forEach((option, index) => {
        const input = option.querySelector('input[type="radio"]');
        input?.setAttribute('data-policy-state', WIRE_CHOICES[index][0]);
        option.title = WIRE_CHOICES[index][2];
    });

    // The group is named by its sampler as well as by "Sent to the AI", because the page holds one wire row for each sampler.
    const sliderTitle = slider.querySelector(':scope > .ds-row-text > .ds-row-label');
    if (sliderTitle) {
        sliderTitle.id ||= `sb-sampler-${range.id}-label`;
        toggle.group.setAttribute('aria-labelledby', `${sliderTitle.id} ${row.querySelector('.ds-row-label')?.id ?? ''}`.trim());
    }

    const badge = element('small', 'sb-capability-forbidden-badge');
    badge.textContent = '(Omitted: provider restriction)';
    badge.hidden = view.reason !== 'capability-forbidden';
    row.querySelector(':scope > .ds-row-suffix')?.prepend(badge);

    wireRows.set(row, toggle);
    slider.after(row);
    syncWireRow(card, view);
}

/**
 * Shows what the transmission policy keeps: the chosen state, the provider restriction, and whether the row can be used at all.
 * @param {HTMLElement} card
 * @param {{storedState: string, targetKey?: unknown, reason?: string}} view
 */
export function syncWireRow(card, view) {
    const row = card.querySelector(':scope > .sb-sampling-wire');
    const toggle = row instanceof HTMLElement ? wireRows.get(row) : null;
    if (!(row instanceof HTMLElement) || !toggle) return;
    toggle.setValue(view.storedState);
    const slider = card.querySelector(':scope > .ds-row-slider input[type="range"]');
    toggle.setDisabled(!view.targetKey || (slider instanceof HTMLInputElement && slider.disabled));
    const badge = row.querySelector('.sb-capability-forbidden-badge');
    if (badge instanceof HTMLElement) badge.hidden = view.reason !== 'capability-forbidden';
}

/**
 * The finishing pass of a card, after the generic row pass: a sampler gets its wire row after the slider row,
 * a seed and the DRY sequence breakers take the row that fits their control, and a dependent set follows its switch.
 * @param {HTMLElement} card
 * @param {{wire?: WireSource | null}} [context]
 */
export function finishSamplingCard(card, { wire = null } = {}) {
    if (wire) addWireRow(card, wire);
    if (card.dataset.sbSamplerId === 'seed') {
        for (const wrapper of card.querySelectorAll('.ds-row-suffix > div')) {
            if (wrapper.children.length === 1 && wrapper.firstElementChild instanceof HTMLInputElement) wrapper.replaceWith(wrapper.firstElementChild);
        }
    }
    adoptSamplingFieldRows(card);
    bindDependentSets(card);
}

/** Looks again at every dependent set of the page; other code changes a switch without an event. */
export function syncSamplingDependents(root) {
    bindDependentSets(root);
}
