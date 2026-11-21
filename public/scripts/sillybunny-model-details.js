/**
 * What each provider's model list says about a model, as option details for the shared picker (see
 * sillybunny-editor/option-details.js). The words match the select2 templates in openai.js,
 * textgen-models.js and horde.js. Those templates parse catalogue fields as HTML; these only build text,
 * so a hostile catalogue entry stays text. Each function returns segments, or null when there is no model.
 */
import { icon, link } from './sillybunny-editor/option-details.js';

const CAPABILITY_ICONS = {
    vision: icon('fa-solid fa-eye fa-sm', 'This model supports vision'),
    reasoning: icon('fa-solid fa-brain fa-sm', 'This model supports reasoning'),
    tools: icon('fa-solid fa-wrench fa-sm', 'This model supports function tools'),
    premium: icon('fa-solid fa-crown fa-sm', 'This model requires a subscription'),
};

function capabilities(flags) {
    const found = Object.entries(flags).filter(([, present]) => present).map(([name]) => CAPABILITY_ICONS[name]);
    return found.length ? [found.flatMap((entry, index) => (index ? [' ', entry] : [entry]))] : [];
}

/** Catalogue text with any markup removed, parsed in an inert document so nothing loads or runs. */
export function plainText(value) {
    if (value === undefined || value === null) return '';
    return new DOMParser().parseFromString(String(value), 'text/html').body.textContent ?? '';
}

function openRouterPrice(model) {
    const prompt = Number(model.pricing?.prompt);
    if (prompt === 0) return 'Free';
    const rounded = (Math.round(Number(1 / (1000 * prompt)) * 1000) / 1000).toFixed(0);
    return `${rounded}k t/$`;
}

export function describeOpenRouterModel(model) {
    if (!model) return null;
    return [model.context_length === undefined ? '' : `${model.context_length} ctx`, openRouterPrice(model)];
}

export function describeElectronHubModel(model) {
    if (!model) return null;
    const input = model.pricing?.input;
    const output = model.pricing?.output;
    return [
        `${model.tokens} ctx`,
        input && output ? `$${input}/$${output} in/out Mtoken` : 'Unknown',
        ...capabilities({
            vision: model.metadata?.vision,
            reasoning: model.metadata?.reasoning,
            tools: model.metadata?.function_call,
            premium: model.premium_model,
        }),
    ];
}

export function describeChutesModel(model) {
    if (!model) return null;
    const input = model.pricing?.input;
    const output = model.pricing?.output;
    let price = 'Unknown';
    if (input !== undefined && output !== undefined) price = input === 0 && output === 0 ? 'Free' : `$${input}/$${output} in/out Mtoken`;
    return [
        `${model.context_length || model.max_model_len || 'Unknown'} ctx`,
        price,
        ...capabilities({
            vision: model.input_modalities?.includes('image'),
            reasoning: model.supported_features?.includes('reasoning'),
            tools: model.supported_features?.includes('structured_outputs'),
        }),
    ];
}

export function describeAimlapiModel(model) {
    return model ? [String(model.id).split('/')[0]] : null;
}

export function describeMancerModel(model) {
    if (!model) return null;
    const perPrompt = (model.limits?.context - model.limits?.completion) * model.pricing?.prompt;
    const perCompletion = model.limits?.completion * model.pricing?.completion;
    return [
        `${model.limits?.context} ctx / ${model.limits?.completion} res`,
        `Credits per request (max): ${Math.round(perPrompt + perCompletion).toFixed(0)}`,
    ];
}

/** @param {string} [label]  The option's text, which is the display name; the id is added when it differs. */
export function describeTogetherModel(model, label = '') {
    if (!model) return null;
    const id = String(model.id);
    return [id === label.trim() ? '' : id, `${model.context_length || '???'} tokens`, plainText(model.description)];
}

const capitalize = text => (text ? text[0].toUpperCase() + text.slice(1) : '');

/**
 * The queue state is already in the option's label, so only the model's own description is added.
 * The display name, without its path, is added when it differs from the name the label starts with.
 * A link to the model's page follows the name; it needs `linkLabel` (its name and tooltip) and a safe address.
 * @param {object} model
 * @param {string} [linkLabel]
 */
export function describeHordeModel(model, linkLabel = '') {
    if (!model) return null;
    const page = linkLabel && typeof model.url === 'string' && model.url.trim()
        ? link(model.url, { classes: 'fa-solid fa-circle-question', label: linkLabel })
        : null;
    const displayName = plainText(model.display_name || model.name).replace(/.*\//g, '');
    const style = capitalize(plainText(model.style));
    const popular = Array.isArray(model.tags) && model.tags.includes('popular');
    const tags = Array.isArray(model.tags) ? model.tags.map(plainText).filter(Boolean) : [];
    return [
        [displayName === model.name ? '' : displayName, ' ', page],
        popular ? [icon('fa-fw fa-solid fa-star', 'Popular'), ...(style ? [' ', style] : [])] : style,
        tags.join(', '),
        plainText(model.description),
    ];
}
