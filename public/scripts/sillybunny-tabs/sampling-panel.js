import { SAMPLING_PARAMETER_DESCRIPTORS } from '../sampling-parameter-policy.js';
import {
    setSamplingParameterTransmissionState,
    getSamplingParameterViewModel,
} from '../openai.js';
import {
    setTextSamplingParameterTransmissionState,
    getTextSamplingParameterViewModel,
    showTGSamplerControls,
} from '../textgen-settings.js';
import { createExpanderRow, createRow } from '../sillybunny-editor/rows.js';
import { normalizeBackendSettingsRows } from '../sillybunny-settings-presentation.js';

export const SB_SAMPLING_BACKENDS = Object.freeze([
    {
        id: 'openai',
        apiIds: ['openai'],
        title: 'Chat Completions',
        usesContextSettings: false,
    },
    {
        id: 'textgenerationwebui',
        apiIds: ['textgenerationwebui'],
        title: 'Text Completions',
        usesContextSettings: true,
    },
    {
        id: 'kobold',
        apiIds: ['kobold', 'koboldhorde'],
        title: 'Kobold/Horde',
        usesContextSettings: true,
    },
    {
        id: 'novel',
        apiIds: ['novel'],
        title: 'NovelAI',
        usesContextSettings: true,
    },
]);

const SB_SAMPLING_GROUPS = Object.freeze([
    { id: 'sampling', title: 'Sampling', description: 'Adjust how the AI chooses tokens and how varied its replies can be' },
    { id: 'penalties', title: 'Penalties & Repetition', description: 'Control how the AI reuses tokens and repeats phrases' },
    { id: 'algorithms', title: 'Advanced Algorithms', description: 'Use advanced sampling methods to adjust token choices and repetition' },
    { id: 'tokens', title: 'Token Control', description: 'Set seeds, token preferences, minimum length, and streaming speed limits' },
    // The group has no description; its title keeps the translation key the upstream heading uses.
    { id: 'banned', title: 'Banned Tokens/Strings', i18n: 'Banned Tokens', description: '' },
    { id: 'output', title: 'Output & Generation', description: 'Adjust sampler order, generation options, and output rules' },
]);

/**
 * Shared sampler registry. Each entry maps a canonical sampler id to selectors across backends.
 * Controls are displayed in registry order within their group. Backends with no selector omit the entry.
 * @type {ReadonlyArray<{id: string, group: string, openai?: string|string[], textgenerationwebui?: string|string[], kobold?: string|string[], novel?: string|string[], expander?: boolean, gated?: boolean, description?: string, subtitleSource?: string}>}
 */
const SB_SAMPLER_REGISTRY = Object.freeze([
    // Sampling
    { id: 'sampler_toolbar', group: 'sampling', openai: '#sb_neutralize_chat_samplers', textgenerationwebui: '#samplerResetButton', gated: true },
    { id: 'temperature', group: 'sampling', openai: '#temp_openai', textgenerationwebui: '#temp_textgenerationwebui', kobold: '#temp', novel: '#temp_novel' },
    { id: 'top_k', group: 'sampling', openai: '#top_k_openai', textgenerationwebui: '#top_k_textgenerationwebui', kobold: '#top_k', novel: '#top_k_novel' },
    { id: 'top_p', group: 'sampling', openai: '#top_p_openai', textgenerationwebui: '#top_p_textgenerationwebui', kobold: '#top_p', novel: '#top_p_novel' },
    { id: 'typical_p', group: 'sampling', textgenerationwebui: '#typical_p_textgenerationwebui', kobold: '#typical_p', novel: '#typical_p_novel' },
    { id: 'min_p', group: 'sampling', openai: '#min_p_openai', textgenerationwebui: '#min_p_textgenerationwebui', kobold: '#min_p', novel: '#min_p_novel' },
    { id: 'top_a', group: 'sampling', openai: '#top_a_openai', textgenerationwebui: '#top_a_textgenerationwebui', kobold: '#top_a', novel: '#top_a_novel' },
    { id: 'tfs', group: 'sampling', textgenerationwebui: '#tfs_textgenerationwebui', kobold: '#tfs', novel: '#tail_free_sampling_novel' },
    { id: 'epsilon_cutoff', group: 'sampling', textgenerationwebui: '#epsilon_cutoff_textgenerationwebui' },
    { id: 'eta_cutoff', group: 'sampling', textgenerationwebui: '#eta_cutoff_textgenerationwebui' },
    { id: 'nsigma', group: 'sampling', textgenerationwebui: '#nsigma_textgenerationwebui' },
    { id: 'min_keep', group: 'sampling', textgenerationwebui: '#min_keep_textgenerationwebui' },
    { id: 'skew', group: 'sampling', textgenerationwebui: '#skew_textgenerationwebui' },
    // Penalties
    { id: 'repetition_penalty', group: 'penalties', openai: '#repetition_penalty_openai', textgenerationwebui: '#rep_pen_textgenerationwebui', kobold: '#rep_pen', novel: '#rep_pen_novel' },
    { id: 'rep_pen_range', group: 'penalties', textgenerationwebui: '#rep_pen_range_textgenerationwebui', kobold: '#rep_pen_range', novel: '#rep_pen_size_novel' },
    { id: 'rep_pen_slope', group: 'penalties', textgenerationwebui: '#rep_pen_slope_textgenerationwebui', kobold: '#rep_pen_slope', novel: '#rep_pen_slope_novel' },
    { id: 'rep_pen_decay', group: 'penalties', textgenerationwebui: '#rep_pen_decay_textgenerationwebui' },
    { id: 'encoder_rep_pen', group: 'penalties', textgenerationwebui: '#encoder_rep_pen_textgenerationwebui' },
    { id: 'frequency_penalty', group: 'penalties', openai: '#freq_pen_openai', textgenerationwebui: '#freq_pen_textgenerationwebui', novel: '#rep_pen_freq_novel' },
    { id: 'presence_penalty', group: 'penalties', openai: '#pres_pen_openai', textgenerationwebui: '#presence_pen_textgenerationwebui', novel: '#rep_pen_presence_novel' },
    { id: 'no_repeat_ngram', group: 'penalties', textgenerationwebui: '#no_repeat_ngram_size_textgenerationwebui' },
    // Algorithms
    { id: 'adaptive_p', group: 'algorithms', textgenerationwebui: '#adaptive_p_block', expander: true, description: 'Adjust token choices toward your chosen level of predictability' },
    { id: 'smoothing', group: 'algorithms', textgenerationwebui: '#smoothingBlock', expander: true },
    { id: 'math1_temp', group: 'algorithms', novel: '#math1_temp_novel' },
    { id: 'math1_quad', group: 'algorithms', novel: '#math1_quad_novel' },
    { id: 'math1_quad_entropy_scale', group: 'algorithms', novel: '#math1_quad_entropy_scale_novel' },
    { id: 'xtc', group: 'algorithms', textgenerationwebui: '#xtc_block', expander: true, description: 'Exclude top token choices to encourage more varied replies' },
    { id: 'dry', group: 'algorithms', textgenerationwebui: '#dryBlock', expander: true },
    { id: 'dynatemp', group: 'algorithms', textgenerationwebui: '#dynatemp_block_ooba', expander: true },
    { id: 'mirostat', group: 'algorithms', textgenerationwebui: '#mirostat_block_ooba', kobold: '[name="miroStatBlock-kobold"]', expander: true, subtitleSource: '[data-sb-sampling-control="#mirostat_block_ooba"] .ds-row-subtitle' },
    { id: 'mirostat_tau', group: 'algorithms', novel: '#mirostat_tau_novel' },
    { id: 'mirostat_lr', group: 'algorithms', novel: '#mirostat_lr_novel' },
    { id: 'beam_search', group: 'algorithms', textgenerationwebui: '#beamSearchBlock', expander: true, gated: true },
    { id: 'contrastive_search', group: 'algorithms', textgenerationwebui: '#contrastiveSearchBlock', expander: true, gated: true },
    // Tokens
    { id: 'seed', group: 'tokens', openai: '#seed_openai', textgenerationwebui: '#seed_textgenerationwebui', kobold: '#seed_kobold', subtitleSource: '[data-sb-sampling-control="#seed_textgenerationwebui"] .ds-row-subtitle' },
    { id: 'logit_bias', group: 'tokens', openai: '#openai_logit_bias_preset', textgenerationwebui: '#logit_bias_block_ooba', gated: true },
    { id: 'banned_tokens', group: 'banned', textgenerationwebui: '#banned_tokens_block_ooba', gated: true },
    { id: 'min_length', group: 'tokens', textgenerationwebui: '#min_length_textgenerationwebui', novel: '#min_length_novel', gated: true },
    { id: 'max_tokens_second', group: 'tokens', textgenerationwebui: '#max_tokens_second_textgenerationwebui', gated: true },
    // Output
    { id: 'sampler_order', group: 'output', textgenerationwebui: ['#sampler_order_block_kcpp', '#sampler_order_block_lcpp'], kobold: '#kobold_order', novel: '#novel_order', gated: true },
    { id: 'sampler_priority', group: 'output', textgenerationwebui: ['#sampler_priority_block_ooba', '#sampler_priority_block_aphrodite'], gated: true },
    { id: 'json_schema', group: 'output', textgenerationwebui: '#json_schema_block', gated: true },
    { id: 'do_sample', group: 'output', textgenerationwebui: '#do_sample_textgenerationwebui', gated: true },
    { id: 'add_bos_token', group: 'output', textgenerationwebui: '#add_bos_token_textgenerationwebui', gated: true },
    { id: 'ban_eos_token', group: 'output', textgenerationwebui: '#ban_eos_token_textgenerationwebui', gated: true },
    { id: 'skip_special_tokens', group: 'output', textgenerationwebui: '#skip_special_tokens_textgenerationwebui', gated: true },
    { id: 'ignore_eos_token', group: 'output', textgenerationwebui: '#ignore_eos_token_textgenerationwebui', gated: true },
    { id: 'use_default_badwordsids', group: 'output', kobold: '#use_default_badwordsids', gated: true },
    { id: 'temperature_last', group: 'output', textgenerationwebui: '#temperature_last_textgenerationwebui', gated: true },
    { id: 'include_reasoning', group: 'output', textgenerationwebui: '#include_reasoning_textgenerationwebui', gated: true },
    { id: 'speculative_ngram', group: 'output', textgenerationwebui: '#speculative_ngram_textgenerationwebui', gated: true },
    { id: 'spaces_between_special_tokens', group: 'output', textgenerationwebui: '#spaces_between_special_tokens_textgenerationwebui', gated: true },
    { id: 'cfg', group: 'output', textgenerationwebui: '#cfg_block_ooba', gated: true },
    { id: 'grammar', group: 'output', textgenerationwebui: '#grammar_block_ooba', kobold: '#grammar', gated: true, subtitleSource: '[data-sb-sampling-control="#grammar_block_ooba"] .ds-row-subtitle' },
]);

const SB_SAMPLER_ENTRY_BY_SELECTOR = Object.freeze(new Map(SB_SAMPLER_REGISTRY.flatMap(entry => SB_SAMPLING_BACKENDS
    .flatMap(backend => [entry[backend.id] ?? []].flat())
    .map(selector => [selector, entry]))));

const SAMPLING_SELECTOR_TO_CANONICAL_ID = Object.freeze({
    '#temp_openai': 'temperature',
    '#temp_textgenerationwebui': 'temperature',
    '#top_p_openai': 'top_p',
    '#top_p_textgenerationwebui': 'top_p',
    '#pres_pen_openai': 'presence_penalty',
    '#presence_pen_textgenerationwebui': 'presence_penalty',
    '#freq_pen_openai': 'frequency_penalty',
    '#freq_pen_textgenerationwebui': 'frequency_penalty',
    '#typical_p_textgenerationwebui': 'typical_p',
});

/**
 * Text Completions samplers that Chat Completions has no setting for. They are listed in the CC
 * section as inert rows so both lists read the same; gated mechanisms are left out because TC only
 * shows them for some backend types.
 */
const SB_CC_PLACEHOLDER_SAMPLERS = Object.freeze(SB_SAMPLER_REGISTRY.filter(entry => entry.textgenerationwebui && !entry.openai && !entry.gated));
const SB_CC_PLACEHOLDER_SUBTITLE = 'Not available in Chat Completions. Custom endpoints can send it with Additional Parameters.';

function getSamplingBackendControls(backendId) {
    return SB_SAMPLER_REGISTRY.flatMap(entry => [entry[backendId] ?? []].flat());
}

function getSamplingGroupId(selector) {
    return SB_SAMPLER_ENTRY_BY_SELECTOR.get(selector)?.group ?? 'sampling';
}

function neutralizeChatCompletionSamplers() {
    const values = {
        '#temp_openai': 1,
        '#top_p_openai': 1,
        '#top_k_openai': 0,
        '#min_p_openai': 0,
        '#top_a_openai': 0,
        '#repetition_penalty_openai': 1,
        '#freq_pen_openai': 0,
        '#pres_pen_openai': 0,
    };

    for (const [selector, value] of Object.entries(values)) {
        const input = document.querySelector(selector);
        if (input instanceof HTMLInputElement) {
            input.value = String(value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    ['#claude_disable_temperature', '#claude_disable_top_p'].forEach(selector => {
        const input = document.querySelector(selector);
        if (input instanceof HTMLInputElement) {
            input.checked = false;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
}

/**
 * The transmission policy of a sampler, for the wire row that the Sampling module builds after its slider row.
 * @param {string} selector
 * @returns {{parameterId: string, read: Function, write: Function}|null}
 */
function getSamplingWire(selector) {
    const parameterId = SAMPLING_SELECTOR_TO_CANONICAL_ID[selector];
    if (!parameterId || !SAMPLING_PARAMETER_DESCRIPTORS[parameterId]) {
        return null;
    }
    const textGeneration = selector.includes('textgenerationwebui');
    return {
        parameterId,
        read: () => (textGeneration ? getTextSamplingParameterViewModel : getSamplingParameterViewModel)(parameterId),
        write: state => (textGeneration ? setTextSamplingParameterTransmissionState : setSamplingParameterTransmissionState)(parameterId, state),
    };
}

function decorateSamplingControlCard(card, selector) {
    if (card instanceof HTMLElement && getSamplingWire(selector)) {
        card.dataset.samplingParameter = SAMPLING_SELECTOR_TO_CANONICAL_ID[selector];
    }
}

function getSamplingControlBlock(selector) {
    const input = document.querySelector(selector);
    if (!(input instanceof HTMLElement)) {
        return null;
    }

    if (SB_SAMPLER_ENTRY_BY_SELECTOR.get(selector)?.expander || input.matches('#cfg_block_ooba, #grammar_block_ooba, #json_schema_block, #banned_tokens_block_ooba, #logit_bias_block_ooba, [id^="sampler_order_block_"], [id^="sampler_priority_block_"]')) {
        return input;
    }

    if (input.matches('input[type="checkbox"]')) {
        return input.closest('.checkbox_label') ?? input.parentElement;
    }

    return input.closest('.range-block')
        ?? input.closest('[data-tg-samplers]')
        ?? input.parentElement;
}

/** Reuses another backend's subtitle (text and i18n key) when this card's native markup has none. */
function applySamplingSubtitleSource(card, entry, root) {
    if (!entry?.subtitleSource) return;
    const placeholder = card.querySelector('.ds-row-subtitle[data-sb-copy-placeholder]');
    const source = root.querySelector(entry.subtitleSource);
    if (!(placeholder instanceof HTMLElement) || !(source instanceof HTMLElement) || source.hasAttribute('data-sb-copy-placeholder')) return;
    const text = source.textContent.trim();
    if (!text) return;
    placeholder.textContent = text;
    delete placeholder.dataset.sbCopyPlaceholder;
    if (source.dataset.i18n) placeholder.dataset.i18n = source.dataset.i18n;
}

/** Registry position of a sampling card, so placeholder rows sort beside real controls. */
function getSamplingCardRank(card) {
    const entry = SB_SAMPLER_ENTRY_BY_SELECTOR.get(card.dataset.sbSamplingControl)
        ?? SB_SAMPLER_REGISTRY.find(candidate => candidate.id === card.dataset.sbSamplerId);
    const index = SB_SAMPLER_REGISTRY.indexOf(entry);
    if (index < 0) return Number.MAX_SAFE_INTEGER;
    const selectors = Object.values(entry).flat().filter(value => typeof value === 'string');
    return index + Math.max(0, selectors.indexOf(card.dataset.sbSamplingControl)) / 100;
}

export function updateSamplingCardVisibility(section) {
    if (!(section instanceof HTMLElement)) {
        return;
    }

    // Read every card's state before writing any `hidden`, so the pass costs one style flush, not one per card.
    const cardVisibility = Array.from(section.querySelectorAll('[data-sb-sampling-control]'))
        .filter(card => card instanceof HTMLElement)
        .map(card => {
            const content = card.querySelector(':scope > .ds-row-expander-content') ?? card;
            const hasVisibleContent = Array.from(content.children).some(child => child instanceof HTMLElement
                && !child.classList.contains('sb-sampling-wire')
                && getComputedStyle(child).display !== 'none');
            return [card, hasVisibleContent];
        });
    for (const [card, hasVisibleContent] of cardVisibility) {
        if (card.hidden !== !hasVisibleContent) card.hidden = !hasVisibleContent;
    }

    // Track visibility as we write: the `card.hidden` writes have not been flushed yet, so a
    // checkVisibility() here would force the very layout this function is trying to avoid.
    const visibleCards = new Set(cardVisibility.filter(([, visible]) => visible).map(([card]) => card));
    const groups = [];
    for (const group of section.querySelectorAll('[data-sb-sampling-group]')) {
        if (!(group instanceof HTMLElement)) continue;
        // Placeholder rows have no gated content, so they always keep their group visible.
        const hasSamplingCard = Boolean(group.querySelector('[data-sb-sampling-placeholder]'))
            || [...group.querySelectorAll('[data-sb-sampling-control]')].some(card => visibleCards.has(card));
        groups.push([group, !hasSamplingCard]);
    }
    for (const [group, hidden] of groups) {
        if (group.hidden !== hidden) group.hidden = hidden;
    }
}

function sortSamplingSectionCards(section) {
    for (const group of section.querySelectorAll('[data-sb-sampling-group] > .ds-pref-group')) {
        const cards = [...group.querySelectorAll(':scope > [data-sb-sampling-control], :scope > [data-sb-sampling-placeholder]')];
        const sorted = [...cards].sort((a, b) => getSamplingCardRank(a) - getSamplingCardRank(b));
        if (sorted.some((card, index) => card !== cards[index])) group.append(...sorted);
    }
}

function resyncUngatedSamplerVisibility(section, backendId) {
    // Cards built after the backend's own gating pass may still carry its inline display:none.
    $(section).find('[data-sb-sampler-ungated]').filter('[data-source], [data-tg-type]').show();
    if (backendId === 'textgenerationwebui') showTGSamplerControls();
}

export function createSamplingPanelController({
    createElement,
    createShellPanel,
    createBackendSectionHeader,
    createBackendGroupHeader,
    getCurrentMainApiValue,
    isShellTabOpen,
    loadSamplingModule,
    hideEmptyGroupedSettingsDrawers,
}) {
    let samplingModule = null;

    /** Text Completions sampler tools: an action row for each button, with the tooltip beside it as the subtitle. */
    function getSamplerToolbarControlBlock() {
        const reset = document.getElementById('samplerResetButton');
        if (!(reset instanceof HTMLElement) || !samplingModule) {
            return null;
        }

        const block = createElement('div', { className: 'sb-sampling-sampler-tools-card' });
        for (const button of [reset, document.getElementById('samplerSelectButton')]) {
            if (button instanceof HTMLElement) {
                block.append(samplingModule.createActionRow(button, samplingModule.readTooltip(button.parentElement?.querySelector(':scope > .fa-circle-info'))));
            }
        }

        return block;
    }

    function refreshSamplingTransmission(card, selector) {
        const wire = getSamplingWire(selector);
        if (wire) {
            samplingModule?.syncWireRow(card, wire.read());
        }
    }

    /** Chat Completions counterpart of the Text Completions sampler tools (`#samplerResetButton` row). */
    function getChatSamplerToolbarControlBlock() {
        const existing = document.getElementById('sb_neutralize_chat_samplers');
        if (existing instanceof HTMLElement) return existing.closest('.sb-sampling-sampler-tools-card');
        if (!samplingModule) return null;

        const block = createElement('div', { className: 'sb-sampling-sampler-tools-card' });
        const button = createElement('button', {
            id: 'sb_neutralize_chat_samplers',
            className: 'menu_button whitespacenowrap sb-neutralize-chat-samplers',
            text: 'Neutralize Samplers',
            attrs: { type: 'button', 'data-i18n': 'Neutralize Samplers' },
        });
        button.addEventListener('click', neutralizeChatCompletionSamplers);
        block.append(samplingModule.createActionRow(button, {
            text: 'Set all samplers to their neutral/disabled state.',
            key: 'Set all samplers to their neutral/disabled state.',
        }));
        return block;
    }

    /** Slider explanations stay searchable and translated, but open only when the reader needs them. */
    function addSamplingDescriptionToggles(card) {
        for (const row of card.querySelectorAll('.ds-row-slider, .sb-sampling-wire')) {
            if (row.querySelector('.sb-sampling-help-toggle')) continue;
            const text = row.querySelector(':scope > .ds-row-text');
            const label = text?.querySelector(':scope > .ds-row-label');
            const subtitle = text?.querySelector(':scope > .ds-row-subtitle:not([data-sb-copy-placeholder])');
            // The wire row of a sampler is named by that sampler's slider.
            const isWire = row.classList.contains('sb-sampling-wire');
            const control = (isWire ? card.querySelector(':scope > .ds-row-slider') : row)?.querySelector('input[type="range"][id]');
            if (!label || !subtitle || !control) continue;
            const key = isWire ? `${control.id}-wire` : control.id;

            label.id ||= `sb-sampler-${key}-label`;
            subtitle.id ||= `sb-sampler-${key}-help`;
            subtitle.classList.add('sb-sampling-help');
            subtitle.hidden = true;
            const button = createElement('button', {
                className: 'sb-sampling-help-toggle',
                attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': subtitle.id, 'data-sb-keeps-sensitive': '' },
            });
            const name = createElement('span', {
                className: 'sr-only', text: 'Details',
                attrs: { id: `sb-sampler-${key}-help-label`, 'data-i18n': 'Details' },
            });
            const sliderLabelId = isWire ? card.querySelector(':scope > .ds-row-slider > .ds-row-text > .ds-row-label')?.id : '';
            button.setAttribute('aria-labelledby', [sliderLabelId, label.id, name.id].filter(Boolean).join(' '));
            button.append(createElement('i', { className: 'fa-solid fa-circle-info', attrs: { 'aria-hidden': 'true' } }), name);
            button.addEventListener('click', () => {
                subtitle.hidden = !subtitle.hidden;
                button.setAttribute('aria-expanded', String(!subtitle.hidden));
            });
            text.append(button);
            row.append(subtitle);
            row.classList.add('sb-sampling-help-row');
        }
    }

    function buildSamplingControlCard(selector, root = document) {
        const controlBlock = selector === '#samplerResetButton'
            ? getSamplerToolbarControlBlock()
            : selector === '#sb_neutralize_chat_samplers'
                ? getChatSamplerToolbarControlBlock()
                : getSamplingControlBlock(selector);
        if (!(controlBlock instanceof HTMLElement)) {
            return null;
        }

        const entry = SB_SAMPLER_ENTRY_BY_SELECTOR.get(selector);
        const isExpander = Boolean(entry?.expander);
        let card;
        if (isExpander) {
            const heading = controlBlock.querySelector(':scope > h4');
            // A header toggle may already be normalized; its subtitle is not part of the sampler name.
            const headingCopy = heading?.cloneNode(true);
            headingCopy?.querySelectorAll('.ds-row-subtitle, [data-sb-copy-placeholder]').forEach(node => node.remove());
            const labelText = headingCopy?.textContent.replace(/\s+/g, ' ').trim() || 'lorum ipsum';
            const tooltip = heading?.matches('[title], [data-sttt--title]') ? heading : heading?.querySelector('[title], [data-sttt--title]');
            const subtitleText = entry?.description || tooltip?.getAttribute('title') || tooltip?.getAttribute('data-sttt--title') || 'lorum ipsum';
            // SillyBunny: move header toggles into the expander body as full-width live preference rows.
            for (const label of controlBlock.querySelectorAll(':scope > h4 .checkbox_label')) controlBlock.prepend(label);
            const expander = createExpanderRow({ label: labelText, subtitle: subtitleText, field: `sampler-${entry.id}`, children: [controlBlock] });
            card = expander.row;
            expander.content.classList.add('sb-sampling-multi-card');
            const label = card.querySelector('.ds-row-label');
            const subtitle = card.querySelector('.ds-row-subtitle');
            if (labelText === 'lorum ipsum') label.dataset.sbCopyPlaceholder = 'true';
            if (entry?.description) subtitle.dataset.i18n = entry.description;
            if (subtitleText === 'lorum ipsum') subtitle.dataset.sbCopyPlaceholder = 'true';
        } else {
            card = createElement('div', { className: 'sb-sampling-row' });
            card.appendChild(controlBlock);
        }
        card.classList.add('sb-sampling-control-card');
        card.dataset.sbSamplingControl = selector;
        if (entry) card.dataset.sbSamplerId = entry.id;
        samplingModule?.prepareSamplingBlock(selector, controlBlock, { root });
        // Ungated samplers stay visible for every provider; gating code in openai.js and
        // textgen-settings.js skips elements carrying this marker.
        if (entry && !entry.gated) {
            for (const element of [controlBlock, ...controlBlock.querySelectorAll('[data-source], [data-tg-type]')]) {
                element.setAttribute('data-sb-sampler-ungated', '');
            }
        }
        for (const attributeName of ['data-source', 'data-source-mode', 'data-sb-sampler-ungated']) {
            if (controlBlock.hasAttribute(attributeName)) {
                card.setAttribute(attributeName, controlBlock.getAttribute(attributeName));
            }
        }
        decorateSamplingControlCard(card, selector);
        // The lists stay lists: their entries are data, not settings rows.
        normalizeBackendSettingsRows(card, { skip: '.sb-sampling-list' });
        applySamplingSubtitleSource(card, entry, root);
        samplingModule?.finishSamplingCard(card, { wire: getSamplingWire(selector) });
        addSamplingDescriptionToggles(card);
        return card;
    }

    /** Builds an inert CC row from the live Text Completions card's label; returns null until that card exists. */
    function buildChatCompletionPlaceholderCard(entry, root) {
        const source = root.querySelector(`#sb-sampling-textgenerationwebui [data-sb-sampling-control="${entry.textgenerationwebui}"]`);
        const sourceLabel = source?.querySelector(entry.expander ? ':scope > .ds-row-expander__header .ds-row-label' : '.ds-row-label');
        const labelText = sourceLabel?.textContent.replace(/\s+/g, ' ').trim();
        if (!labelText || sourceLabel.hasAttribute('data-sb-copy-placeholder')) return null;

        const card = createElement('div', {
            className: 'sb-sampling-control-card sb-sampling-row sb-sampling-placeholder-card',
            attrs: { 'data-sb-sampling-placeholder': '', 'data-sb-sampler-id': entry.id },
        });
        const badge = createElement('span', { className: 'sb-sampling-unavailable-badge' });
        badge.append(
            createElement('i', { className: 'fa-solid fa-ban', attrs: { 'aria-hidden': 'true' } }),
            createElement('span', { text: 'Unavailable', attrs: { 'data-i18n': 'Unavailable' } }),
        );
        const { row } = createRow({ label: labelText, subtitle: SB_CC_PLACEHOLDER_SUBTITLE, field: `sampler-${entry.id}-unavailable`, suffix: badge });
        // The row has no control to disable, so it takes the insensitive look without `inert`: the reason stays readable to a screen reader.
        row.classList.add('is-insensitive');
        row.setAttribute('aria-disabled', 'true');
        const label = row.querySelector('.ds-row-label');
        const i18nKey = sourceLabel.getAttribute('data-i18n') ?? sourceLabel.querySelector(':scope > [data-i18n]')?.getAttribute('data-i18n');
        if (i18nKey && !i18nKey.startsWith('[')) label.dataset.i18n = i18nKey;
        row.querySelector('.ds-row-subtitle').dataset.i18n = SB_CC_PLACEHOLDER_SUBTITLE;
        card.append(row);
        return card;
    }

    function syncChatCompletionPlaceholderCards(root) {
        const section = root.querySelector('#sb-sampling-openai');
        if (!(section instanceof HTMLElement)) return false;
        let built = false;
        for (const entry of SB_CC_PLACEHOLDER_SAMPLERS) {
            if (section.querySelector(`[data-sb-sampling-placeholder][data-sb-sampler-id="${entry.id}"]`)) continue;
            const target = section.querySelector(`[data-sb-sampling-group="${entry.group}"] > .ds-pref-group`);
            const card = target instanceof HTMLElement ? buildChatCompletionPlaceholderCard(entry, root) : null;
            if (!card) continue;
            target.append(card);
            built = true;
        }
        return built;
    }

    function syncSamplingPanelControls(root) {
        if (!(root instanceof HTMLElement)) {
            return;
        }

        for (const backend of SB_SAMPLING_BACKENDS) {
            const section = root.querySelector(`#sb-sampling-${backend.id}`);
            if (!(section instanceof HTMLElement)) {
                continue;
            }

            section.querySelector('.sb-sampling-note')?.remove();

            let builtCards = false;
            const backendControls = getSamplingBackendControls(backend.id);

            for (const selector of backendControls) {
                const groupId = getSamplingGroupId(selector);
                const target = section.querySelector(`[data-sb-sampling-group="${groupId}"] > .ds-pref-group`);
                if (!(target instanceof HTMLElement)) throw new Error(`Missing Sampling group: ${backend.id}/${groupId}`);
                const existingCard = Array.from(section.querySelectorAll('[data-sb-sampling-control]'))
                    .find(card => card instanceof HTMLElement && card.dataset.sbSamplingControl === selector);
                if (existingCard instanceof HTMLElement && existingCard.children.length > 0) {
                    if (existingCard.parentElement !== target) {
                        target.appendChild(existingCard);
                    }
                    refreshSamplingTransmission(existingCard, selector);
                    continue;
                }

                existingCard?.remove();

                const card = buildSamplingControlCard(selector, root);
                if (card) {
                    target.appendChild(card);
                    builtCards = true;
                }
            }

            if (backend.id === 'openai' && syncChatCompletionPlaceholderCards(root)) builtCards = true;

            if (builtCards) {
                sortSamplingSectionCards(section);
                section.dataset.sbUngatedResyncPending = 'true';
            }
            // Base gating and manual sampler hiding query the live document, so wait until the panel is attached.
            if (section.dataset.sbUngatedResyncPending && section.isConnected) {
                delete section.dataset.sbUngatedResyncPending;
                resyncUngatedSamplerVisibility(section, backend.id);
            }

            if (!section.querySelector('[data-sb-sampling-control]') && !section.querySelector('[data-sb-sampling-placeholder]')) {
                section.appendChild(createElement('p', {
                    className: 'sb-sampling-note',
                    text: 'Sampler controls are not ready yet. Reopen the Backend menu after settings finish loading.',
                }));
            }

            updateSamplingCardVisibility(section);
        }

        samplingModule?.syncSamplingDependents(root);
        hideEmptyGroupedSettingsDrawers();
    }

    function updateSamplingPanelVisibility(root) {
        if (!(root instanceof HTMLElement)) {
            return;
        }

        syncSamplingPanelControls(root);

        const activeApi = getCurrentMainApiValue();
        let activeSection = null;

        for (const section of root.querySelectorAll('[data-sb-sampling-apis]')) {
            if (!(section instanceof HTMLElement)) {
                continue;
            }

            const apiIds = String(section.dataset.sbSamplingApis ?? '').split(',');
            const isActive = apiIds.includes(activeApi);
            section.hidden = !isActive;

            if (isActive) {
                activeSection = section;
            }
        }

        const empty = root.querySelector('#sb-sampling-empty');
        if (empty instanceof HTMLElement) {
            empty.hidden = Boolean(activeSection);
        }
    }

    async function buildSamplingPanel() {
        samplingModule ??= await loadSamplingModule();
        await samplingModule.loadSamplingStyles();
        const { panel, scroller } = createShellPanel({ id: 'sampling' });
        const column = createElement('div', {
            className: 'sb-shell-column sb-sampling-panel',
            attrs: { 'data-sb-presentation': 'manual' },
        });

        const sections = createElement('div', { className: 'sb-sampling-sections' });
        for (const backend of SB_SAMPLING_BACKENDS) {
            const section = createElement('section', {
                id: `sb-sampling-${backend.id}`,
                className: 'sb-sampling-section',
                attrs: {
                    'data-sb-sampling-apis': backend.apiIds.join(','),
                },
            });
            section.append(createBackendSectionHeader({
                title: `Backend: ${backend.title}`,
                note: 'Some backends ignore samplers they do not support',
            }));
            for (const group of SB_SAMPLING_GROUPS) {
                const category = createElement('section', {
                    className: 'sb-sampling-group',
                    attrs: { 'data-sb-sampling-group': group.id },
                });
                category.append(
                    createBackendGroupHeader(group.title, group.i18n ? { 'data-i18n': group.i18n } : {}, group.description),
                    createElement('div', { className: 'ds-pref-group' }),
                );
                section.append(category);
            }
            sections.appendChild(section);
        }

        const empty = createElement('div', {
            id: 'sb-sampling-empty',
            className: 'sb-sampling-empty sb-shell-callout',
            html: '<strong>No unified samplers for this backend yet</strong><p>This POC currently supports Chat Completions, Text Completions, Kobold/Kobold Horde, and NovelAI.</p>',
        });

        column.append(sections, empty);
        scroller.appendChild(column);
        let visibilityQueued = false;
        const visibilityObserver = new MutationObserver(mutations => {
            if (visibilityQueued || !mutations.some(({ target }) => target instanceof HTMLElement && target.matches('[data-source], [data-tg-type], [data-tg-samplers]'))) return;
            visibilityQueued = true;
            window.requestAnimationFrame(() => {
                visibilityQueued = false;
                sections.querySelectorAll('.sb-sampling-section').forEach(updateSamplingCardVisibility);
            });
        });
        visibilityObserver.observe(sections, { subtree: true, attributes: true, attributeFilter: ['style'] });

        $('#main_api').on('change.sbSamplingPanel', () => {
            if (isShellTabOpen('left', 'sampling')) updateSamplingPanelVisibility(column);
        });
        $(document).on('change.sbSamplingTransmission', 'select', () => updateSamplingPanelVisibility(column));
        updateSamplingPanelVisibility(column);
        window.requestAnimationFrame(() => updateSamplingPanelVisibility(column));
        window.setTimeout(() => updateSamplingPanelVisibility(column), 250);
        window.setTimeout(() => updateSamplingPanelVisibility(column), 1000);

        return {
            id: 'sampling',
            panel,
            button: null,
            searchRoot: column,
            onActivate: () => updateSamplingPanelVisibility(column),
        };
    }

    return {
        buildSamplingPanel,
        updateSamplingCardVisibility,
        updateSamplingPanelVisibility,
    };
}
