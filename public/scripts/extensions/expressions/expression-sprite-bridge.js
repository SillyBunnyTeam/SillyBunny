/**
 * Non-blocking bridge from the Expressions extension to Quick Image Gen.
 *
 * SillyBunny divergence: QIG is vendored from an upstream repo, so this file lives
 * outside `quick-image-gen/` and imports only the small set of helpers it needs.
 * That keeps the vendored QIG surface minimal and makes upstream syncs safer.
 */

import {
    getSettings as getQigSettings,
    getGenerationSettingsForRun as getQigGenerationSettingsForRun,
    generateForProvider as qigGenerateForProvider,
    finalizeGeneratedEntry as qigFinalizeGeneratedEntry,
    withTransientGenerationSettings as qigWithTransientGenerationSettings,
} from '../quick-image-gen/index.js';

const SPINNER_ID = 'expression-agent-spinner';
const EXPRESSION_SPRITE_FRAMING = {
    bust: 'bust',
    fullBody: 'full_body',
};
const EXPRESSION_SPRITE_NEGATIVE = [
    'three-quarter view',
    '3/4 view',
    'side view',
    'profile view',
    'looking away',
    'rotated shoulders',
    'tilted head',
    'tilted camera',
    'dutch angle',
    'top-down view',
    'low angle',
    'different crop',
    'different zoom',
    'different outfit',
    'different hairstyle',
    'different accessories',
].join(', ');
const EXPRESSION_SPRITE_FRAMING_PROMPTS = {
    [EXPRESSION_SPRITE_FRAMING.bust]: [
        'Framing: bust portrait, chest and shoulders visible, face centered, same head size in every sprite.',
        'Use a straight-on front view at eye level. Keep shoulders square to the camera and do not change the camera distance.',
    ].join('\n'),
    [EXPRESSION_SPRITE_FRAMING.fullBody]: [
        'Framing: full body sprite, entire character visible from head to feet, centered with consistent scale.',
        'Use a straight-on front-facing standing pose at eye level. Keep the same body pose and camera distance in every sprite.',
    ].join('\n'),
};

function getExpressionSpriteFramingPrompt(framing) {
    return EXPRESSION_SPRITE_FRAMING_PROMPTS[framing] || EXPRESSION_SPRITE_FRAMING_PROMPTS[EXPRESSION_SPRITE_FRAMING.bust];
}

function substituteExpressionSpritePrompt(template, values) {
    return Object.entries(values).reduce((prompt, [key, value]) => {
        const macro = new RegExp(`{{\\s*${key}\\s*}}`, 'gi');
        return prompt.replace(macro, () => String(value ?? ''));
    }, template).replace(/\n{3,}/g, '\n\n').trim();
}

function buildExpressionSpritePrompt(expression, { characterName, characterCard, framing, promptTemplate } = {}) {
    const name = characterName || 'character';
    const cardDetails = String(characterCard || '').trim();
    const framingInstructions = getExpressionSpriteFramingPrompt(framing);
    const promptTemplateText = String(promptTemplate || '').trim();

    if (promptTemplateText) {
        return substituteExpressionSpritePrompt(promptTemplateText, {
            characterName: name,
            expression,
            characterCard: cardDetails,
            framing: framing || EXPRESSION_SPRITE_FRAMING.bust,
            framingInstructions,
        });
    }

    return [
        `Create one image in a matching character expression sprite set for ${name}.`,
        `Expression to show: ${expression}.`,
        cardDetails ? `Use these character card details as the source of truth for the character's actual appearance:\n${cardDetails}` : '',
        framingInstructions,
        'Preserve the same character identity, species, body, hair, eyes, clothing, accessories, colors, and style described in the card.',
        'Consistency rules: same front-facing angle, same crop, same scale, same head and body position, same outfit, same hairstyle, same accessories, plain white or transparent background.',
        'Only the facial expression should change. Keep pose, camera, composition, and silhouette stable across all generated expressions.',
        'Clean isolated character sprite, emotional face, production-ready expression sheet tile.',
    ].filter(Boolean).join('\n');
}

/**
 * Find or create a small inline spinner inside the expression holder.
 * @returns {HTMLElement|null}
 */
function getSpinner() {
    let spinner = document.getElementById(SPINNER_ID);
    if (!spinner) {
        const holder = document.getElementById('expression-holder');
        if (!holder) return null;
        spinner = document.createElement('div');
        spinner.id = SPINNER_ID;
        spinner.className = 'expression_agent_spinner';
        spinner.title = 'Generating missing sprite…';
        holder.appendChild(spinner);
    }
    return spinner;
}

function showSpinner() {
    const spinner = getSpinner();
    if (spinner) spinner.classList.add('active');
}

function hideSpinner() {
    const spinner = document.getElementById(SPINNER_ID);
    if (spinner) spinner.classList.remove('active');
}

function removeSpinner() {
    const spinner = document.getElementById(SPINNER_ID);
    if (spinner) spinner.remove();
}

/**
 * Generate a character sprite for the given expression using Quick Image Gen.
 * This call is intentionally independent of QIG's global `isGenerating` flag so
 * that expression sprite creation never blocks or is blocked by manual QIG usage.
 *
 * @param {string} expression - The expression label (e.g. "joy").
 * @param {object} promptContext - Character prompt context.
 * @param {string} promptContext.characterName - The character name to seed the prompt.
 * @param {string} [promptContext.characterCard] - Character card details to preserve in the prompt.
 * @param {string} [promptContext.framing] - Desired sprite framing.
 * @param {string} [promptContext.promptTemplate] - Editable prompt template sent to Quick Image Gen.
 * @returns {Promise<string|null>} URL/data-URI of the generated image, or null on failure.
 */
export async function generateExpressionSprite(expression, promptContext) {
    if (!expression || !promptContext?.characterName) return null;

    const qigSettings = getQigSettings();
    if (!qigSettings) {
        console.debug('[Expression Sprite Bridge] Quick Image Gen settings not available');
        return null;
    }

    showSpinner();

    try {
        const prompt = buildExpressionSpritePrompt(expression, promptContext);
        const negative = [qigSettings.negativePrompt, EXPRESSION_SPRITE_NEGATIVE].filter(Boolean).join(', ');

        const imageUrl = await qigWithTransientGenerationSettings({}, async () => {
            const settings = getQigGenerationSettingsForRun();
            const rawResult = await qigGenerateForProvider(prompt, negative, settings, null, {});
            if (!rawResult) return null;
            const entry = await qigFinalizeGeneratedEntry(rawResult, prompt, negative, settings, {});
            return entry?.url || null;
        });

        return imageUrl || null;
    } catch (error) {
        console.error('[Expression Sprite Bridge] Failed to generate sprite:', error);
        return null;
    } finally {
        hideSpinner();
    }
}

/**
 * Remove the inline spinner if it is still present. Safe to call on chat changes.
 */
export function cleanupExpressionSpriteSpinner() {
    removeSpinner();
}
