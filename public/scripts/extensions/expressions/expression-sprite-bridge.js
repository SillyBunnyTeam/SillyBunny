/**
 * Non-blocking bridge from the Expressions extension to Quick Image Gen.
 *
 * SillyBunny divergence: QIG is vendored from an upstream repo, so this file lives
 * outside `quick-image-gen/` and discovers its activated runtime capability.
 * This avoids loading a disabled or second URL identity of the QIG entrypoint.
 */

import { getExtensionCapability } from '../../sillybunny-conversation/extension-capabilities.js';

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
    'opaque background',
    'colored background',
    'busy background',
    'checkerboard background',
    'transparent checkerboard',
    'transparency grid',
    'alpha checkerboard',
    'gray checkerboard',
    'captions',
    'labels',
    'text',
    'expression names',
    'overlapping cells',
    'sprites crossing cell boundaries',
    'cut off character',
    'adjacent sprite fragments',
].join(', ');
const EXPRESSION_SPRITE_FRAMING_PROMPTS = {
    [EXPRESSION_SPRITE_FRAMING.bust]: [
        'Framing: bust portrait, chest and shoulders visible, face centered, same head size in every sprite.',
        'Use a straight-on front view at eye level. Keep shoulders square to the camera and do not change the camera distance.',
        'Position the character identically in every image: head near the top with a small even margin, body centered horizontally, same scale and crop. The character must occupy the same area of the frame each time.',
    ].join('\n'),
    [EXPRESSION_SPRITE_FRAMING.fullBody]: [
        'Framing: full body sprite, entire character visible from head to feet, centered with consistent scale.',
        'Use a straight-on front-facing standing pose at eye level. Keep the same body pose and camera distance in every sprite.',
        'Position the character identically in every image: feet near the bottom, head near the top, centered horizontally, same scale and crop. The character must occupy the same area of the frame each time.',
    ].join('\n'),
};

function getExpressionSpriteFramingPrompt(framing) {
    return EXPRESSION_SPRITE_FRAMING_PROMPTS[framing] || EXPRESSION_SPRITE_FRAMING_PROMPTS[EXPRESSION_SPRITE_FRAMING.bust];
}

function getExpressionSpriteSheetGrid(count) {
    const columns = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    return { columns, rows };
}

function formatExpressionList(expressions) {
    return expressions.map((expression, index) => `${index + 1}. ${expression}`).join('\n');
}

function hasPromptMacro(template, macroName) {
    const macro = new RegExp(`{{\\s*${macroName}\\s*}}`, 'i');
    return macro.test(template);
}

function substituteExpressionSpritePrompt(template, values) {
    return Object.entries(values).reduce((prompt, [key, value]) => {
        const macro = new RegExp(`{{\\s*${key}\\s*}}`, 'gi');
        return prompt.replace(macro, () => String(value ?? ''));
    }, template).replace(/\n{3,}/g, '\n\n').trim();
}

function buildPromptFromTemplate(template, values) {
    const missingInstructions = [];
    if (!hasPromptMacro(template, 'generationInstructions')) {
        missingInstructions.push(values.generationInstructions);
    }
    if (values.sheetInstructions && !hasPromptMacro(template, 'sheetInstructions')) {
        missingInstructions.push(values.sheetInstructions);
    }

    return [
        missingInstructions.filter(Boolean).join('\n'),
        substituteExpressionSpritePrompt(template, values),
    ].filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildIndividualGenerationInstructions(expression, characterName) {
    return [
        `Create one image in a matching character expression sprite set for ${characterName}.`,
        `Expression to show: ${expression}.`,
    ].join('\n');
}

function buildSheetGenerationInstructions(expressions, characterName, grid) {
    const extraCells = (grid.columns * grid.rows) - expressions.length;
    return [
        `Create one complete character expression sheet for ${characterName}.`,
        `Sheet layout: ${grid.columns} columns by ${grid.rows} rows, equal-size cells, row-major order.`,
        `Generate the first ${expressions.length} cells using these expressions in order:\n${formatExpressionList(expressions)}`,
        extraCells > 0 ? `Leave the final ${extraCells} unused cell(s) transparent or flat white.` : '',
        'Use true alpha transparency for the sheet and every cell. If true transparency is not available, use a flat pure white background only.',
        'Do not draw a checkerboard, transparency grid, gray squares, paper texture, or any background pattern.',
        'No captions, labels, numbers, expression names, borders, gutters, panel outlines, or decorative dividers.',
        'Keep every character, prop, weapon, accessory, hair strand, and shadow fully inside its own cell with clear transparent padding on all sides.',
        'Do not let any part of a sprite cross into another cell. Adjacent cells must never overlap or leak into each other.',
        'Each filled cell must contain exactly one clean sprite tile that can be cropped by equal grid coordinates.',
    ].filter(Boolean).join('\n');
}

function buildExpressionSpritePrompt(expression, { characterName, characterCard, framing, promptTemplate } = {}) {
    const name = characterName || 'character';
    const cardDetails = String(characterCard || '').trim();
    const framingInstructions = getExpressionSpriteFramingPrompt(framing);
    const promptTemplateText = String(promptTemplate || '').trim();
    const generationInstructions = buildIndividualGenerationInstructions(expression, name);

    if (promptTemplateText) {
        return buildPromptFromTemplate(promptTemplateText, {
            generationInstructions,
            characterName: name,
            expression,
            expressions: expression,
            characterCard: cardDetails,
            framing: framing || EXPRESSION_SPRITE_FRAMING.bust,
            framingInstructions,
            sheetInstructions: '',
        });
    }

    return [
        generationInstructions,
        cardDetails ? `Use these character card details as the source of truth for the character's actual appearance:\n${cardDetails}` : '',
        framingInstructions,
        'Preserve the same character identity, species, body, hair, eyes, clothing, accessories, colors, and style described in the card.',
        'Consistency rules: same front-facing angle, same crop, same scale, same head and body position, same outfit, same hairstyle, same accessories, true transparent background.',
        'If true transparency is not available, use flat pure white only. Never draw a checkerboard or transparency grid.',
        'Only the facial expression should change. Keep pose, camera, composition, and silhouette stable across all generated expressions.',
        'Clean isolated character sprite, emotional face, production-ready expression sheet tile.',
    ].filter(Boolean).join('\n');
}

function buildExpressionSpriteSheetPrompt(expressions, { characterName, characterCard, framing, promptTemplate } = {}, grid) {
    const name = characterName || 'character';
    const cardDetails = String(characterCard || '').trim();
    const framingInstructions = getExpressionSpriteFramingPrompt(framing);
    const promptTemplateText = String(promptTemplate || '').trim();
    const sheetInstructions = buildSheetGenerationInstructions(expressions, name, grid);
    const generationInstructions = `Create one image containing a matching character expression sheet for ${name}.`;

    if (promptTemplateText) {
        return buildPromptFromTemplate(promptTemplateText, {
            generationInstructions,
            characterName: name,
            expression: 'each listed expression',
            expressions: expressions.join(', '),
            characterCard: cardDetails,
            framing: framing || EXPRESSION_SPRITE_FRAMING.bust,
            framingInstructions,
            sheetInstructions,
        });
    }

    return [
        generationInstructions,
        sheetInstructions,
        cardDetails ? `Use these character card details as the source of truth for the character's actual appearance:\n${cardDetails}` : '',
        framingInstructions,
        'Preserve the same character identity, species, body, hair, eyes, clothing, accessories, colors, and style described in the card.',
        'Consistency rules: same front-facing angle, same crop, same scale, same head and body position, same outfit, same hairstyle, same accessories, true transparent background.',
        'If true transparency is not available, use flat pure white only. Never draw a checkerboard or transparency grid.',
        'Only the facial expression should change. Keep pose, camera, composition, and silhouette stable across all generated expressions.',
        'Clean isolated character sprite, emotional face, production-ready expression sheet.',
    ].filter(Boolean).join('\n');
}

let activeGenerationAbortController = null;
let activeGenerationSerial = 0;

function beginExpressionGenerationRequest() {
    activeGenerationAbortController = new AbortController();
    activeGenerationSerial += 1;
    return {
        controller: activeGenerationAbortController,
        serial: activeGenerationSerial,
    };
}

function endExpressionGenerationRequest(serial) {
    if (serial === activeGenerationSerial) {
        activeGenerationAbortController = null;
    }
}

async function waitForQigReadiness(qig, signal) {
    if (signal.aborted) throw signal.reason;
    let abort;
    const aborted = new Promise((_, reject) => {
        abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
    });
    try {
        await Promise.race([qig.ensureReady(), aborted]);
    } finally {
        signal.removeEventListener('abort', abort);
    }
}

async function runWithQigCapability(task) {
    const qig = getExtensionCapability('quick-image-gen');
    if (!qig) {
        console.debug('[Expression Sprite Bridge] Quick Image Gen is not active');
        return null;
    }

    const generationRequest = beginExpressionGenerationRequest();
    try {
        await waitForQigReadiness(qig, generationRequest.controller.signal);
        return await task(qig, generationRequest.controller.signal);
    } finally {
        endExpressionGenerationRequest(generationRequest.serial);
    }
}

/**
 * Abort the active Expressions Agent QIG request, if one is running.
 * @returns {boolean} True when a running request was asked to stop.
 */
export function stopExpressionSpriteGeneration() {
    if (!activeGenerationAbortController || activeGenerationAbortController.signal.aborted) return false;

    activeGenerationAbortController.abort();
    hideSpinner();
    return true;
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

    showSpinner();

    try {
        return await runWithQigCapability(async (qig, signal) => {
            const qigSettings = qig.getSettingsSnapshot();
            const prompt = buildExpressionSpritePrompt(expression, promptContext);
            const negative = [qigSettings?.negativePrompt, EXPRESSION_SPRITE_NEGATIVE].filter(Boolean).join(', ');
            const entry = await qig.generateImage(prompt, negative, { signal });
            return entry?.url || null;
        });
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        console.error('[Expression Sprite Bridge] Failed to generate sprite:', error);
        return null;
    } finally {
        hideSpinner();
    }
}

/**
 * Generate a character expression sprite sheet using Quick Image Gen.
 * @param {string[]} expressions - Expression labels in desired sheet order.
 * @param {object} promptContext - Character prompt context.
 * @param {string} promptContext.characterName - The character name to seed the prompt.
 * @param {string} [promptContext.characterCard] - Character card details to preserve in the prompt.
 * @param {string} [promptContext.framing] - Desired sprite framing.
 * @param {string} [promptContext.promptTemplate] - Editable prompt template sent to Quick Image Gen.
 * @returns {Promise<{imageUrl: string, grid: {columns: number, rows: number}}|null>} Generated sheet and grid metadata.
 */
export async function generateExpressionSpriteSheet(expressions, promptContext) {
    const labels = Array.isArray(expressions) ? expressions.filter(Boolean) : [];
    if (labels.length === 0 || !promptContext?.characterName) return null;

    showSpinner();

    try {
        return await runWithQigCapability(async (qig, signal) => {
            const qigSettings = qig.getSettingsSnapshot();
            const grid = getExpressionSpriteSheetGrid(labels.length);
            const prompt = buildExpressionSpriteSheetPrompt(labels, promptContext, grid);
            const negative = [qigSettings?.negativePrompt, EXPRESSION_SPRITE_NEGATIVE].filter(Boolean).join(', ');
            const entry = await qig.generateImage(prompt, negative, { signal });
            return entry?.url ? { imageUrl: entry.url, grid } : null;
        });
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        console.error('[Expression Sprite Bridge] Failed to generate sprite sheet:', error);
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
