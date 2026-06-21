import { generateRaw } from '../script.js';
import { resolveConnectionProfile } from './extensions/in-chat-agents/agent-store.js';
import { extractProfileResponseText } from './extensions/in-chat-agents/llm-utils.js';
import { getConnectionManagerRequestService } from './extensions/in-chat-agents/profile-utils.js';

export const CUSTOM_CSS_AI_MAX_TOKENS = 3072;

export const CUSTOM_CSS_AI_PALETTE_VARIABLES = Object.freeze([
    '--SmartThemeBodyColor',
    '--SmartThemeEmColor',
    '--SmartThemeUnderlineColor',
    '--SmartThemeQuoteColor',
    '--SmartThemeBlurTintColor',
    '--SmartThemeChatTintColor',
    '--SmartThemeUserMesBlurTintColor',
    '--SmartThemeBotMesBlurTintColor',
    '--SmartThemeShadowColor',
    '--SmartThemeBorderColor',
    '--customCSS-bg-blur',
    '--customCSS-bg-opacity',
]);

export const CUSTOM_CSS_AI_SYSTEM_PROMPT = [
    'You are a CSS specialist for SillyBunny, a SillyTavern fork.',
    'Generate custom CSS for the Custom CSS editor.',
    'Output ONLY raw CSS. Do not include markdown fences, prose, HTML, <style> tags, JavaScript, @import, or external URLs.',
    'Prefer stable SillyTavern/SillyBunny selectors and CSS custom properties. Keep desktop and mobile usable.',
    'Scope risky changes narrowly. Short CSS comments are allowed only when they clarify non-obvious rules.',
].join(' ');

export function isAbortLikeError(error, signal = null) {
    return Boolean(
        signal?.aborted
        || error?.name === 'AbortError'
        || /abort|cancel/i.test(String(error?.message ?? error ?? '')),
    );
}

export function stripCssMarkdownFences(text = '') {
    const value = String(text ?? '').trim();
    const fencedBlock = value.match(/```(?:css)?\s*([\s\S]*?)```/i);
    if (fencedBlock) {
        return fencedBlock[1].trim();
    }

    return value
        .replace(/^```(?:css)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
}

export function normalizeGeneratedCustomCss(text = '') {
    return stripCssMarkdownFences(text)
        .replace(/^<style[^>]*>/i, '')
        .replace(/<\/style>$/i, '')
        .trim();
}

export function getCustomCssPaletteSnapshot(root = typeof document === 'undefined' ? null : document.documentElement) {
    if (!root || typeof getComputedStyle !== 'function') {
        return '';
    }

    const computedStyle = getComputedStyle(root);
    return CUSTOM_CSS_AI_PALETTE_VARIABLES
        .map(name => [name, String(computedStyle.getPropertyValue(name) ?? '').trim()])
        .filter(([, value]) => value)
        .map(([name, value]) => `${name}: ${value};`)
        .join('\n');
}

export function buildCustomCssAIMessages({ instruction = '', currentCss = '', paletteSnapshot = getCustomCssPaletteSnapshot() } = {}) {
    const request = String(instruction ?? '').trim();
    const current = String(currentCss ?? '').trim();
    const palette = String(paletteSnapshot ?? '').trim();

    const userContent = [
        `Request:\n${request}`,
        `Current custom CSS:\n${current || '/* No custom CSS is currently set. */'}`,
        palette ? `Current theme CSS variables:\n${palette}` : '',
        'Return CSS that can be pasted directly into the Custom CSS textarea.',
    ].filter(Boolean).join('\n\n');

    return [
        { role: 'system', content: CUSTOM_CSS_AI_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
    ];
}

export function resolveCustomCssAIProfile(profileId = '') {
    return resolveConnectionProfile(profileId);
}

export async function generateCustomCssWithAI({
    instruction = '',
    currentCss = '',
    profileId = '',
    maxTokens = CUSTOM_CSS_AI_MAX_TOKENS,
    signal = null,
    paletteSnapshot = getCustomCssPaletteSnapshot(),
} = {}) {
    if (!String(instruction ?? '').trim()) {
        throw new Error('Instruction is required to generate custom CSS.');
    }

    const messages = buildCustomCssAIMessages({ instruction, currentCss, paletteSnapshot });
    const resolvedProfileId = resolveCustomCssAIProfile(profileId);
    const CMRS = getConnectionManagerRequestService();

    if (resolvedProfileId && CMRS && typeof CMRS.sendRequest === 'function') {
        try {
            const response = await CMRS.sendRequest(resolvedProfileId, messages, maxTokens, {
                extractData: true,
                includePreset: true,
                includeInstruct: true,
                stream: false,
                signal,
            });
            const profileText = typeof response === 'string' ? response : extractProfileResponseText(response);
            const css = normalizeGeneratedCustomCss(profileText);
            if (css) {
                return css;
            }
        } catch (error) {
            if (isAbortLikeError(error, signal)) {
                throw error;
            }
            console.warn(`[CustomCssAI] Profile "${resolvedProfileId}" request failed, falling back to the main model.`, error);
        }
    }

    const fallbackText = await generateRaw({
        prompt: messages,
        responseLength: maxTokens,
        trimNames: false,
        signal,
        cacheScope: 'auxiliary',
    });
    return normalizeGeneratedCustomCss(fallbackText);
}
