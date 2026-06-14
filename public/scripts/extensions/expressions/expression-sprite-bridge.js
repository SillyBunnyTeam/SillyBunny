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
 * @param {string} characterName - The character name to seed the prompt.
 * @returns {Promise<string|null>} URL/data-URI of the generated image, or null on failure.
 */
export async function generateExpressionSprite(expression, characterName) {
    if (!expression || !characterName) return null;

    const qigSettings = getQigSettings();
    if (!qigSettings) {
        console.debug('[Expression Sprite Bridge] Quick Image Gen settings not available');
        return null;
    }

    showSpinner();

    try {
        const prompt = `${characterName}, ${expression} expression, portrait, character sprite, emotional face`;
        const negative = qigSettings.negativePrompt || '';

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
